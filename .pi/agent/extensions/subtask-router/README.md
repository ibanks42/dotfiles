# Native subagent routing

Tintinweb's `pi-subagents` owns agent execution, sessions, UI, and controls.
This extension selects the model and reasoning level before each new `Agent` tool call.
The old `subtask` tool and subprocess runner are removed.

## Controls

- `Agent`: start an agent. Background mode returns an ID immediately.
- `get_subagent_result`: get status or output. Use `verbose: true` for the conversation, or `wait: true` to wait.
- `steer_subagent`: redirect a running agent or request a progress report.
- `stop_subagent`: stop a running or queued agent. This wrapper requires an exact agent ID.
- `Agent(resume: id, prompt: ...)`: continue an existing agent session without a new routing decision.
- `/agents`: open the native manager and its live conversation viewer.

Steering takes effect after the current tool execution. Stopping does not undo edits.
Foreground calls show activity inline. Background calls show activity in the native widget and fleet view.
Visual layout depends on the active Pi theme and TUI extensions.

## Routing

| Tier | Preference order |
|---|---|
| menial | GLM Flash, free Muse Spark |
| low | Luna, Sonnet |
| mid | Opus, Sol |
| high | Fable, Astra |

Luna selects the tier and reasoning effort independently.
Read-only inventories and reference audits normally use `low`, even across many folders.
Reasoning can be `medium` for an evidence-heavy audit without changing its model tier.
Pi clamps the requested effort to the selected model's supported levels.

Explicit model or thinking arguments override that part of the decision.
A model override alone still gets a reasoning decision.
Custom agent frontmatter takes precedence over tool arguments, as required by the backend.
All selected models must be authenticated and in the active Pi scope.

The `Explore.md` definition has no model or reasoning pin.

## Configuration

- `~/.pi/agent/subtask-router.json`: model preferences, quota threshold, classifier settings, and output limit.
- `~/.pi/agent/subagents.json`: concurrency, nesting, native UI, and backend settings.
- `policy.ts`: the classifier prompt.

The quota threshold remains 95%. The text limit remains 400,000 characters for `Agent` and `get_subagent_result` tool results.
Long tool output goes to a private temporary file. Native completion notifications use the backend's own output behavior.
The former `maxParallel` and `maxDepth` values moved to backend settings as `maxConcurrent: 4` and `maxSubagentDepth: 1`.
The router does not use these old keys. If `subtask-router.json` contains them, the router ignores them.

Claude quota checks refresh in the background and never block agent dispatch.
Unknown quota permits an attempt. A rate-limit failure blocks that provider for subsequent routed calls until the reset or cooldown.
The router does not silently restart failed native agents because they can already have changed files.

Workflows, schedules, and new-agent mentions are disabled because those spawn paths bypass the `Agent` routing hook.
Use the native tools or `/agents` viewer controls instead.
Nesting is disabled. Each child does not receive the parent's stop tool or router hooks.

## Inspection

- `/subtask-router`: show model candidates and cached quota without waiting for the quota command.
- `/subtask-router prompt`: show the exact classifier prompt.
- `/subtask-router test <task>`: classify a task without starting an agent.
- `/subtask-router refresh`: explicitly wait for a fresh Claude quota reading.

Routing decisions enter session metadata, not the system prompt.
The backend is unpinned. This adapter was tested against version 0.19.0.
It uses the backend's internal agent-definition registry and child-session guard.
After an upgrade, run the tests and repeat the native lifecycle smoke test.

```sh
bun test ~/.pi/agent/extensions/subtask-router/tests/router.test.ts
```

The tests use this machine's Pi installation for the reasoning-level helper.
