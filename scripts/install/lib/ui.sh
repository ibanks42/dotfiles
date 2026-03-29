#!/usr/bin/env bash
# Terminal UI library for the dotfiles installer.
# Provides flicker-free interactive menus and styled output.

# ── Colors ─────────────────────────────────────────────────────────────

if [[ -t 1 ]]; then
  C_RESET=$'\033[0m'
  C_BOLD=$'\033[1m'
  C_DIM=$'\033[2m'
  C_RED=$'\033[31m'
  C_GREEN=$'\033[32m'
  C_YELLOW=$'\033[33m'
  C_BLUE=$'\033[34m'
  C_MAGENTA=$'\033[35m'
  C_CYAN=$'\033[36m'
else
  C_RESET='' C_BOLD='' C_DIM=''
  C_RED='' C_GREEN='' C_YELLOW=''
  C_BLUE='' C_MAGENTA='' C_CYAN=''
fi

# ── TTY & Cleanup ─────────────────────────────────────────────────────

TTY_FILE=${TTY_FILE:-/dev/tty}

require_tty() {
  if [[ ! -r $TTY_FILE ]]; then
    printf '%sThis installer needs an interactive terminal.%s\n' "$C_RED" "$C_RESET" >&2
    printf 'Run it directly:  bash install.sh\n' >&2
    exit 1
  fi
}

# Restore cursor on exit so ctrl+c doesn't leave the terminal broken.
_ui_cleanup() {
  printf '\033[?25h' >"$TTY_FILE" 2>/dev/null || true
}
trap _ui_cleanup EXIT

# ── Frame Buffer ───────────────────────────────────────────────────────
# Build an entire screen in memory, then flush it to the terminal in one
# write.  Combined with hide-cursor / cursor-home / clear-to-end, this
# eliminates visible flicker when redrawing interactive menus.

declare -g _FRAME=""

_frame_begin() { _FRAME=$'\033[?25l\033[H'; }
_f()           { _FRAME+="$*"; }
_fn()          { _FRAME+="$*"$'\033[K\n'; }
_fblank()      { _FRAME+=$'\033[K\n'; }
_frame_end()   { _FRAME+=$'\033[J'; printf '%s' "$_FRAME" >"$TTY_FILE"; }

# ── Banner ─────────────────────────────────────────────────────────────

read -r -d '' _BANNER_RAW <<'BANNER' || true
  ____        _    _____ _ _
 |  _ \  ___ | |_ |  ___(_) | ___  ___
 | | | |/ _ \| __|| |_  | | |/ _ \/ __|
 | |_| | (_) | |_ |  _| | | |  __/\__ \
 |____/ \___/ \__||_|   |_|_|\___||___/
BANNER

# Append the banner block to the current frame buffer.
# Each line is emitted individually so _fn can clear-to-end-of-line.
_banner_to_frame() {
  local _line
  _fblank
  while IFS= read -r _line; do
    _fn "${C_CYAN}${C_BOLD}${_line}${C_RESET}"
  done <<< "$_BANNER_RAW"
  _fn "  ${C_DIM}Arch installer${C_RESET}"
  _fn "  ${C_DIM}──────────────────────────────────────────────${C_RESET}"
}

# Print the banner directly to stdout (for non-interactive screens).
ui_banner() {
  [[ -t 1 ]] && clear
  printf '\n%s%s%s%s\n' "$C_CYAN" "$C_BOLD" "$_BANNER_RAW" "$C_RESET"
  printf '  %sArch installer%s\n' "$C_DIM" "$C_RESET"
  ui_hr
}

# ── Layout Helpers ─────────────────────────────────────────────────────

ui_section() {
  printf '\n  %s%s%s%s\n\n' "$C_CYAN" "$C_BOLD" "$1" "$C_RESET"
}

ui_hr() {
  printf '  %s──────────────────────────────────────────────%s\n' "$C_DIM" "$C_RESET"
}

# ── Logging ────────────────────────────────────────────────────────────

log_info()    { printf '  %s::%s  %s\n' "${C_BLUE}${C_BOLD}" "$C_RESET" "$1"; }
log_success() { printf '  %s✓%s  %s\n'  "${C_GREEN}"          "$C_RESET" "$1"; }
log_warning() { printf '  %s!%s  %s\n'  "${C_YELLOW}${C_BOLD}" "$C_RESET" "$1"; }
log_error()   { printf '  %s✗%s  %s\n'  "${C_RED}${C_BOLD}"    "$C_RESET" "$1"; }

# ── Input ──────────────────────────────────────────────────────────────

ui_read() {
  local prompt=${1:-}
  local value

  printf '%b' "$prompt" >"$TTY_FILE"
  IFS= read -r value <"$TTY_FILE"
  printf '%s' "$value"
}

ui_read_key() {
  local key='' next=''

  IFS= read -rsn1 key <"$TTY_FILE" || true
  if [[ $key == $'\x1b' ]]; then
    IFS= read -rsn1 -t 0.01 next <"$TTY_FILE" || true
    key+=$next
    if [[ $next == '[' ]]; then
      IFS= read -rsn1 -t 0.01 next <"$TTY_FILE" || true
      key+=$next
    fi
  fi

  printf '%s' "$key"
}

