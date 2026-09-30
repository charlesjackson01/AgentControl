#!/usr/bin/env python3
"""J0 probe (run on your server): what does TypeSafe's Jev API actually accept and return?

AgentControl never guesses an API's shape. This sends ONE request about a fixed, harmless sample
text (no project data) to Jev, and prints the HTTP status, the response's field names and types,
and the full body, so the adapter can be written against what your key really gets back.

The key is read from the ai-arch secret store (the same place as other paid endpoints):
    mkdir -p ~/.local/share/ai-arch/secrets && chmod 700 ~/.local/share/ai-arch/secrets
    (umask 077; printf '%s' 'YOUR_KEY' > ~/.local/share/ai-arch/secrets/typesafe)
or, for this probe only, from the TYPESAFE_API_KEY environment variable. It is never printed.

    python3 agent-autonomy/spikes/jev_probe.py                  # asks before sending
    python3 agent-autonomy/spikes/jev_probe.py --show-body      # print the request body and exit
    python3 agent-autonomy/spikes/jev_probe.py --body my.json   # send your own body instead

The default body is a best guess (a state plus one noul, one choice and one score question). If the
server rejects it, the error body it returns is printed in full: paste it back and the next body
is written from it.
"""
import argparse
import json
import os
from pathlib import Path
import sys
import time
import urllib.error
import urllib.request

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import models

SAMPLE = ('Task: make the test suite pass. Turn 5. The agent ran `pytest`, saw test_parse fail with '
          'KeyError: "date", edited parse.py to add a default, ran `pytest` again and saw the same '
          'KeyError in test_parse. This is the third time it made this same edit.')

GUESS = {
    # From probe 1 (HTTP 422): a top-level model is required, questions are told apart by `type`,
    # and choice and score questions need `criteria`. The model id and score criteria type are
    # still guesses; the server names them if they are wrong.
    'model': 'jev',
    'state': SAMPLE,
    'questions': {
        'stuck': {'type': 'noul',
                  'proposition': 'The agent is stuck: repeating the same actions or errors without progress toward the task.'},
        'pattern': {'type': 'choice', 'criteria': {
            'repeating_failure': 'The same failure recurs after each attempt.',
            'undo_redo': 'The agent keeps undoing and redoing the same change.',
            'tool_errors': 'Tools keep failing (bad commands, missing files).',
            'progressing': 'Each attempt changes the outcome; the agent is making progress.'}},
        'progress': {'type': 'score', 'criteria': 'How much progress the agent is making toward the task.', 'levels': [
            'No progress toward the task.', 'Some progress, but blocked.', 'Clear progress.', 'Task nearly done.']},
    },
}


def shape(value, depth=0):
    """Field names and types, without the values (safe to paste back)."""
    pad = '  ' * depth
    if isinstance(value, dict):
        return '\n'.join(f'{pad}{k}: {type(v).__name__}' + ('\n' + shape(v, depth + 1) if isinstance(v, (dict, list)) and v else '')
                         for k, v in value.items())
    if isinstance(value, list):
        return f'{pad}[{len(value)} items] ' + (('\n' + shape(value[0], depth + 1)) if value and isinstance(value[0], (dict, list)) else type(value[0]).__name__ if value else '')
    return pad + type(value).__name__


def key(ref):
    reason = 'no key reference given'
    try:
        found = models.read_secret(ref)
    except models.RegistryError as exc:
        found = ''
        reason = str(exc)
    if found:
        return found, f'secret store ({ref})'
    if os.environ.get('TYPESAFE_API_KEY'):
        return os.environ['TYPESAFE_API_KEY'].strip(), 'TYPESAFE_API_KEY'
    sys.exit(f'No key: {reason}. Put it in the secret store (see --help) or set TYPESAFE_API_KEY.')


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument('--url', default='https://api.typesafe.ai/v1/systemone')
    p.add_argument('--key-ref', default='typesafe', help='name of the key file in the ai-arch secret store')
    p.add_argument('--body', help='JSON file to send instead of the built-in guess')
    p.add_argument('--show-body', action='store_true', help='print the request body and exit (sends nothing)')
    p.add_argument('--yes', action='store_true', help='send without asking')
    p.add_argument('--model', help='model id to send (default: the body\'s own)')
    p.add_argument('--timeout', type=float, default=30)
    a = p.parse_args()

    body = json.loads(Path(a.body).read_text()) if a.body else GUESS
    if a.model:
        body = {**body, 'model': a.model}
    if a.show_body:
        print(json.dumps(body, indent=2))
        return
    secret, source = key(a.key_ref)
    print(f'== POST {a.url}  (key from {source})')
    print('Sends only the built-in sample text above (no project data), unless --body is given.')
    if not a.yes and input('Send one request to TypeSafe? [y/N] ').strip().lower() != 'y':
        return

    request = urllib.request.Request(a.url, data=json.dumps(body).encode(), method='POST', headers={
        'Authorization': 'Bearer ' + secret, 'Content-Type': 'application/json', 'Accept': 'application/json'})
    started = time.monotonic()
    try:
        with urllib.request.urlopen(request, timeout=a.timeout) as response:
            status, headers, raw = response.status, dict(response.headers), response.read()
    except urllib.error.HTTPError as exc:
        status, headers, raw = exc.code, dict(exc.headers or {}), exc.read()
    except (urllib.error.URLError, OSError) as exc:
        sys.exit(f'Request failed: {exc}')
    elapsed = time.monotonic() - started

    print(f'== HTTP {status} in {elapsed * 1000:.0f} ms')
    interesting = {k: v for k, v in headers.items() if k.lower().startswith(('x-', 'ratelimit', 'retry', 'content-type'))}
    print('== headers\n' + json.dumps(interesting, indent=2))
    text = raw.decode('utf-8', 'replace').replace(secret, '[key]')
    try:
        parsed = json.loads(text)
    except ValueError:
        print('== body (not JSON)\n' + text[:4000])
        return
    print('== shape\n' + shape(parsed))
    print('== body\n' + json.dumps(parsed, indent=2)[:8000])


if __name__ == '__main__':
    main()
