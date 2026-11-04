# Intercom across Codex, Claude Code, and OpenCode through hc

Later implementation: [native intercom MVP](../intercom/README.md) uses Claude's built-in per-session inbox socket and OpenCode synthetic input. The socket supersedes the Claude hook receiver discussed below; a direct live Claude ↔ OpenCode round trip passed with the shared intercom skill.

Investigated 2026-11-03. Updated direction after discussion: build an independent local intercom service with SQLite mailboxes and native CLI receive adapters. hc is optional discovery/location metadata and a fallback delivery mechanism. A useful first version is realistic; full Pi intercom parity requires adapters and explicit delivery receipts. See `../intercom-spike/README.md` for the subsequent disposable-session experiments.

## Evidence and scope

Local inspection: `hc 0.1.17`, Codex `0.166.0`, Claude Code `2.1.318`, OpenCode `2.2.5`, and installed `pi-intercom 0.18.1`. Read-only discovery found this workspace's three CLI terminals already visible to hc, all reporting agent status. Their addresses are runtime observations, not configuration to hardcode.

Inspected `hc --skill`, command help, generated `hc schema`, live `hello`/`terminal.list` through `hc connect`, and Pi intercom's installed README and receive implementation. No messages were sent to the user's agents and no integrations/settings were installed or modified. One mock receiver ran on a separate core with independent HC_SESSION and XDG paths; that core was stopped afterward.

Sources:

