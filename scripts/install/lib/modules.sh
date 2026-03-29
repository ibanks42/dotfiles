#!/usr/bin/env bash
# Data-driven module registry for the dotfiles installer.
# Adding a new app = one app() call.  Adding a new config = one config() call
# plus an install_config_ID() function.

# ── App Registry ──────────────────────────────────────────────────────

declare -ga APP_IDS=()
declare -Ag APP_GROUPS=()
declare -Ag APP_LABELS=()
declare -Ag APP_DESCRIPTIONS=()
declare -Ag APP_DEFAULTS=()
declare -Ag APP_PACKAGES=()
declare -Ag APP_NOTES=()
declare -Ag APP_SELECTED=()

# Groups in display order  (id  label)
declare -ga GROUP_IDS=(core cli editor terminal shell desktop apps security dev)
declare -Ag GROUP_LABELS=(
  [core]='Core'
  [cli]='CLI tools'
  [editor]='Editors'
  [terminal]='Terminals'
  [shell]='Shell'
  [desktop]='Desktop'
  [apps]='Applications'
  [security]='Security'
  [dev]='Dev tools'
)

# Register an application.
# Usage: app ID GROUP 'Label' 'Description' DEFAULT PACKAGES...
app() {
  local id=$1 group=$2 label=$3 desc=$4 default=$5; shift 5
  APP_IDS+=("$id")
  APP_GROUPS[$id]=$group
  APP_LABELS[$id]=$label
  APP_DESCRIPTIONS[$id]=$desc
  APP_DEFAULTS[$id]=$default
  APP_PACKAGES[$id]="$*"
}

# ── App Definitions ───────────────────────────────────────────────────
# One line per app — add new apps here.

app core-tools  core     'Core tools'   'git, gh, curl, wget, jq, base-devel'              1  git github-cli curl wget jq base-devel unzip zip tar xz
app cli-tools   cli      'CLI tools'    'fzf, eza, fd, bat, lazygit, zoxide, ripgrep'      1  fzf eza fd bat lazygit zoxide ripgrep
app neovim      editor   'Neovim'       'Text editor'                                      1  neovim
app tmux        terminal 'tmux'         'Terminal multiplexer'                              1  tmux
app ghostty     terminal 'Ghostty'      'GPU-accelerated terminal'                         1  ghostty
app zsh         shell    'Zsh'          'Z shell + oh-my-zsh'                              1  zsh
app hyprland    desktop  'Hyprland'     'Compositor + desktop environment'                  0  hyprland hyprlock hyprpaper xdg-desktop-portal-hyprland pipewire wireplumber brightnessctl grim slurp wl-clipboard ydotool wtype pavucontrol network-manager-applet
app waybar      desktop  'Waybar'       'Status bar for Wayland'                            0  waybar
app mako        desktop  'Mako'         'Notification daemon'                               0  mako
app walker      desktop  'Walker'       'Application launcher'                              0  aur:walker-bin
app vivaldi     apps     'Vivaldi'      'Web browser + ffmpeg codecs'                       0  vivaldi vivaldi-ffmpeg-codecs
app steam       apps     'Steam'        'Gaming platform'                                   0  steam
app spotify     apps     'Spotify'      'Music player'                                      0  spotify-launcher
app dolphin     apps     'Dolphin'      'File manager'                                      0  dolphin
app bitwarden   security 'Bitwarden'    'Password manager (rbw + CLI)'                      0  rbw bitwarden-cli
app mise        dev      'mise'         'Runtime version manager'                           1  mise

# Post-install notes for specific apps
APP_NOTES[steam]='Steam on Arch may require multilib to be enabled in /etc/pacman.conf.'
APP_NOTES[hyprland]='Run: systemctl --user daemon-reload'

# ── Config Registry ───────────────────────────────────────────────────

declare -ga CONFIG_IDS=()
declare -Ag CONFIG_LABELS=()
declare -Ag CONFIG_DESCRIPTIONS=()
declare -Ag CONFIG_DEFAULTS=()
declare -Ag CONFIG_SELECTED=()

# Register a configuration.
# Usage: config ID 'Label' 'Description' DEFAULT
config() {
  local id=$1 label=$2 desc=$3 default=$4
  CONFIG_IDS+=("$id")
  CONFIG_LABELS[$id]=$label
  CONFIG_DESCRIPTIONS[$id]=$desc
  CONFIG_DEFAULTS[$id]=$default
}

# ── Config Definitions ────────────────────────────────────────────────

config shell     'Shell config'     '.hushlogin symlink'                            1
config fonts     'Fonts'            'Copy bundled fonts to ~/.local/share/fonts'     1
config neovim    'Neovim config'    'Link nvim config + back up data/cache'          1
config tmux      'tmux config'      'Link tmux config + sessionizer'                1
config ghostty   'Ghostty config'   'Link Ghostty config'                           1
config zsh       'Zsh config'       'oh-my-zsh + custom.zsh'                        1
config hyprland  'Hyprland config'  'Hypr, Waybar, Mako, Walker, Elephant, GTK'     0
config ideavim   'IdeaVim config'   '.ideavimrc symlink for JetBrains IDEs'         0
config mise      'Mise runtimes'    'Pick languages to install globally'             1

