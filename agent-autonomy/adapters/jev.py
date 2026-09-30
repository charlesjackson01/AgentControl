"""TypeSafe Jev adapter: typed questions about a text, answered with calibrated probabilities.

Jev is a hosted "System One" model (TypeSafe AI): it does not write text or call tools. The request
and reply formats below are the ones the J0 probe (spikes/jev_probe.py) confirmed against the live
API on 2026-09-30; nothing here is taken from documentation alone:

    POST https://api.typesafe.ai/v1/systemone   Authorization: Bearer <key>
    {"model": "jev-1.13.0", "state": "<text>", "questions": {
        "<name>": {"type": "noul",   "instructions": "<statement>"},
        "<name>": {"type": "choice", "criteria": {"<option>": "<description>", ...}},
        "<name>": {"type": "score",  "criteria": ["<level 0>", "<level 1>", ...]}}}
    -> {"model": "jev-1.13.0", "answers": {
          "<name>": {"type": "noul", "noul": 0.93},
          "<name>": {"type": "choice", "choice": "<option>", "confidence": 1.0, "probabilities": {...}},
          "<name>": {"type": "score", "score": 0.71, "confidence": 0.7, "legend": {...}, "probabilities": {...}}},
        "usage": {"input_tokens": 502, "output_tokens": 87}}

Unknown request fields are silently ignored by the API, so questions are built only through the
helpers here. Replies are validated strictly. A call never raises: it returns (answers, info)
where answers is None on any failure and info['error'] says why. The key is read per call from
the ai-arch secret store and never appears in results or errors. Standard library only.
"""
import json
import time
import urllib.error
import urllib.request

import models

URL = 'https://api.typesafe.ai/v1/systemone'
MODEL = 'jev-1.13.0'           # pinned: the answers must not shift when TypeSafe moves jev-latest
PRICE_IN = 42 / 1e9            # dollars per input token; output tokens are free (TypeSafe pricing)
MAX_STATE = 200_000            # characters; Jev reads at most 64K tokens per request


def noul(instructions):
    return {'type': 'noul', 'instructions': str(instructions)}


def choice(criteria):
    return {'type': 'choice', 'criteria': {str(k): str(v) for k, v in criteria.items()}}


def score(levels):
    return {'type': 'score', 'criteria': [str(level) for level in levels]}


def _probability(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and 0 <= value <= 1


def parse(questions, body):
    """The answers for exactly the questions asked, or raises ValueError naming what was wrong."""
    answers = body.get('answers') if isinstance(body, dict) else None
    if not isinstance(answers, dict):
        raise ValueError('reply has no answers object')
    result = {}
    for name, question in questions.items():
        answer = answers.get(name)
        if not isinstance(answer, dict) or answer.get('type') != question['type']:
            raise ValueError(f'no {question["type"]} answer for {name!r}')
        if question['type'] == 'noul':
            if not _probability(answer.get('noul')):
                raise ValueError(f'{name!r}: noul is not a probability')
            result[name] = {'probability': float(answer['noul'])}
        elif question['type'] == 'choice':
            if answer.get('choice') not in question['criteria'] or not _probability(answer.get('confidence')):
                raise ValueError(f'{name!r}: choice is not one of the options, or has no confidence')
            result[name] = {'choice': answer['choice'], 'confidence': float(answer['confidence']),
                            'probabilities': {k: float(v) for k, v in (answer.get('probabilities') or {}).items() if _probability(v)}}
        else:
            top = len(question['criteria']) - 1
            value = answer.get('score')
            if not isinstance(value, (int, float)) or isinstance(value, bool) or not 0 <= value <= max(top, 1) or not _probability(answer.get('confidence')):
                raise ValueError(f'{name!r}: score is out of range, or has no confidence')
            result[name] = {'score': float(value), 'confidence': float(answer['confidence'])}
    return result


class Jev:
    def __init__(self, key_ref, url=URL, model=MODEL, timeout=20.0, secret_dir=None, opener=None):
        self.key_ref = key_ref
        self.url = url
        self.model = model
        self.timeout = timeout
        self.secret_dir = secret_dir
        self.opener = opener or urllib.request.build_opener()

    def ask(self, state, questions):
        """(answers or None, info). info: model, tokens_in, tokens_out, duration_ms, cost, request_id, error."""
        info = {'model': self.model, 'tokens_in': None, 'tokens_out': None, 'duration_ms': None, 'cost': 0.0,
                'request_id': '', 'error': ''}
        try:
            key = models.read_secret(self.key_ref, self.secret_dir)
        except models.RegistryError as exc:
            return None, {**info, 'error': str(exc)}
        if not key:
            return None, {**info, 'error': 'No Jev key configured'}
        body = json.dumps({'model': self.model, 'state': str(state)[:MAX_STATE], 'questions': questions}).encode()
        request = urllib.request.Request(self.url, data=body, method='POST', headers={
            'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json', 'Accept': 'application/json'})
        started = time.monotonic()
        try:
            with self.opener.open(request, timeout=self.timeout) as response:
                info['request_id'] = response.headers.get('x-typesafe-request-id', '')[:80]
                raw = response.read(1_000_000)
        except urllib.error.HTTPError as exc:
            detail = exc.read(2000).decode('utf-8', 'replace').replace(key, '[key]')
            return None, {**info, 'duration_ms': int((time.monotonic() - started) * 1000),
                          'error': f'Jev replied HTTP {exc.code}: {detail[:500]}'}
        except (urllib.error.URLError, OSError, ValueError) as exc:
            return None, {**info, 'error': f'Jev could not be reached: {str(exc).replace(key, "[key]")[:300]}'}
        info['duration_ms'] = int((time.monotonic() - started) * 1000)
        try:
            reply = json.loads(raw)
            if not isinstance(reply, dict):
                raise ValueError('reply is not a JSON object')
            usage = reply.get('usage') if isinstance(reply.get('usage'), dict) else {}
            count = lambda v: v if isinstance(v, int) and not isinstance(v, bool) and v >= 0 else None
            info.update(model=str(reply.get('model') or self.model)[:80], tokens_in=count(usage.get('input_tokens')),
                        tokens_out=count(usage.get('output_tokens')))
            # Charge by reported input tokens; estimate (4 characters per token) only when Jev does not say.
            info['cost'] = (info['tokens_in'] if info['tokens_in'] is not None else len(body) // 4) * PRICE_IN
            return parse(questions, reply), info
        except ValueError as exc:
            return None, {**info, 'error': f'Jev reply was not understood: {exc}'}
