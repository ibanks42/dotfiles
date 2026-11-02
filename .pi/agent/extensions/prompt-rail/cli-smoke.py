"""Exercise the bundled Pi CLI in a PTY, with synthetic history and no model calls."""
import argparse
import fcntl
import json
import os
from pathlib import Path
import pty
import select
import shutil
import struct
import subprocess
import sys
import tempfile
import termios
import time
import uuid

parser = argparse.ArgumentParser()
parser.add_argument("cli")
parser.add_argument("extension")
parser.add_argument("--session", help="Use a temporary copy of an existing session (never modify it)")
parser.add_argument("--compacted", action="store_true")
parser.add_argument("--history", action="store_true")
parser.add_argument("--latest", action="store_true")
args = parser.parse_args()
cli, extension = (str(Path(p).resolve()) for p in [args.cli, args.extension])
with tempfile.TemporaryDirectory() as directory:
    root = Path(directory)
    agent = root / "agent"
    agent.mkdir()
    (agent / "settings.json").write_text(json.dumps({"tuiMode": "fullscreen"}))
    entries = [{"type": "session", "version": 3, "id": str(uuid.uuid4()),
                "timestamp": "2026-01-01T00:00:00.000Z", "cwd": directory}]
    parent = None
    for index, (role, text) in enumerate([
        ("user", "fixture first prompt"),
        ("assistant", "\n\n".join(["fixture reply"] * 60)),
        ("user", "fixture second prompt"),
        ("assistant", "\n\n".join(["fixture tail"] * 60)),
    ]):
        message = {"role": role, "content": [{"type": "text", "text": text}], "timestamp": 1}
        if role == "assistant":
            message.update(api="openai-responses", provider="openai", model="gpt-5",
                           usage={"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0,
                                  "totalTokens": 0, "cost": {"input": 0, "output": 0,
                                  "cacheRead": 0, "cacheWrite": 0, "total": 0}}, stopReason="stop")
        entry_id = f"entry-{index}"
        entries.append({"type": "message", "id": entry_id, "parentId": parent,
                        "timestamp": "2026-01-01T00:00:00.000Z", "message": message})
        parent = entry_id
    session = root / "session.jsonl"
    if args.compacted:
        entries.append({"type": "compaction", "id": "compact", "parentId": parent,
                        "timestamp": "2026-01-01T00:00:00.000Z", "summary": "fixture compaction summary",
                        "firstKeptEntryId": "entry-2", "tokensBefore": 1000})
    if args.session:
        shutil.copyfile(args.session, session)
        entries = [json.loads(line) for line in session.read_text().splitlines() if line.strip()]
    else:
        session.write_text("".join(json.dumps(entry) + "\n" for entry in entries))
    by_id = {entry["id"]: entry for entry in entries if entry.get("id") and entry.get("type") != "session"}
    leaf = next(entry["id"] for entry in reversed(entries) if entry.get("id") and entry.get("type") != "session")
    branch = []
    while leaf in by_id:
        entry = by_id[leaf]
        branch.append(entry)
        leaf = entry.get("parentId")
    user_count = sum(entry.get("type") == "message" and entry["message"].get("role") == "user" for entry in branch)
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 35, 110, 0, 0))
    process = subprocess.Popen([
        cli, "--session", str(session), "--no-extensions", "--no-skills",
        "--no-prompt-templates", "-e", extension, "--tui-mode", "fullscreen",
    ], cwd=directory, env={**os.environ, "PI_CODING_AGENT_DIR": str(agent),
                          "TERM": "xterm-256color"}, stdin=slave, stdout=slave,
        stderr=slave, start_new_session=True)
    os.close(slave)
    data = bytearray()

    def wait_for(needle, seconds=10):
        deadline = time.monotonic() + seconds
        while needle not in data and time.monotonic() < deadline:
            ready, _, _ = select.select([master], [], [], max(0, deadline - time.monotonic()))
            if ready:
                try:
                    data.extend(os.read(master, 65536))
                except OSError:
                    break
        assert needle in data, f"Bundled CLI did not reach {needle!r} (exit={process.poll()})"

    try:
        wait_for(b"Prompts")
        data.clear()
        os.write(master, b"/prompt-jump\r")
        wait_for(b"Jump to prompt")
        data.clear()
        query = f"{user_count if args.latest else 1}.".encode()
        os.write(master, query + b"\r")
        if args.history:
            wait_for(b"read-only")
            if not args.session:
                wait_for(b"ASSISTANT TEXT")
            os.write(master, b"\x1b")
        else:
            wait_for(b"Jump to latest message")
        if not args.session:
            assert b"transcript position unavailable" not in data, "Prompt jump was rejected"
        print(f"PASS bundled CLI: {'saved history reader' if args.history else 'live transcript jump'} ({'copied session' if args.session else 'synthetic history'})")
    finally:
        process.terminate()
        try:
            process.wait(timeout=3)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait()
        os.close(master)
