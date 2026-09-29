#!/usr/bin/env python3
"""Runs inside an agent container (M10). The container has no network, so everything goes
through Unix sockets in a folder shared with AgentControl:

  serve <workdir> <sockets> <opencode-port> <model-port>
      starts `opencode serve` on 127.0.0.1:<opencode-port> in <workdir>, then relays
        <sockets>/api.sock      -> 127.0.0.1:<opencode-port>   (AgentControl talks to OpenCode)
        127.0.0.1:<model-port>  -> <sockets>/model.sock        (OpenCode reaches the model via
                                                               AgentControl's gateway)
      and exits when OpenCode exits.
  relay <port> <socket>
      relays <socket> -> 127.0.0.1:<port> (a web preview running in the container).

Standard library only; this file is mounted read-only into the container.
"""
import http.client
import os
import socket
import subprocess
import sys
import threading
import time


def pipe(a, b):
    try:
        while True:
            data = a.recv(65536)
            if not data:
                break
            b.sendall(data)
    except OSError:
        pass
    finally:
        for s in (a, b):
            try:
                s.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
            s.close()


def serve_forever(listener, connect):
    while True:
        client, _ = listener.accept()
        try:
            upstream = connect()
        except OSError:
            client.close()
            continue
        threading.Thread(target=pipe, args=(client, upstream), daemon=True).start()
        threading.Thread(target=pipe, args=(upstream, client), daemon=True).start()


def unix_listener(path):
    if os.path.exists(path):
        os.unlink(path)
    server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    server.bind(path)
    os.chmod(path, 0o660)
    server.listen(64)
    return server


def tcp_listener(port):
    server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    server.bind(('127.0.0.1', port))
    server.listen(64)
    return server


def to_tcp(port):
    return lambda: socket.create_connection(('127.0.0.1', port), timeout=10)


def to_unix(path):
    def connect():
        s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        s.connect(path)
        return s
    return connect


def serve(workdir, sockets, opencode_port, model_port):
    opencode = subprocess.Popen(['opencode', 'serve', '--hostname', '127.0.0.1', '--port', str(opencode_port)], cwd=workdir)
    threading.Thread(target=serve_forever, args=(tcp_listener(model_port), to_unix(os.path.join(sockets, 'model.sock'))), daemon=True).start()
    # OpenCode opens its port a moment before it answers HTTP; wait for a real health reply.
    deadline = time.monotonic() + 120
    while time.monotonic() < deadline and opencode.poll() is None:
        try:
            connection = http.client.HTTPConnection('127.0.0.1', opencode_port, timeout=5)
            connection.request('GET', '/global/health')
            if connection.getresponse().status == 200:
                break
        except (OSError, http.client.HTTPException):
            pass
        time.sleep(.3)
    api = unix_listener(os.path.join(sockets, 'api.sock'))
    threading.Thread(target=serve_forever, args=(api, to_tcp(opencode_port)), daemon=True).start()
    with open(os.path.join(sockets, 'ready'), 'w') as f:
        f.write(str(opencode.pid))
    sys.exit(opencode.wait())


def main(argv):
    if argv[:1] == ['serve'] and len(argv) == 5:
        serve(argv[1], argv[2], int(argv[3]), int(argv[4]))
    elif argv[:1] == ['relay'] and len(argv) == 3:
        serve_forever(unix_listener(argv[2]), to_tcp(int(argv[1])))
    else:
        sys.exit(__doc__)


if __name__ == '__main__':
    main(sys.argv[1:])
