#!/usr/bin/env bash

SYSTEM_ID=''
SYSTEM_NAME=''
SYSTEM_ARCH=''
AUR_HELPER=''
SUDO_READY=0

detect_system() {
  local like

  if [[ ! -f /etc/os-release ]]; then
    log_error 'Unable to detect the operating system.'
    exit 1
  fi

  # shellcheck disable=SC1091
  source /etc/os-release
  SYSTEM_ID=${ID:-unknown}
  SYSTEM_NAME=${PRETTY_NAME:-$SYSTEM_ID}
  like=${ID_LIKE:-}

  if [[ $SYSTEM_ID != arch && $like != *arch* && $SYSTEM_ID != endeavouros && $SYSTEM_ID != manjaro && $SYSTEM_ID != cachyos ]]; then
    log_error "This installer is Arch-only now. Detected: $SYSTEM_NAME"
    exit 1
  fi

  SYSTEM_ARCH=$(uname -m)
  if [[ $SYSTEM_ARCH != x86_64 ]]; then
    log_warning "This setup is tuned for x86_64; you are on $SYSTEM_ARCH"
  fi
}

detect_aur_helper() {
  if command -v paru >/dev/null 2>&1; then
    AUR_HELPER=paru
  elif command -v yay >/dev/null 2>&1; then
    AUR_HELPER=yay
  else
    AUR_HELPER=''
  fi
}

ensure_sudo() {
  if (( SUDO_READY == 1 )); then
    return 0
  fi

  log_info 'Requesting sudo access for package installation...'
  sudo -v
  SUDO_READY=1
}

ensure_aur_helper() {
  detect_aur_helper
  if [[ -n $AUR_HELPER ]]; then
    return 0
  fi

  if ! prompt_yes_no 'Install paru for AUR packages?' y; then
    return 1
  fi

  ensure_sudo
  sudo pacman -S --needed --noconfirm paru
  AUR_HELPER=paru
}

install_packages() {
  local label=$1
  shift
  local requested=("$@")
  local official=()
  local aur=()
  local missing=()
  local pkg

  if (( ${#requested[@]} == 0 )); then
    return 0
  fi

  for pkg in "${requested[@]}"; do
    if [[ $pkg == aur:* ]]; then
      aur+=("${pkg#aur:}")
    elif pacman -Si "$pkg" >/dev/null 2>&1; then
      official+=("$pkg")
    else
      aur+=("$pkg")
    fi
  done

  if (( ${#official[@]} > 0 )); then
    ensure_sudo
    log_info "Installing $label packages from pacman..."
    sudo pacman -S --needed --noconfirm "${official[@]}"
  fi

  if (( ${#aur[@]} > 0 )); then
    if ensure_aur_helper; then
      log_info "Installing $label packages from AUR via $AUR_HELPER..."
      "$AUR_HELPER" -S --needed --noconfirm "${aur[@]}"
    else
      missing=("${aur[@]}")
    fi
  fi

  if (( ${#missing[@]} > 0 )); then
    log_warning "Skipped packages without an AUR helper: ${missing[*]}"
    add_note "Skipped packages (no AUR helper): ${missing[*]}"
  fi
}
