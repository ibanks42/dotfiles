# Installing these dotfiles (instructions for an agent)

This file tells a coding agent (Claude Code, pi, Codex, and so on) how to set up
these dotfiles on a machine. The repo has no installer script. You, the agent,
do the install by following these steps and adapting them to the machine.

## Rules

1. **Ask before you change anything.** Show the user the list of modules below
   and ask which ones to install. Defaults are marked ✅.
2. **Back up before you replace.** If a target path already exists and is not
   already a link to this repo, move it to
   `~/.backup/dotfiles/<YYYYMMDD-HHMMSS>/<same relative path>` first. Never
   delete user files.
3. **Link, don't copy.** Configs are symlinks into the repo
   (`ln -sfn <repo path> <target>`), so edits land in git. The exceptions are
   fonts (copied) and `~/.zshrc.local` (created, never linked).
4. **Detect the OS and package manager.** Don't assume Arch. Use `pacman`/`paru`,
   `dnf`, `apt` or `brew` as appropriate, and tell the user about any package
   that isn't available (see "Package names" below).
5. **Keep machine-specific settings out of git.** Anything that only makes sense
   on this machine (SDK paths, tools installed only here, secrets, blocks that
   installers append to `~/.zshrc`) goes in `~/.zshrc.local`, not in
   `zsh/.zshrc`.
6. **Finish with a summary**: what you installed, what you linked, what you
   backed up, and any manual steps left for the user.

`$DOTFILES` below means the repo checkout, normally `~/dotfiles`:

```sh
git clone https://github.com/ibanks42/dotfiles.git ~/dotfiles
git -C ~/dotfiles submodule update --init --recursive   # fonts submodule
```

## Modules

### ✅ Core and CLI tools
Packages: git, gh (GitHub CLI), curl, wget, jq, unzip, zip, tar, xz, a C
toolchain (`base-devel` / `build-essential` / `@development-tools`), fzf, eza,
fd, bat, lazygit, zoxide, ripgrep.

Link: `$DOTFILES/.hushlogin` → `~/.hushlogin`

### ✅ Fonts
Copy every font file in `$DOTFILES/fonts` (a git submodule) into
`~/.local/share/fonts/`, then run `fc-cache -f`. Only needed on machines that
draw text (the machine running Ghostty), not on a headless server.

### ✅ zsh (main shell)
Packages: zsh, starship.

| Source | Target |
|---|---|
| `$DOTFILES/zsh/.zshrc` | `~/.zshrc` |
| `$DOTFILES/bash/.customrc` | `~/.customrc` (aliases, starship, zoxide, mise; shared with bash) |
| `$DOTFILES/bash/starship.toml` | `~/.config/starship.toml` |

Then:
- Install antigen (the plugin manager):
  `mkdir -p ~/.zsh && curl -fsSL https://raw.githubusercontent.com/zsh-users/antigen/develop/bin/antigen.zsh -o ~/.zsh/antigen.zsh`.
  Plugins download on the first interactive shell.
- Create `~/.zshrc.local` if it doesn't exist, with a one-line comment header.
  If the old `~/.zshrc` had machine-specific lines (PATHs, SDKs, installer
  blocks), move them into `~/.zshrc.local` and show the user what you moved.
- Ask before running `chsh -s "$(command -v zsh)"`.
- Check: `zsh -ic 'echo ok'` prints `ok` with no errors.

### Bash
Packages: bash. Install ble.sh:
```sh
git clone --recursive --depth 1 --shallow-submodules https://github.com/akinomyoga/ble.sh.git ~/.local/share/blesh-repo
bash ~/.local/share/blesh-repo/make install PREFIX=~/.local
rm -rf ~/.local/share/blesh-repo
```
Link `$DOTFILES/bash/.blerc` → `~/.blerc` and `$DOTFILES/bash/.customrc` →
`~/.customrc`. Add these lines to `~/.bashrc` if missing:
```sh
[[ -f $HOME/.local/share/blesh/ble.sh ]] && source "$HOME/.local/share/blesh/ble.sh"
[[ -f $HOME/.customrc ]] && source "$HOME/.customrc"
```
Note: `.customrc` currently uses zsh-flavoured lines (zoxide/mise init for zsh,
nvm `zsh_completion`). Warn the user if they want it for bash too.

### ✅ Neovim
Packages: neovim (recent; the config is LazyVim). Link `$DOTFILES/nvim` →
`~/.config/nvim`. Back up `~/.local/share/nvim` and `~/.cache/nvim` if they
exist, so plugins install clean.

