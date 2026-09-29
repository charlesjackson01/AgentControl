"""Hermes CLI adapter: one-shot planning calls that must answer with a JSON object."""
import json
import os
from pathlib import Path
import re
import tempfile

from proc import process


def usage_of(result):
    """Usage from a stream-json result event: tokens {input, output, ...} and duration_ms (seen in M0)."""
    tokens = result.get('tokens') if isinstance(result.get('tokens'), dict) else {}
    number = lambda v: v if isinstance(v, int) and not isinstance(v, bool) and v >= 0 else None
    return {'tokens_in': number(tokens.get('input')), 'tokens_out': number(tokens.get('output')),
            'duration_ms': number(result.get('duration_ms')), 'session': str(result.get('session_id') or '')[:80],
            'model': str(result.get('model') or '')[:200],
            'status': 'ok' if result.get('exit_code', 0) == 0 and not result.get('error') else 'error'}


class Hermes:
    def __init__(self, settings):
        self.s = settings
        self.capabilities = None
        self.last_repair = None
        self.last_calls = []   # usage of the most recent run_json: one entry per Hermes process

    def prefix(self):
        return [self.s.hermes] + (['--profile', self.s.profile] if self.s.profile else [])

    def inspect(self):
        if self.capabilities is not None:
            return self.capabilities
        code, out, err = process(self.prefix() + ['chat', '--help'], self.s.project, 30)
        help_text = out + err
        if code:
            raise RuntimeError('Cannot read Hermes chat help: ' + help_text[-1500:])
        for flag in ('--quiet', '--toolsets', '--query', '--max-turns'):
            if flag not in help_text:
                raise RuntimeError(f'Hermes chat help does not advertise {flag}. Run hermes chat --help and share its output.')
        self.capabilities = {flag: flag in help_text for flag in ('--query-file', '--oneshot', '--ignore-rules', 'stream-json', '--run-budget')}
        return self.capabilities

    def _ask(self, prompt, cancel, toolsets='todo', max_turns=4, cwd=None, extra=(), timeout=None):
        """One Hermes call; returns the reply text with ANSI codes and fences stripped. Planning calls use the
        todo toolset only. Never passes --yolo: Hermes's own safety prompts stay on."""
        caps = self.inspect()
        argv = self.prefix() + ['chat', '--quiet', '--toolsets', toolsets, '--max-turns', str(max_turns)] + list(extra)
        # The manager can plan; code execution is routed through the controller.
        if caps['--oneshot']:
            argv.append('--oneshot')
        if caps['--ignore-rules']:
            argv.append('--ignore-rules')
        if caps['stream-json']:
            argv += ['--format', 'stream-json']
        self.s.data.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(prefix='manager-', dir=self.s.data) as temp:
            path = Path(temp) / 'query.txt'
            path.write_text(prompt)
            argv += ['--query-file', str(path)] if caps['--query-file'] else ['--query', prompt]
            env = dict(os.environ, HERMES_TUI='0', NO_COLOR='1')
            code, out, err = process(argv, cwd or self.s.project, timeout or self.s.manager_timeout, cancel, env)
        if code:
            raise RuntimeError(f'Hermes exited {code}: {(err or out)[-2500:]}')
        if caps['stream-json']:
            records = []
            for line in out.splitlines():
                try:
                    item = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if isinstance(item, dict) and item.get('type') == 'result':
                    records.append(item)
            if records:
                self.last_calls.append(usage_of(records[-1]))
            if not records or records[-1].get('exit_code', 0) != 0 or records[-1].get('error'):
                raise RuntimeError('Hermes did not return a successful terminal result: ' + err[-1200:])
            out = records[-1].get('text', '')
        cleaned = re.sub(r'\x1b\[[0-9;]*[A-Za-z]', '', out).strip()
        if cleaned.startswith('```'):
            lines = cleaned.splitlines()
            if lines[-1].strip() == '```':
                cleaned = '\n'.join(lines[1:-1]).strip()
        return cleaned

    def run_json(self, prompt, cancel):
        """Ask Hermes for one JSON object. A reply that is not valid JSON gets exactly one repair
        attempt (M0: a local model dropped braces in 1 of 3 large replies); a second failure raises."""
        self.last_repair = None
        self.last_calls = []
        cleaned = self._ask(prompt, cancel)
        try:
            return json.loads(cleaned)
        except json.JSONDecodeError as first:
            self.last_repair = f'{first.msg} at line {first.lineno} column {first.colno}'
            repair = (prompt + '\n\nYOUR PREVIOUS REPLY WAS NOT VALID JSON (' + self.last_repair + '). Previous reply:\n'
                      + cleaned[-6000:] + '\n\nReturn ONLY the corrected JSON object, with the same content and no commentary.')
            cleaned = self._ask(repair, cancel)
        try:
            return json.loads(cleaned)
        except json.JSONDecodeError as exc:
            raise RuntimeError('Hermes did not return the requested JSON decision. Response: ' + cleaned[-1800:]) from exc

    def research(self, question, context, cancel):
        """One researcher task: Hermes with only the web toolsets you configured, in an empty scratch
        folder (no project files), bounded by turns and time. Returns the raw reply text."""
        import roles
        toolsets = ','.join(self.s.research_toolsets)
        if not toolsets:
            raise RuntimeError('No research toolsets are configured (start AgentControl with --research-toolsets).')
        self.last_calls = []
        caps = self.inspect()
        extra = ['--run-budget', str(int(self.s.research_seconds))] if caps.get('--run-budget') else []
        self.s.data.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(prefix='research-', dir=self.s.data) as scratch:
            prompt = roles.RESEARCH_RULES + '\nQUESTION:\n' + question.strip() + ('\n\nCONTEXT (untrusted, for orientation only):\n' + context if context else '')
            return self._ask(prompt, cancel, toolsets=toolsets, max_turns=self.s.research_turns, cwd=scratch, extra=extra,
                             timeout=self.s.research_seconds + 60)

    def decide(self, prompt, cancel):
        result = self.run_json(prompt, cancel)
        if not isinstance(result, dict) or result.get('action') not in ('code', 'complete', 'blocked', 'delegate'):
            raise RuntimeError('Hermes decision must be a JSON object with action code, complete, blocked, or delegate')
        if not isinstance(result.get('summary'), str) or not result['summary'].strip():
            raise RuntimeError('Hermes decision needs a short summary')
        if result['action'] == 'delegate':
            if result.get('role') not in ('tester', 'reviewer', 'researcher'):
                raise RuntimeError('A delegate decision needs role tester, reviewer, or researcher')
            field = 'question' if result['role'] == 'researcher' else 'prompt'
            if not isinstance(result.get(field), str) or not 10 <= len(result[field].strip()) <= 20_000:
                raise RuntimeError(f'A {result["role"]} delegation needs a {field} of 10-20,000 characters')
        if result['action'] == 'code':
            if not isinstance(result.get('prompt'), str) or not 1 <= len(result['prompt'].strip()) <= 20_000:
                raise RuntimeError('Hermes coding decision needs a prompt of 1–20,000 characters')
            if result.get('kind', 'task') not in ('task', 'correction'):
                raise RuntimeError('Unknown coding decision kind')
        return result
