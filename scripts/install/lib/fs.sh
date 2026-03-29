#!/usr/bin/env bash

BACKUP_SESSION=${BACKUP_SESSION:-$(date +%Y%m%d-%H%M%S)}
BACKUP_ROOT=${BACKUP_ROOT:-$HOME/.backup/dotfiles/$BACKUP_SESSION}

declare -ga FINAL_NOTES=()

ensure_dir() {
  mkdir -p "$1"
}

add_note() {
  FINAL_NOTES+=("$1")
}

backup_destination() {
  local target=$1
  local rel=${target#$HOME/}

  if [[ $rel == "$target" ]]; then
    rel=$(basename "$target")
  fi

  printf '%s/%s' "$BACKUP_ROOT" "$rel"
}

same_link_target() {
  local source=$1
  local target=$2

  [[ -L $target ]] || return 1
  [[ $(readlink -f "$target") == $(readlink -f "$source") ]]
}

backup_if_needed() {
  local target=$1
  local dest

  if [[ ! -e $target && ! -L $target ]]; then
    return 0
  fi

  dest=$(backup_destination "$target")
  ensure_dir "$(dirname "$dest")"
  mv "$target" "$dest"
  log_info "Backed up $target -> $dest"
}

link_path() {
  local source=$1
  local target=$2

  ensure_dir "$(dirname "$target")"
  if same_link_target "$source" "$target"; then
    log_success "Already linked: $target"
    return 0
  fi

  backup_if_needed "$target"
  ln -sfn "$source" "$target"
  log_success "Linked $target"
}

copy_fonts_tree() {
  local source_dir=$1
  local target_dir=$HOME/.local/share/fonts
  local count=0
  local font

  ensure_dir "$target_dir"

  while IFS= read -r -d '' font; do
    cp "$font" "$target_dir/"
    ((count += 1))
  done < <(find "$source_dir" -type f \( -name '*.ttf' -o -name '*.otf' \) -print0)

  if (( count == 0 )); then
    log_warning "No font files found in $source_dir"
    return 0
  fi

  fc-cache -f >/dev/null 2>&1 || true
  log_success "Installed $count font files"
}
