#!/usr/bin/env python3
"""Offline prefix comparison. All byte/token boundaries and Pi/provider joins are estimates."""
import argparse
import difflib
import json
import re
from collections import defaultdict
from datetime import datetime
from pathlib import Path
from typing import Any


def unpack(value: Any, root: Path, key: str = "") -> Any:
    if isinstance(value, dict):
        if set(value) == {"__items"}:
            return [unpack(v, root, "__item") for v in value["__items"]]
        if set(value) == {"__fields"}:
            return {k: unpack(v, root, k) for k, v in value["__fields"].items()}
        if set(value) == {"blob"}:
            sha = value["blob"]["sha256"]
            if not re.fullmatch(r"[a-f0-9]{64}", sha):
                raise ValueError("Invalid blob hash")
            for base in (root / "data", root):
                path = base / "blobs" / sha
                if path.exists():
                    if key == "imageBlobs":
                        return {"sha256": sha}
                    content = path.read_text()
                    if value["blob"].get("json"):
                        return json.loads(content)
                    if key in ("messages", "tools", "prompt", "payload", "systemPromptOptions"):
                        try:
                            return json.loads(content)
                        except ValueError:  # legacy draft packed individual strings recursively
                            pass
                    return content
            raise FileNotFoundError(sha)
        return {k: unpack(v, root, k) for k, v in value.items()}
    if isinstance(value, list):
        return [unpack(v, root, key) for v in value]
    return value


def lines(root: Path, name: str) -> list[dict[str, Any]]:
    records = []
    for base in (root / "data", root):
        path = base / name
        if path.exists():
            for line in path.read_text().splitlines():
                if line:
                    records.append(unpack(json.loads(line), root))
    return records


def strip(value):
    if isinstance(value, dict):
        return {k: strip(v) for k, v in value.items() if k != "cache_control"}
    if isinstance(value, list):
        return [strip(v) for v in value]
    return value


def offset(a, b):
    for i, (left, right) in enumerate(zip(a, b)):
        if left != right:
            return i
    return min(len(a), len(b)) if a != b else None


def section(text, pos):
    headings = [(m.start(), m.group()) for m in re.finditer(
        r"(?m)^(?:#{1,4} [^\n]+|Current date[^\n]*|<(?:codex_[^>]+|cwd|skills)>|# Project Context[^\n]*)", text)]
    found = [heading for start, heading in headings if start <= pos]
    return found[-1] if found else "unknown source"


def difference(a, b, label):
    a = a if isinstance(a, str) else json.dumps(a, sort_keys=True, ensure_ascii=False)
    b = b if isinstance(b, str) else json.dumps(b, sort_keys=True, ensure_ascii=False)
    pos = offset(a, b)
    if pos is None:
        return None
    lo = max(0, pos - 120)
    return {"layer": label, "offset": pos, "old": a[lo:pos + 120], "new": b[lo:pos + 120],
            "diff": "\n".join(difflib.unified_diff(a[lo:pos + 120].splitlines(), b[lo:pos + 120].splitlines(), lineterm=""))}


def tools_delta(a, b):
    old = {x.get("name", "?"): strip(x) for x in (a or []) if isinstance(x, dict)}
    new = {x.get("name", "?"): strip(x) for x in (b or []) if isinstance(x, dict)}
    return {"added": sorted(new.keys() - old.keys()), "removed": sorted(old.keys() - new.keys()),
            "changed": sorted(key for key in new.keys() & old.keys() if new[key] != old[key])}


KNOWN_INJECTORS = (
    ("The task tools haven't been used recently", "pi-tasks context hook (transient reminder, not persisted)"),
    ("your task list is currently empty", "pi-tasks context hook (transient reminder, not persisted)"),
)


def injector(text):
    for marker, label in KNOWN_INJECTORS:
        if marker in text:
            return label
    return None


def header(block):
    text = block.get("text", "") if isinstance(block, dict) else str(block)
    if "pi-claude-code-provider-context-v4" not in text:
        return None
    try:
        return json.loads(text)
    except ValueError:
        match = re.search(r"\{[^\n]*\"toolNameMap\"[^\n]*\}", text)
        try:
            return json.loads(match.group()) if match else None
        except ValueError:
            return None