- [hc repository](https://github.com/herdrdev/herdr-core), [API protocol](https://github.com/herdrdev/herdr-core/blob/master/schema/README.md), [input implementation](https://github.com/herdrdev/herdr-core/blob/master/crates/herdr-core/src/input.rs), [agent manual](https://github.com/herdrdev/herdr-core/blob/master/crates/herdr-core/src/SKILL.md).
- Local Pi sources: `/home/ibanks/.local/share/pi-runtime/npm/node_modules/pi-intercom/{README.md,index.ts,broker/protocol.ts}`. In `index.ts`, `sendIncomingMessage` uses Pi's custom message and steering APIs; this is deeper integration than terminal typing.
- [Codex CLI reference](https://learn.chatgpt.com/docs/cli/reference), [Codex app-server](https://learn.chatgpt.com/docs/app-server).
- [Claude hooks](https://code.claude.com/docs/en/hooks), [Agent SDK streaming input](https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode).
- [OpenCode v2 API](https://dev.opencode.ai/v2/docs/api), [v2 client](https://dev.opencode.ai/v2/docs/build/client/), [v2 server plugins](https://dev.opencode.ai/v2/docs/build/plugins/server).

Upstream hc checkout inspected at `ec8adcdf0da38e539e8702f7c37801647da035f3`. It has draft-protection changes absent from installed 0.1.17's help/schema. Use the installed schema as the implementation contract; do not assume master behavior exists locally.

## What hc already supplies

- Persistent interactive terminals, human attach/takeover, names and labels, cwd, process identity, local/remote addressing, and parent-child lifecycle.
- `hc send`/`terminal.send`: paste and submit, sender attribution when enabled, blocked-state refusal, optional conditional status check, optional wait.
- Structured OSC 7501 status: idle, working, done, blocked, error. No screen scraping needed for status. Unknown status is not evidence of readiness.
- `hc wait`: stops on status/exit or an incoming message to its caller; it does not return a structured agent reply.
- `events.subscribe`: snapshot, ordered fact changes, sequence numbers, and missed-event recovery. Plain-mode subscription owns its connection; keep a separate RPC connection for requests.
- `hc connect`: JSON-RPC 2.0 over JSON lines, including through SSH. Framed protocol is unnecessary for an intercom unless embedding a terminal viewer.
- `doc.get` and `doc.set`: persisted opaque JSON documents, version-based compare-and-set, doc-change events, at most 1 MiB per document. Available through RPC, not a documented `hc doc` command.

The live handshake confirmed these methods. Check method/feature availability on startup rather than assuming every connected remote core matches.

hc does not itself give the application a durable correlated message protocol, consumption receipts, portable busy-agent steering, or Pi's inline message renderer. Its terminal turn counter increments when leaving working; it is not a Codex/OpenCode native turn ID.

## The Pi behavior to preserve

Pi intercom supplies discovery, aliases, targeted send/ask/reply, reply correlation, queued mail, inline transcript messages, idle wakeup, safe-boundary steering, and configurable priority for human input. Its receiver calls Pi extension APIs directly. Sharing its broker would not automatically make Codex or Claude consume messages.

Borrow the user-facing semantics and envelope design. Do not initially port Pi's overlays, handover machinery, or broker implementation. A later Pi adapter can join the new transport if desired.

## Proposed design

One `intercom` executable, accessible from each agent's ordinary shell tools. Optional shared MCP facade later for structured tool discovery. MCP tool availability alone does not provide unsolicited incoming delivery.

```text
Codex / Claude Code / OpenCode
       | explicit intercom list/send/reply/inbox
       v
intercom service -> SQLite mailbox + Unix socket
       | resolve native session + endpoint
       v
destination adapter -> native input API, hook context, or hc send
```

Run one independent local service. Adapters register the native CLI session as the recipient identity; optional hc discovery adds terminal/machine location and fallback wakeup capability. The service must also work in another terminal emulator without hc. Expose a local Unix socket, use SQLite for durable mail and correlation, and start with local-only delivery. hc need not own the service process.

Suggested interface (new commands to implement, not existing hc commands):

```sh
intercom list --cwd .
intercom send reviewer 'Check the retry policy'
intercom inbox
intercom reply MESSAGE_ID 'Only idempotent requests should retry'
intercom wait MESSAGE_ID --timeout 60
```

Register each session with core identity, terminal address, provider, native session ID, alias, cwd/project, endpoint where needed, and capabilities. Labels help discovery; native session metadata must be registered by the adapter/launcher. Neither cwd nor tab title uniquely identifies a recipient. A kept terminal may recover into a shell: revalidate current agent/session before delivering.

Store sessions, messages, and receipts in SQLite with transactions and indexes by recipient/status/message ID. Socket notifications are wake hints; reread authoritative rows after reconnect. Bound retained history, expire old messages, and use file references for larger content. Native session identity must survive terminal relocation; adapter registration includes an instance/generation to prevent delivery into an unrelated resumed or replaced process. hc documents remain a possible deployment-specific option, not the primary store.

Envelope: message ID, sender/recipient session identities, body, replyTo, createdAt, expiry, and requested delivery mode. Receipts: persisted, submitted to receiver, receiver acknowledged, replied, failed/expired. hc's `started:true` only signals observed activity and is not a consumption receipt. Native queue admission also does not prove model consumption. Keep ambiguous submissions visible; blindly retrying terminal input risks duplicates. Promise deduplication where supported, not end-to-end exactly-once processing.

Defer remote delivery until local lifecycle works. A later SSH transport can carry the intercom protocol; hc-connected machines are another optional routing backend. Do not expose native agent APIs publicly. Keep routing/mailbox ownership explicit at the destination.

## Receive adapters

| CLI | Best available integration | Constraint |
| --- | --- | --- |
| Codex | `codex queue --thread UUID --message TEXT`; app-server for turn start/steer and events | Queue success means admission. Delivery to an already running private `--no-daemon` session needs a disposable-session test. |
| OpenCode v2 | `POST /api/session/{sessionID}/prompt`, explicit `delivery: queue`; plugin for registration and events | Must know the actual server and session. Use installed v2 schema, not old v1 SDK examples. |
| Claude Code | Hooks drain inbox at tool/stop boundaries; hc submission for idle wake initially | `asyncRewake` offers a possible native idle wakeup, but timeout/rearming behavior needs validation. |

Codex details: queue supports `--resume`, but resume failure may warn while queueing still exits successfully. Use UUIDs. App-server supports `turn/start`, `turn/steer` with `expectedTurnId`, and context injection. A TUI can connect to a managed server with `--remote unix://...`. Do not assume a managed app-server can attach to any existing private TUI. hc's manual requires `--no-daemon` so agent shell commands remain inside hc's lifecycle; resolve this requirement before choosing the shared-daemon queue route. Do not silently drop it.

OpenCode details: current v2 prompt API supports text, message IDs, metadata, queue/steer delivery, and `resume:false`. Native admission can start work without terminal typing. Use `@opencode/client` or installed `opencode api`/OpenAPI schema. Server plugins can register tools and use session operations/events. Hooks may execute more than once during concurrent admission; side effects must be idempotent. Scope event handling to registered root sessions to avoid cross-talk with children.

Claude details: SessionStart can register identity; PostToolUse/PostToolBatch/Stop can contribute additionalContext. Guard Stop continuation with `stop_hook_active` to avoid loops. Ordinary async hook output waits for a later turn. Current `asyncRewake:true` hooks can wake an idle session when exiting 2, but a SessionStart mailbox watcher is an experimental adapter until bounded-wait/rearm/teardown behavior is tested. Agent SDK streaming input is a controlled alternative for managed sessions; it requires owning input and does not inject into an arbitrary existing TUI. A second `claude --resume ... -p` process is not a supported substitute for interactive input injection.

## Delivery policy and limitations

Default to queueing peer mail. Opt into steering only when the destination advertises it and has been tested. Preserve sender identity and explicit reply IDs in the injected body; treat messages as peer context with no user authority. Avoid automatic transcript mirroring and automatic reply acknowledgements that themselves trigger replies.

Terminal fallback is useful for unmanaged sessions, with reduced guarantees. Installed hc waits for a typing pause; that does not prove the composer has no unfinished human draft. Upstream adds stronger draft handling, but that is not established for this installation. Prefer dedicated agent terminals for fallback, and defer when blocked, errored, unregistered, or status is unknown. Never force delivery through permission prompts. `--if idle` gives an atomic status guard but does not accept `done`; a separate get-then-send for done has a race and needs a deliberate policy rather than pretending the same guarantee holds.

Start with nonblocking send/reply/wait. A blocking `ask` can deadlock if two peers ask each other; if added, use timeouts and separate request/reply channels and permit incoming work while waiting. Timeout is not cancellation of a message already submitted.

## Validation completed

On a scratch core with a mock OSC-reporting receiver:

1. `hc send --if idle` submitted a unique marker and returned `started:true`, status idle, turn 0.
2. Receiver printed the marker and reported working then done; wait returned done, turn 1.
3. Receiver then reported blocked; another send failed with exit 9 / kind blocked.
4. Scratch terminal was killed/removed and scratch core stopped.

Also verified read-only plain JSONL RPC handshake/list against the running user core. These checks establish transport/status primitives, not integration with the three actual model runtimes.

## Build sequence and acceptance gates

1. **Native delivery experiments:** disposable interactive sessions; prove idle/busy input and exact replies before investing in service/UI work.
2. **Minimal useful bridge:** list registered peers; explicit send/reply; SQLite persistence and Unix socket; native adapters, with terminal fallback restricted to dedicated verified receivers. All three agents can use the same shell interface. hc remains optional.
3. **Native OpenCode adapter:** registration and queued prompt admission, then receipts. This has the clearest current native API.
4. **Codex adapter:** test queue with private-process mode; prefer retaining the user's ordinary TUI and native queue over a custom app-server launcher when supported.
5. **Claude adapter:** test hooks plus asyncRewake lifecycle; retain fallback wakeups if rearming is unreliable. Choose SDK-managed workers only if that fits the desired terminal experience.
6. **Parity work:** steering, human priority, richer UI, remote machines, optional Pi adapter, then request/response convenience.

Before calling it reliable, test a disposable session of each CLI for idle/busy delivery, a pending human draft, permission dialog, duplicate retry, recipient switching sessions, router crash between submit and receipt, core reconnect, kept-terminal shell recovery, and peer reply while sender waits. Use explicit receiver acknowledgements and check session history rather than inferring delivery from status alone.

Effort assessment: the transport-only proof is small; reliable cross-CLI Pi parity is a separate integration project. The main uncertainty is receive lifecycle and semantics, particularly private Codex and idle Claude, rather than whether hc can carry messages.
