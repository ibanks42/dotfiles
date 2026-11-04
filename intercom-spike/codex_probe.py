#!/usr/bin/env python3
"""Probe native queue delivery to a disposable private Codex TUI.

Requires installed codex, Python pexpect, and existing Codex login. Uses a
temporary CODEX_HOME with an auth symlink, never copies/prints credentials.
Read-only sandbox; no user config or live sessions are changed. Logs remain
under /tmp for investigation. This is a probe, not a supported adapter.
"""
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import tempfile
import time
import uuid

import pexpect


def main():
    root = Path(tempfile.mkdtemp(prefix="intercom-codex-"))
    home, work = root / "home", root / "work"
    home.mkdir()
    work.mkdir()
    auth = Path(os.environ.get("CODEX_HOME", str(Path.home() / ".codex"))) / "auth.json"
    if not auth.exists():
        raise SystemExit("Existing Codex auth.json required; no login changes made")
    (home / "auth.json").symlink_to(auth)
    env = {k: v for k, v in os.environ.items() if not k.startswith(("HC_", "HERDR_"))}
    env.update(CODEX_HOME=str(home), TERM="xterm-256color")
    nonce = uuid.uuid4().hex[:10]
    results = {"scratch": str(root), "version": subprocess.check_output(["codex", "-V"], text=True).strip()}
    child = pexpect.spawn("codex", ["--no-daemon", "--no-alt-screen", "-C", str(work),
        "-s", "read-only", "-c", 'model_reasoning_effort="low"',
        "-c", "check_for_update_on_startup=false",
        f"Reply exactly READY_{nonce}. Do not use tools."], env=env,
        encoding="utf-8", timeout=1, dimensions=(40, 160))
    log = (root / "terminal.log").open("w")
    child.logfile_read = log

    def pump():
        try:
            i = child.expect(["\x1b\\[6n", "Do you trust", pexpect.EOF, pexpect.TIMEOUT], timeout=.2)
            if i == 0:
                child.send("\x1b[1;1R")
            elif i == 1:
                child.send("\r")  # Only our generated scratch directory.
            elif i == 2:
                raise RuntimeError("Disposable Codex exited")
        except pexpect.TIMEOUT:
            pass

    def history():
        rows = []
        for path in (home / "sessions").rglob("*.jsonl"):
            for line in path.read_text().splitlines():
                try:
                    rows.append(json.loads(line))
                except json.JSONDecodeError:
                    pass  # A writer can be partway through its last record.
        return rows

    def assistant_texts():
        return ["".join(c.get("text", "") for c in row["payload"].get("content", []))
                for row in history() if row.get("type") == "response_item"
                and row.get("payload", {}).get("role") == "assistant"]

    def until(predicate, timeout=45):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if predicate():
                return True
            pump()
        return False

    def queue(text):
        r = subprocess.run(["codex", "queue", "--thread", thread, "--message", text],
                           env=env, capture_output=True, text=True, timeout=15)
        return {"exit": r.returncode, "stdout": r.stdout.strip(), "stderr": r.stderr.strip()}

    try:
        results["initial_reply"] = until(lambda: f"READY_{nonce}" in assistant_texts())
        if not results["initial_reply"]:
            raise RuntimeError("Initial inference did not complete; inspect scratch logs")
        # Read only the disposable database to discover the new native ID.
        with sqlite3.connect(home / "state_5.sqlite") as db:
            thread = db.execute("select id from threads").fetchone()[0]
        results["thread"] = thread
        token = f"IDLE_ACK_{nonce}"
        results["idle_submit"] = queue(f"Peer message: reply exactly {token}. Do not use tools.")
        results["idle_consumed"] = until(lambda: token in assistant_texts(), timeout=20)
        if not results["idle_consumed"]:
            # Test busy separately using human input solely to initiate a turn.
            results["private_queue_idle_limit"] = "Queue accepted but no idle wake within 20 seconds"
        before = len(assistant_texts())
        results["busy_work_submit"] = queue("Write the numbers 1 through 500, one per line. Do not use tools.")
        # Observe native admission before submitting the second peer message.
        working = until(lambda: any(row.get("type") == "event_msg" and
            row.get("payload", {}).get("type") == "item_completed" and
            row["payload"].get("item", {}).get("type") == "UserMessage" and
            "numbers 1 through 500" in json.dumps(row) for row in history()), timeout=15)
        results["busy_turn_admitted"] = working
        admitted = [row["payload"] for row in history() if row.get("type") == "event_msg"
                    and row.get("payload", {}).get("item", {}).get("type") == "UserMessage"
                    and "numbers 1 through 500" in json.dumps(row)]
        active_turn = admitted[-1]["turn_id"] if admitted else None
        results["busy_verified_before_submit"] = bool(active_turn) and not any(
            row.get("payload", {}).get("turn_id") == active_turn and
            row.get("payload", {}).get("item", {}).get("type") == "AgentMessage" and
            row["payload"]["item"].get("phase") == "final_answer" for row in history())
        token = f"BUSY_ACK_{nonce}"
        results["busy_submit"] = queue(f"Peer message: after current work, reply exactly {token}. Do not use tools.")
        results["busy_consumed"] = until(lambda: token in assistant_texts(), timeout=45)
        results["assistant_turns_after_busy"] = len(assistant_texts()) - before
    except Exception as exc:
        results["error"] = str(exc)
    finally:
        child.close(force=True)
        log.close()
        (root / "results.json").write_text(json.dumps(results, indent=2) + "\n")
        print(json.dumps(results, indent=2), flush=True)
    if not all(results.get(key) for key in
               ("initial_reply", "idle_consumed", "busy_verified_before_submit", "busy_consumed")):
        raise SystemExit(1)


if __name__ == "__main__":
    main()
