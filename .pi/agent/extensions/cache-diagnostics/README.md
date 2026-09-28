# Cache diagnostics

This extension records metadata about prompt-cache behavior for every provider, model, and session. It helps find misses that a request change caused, such as a changed system prompt, tool list, history, option, or cache key.

It replaces the old `cache-prefix-diagnostic.ts`, which observed one hard-coded session.

**Status: installed, disabled by default.** The extension creates no files until you enable it.

## Guarantees

- The extension only observes. Every handler returns `undefined`. It does not change payloads, headers, messages, settings, or cache warming.
- It makes no model calls, sends no keepalive requests, and captures no raw content.
- It does not read or change `/forensics` state, `CLAUDE_BRIDGE_DEBUG`, or the Claude bridge trace.
- Records contain only fixed field names, enums, numbers, HMAC ids, and provider/model names that the live model registry knows.
- Records never contain prompts, messages, tool names, arguments, results, payload field names, paths, raw session or account ids, error text, or header values. The extension never reads `Authorization` or any other header that is not on its allowlist.
- Storage failures never reach the provider. A failure drops the observation, clears the pairing state for that session, and shows one warning.

## Commands

| Command | Effect |
| --- | --- |
| `/cache-diagnostics on` | Writes the control file. Every Pi process reads it at each event. No reload is necessary. |
| `/cache-diagnostics off` | Stops recording. Existing data stays. |
| `/cache-diagnostics status` | Shows the state, log size, baseline count, and key presence. Creates nothing. |
| `/cache-diagnostics report [n]` | Shows the newest `n` observed misses (default 10, max 100). |
| `/cache-diagnostics purge` | Deletes logs, baselines, and the key. The control file stays. |

Offline report:

```sh
bun ~/.pi/agent/extensions/cache-diagnostics/report.ts --limit 20
```

## Storage

The root is `$PI_CODING_AGENT_DIR/cache-diagnostics`, or `~/.pi/agent/cache-diagnostics` without that variable. Tests use `PI_CACHE_DIAGNOSTICS_ROOT`.

```text
cache-diagnostics/          0700
  control.json              0600  {"enabled":true,"since":<ms>}
  key                       0600  random 256-bit HMAC key
  logs/events.jsonl         0600  plus events.1..3.jsonl
  state/<session-hmac>.json 0600  newest completed request per session
```

- The agent root can be a symlink. The diagnostics root, control file, key, log files, and state files cannot be symlinks. Files also must be regular, owned by you, and not hard-linked. Opens use `O_NOFOLLOW` and `O_NONBLOCK`, so a FIFO or device at a private path cannot block a hook. The regular-file check after the open then refuses it. Reads have size caps.
- A missing, unsafe, oversized, or malformed control file means OFF.
- A key with group or other permissions is refused.
- Logs rotate at 1 MiB per file, with four files. A short `mkdir` lock serializes rotation. If the lock is busy, a writer can exceed the cap by one more cap, then it drops records.
- Each record is one `O_APPEND` write of at most 32 KiB, so concurrent processes write whole lines.
- Each state file has a 512 KiB limit and is replaced atomically. The newest 128 sessions are kept.
- The key is created once. The creator writes a private temporary file and hard-links it to `key`, so exactly one creator wins and readers never see a partial key. No lock is held during a request.

## Identity and correlation

- `session` is `HMAC(key, session id)`. The persistent key makes it stable across restarts, so a new process compares against the previous process's baseline.
- `run` is random for each OS process. `inst` is random for each extension instance. Parent sessions and in-process subagent sessions have separate instances and separate state.
- Content hashes are keyed with domain separation. Without the key, nobody can confirm a guessed prompt or model name. Anyone with the key and the logs can confirm guesses, so `purge` deletes the key too.
- Plain provider/model names appear only when `ctx.modelRegistry.find(provider, model)` knows the exact pair. Other names are HMACs.

## What each hook contributes

Pi 0.87.1 hook order for one agent LLM call, from the installed source:

