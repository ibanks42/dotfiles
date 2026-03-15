_dotfiles_set_prompt() {
  PROMPT="%(?:%{$fg_bold[green]%}%1{➜%} :%{$fg_bold[red]%}%1{➜%} ) %{$fg[cyan]%}%~%{$reset_color%}"
  PROMPT+=' $(git_prompt_info)'
  RPROMPT=''
}

if (( ${precmd_functions[(Ie)_dotfiles_set_prompt]} == 0 )); then
  precmd_functions+=(_dotfiles_set_prompt)
fi

_dotfiles_set_prompt

if [[ -n $SSH_CONNECTION ]]; then
  export EDITOR='vim'
else
  export EDITOR='nvim'
fi

export PATH="$PATH:$HOME/.local/bin"

eval "$(zoxide init zsh)"
eval "$($HOME/.local/bin/mise activate zsh)"

alias cd="z"
alias lta="lt -a"
alias ff="fzf --preview 'bat --style=numbers --color=always {}'"
alias fd="fdfind"
alias lsa="ls -a"
alias lt="eza --tree --level=2 --long --icons --git"
alias ls="eza -lh --group-directories-first --icons"
alias la="ls -a"

tmux() {
  local sessionizer="$HOME/.config/tmux/tmux-sessionizer"
  local restore_script="$HOME/.config/tmux/plugins/tmux-resurrect/scripts/restore.sh"
  local no_auto_restore_file="$HOME/tmux_no_auto_restore"

  if [[ $# -gt 0 ]]; then
    command tmux "$@"
    return
  fi

  if [[ -n $TMUX ]]; then
    if [[ -x "$sessionizer" ]]; then
      "$sessionizer" "$(pwd -P)"
    else
      command tmux switch-client -n
    fi
    return
  fi

  if ! command tmux has-session 2>/dev/null; then
    if [[ -f "$restore_script" && ! -f "$no_auto_restore_file" ]]; then
      command tmux start-server
      bash "$restore_script" >/dev/null 2>&1 || true
    fi
  fi

  if command tmux has-session 2>/dev/null; then
    command tmux attach-session 2>/dev/null && return
  fi

  if [[ -x "$sessionizer" ]]; then
    "$sessionizer" "$(pwd -P)"
  else
    command tmux new-session -s home -c "$(pwd -P)"
  fi
}

export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"                   # This loads nvm
[ -s "$NVM_DIR/bash_completion" ] && \. "$NVM_DIR/bash_completion" # This loads nvm bash_completion

# bun
export BUN_INSTALL="$HOME/.bun"
export PATH="$BUN_INSTALL/bin:$PATH"

export FLYCTL_INSTALL="/home/ibanks/.fly"
export PATH="$FLYCTL_INSTALL/bin:$PATH"

# bun completions
[ -s "/home/ibanks/.bun/_bun" ] && source "/home/ibanks/.bun/_bun"


# Added by LM Studio CLI tool (lms)
export PATH="$PATH:/home/server/.lmstudio/bin"

# pnpm
export PNPM_HOME="/home/server/.local/share/pnpm"
case ":$PATH:" in
  *":$PNPM_HOME:"*) ;;
  *) export PATH="$PNPM_HOME:$PATH" ;;
esac
# pnpm end

