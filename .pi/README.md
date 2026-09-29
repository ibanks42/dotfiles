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
The active Claude bridge comes from `npm:pi-claude-bridge`. No local fork loads as an extension.
The shared patch runner preserves its Sonnet 5.5 support, metadata-only cache tracing, and support for notebook tool schemas.
See `agent/patches/README.md` for launcher installation, checks, and failure handling.

Before you start Pi on a new machine:

1. If you will replace an existing installation, review its local patches first.
2. Create the private session directory with `install -d -m 700 ~/.pi/agent/sessions`.
3. Link `~/dotfiles/bin/bun-as-npm` to `~/.local/bin/bun-as-npm` and install Bun.
4. Make sure that `~/.local/bin` is on `PATH`. The `npmCommand` setting uses this wrapper.
5. Install the launcher described in `agent/patches/README.md`.
6. Install the packages declared in `agent/settings.json` with `pi update --extensions`.
7. Resolve any reported patch failure before starting Pi.
8. Configure credentials locally with `/login` or provider environment variables.

The wrapper translates npm's `--prefix` to Bun's `--cwd`. Without this translation, Bun installs packages in `agent/` instead of `agent/npm/`.
Run `sh bin/test-bun-as-npm.sh` from the dotfiles repo to check the wrapper without a network request.

The router tests resolve dependencies relative to this directory, not a fixed home directory.

## Automatic patches

The normal `pi` command runs a launcher ahead of the real executable on `PATH`.
After a successful extension update, it applies registered diffs and runs their offline regression checks.
The launcher also handles `pi update --all` and individual package updates.
Other commands pass directly to Pi.

Use these commands from `~/.pi`:

```sh
pi update --extensions
python3 agent/patches/runner.py check
```

If a patch conflicts or its check fails, the launcher returns an error and restores files changed by that patch run.
It does not undo the package update. Review the failure rather than bypassing the checks.
Restart running Pi sessions after successful updates.
The old repair scripts and bridge fork remain in a private migration backup under `agent/backups/`.
Pi Web Access includes its former fix upstream. The inactive Claude Code provider no longer needs an automatic repair.

Pi uses its built-in `cacheWarming` setting.
This setting warms only eligible providers; it does not guarantee warming for Codex or the Claude bridge.
The retired warm-cache extension and its repair inputs are not required.

## Files kept locally

- `agent/auth.json`, model files, and account files supply live authentication and model state.
- `agent/sessions/` contains conversation history, not disposable configuration.
- `agent/cache/` contains the native code-mode executable used by Codex Conversion.
- `agent/npm/` contains the installed packages and their dependency records.
- `agent/cache-forensics/` contains retained diagnostic tools and private capture controls.

The metadata-only cache diagnostic replaces the historical single-session prefix observer.
Use `/cache-diagnostics on|off|status|report` to inspect cache behavior across observed providers and sessions.
Its persistent HMAC key, fingerprints, and logs stay local under `agent/cache-diagnostics/`.
This does not enable the separate raw `/forensics` capture. See `agent/extensions/cache-diagnostics/README.md` for coverage limits.
The Herdr extension is active in this environment. The usage extension supplies `/usage`.
Session directories use mode `0700`, and existing session files use mode `0600` on this machine.
Git does not preserve these runtime permissions. The private session directory also protects newly created session files.

The unused notebook-mode download and empty notebook records are removed.
Notebook mode downloads its Deno executable again when required.
