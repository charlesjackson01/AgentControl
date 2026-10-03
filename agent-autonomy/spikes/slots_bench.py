#!/usr/bin/env python3
"""M0 spike: how many agents can share one llama-server at once?

Sends N simultaneous chat completions and reports per-request latency and
aggregate throughput, plus the server's own slot/context settings.
Read-only against the model server; standard library only.

    python3 slots_bench.py --url http://127.0.0.1:8080 --concurrency 1 2 3
    python3 slots_bench.py --url ... --json > slots-np1.json

Run it once with your current server (-np 1), then restart llama-server with
more slots (e.g. -np 2 and a larger -c) and run it again. Compare the tables.
"""
import argparse
import json
import statistics
import threading
import time
import urllib.request

PROMPT = ('Write a numbered list of 40 short, distinct tips for writing maintainable Python code. '
          'One line each. No introduction.')


def get(url, timeout=10):
    try:
        with urllib.request.urlopen(url, timeout=timeout) as r:
            return json.load(r)
    except Exception as exc:  # the server may not expose every endpoint
        return {'error': str(exc)}


def complete(base, model, max_tokens, results, index):
    body = json.dumps({'model': model, 'messages': [{'role': 'user', 'content': PROMPT}],
                       'max_tokens': max_tokens, 'temperature': 0.2, 'stream': False}).encode()
    req = urllib.request.Request(base + '/v1/chat/completions', data=body, headers={'Content-Type': 'application/json'})
    start = time.monotonic()
    try:
        with urllib.request.urlopen(req, timeout=900) as r:
            data = json.load(r)
        tokens = (data.get('usage') or {}).get('completion_tokens') or 0
        timings = data.get('timings') or {}
        results[index] = {'ok': True, 'seconds': time.monotonic() - start, 'tokens': tokens,
                          'server_prompt_ms': timings.get('prompt_ms'), 'server_predicted_per_second': timings.get('predicted_per_second')}
    except Exception as exc:
        results[index] = {'ok': False, 'seconds': time.monotonic() - start, 'error': str(exc)}


def round_(base, model, n, max_tokens):
    results = [None] * n
    threads = [threading.Thread(target=complete, args=(base, model, max_tokens, results, i)) for i in range(n)]
    start = time.monotonic()
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    wall = time.monotonic() - start
    ok = [r for r in results if r['ok']]
    tokens = sum(r['tokens'] for r in ok)
    return {'concurrency': n, 'wall_seconds': round(wall, 2), 'ok': len(ok), 'failed': n - len(ok),
            'total_tokens': tokens, 'aggregate_tok_per_s': round(tokens / wall, 1) if wall else 0,
            'per_request_tok_per_s': [round(r['tokens'] / r['seconds'], 1) for r in ok if r['seconds']],
            'latency_seconds': {'min': round(min(r['seconds'] for r in ok), 2), 'median': round(statistics.median(r['seconds'] for r in ok), 2),
                                'max': round(max(r['seconds'] for r in ok), 2)} if ok else None,
            'errors': [r['error'] for r in results if not r['ok']][:3]}


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument('--url', default='http://127.0.0.1:8080')
    p.add_argument('--model', default='', help='model id; default: first from /v1/models')
    p.add_argument('--concurrency', type=int, nargs='+', default=[1, 2, 3])
    p.add_argument('--max-tokens', type=int, default=256)
    p.add_argument('--json', action='store_true')
    a = p.parse_args()
    base = a.url.rstrip('/')
    models = get(base + '/v1/models')
    model = a.model or ((models.get('data') or [{}])[0].get('id') if isinstance(models, dict) else '') or 'default'
    props = get(base + '/props')
    server = {'model': model, 'total_slots': props.get('total_slots'),
              'n_ctx_per_slot': (props.get('default_generation_settings') or {}).get('n_ctx'),
              'props_error': props.get('error')}
    complete(base, model, 16, [None], 0)  # warm-up, not measured
    rounds = [round_(base, model, n, a.max_tokens) for n in a.concurrency]
    report = {'server': server, 'max_tokens': a.max_tokens, 'rounds': rounds}
    if a.json:
        print(json.dumps(report, indent=2))
        return
    print(f"server: slots={server['total_slots']} ctx/slot={server['n_ctx_per_slot']} model={model}")
    print(f"{'agents':>6} {'wall s':>8} {'tokens':>7} {'agg tok/s':>10} {'median s':>9}  per-request tok/s")
    for r in rounds:
        lat = r['latency_seconds'] or {}
        print(f"{r['concurrency']:>6} {r['wall_seconds']:>8} {r['total_tokens']:>7} {r['aggregate_tok_per_s']:>10} {lat.get('median', '-'):>9}  {r['per_request_tok_per_s']}"
              + (f"  FAILED: {r['errors']}" if r['failed'] else ''))
    print('\nAlso record VRAM with:  nvidia-smi --query-gpu=memory.used,memory.total --format=csv')


if __name__ == '__main__':
    main()
