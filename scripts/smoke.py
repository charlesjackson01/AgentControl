#!/usr/bin/env python3
"""Hermetic browser integration smoke against real BE + FE and a scripted model.

Prerequisites: npm ci in both projects, npm run build in AgentControlBE,
Python playwright, and Chromium. No real model/server credentials are used.
Run: python3 scripts/smoke.py [--artifacts /tmp/agentcontrol-smoke]
"""

import argparse
import json
import os
from pathlib import Path
import re
import shutil
import signal
import socket
import subprocess
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.error import URLError
from urllib.request import ProxyHandler, Request, build_opener

from playwright.sync_api import expect, sync_playwright

ROOT = Path(__file__).resolve().parents[1]
HTTP = build_opener(ProxyHandler({}))


def api(base, path, method="GET", data=None):
    body = json.dumps(data).encode() if data is not None else None
    request = Request(base + path, data=body, method=method, headers={"Content-Type": "application/json"})
    with HTTP.open(request, timeout=15) as response:
        raw = response.read()
        return json.loads(raw) if raw else None


def free_port():
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def wait_ready(url, processes):
    deadline = time.monotonic() + 30
    while time.monotonic() < deadline:
        if any(process.poll() is not None for process in processes):
            raise RuntimeError("A smoke server exited before becoming ready; see server logs.")
        try:
            with HTTP.open(url, timeout=1) as response:
                if response.status == 200:
                    return
        except (URLError, TimeoutError):
            pass
        time.sleep(0.1)
    raise RuntimeError(f"Timed out waiting for {url}")


class Model(BaseHTTPRequestHandler):
    """Emit one requested tool call, then echo its actual backend result."""

    requests = []

    def log_message(self, *_args):
        pass

    def answer(self, body, status=200):
        raw = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def do_GET(self):
        if self.path != "/v1/models":
            return self.answer({"error": "Unexpected model path"}, 404)
        self.answer({"data": [{"id": "smoke-model", "object": "model"}]})

    def do_POST(self):
        if self.path != "/v1/chat/completions":
            return self.answer({"error": "Unexpected completion path"}, 404)
        request = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        self.requests.append(request)
        messages = request["messages"]
        if messages[-1]["role"] == "tool":
            message = {"role": "assistant", "content": "Smoke tool result: " + messages[-1]["content"]}
            finish = "stop"
        else:
            latest = next(message["content"] for message in reversed(messages) if message["role"] == "user")
            match = re.fullmatch(r"#tool (\w+) (.+)", latest, flags=re.S)
            if not match:
                return self.answer({"error": "Expected #tool NAME JSON"}, 400)
            name, args = match.groups()
            json.loads(args)
            offered = {tool["function"]["name"] for tool in request.get("tools", [])}
            if name not in offered:
                return self.answer({"error": f"Requested tool {name} was not offered"}, 400)
            message = {"role": "assistant", "content": None, "tool_calls": [{
                "id": "smoke_call_" + str(len(self.requests)), "type": "function",
                "function": {"name": name, "arguments": args},
            }]}
            finish = "tool_calls"
        self.answer({"id": "smoke_completion", "object": "chat.completion", "model": "smoke-model",
                     "choices": [{"index": 0, "message": message, "finish_reason": finish}]})


def check(condition, message):
    if not condition:
        raise AssertionError(message)