# ── Config Install Functions ──────────────────────────────────────────
# Each config has a custom install_config_ID() function since linking
# logic varies per config.

install_config_shell() {
  link_path "$DOTFILES_PATH/.hushlogin" "$HOME/.hushlogin"
}

install_config_fonts() {
  copy_fonts_tree "$DOTFILES_PATH/fonts"
}

install_config_neovim() {
  link_path "$DOTFILES_PATH/nvim" "$HOME/.config/nvim"
  [[ -d $HOME/.local/share/nvim ]] && backup_if_needed "$HOME/.local/share/nvim"
  [[ -d $HOME/.cache/nvim ]]       && backup_if_needed "$HOME/.cache/nvim"
}

install_config_tmux() {
  link_path "$DOTFILES_PATH/tmux" "$HOME/.config/tmux"
  link_path "$HOME/.config/tmux/tmux-sessionizer" "$HOME/.local/bin/tmux-sessionizer"
}

install_config_ghostty() {
  link_path "$DOTFILES_PATH/ghostty" "$HOME/.config/ghostty"
}

install_config_zsh() {
  if [[ ! -d $HOME/.oh-my-zsh ]]; then
    log_info 'Cloning oh-my-zsh...'
    git clone https://github.com/ohmyzsh/ohmyzsh.git "$HOME/.oh-my-zsh"
  else
    log_success 'oh-my-zsh already exists'
  fi

  ensure_dir "$HOME/.oh-my-zsh/custom"
  link_path "$DOTFILES_PATH/zsh/custom.zsh" "$HOME/.oh-my-zsh/custom/custom.zsh"

  if [[ $SHELL != *zsh ]] && prompt_yes_no 'Change your default shell to zsh?' n; then
    chsh -s "$(command -v zsh)"
    add_note 'Log out and back in for your shell change to take effect.'
  fi
}

install_config_hyprland() {
  link_path "$DOTFILES_PATH/hypr/hypr"       "$HOME/.config/hypr"
  link_path "$DOTFILES_PATH/hypr/waybar"     "$HOME/.config/waybar"
  link_path "$DOTFILES_PATH/hypr/walker"     "$HOME/.config/walker"
  link_path "$DOTFILES_PATH/hypr/mako"       "$HOME/.config/mako"
  link_path "$DOTFILES_PATH/hypr/elephant"   "$HOME/.config/elephant"
  link_path "$DOTFILES_PATH/hypr/gtk-3.0"    "$HOME/.config/gtk-3.0"
  link_path "$DOTFILES_PATH/hypr/gtk-4.0"    "$HOME/.config/gtk-4.0"

  link_path "$DOTFILES_PATH/hypr/systemd/user/elephant.service"           "$HOME/.config/systemd/user/elephant.service"
  link_path "$DOTFILES_PATH/hypr/systemd/user/elephant-rbw-watch.service" "$HOME/.config/systemd/user/elephant-rbw-watch.service"

  link_path "$DOTFILES_PATH/hypr/local/bin/hyprctl-current"     "$HOME/.local/bin/hyprctl-current"
  link_path "$DOTFILES_PATH/hypr/local/bin/hypr-toggle-hdr"     "$HOME/.local/bin/hypr-toggle-hdr"
  link_path "$DOTFILES_PATH/hypr/local/bin/hypr-workspacectl"   "$HOME/.local/bin/hypr-workspacectl"
  link_path "$DOTFILES_PATH/hypr/local/bin/elephant-launch"     "$HOME/.local/bin/elephant-launch"
  link_path "$DOTFILES_PATH/hypr/local/bin/elephant-rbw-watch"  "$HOME/.local/bin/elephant-rbw-watch"
  link_path "$DOTFILES_PATH/hypr/local/bin/rbw-unlock-elephant"    "$HOME/.local/bin/rbw-unlock-elephant"
  link_path "$DOTFILES_PATH/hypr/local/bin/rbw-pinentry-keyring" "$HOME/.local/bin/rbw-pinentry-keyring"
  link_path "$DOTFILES_PATH/hypr/local/bin/rbw-store-keyring-password" "$HOME/.local/bin/rbw-store-keyring-password"

  link_path "$DOTFILES_PATH/hypr/local/share/color-schemes/FlexokiDark.colors" "$HOME/.local/share/color-schemes/FlexokiDark.colors"
  link_path "$DOTFILES_PATH/hypr/kdeglobals" "$HOME/.config/kdeglobals"

  add_note 'Run: systemctl --user daemon-reload'
  add_note 'If Elephant is installed locally, restart: elephant.service and elephant-rbw-watch.service'
  add_note 'Reload Hyprland and Waybar after logging in: hyprctl reload && pkill -SIGUSR2 waybar'
}

