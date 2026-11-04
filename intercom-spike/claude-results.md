# Claude native receive experiment

2026-11-03 America/New_York, Claude Code 2.1.318, subscription authentication, model alias `haiku` (resolved Haiku 5.5). Reproducible source: `/home/ibanks/dotfiles/intercom-spike/claude_probe.py`.

**Result: native hook delivery to an ordinary interactive TUI works while idle, repeatedly after rearming, and during active generation.** No message delivery used terminal paste. The PTY was used to launch the disposable TUI and submit initial test prompts; mailbox deliveries came solely from hook stderr + exit 2.

Isolation: new generated `/tmp/hc-claude-probe-*` cwd, temporary explicit settings, empty `--setting-sources`, strict empty MCP configuration, model tools disabled via `--tools ''`, normal default permission mode. Trusted only the generated scratch directory through its normal startup prompt. No user hook settings or live sessions were edited. Claude itself records ordinary per-session transcript/trust metadata as part of normal CLI startup.

## Mechanism

SessionStart and Stop run the same `asyncRewake:true` command. A nonblocking flock allows one receiver at a time. The receiver polls only its scratch mailbox, atomically renames one file to `.delivered`, writes an exact nonce request on stderr, and exits 2. After Claude responds, its Stop event starts a fresh receiver. Normal Stop watchers that encounter an already running SessionStart receiver exit 0.

Official docs establish that asyncRewake wakes idle Claude on exit 2 and still enforces hook timeout. Ordinary async output does not wake idle Claude. [Claude hooks reference](https://code.claude.com/docs/en/hooks)

## Verified evidence

Successful run: `/tmp/hc-claude-probe-luyf2fwz/`.

Authoritative assistant transcript: `/home/ibanks/.claude/projects/-tmp-hc-claude-probe-luyf2fwz/735f6dbe-02e6-4c0b-a0d9-354a2a5aad33.jsonl`.

Actual assistant text messages, read directly from JSONL `type:assistant` records:

1. `READY_PROBE` at `2026-11-04T04:35:16.599Z`.
2. `ACK_idle1_yf2fwz` at `04:35:28.353Z`.
3. `ACK_idle2_yf2fwz` at `04:35:43.380Z`.
4. Complete integers 1 through 200, each on its own line, at `04:36:00.854Z`.
5. `ACK_busy3_yf2fwz` at `04:36:01.893Z`.

First idle delivery: mailbox enqueued epoch `1793766927.443`, receiver delivered `6927.452`, assistant completed `6928.353` (~0.91 seconds after enqueue). Stop rearmed at `6928.389`.

Second idle delivery: enqueue `6942.444`, receiver delivery `6942.508`, assistant completed `6943.380` (~0.94 seconds). Stop rearmed at `6943.411`.

Busy delivery: original number-output prompt submitted (UserPromptSubmit event) `6957.768`; mailbox enqueued `6958.044`, delivered `6958.132`; original generation completed `6960.854`; automatic continuation UserPromptSubmit event `6960.902`; exact ACK completed `6961.893`. Delivery waited for the active generation to finish; it did not interrupt or truncate it.

An earlier trial `/tmp/hc-claude-probe-n5ysacde/` independently passed repeated idle delivery, but its busy trial was invalid because a typing+Enter burst remained in the composer instead of submitting. The probe now separates text entry from Enter. Do not count that earlier trial as busy evidence.

## Limits and next implementation work

- **Idle receiver expiry is unresolved.** Probe receivers stop after 180 seconds (hook timeout 190 seconds). If the session stays idle beyond expiry, no lifecycle event automatically rearms a receiver. Stop-based rearm solves delivery-followed-by-response, not indefinite idle liveness. Production needs a deliberately managed long-lived timeout and restart strategy, another supported wake mechanism, or explicit hc fallback. Larger timeouts alone merely defer the gap. No maximum timeout or unlimited mode was established by this experiment.
- Hook-triggered continuations appear as Stop feedback, not ordinary peer chat messages. `stop_hook_active:true` was present after wakes; repeated idle wakes succeeded twice but long sequences/continuation caps were not tested.
- This is a local filesystem mailbox spike, not a durable broker: renaming a file before model acknowledgement can lose delivery on crashes; no retry/deduplication protocol exists here.
- Busy evidence covers a text-only model generation. Permissions dialogs, active tool batches, compaction, session restart, human draft preservation, hook timeout behavior, and model/provider failures remain untested.
- Each run creates a new scratch session and makes five short model requests including a 200-number output. CLI normal transcript/trust artifacts remain; probe terminates its own child process and tells watchers to shut down.
- Source was updated after the successful run to automatically extract assistant transcript and assert exact ACKs and the complete busy response. That assertion addition passed syntax parsing but was not re-run; successful-run transcript was independently inspected with Python.
