#!/usr/bin/env python3
"""Small, local-only Hermes to OpenCode prompt journal and dashboard."""
import html
import json
import os
import sqlite3
import subprocess
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

BASE = os.environ.get("OPENCODE_URL", "http://127.0.0.1:45381").rstrip("/")
PORT = int(os.environ.get("DASHBOARD_PORT", "8765"))
DB = Path(__file__).with_name("activity.sqlite3")
LOCK = threading.Lock()
PAUSED = False

def now():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")

def db():
    conn = sqlite3.connect(DB)
    conn.row_factory = sqlite3.Row
    conn.execute("CREATE TABLE IF NOT EXISTS tasks (id INTEGER PRIMARY KEY, created TEXT, session TEXT, prompt TEXT, status TEXT, result TEXT, notified INTEGER DEFAULT 0)")
    conn.execute("CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY, created TEXT, task_id INTEGER, kind TEXT, detail TEXT)")
    conn.commit()
    return conn

def event(task, kind, detail):
    with db() as c:
        c.execute("INSERT INTO events(created,task_id,kind,detail) VALUES(?,?,?,?)", (now(), task, kind, str(detail)[:8000]))

def api(path, method="GET", data=None):
    body = None if data is None else json.dumps(data).encode()
    req = urllib.request.Request(BASE + path, data=body, method=method,
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=20) as response:
        raw = response.read()
        return json.loads(raw) if raw else None

