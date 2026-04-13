# My dotfiles

## Installation

This repo is now built around Arch and Arch-based systems.
The installer is fully interactive and is meant to feel more like a guided workstation setup than a pile of flags.
Anything it replaces gets backed up into `~/.backup/dotfiles/`.

### Prerequisites

On a fresh Arch machine, start with:

```bash
sudo pacman -S --noconfirm --needed curl git
```

### Launch the installer

Recommended:

```bash
bash -c "$(curl -fsSL https://raw.githubusercontent.com/ibanks42/dotfiles/main/install.sh)"
```

Or with `wget`:

```bash
bash -c "$(wget -qO- https://raw.githubusercontent.com/ibanks42/dotfiles/main/install.sh)"
```

If you already cloned the repo locally:

```bash
./install.sh
```

### What the installer does

The new flow is interactive all the way through:

- uses the current repo, updates an existing checkout, or clones `~/dotfiles`
- starts from a preset: full workstation, terminal/editor, Hypr desktop, minimal, or custom
- lets you fine tune modules before anything changes
- installs packages with `pacman` and, if needed, offers to install `paru` for AUR packages
- links configs with backups instead of smashing your existing setup
- shows a final summary with any manual follow-up steps

### Available modules

- `Base tooling` - git, github-cli, jq, curl, wget, tar, unzip, and `.hushlogin`
- `CLI extras` - fzf, eza, fd, bat, lazygit, zoxide, ripgrep
- `Fonts` - repo fonts into `~/.local/share/fonts`
- `Neovim` - install Neovim and link `nvim/`
- `tmux` - install tmux, link config, and expose `tmux-sessionizer`
- `Ghostty` - install Ghostty and link `ghostty/`
- `Hypr desktop` - install and link the Hyprland setup in `hypr/`
- `Daily apps` - Vivaldi, Steam, Spotify, and Dolphin
- `Bash` - install bash, ble.sh, starship, and link `bash/` configs
- `IdeaVim` - link `idea/.ideavimrc`
- `Mise runtimes` - install mise and walk through runtime choices

### tmux sessionizer on new machines

The custom `tmux-sessionizer` picker is installed with the tmux config and exposed on your `PATH`.
Once the `tmux` module is installed, it lives at:

```bash
~/.config/tmux/tmux-sessionizer
```

Notes:
- The default window commands live in `tmux/tmux_sessionizer.conf`.
- Project-specific overrides can live in `.tmux_sessionizer.conf` inside a project directory.