def exercise(page, front, back, model_base, artifacts):
    errors = []
    page.on("pageerror", lambda error: errors.append(str(error)))
    page.set_default_timeout(10_000)
    endpoint = api(back, "/api/endpoints", "POST", {
        "name": "Smoke Model", "kind": "openai-compatible", "baseUrl": model_base,
        "defaultModel": "smoke-model", "contextWindow": 32768,
    })
    disposable = api(back, "/api/endpoints", "POST", {
        "name": "Disposable Smoke", "kind": "openai-compatible", "baseUrl": model_base,
        "defaultModel": "smoke-model", "contextWindow": 32768,
    })

    page.goto(front + "/skills")
    page.get_by_role("button", name="New Skill", exact=True).click()
    dialog = page.get_by_role("dialog", name="New skill", exact=True)
    dialog.get_by_role("textbox", name="Name", exact=True).fill("Smoke Capability")
    dialog.get_by_role("textbox", name="Content", exact=True).fill("Call the requested built-in tool and report its result.")
    dialog.get_by_role("checkbox", name=re.compile(r"^calculate\b")).check()
    dialog.get_by_role("checkbox", name=re.compile(r"^save_note\b")).check()
    dialog.get_by_role("button", name="Remove calculate", exact=True).click()
    expect(dialog.get_by_role("checkbox", name=re.compile(r"^calculate\b"))).not_to_be_checked()
    dialog.get_by_role("checkbox", name=re.compile(r"^calculate\b")).check()
    dialog.get_by_role("button", name="Create skill", exact=True).click()
    expect(dialog).not_to_be_visible()
    skill = next(skill for skill in api(back, "/api/skills") if skill["name"] == "Smoke Capability")
    check({tool["name"] for tool in skill["tools"]} == {"calculate", "save_note"}, "UI selection was not saved")
    print("PASS skill create, registry selection, chip removal", flush=True)

    legacy = {"name": "legacy_custom", "description": "Preserve original", "parameters": {"type": "object", "properties": {"original": {"type": "boolean"}}}}
    api(back, f"/api/skills/{skill['id']}", "PATCH", {"tools": skill["tools"] + [legacy]})
    page.reload()
    page.get_by_role("button", name=re.compile(r"Smoke Capability")).click()
    page.get_by_role("dialog", name="Smoke Capability", exact=True).get_by_role("button", name="Edit", exact=True).click()
    editor = page.get_by_role("dialog", name="Edit Smoke Capability", exact=True)
    expect(editor.get_by_role("button", name="Remove legacy_custom (unavailable)", exact=True)).to_be_visible()
    editor.get_by_label("Description", exact=True).fill("Edited with a legacy tool intact.")
    editor.get_by_role("checkbox", name=re.compile(r"^list_notes\b")).check()
    editor.get_by_role("button", name="Save changes", exact=True).click()
    expect(editor).not_to_be_visible()
    edited = api(back, f"/api/skills/{skill['id']}")
    check(legacy in edited["tools"], "Edit lost or changed the legacy declaration")
    check(any(tool["name"] == "list_notes" for tool in edited["tools"]), "Edit did not add registry tool")
    print("PASS skill edit preserves unknown tool declarations", flush=True)

    page.get_by_role("button", name="Import SKILL.md", exact=True).click()
    importer = page.get_by_role("dialog", name="Import SKILL.md", exact=True)
    importer.get_by_label("SKILL.md text", exact=True).fill(
        "---\nname: Smoke Import\ndescription: Comment-aware import\ntools: # inline comment\n"
        "  - calculate # ignored words\n# preserve block\n  - save_note\n  - unavailable_tool\n---\nUse the declared tools."
    )
    expect(importer.get_by_text("Tools to import", exact=True)).to_be_visible()
    expect(importer.get_by_text(re.compile(r"Ignored.*unavailable_tool"))).to_be_visible()
    importer.get_by_role("button", name="Import skill", exact=True).click()
    expect(importer).not_to_be_visible()
    imported = api(back, "/api/skills/smoke-import")
    check([tool["name"] for tool in imported["tools"]] == ["calculate", "save_note"], "Import disagreed with preview")
    page.screenshot(path=str(artifacts / "skills.png"), full_page=True, animations="disabled")
    print("PASS SKILL.md comment parsing, tool preview and import", flush=True)

    agent = api(back, "/api/agents", "POST", {
        "name": "Smoke Agent", "role": "Team Lead", "description": "Isolated smoke agent",
        "instructions": "Execute requested tools.", "modelId": "smoke-model", "endpointId": endpoint["id"],
        "skillIds": [skill["id"]], "temperature": 0.3, "isPrimary": True,
    })
    page.goto(front + f"/agents/{agent['id']}")
    malicious_body = '<img src=x onerror="window.smokeInjected=true">\nSaved safely as literal note text.'
    for name, arguments in [
        ("calculate", {"expression": "6 * 7"}),
        ("save_note", {"title": "Smoke Memory", "body": malicious_body, "tags": ["smoke", "planning"]}),
    ]:
        page.get_by_role("textbox", name="Message", exact=True).fill(f"#tool {name} {json.dumps(arguments)}")
        with page.expect_response(lambda response: response.url.endswith(f"/api/agents/{agent['id']}/runs") and response.request.method == "POST") as pending:
            page.get_by_role("button", name="Send", exact=True).click()
        response = pending.value
        check(response.status == 200, f"Agent run failed: {response.status} {response.text()}")
        run = response.json()
        check(run["status"] == "succeeded", f"Agent run did not succeed: {run}")
        check(any(call["name"] == name and call["ok"] for call in run["toolCalls"]), f"Tool {name} did not execute")
        check("Smoke tool result:" in run["output"], "Scripted model did not receive a tool result")
        if name == "calculate":
            check('"result":42' in run["output"].replace(" ", ""), "Calculation returned the wrong result")
        expect(page.get_by_role("button", name="Send", exact=True)).to_be_visible()
    page.screenshot(path=str(artifacts / "agent-runs.png"), full_page=True, animations="disabled")
    print("PASS browser agent runs execute calculate and persist save_note", flush=True)

    page.get_by_role("link", name="Notes", exact=True).click()
    search = page.get_by_role("searchbox", name="Search notes", exact=True)
    search.fill("not a matching note")
    expect(page.get_by_text("No notes match", exact=True)).to_be_visible()
    search.fill("planning")
    page.get_by_role("button", name=re.compile(r"Smoke Memory")).click()
    detail = page.get_by_role("dialog", name="Smoke Memory", exact=True)
    expect(detail.locator("pre")).to_have_text(malicious_body)
    check(page.evaluate("window.smokeInjected === undefined"), "Note body executed HTML")
    check(detail.locator("img").count() == 0, "Note body rendered as HTML")
    page.screenshot(path=str(artifacts / "note-detail.png"), full_page=True, animations="disabled")
    detail.get_by_role("button", name="Delete…", exact=True).click()
    confirmation = page.get_by_role("dialog", name="Delete Smoke Memory?", exact=True)
    confirmation.get_by_role("button", name="Cancel", exact=True).click()
    check(len(api(back, "/api/notes")) == 1, "Cancel deleted a note")
    page.get_by_role("button", name=re.compile(r"Smoke Memory")).click()
    page.get_by_role("dialog", name="Smoke Memory", exact=True).get_by_role("button", name="Delete…", exact=True).click()
    note = api(back, "/api/notes")[0]

    def fail_delete(route):
        route.fulfill(status=500, content_type="application/json", body=json.dumps({"message": "Simulated delete failure"}))

    page.route(f"**/api/notes/{note['id']}", fail_delete)
    confirmation.get_by_role("button", name="Delete note", exact=True).click()
    expect(confirmation.get_by_role("alert")).to_have_text("Simulated delete failure")
    check(len(api(back, "/api/notes")) == 1, "Failed delete lost the note")
    page.unroute(f"**/api/notes/{note['id']}", fail_delete)
    confirmation.get_by_role("button", name="Delete note", exact=True).click()
    expect(confirmation).not_to_be_visible()
    expect(page.get_by_text("No notes yet", exact=True)).to_be_visible()
    check(api(back, "/api/notes") == [], "Confirmed delete did not persist")
    print("PASS Notes search, safe detail, cancel, delete failure/retry and confirmation", flush=True)

    page.get_by_role("link", name="Settings", exact=True).click()
    row = page.locator(".row").filter(has=page.get_by_text("Disposable Smoke", exact=True))
    row.get_by_role("button", name="Delete", exact=True).click()
    deletion = page.get_by_role("dialog", name="Delete Disposable Smoke?", exact=True)
    expect(deletion).to_be_visible()
    check(any(item["id"] == disposable["id"] for item in api(back, "/api/endpoints")), "Endpoint deleted before confirmation")
    deletion.get_by_role("button", name="Cancel", exact=True).click()
    row.get_by_role("button", name="Delete", exact=True).click()
    deletion.get_by_role("button", name="Delete endpoint", exact=True).click()
    expect(deletion).not_to_be_visible()
    check(not any(item["id"] == disposable["id"] for item in api(back, "/api/endpoints")), "Confirmed endpoint delete failed")
    check(not errors, "Browser runtime errors: " + repr(errors))
    check(len(Model.requests) == 4, f"Expected two tool exchanges; got {len(Model.requests)} model requests")
    print("PASS endpoint delete confirmation and zero browser runtime errors", flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--artifacts", type=Path, default=Path(tempfile.gettempdir()) / "agentcontrol-smoke")
    parser.add_argument("--chromium", default=shutil.which("chromium") or shutil.which("chromium-browser"))
    args = parser.parse_args()
    if not args.chromium:
        parser.error("Chromium not found; specify --chromium /path/to/chromium")
    if not (ROOT / "AgentControlBE/dist/index.js").exists():
        parser.error("Build the backend first: cd AgentControlBE && npm run build")
    artifacts = args.artifacts.resolve()
    artifacts.mkdir(parents=True, exist_ok=True)
    for stale in ["failure.png", "failure.html"]:
        (artifacts / stale).unlink(missing_ok=True)
    processes = []
    logs = []
    model = ThreadingHTTPServer(("127.0.0.1", 0), Model)
    threading.Thread(target=model.serve_forever, daemon=True).start()
    back_port, front_port = free_port(), free_port()
    while front_port == back_port:
        front_port = free_port()
    back, front = f"http://127.0.0.1:{back_port}", f"http://127.0.0.1:{front_port}"
    try:
        with tempfile.TemporaryDirectory(prefix="agentcontrol-smoke-data-") as data:
            env = {**os.environ, "PORT": str(back_port), "HOST": "127.0.0.1", "AGENTCONTROL_DATA_DIR": data,
                   "AGENTCONTROL_SECRET": "smoke-only-ephemeral-secret", "AGENTCONTROL_AUTH_TOKEN": "",
                   "AGENTCONTROL_API_TARGET": back, "VITE_API_BASE": "", "VITE_AUTH_TOKEN": ""}
            for name, command, directory in [
                ("backend", ["node", "dist/index.js"], "AgentControlBE"),
                ("frontend", ["npm", "run", "dev", "--", "--host", "127.0.0.1", "--port", str(front_port), "--strictPort"], "AgentControlFE"),
            ]:
                log = (artifacts / f"{name}.log").open("w")
                logs.append(log)
                processes.append(subprocess.Popen(command, cwd=ROOT / directory, env=env, stdout=log, stderr=subprocess.STDOUT, start_new_session=True))
            wait_ready(back + "/health", processes)
            wait_ready(front, processes)
            with sync_playwright() as playwright:
                browser = playwright.chromium.launch(executable_path=args.chromium, headless=True, args=["--no-sandbox"])
                page = browser.new_page(viewport={"width": 1440, "height": 1000})
                try:
                    exercise(page, front, back, f"http://127.0.0.1:{model.server_port}", artifacts)
                except Exception:
                    page.screenshot(path=str(artifacts / "failure.png"), full_page=True, animations="disabled")
                    (artifacts / "failure.html").write_text(page.content())
                    raise
                finally:
                    browser.close()
            print(f"All browser smoke checks passed. Artifacts: {artifacts}", flush=True)
    except Exception:
        for name in ["backend", "frontend"]:
            path = artifacts / f"{name}.log"
            if path.exists():
                print(f"\n{name} log tail:\n{path.read_text()[-6000:]}", flush=True)
        raise
    finally:
        for process in processes:
            if process.poll() is None:
                os.killpg(process.pid, signal.SIGTERM)
        for process in processes:
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                os.killpg(process.pid, signal.SIGKILL)
                process.wait()
        for log in logs:
            log.close()
        model.shutdown()
        model.server_close()


if __name__ == "__main__":
    main()