# ── Simple Prompts ─────────────────────────────────────────────────────

prompt_enter() {
  ui_read "  ${C_DIM}Press Enter to continue...${C_RESET}"
}

prompt_yes_no() {
  local prompt=$1
  local default=${2:-y}
  local reply suffix

  if [[ $default == y ]]; then suffix='[Y/n]'; else suffix='[y/N]'; fi

  while true; do
    reply=$(ui_read "  ${C_YELLOW}${prompt}${C_RESET} ${C_DIM}${suffix}${C_RESET} ")
    reply=${reply:-$default}
    case ${reply,,} in
      y|yes) return 0 ;;
      n|no)  return 1 ;;
    esac
  done
}

# ── Single-Select Menu ────────────────────────────────────────────────
# Usage:  choice=$(prompt_choice 'Title' labels_arr [default] [descs_arr])
# Prints the 1-based index to stdout.

prompt_choice() {
  local title=$1
  local -n _pc_labels=$2
  local default_index=${3:-1}
  local cursor=$((default_index - 1))
  local total=${#_pc_labels[@]}
  local key i

  local _pc_has_descs=0
  if (( $# >= 4 )) && [[ -n ${4:-} ]]; then
    local -n _pc_descs=$4
    _pc_has_descs=1
  fi

  while true; do
    _frame_begin
    _banner_to_frame
    _fblank
    _fn "  ${C_BOLD}${title}${C_RESET}"
    _fblank

    for ((i = 0; i < total; i++)); do
      if ((i == cursor)); then
        _fn "  ${C_CYAN}❯${C_RESET} ${C_BOLD}${_pc_labels[$i]}${C_RESET}"
        # Show description only on focused item
        if ((_pc_has_descs)) && [[ -n ${_pc_descs[$i]:-} ]]; then
          _fn "      ${C_DIM}${_pc_descs[$i]}${C_RESET}"
        fi
      else
        _fn "    ${_pc_labels[$i]}"
      fi

      _fblank
    done

    _fn "  ${C_DIM}↑↓ navigate · enter confirm${C_RESET}"
    _frame_end

    key=$(ui_read_key)

    case "$key" in
      '')
        printf '\033[?25h' >"$TTY_FILE"
        printf '%s' "$((cursor + 1))"
        return 0
        ;;
      $'\x1b[A'|k|K) cursor=$(( (cursor - 1 + total) % total )) ;;
      $'\x1b[B'|j|J) cursor=$(( (cursor + 1) % total )) ;;
      [1-9])
        if (( key >= 1 && key <= total )); then
          printf '\033[?25h' >"$TTY_FILE"
          printf '%s' "$key"
          return 0
        fi
        ;;
    esac
  done
}

# ── Multi-Select Checklist ────────────────────────────────────────────
# Usage:  choose_checklist 'Title' ids labels selected defaults [descs]
# Modifies the `selected` associative array in place.
# Description is only shown for the focused (cursor) item to save space.

choose_checklist() {
  local title=$1
  local -n _cc_ids=$2
  local -n _cc_labels=$3
  local -n _cc_selected=$4
  local -n _cc_defaults=$5
  local cursor=0
  local total=${#_cc_ids[@]}
  local key id i marker check_color

  local _cc_has_descs=0
  if (( $# >= 6 )) && [[ -n ${6:-} ]]; then
    local -n _cc_descs=$6
    _cc_has_descs=1
  fi

  while true; do
    _frame_begin
    _banner_to_frame
    _fblank
    _fn "  ${C_BOLD}${title}${C_RESET}"
    _fblank

    for ((i = 0; i < total; i++)); do
      id=${_cc_ids[$i]}

      if [[ ${_cc_selected[$id]} -eq 1 ]]; then
        marker="✓"; check_color=$C_GREEN
      else
        marker="·"; check_color=$C_DIM
      fi

      if ((i == cursor)); then
        _fn "  ${C_CYAN}❯${C_RESET} ${check_color}${marker}${C_RESET}  ${C_BOLD}${_cc_labels[$id]}${C_RESET}"
        # Show description only on the focused item
        if ((_cc_has_descs)) && [[ -n ${_cc_descs[$id]:-} ]]; then
          _fn "       ${C_DIM}${_cc_descs[$id]}${C_RESET}"
        fi
      else
        _fn "    ${check_color}${marker}${C_RESET}  ${_cc_labels[$id]}"
      fi
    done

    _fblank
    _fn "  ${C_DIM}↑↓ move · space toggle · a/n/d all/none/defaults · enter done${C_RESET}"
    _frame_end

    key=$(ui_read_key)

    case "$key" in
      '')
        printf '\033[?25h' >"$TTY_FILE"
        return 0
        ;;
      $'\x1b[A'|k|K) cursor=$(( (cursor - 1 + total) % total )) ;;
      $'\x1b[B'|j|J) cursor=$(( (cursor + 1) % total )) ;;
      ' ')
        id=${_cc_ids[$cursor]}
        if [[ ${_cc_selected[$id]} -eq 1 ]]; then
          _cc_selected[$id]=0
        else
          _cc_selected[$id]=1
        fi
        ;;
      a|A) for id in "${_cc_ids[@]}"; do _cc_selected[$id]=1; done ;;
      n|N) for id in "${_cc_ids[@]}"; do _cc_selected[$id]=0; done ;;
      d|D) for id in "${_cc_ids[@]}"; do _cc_selected[$id]=${_cc_defaults[$id]}; done ;;
      [1-9])
        if (( key >= 1 && key <= total )); then
          cursor=$((key - 1))
          id=${_cc_ids[$cursor]}
          if [[ ${_cc_selected[$id]} -eq 1 ]]; then
            _cc_selected[$id]=0
          else
            _cc_selected[$id]=1
          fi
        fi
        ;;
    esac
  done
}

