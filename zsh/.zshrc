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
export SUDOEDITOR=vim

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

# ── Plugins ─────────────────────────────────────────────────────────────
if [[ -r ~/.zsh/antigen.zsh ]]; then
  source ~/.zsh/antigen.zsh
  antigen bundle git
  antigen bundle zsh-users/zsh-syntax-highlighting
  antigen bundle Aloxaf/fzf-tab
  antigen bundle "MichaelAquilina/zsh-you-should-use"
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
# Green on success, orange when the last command failed.
_prompt_char() {
  local c
  (( ${STARSHIP_CMD_STATUS:-0} )) && c='#d99a5e' || c='#a5e075'
  print -n "%F{$c}%B❯%b%f"
}
PROMPT+=$'\n''$(_prompt_char) '

# Show the cursor again before each prompt, in case a program (pi, nvim, a TUI
# that crashed) exited with the cursor still hidden.
_show_cursor() { print -n '\e[?25h' }
add-zsh-hook precmd _show_cursor

# ── Machine-specific settings (last, so they can override anything) ─────
[[ -f $HOME/.zshrc.local ]] && source "$HOME/.zshrc.local"

# Standard command-line editing, even when EDITOR is vim or nvim.
bindkey -e
