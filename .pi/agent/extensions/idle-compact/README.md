# Provider-aware idle keepalive and compaction

Loaded globally through this repository's `~/.pi` symlink. Run `/reload` to load;
a real request must then occur before any timer is armed. No cache lifetime is
invented on reload/resume. Built-in overflow/threshold compaction is unchanged.

## Approved client policies

| Provider | Cache lifetime used for scheduling | Idle refresh interval |
| --- | --- | --- |
| `openai-codex`, all models | Assumed 5 minutes | 4 minutes |
| `claude-bridge`, all models | 1-hour included-subscription main-conversation TTL | 50 minutes |
| `xai` (including scoped Grok 4.6 / 4.7) | Assumed 5 minutes; eviction is possible at any time | 4 minutes |
| `opencode-go` (including scoped DeepSeek / Gemini) | Assumed 5 minutes; Go-route lifetime is undocumented | 4 minutes |

These are **client scheduling policies**, not new provider guarantees, and do
not overwrite provider catalog metadata. Source evidence and route caveats are
in [`docs/pi-scoped-cache-lifetimes.md`](../../../../docs/pi-scoped-cache-lifetimes.md).

For all four routes:

- Refresh only when context usage is known and passes the configured keepalive
  minimum (default: **strictly above 100,000 tokens**), fully idle, with no queued
  messages. Recheck at dispatch.
- Stop at **60 minutes from the latest real provider request**, not from the
  latest keepalive. A new real request resets the window; a refresh never does.
- At the horizon, use the independent compaction minimum (default: **strictly
  above 200,000 tokens**). A context may qualify for either operation without
  qualifying for the other. No minimum removes a floor, not the requirement for
  known context usage.
- Cancel on input, activity, model changes, tree navigation, compaction, or
  shutdown. A refresh has a **20-second abort timeout**, with no provider retries.
- Stop refreshing after a failure or a timer more than **30 seconds late**; keep
  the compaction horizon. Do not deliberately rebuild a cache after sleep.
- Suppress Pi's native warmer on these routes to avoid duplicate refreshes.
- Unknown providers receive no new fallback policy and retain the legacy
  compaction/native-warming behavior described below.

### Claude billing caveat

The one-hour policy assumes main SDK turns within included subscription usage.
It does **not** detect a transition to paid usage credits. If you use extra
usage, explicitly request a one-hour TTL in Claude Code, or set
`CLAUDE_CODE_PROMPT_CACHE_TTL=5m` before starting Pi. The plugin recognizes that
variable, and `FORCE_PROMPT_CACHING_5M=1`, switching its bridge policy to the
five-minute/four-minute fallback. TTL settings in Claude's own settings file are
not read by this extension; keep those consistent with the plugin's assumptions.
Compaction/helper TTLs may differ from the main-conversation TTL.

## Request handling and accounting

- Capture the real serialized provider payload when its API exposes one.
  Replay its prefix and affinity with a temporary "reply exactly OK" user
  instruction. Existing messages, tools, and reasoning settings are not rewritten.
  Tool choice is disabled for Responses/Completions replays.
- For providers such as Claude bridge that do not expose payload hooks, capture
  the full logical context through `context_with_system` and Pi's real
  `convertToLlm()` helper. Preserve the session ID and thinking level and append
  the instruction only to the temporary call. Bridge-owned CLI transformations
  and cache behavior remain outside this extension's visibility.
- Use SSE for Codex refreshes so they do not disturb foreground cached WebSocket
  state. Other providers retain their normal transport.
- No local tool execution loop is run. Neither the temporary instruction nor
  response enters Pi's conversation history. Provider-owned SDK history may be
  synchronized internally by the bridge on the next real turn.
- Usage, including reported cache reads, is stored as **`idle-keepalive-usage`**
  custom metadata, not model context. Provider/model are included, not prompts.
  These records are **separate from Pi's built-in totals**. Old
  `codex-keepalive-usage` records remain untouched.

