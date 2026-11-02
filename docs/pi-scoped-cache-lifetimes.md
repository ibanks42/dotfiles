# Cache lifetimes for scoped Pi models

Research date: 2026-11-01 (local). Scope read from `.pi/agent/settings.json`.
No runtime policy or model metadata was changed by this research.

## Summary

| Scoped models | Pi route | Published lifetime evidence | Applicability |
| --- | --- | --- | --- |
| `gpt-6-astra`, `gpt-6.1-sol`, `gpt-6-luna` | `openai-codex` | OpenAI's public Responses API documents a **30-minute default minimum**, optionally **12 hours**, for GPT-5.6 and later. | Strong public API documentation, but **not verified for Pi's ChatGPT/Codex subscription endpoint**. Do not silently replace the user-selected Codex policy with 30 minutes. |
| `claude-fable-5-1`, `claude-opus-5-5`, `claude-sonnet-5-5` | `claude-bridge` → Claude Code Agent SDK | Claude Code requests **one hour** for main-conversation requests within a Claude subscription's included usage. Main conversation explicitly includes SDK turns. Otherwise default **five minutes** for API keys, usage credits, and cloud-provider billing. | Strong route-level documentation. Actual billing mode and TTL overrides matter. Requests outside the main conversation normally default to five minutes, even on a subscription. |
| `grok-4.6`, `grok-4.7` | direct `xai`, Responses API | **No fixed TTL published in the consulted docs.** Cache entries can be evicted at any time due to load or restarts. | xAI explicitly documents eviction uncertainty. No numeric lifetime can be inferred. |
| `deepseek-v4.1-flash` | `opencode-go` | DeepSeek's own API says unused disk cache is usually cleared within **a few hours to a few days**, best effort. | This is upstream DeepSeek behavior, **not an OpenCode Go guarantee**. No Go-specific cache lifetime found. |
| `gemini-4-argon` | `opencode-go` | Google's current Gemini caching page documents automatic **implicit caching**, but **no fixed lifetime**. It lists Argon with a 4,096-token caching minimum. | No numeric lifetime found for implicit caching or for this OpenCode Go route. Do not substitute the lifetime of a separately created explicit cache resource. |

## OpenAI: correction to older guidance

Source: [OpenAI prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching), sections “Cache lifetime,” “GPT-5.6 and later,” and “Cache location.”

The current guide says:

> In the Responses API, set `prompt_cache_options.ttl` to choose the minimum cache lifetime.

The table gives `"30m"` as the default and `"12h"` as the longer option. It also states that a 30-minute read refreshes coverage to at least 30 minutes after that read, and:

> The minimum lifetime governs eligibility for cache-read pricing. It does not guarantee that every request reuses stored KV tensors or has lower latency.

The same guide's **earlier-model** section says `in_memory` entries typically remain active for 5–10 minutes of inactivity, up to one hour. Applying that older-model range as the documented lifetime of GPT-6 was incorrect.

The cache-location section still warns about machine-local state and overflow routing. Pricing coverage, physical KV reuse, and a guaranteed cache hit are distinct questions.

Pi's installed `pi-ai/dist/api/openai-codex-responses.js` uses `https://chatgpt.com/backend-api` by default, not the public `api.openai.com/v1/responses` route. Its payload builder sends `prompt_cache_key`; inspection found no `prompt_cache_options` TTL selection. The public API's guarantees have therefore **not** been established for this route.

