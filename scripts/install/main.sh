#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
DOTFILES_PATH=${DOTFILES_PATH:-$(cd "$SCRIPT_DIR/../.." && pwd)}

# shellcheck source=scripts/install/lib/ui.sh
source "$SCRIPT_DIR/lib/ui.sh"
# shellcheck source=scripts/install/lib/fs.sh
source "$SCRIPT_DIR/lib/fs.sh"
# shellcheck source=scripts/install/lib/system.sh
source "$SCRIPT_DIR/lib/system.sh"
# shellcheck source=scripts/install/lib/modules.sh
source "$SCRIPT_DIR/lib/modules.sh"

declare -Ag INSTALL_RESULTS=()

# ── Review ────────────────────────────────────────────────────────────

show_review() {
  local id any_apps=0 any_configs=0

  ui_banner
  ui_section 'Install plan'
  printf '  %-12s%s\n' "Repo" "$DOTFILES_PATH"
  printf '  %-12s%s\n' "Backups" "$BACKUP_ROOT"

  # Apps
  printf '\n  %s%sApplications%s\n' "$C_CYAN" "$C_BOLD" "$C_RESET"
  for id in "${APP_IDS[@]}"; do
    if [[ ${APP_SELECTED[$id]} -eq 1 ]]; then
      printf '  %s✓%s  %-18s %s%s%s\n' "$C_GREEN" "$C_RESET" \
        "${APP_LABELS[$id]}" "$C_DIM" "${APP_DESCRIPTIONS[$id]}" "$C_RESET"
      any_apps=1
    fi
  done
  (( any_apps )) || printf '  %sNone selected.%s\n' "$C_DIM" "$C_RESET"

  # Configs
  printf '\n  %s%sConfigurations%s\n' "$C_CYAN" "$C_BOLD" "$C_RESET"
  for id in "${CONFIG_IDS[@]}"; do
    if [[ ${CONFIG_SELECTED[$id]} -eq 1 ]]; then
      printf '  %s✓%s  %-18s %s%s%s\n' "$C_GREEN" "$C_RESET" \
        "${CONFIG_LABELS[$id]}" "$C_DIM" "${CONFIG_DESCRIPTIONS[$id]}" "$C_RESET"
      any_configs=1
    fi
  done
  (( any_configs )) || printf '  %sNone selected.%s\n' "$C_DIM" "$C_RESET"

  printf '\n'
}

# ── Install Execution ─────────────────────────────────────────────────

run_app() {
  local id=$1
  local packages=${APP_PACKAGES[$id]}

  printf '\n'
  ui_hr
  printf '  %s%s%s  %s(%s)%s\n\n' "$C_BOLD" "${APP_LABELS[$id]}" "$C_RESET" \
    "$C_DIM" "$packages" "$C_RESET"

  # Word splitting is intentional here — packages is a space-separated string.
  # shellcheck disable=SC2086
  if install_packages "${APP_LABELS[$id]}" $packages; then
    INSTALL_RESULTS[app:$id]=success
    log_success "${APP_LABELS[$id]} installed"
  else
    INSTALL_RESULTS[app:$id]=failed
    log_error "${APP_LABELS[$id]} failed"
  fi

  # Emit any post-install notes for this app.
  [[ -n ${APP_NOTES[$id]:-} ]] && add_note "${APP_NOTES[$id]}"
}

run_config() {
  local id=$1
  local fn="install_config_${id}"

  printf '\n'
  ui_hr
  printf '  %s%s%s\n\n' "$C_BOLD" "${CONFIG_LABELS[$id]}" "$C_RESET"

  if "$fn"; then
    INSTALL_RESULTS[config:$id]=success
    log_success "${CONFIG_LABELS[$id]} done"
  else
    INSTALL_RESULTS[config:$id]=failed
    log_error "${CONFIG_LABELS[$id]} failed"
  fi
}

# ── Summary ───────────────────────────────────────────────────────────

