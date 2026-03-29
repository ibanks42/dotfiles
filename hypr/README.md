# Hyprland Setup

This folder contains the current Hyprland desktop setup from `~/.config` and a few supporting files from `~/.local`.

On Arch-based systems, the root `install.sh` can set this up for you through the `Hypr desktop` module.

Included pieces:

- `hypr/` - Hyprland config
- `waybar/` - Waybar config
- `walker/` - Walker config and theme
- `mako/` - notification config
- `elephant/` - Elephant provider config for Walker
- `gtk-3.0/` and `gtk-4.0/` - GTK theme overrides
- `kdeglobals` - KDE/Qt config
- `local/bin/` - helper scripts used by Hyprland
- `local/share/color-schemes/FlexokiDark.colors` - KDE Flexoki color scheme
- `systemd/user/elephant.service` - user service unit for Elephant

Prerequisites:

- `hyprland`, `hyprlock`, `hyprpaper`, `hyprctl`
- `waybar`, `walker`, `mako`
- `ghostty`, `dolphin`, `vivaldi`
- `wl-clipboard`, `wtype`, `ydotool`, `brightnessctl`, `wpctl`, `grim`, `slurp`
- `rbw`, `bw`
- `kwallet`, `kwallet-query`, `qdbus6` if you want `rbw` to auto-unlock from the login keyring
- KDE bits used by this setup: `ksecretd`, `plasma-apply-colorscheme`, `plasma-apply-lookandfeel`

Current workflow highlights:

- `SUPER+1/2/3` focuses monitor 1/2/3; repeating the key cycles windows on that monitor's current workspace
- `SUPER+SHIFT+1/2/3` moves the active window to monitor 1/2/3
- `SUPER+H` / `SUPER+L` cycles workspaces on the focused monitor without blindly creating extra empty workspaces
- `SUPER+SHIFT+H` / `SUPER+SHIFT+L` moves the active window to the previous/next workspace on the current monitor
- `SUPER+TAB` jumps to the previous workspace on the focused monitor
- `SUPER+GRAVE` toggles between the current and last focused window
- `SUPER+S` toggles the scratchpad and lazily launches `steam` and `spotify-launcher` if they are not already running
- `SUPER+ALT+S` sends the active window to the scratchpad
- Waybar uses `hyprland/workspace-taskbar`, so each workspace button shows window icons and clicking an icon focuses that window

Important note about Walker Bitwarden support:

- This setup expects a locally built Elephant binary at `~/.local/lib/elephant/bin/elephant`
- It also expects provider plugins at `~/.local/lib/elephant/providers-walker`
- The Bitwarden provider patch used on this machine is included as `elephant-bitwarden-rbw.patch`

Suggested setup on a new machine:

```bash
mkdir -p ~/.config ~/.local/bin ~/.local/share/color-schemes ~/.config/systemd/user

ln -sfn ~/dotfiles/hypr/hypr ~/.config/hypr
ln -sfn ~/dotfiles/hypr/waybar ~/.config/waybar
ln -sfn ~/dotfiles/hypr/walker ~/.config/walker
ln -sfn ~/dotfiles/hypr/mako ~/.config/mako
ln -sfn ~/dotfiles/hypr/elephant ~/.config/elephant
ln -sfn ~/dotfiles/hypr/gtk-3.0 ~/.config/gtk-3.0
ln -sfn ~/dotfiles/hypr/gtk-4.0 ~/.config/gtk-4.0
ln -sfn ~/dotfiles/hypr/systemd/user/elephant.service ~/.config/systemd/user/elephant.service

ln -sfn ~/dotfiles/hypr/local/bin/hyprctl-current ~/.local/bin/hyprctl-current
ln -sfn ~/dotfiles/hypr/local/bin/hypr-workspacectl ~/.local/bin/hypr-workspacectl
ln -sfn ~/dotfiles/hypr/local/bin/elephant-launch ~/.local/bin/elephant-launch
ln -sfn ~/dotfiles/hypr/local/bin/elephant-rbw-watch ~/.local/bin/elephant-rbw-watch
ln -sfn ~/dotfiles/hypr/local/bin/rbw-unlock-elephant ~/.local/bin/rbw-unlock-elephant
ln -sfn ~/dotfiles/hypr/local/bin/rbw-pinentry-keyring ~/.local/bin/rbw-pinentry-keyring
ln -sfn ~/dotfiles/hypr/local/bin/rbw-store-keyring-password ~/.local/bin/rbw-store-keyring-password
ln -sfn ~/dotfiles/hypr/local/share/color-schemes/FlexokiDark.colors ~/.local/share/color-schemes/FlexokiDark.colors
ln -sfn ~/dotfiles/hypr/kdeglobals ~/.config/kdeglobals
```

To auto-unlock `rbw` from the login keyring instead of typing the master password after every login:

```bash
rbw config set pinentry ~/.local/bin/rbw-pinentry-keyring
~/.local/bin/rbw-store-keyring-password
```

The helper stores the password in KWallet folder `rbw` under an entry named `rbw:<profile>:<email>`. It discovers the current `rbw` account email from `~/.config/rbw/config.json`, and uses the default profile name `default` unless `RBW_PROFILE` is set.

Then reload the session pieces:

```bash
systemctl --user daemon-reload
systemctl --user restart elephant.service
systemctl --user restart elephant-rbw-watch.service
pkill -x walker || true
walker --gapplication-service &
pkill mako || true
mako &
hyprctl reload
pkill -SIGUSR2 waybar
```

Rebuild the local Elephant setup if you want Walker Bitwarden support to match this machine:

```bash
git clone https://github.com/abenz1267/elephant.git ~/.local/src/elephant
cd ~/.local/src/elephant
git checkout v2.20.2
git apply ~/dotfiles/hypr/elephant-bitwarden-rbw.patch

mkdir -p ~/.local/lib/elephant/bin ~/.local/lib/elephant/providers ~/.local/lib/elephant/providers-walker
go build -buildvcs=false -trimpath -o ~/.local/lib/elephant/bin/elephant ./cmd/elephant

for p in desktopapplications websearch providerlist calc files symbols unicode bitwarden menus; do
  go build -buildvcs=false -buildmode=plugin -trimpath -o ~/.local/lib/elephant/providers/$p.so ./internal/providers/$p
  cp ~/.local/lib/elephant/providers/$p.so ~/.local/lib/elephant/providers-walker/$p.so
done
```

Final desktop theme steps:

```bash
gsettings set org.gnome.desktop.interface gtk-theme 'Breeze-Dark'
gsettings set org.gnome.desktop.interface icon-theme 'breeze-dark'
gsettings set org.gnome.desktop.interface color-scheme 'prefer-dark'
plasma-apply-colorscheme FlexokiDark
plasma-apply-lookandfeel -a org.kde.breezedark.desktop
```

Logging out and back in is the cleanest final pass for GTK/KDE theming.

Notes:

- `hypr-workspacectl` is the main glue script for monitor-local workspace movement, scratchpad behavior, and Waybar window focusing
- `steam` and `spotify-launcher` are sent to `special:scratchpad` via `windowrule`
- Vivaldi is launched once at startup so it can restore its own previous-session windows naturally
