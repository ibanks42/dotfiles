import json
import tempfile
import unittest
from pathlib import Path
from analyze import block_delta, breakpoint_indices, classify, difference, lines, report, section, tools_delta, unpack, wire_delta


class AnalyzeTests(unittest.TestCase):
    def test_append_moving_breakpoint_no_break(self):
        old = [{"text": "header"}, {"text": "history", "cache_control": {"ttl": "1h"}}]
        new = [{"text": "header"}, {"text": "history"}, {"text": "appended", "cache_control": {"ttl": "1h"}}]
        self.assertIsNone(block_delta(old, new))
        self.assertIsNone(wire_delta({"system": old, "tools": old, "messages": old},
                                      {"system": new, "tools": new, "messages": new}))
        self.assertEqual(breakpoint_indices(new)[-1] - breakpoint_indices(old)[-1], 1)

    def test_system_change_section(self):
        prompt = "## Memory\nold\n<codex_tools>\nold"
        current = prompt.replace("old\n<codex", "new\n<codex")
        self.assertEqual(section(current, difference(prompt, current, "system")["offset"]), "## Memory")
        self.assertEqual(section("# Project Context\nfoo\n<codex_skills>\nbar", 40), "<codex_skills>")

    def test_header_tool_map(self):
        def block(mapping):
            return [{"text": json.dumps({"protocol": "pi-claude-code-provider-context-v4", "toolNameMap": mapping})}]
        result = block_delta(block({"a": "A"}), block({"b": "B"}))
        self.assertEqual(result["toolNameMap"], {"added": ["b"], "removed": ["a"], "changed": []})

    def test_hit_partial_cold(self):
        previous = {"input": 20, "cacheRead": 70, "cacheWrite": 10}
        self.assertIn("full hit", classify(previous, {"cacheRead": 98}))
        self.assertIn("partial", classify(previous, {"cacheRead": 32}))
        self.assertIn("cold", classify(previous, {"cacheRead": 0}))

    def test_lookback_and_legacy(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            records = []
            for n in range(2):
                prompt = [{"text": "stable"}] + [{"text": str(i)} for i in range(22 * n + 1)]
                prompt[-1]["cache_control"] = {"ttl": "1h"}
                records += [{"kind": "request", "requestId": str(n), "sessionId": "s",
                             "at": f"2026-01-01T00:00:0{n}+00:00", "systemPrompt": "same", "prompt": prompt},
                            {"kind": "result", "requestId": str(n), "usage": {"input": 0, "cacheRead": 0, "cacheWrite": 32}}]
            (root / "provider.jsonl").write_text("\n".join(json.dumps(record) for record in records))
            text = report(root)
            self.assertIn('"lookbackCouldApply": true', text)
            self.assertIn("no break (append/unchanged", text)
            self.assertEqual(len(lines(root, "provider.jsonl")), 4)

    def test_binary_image_blob(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            import hashlib
            raw = b"\xff\x89PNG\x00"
            sha = hashlib.sha256(raw).hexdigest()
            (root / "blobs").mkdir()
            (root / "blobs" / sha).write_bytes(raw)
            self.assertEqual(unpack({"imageBlobs": [{"blob": {"sha256": sha}}]}, root),
                             {"imageBlobs": [{"sha256": sha}]})

    def test_tool_delta(self):
        self.assertEqual(tools_delta([{"name": "x"}], [{"name": "y"}])["added"], ["y"])


class RealMissPatternTests(unittest.TestCase):
    def test_fallback_to_older_entry_is_partial(self):
        import analyze
        verdict = analyze.classify({"input": 2, "cacheRead": 227111, "cacheWrite": 3633}, {"cacheRead": 227111})
        self.assertIn("fell back to older entry", verdict)
        normal = analyze.classify({"input": 2, "cacheRead": 226012, "cacheWrite": 1715}, {"cacheRead": 227111})
        self.assertTrue(normal.startswith("full hit"))

    def test_pi_tasks_reminder_attributed(self):
        import analyze
        reminder = {"role": "user", "content": [{"type": "text", "text": "<system-reminder>\nThe task tools haven't been used recently. x</system-reminder>"}]}
        reply = {"role": "assistant", "content": [{"type": "text", "text": "ok"}]}
        info = analyze.block_delta([{"t": 1}, reminder], [{"t": 1}, reply, {"t": 2}])
        self.assertEqual(info["index"], 1)
        self.assertIn("pi-tasks", info["source"])
        self.assertTrue(info["previousLastBlockReplaced"])


if __name__ == "__main__":
    unittest.main()
