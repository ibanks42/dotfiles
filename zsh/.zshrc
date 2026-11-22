# Shared zsh config (tracked in ~/dotfiles/zsh/.zshrc, linked to ~/.zshrc).
# Put anything specific to one machine in ~/.zshrc.local (not in git).

ttyctl -f
autoload -Uz add-zsh-hook

export EDITOR=nvim
export SUDOEDITOR=vim


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
# _prompt_char() {
#   local c
#   (( ${STARSHIP_CMD_STATUS:-0} )) && c='#d99a5e' || c='#a5e075'
#   print -n "%F{$c}%B❯%b%f"
# }
# PROMPT+=$'\n''$(_prompt_char) '

# Show the cursor again before each prompt, in case a program (pi, nvim, a TUI
# that crashed) exited with the cursor still hidden.
_show_cursor() { print -n '\e[?25h' }
add-zsh-hook precmd _show_cursor

# ── Machine-specific settings (last, so they can override anything) ─────
[[ -f $HOME/.zshrc.local ]] && source "$HOME/.zshrc.local"

# Bash-style command-line editing, even when EDITOR is vim or nvim.
bindkey -e
autoload -Uz select-word-style
select-word-style bash
bindkey '^[[1;5D' backward-word       # Ctrl+Left
bindkey '^[[1;5C' forward-word        # Ctrl+Right
bindkey '^[[1;3D' backward-word       # Alt+Left
bindkey '^[[1;3C' forward-word        # Alt+Right
bindkey '^[[H' beginning-of-line      # Home
bindkey '^[[F' end-of-line            # End
bindkey '^[OH' beginning-of-line
bindkey '^[OF' end-of-line
bindkey '^[[3~' delete-char           # Delete
bindkey '^[[3;5~' kill-word           # Ctrl+Delete
bindkey '^H' backward-kill-word       # Ctrl+Backspace

# Herdr remote attaches lack SSH markers; forward Pi copies to the client clipboard.
if [[ ${HERDR_ENV:-} == 1 ]]; then
  export PI_CLIPBOARD_OSC52=1
fi

[[ -r $HOME/.grok/completions/zsh/_grok ]] && source "$HOME/.grok/completions/zsh/_grok"

# Aliases, starship, zoxide, mise
[[ -f $HOME/.zsh/custom.zsh ]] && source "$HOME/.zsh/custom.zsh"

# ── Behave like bash at the prompt ──────────────────────────────────────
# Interactive only (this file is not read by scripts). Never put these in ~/.zshenv.
setopt INTERACTIVE_COMMENTS  # `# comment` works when typed
setopt NO_NOMATCH            # unmatched globs pass through literally (curl 'a?b', pip install x[y])
setopt SH_WORD_SPLIT         # unquoted $var splits on spaces, like bash
setopt BASH_REMATCH          # [[ x =~ re ]] fills BASH_REMATCH like bash
setopt NO_EQUALS             # `=foo` is just text, not a path lookup
setopt NO_BEEP
HISTFILE=~/.zsh_history HISTSIZE=50000 SAVEHIST=50000
setopt HIST_IGNORE_DUPS
setopt NO_AUTO_CD            # typing a directory name doesn't cd into it
setopt NO_CORRECT NO_CORRECT_ALL
setopt NO_SHARE_HISTORY NO_INC_APPEND_HISTORY
setopt APPEND_HISTORY
# KSH_ARRAYS (0-based arrays) is left OFF on purpose: zsh hooks and plugins that
# don't reset options break with it (the "bad output format specification" errors).
# For bash array scripts, use bash: put #!/usr/bin/env bash at the top of the script and run it.
