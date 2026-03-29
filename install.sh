#!/usr/bin/env bash

set -euo pipefail

REPO_URL="https://github.com/ibanks42/dotfiles.git"
DEFAULT_REPO_PATH="${DOTFILES_PATH:-$HOME/dotfiles}"
TTY_FILE="/dev/tty"

say() {
  printf '%s\n' "$1"
}

prompt_yes_no() {
  local prompt=$1
  local default=${2:-y}
  local reply
  local suffix

  if [[ $default == y ]]; then
    suffix='[Y/n]'
  else
    suffix='[y/N]'
  fi

  while true; do
    if [[ -r $TTY_FILE ]]; then
      printf '%s %s ' "$prompt" "$suffix" >"$TTY_FILE"
      IFS= read -r reply <"$TTY_FILE"
    else
      reply=$default
    fi

    reply=${reply:-$default}
    case ${reply,,} in
      y|yes) return 0 ;;
      n|no) return 1 ;;
    esac
  done
}

bootstrap_git() {
  if command -v git >/dev/null 2>&1; then
    return 0
  fi

  if ! command -v pacman >/dev/null 2>&1; then
    printf '%s\n' 'This installer is Arch-only and needs pacman available.' >&2
    exit 1
  fi

  prompt_yes_no 'git is required. Install it with pacman now?' y || exit 1
  sudo pacman -Sy --needed --noconfirm git
}

prepare_repo() {
  local repo_path=$DEFAULT_REPO_PATH
  local script_dir
  local script_source

  script_source=${BASH_SOURCE[0]:-$0}
  if [[ -n $script_source && -e $script_source ]]; then
    script_dir=$(cd "$(dirname "$script_source")" && pwd)
  else
    script_dir=$PWD
  fi

  if [[ -f $script_dir/scripts/install/main.sh && -d $script_dir/.git ]]; then
    DOTFILES_PATH=$script_dir
    export DOTFILES_PATH
    exec "$script_dir/scripts/install/main.sh"
  fi

  bootstrap_git

  if [[ -d $repo_path/.git ]]; then
    if prompt_yes_no "Use existing checkout at $repo_path?" y; then
      if prompt_yes_no 'Update it first with git pull?' y; then
        git -C "$repo_path" pull --rebase --autostash || true
        git -C "$repo_path" submodule update --init --recursive
      fi
    else
      local backup_path="${repo_path}.bak.$(date +%Y%m%d-%H%M%S)"
      mv "$repo_path" "$backup_path"
      say "Moved existing path to $backup_path"
      git clone "$REPO_URL" "$repo_path"
      git -C "$repo_path" submodule update --init --recursive
    fi
  elif [[ -e $repo_path ]]; then
    local backup_path="${repo_path}.bak.$(date +%Y%m%d-%H%M%S)"
    prompt_yes_no "$repo_path exists and is not a git checkout. Move it aside and clone dotfiles there?" y || exit 1
    mv "$repo_path" "$backup_path"
    say "Moved existing path to $backup_path"
    git clone "$REPO_URL" "$repo_path"
    git -C "$repo_path" submodule update --init --recursive
  else
    git clone "$REPO_URL" "$repo_path"
    git -C "$repo_path" submodule update --init --recursive
  fi

  DOTFILES_PATH=$repo_path
  export DOTFILES_PATH
  exec "$repo_path/scripts/install/main.sh"
}

prepare_repo "$@"