**Best effort, not free:** these are real requests against your quota. Original
output/thinking settings are preserved to avoid invalidating the prefix. The
Codex adapter ignores `maxTokens`; other replays also rely on the OK instruction
and timeout rather than a hard output cap. Abort does not guarantee server-side
cancellation, and cancelled requests may have unreported usage. A cache hit,
unchanged backend routing, or cost saving is never guaranteed.

## Settings menu

Open **`/idle-compact`** or **`/idle-compact settings`** for the built-in-style
settings list. The **Edit** row selects global defaults or an exact
`provider/model` override. It offers the current model, scoped models, and any
models with existing overrides.

Keepalive and compaction each have their own minimum. Presets include **25k,
50k, 75k, 100k, 150k, 200k, 250k, 300k, 500k, and 1M**, plus **No minimum** and
**Custom…**. Custom input accepts token counts, `k`/`m`, and commas (`125k`,
`250000`, `1.5m`). Entering `0` also means No minimum. Numeric floors are strict:
a context equal to 25,000 does not pass a 25k minimum. Unknown usage remains
ineligible even with No minimum.

An override can **Use default** independently for either field. Choosing that
removes the field's override; it does not copy today's default, so later default
changes are inherited. **No minimum is an explicit override**, not inheritance.

Changes save immediately to **`~/.pi/agent/idle-compact.json`**, or under
`PI_CODING_AGENT_DIR`. `PI_IDLE_COMPACT_CONFIG` can select another file. This is
local numeric configuration, not prompt/context content; it is ignored by git.
Defaults remain 100k/200k until edited. For example:

```json
{
  "defaults": {
    "keepaliveMinimumTokens": 100000,
    "compactionMinimumTokens": 200000
  },
  "modelOverrides": {
    "openai-codex/gpt-6.1-sol": { "keepaliveMinimumTokens": 25000 },
    "xai/grok-4.7": { "keepaliveMinimumTokens": null }
  }
}
```

The edited session reconciles timers without resetting the real-request clock.
Other sessions read changes at their next activity/eligibility check; inactive
sessions may need another real request to arm a timer. A late refresh is still
skipped rather than deliberately rebuilding an expired cache. Invalid settings
fail closed for automatic operations and are reported by the menu.

**Caution:** No minimum for compaction allows small contexts to be compacted at
the idle horizon, which can add unnecessary model calls. It does not turn off
compaction; `/idle-compact off` does that.

## Commands

- `/idle-keepalive status|on|off`: current route policy and refresh usage since
  reload. Off cancels refreshes and their compaction handoff; on waits for the
  next real request.
- `/codex-keepalive status|on|off`: compatibility alias for the same controller.
- `/idle-compact [settings]`: open the settings menu (values persist across reloads).
- `/idle-compact status|on|off`: independently inspect/enable/disable compaction.
  Off does not disable keepalives. On/off toggles last until reload.

## Other providers: legacy compaction

For providers outside the approved table, idle compaction still requires known
context passing its configured minimum (default **>200,000 tokens**), settlement,
and no queued messages. Models declaring
`promptCache` use 90% of the active retention tier, with at least ten seconds of
margin; `PI_CACHE_RETENTION=long` selects long. Unknown lifetimes disable it.
`PI_IDLE_COMPACT_MINUTES` overrides legacy timing only; positive values up to
1440 are accepted, while zero/invalid values disable it. These settings do not
change the approved keepalive policies. A native warming decision can substitute
compaction for an eligible legacy-provider context.

Compaction uses Pi's normal compactor, costs a model call, and rewrites context.
Failures are not retried without another real request.

## Tests

```sh
bun test ./.pi/agent/extensions/idle-compact/tests/*.test.ts
```

Tests resolve Pi's real conversion helper from the installed host package;
`PI_CODING_AGENT_PACKAGE` can override the default global installation path.
They use fake clocks/providers, including real Pi-loader integration. They send
no paid requests and do not constitute live provider cache-hit verification.