1. `context_with_system`: the logical transcript after all `context` handlers. This opens a request **attempt**. Fingerprint layer: `context`.
2. `before_provider_headers`: fires in `applyAuth`, before the provider adapter builds its own headers and body. It shows only auth, attribution, and `options.headers` values. Adapter-built headers such as `session_id`, `x-session-id`, `x-client-request-id`, `session-id`, and `chatgpt-account-id` are **not visible**.
3. `before_provider_request`: the adapter body at this handler's position. Fingerprint layer: `provider_payload`.
4. `after_provider_response`: the HTTP status. Adapter-internal retries fire it more than once for one payload.
5. `message_end` (assistant): the actual `provider`, `model`, `api`, `usage`, and `stopReason`. This closes the attempt.

Other hooks add markers: `before_agent_start` (user turn), `session_start` (startup, reload, new, resume, fork), `session_compact`, `session_tree`, `model_select`, `thinking_level_select`, `cache_warming_decision`, `agent_end`, and `session_shutdown`.

### Coverage limits

- **Hook time is not wire time.** This auto-discovered user extension runs after package handlers. Later handlers, such as project or command-line extensions, can still change the payload. The transport can also change what goes on the wire. For example, the Codex WebSocket path sends only an input delta with `previous_response_id` when its connection-scoped state matches. That state is lost at a restart.
- **Custom providers.** `pi-claude-bridge` never calls `onPayload`, so it has only the `context` layer. The hidden Claude Code preset and the SDK wire prefix are not observed. Records say `layers: ["context"]` and `pairing: "context_only"`. To settle wire questions, use the separate bridge trace or provider-specific hooks. This extension does not join the bridge trace: that trace uses its own memory-only key.
- **Cache warming.** The warmer replays the previous request with `onPayload`, so `before_provider_request` fires without `context_with_system` and without `message_end`. Warm usage goes to a `usage` session entry. No hook reports it, and this extension does not read session entries. `cache_warming_decision` shows the action proposed at this handler's position. A later handler can override it. The record is a `warm_candidate` only when a decision proposing `warm` preceded the payload and no attempt was waiting for a payload. Missing warm evidence does not prove that warming never ran.
- **Nested calls.** Extension calls through `ctx.modelRegistry.streamSimple()`, compaction summaries, and similar calls normally fire no request hooks. They are invisible.
- **Subagents.** In-process subagents that load extensions get their own records. Subagents started with extensions disabled are invisible.
- **Usage.** pi-ai adapters initialize `cacheRead` to 0, so `0` can mean "not reported". Records say `zero_or_unreported`, never "miss" alone. `promptTokens` and `readRatio` exist only for adapters that were verified to report `input` without cache tokens: anthropic-messages, openai-responses, openai-codex-responses, azure-openai-responses, openai-completions, google-generative-ai, google-vertex, and bedrock-converse-stream. Providers that an extension registered with a custom `streamSimple` are unverified.
- **TTL.** Provider TTL and eviction are unknown. `ttl` is the model's `promptCache` tiers in pi's registry, not a provider guarantee. Without it, pi's warmer does not schedule.

## Fingerprints

Each layer stores:

- `sys`: an HMAC of the system prompt or instructions, 2 KiB chunk hashes, and section hashes. Payload sections split at Markdown headings or leading XML-like tags. Context sections are the leading message content and each named `sections` entry. Comparison reports the first changed chunk and section.
- `tools`: an ordered list of name and definition HMACs. Comparison reports identical, append, or rewrite, the first changed index, added and removed counts, reordering, and changed definitions.
- `msgs`: one HMAC per message or input item, up to 4096 items. Comparison requires the previous items to be an exact prefix. It reports `identical`, `append`, `rewrite`, `shorter`, or `unknown`, and the first changed index and its role/type enum.
- `options`: per-field HMACs of known cache-relevant fields, such as `model`, `reasoning`, `thinking`, `output_config`, `prompt_cache_retention`, `betas`, `tool_choice`, `max_tokens`, Google `config`, and Bedrock `toolConfig`. Some values are also plain when they are numbers, booleans, or allowlisted enums.
- `affinity`: HMACs of `prompt_cache_key`, `promptCacheKey`, `previous_response_id`, `conversation`, `user`, `safety_identifier`, and `metadata`. Allowlisted request headers go to a separate `headers` comparison.
- `opaque`: a count and one HMAC of all unknown top-level fields. Field names are never stored. A change there, or a wholly unknown payload, makes the verdict `unknown`.