show_summary() {
  local failures=0
  local id note

  printf '\n'
  ui_hr
  ui_section 'Summary'

  # Apps
  for id in "${APP_IDS[@]}"; do
    [[ ${APP_SELECTED[$id]:-0} -ne 1 ]] && continue
    if [[ ${INSTALL_RESULTS[app:$id]:-skipped} == success ]]; then
      printf '  %s✓%s  %s\n' "$C_GREEN" "$C_RESET" "${APP_LABELS[$id]}"
    else
      printf '  %s✗%s  %s\n' "$C_RED" "$C_RESET" "${APP_LABELS[$id]}"
      ((failures += 1))
    fi
  done

  # Configs
  for id in "${CONFIG_IDS[@]}"; do
    [[ ${CONFIG_SELECTED[$id]:-0} -ne 1 ]] && continue
    if [[ ${INSTALL_RESULTS[config:$id]:-skipped} == success ]]; then
      printf '  %s✓%s  %s\n' "$C_GREEN" "$C_RESET" "${CONFIG_LABELS[$id]}"
    else
      printf '  %s✗%s  %s\n' "$C_RED" "$C_RESET" "${CONFIG_LABELS[$id]}"
      ((failures += 1))
    fi
  done

  if (( ${#FINAL_NOTES[@]} > 0 )); then
    printf '\n  %s%sNext steps%s\n\n' "$C_CYAN" "$C_BOLD" "$C_RESET"
    for note in "${FINAL_NOTES[@]}"; do
      printf '  · %s\n' "$note"
    done
  fi

  printf '\n  Backups in %s%s%s\n\n' "$C_DIM" "$BACKUP_ROOT" "$C_RESET"

  if (( failures == 0 )); then
    printf '  %s%sAll selected items completed.%s\n\n' "$C_GREEN" "$C_BOLD" "$C_RESET"
  else
    printf '  %s%sSome items failed — check the output above.%s\n\n' "$C_YELLOW" "$C_BOLD" "$C_RESET"
  fi
}

# ── Main ──────────────────────────────────────────────────────────────

main() {
  local preset_labels=(
    'Full workstation'
    'Terminal + editor'
    'Hypr desktop'
    'Minimal'
    'Custom'
  )
  local preset_descs=(
    'Everything — desktop, terminal, editor, and apps'
    'Core dev tools, Neovim, tmux, Ghostty, Zsh'
    'Hyprland stack plus daily desktop apps'
    'Just the bare essentials — base, Neovim, tmux'
    'Start from defaults and pick your own'
  )
  local preset_map=(full terminal hypr minimal custom)
  local preset_choice id

  require_tty
  detect_system

  ensure_dir "$HOME/.config"
  ensure_dir "$HOME/.local/bin"
  ensure_dir "$HOME/.config/systemd/user"
  ensure_dir "$HOME/.local/share/color-schemes"

  ui_banner
  printf '  Detected %s%s%s on %s.\n\n' "$C_BOLD" "$SYSTEM_NAME" "$C_RESET" "$SYSTEM_ARCH"
  prompt_enter

  # ── Phase 1: Preset ──────────────────────────────────────────────

  preset_choice=$(prompt_choice 'Choose a starting preset' preset_labels 1 preset_descs)
  apply_preset "${preset_map[$((preset_choice - 1))]}"

  # ── Phase 2: Applications (category submenus) ───────────────────

  choose_app_categories 'Applications — choose by category'

  # ── Phase 3: Configurations (flat checklist) ────────────────────

  choose_checklist 'Configurations — link dotfiles & settings' \
    CONFIG_IDS CONFIG_LABELS CONFIG_SELECTED CONFIG_DEFAULTS CONFIG_DESCRIPTIONS

  # ── Phase 4: Review & confirm ───────────────────────────────────

  show_review
  if ! prompt_yes_no 'Apply this setup?' y; then
    log_warning 'Installer cancelled.'
    exit 0
  fi

  # ── Phase 5: Install ────────────────────────────────────────────

  ui_banner
  ui_section 'Installing'

  ensure_sudo

  # Install selected apps (packages)
  for id in "${APP_IDS[@]}"; do
    [[ ${APP_SELECTED[$id]} -eq 1 ]] && run_app "$id"
  done

  # Apply selected configurations
  for id in "${CONFIG_IDS[@]}"; do
    [[ ${CONFIG_SELECTED[$id]} -eq 1 ]] && run_config "$id"
  done

  # ── Phase 6: Summary ────────────────────────────────────────────

  show_summary
}

main "$@"
