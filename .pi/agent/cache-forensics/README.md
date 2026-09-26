# Cache forensics (local diagnostic)

This is a private, offline diagnostic for Pi 0.87.1. **Captured Pi content is full raw text and images. It can contain credentials or secrets.** The root and `data/` directories have mode 0700. Capture files and blobs have mode 0600. Do not commit or share captures before you review them.

## What the current install records

- **Pi hook capture.** `~/.pi/agent/extensions/cache-forensics.ts` records the Pi prompt, the context, and the logical provider request at its hook position. It also records the final assistant usage. It does this for all providers. It writes `data/pi.jsonl` and content-addressed `data/blobs/`.
- **Provider metrics.** The installed npm `pi-claude-code-provider` 0.4.0 reads `PI_CLAUDE_CODE_PROVIDER_METRICS_LOG`. When capture is on, the extension sets this variable to `data/metrics.jsonl`. Each metrics record contains counts, sizes, token estimates, cache usage, and version data. It does not contain prompt or message text.
- **Analyzer.** `analyze.py` compares observed prefix shapes. Tokens and breakpoint matches are estimates. They do not prove how the server cache behaves.

The extension also sets `PI_CLAUDE_CODE_PROVIDER_CAPTURE_DIR`. Provider 0.4.0 does not read this variable. Thus the current provider does not write raw provider captures. The replay script `scripts/replay-capture.js` is not in this install, so offline wire replay is not available.

## Turn capture on and off

Capture is off by default. The extension captures only when `state.json` contains the object `{"enabled": true}`. A missing, corrupt, or different `state.json` keeps capture off. For example, `{"enabled": "true"}`, `{"enabled": 1}`, `{}`, `null`, and `[true]` keep capture off. `state.json` is private and is not in git. Thus a fresh install does not capture prompts.

Use these commands inside Pi after the extension loads:

- `/forensics on` starts capture. It writes `{"enabled": true}` and removes `STOP` from the root and from `data/`.
- `/forensics off` stops capture. It writes `{"enabled": false}`.
- `/forensics status` shows ON or OFF and the size of the captured data.
- `/forensics purge` permanently removes **only captured data**. It keeps `state.json`, the analyzer, the tests, and this README.

To stop capture without Pi, create a `STOP` file in the cache-forensics root. A `STOP` file in `data/` also stops capture. To resume, use `/forensics on`. The extension reads `state.json` and `STOP` again before each provider request. If capture is off, it removes the provider variables at that request. It does not wait for a new user turn.

Capture stops near 200 MiB. At the limit, the extension removes the provider variables immediately. `/forensics on` retries capture, but the capacity limit still applies. `/forensics purge` removes the captured data. The extension counts the bytes in `data/` again after 50 records or 60 seconds.

## Request and usage pairing

The extension keeps a small request counter for each session in memory. It uses the counter to pair each request with its usage record. The extension does not count requests while capture is off. At `session_start` and `session_shutdown`, it clears the counter of that session only. Other sessions in the same process keep their counters. When capture changes between on and off, it clears the counters of all sessions.

The extension keeps a maximum of 64 unpaired requests for each session and a maximum of 32 sessions. When the extension reaches a limit, it removes the oldest entry. Thus pairing is best effort. A usage record can have no `requestSequence`, or it can have the wrong one, after a limit or reset.

## Run the tests and the analyzer

From the cache-forensics directory:

```sh
python3 -m unittest
(cd ../extensions && bun test cache-forensics-tests/)
python3 analyze.py
python3 analyze.py --markdown report.md
```

The extension tests use a fake Pi API and temporary directories. They do not use credentials, live captures, the network, or a model.

## Legacy captures

An earlier local provider draft wrote raw provider captures and offline wire replays. The current install does not write these files. The analyzer can still read them:

- `provider.jsonl`, `pi.jsonl`, `metrics.jsonl`, and `blobs/` in `data/` or in the root.
- `wire-*.json` in `data/` or in the root.

The analyzer reads both locations. You do not have to move or merge legacy files. Legacy raw captures can contain secrets, the same as current Pi captures. `/forensics purge` deletes legacy root-level capture files and `data/`. If you want to keep legacy captures, copy them to a private location before you purge.

## Limits of the data

Pi 0.87.1 resolves package extensions first, then explicit project and user entries, then auto-discovered extensions. This extension is auto-discovered. Thus it observes **after configured package extensions**, for example pi-codex-conversion. Later explicit or auto-discovered handlers can still change the request after this snapshot.

- `context` omits system messages. `context_with_system` includes them.
- `before_provider_request` is the logical payload, not the Claude wire bytes.
- Joins between Pi and provider records by session, sequence, and time are best effort. Concurrent subagents can finish out of order.
- Legacy offline replays used a dummy account. They can differ from authenticated requests, and they do not show a real cache hit or miss.
- The analyzer prints image hashes, not image bytes.
- The 20-block lookback estimate uses visible transcript breakpoints. Claude Code can add hidden markers.
