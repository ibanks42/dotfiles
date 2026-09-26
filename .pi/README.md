# Pi configuration

This directory supplies the user configuration through the `~/.pi` symlink.
The `agent/settings.json` file declares packages and preferences.
There is no nested `.pi/` configuration. Work inside `~/.pi` uses the global preferences.

## Public files and private data

The `.gitignore` file uses an explicit allowlist.
New files remain ignored until you add an exception.
The allowlist includes preferences, agent definitions, extension source, diagnostic tools, and selected repair tools.

Credentials, model stores, sessions, tasks, memory, caches, captures, logs, and installed dependencies remain local.
The diagnostic tools remain available, but their captured content can contain credentials and complete conversations.
Capture is off by default, including when its private state file is missing or invalid.
The `/forensics on` command explicitly enables capture.
An allowed source file can still contain a secret after an edit.

Before you publish changes:

1. Review new allowlist entries for secrets and private data.
2. Run `git status --short --untracked-files=all .pi`.
3. Run `git ls-files -ci --exclude-standard .pi` to find tracked files that match ignore rules.
4. Review the staged diff locally before you commit.

Git ignores do not protect files that are already tracked.
Never use `git add -f` for credentials or runtime data.

## Machine setup

Extension declarations have no version pins. Pi can update them to newer releases.
The default Claude provider uses `npm:pi-claude-code-provider`.
Local repairs remain specific to their reviewed package versions and hashes.

Before you start Pi on a new machine:

1. If you will replace an existing installation, review its local patches first.
2. Create the private session directory with `install -d -m 700 ~/.pi/agent/sessions`.
3. Install the packages declared in `agent/settings.json` with `pi update --extensions`.
4. Check whether the local patches still apply to the installed versions.
5. Configure credentials locally with `/login` or provider environment variables.

The router tests resolve dependencies relative to this directory, not a fixed home directory.
The Claude recovery procedure checks the exact package version and source hashes before any write.
See `agent/local-patches/claude-tool-schema-filter/README.md` for recovery tests and prerequisites.

## Repair tools

The web-access repair retains its source fixture and reviewed payload.
The Claude repair retains a patch and a manifest of reviewed source hashes.
These files are test and repair inputs, not disposable backups.
Both repairs refuse unreviewed package versions or hashes.
These safety checks do not pin extensions or prevent Pi from updating them.
If a new release fails a repair check, review or retire the patch instead of bypassing its checks.

With Pi sessions stopped, run these commands from `~/.pi`:

```sh
python3 agent/local-patches/post-update-cache-repair/repair.py apply
python3 agent/local-patches/claude-tool-schema-filter/repair.py apply
```

To inspect an installation without changes, replace `apply` with `check`.
The existing `pi-update-with-cache-fixes` launcher restores only the web-access patch.
An extension update can succeed while the launcher's subsequent repair refuses the new version.
After package updates, run the Claude repair separately.
See each repair README for refusal conditions and recovery limits.

Pi uses its built-in `cacheWarming` setting.
The retired warm-cache extension and its repair inputs are not required.

## Files kept locally

- `agent/auth.json`, model files, and account files supply live authentication and model state.
- `agent/sessions/` contains conversation history, not disposable configuration.
- `agent/cache/` contains the native code-mode executable used by Codex Conversion.
- `agent/npm/` contains the installed packages and their dependency records.
- `agent/cache-forensics/` contains retained diagnostic tools and private capture controls.

The prefix diagnostic targets one historical session. It remains because you explicitly chose to keep both diagnostic tools.
The Herdr extension is active in this environment. The usage extension supplies `/usage`.
Session directories use mode `0700`, and existing session files use mode `0600` on this machine.
Git does not preserve these runtime permissions. The private session directory also protects newly created session files.

The unused notebook-mode download and empty notebook records are removed.
Notebook mode downloads its Deno executable again when required.