install_config_ideavim() {
  link_path "$DOTFILES_PATH/idea/.ideavimrc" "$HOME/.ideavimrc"
}

install_config_mise() {
  local runtime_ids=(node go bun python rust zig java)

  local -A runtime_labels=(
    [node]='Node.js'   [go]='Go'       [bun]='Bun'
    [python]='Python'  [rust]='Rust'   [zig]='Zig'   [java]='Java'
  )

  local -A runtime_descs=(
    [node]='JavaScript runtime (node@latest)'
    [go]='Go programming language (go@latest)'
    [bun]='Fast JS runtime & bundler (bun@latest)'
    [python]='Python interpreter (python@latest)'
    [rust]='Rust toolchain (rust@latest)'
    [zig]='Zig programming language (zig@latest)'
    [java]='Java Development Kit (java@latest)'
  )

  local -A runtime_versions=(
    [node]='node@latest'   [go]='go@latest'     [bun]='bun@latest'
    [python]='python@latest' [rust]='rust@latest' [zig]='zig@latest' [java]='java@latest'
  )

  local -A runtime_selected=(
    [node]=1  [go]=1  [bun]=1
    [python]=0  [rust]=0  [zig]=0  [java]=0
  )

  local -A runtime_defaults
  local id
  for id in "${runtime_ids[@]}"; do runtime_defaults[$id]=${runtime_selected[$id]}; done

  choose_checklist 'Mise runtimes — pick languages to install globally' \
    runtime_ids runtime_labels runtime_selected runtime_defaults runtime_descs

  [[ -t 1 ]] && clear

  local any=0
  for id in "${runtime_ids[@]}"; do
    if [[ ${runtime_selected[$id]} -eq 1 ]]; then
      log_info "Installing ${runtime_versions[$id]}..."
      mise use --global "${runtime_versions[$id]}"
      any=1
    fi
  done

  (( any )) || log_info 'No additional mise runtimes selected.'
}

# ── Preset Helpers ────────────────────────────────────────────────────

# Enable all apps whose group matches any of the given group names.
_enable_app_groups() {
  local group id
  for group in "$@"; do
    for id in "${APP_IDS[@]}"; do
      [[ ${APP_GROUPS[$id]} == "$group" ]] && APP_SELECTED[$id]=1
    done
  done
}

# Enable specific apps by ID.
_enable_apps() {
  local id
  for id in "$@"; do
    APP_SELECTED[$id]=1
  done
}

# Enable specific configs by ID.
_enable_configs() {
  local id
  for id in "$@"; do
    CONFIG_SELECTED[$id]=1
  done
}

# Zero out all selections.
reset_all_selections() {
  local id
  for id in "${APP_IDS[@]}";    do APP_SELECTED[$id]=0;    done
  for id in "${CONFIG_IDS[@]}"; do CONFIG_SELECTED[$id]=0; done
}

# Apply a named preset to APP_SELECTED and CONFIG_SELECTED.
apply_preset() {
  local preset=$1

  reset_all_selections

  case $preset in
    full)
      for id in "${APP_IDS[@]}";    do APP_SELECTED[$id]=1;    done
      for id in "${CONFIG_IDS[@]}"; do CONFIG_SELECTED[$id]=1; done
      ;;
    terminal)
      _enable_app_groups core cli editor terminal shell dev
      _enable_configs shell fonts neovim tmux ghostty zsh mise
      ;;
    hypr)
      _enable_app_groups core cli desktop apps security
      _enable_apps ghostty zsh mise
      _enable_configs shell fonts ghostty hyprland zsh mise
      ;;
    minimal)
      _enable_apps core-tools neovim tmux
      _enable_configs shell neovim tmux
      ;;
    custom)
      for id in "${APP_IDS[@]}";    do APP_SELECTED[$id]=${APP_DEFAULTS[$id]};    done
      for id in "${CONFIG_IDS[@]}"; do CONFIG_SELECTED[$id]=${CONFIG_DEFAULTS[$id]}; done
      ;;
  esac
}

# ── Query Helpers ─────────────────────────────────────────────────────

# Print app IDs in a given group.
apps_in_group() {
  local group=$1 id
  for id in "${APP_IDS[@]}"; do
    [[ ${APP_GROUPS[$id]} == "$group" ]] && printf '%s\n' "$id"
  done
}

# Count selected / total apps in a group.
group_counts() {
  local group=$1
  local total=0 selected=0 id
  for id in "${APP_IDS[@]}"; do
    if [[ ${APP_GROUPS[$id]} == "$group" ]]; then
      ((total += 1))
      [[ ${APP_SELECTED[$id]} -eq 1 ]] && ((selected += 1))
    fi
  done
  printf '%d %d' "$selected" "$total"
}

# Check if a group has any apps registered.
group_has_apps() {
  local group=$1 id
  for id in "${APP_IDS[@]}"; do
    [[ ${APP_GROUPS[$id]} == "$group" ]] && return 0
  done
  return 1
}
