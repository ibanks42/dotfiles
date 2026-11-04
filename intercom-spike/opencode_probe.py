#!/usr/bin/env python3
"""Disposable OpenCode v2 native-input probe. Requires installed CLI + pexpect.

Uses a new session with all tools denied on the normal local service. Does not
write configuration, read credentials, or send terminal composer input.
"""
import json
import argparse
import os
from pathlib import Path
import subprocess
import tempfile
import threading
import time
import uuid

import pexpect


def api(method, path, body=None, timeout=100):
    argv = ["opencode", "api", method, path]
    if body is not None:
        argv += ["--data", json.dumps(body)]
    result = subprocess.run(argv, capture_output=True, text=True, timeout=timeout)
    if result.returncode:
        raise RuntimeError(result.stderr[-1500:])
    return json.loads(result.stdout) if result.stdout.strip() else None


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model", help="Optional existing provider/model ID, e.g. claude-agent/haiku")
    args = parser.parse_args()
    root = Path(tempfile.mkdtemp(prefix="intercom-opencode-"))
    report = {"scratch": str(root), "started": time.time(), "checks": []}
    create = {
        "location": {"directory": str(root)},
        "title": "intercom disposable probe",
        "permissions": [{"action": "*", "resource": "*", "effect": "deny"}],
    }
    if args.model:
        provider, model = args.model.split("/", 1)
        create["model"] = {"providerID": provider, "id": model}
    session = api("POST", "/api/session", create)["data"]
    sid = session["id"]
    report["sessionID"] = sid
    prefix = "/api/session/" + sid
    env = {k: v for k, v in os.environ.items() if not k.startswith(("HC_", "HERDR_"))}
    env["TERM"] = "xterm-256color"
    child = pexpect.spawn("opencode", ["--session", sid, str(root)],
                          env=env, cwd=str(root), dimensions=(40, 130),
                          encoding="utf-8", codec_errors="replace")
    terminal = (root / "terminal.log").open("w")
    child.logfile_read = terminal
    try:
        # Allow the full TUI to initialise without submitting composer text.
        try:
            child.expect("intercom disposable probe", timeout=20)
            report["tui_attached"] = True
        except pexpect.TIMEOUT:
            report["tui_attached"] = False
        pump_stop = threading.Event()

        def drain_terminal():
            while not pump_stop.is_set():
                try:
                    child.read_nonblocking(size=65536, timeout=0.5)
                except pexpect.TIMEOUT:
                    continue
                except (pexpect.EOF, OSError):
                    break

        pump = threading.Thread(target=drain_terminal, daemon=True)
        pump.start()
        for phase in ["idle", "busy"]:
            nonce = "INTERCOM_" + phase.upper() + "_" + uuid.uuid4().hex[:10]
            text = "Use no tools. Reply with exactly this text and nothing else: " + nonce
            if phase == "busy":
                api("POST", prefix + "/prompt", {
                    "text": "Use no tools. Write 400 words describing a fictional blue pebble. End with PEBBLE_DONE.",
                    "delivery": "queue",
                })
                active = api("GET", "/api/session/active")
                report["before_busy_send"] = active.get("data", {}).get(sid)
            receipt = api("POST", prefix + "/prompt", {"text": text, "delivery": "queue"})
            try:
                api("POST", "/api/experimental/session/" + sid + "/wait", {}, timeout=100)
            except Exception as exc:
                report["wait_error"] = str(exc)
            messages = api("GET", prefix + "/message")
            (root / (phase + "-messages.json")).write_text(json.dumps(messages, indent=2))
            replies = ["".join(p.get("text", "") for p in m.get("content", []) if p.get("type") == "text")
                       for m in messages.get("data", []) if m.get("type") == "assistant"]
            errors = [m.get("error", {}).get("type") for m in messages.get("data", []) if m.get("error")]
            check = {"phase": phase, "nonce": nonce, "receipt": receipt,
                     "exact_reply": nonce in replies, "errors": errors}
            report["checks"].append(check)
            print(json.dumps(check), flush=True)
    finally:
        # Kill only this test client, and interrupt only its own scratch session.
        if "pump_stop" in locals():
            pump_stop.set()
            pump.join(timeout=2)
        child.terminate(force=True)
        terminal.close()
        try:
            api("POST", prefix + "/interrupt", {})
            api("DELETE", prefix)
            report["session_removed"] = True
        except Exception as exc:
            report["cleanup_error"] = str(exc)
        (root / "report.json").write_text(json.dumps(report, indent=2))
        print("REPORT=" + str(root / "report.json"), flush=True)
    if (not report.get("tui_attached") or
            report.get("before_busy_send", {}).get("type") != "running" or
            not all(c["exact_reply"] for c in report["checks"])):
        raise SystemExit(1)


if __name__ == "__main__":
    main()
