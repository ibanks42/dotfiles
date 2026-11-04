# Native CLI intercom experiments

Verified locally 2026-11-03 (timestamps below are UTC on November 4).

Superseded receive design: the subsequent [native intercom MVP](../intercom/README.md) found Claude's built-in session inbox socket. It eliminates the hook/watchdog requirement and has passed live Claude ↔ OpenCode message/reply delivery with a shared collaboration skill.

**All three CLIs consumed external messages and returned exact nonce replies in disposable interactive sessions, both idle and busy. hc was not required.** These are receiver feasibility probes, not a complete inter-agent service or production adapters.

## Results

| CLI | Receive mechanism | Idle | Busy | Important qualification |
| --- | --- | --- | --- | --- |
| Codex 0.166.0 | `codex queue --thread UUID --message TEXT` | Passed | Passed | Ordinary private `--no-daemon` TUI worked; no app-server launcher needed. |
| OpenCode 2.2.5 | Native `/api/session/{ID}/prompt`, `delivery:queue` | Passed | Passed | Full TUI attached and rendered replies. Default free model was quota-blocked; existing `claude-agent/haiku` provider passed. |
| Claude Code 2.1.318 | SessionStart/Stop `asyncRewake` command hooks | Passed twice | Passed | Watcher must remain armed. This probe has a three-minute idle-expiry gap and is not a production receiver. |

Each success means an actual assistant reply matched a unique nonce in conversation history, rather than a successful queue command or an echoed user prompt. Busy delivery was checked against an admitted/running workload and ordered transcript events. No model tools were needed for the tasks.

## Reproduce

Requires installed CLIs, their existing authenticated providers, Python 3, and `pexpect` (already installed on this machine). These commands invoke models and consume normal account usage. Each creates scratch files and new test sessions; no integration is installed into your normal sessions.

```sh
python3 intercom-spike/codex_probe.py
python3 intercom-spike/opencode_probe.py --model claude-agent/haiku
python3 intercom-spike/claude_probe.py
```

Run from the repository root. Evidence remains under each printed `/tmp` path. The probes stop their own interactive processes. OpenCode removes its own scratch session after exporting evidence; Claude's normal session transcript and scratch-folder trust record may remain in its application state. Codex uses a scratch CODEX_HOME with a symlink to existing auth, a read-only sandbox, and a scratch working directory. It does not change the user's Codex configuration. No live user session was prompted.

## Concrete evidence

Codex evidence: `/tmp/intercom-codex-bd1oimqq/results.json` and its `home/sessions/` transcript. Initial, idle, admitted-busy, busy-without-final-at-submission, and busy-consumption checks all passed. The running workload finished at `04:35:45.192Z`; queued peer message became a user item at `04:35:45.216Z`; exact `BUSY_ACK_bc08787b92` assistant reply followed at `04:35:46.778Z`. The queue was submitted before the long-running response completed. Replies were displayed by the ordinary TUI. An earlier attempt accidentally left the workload as an unsubmitted composer draft and was explicitly excluded from busy evidence; the reproducer now starts that workload through the native queue too.

OpenCode evidence: `/tmp/intercom-opencode-4eumax3g/{report.json,idle-messages.json,busy-messages.json,terminal.log}`. Active-session API reported running before second input admission at `1793766922565` ms. Original response finished at `1793766928181`; queued user item followed at `1793766928183`; exact busy reply completed at `1793766929454`. Both nonce replies also appeared in the attached TUI. Session has been removed; exported evidence remains. The initial default-provider attempt returned HTTP 429 `provider.free-limit`, not an intercom transport failure.

Claude evidence: `/tmp/hc-claude-probe-luyf2fwz/` and the disposable transcript `/home/ibanks/.claude/projects/-tmp-hc-claude-probe-luyf2fwz/735f6dbe-02e6-4c0b-a0d9-354a2a5aad33.jsonl`. Assistant history contains `READY_PROBE`, `ACK_idle1_yf2fwz`, `ACK_idle2_yf2fwz`, the full 1..200 workload, and `ACK_busy3_yf2fwz`. Busy prompt was submitted at `1793766957.768`; hook delivered mail at `1793766958.132`; workload finished at `1793766960.854`; nonce response finished at `1793766961.893`. Thus the hook wake queued behind active generation rather than interrupting it. No peer-message text was typed into the composer. Settings/hooks were supplied only to this disposable invocation; model tools were disabled.

## What this changes about the design

User requirement after the first live-space test: **never deliver peer mail by typing/pasting into the human composer.** hc is discovery-only for intercom; no `hc send` fallback. Native input admission may still appear in conversation history, but it must not alter, submit, or overwrite a human draft. Concurrent human prompting is a required acceptance test, not yet verified. Claude needs an installed receiver hook for native delivery; its existing live session has none. The first live test used hc input: Claude returned `CLAUDE_LIVE_ACK_7391`; OpenCode retained the test as an unsubmitted composer paste. Those are terminal-path observations, not native intercom successes. Terminal-input testing was stopped when the user clarified this requirement.

Keep normal interactive CLIs. Build a separate local intercom service with a Unix socket and SQLite mailboxes. Adapters register native session identity and endpoint; hc can enrich discovery with project/terminal location but is optional. There is no demonstrated need to replace the CLIs with SDK-owned agent hosts for basic queued delivery.

- Codex adapter can begin with the stable queue command. Register the native thread UUID through a supported hook/launcher mechanism; the probe's inspection of its own disposable SQLite database is test instrumentation, not a proposed production discovery API.
- OpenCode plugin can register native session IDs and send queue input through its server client. Explicit queue delivery already preserves sequential execution.
- Claude adapter can register and drain mail through invocation-scoped hooks. **Solve idle watcher lifetime/rearming before calling this reliable.** The test watcher stops after 180 seconds; an idle session receives no subsequent lifecycle event to restart it. Raising the timeout alone postpones this gap. Options include a validated restartable hook-wake design, a fallback wake path, or documenting limited native idle wake capability.

Start service implementation with explicit send/reply, recipient registration, persistent message IDs/reply IDs, and separate stored/submitted/acknowledged states. Add no automatic conversation mirroring or reply echoing. Hook context is peer input, not user authorization.

Not yet established: end-to-end agent-generated send/reply tools, broker correlation, delivery across process restart, exactly-once handling, pending permission dialogs, preservation of human drafts, aliases/resumed identity changes, steering, remote machines, or long-idle Claude recovery. Do not infer these from nonce success. No shared broker or permanent CLI plugin was installed by this spike.

## Interface references

- [Codex queue](https://learn.chatgpt.com/docs/developer-commands), [app-server](https://learn.chatgpt.com/docs/app-server).
- [OpenCode v2 API](https://dev.opencode.ai/v2/docs/api). The installed wait/messages paths are captured in the reproducer; avoid substituting old v1 examples.
- [Claude hooks](https://code.claude.com/docs/en/hooks), particularly `asyncRewake` and asynchronous command-hook lifecycle.
- [Original investigation](../docs/hc-intercom-investigation.md), updated to reflect the independent-service direction.
