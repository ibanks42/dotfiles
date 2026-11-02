# Aliases, env, and tool init (starship, zoxide, mise) for zsh. Sourced by ~/.zshrc.

. "$HOME/.cargo/env"

if [[ -n $SSH_CONNECTION ]]; then
  export EDITOR='vim'
else
  export EDITOR='nvim'
fi

export PATH="$PATH:$HOME/.local/bin"

alias cd="z"
alias lta="lt -a"
alias ff="fzf --preview 'bat --style=numbers --color=always {}'"
alias fd="fdfind"
alias lsa="ls -a"
alias lt="eza --tree --level=2 --long --icons --git"
alias ls="eza -lh --group-directories-first --icons always"
alias la="ls -a"
alias bat="batcat"

alias ".."="cd .."
alias "..."="cd ../.."
alias "...."="cd ../../.."

# nvm
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"
[ -s "$NVM_DIR/zsh_completion" ] && \. "$NVM_DIR/zsh_completion"

# bun
export BUN_INSTALL="$HOME/.bun"
export PATH="$BUN_INSTALL/bin:$PATH"

# bun completions
[ -s "$BUN_INSTALL/_bun" ] && source "$BUN_INSTALL/_bun"

# flyctl
export FLYCTL_INSTALL="$HOME/.fly"
[[ -d $FLYCTL_INSTALL/bin ]] && export PATH="$FLYCTL_INSTALL/bin:$PATH"

# pnpm
export PNPM_HOME="$HOME/.local/share/pnpm"
case ":$PATH:" in
  *":$PNPM_HOME:"*) ;;
  *) export PATH="$PNPM_HOME:$PATH" ;;
esac

# opencode
[[ -d $HOME/.opencode/bin ]] && export PATH="$HOME/.opencode/bin:$PATH"

if [[ $- == *i* ]]; then
  eval "$(starship init zsh)"
fi

eval "$(zoxide init zsh)"
eval "$($HOME/.local/bin/mise activate zsh)"

# Apply reviewed Pi patches after extension updates.
export PATH="$HOME/.local/share/pi-launcher/bin:$PATH"

