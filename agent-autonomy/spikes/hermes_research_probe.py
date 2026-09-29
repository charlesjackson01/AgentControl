#!/usr/bin/env python3
"""M12 probe (run on your server): what does your Hermes offer for a research agent?

AgentControl never guesses Hermes toolset names. This prints what your Hermes reports, so you can
start AgentControl with --research-toolsets <names> (for example: web,browser). It only reads
help and list output; nothing is sent to the internet unless you add --try, which asks first.

    python3 agent-autonomy/spikes/hermes_research_probe.py [--hermes hermes] [--profile ai-arch-dev] [--try web,browser]
"""
import argparse
import json
import re
import shutil
import subprocess
import tempfile


def run(argv, timeout=60, cwd=None):
    try:
        done = subprocess.run(argv, capture_output=True, text=True, timeout=timeout, cwd=cwd)
        return done.returncode, (done.stdout + done.stderr)
    except (OSError, subprocess.TimeoutExpired) as exc:
        return None, str(exc)


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument('--hermes', default=shutil.which('hermes') or 'hermes')
    p.add_argument('--profile', default='ai-arch-dev')
    p.add_argument('--try', dest='try_toolsets', default='', help='comma-separated toolsets for one real research call (uses the internet)')
    a = p.parse_args()
    prefix = [a.hermes] + (['--profile', a.profile] if a.profile else [])

    print('== hermes --version')
    print(run(prefix + ['--version'])[1].strip()[:400])
    code, chat_help = run(prefix + ['chat', '--help'])
    flags = {flag: flag in chat_help for flag in ('--toolsets', '--provider', '--model', '-m', '--run-budget', '--max-turns', '--oneshot',
                                                   '--query-file', '--safe-mode', '--in', 'stream-json', '--yolo')}
    print('== chat flags AgentControl uses or avoids')
    print(json.dumps(flags, indent=2))
    print('== toolsets as described in chat --help')
    for line in chat_help.splitlines():
        if re.search(r'toolset|-t\b', line, re.I):
            print('   ' + line.strip())
    print('== toolset listings (whichever your Hermes supports)')
    for argv in (['tools', 'list'], ['toolsets', 'list'], ['tools'], ['toolsets']):
        code, out = run(prefix + argv, 30)
        if code == 0 and out.strip():
            print(f'$ hermes {" ".join(argv)}')
            print(out.strip()[:4000])
            names = sorted(set(re.findall(r'\b([a-z][a-z0-9_-]*(?:web|browser|search|fetch)[a-z0-9_-]*|(?:web|browser|search|fetch)[a-z0-9_-]*)\b', out)))
            print('   candidates for research:', ', '.join(names) or 'none recognised; pick from the list above')
            break
    else:
        print('   No list command worked. Pick toolset names from the help text above.')
    if a.try_toolsets:
        answer = input(f'Run one research call with toolsets {a.try_toolsets}? It browses the internet. Type yes: ')
        if answer.strip().lower() != 'yes':
            return
        with tempfile.TemporaryDirectory() as scratch:
            argv = prefix + ['chat', '--quiet', '--oneshot', '--toolsets', a.try_toolsets, '--max-turns', '8', '--query',
                             'Find the current stable version of Python and cite the page you used. Answer in one sentence with the URL.']
            code, out = run(argv, 600, cwd=scratch)
            print(f'== exit {code}')
            print(out.strip()[-3000:])


if __name__ == '__main__':
    main()
