#!/usr/bin/env python3
"""mock-endpoint — scripted OpenAI-compatible server for T4 tests.

stdlib only. Scripts (selected per request via X-AIARCH-Script header or
?script= query param):
  ok             normal streamed completion + usage + [DONE]
  slow           like ok, MOCK_SLOW_DELAY (default 2.0) seconds between chunks
  fail-midstream 5 chunks, then the socket closes (no [DONE])
  bad-json       SSE data lines are malformed JSON
  tool-call      turn 1: tool_calls (files.read /tmp/ok.txt); turn 2 (a
                 "tool" role message present): final content
  injection      tool_call targeting an excluded path (~/.ssh/id_rsa)
  no-model       /v1/models returns a list without the usual models

Usage: python3 server.py [--port 8317]
"""
import json
import os
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

DEFAULT_PORT = int(os.environ.get("MOCK_PORT", "8317"))
SLOW_DELAY = float(os.environ.get("MOCK_SLOW_DELAY", "2.0"))
MODELS = ["mock-model", "mock-model-2"]


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):  # keep test output readable
        sys.stderr.write("mock-endpoint: " + fmt % args + "\n")

    def _script(self):
        s = self.headers.get("X-AIARCH-Script", "")
        if not s:
            q = parse_qs(urlparse(self.path).query)
            s = (q.get("script", [""])[0])
        return s or "ok"

    def _send_json(self, obj, code=200):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _send_error_json(self, msg, code=400):
        self._send_json({"error": {"message": msg, "type": "invalid_request_error"}}, code)

    def _sse(self, data_lines, close_after=True):
        """Write an SSE body with no Content-Length (streaming)."""
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "close")
        self.end_headers()
        for line in data_lines:
            self.wfile.write(("data: " + line + "\n\n").encode())
            self.wfile.flush()
        if close_after:
            try:
                self.wfile.flush()
            except BrokenPipeError:
                pass

    def do_GET(self):
        path = urlparse(self.path).path
        if path == "/v1/models":
            script = self._script()
            models = ["mock-other"] if script == "no-model" else MODELS
            self._send_json({"object": "list", "data": [{"id": m, "object": "model"} for m in models]})
            return
        self._send_error_json("not found", 404)

    def do_POST(self):
        path = urlparse(self.path).path
        if path != "/v1/chat/completions":
            self._send_error_json("not found", 404)
            return
        length = int(self.headers.get("Content-Length", "0"))
        body = json.loads(self.rfile.read(length) or b"{}")
        script = self._script()

        if script == "fail-midstream":
            self._sse([
                json.dumps({"choices": [{"delta": {"content": "p"}}]}),
                json.dumps({"choices": [{"delta": {"content": "a"}}]}),
                json.dumps({"choices": [{"delta": {"content": "r"}}]}),
                json.dumps({"choices": [{"delta": {"content": "t"}}]}),
                json.dumps({"choices": [{"delta": {"content": "i"}}]}),
            ], close_after=False)  # close without [DONE]
            self.close_connection = True
            return

        if script == "bad-json":
            self._sse(["{not json"])
            return

        if script == "tool-call":
            has_tool_result = any(
                isinstance(m, dict) and m.get("role") == "tool" for m in body.get("messages", [])
            )
            if not has_tool_result:
                self._sse([json.dumps({
                    "choices": [{
                        "delta": {
                            "tool_calls": [{
                                "index": 0,
                                "id": "call_mock1",
                                "type": "function",
                                "function": {
                                    "name": "files.read",
                                    "arguments": json.dumps({"path": "/tmp/ok.txt"}),
                                },
                            }]
                        }
                    }]
                })], close_after=False)
                self.close_connection = True
            else:
                self._sse([
                    json.dumps({"choices": [{"delta": {"content": "Tool result processed: "}}]}),
                    json.dumps({"choices": [{"delta": {"content": "ok"}}]}),
                    json.dumps({"choices": [{"delta": {}}], "usage": {
                        "prompt_tokens": 10, "completion_tokens": 5}}),
                    "[DONE]",
                ])
            return

        if script == "injection":
            self._sse([json.dumps({
                "choices": [{
                    "delta": {
                        "tool_calls": [{
                            "index": 0,
                            "id": "call_inject1",
                            "type": "function",
                            "function": {
                                "name": "files.read",
                                "arguments": json.dumps({"path": "~/.ssh/id_rsa"}),
                            },
                        }]
                    }
                }]
            })], close_after=False)
            self.close_connection = True
            return

        # ok / slow
        delay = SLOW_DELAY if script == "slow" else 0.0
        text = ["Hello", " world", " from", " the", " mock"]
        lines = []
        for i, piece in enumerate(text):
            lines.append(json.dumps({"choices": [{"delta": {"content": piece}}]}))
            if delay and i < len(text) - 1:
                time.sleep(delay)
        lines.append(json.dumps({"choices": [{"delta": {}}], "usage": {
            "prompt_tokens": 8, "completion_tokens": len(text)}}))
        lines.append("[DONE]")
        self._sse(lines)


def main():
    port = DEFAULT_PORT
    args = sys.argv[1:]
    if "--port" in args:
        port = int(args[args.index("--port") + 1])
    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    print("mock-endpoint listening on 127.0.0.1:%d (scripts: ok slow fail-midstream "
          "bad-json tool-call injection no-model)" % port, file=sys.stderr)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
