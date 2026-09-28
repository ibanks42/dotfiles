# Claude bridge cache trace

This patch adds local diagnostics to the installed `pi-claude-bridge@0.9.0` baseline. It does not change session synchronization or cache behavior.

**Status: installed locally and enabled. Restart Pi to load the trace.** No model requests ran. No real prompts, session records, or credentials exist in these assets.

## Scope

The repair tool changes only these package files:

- `src/index.ts`: one import and observational calls.
- `src/cache-trace.ts`: a new diagnostic module.

The patch does not change `SessionState`, cursors, return values, rebuild decisions, extension commands, or event registration. Existing debug and capture code remains unchanged.

`pristine/` contains the exact installed baseline, not an assertion about the original npm release. Existing local changes remain part of that baseline.

The working copy is `/tmp/bridge-trace-7v3pxbbr/pi-claude-bridge`. It excludes nested dependencies. Its dependency symlink points to the installed dependency directory.

## Requirements

- Linux with `/proc/self/fd` and Python 3.11 or later.
- The exact package version and hashes in `manifest.json`.
- Node.js 22.18 or later for offline tests. The tests ran with Node.js 26.10.0.
- No concurrent package updates during repair.

The sink uses directory descriptors to keep file operations inside the selected directories. Other platforms fail closed and produce no trace.

The agent root can be a symlink, as in this installation. The control file, trace directory, lock, and log files cannot be symlinks.

## Review and installation

1. Review `bridge.patch`, `payload/src/cache-trace.ts`, and `repair.py`.
2. Run the offline tests:

   ```sh
   node --test offline.test.mjs
   python3 test_repair.py
   ```

3. Check the installed state:

   ```sh
   python3 repair.py check
   ```

4. Stop Pi before installation.
5. Apply the reviewed patch:

   ```sh
   python3 repair.py apply
   ```

6. Restart Pi to load the new module.

The default package path is `~/.pi/agent/npm/node_modules/pi-claude-bridge`. `--package PATH` selects a temporary package for offline checks.

The repair tool checks all target hashes before any package write. It also checks the manifest hash and every patch payload hash.

Each replacement uses an atomic rename. On an ordinary write error, the tool restores completed replacements. It refuses unknown files, mixed states, and newer edits.

Multi-file replacement is not crash-atomic. If the process dies between replacements, the next command refuses the mixed state. Keep the pristine assets for manual recovery.

## Local control

The trace is off unless this regular file contains `{"enabled":true}`:

```text
~/.pi/agent/claude-bridge-cache-trace.json
```

`PI_CODING_AGENT_DIR` selects another agent root. The repair tool never creates or edits the control file.

**The parent has reviewed the patch and enabled metadata tracing with fingerprints.** Keep the control file private, preferably mode `0600`.

Optional prefix fingerprints require a second explicit field:

```json
{"enabled":true,"fingerprints":true}
```

Without `fingerprints`, the trace does not hash prompt or tool definitions. Model-change comparison still uses an internal HMAC.

To disable the trace, set `enabled` to `false` or remove the control file. Each observation reads the control file again. No reload is necessary.

A disabled trace creates no directory or log file. Disablement clears diagnostic state. A subsequent enablement starts new correlation identifiers and unknown idle durations.

## Records

Records contain only fixed fields and validated metadata. They do not contain messages, tool names, arguments, results, prompts, paths, credentials, errors, SDK events, or raw session identifiers.

The module constructs records from allowlists. It does not redact serialized bridge objects.

| Event | Meaning |
| --- | --- |
| `start` | Fresh provider query setup, message/tool counts, prior-query idle duration, and prefix comparisons. |
| `sync` | The selected sync branch, pre-reset flags, history/prior/cursor/missed counts, and prior CC-session fingerprint. |
| `rewrite` | Normalized compaction, tree navigation, or unknown history rewrite. No dynamic event text. |
| `mark` | Missed steering or a discarded query after a history rewrite. |
| `continuation` | Tool-result delivery for an existing query. It does not restart the query timer. |
| `selected` | The effective effort argument, or `unspecified`. |
| `usage` | One `updateUsage` observation, explicitly labeled `snapshot_partial` and `aggregation: none`. |
| `finish` | SDK consumption ended with `completed`, `aborted`, `error`, or `abandoned`. |

`sync.branch` distinguishes exact reuse, trailing-assistant reuse, shorter-context clean start, no-priors clean start, first import, preserved-ID rebuild, and rotated-ID rebuild.