def notify(task, status):
    try:
        subprocess.run(["hermes", "send", "--to", "push", f"TrialProject task {task}: {status}. Open the dashboard for details."],
                       timeout=20, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
        event(task, "notification", "Push delivered")
    except Exception as exc:
        event(task, "notification error", str(exc))

def watch(task, session):
    """Poll structured messages and status; works even if event SSE disconnects."""
    seen = set()
    idle_since = None
    deadline = time.monotonic() + 900
    while time.monotonic() < deadline:
        try:
            messages = api(f"/session/{urllib.parse.quote(session)}/message") or []
            for msg in messages:
                info = msg.get("info", {})
                if info.get("role") != "assistant":
                    continue
                for part in msg.get("parts", []):
                    key = (info.get("id"), part.get("id"), part.get("type"), json.dumps(part, sort_keys=True))
                    if key in seen:
                        continue
                    seen.add(key)
                    if part.get("type") == "tool":
                        event(task, "tool", f"{part.get('tool', 'tool')}: {part.get('state', {}).get('status', '')}")
                    elif part.get("type") == "text" and part.get("text"):
                        # Only final text is shown; intermediate changes are still updated on completion.
                        pass
            statuses = api("/session/status") or {}
            active = statuses.get(session)
            has_assistant = any(m.get("info", {}).get("role") == "assistant" for m in messages)
            if has_assistant and (active is None or (isinstance(active, dict) and active.get("type") == "idle")):
                idle_since = idle_since or time.monotonic()
                if time.monotonic() - idle_since >= 4:
                    texts = [p.get("text", "") for m in messages if m.get("info", {}).get("role") == "assistant" for p in m.get("parts", []) if p.get("type") == "text"]
                    result = "\n".join(texts).strip()[-20000:]
                    if not result:
                        raise RuntimeError("Session ended without an assistant response; check OpenCode permissions and model configuration")
                    with db() as c:
                        c.execute("UPDATE tasks SET status='completed',result=? WHERE id=?", (result, task))
                    event(task, "completed", result[:1000])
                    notify(task, "completed")
                    return
            else:
                idle_since = None
        except Exception as exc:
            event(task, "poll error", str(exc))
        time.sleep(2)
    with db() as c:
        c.execute("UPDATE tasks SET status='timed out',result=? WHERE id=?", ("Monitoring timed out after 15 minutes", task))
    notify(task, "timed out")

PAGE = '''<!doctype html><html lang="en"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>TrialProject · Agent Control</title><style>
:root{color-scheme:dark;font-family:system-ui;background:#0c111b;color:#e8eef7}body{max-width:1100px;margin:auto;padding:18px}
header{display:flex;align-items:center;justify-content:space-between}h1{font-size:1.45rem}small,.muted{color:#9cabbe}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:14px}.card{background:#151e2d;border:1px solid #30405a;border-radius:14px;padding:16px;margin:12px 0}
button{background:#4adeaa;border:0;border-radius:8px;padding:10px 15px;font-weight:700;cursor:pointer}button.secondary{background:#344256;color:white}
textarea{width:100%;min-height:130px;background:#0c111b;color:white;border:1px solid #40516c;border-radius:8px;padding:10px;box-sizing:border-box}
pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#0c111b;border-radius:8px;padding:12px;max-height:280px;overflow:auto}
.label{color:#4adeaa;font-weight:700}.event{border-left:3px solid #5a94eb;padding:6px 12px;margin:8px 0}details{margin-top:12px}
@media(max-width:700px){.grid{grid-template-columns:1fr}}
</style><header><div><h1>Agent Control</h1><small>TrialProject · local dashboard</small></div><strong id="health">Connecting</strong></header>
<div class="grid"><section class="card"><h2>Submit a Hermes prompt</h2><p class="muted">Paste a prompt here, or have Hermes POST it to /api/tasks. Every submission is saved exactly as sent.</p>
<form id="form"><textarea id="prompt" placeholder="Describe a read-only task for OpenCode"></textarea><p><button>Send to OpenCode</button> <button class="secondary" type="button" id="pause">Pause new tasks</button></p></form><small id="feedback"></small></section>
<section class="card"><h2>Current tasks</h2><div id="tasks"></div></section></div><section class="card"><h2>Activity</h2><div id="events"></div></section>
<script>
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
async function refresh(){try{const r=await fetch('/api/state');const d=await r.json();document.getElementById('health').textContent=d.paused?'PAUSED':'LIVE';
document.getElementById('pause').textContent=d.paused?'Resume new tasks':'Pause new tasks';
document.getElementById('tasks').innerHTML=d.tasks.length?d.tasks.map(t=>`<div><span class="label">#${t.id} · ${esc(t.status)}</span> <small>${esc(t.created)}</small><details><summary>Exact prompt</summary><pre>${esc(t.prompt)}</pre></details>${t.result?`<details><summary>Result</summary><pre>${esc(t.result)}</pre></details>`:''}</div><hr>`).join(''):'<p class="muted">No tasks yet.</p>';
document.getElementById('events').innerHTML=d.events.map(e=>`<div class="event"><small>${esc(e.created)} · task ${e.task_id}</small><br><b>${esc(e.kind)}</b> ${esc(e.detail)}</div>`).join('');
}catch(e){document.getElementById('health').textContent='Disconnected'}}
document.getElementById('form').onsubmit=async e=>{e.preventDefault();let r=await fetch('/api/tasks',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({prompt:document.getElementById('prompt').value})});document.getElementById('feedback').textContent=JSON.stringify(await r.json());refresh()};
document.getElementById('pause').onclick=async()=>{await fetch('/api/pause',{method:'POST'});refresh()};setInterval(refresh,2000);refresh();
</script></html>'''

class Handler(BaseHTTPRequestHandler):
    def reply(self, code, obj):
        data = json.dumps(obj).encode()
        self.send_response(code); self.send_header("Content-Type", "application/json"); self.send_header("Content-Length", str(len(data)))
        self.end_headers(); self.wfile.write(data)

    def do_GET(self):
        if self.path == "/":
            data = PAGE.encode(); self.send_response(200); self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(data))); self.end_headers(); self.wfile.write(data)
        elif self.path == "/api/state":
            with db() as c:
                tasks = [dict(x) for x in c.execute("SELECT id,created,session,prompt,status,result FROM tasks ORDER BY id DESC LIMIT 20")]
                events = [dict(x) for x in c.execute("SELECT created,task_id,kind,detail FROM events ORDER BY id DESC LIMIT 50")]
            self.reply(200, {"paused": PAUSED, "tasks": tasks, "events": events})
        else: self.reply(404, {"error": "Not found"})

    def do_POST(self):
        global PAUSED
        if self.path == "/api/pause":
            with LOCK: PAUSED = not PAUSED
            return self.reply(200, {"paused": PAUSED})
        if self.path != "/api/tasks": return self.reply(404, {"error": "Not found"})
        if PAUSED: return self.reply(409, {"error": "New tasks paused"})
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if length > 100000: return self.reply(413, {"error": "Prompt too large"})
            prompt = json.loads(self.rfile.read(length)).get("prompt", "").strip()
            if not prompt: return self.reply(400, {"error": "Prompt required"})
            session = api("/session", "POST", {"title": f"TrialProject {now()}"})["id"]
            with db() as c:
                cur = c.execute("INSERT INTO tasks(created,session,prompt,status,result) VALUES(?,?,?,?,?)", (now(), session, prompt, "submitting", ""))
                task = cur.lastrowid
            event(task, "prompt", prompt)
            api(f"/session/{urllib.parse.quote(session)}/prompt_async", "POST", {"parts": [{"type": "text", "text": prompt}]})
            with db() as c: c.execute("UPDATE tasks SET status='running' WHERE id=?", (task,))
            event(task, "submitted", f"OpenCode session {session}")
            threading.Thread(target=watch, args=(task, session), daemon=True).start()
            self.reply(201, {"task": task, "session": session})
        except Exception as exc:
            if 'task' in locals():
                with db() as c: c.execute("UPDATE tasks SET status='failed',result=? WHERE id=?", (str(exc), task))
                event(task, "failed", str(exc)); threading.Thread(target=notify, args=(task, "failed"), daemon=True).start()
            self.reply(502, {"error": str(exc)})

if __name__ == "__main__":
    db().close()
    print(f"Dashboard: http://127.0.0.1:{PORT} | OpenCode: {BASE}", flush=True)
    ThreadingHTTPServer(("100.79.242.24", PORT), Handler).serve_forever()
