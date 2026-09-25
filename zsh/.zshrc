# Shared zsh config (tracked in ~/dotfiles/zsh/.zshrc, linked to ~/.zshrc).
# Put anything specific to one machine in ~/.zshrc.local (not in git).

ttyctl -f
autoload -Uz add-zsh-hook

# User specific environment
if ! [[ "$PATH" =~ "$HOME/.local/bin:$HOME/bin:" ]]; then
  PATH="$HOME/.local/bin:$HOME/bin:$PATH"
fi
export PATH
export EDITOR=nvim

# Aliases, starship, zoxide, mise (shared with bash)
[[ -f $HOME/.customrc ]] && source "$HOME/.customrc"

# if [[ -f "/usr/share/ghost/ghost.sh" ]]; then
#   source "/usr/share/ghost/ghost.sh"
# fi
#
# export GHOST_CTRL_R_COMMAND="fzf --height=40% --reverse --scheme=history --tiebreak=index"

zstyle ':completion:*' menu no
zstyle ':completion:*:descriptions' format '[%d]'
zstyle ':completion:*' list-colors ${(s.:.)LS_COLORS}

# ── zsh-vi-mode settings (must be set before the plugin loads) ──────────
# Ghostty sends Esc as CSI 27u (kitty protocol). Treat it as Esc; plain ^[
# stays bound too.
ZVM_VI_INSERT_ESCAPE_BINDKEY='^[[27u'
ZVM_VI_VISUAL_ESCAPE_BINDKEY='^[[27u'
# Not ZVM_VI_OPPEND_ESCAPE_BINDKEY: zsh-vi-mode uses it as a regex and '^[[27u'
# fails to compile. The default '^[' already matches the start of ESC[27u.
# Start every new prompt in insert mode. 'i' is $ZVM_MODE_INSERT (not defined yet).
ZVM_LINE_INIT_MODE=i

# ── Plugins ─────────────────────────────────────────────────────────────
if [[ -r ~/.zsh/antigen.zsh ]]; then
  source ~/.zsh/antigen.zsh
  antigen bundle git
  antigen bundle zsh-users/zsh-syntax-highlighting
  antigen bundle Aloxaf/fzf-tab
  antigen bundle "MichaelAquilina/zsh-you-should-use"
  antigen bundle jeffreytse/zsh-vi-mode
  antigen apply
  fpath+=($HOME/.antigen/bundles/Aloxaf/fzf-tab/lib)
fi
autoload -Uz compinit; compinit -i
if (( ${+functions[enable-fzf-tab]} )); then
  add-zsh-hook -D precmd _antigen_compinit 2>/dev/null
  autoload -Uz -- -ftb-version -ftb-generate-complist -ftb-generate-header -ftb-generate-query -ftb-fzf -ftb-colorize 2>/dev/null
  enable-fzf-tab
fi

command -v rbw >/dev/null && eval "$(rbw gen-completions zsh)"

# ── Prompt ──────────────────────────────────────────────────────────────
# Vi mode ❯ on its own line (zsh-vi-mode redraws on change). Colors follow
# the usual nvim statusline mode colors, from the modest-dark palette:
# insert green, normal blue, visual magenta, replace red. Insert turns
# orange when the last command failed.
_vi_mode_char() {
  local c
  case $ZVM_MODE in
    $ZVM_MODE_NORMAL)                       c='#5ab0f6' ;;
    $ZVM_MODE_VISUAL|$ZVM_MODE_VISUAL_LINE) c='#c678dd' ;;
    $ZVM_MODE_REPLACE)                      c='#e06c75' ;;
    *) (( ${STARSHIP_CMD_STATUS:-0} )) && c='#d99a5e' || c='#a5e075' ;;
  esac
  print -n "%F{$c}%B❯%b%f"
}
PROMPT+=$'\n''$(_vi_mode_char) '
# zsh draws the prompt before zsh-vi-mode switches the new line to insert mode,
# and zsh-vi-mode doesn't redraw it. Set the mode first so the ❯ starts green.
_vi_mode_reset() { ZVM_MODE=i }
add-zsh-hook precmd _vi_mode_reset

# Show the cursor again before each prompt, in case a program (pi, nvim, a TUI
# that crashed) exited with the cursor still hidden.
_show_cursor() { print -n '\e[?25h' }
add-zsh-hook precmd _show_cursor

# ── Machine-specific settings (last, so they can override anything) ─────
[[ -f $HOME/.zshrc.local ]] && source "$HOME/.zshrc.local"

