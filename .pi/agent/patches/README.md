# Automatic Pi patches

The `pi` launcher runs the real Pi command. After a successful extension update, it applies the patches in `manifest.json`.
Normal sessions pass directly to Pi. The launcher does not change prompts, models, or credentials.

## Use

Use the normal update commands:

```sh
pi update --extensions
pi update --all
pi update npm:pi-claude-bridge
```

Restart running Pi sessions after an update. Their imported extension code does not change on disk updates.
The launcher leaves self-only updates, model updates, help, and other commands unchanged.

For a separate patch check or repair:

```sh
python3 ~/.pi/agent/patches/runner.py check
python3 ~/.pi/agent/patches/runner.py apply
```

## Installation

The launcher link is `~/.local/share/pi-launcher/bin/pi`.
The shell places that directory before the real Pi installation on `PATH`.
The real executable remains at `~/.bun/bin/pi` on this machine. Pi updates can replace it without replacing the launcher.
The launcher requires Python 3 and Git. The current regression checks also require Node.js with TypeScript stripping support.

To install the link on another machine:

```sh
mkdir -p ~/.local/share/pi-launcher/bin
ln -s ~/.pi/agent/patches/pi ~/.local/share/pi-launcher/bin/pi
export PATH="$HOME/.local/share/pi-launcher/bin:$PATH"
```

Add the export after other Pi-related path changes in your shell startup files.
Open a new shell, or run the export in your existing shell.
Use `command -v pi` to check which launcher the shell selects.

The launcher finds the next executable named `pi` on `PATH`, excluding itself.
`PI_REAL_BIN` can select an explicit executable. It must not point back to the launcher.
Calling the real executable directly bypasses automatic patches.

## Active customization

### Pi 0.99 extension compatibility

Four manifest patches move host-provided packages from dependencies to peers:

- `@juicesharp/rpiv-ask-user-question`: `typebox`.
- `pi-opencode-direct` and `pi-multi-account`: `@earendil-works/pi-ai`.
- `@tintinweb/pi-subagents`: `typebox` and `@sinclair/typebox`.

These patches remove Pi's manifest warnings. They do not delete existing runtime packages or change the declared host-version ranges.

A separate `pi-multi-account` patch repairs OAuth initialization after a failed native import leaves provider modules partially loaded.
The extension factory awaits asynchronous imports before it registers providers. Login and refresh callbacks remain unchanged.
The checks cover the original module-load failure, optional providers, cached results, and genuine OAuth-load failures.
The checks use isolated account stores and never perform a login or token refresh.

The tested combination is Pi 0.99.0, `pi-multi-account` 1.23.2, and its local `pi-ai` 0.87.1.
The extension still declares a host range below 0.88.0. These checks do not establish full compatibility with every Pi 0.99 feature.

### Claude bridge

The bridge uses the upstream `npm:pi-claude-bridge` package, not a local fork.
One combined diff preserves changes that share `src/index.ts`:

- Object-only root union schemas work with the Claude MCP tool server, including the notebook tool.
- Optional cache tracing records bounded metadata, not prompts or credentials. Its existing runtime control file still applies.
- The catalog supplies Sonnet 5.5 only when the host catalog lacks it. Authoritative catalog entries win.
- Sonnet 5.5 retains the upstream 1M-context policy from the former fork.

The diff is based on the npm 0.9.0 release. Exact context and regression checks decide whether a newer release is compatible.
The catalog fallback copies provisional registration metadata from Sonnet 5. It does not copy pricing.
The checks require Agent SDK 0.3.284 or newer and its native Claude executable on this Linux host.

Pi Web Access 0.32.0 includes the old dynamic-tool fix. Its obsolete repair is not registered.
The old Claude Code provider is inactive. Its repair is not registered.
The former fork and repair directories remain in a private migration backup under `agent/backups/`, outside extension discovery.

## Safety and limits

The manifest names each package, diff, affected file, and regression command.
Checks execute trusted local code. Review new checks and diffs before registering them.
The runner handles the global npm packages under the selected Pi agent directory. It does not patch project-local installations.
`PI_CODING_AGENT_DIR` selects another agent directory. `--agent-dir` and `--manifest` support isolated tests.

The runner skips an already-applied patch only after its check passes.
If the check passes without the patch, the runner reports that upstream supplies the behavior.
If exact patch context no longer matches, the runner stops. It does not guess a replacement.
If a patch or check fails, the runner restores files changed during that patch invocation and returns an error.
It does not undo the preceding package update. Review the failure before restarting Pi with those packages.

A lock prevents concurrent launcher updates and patch runs for the same agent directory.
If the real Pi update fails, the launcher preserves its exit status and does not apply patches.
An absent registered package is reported and skipped.
Some checks assert the existing integration structure as well as behavior. Upstream refactoring can require a check update.

## Offline tests

```sh
python3 -m unittest discover -s agent/patches -p "test_*.py"
python3 agent/patches/runner.py check
PI_PATCH_PACKAGE_ROOT="$PWD/agent/npm/node_modules/pi-web-access" \
  node --test agent/patches/checks/web-access.test.mjs
```

The package checks use local fixtures and fake transports. They make no model requests.