A rebuild record describes the selected branch before session IO. It does not prove that the subsequent session write succeeded.

`start.idleMs` measures time from the previous observed query completion to fresh query setup for the same Pi session. Tool boundaries never update completion time.

Idle duration is `null` without a prior observed completion. Aborted, failed, and abandoned queries count as terminal queries. Their finish reason remains explicit.

Usage values are partial snapshots, not increments. Repeated snapshots are not added. Missing and invalid numeric fields become `null`, not zero.

All three existing `updateUsage` callers use the same observation hook. The consumer binds each output object to its source SDK query before dispatch.

Late completion callbacks use the SDK query identity, not the current mutable query context. Parent and child sessions have separate diagnostic state.

Identifiers use a random, memory-only HMAC key. Correlation does not survive a process restart, module reload, disablement, or diagnostic-state reset. There is no key file.

Optional hashes cover the projected system-prompt append and ordered MCP tool definitions. They do not cover the hidden Claude Code preset or its complete wire prefix.

Model names appear only from a fixed allowlist. Unknown model names never appear in records. Model changes use internal HMAC comparisons without exposing unknown names.

`effort` in `start` means requested reasoning. `selected.effort` means the effective SDK argument. `unspecified` does not assert a Claude Code default.

The provider field is always `claude-bridge`. This patch cannot observe another provider's calls. It does not infer provider changes from unrelated history.

## Storage and failure behavior

Logs use this directory under the selected agent root:

```text
claude-bridge-cache-trace/
  trace.jsonl
  trace.1.jsonl
  trace.2.jsonl
```

The directory has mode `0700`. The sink enforces mode `0600` for log files. Three files limit retained output to approximately 768 KiB.

An exclusive directory lock serializes rotation across processes. A busy lock drops the observation without a retry. A process crash can leave a stale `.lock` directory.

If a stale lock exists, stop all traced processes before you remove it. Do not remove a lock from an active writer.

Storage errors never escape to the provider. They can drop observations and clear diagnostic state. Session metadata has a 1,024-entry limit.

The sink performs synchronous local IO and optional hashing. It adds diagnostic overhead, not a zero-cost guarantee. No background work, network calls, or cache warming occur.

## Restoration

1. Disable the trace through the control file.
2. Stop Pi.
3. Restore the exact baseline:

   ```sh
   python3 repair.py restore
   ```

4. Restart Pi.

Restore accepts only the complete reviewed patched state, or the unchanged baseline. It never overwrites newer user edits. It leaves the control file and private logs untouched.

## Offline evidence and limits

The JavaScript tests extract actual functions from the patched and baseline source. Fake session IO replaces `cc-session-io`; no SDK or provider connection occurs.

The tests compare stock and patched sync return values, session mutations, and fake IO. They exercise compaction, tree navigation, steering, discard, and usage hooks.

Other tests cover query identity, sibling isolation, idle duration, repeated snapshots, privacy sentinels, disablement, symlink refusal, sink failure, permissions, and rotation.

A source comparison proves that removal of observational lines restores the exact baseline `index.ts`.

The Python tests cover version/hash refusal, payload corruption, installation/restoration, partial states, symlinks, newer edits, and rollback after an injected write failure.

Lifecycle tests also extract the actual provider entry function. A deferred fake consumer exercises its completion, abort, error, and abandoned-query callbacks.

The tests do not run the real SDK or complete extension integration. Real cache behavior remains unverified.

Isolated summaries with `cacheRetention: "none"` leave the provider before trace setup. Their usage and idle durations are excluded. AskClaude does not receive full lifecycle instrumentation.

A setup exception before SDK creation can leave a `start` without `finish`. Enablement during an existing query does not reconstruct its start or usage attribution.

`finish` observes SDK-consumer completion before bridge finalization. A later finalization error does not create a second finish record.

Existing stock diagnostic paths remain outside this patch's privacy guarantees. This patch does not enable `CLAUDE_BRIDGE_DEBUG` or `CLAUDE_BRIDGE_RECORD_STREAM`.

The repository currently ignores this asset directory through `.pi/.gitignore`. No ignore rules, staging entries, or commits changed.

After restart, complete one normal Claude bridge exchange, wait 6-8 minutes, and send a short follow-up in the same session. Avoid model switches, compaction, steering, or aborts in this first trial. The first exchange establishes a baseline; the second records idle duration and cache behavior.
