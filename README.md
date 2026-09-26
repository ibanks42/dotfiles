# My dotfiles

## Installation

There is no installer script. Ask a coding agent (Claude Code, pi, Codex, ...)
to install them for you:

> Install my dotfiles by following INSTALL.md in https://github.com/ibanks42/dotfiles

[`INSTALL.md`](INSTALL.md) lists every module, what it installs, where each
config is linked, and the rules the agent follows (ask first, back up before
replacing, keep machine-specific settings in `~/.zshrc.local`).

## tmux sessionizer on new machines

The custom `tmux-sessionizer` picker is installed with the tmux config and exposed on your `PATH`.
Once the tmux module is linked, it lives at:

```bash
~/.config/tmux/tmux-sessionizer
```

Notes:
- The default window commands live in `tmux/tmux_sessionizer.conf`.
- Project-specific overrides can live in `.tmux_sessionizer.conf` inside a project directory.
- Press `Ctrl-f` to open the picker. It starts in a vim-like normal mode: `j`/`k` (or `Ctrl-n`/`Ctrl-p`) move, `i` enters insert mode to type a filter, and `Esc` returns to normal mode (pressing `Esc` in normal mode quits).
- Press `Ctrl-e` to create a folder and switch to its new session.
- Type an explicit path such as `~/docker/t3code` to enumerate directories beneath that path; press `Ctrl-o` to confirm opening it. Missing directories require a second confirmation before creation.
- Press `Alt-d` to delete the selected session.
- Press `F2` to toggle Streamer Mode: the list hides everything and you must type the directory you want.
- The create flow can use an existing `TS_SEARCH_PATHS` root or a custom root. Custom roots are appended to `tmux/tmux_sessionizer.conf`, intentionally marking the dotfiles checkout as modified.