Model references:
- [GPT-6 Astra](https://developers.openai.com/api/docs/models/gpt-6-astra)
- [GPT-6.1 Sol](https://developers.openai.com/api/docs/models/gpt-6.1-sol)
- [GPT-6 Luna](https://developers.openai.com/api/docs/models/gpt-6-luna)

The user's Codex-only policy remains: assumed five-minute lifetime, four-minute refreshes, 60-minute horizon from the latest real request, known context strictly above 100k. It is a local policy, not a verified provider guarantee.

## Claude bridge: subscription main turns versus helper requests

Source: [How Claude Code uses prompt caching](https://code.claude.com/docs/en/prompt-caching.md), “Which TTL each request gets” and “Choose the TTL yourself.”

The main-conversation bucket includes:

> your interactive turns, non-interactive `-p` runs, and Agent SDK turns, plus the helpers Claude Code runs inline with them

Its default-TTL table says:
- Main conversation, subscription within included usage: **one hour**.
- Main conversation, usage credits/API key/cloud provider: **five minutes**.
- Everything else: normally **five minutes**, except certain server-controlled subscription helpers.

Compaction, forks, subagents, and session titles are listed outside the main conversation. A separate Pi session hosted through a primary SDK query should not automatically be treated as a Claude Code subagent merely because it coordinates with another Pi session.

TTL controls include `CLAUDE_CODE_PROMPT_CACHE_TTL`, `CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL`, `promptCacheTtl`, `subagentPromptCacheTtl`, and `ENABLE_PROMPT_CACHING_1H`. `FORCE_PROMPT_CACHING_5M=1` takes precedence.

Source: [Claude Code environment variables](https://code.claude.com/docs/en/env-vars).

Local observations:
- Installed `claude --version`: 2.1.316.
- Installed bridge source uses the Agent SDK `query()` path for primary provider turns.
- No TTL-control environment variables were present in this research shell, and no relevant TTL settings were found in the user Claude settings file examined.
- This does **not** prove the environment or billing mode of every running bridge subprocess. Saved Pi message usage examined did not expose `cacheWrite1h`, so no event-local TTL verification was available from those records.

## xAI / Grok

Source: [Prompt caching: best practices and FAQ](https://docs.x.ai/developers/advanced-api-usage/prompt-caching/best-practices).

The docs say caching is available on all Grok language models. In response to “How long do cache entries persist?”:

> Cache entries can be evicted at any time due to server load or restarts.

The recommended affinity is a stable `x-grok-conv-id`, or `prompt_cache_key` for the Responses API. Pi's cached catalog selects `openai-responses` for the two scoped Grok models; its installed adapter supplies a session-derived `prompt_cache_key` unless caching is disabled. This supports affinity, not a numeric retention guarantee.

## DeepSeek through OpenCode Go

Sources:
- [DeepSeek Context Caching](https://api-docs.deepseek.com/guides/kv_cache/), “Additional Notes.”
- [OpenCode Go](https://opencode.ai/docs/go/), supported models and session routing.

DeepSeek says:

> The cache system works on a "best-effort" basis and does not guarantee a 100% cache hit rate.

> Cache construction takes seconds. Once the cache is no longer in use, it will be automatically cleared, usually within a few hours to a few days.

The current page also describes complete prefix units and persistence at request boundaries. A sufficiently long overlapping prefix is not by itself proof that a reusable persisted unit exists.

OpenCode Go lists DeepSeek V4.1 Flash and cached-read pricing, and asks clients to send stable `x-opencode-session` values for routing and caching. Its consulted docs do not state a numeric cache lifetime. Pi's installed OpenCode extension has explicit stable session-header handling. None of this proves that Go exposes the same disk-cache persistence as the direct DeepSeek API.

## Gemini through OpenCode Go

Sources:
- [Google Gemini context caching](https://ai.google.dev/gemini-api/docs/caching), current page dated 2026-10-23.
- [OpenCode Go](https://opencode.ai/docs/go/).

Google's current page describes automatic implicit caching and recommends similar prefixes in a short time interval. It gives no numeric TTL. OpenCode Go lists Gemini 4 Argon and cached-read pricing, but no numeric retention promise was found.

Explicit caching creates separately managed cache resources. A default expiration documented for those resources would not establish the lifetime of implicit caching on the ordinary Pi/OpenCode Go conversation path.

## Warming cadence is not a cache-lifetime guarantee

Source: [OpenCode session warming](https://opencode.ai/v2/docs/warming).

OpenCode's own warming defaults are a four-minute interval and a 30-minute window. Its automatic mode uses 90% of configured `cache.ttl`, and skips models without that metadata. These are client scheduling defaults, **not evidence** that Go guarantees a five-minute cache lifetime for every served model.

## Conclusions for future configuration

- Claude bridge has the strongest route-relevant numeric evidence: one-hour primary SDK-turn TTL **when within included subscription usage**, with five-minute exceptions and explicit override controls.
- GPT-6 public API documentation has a 30-minute default minimum, but applying it to the Codex subscription backend remains unverified.
- Do not encode a fixed Grok or Gemini implicit TTL as a documented fact.
- Do not turn DeepSeek's upstream hours-to-days description into a Go route guarantee.
- Other-provider fallback defaults remain undecided by the user. No defaults were set during this research.