Normalization is minimal and deliberate:

- Cache breakpoints move every request and are not prompt content. They are removed before hashing and counted separately (`cacheMarkers`, `markersMoved`), but only at the positions where pi-ai 0.87.1 writes them:
  - Anthropic mode (anthropic-messages payloads, and openai-completions payloads that carry Anthropic breakpoints): the top-level `cache_control` key of a typed system or message content block, and of a tool object.
  - Bedrock mode: `{cachePoint}` elements of the `system` array, of a message `content` array, and of `toolConfig.tools`.
  - Other formats: nothing is removed.
- A key named `cache_control` or `cachePoint` anywhere else stays hashed. This includes tool schemas (`input_schema`, `parameters`, `inputSchema`), tool-call arguments, tool-result content, and unknown shapes.
- In Anthropic mode, string message content hashes as `[{"type":"text","text":...}]`. Anthropic documents a string as shorthand for one text block. pi-ai converts the last string message to that form to attach a breakpoint, so without this rule every moving breakpoint would look like a history rewrite.
- Provider ids, signatures, encrypted reasoning, and timestamps inside content stay hashed, because they are sent and can affect the cached prefix.
- The context layer excludes only `timestamp`, `usage`, and `diagnostics`. That local bookkeeping is never serialized by pi-ai adapters.
- Hashing has a 16 Mi-character budget for each fingerprint. Parts beyond it become `null`, `complete` becomes `false`, and the verdict can be `unknown` but never `extends`.

`prefix` is `extends` only when system, tools, and every previous item are unchanged and fully hashed. It is `early_change` when any hashed part changed. Token counts alone never decide it.

## Pairing

- One attempt is open per `context_with_system`. The next payload attaches only when exactly one attempt is open and waiting for its payload.
- `message_end` pairs only when exactly one attempt is open, it is not ambiguous, and it has at most one payload. Then `pairing` is `single_request` or `context_only`.
- Overlapping attempts in one session, extra payloads, or unexplained responses make the attempts `ambiguous`. Their responses are recorded as `kind: "response"` without comparison. Nothing is paired by FIFO order.
- A response with no open attempt is `unpaired`. An attempt that is still open at `agent_end` or `session_shutdown` is recorded as `unfinished`. An attempt older than 30 minutes is recorded the same way when the next request of that session starts.
- Only `stop`, `length`, and `toolUse` responses advance the baseline. `error` and `aborted` responses are recorded with the enum only.
- The gap is the time from the previous completed response in this session to the start of this request (`context_with_system`). It excludes the generation time of this response. It includes the time across restarts. `boundary` is `user_turn` after `before_agent_start`, `tool_boundary` after a `toolUse` response, `other_continuation`, or `unknown`.
- Markers, warming evidence, and unanchored counts accumulate from the previous completed response.
- `baseline.stale` means that unpaired, ambiguous, or unfinished traffic occurred after the baseline. The comparison can then skip requests.

## Reading the report

An **observed miss** is a paired, completed request with a baseline and one of these conditions:

- `zero_read`: cache read is 0 or not reported.
- `reduced_read`: verified usage shows a cache read below half of the previous prompt.

For each miss, the report shows **facts** first: models, usage, gap, boundary, restart, markers, prefix comparison, affinity, and warming evidence. **Suspected** causes follow, based only on observed changes. Without any observed change, the report says so. It names provider TTL, eviction, or routing as unobservable possibilities, not as proven causes. The report never states that a miss was preventable. `pairing` values other than `single_request` or `context_only` get no causal verdict.

## Tests

```sh
cd ~/.pi/agent/extensions/cache-diagnostics
bun test tests/
```

The tests use temporary roots and fake or real Pi dispatch only. `tests/runner.integration.test.ts` loads `index.ts` through the installed Pi jiti loader and real `ExtensionRunner`. It skips when the Pi package is absent. `PI_CODING_AGENT_PACKAGE` selects another package path.