### ✅ Ghostty
Packages: ghostty. Link `$DOTFILES/ghostty` → `~/.config/ghostty`.
**Only on the machine the user sits at.** Ghostty runs locally; its config on a
remote server does nothing. The config sends Esc as `CSI 27u`
(`keybind = escape=csi:27u`); `zsh/.zshrc` and herdr already handle that.

### ✅ herdr (terminal workspace manager)
Install herdr from https://herdr.dev (see its install page). Link each file
individually, because `~/.config/herdr` also holds live server state and must
stay a real directory:

| Source | Target |
|---|---|
| `$DOTFILES/herdr/config.toml` | `~/.config/herdr/config.toml` |
| `$DOTFILES/herdr/herdr-sessionizer.conf` | `~/.config/herdr/herdr-sessionizer.conf` |
| `$DOTFILES/herdr/herdr-sessionizer` | `~/.local/bin/herdr-sessionizer` |
| `$DOTFILES/herdr/herdr-space-numbers` | `~/.local/bin/herdr-space-numbers` |
| `$DOTFILES/herdr/herdr-space-jumper` | `~/.local/bin/herdr-space-jumper` |
| `$DOTFILES/herdr/herdr-split` | `~/.local/bin/herdr-split` |

Check with `herdr config check`. If a herdr server is running, apply with
`herdr server reload-config`.

### tmux
Packages: tmux. Link `$DOTFILES/tmux` → `~/.config/tmux` and
`~/.config/tmux/tmux-sessionizer` → `~/.local/bin/tmux-sessionizer`.

### ✅ yazi
Packages: yazi. Link `$DOTFILES/yazi` → `~/.config/yazi`. Plugins listed in
`yazi/package.toml` install with `ya pkg install` (`yazi/plugins/` is ignored
by git).

### ✅ mise (language runtimes)
Install with `curl https://mise.run | sh` (puts `mise` in `~/.local/bin`) or the
package manager. Ask which runtimes to install globally; defaults are node, go
and bun. Optional: python, rust, zig, java. For each one:
`mise use --global <name>@latest`.

### Hyprland desktop (off by default; Arch)
Packages: hyprland hyprlock hyprpaper xdg-desktop-portal-hyprland pipewire
wireplumber brightnessctl grim slurp wl-clipboard ydotool wtype pavucontrol
network-manager-applet waybar mako, plus `walker-bin` from the AUR.

Link these `$DOTFILES/hypr/<x>` → `~/.config/<x>`: `hypr`, `waybar`, `walker`,
`mako`, `elephant`, `gtk-3.0`, `gtk-4.0`, and `hypr/kdeglobals` →
`~/.config/kdeglobals`.

Also link:
- `hypr/systemd/user/elephant.service` and `elephant-rbw-watch.service` →
  `~/.config/systemd/user/`
- every file in `hypr/local/bin/` → `~/.local/bin/`
- `hypr/local/share/color-schemes/FlexokiDark.colors` →
  `~/.local/share/color-schemes/`

Then: `systemctl --user daemon-reload`; restart `elephant.service` and
`elephant-rbw-watch.service` if Elephant is installed; after logging in,
`hyprctl reload && pkill -SIGUSR2 waybar`. See `hypr/README.md`.

### Apps (off by default)
- Bitwarden: rbw, bitwarden-cli
- Vivaldi (+ ffmpeg codecs), Steam (on Arch, needs `multilib`), Spotify, Dolphin

### Not linked automatically
`zed/` and `vscode/` (a Modest Dark theme) exist but are not linked on the
current machines. Ask the user before linking them.

## Package names
- Debian/Ubuntu: `fd` is `fd-find` (binary `fdfind`), `bat` is binary `batcat`.
  `.customrc` has `alias fd=fdfind` and `alias bat=batcat` for this; on
  other distros those aliases break `fd`/`bat`, so tell the user.
- eza, lazygit, starship, ghostty, yazi and a recent neovim may be missing or
  old in apt/dnf repos. Use the upstream install method (release binary,
  COPR, cargo, or the project's install script) and say which you used.

## Known quirks
- **mosh** drops cursor-shape codes, so the vi-mode cursor shape (line/block)
  doesn't change over mosh. The prompt ❯ colour shows the mode instead.
- **Esc** is sent as `CSI 27u` by Ghostty. Programs outside herdr that don't
  understand the kitty keyboard protocol may show `[27u` when Esc is pressed.