def block_delta(a, b):
    # The generated attachment narration is a suffix outside the replayed history.
    # It moves when a new history block is appended; it is not a changed prefix.
    def history(items):
        items = strip(items or [])
        return [v for v in items if not (isinstance(v, dict) and str(v.get("text", "")).startswith("Generated image attachments"))]
    a, b = history(a), history(b)
    for i, (left, right) in enumerate(zip(a, b)):
        if left != right:
            info = {"index": i, **(difference(left, right, f"messages[{i}]") or {})}
            source = injector(json.dumps(left, ensure_ascii=False))
            if source:
                info["source"] = source
            info["previousLastBlockReplaced"] = i == len(a) - 1
            if i == 0:
                before, after = header(left), header(right)
                if before is not None and after is not None:
                    old = before.get("toolNameMap", {})
                    new = after.get("toolNameMap", {})
                    if old != new:
                        info["toolNameMap"] = {"added": sorted(new.keys() - old.keys()),
                                               "removed": sorted(old.keys() - new.keys()),
                                               "changed": sorted(k for k in old.keys() & new.keys() if old[k] != new[k])}
            return info
    if len(a) > len(b):
        return {"index": len(b), "layer": "messages", "offset": 0, "reason": "truncated"}
    return None  # exact prefix: append is not a cache break


def wire_delta(a, b):
    for key in ("system", "tools", "messages"):
        old, new = strip(a.get(key, [])), strip(b.get(key, []))
        if isinstance(old, list) and isinstance(new, list):
            change = block_delta(old, new)
            if change:
                return key, change
        elif old != new:
            return key, difference(old, new, "wire " + key)
    return None


def breakpoint_indices(prompt):
    return [i for i, block in enumerate(prompt or []) if isinstance(block, dict) and block.get("cache_control")]


def classify(prev_usage, usage):
    previous = sum(int(prev_usage.get(k) or 0) for k in ("input", "cacheRead", "cacheWrite"))
    read = int(usage.get("cacheRead") or 0)
    if not previous:
        return "unknown (no previous usage)"
    fraction = read / previous
    kind = 'full hit' if fraction >= .95 else 'partial' if read else 'cold'
    prev_read, prev_write = int(prev_usage.get("cacheRead") or 0), int(prev_usage.get("cacheWrite") or 0)
    # A read that stops at the previous request's read means the previous write was not
    # reusable (e.g. its last block vanished) and the lookup fell back to an older entry.
    if read and prev_write >= 1024 and read <= prev_read + 64:
        kind = f"partial: fell back to older entry, previous write of {prev_write} not reused"
    return f"{kind} ({read}/{previous} = {fraction:.1%} estimated)"


def boundary(req, read, ratio):
    if not read or not ratio:
        return "none (estimate)"
    running = 0
    candidates = []
    for label, value in (("end of system", req.get("systemPromptFile", req.get("systemPrompt", ""))),
                         ("end of tools", req.get("catalogFile", req.get("tools", [])))):
        running += len(value if isinstance(value, str) else json.dumps(value))
        candidates.append((abs(running / ratio - read), label))
    for i, block in enumerate(req.get("prompt", [])):
        running += len(json.dumps(strip(block)))
        if i in breakpoint_indices(req.get("prompt", [])) or i == len(req.get("prompt", [])) - 1:
            candidates.append((abs(running / ratio - read), f"block {i}"))
    return min(candidates)[1] + " (byte/token estimate)" if candidates else "unknown (estimate)"


