# Idle compaction and Codex keepalive

Loaded globally through this repository's `~/.pi` symlink. Run `/reload` to load.
Built-in overflow/threshold compaction is unchanged.

## Codex

For provider `openai-codex`, keep the cache warm first, then compact:

- Refresh every **four minutes**, only when fully idle with no queued messages.
- Stop after **30 minutes from the latest real provider request** (not from the
  latest keepalive). At that point compact only if context is **>200,000 tokens**.
- Replay the captured serialized request prefix and cache key, appending a
  temporary "reply exactly OK" instruction. Neither the temporary instruction
  nor response enters the conversation. No tools are executed.
- Use SSE to avoid changing the foreground cached WebSocket state. The original
  tools, instructions and reasoning settings remain in the replay to preserve
  the prefix as closely as possible; tool choice is set to `none`.
- Cancel on new activity, model changes, tree navigation, compaction or shutdown.
  Each request has a **20-second timeout** and no provider retries. Stop refreshing
  after a failure or a timer more than 30 seconds late; retain the compaction
  horizon. No timers keep a noninteractive process alive.
- Suppress Pi's native Codex warming to avoid duplicate refreshes.

Commands: `/codex-keepalive status|on|off`. Off cancels both keepalives and their
compaction handoff; on waits for the next real request. `/idle-compact off`
disables the compaction handoff without disabling keepalives. Toggles last until
reload. Changes to `PI_IDLE_COMPACT_MINUTES` do not change Codex's schedule.

**Best effort, not free:** the installed Codex adapter ignores `maxTokens`, so
"reply OK" is an instruction, not a hard output cap. Background usage counts
against your provider quota. Timeouts/aborts do not guarantee server cancellation.
Cache retention, cross-transport routing and cache hits are not guaranteed.

Returned usage is stored as `codex-keepalive-usage` custom metadata (not model
context). `/codex-keepalive status` shows its cost since reload, **separately from
Pi's built-in totals**. Cancelled requests may have unreported usage. This does
not enable raw request logging; the captured prompt exists only in memory.

Your global `cacheWarming: "idle"` already enables Pi's native warmer. Its Codex
catalog lacks TTL metadata, and its one-token limit is ignored by the Codex
adapter, which is why this provider uses a separate bounded implementation.

## Other providers

Automatically call Pi's normal compactor only when context usage is **strictly
above 200,000 tokens**, the agent has fully settled, no messages are queued, and
the estimated cache deadline is approaching.

Use `/idle-compact status|on|off`.

Timing, measured from the latest turn's request start (generation time counts):

- `claude-bridge`: 54 minutes, the user's chosen Claude Code heuristic.
- Models declaring `promptCache`: 90% of the active retention tier's lifetime,
  with at least ten seconds of margin. `PI_CACHE_RETENTION=long` selects long.
- Unknown providers without metadata: disabled.

Set `PI_IDLE_COMPACT_MINUTES=54` before starting Pi to override this timing.
Values must be positive and at most 1440; zero/invalid values disable it.
Pi's native cache-warming decision, when available, takes precedence as the
expiry signal: eligible large idle contexts compact instead of warming.
Smaller/busy contexts retain Pi's normal warming behavior.

Reload/resume does not invent a fresh cache lifetime: a real request must occur
before scheduling. Compaction failures are not retried until another real
request. Compaction costs a model request and rewrites the prompt; a cache hit
or cost saving is not guaranteed, especially with bridge summary requests.

References:
- https://platform.claude.com/docs/en/build-with-claude/prompt-caching — default
  five-minute or optional one-hour TTL; 54 minutes is a margin, not the TTL.
- https://developers.openai.com/api/docs/guides/prompt-caching — in-memory
  caching typically persists 5–10 idle minutes, with model-dependent options;
  this is not a subscription Codex retention guarantee.

Tests: `bun test ./.pi/agent/extensions/idle-compact/tests/*.test.ts`
