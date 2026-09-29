"""OpenCode HTTP API adapter. Standard library only."""
import base64
import json
from pathlib import Path
import urllib.error
import urllib.parse
import urllib.request

from errors import OpenCodeHTTPError, ReviewConflict


class OpenCode:
    def __init__(self, settings):
        self.s = settings
        # Local API must not be sent through a configured outbound HTTP proxy.
        self.http = urllib.request.build_opener(urllib.request.ProxyHandler({}))

    def request(self, path, method='GET', data=None, directory=None):
        # OpenCode scopes sessions, status, approvals, and replies by directory. Single
        # mode uses the project folder; each multi-agent worktree passes its own.
        query = urllib.parse.urlencode({'directory': str(directory or self.s.project)})
        url = self.s.opencode_url.rstrip('/') + path + ('&' if '?' in path else '?') + query
        headers = {'Content-Type': 'application/json', 'Accept': 'application/json'}
        if self.s.password:
            auth = base64.b64encode((self.s.username + ':' + self.s.password).encode()).decode()
            headers['Authorization'] = 'Basic ' + auth
        req = urllib.request.Request(url, method=method, headers=headers,
            data=None if data is None else json.dumps(data).encode())
        try:
            with self.http.open(req, timeout=20) as response:
                raw = response.read()
                return json.loads(raw) if raw else None
        except urllib.error.HTTPError as exc:
            message = exc.read(4000).decode(errors='replace')
            raise OpenCodeHTTPError(method, path, exc.code, message) from exc

    def health(self):
        health = self.request('/global/health')
        if not isinstance(health, dict) or not health.get('healthy'):
            raise RuntimeError('OpenCode health check did not report healthy')
        path = self.request('/path')
        actual = path.get('directory') if isinstance(path, dict) else None
        if not actual or Path(actual).resolve() != self.s.project.resolve():
            raise RuntimeError(f'OpenCode directory mismatch: expected {self.s.project}; received {actual!r}')
        return health

    def pending(self, session, directory=None):
        result = []
        for kind, path in (('permission', '/permission'), ('question', '/question')):
            try:
                items = self.request(path, directory=directory)
            except RuntimeError as exc:
                if 'HTTP 404' in str(exc):
                    continue
                raise
            if isinstance(items, list):
                result.extend({**item, 'kind': kind} for item in items if isinstance(item, dict) and item.get('sessionID') == session)
        return result

    def respond(self, session, request, action, answers=None, directory=None):
        ident = urllib.parse.quote(str(request.get('id') or request.get('requestID')), safe='')
        if request['kind'] == 'question':
            if action == 'reject':
                return self.request(f'/question/{ident}/reject', 'POST', {}, directory=directory)
            return self.request(f'/question/{ident}/reply', 'POST', {'answers': answers}, directory=directory)
        reply = 'once' if action == 'approve' else 'reject'
        try:
            return self.request(f'/permission/{ident}/reply', 'POST', {'reply': reply}, directory=directory)
        except OpenCodeHTTPError as exc:
            if exc.status not in (404, 405):
                raise
            # Only use the older documented route when the new route is absent,
            # and only while this exact request still exists in this session.
            present = self.pending(session, directory)
            current = next((p for p in present if p.get('kind') == 'permission' and (p.get('id') or p.get('requestID')) == (request.get('id') or request.get('requestID'))), None)
            if current is None:
                raise ReviewConflict('OpenCode no longer has this approval request.') from exc
            if current != request:
                raise ReviewConflict('The requested action changed before the decision could be sent.') from exc
            sid = urllib.parse.quote(session, safe='')
            return self.request(f'/session/{sid}/permissions/{ident}', 'POST', {'response': reply}, directory=directory)