def report(root: Path) -> str:
    provider, pi = lines(root, "provider.jsonl"), lines(root, "pi.jsonl")
    wire = defaultdict(list)
    for base in (root / "data", root):
        for file in base.glob("wire-*.json"):
            value = json.loads(file.read_text())
            wire[str(value.get("requestId"))].append(value)
    results = {r["requestId"]: r for r in provider if r.get("kind") == "result" and r.get("requestId")}
    pi_usage = defaultdict(list)
    pi_requests = defaultdict(list)
    requests = defaultdict(list)
    for record in pi:
        if record.get("kind") == "usage":
            pi_usage[str(record.get("sessionId"))].append(record)
        if record.get("kind") == "request":
            pi_requests[str(record.get("sessionId"))].append(record)
    for record in provider:
        if record.get("kind") == "request":
            requests[str(record.get("sessionId"))].append(record)
    for session, records in pi_requests.items():
        if session not in requests:
            requests[session] = records
    output = []
    for session, group in sorted(requests.items()):
        group.sort(key=lambda r: r.get("at", ""))
        pi_requests[session].sort(key=lambda r: r.get("at", ""))
        pi_usage[session].sort(key=lambda r: r.get("at", ""))
        usage_list = []
        for index, req in enumerate(group):
            result = results.get(req.get("requestId"), {})
            match = min(pi_usage[session], key=lambda r: abs((datetime.fromisoformat(r["at"].replace("Z", "+00:00")) -
                datetime.fromisoformat(req["at"].replace("Z", "+00:00"))).total_seconds()), default={})
            usage_list.append(result.get("usage") or match.get("usage") or {})
        ratios = []
        for index in range(1, len(group)):
            previous = sum(int(usage_list[index - 1].get(k) or 0) for k in ("input", "cacheRead", "cacheWrite"))
            if previous and int(usage_list[index].get("cacheRead") or 0) >= .95 * previous:
                byte_count = len(json.dumps(strip(group[index - 1].get("prompt", [])))) + len(str(group[index - 1].get("systemPromptFile", "")))
                ratios.append(byte_count / previous)
        ratio = sum(ratios) / len(ratios) if ratios else 4.0
        output.append(f"## Session {session}\n\n| Seq | Gap | Cache read | Classification | First non-append difference |\n|---:|---:|---:|---|---|")
        for index, req in enumerate(group):
            prev = group[index - 1] if index else None
            usage = usage_list[index]
            gap = round((datetime.fromisoformat(req["at"].replace("Z", "+00:00")) - datetime.fromisoformat(prev["at"].replace("Z", "+00:00"))).total_seconds(), 1) if prev else 0
            old = prev.get("payload", prev) if prev else {}
            current = req.get("payload", req)
            system = difference(old.get("systemPrompt", ""), current.get("systemPrompt", ""), "system prompt") if prev else None
            if system:
                system["attribution"] = section(str(current.get("systemPrompt", "")), system["offset"])
            tools = tools_delta(old.get("tools"), current.get("tools")) if prev else {}
            messages = block_delta(old.get("prompt", old.get("messages", [])), current.get("prompt", current.get("messages", []))) if prev else None
            a, b = wire.get(str(prev.get("requestId")), []) if prev else [], wire.get(str(req.get("requestId")), [])
            wire_diff = wire_delta(a[-1]["body"], b[-1]["body"]) if a and b else None
            previous_bp = breakpoint_indices(old.get("prompt", [])) if prev else []
            current_bp = breakpoint_indices(current.get("prompt", []))
            lookback = bool(previous_bp and current_bp and current_bp[-1] - previous_bp[-1] > 20)
            first = (f"system char {system['offset']} ({system['attribution']})" if system else
                     f"tools {tools}" if any(tools.values()) else
                     f"messages[{messages['index']}] toolNameMap {messages['toolNameMap']}" if messages and messages.get("toolNameMap") else
                     (f"messages[{messages['index']}] changed" + (f" (source: {messages['source']})" if messages.get("source") else "")) if messages else
                     f"wire {wire_diff[0]}" if wire_diff else "no break (append/unchanged at observed layers)")
            classification = classify(usage_list[index - 1], usage) if prev else "initial"
            note = {"session": session, "requestId": req.get("requestId"), "gapSeconds": gap, "usage": usage,
                    "classification": classification, "estimatedBoundary": boundary(prev or req, usage.get("cacheRead", 0), ratio),
                    "system": system, "tools": tools, "messages": messages, "wire": wire_diff,
                    "breakpoints": current_bp, "lookbackCouldApply": lookback,
                    "piRequestSequence": min(pi_requests[session], key=lambda r: abs((datetime.fromisoformat(r["at"].replace("Z", "+00:00")) - datetime.fromisoformat(req["at"].replace("Z", "+00:00"))).total_seconds()), default={}).get("sequence"),
                    "joinCaveat": "Pi/provider correlation is best effort by session, order and timestamp; concurrent requests may cross.", "verdict": first}
            output.append(f"| {index + 1} | {gap}s | {usage.get('cacheRead', '?')} | {classification} | {first} |")
            output.append(f"\n<details><summary>{first}</summary>\n\n```json\n{json.dumps(note, indent=2, ensure_ascii=False)}\n```\n</details>\n")
    return "\n".join(output)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("root", nargs="?", type=Path, default=Path.home() / ".pi/agent/cache-forensics")
    parser.add_argument("--markdown", type=Path)
    args = parser.parse_args()
    text = report(args.root)
    print(text)
    if args.markdown:
        args.markdown.write_text(text)
