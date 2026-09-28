# Native subagent routing

Tintinweb's `pi-subagents` owns agent execution, sessions, UI, and controls.
This extension selects the model and reasoning level before each new `Agent` tool call.
It also restarts rate-limited agents on another route and escalates weak results on request.
On request, a fixed reviewer examines the file changes of the latest delegation batch. See [Manual review](#manual-review).

## Controls

- `Agent`: start an agent. Background mode returns an ID immediately.
- `get_subagent_result`: get status or output. Use `verbose: true` for the conversation, or `wait: true` to wait.
- `steer_subagent`: redirect a running agent or request a progress report.
- `stop_subagent`: stop a running or queued agent. This wrapper requires an exact agent ID.
- `Agent(resume: id, prompt: ...)`: continue an existing agent session without a new routing decision.
- `/agents`: open the native manager and its live conversation viewer.

Steering takes effect after the current tool execution. Stopping does not undo edits.

## How a model is chosen

1. The parent adds a `routing` field to the `Agent` call: level, kind, whether it edits, and a one-line reason.
   The backend does not declare this field. The router reads it and removes it.
2. The classifier sees the task, the parent's rating, the agent type, and every usable model's profile.
   It returns a level, a task kind, a model name, and a thinking level.
3. The scout runs when the parent gave no rating, or when the two levels differ by `scout.levelGap` or more.
   The scout is the classifier with read-only tools for a few turns. If it is still unsure, the router uses the model's `stronger` link.
4. The router tries the model's routes in order, then its `fallback` chain. Each model is tried once.
   The router skips quota-blocked routes and routes that the model registry cannot authenticate.
5. Pi clamps the thinking level to what the selected model supports.

Levels are `trivial`, `routine`, `hard`, and `extreme`.
Kinds are `implementation`, `debugging`, `review`, `research`, `docs`, and `mechanical`.

Explicit model and thinking arguments override the decision. A configured model name, such as `sol`, keeps its routes and fallback chain.
A model pin alone still gets a classified thinking level.
Custom agent frontmatter takes precedence over tool arguments, as required by the backend.

If the classifier fails, the router uses `fallbackModel`. If `fallbackModel` is not set, the `Agent` call is blocked.

### Reviews

For a review, the router removes the author's model family from the candidates when another family is usable.
The author comes from the parent's `routing.reviewing` field when present.
Otherwise the router checks which family's agents edited the files that the prompt names.
If no single family edited them, the parent session's family counts as the author.
File authorship is kept in memory for the current Pi process only.

### Rate limits

A Claude rate limit forces a fresh quota reading. A full session or all-models meter blocks every Claude model.
A full per-model meter, such as `Week (Fable)`, blocks only that model. A limit that the meters do not show blocks only the failed model.
Other providers get a provider-wide cooldown until the reset time in the error, or `rateLimitCooldownMs`.
Each Codex account is its own provider, so a limit on one account does not block the other.

After a rate limit, the router starts a new agent on the next usable route when that cannot duplicate edits:

- The failed agent used no tools.
- Or the agent type is read-only. The new agent receives the partial findings.

Other agents are not restarted, because they may already have changed files. The router reports this instead.
The router posts the new agent ID in the conversation. It retries a task at most 3 times.

### Escalation and history

`/subtask-router escalate <agent-id>` starts a new agent on the model's `stronger` link, one thinking level higher.
The new agent gets the original prompt, the previous final report, and a warning that files may already have changed.
Escalation works after `/reload` because the routing entries keep a copy of the prompt.

Every routed task and every escalation is counted per model and task kind in `~/.pi/agent/subtask-router-state.json`.
The classifier sees these counts as a history line in each profile. Your profiles in the configuration are never changed.

## Configuration

`~/.pi/agent/subtask-router.json`:

- `router`: the classifier model as an exact `provider/id`, its thinking level, and its timeout.
  Do not use a `claude-bridge` model. The bridge refuses calls with system prompts that it has not captured from a real session.
- `scout`: `maxTurns`, `timeoutMs`, and `levelGap`.
- `fallbackModel`: the model name to use when the classifier fails.
  An exact route, such as `zai/glm-5.3-flash`, is also accepted if exactly one model lists it. The router then uses that model's name.
  If more than one model lists the route, or no model lists it, the configuration error names the models to choose from.
- `models`: one entry per model name.
  - `routes`: exact `provider/id` values for the same model, in order. Use one route per account.
  - `family`: the vendor, for the review rule.
  - `profile`: what the model is good and bad at, in plain words. The classifier reads this text.
  - `fallback`: the model to try when every route is unusable. Two models can be each other's fallback.
  - `stronger`: the escalation target.
- `agentTypes`: optional fixed facts per custom agent type (`kind` and `readOnly`). No types are configured by default.
  The classifier still judges the difficulty.
- `quota`: `maxUsedPercent`, `claudeCacheMs`, `claudeWaitMs`, and `rateLimitCooldownMs`.
- `maxOutputChars`: the text limit for `Agent` and `get_subagent_result` results. Longer output goes to a private temporary file.

The router uses every model that the model registry can authenticate.
`enabledModels` in `settings.json` and `/scoped-models` control only the model cycle of the main session. They do not limit routing.
The model profiles in this file decide which models are candidates.
`scopeModels` is off in `subagents.json`, so the backend accepts a routed model that is not in `enabledModels`.
At session start, the router warns about routes that are not available, a missing `fallbackModel`, and loops in `stronger` links.
Configuration errors, such as a link to an unknown model, block routing with a message.

Claude quota comes from the fast usage call in the usage-meters extension (about 0.3 s), with the `claude` CLI as fallback.
Before a pick, the router waits at most `claudeWaitMs` for a stale reading. Unknown quota permits an attempt.

`~/.pi/agent/subagents.json` holds concurrency, nesting, and native UI settings.
Workflows, schedules, and new-agent mentions are disabled because those spawn paths bypass the `Agent` routing hook.
Nesting is disabled. Each child does not receive the parent's stop tool or router hooks.

### Claude bridge and subagents

The Claude bridge rejects tools whose schema root is not an object.
Codex Conversion's `notebook` tool has an `anyOf` root, so `general-purpose.md` sets `disallowed_tools: notebook`.
The legacy `Explore` type is disabled. Its minimal agent file prevents the backend's built-in definition from reappearing.
`general-purpose.md` otherwise repeats the backend's built-in definition.
If a Claude subagent fails with "MCP tool parameters must be an object schema", disallow the named tool the same way.

## Manual review

`/subtask-router review [focus]` starts a reviewer on the latest delegation batch. Only the user starts it.

- The reviewer always runs on `openai-codex/gpt-6-astra` with `high` thinking.
  It gets no classifier decision, no route list, and no fallback.
- If this exact model is not authenticated, or its quota is known to be exhausted, the command refuses.
  It does not use the second account or another model. If the start fails, the command reports the failure and does not retry.
- The reviewer is the `subtask-reviewer` agent type in `~/.pi/agent/agents/subtask-reviewer.md`.
  It has only the `read`, `grep`, `find`, and `ls` tools. It loads no extensions, skills, or nested agent tools.
- The router blocks `Agent` calls that start or resume this type. A rate-limited reviewer is not restarted.
- The reviewer runs as a native background agent. Its result arrives like the result of any other agent.

### Delegation batches

A delegation batch is every `Agent` call of one parent run: parallel calls and later calls in the same run.
A resume in a later run starts a new batch. Rate-limit restarts join the batch of the failed agent.
An escalation starts a new batch. A later run without `Agent` calls keeps the batch as the latest one.
The reviewer does not change the latest batch.

The command refuses the batch until these conditions are true:

1. The parent run that started the batch is finished.
2. Every `Agent` call and router restart of the batch has returned.
3. No agent of the batch is queued or running.

### Evidence

Before the first agent of a batch starts, the router takes a baseline snapshot of the workspace.
The workspace is the git work tree of the session directory, or the session directory when it is not in a git repository.
The snapshot includes uncommitted and untracked files. Git-ignored files are not in it.
After the last agent finishes, the router takes a final snapshot.

The router attributes a change to the agents only from their own tool calls:

- `edit`: the exact patch that the edit tool recorded.
- `write`: the written content.
- `apply_patch`: the patch text.

The router replays these operations on the baseline. If the result is the same as the final file, the packet shows the diff from the baseline to the final file.
If the file also has other changes, the packet shows only agent operations and reports incomplete coverage.
Missing baselines and truncated evidence also mean incomplete coverage.
Changes that no agent operation explains are never shown as agent work:

- If no agent ran a tool with untraceable writes, these changes are listed as changes by the parent session or the user.
- If an agent ran such a tool, the changed files are listed as unattributed. Examples of such tools are `bash`, `exec_command`, and `exec`.

The packet starts with one of three coverage states:

- Complete: every change is attributed, and no agent ran a tool with untraceable writes.
- Complete for tracked files only: agents ran such tools, but every change to the snapshot files is accounted for.
  Writes by these tools to ignored files or other directories cannot be detected.
- Incomplete: some changes cannot be attributed. The packet names them, and the review does not cover them.

### Limits and privacy

- Batch artifacts are in `~/.pi/agent/subtask-reviews/<batch>/`, with private file permissions. The router deletes them after 14 days.
- A snapshot stores content only for text files that differ from `HEAD`. Clean tracked files refer to their git blob.
- The snapshot stores only a hash for secret-like files (for example `.env`, keys, `auth.json`), binary files, and files over 512 KiB.
  Agent changes to secret-like files are withheld from the packet, and the coverage is then incomplete.
- The packet removes values that look like API keys, tokens, and private keys.
- Git commands are read-only: `rev-parse`, `ls-files`, `ls-tree`, and `cat-file`. The router never changes the index, refs, or work tree.
- After `/reload`, a finished batch stays reviewable. If an agent had not finished at the reload, its transcript is lost, and the command refuses the batch.
- A delegation from before batch tracking has no baseline, and the command refuses it.
- Agents that another extension starts through the backend RPC are not part of a batch.
- A worktree-isolated agent edits a separate copy. Its operations appear without a baseline diff.

## Inspection

- `/subtask-router`: show every model, its routes, links, history, warnings, and cached Claude quota.
- `/subtask-router prompt`: show the classifier prompt.
- `/subtask-router test <task>`: classify a task without starting an agent. The task has no parent rating, so the scout runs.
- `/subtask-router refresh`: wait for a fresh Claude quota reading.
- `/subtask-router eval [provider/id] [thinking]`: run the routing test set, optionally with another classifier.

Routing decisions enter session metadata, not the system prompt.

## Test set

`eval/cases.json` holds 21 paraphrased tasks from real sessions. Each case lists acceptable models, a thinking range, and models that must not be picked.
Quota is ignored during the eval so results repeat. Detailed results go to a private file in the temporary directory.
Pick the fastest classifier that passes about 90% of the cases.

Result on 2026-09-28:

| Classifier | Pass | Median | p90 |
|---|---|---|---|
| gpt-6-luna, low | 20/21 | 3.7 s | 6.8 s |
| gpt-6-luna, medium | 20/21 | 6.7 s | 22.1 s |
| claude-sonnet-5 | not usable through the bridge | | |

## Tests

The backend is unpinned. This adapter was tested against version 0.19.0.
It uses the backend's internal agent-definition registry, agent records, and child-session guard.
After an upgrade, run the tests and repeat the native lifecycle smoke test.

```sh
bun test ~/.pi/agent/extensions/subtask-router/tests/
```

The tests use a temporary agent directory, temporary git repositories, and a usage-meters stub. They make no network calls.
One test loads the real `subtask-router.json`.
The reviewer uses the `diff` package from `~/.pi/agent/npm/node_modules`. After a package update, run the tests again.