# ── Category Submenu ──────────────────────────────────────────────────
# Shows a list of app groups (categories) with aggregate selection counts.
# User navigates to a category and presses Enter to drill into it, or
# presses Enter on "Done" to finish.  Space on a category toggles all
# apps in that group.
#
# This function directly manipulates APP_SELECTED (from modules.sh).
# Requires: APP_IDS, APP_GROUPS, APP_SELECTED, APP_LABELS, APP_DESCRIPTIONS,
#           APP_DEFAULTS, GROUP_IDS, GROUP_LABELS, apps_in_group, group_counts

choose_app_categories() {
  local title=$1

  # Build list of groups that actually have apps.
  local _cac_groups=()
  local gid
  for gid in "${GROUP_IDS[@]}"; do
    group_has_apps "$gid" && _cac_groups+=("$gid")
  done

  # Extra "done" row at bottom.
  local total=${#_cac_groups[@]}
  local cursor=0
  local key i sel tot counts status_color _aid target

  while true; do
    _frame_begin
    _banner_to_frame
    _fblank
    _fn "  ${C_BOLD}${title}${C_RESET}"
    _fblank

    for ((i = 0; i < total; i++)); do
      gid=${_cac_groups[$i]}
      counts=$(group_counts "$gid")
      sel=${counts%% *}
      tot=${counts##* }

      status_color=$C_DIM
      if (( sel == tot )); then
        status_color=$C_GREEN
      elif (( sel > 0 )); then
        status_color=$C_YELLOW
      fi

      if ((i == cursor)); then
        _fn "  ${C_CYAN}❯${C_RESET} ${C_BOLD}${GROUP_LABELS[$gid]}${C_RESET}  ${status_color}${sel}/${tot}${C_RESET}"
      else
        _fn "    ${GROUP_LABELS[$gid]}  ${status_color}${sel}/${tot}${C_RESET}"
      fi
    done

    _fblank

    # "Done" row
    if ((cursor == total)); then
      _fn "  ${C_CYAN}❯${C_RESET} ${C_GREEN}${C_BOLD}Done${C_RESET}"
    else
      _fn "    ${C_DIM}Done${C_RESET}"
    fi

    _fblank
    _fn "  ${C_DIM}↑↓ move · enter open category · space toggle all · q/done finish${C_RESET}"
    _frame_end

    key=$(ui_read_key)

    case "$key" in
      '')
        if ((cursor == total)); then
          # On "Done" — exit
          printf '\033[?25h' >"$TTY_FILE"
          return 0
        else
          # Drill into selected category
          _drill_into_group "${_cac_groups[$cursor]}"
        fi
        ;;
      q|Q)
        printf '\033[?25h' >"$TTY_FILE"
        return 0
        ;;
      $'\x1b[A'|k|K) cursor=$(( (cursor - 1 + total + 1) % (total + 1) )) ;;
      $'\x1b[B'|j|J) cursor=$(( (cursor + 1) % (total + 1) )) ;;
      ' ')
        if ((cursor < total)); then
          # Toggle all apps in this group
          gid=${_cac_groups[$cursor]}
          counts=$(group_counts "$gid")
          sel=${counts%% *}
          tot=${counts##* }
          target=1
          (( sel == tot )) && target=0
          for _aid in "${APP_IDS[@]}"; do
            [[ ${APP_GROUPS[$_aid]} == "$gid" ]] && APP_SELECTED[$_aid]=$target
          done
        fi
        ;;
      a|A)
        for _aid in "${APP_IDS[@]}"; do APP_SELECTED[$_aid]=1; done
        ;;
      n|N)
        for _aid in "${APP_IDS[@]}"; do APP_SELECTED[$_aid]=0; done
        ;;
    esac
  done
}

# Drill into a single group's apps as a checklist.
_drill_into_group() {
  local group=$1

  # Build filtered ID list for this group.
  local _dig_ids=()
  local id
  for id in "${APP_IDS[@]}"; do
    [[ ${APP_GROUPS[$id]} == "$group" ]] && _dig_ids+=("$id")
  done

  (( ${#_dig_ids[@]} == 0 )) && return 0

  choose_checklist "${GROUP_LABELS[$group]} — select packages" \
    _dig_ids APP_LABELS APP_SELECTED APP_DEFAULTS APP_DESCRIPTIONS
}
