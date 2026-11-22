# GUI sessionizer

Native Herdr dialog replacing the old Bash/fzf sessionizer's orchestration. Source lives here; installed mod: `~/.config/herdr-app/mods/sessionizer/`.

## Use

- Sidebar **+**, **New space** in the custom menus, or **Ctrl+F** in the `unified` layout opens it. Ctrl+F is taken from terminal programs in this layout.
- Fuzzy-search one combined, continuously scrolling project-folder list across all configured machines. Each row has a local/remote machine label; no browse-time machine selector or redundant existing-Space switch entries. Arrow keys keep selection visible; Enter/click selects a folder. Root config order wins, with fuzzy ranking inside each root. Overlapping roots use the first matching root; identical paths on different machines stay separate. Opening an existing Space's folder reuses that Space without rerunning startup programs.
- **Exact path → Review folder** opens an absolute or `~/…` path on its chosen destination machine. Symlinks resolve before duplicate detection. Matching checks both a Space's creation folder and its representative live folder (focused pane of its active tab, then the first pane). The latter is displayed; the original folder still matches after a shell changes directory.
- **New folder** creates an exclusively reserved destination below the chosen parent, then previews startup. **Clone repo** clones into a new destination and previews startup after completion. Neither overwrites an existing folder.
- Startup preview has **Customize tabs…** for one-off Name/Command editing and **Open this layout** to approve it. **Open with defaults** immediately uses the selected machine's configured defaults, ignoring project tab overrides. Initial defaults migrated from your dotfiles: `pi`, `nvim`, shell, shell, named `1`–`4`.
- Space closing remains in the sidebar's right-click menu, with Herdr's confirmation. No redundant Space switch/close entries in the sessionizer list.

Keys: ↑/↓ (or Ctrl+N/P, PgUp/PgDn) select, Enter opens; Enter in the startup review opens the Space. A dialog opened with props `{mode: 'settings' | 'path' | 'new' | 'clone'}` (and `tab: 'roots'`) starts on that screen.

## Configuration

**Settings** has two panes, **Startup tabs** and **Project roots**, saved together (button or **Ctrl+S**; the footer shows unsaved/invalid state, and bad commands are flagged inline). **Project roots** is ONE global ordered list. Every row has its own machine picker, folder path, and a 0–5 depth stepper; reorder by dragging the grip or with ↑/↓. For example: `server ~/dev/work`, `local ~/dev/personal`, `server ~/dev/personal`. Add/remove rows or use ↑/↓ to set their priority **across machines**, not just within one machine. The selector before each path opens machine choices inline. The same path may appear on multiple machines.

Startup tab Name/Command defaults are **global for all machines**. There is no local/server selector above the tab settings. Saving updates the one default layout and the global prioritized path list. Machine selectors exist only on individual path rows. Blank commands start a shell; per-opening tab customization and project-specific previews remain available.

Installed `config.json` remains editable; reinstall preserves it. GUI saves validate first and atomically compare against the loaded file, so stale dialogs cannot overwrite external changes. If a save reports a stale snapshot, close/reopen to reload before editing again. JSON uses `version: 2`, one ordered `roots` array with explicit `machine` (`null` means local), path and depth, and `tabs` with `name` + `argv` array (or `null`). Old per-machine tab defaults are no longer applied; the top-level `tabs` layout is used everywhere. Legacy version-1 local/per-machine root lists are normalized in memory without losing paths; the next GUI save writes version 2. Example:

```json
{"version":2,"roots":[{"machine":"server","path":"~/dev/work","depth":1},{"machine":null,"path":"~/dev/personal","depth":1},{"machine":"server","path":"~/dev/personal","depth":1}],"tabs":[{"name":"agent","argv":["pi"]},{"name":"shell","argv":null}],"machines":{}}
```

In a project, `.herdr-sessionizer.json` may override only the tabs:

```json
{"version":1,"tabs":[{"name":"agent","argv":["pi"]},{"name":"editor","argv":["nvim"]},{"name":"shell","argv":null}]}
```

Project settings are shown in the preview before execution. Bash configs are **not sourced**: legacy `.tmux_sessionizer.conf` produces a conversion warning. There is no `eval`, shell-string interpolation, or arbitrary per-project code during discovery. For an intentional shell command, put the shell and arguments explicitly in an argv array and review it before launch.

## Robustness / limits

- Machine-scoped canonical directory matching; bounded directory scan (4,000 directories / 3 seconds, depth ≤5), `.git` excluded, no directory-symlink traversal. Scan limits and read errors are visible; nonexistent optional roots are silently skipped; exact-path opening remains available. Slow filesystem syscalls can exceed the scan budget.
- Parallel per-machine discovery publishes partial results independently; an unavailable remote doesn't hide local results. UI generation guards discard stale refresh replies. Busy guards prevent double submission. No browsing starts programs or creates directories.
- Filesystem work runs through `exec(..., {on: machine})`, with Python 3 required **on each selected machine**. The first of `python3`, `python`, `py -3` that answers is remembered per machine (Windows usually has no real `python3`). Startup programs use Herdr's normal interactive shell environment. A successful launch reply confirms creation, not successful program initialization; Herdr still reports immediate process failures.
- Herdr lifecycle requests use structured CLI arguments and returned IDs. A persisted shared journal is written before each mutation. Partial/uncertain replies stop setup, preserving known Space/tab IDs for inspection. There is no automatic retry or destructive rollback. Dismissing recovery never removes resources. The guard coordinates copies in this app and is rechecked after asynchronous preflight; it is not a cross-client distributed lock.
- Clone jobs run independently, with a 30-minute Git timeout and prompts disabled (`GIT_TERMINAL_PROMPT=0`). Git/SSH authentication must already work; SSH agents/credential helpers are supported. Failed clones retain their directory and `~/.cache/herdr-sessionizer/jobs/<id>/git.log` **on the selected machine**. No automatic deletion. If the machine reboots mid-clone, its record may remain running; inspect its directory/process before using the two-step **Stop tracking** action. Stop tracking does not cancel Git, and these jobs have no cancellation button yet.
- Clone status survives closing/reopening the dialog in the same app configuration via shared `sessionizer.clone`. Interrupted launch recovery is shared `sessionizer.operation`. An unacknowledged clone-start is uncertain: don't retry until its destination has been inspected.
- The legacy script's live sibling-path completion, clone-URL autofill and arbitrary shell-config sourcing are intentionally not copied. Windows hosts work too: `~\…` expands, `C:\Users\<user>` displays as `~`, NTFS junctions are not traversed (like symlinks), and clones run detached in a hidden console. Clone logs live in `%USERPROFILE%\.cache\herdr-sessionizer\jobs\<id>\`.

## Install / test

```sh
python3 install.py   # Windows: py -3 install.py (install.sh is a Unix shim for it)
node --test model.test.mjs ui.test.mjs
python3 -m unittest -v test_filesystem.py
herdr-app check ~/.config/herdr-app/mods/sessionizer
herdr-app do mod.open --name sessionizer
```

`install.py` copies the mod only (into `$HERDR_APP_HOME` or `~/.config/herdr-app`); existing custom sidebar/menu entry points are wired separately. It never edits the generated app guide, types, shipped mods, or legacy script. On a fresh setup, use the last command above or bind `mod.open:sessionizer`.

Tests cover matching/config policy, duplicate suppression, machine routing, stale replies, root priority/overlap, native-list navigation, missing-root notice suppression, busy guards, launch journaling and partial failures, bounded traversal, no-overwrite/path traversal rules, safe project config, and real local Git success/failure in temporary directories. Live local and `server` discovery and GUI rendering were verified. Launch actions are tested with command adapters, not by starting extra agents in your real workspaces.
