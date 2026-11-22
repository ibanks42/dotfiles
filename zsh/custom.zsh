# Aliases, env, and tool init (starship, zoxide, mise) for zsh. Sourced by ~/.zshrc.

. "$HOME/.cargo/env"

if [[ -n $SSH_CONNECTION ]]; then
  export EDITOR='vim'
else
  export EDITOR='nvim'
fi


alias lta="lt -a"
alias ff="fzf --preview 'bat --style=numbers --color=always {}'"
alias fd="fdfind"
alias lsa="ls -a"
alias lt="eza --tree --level=2 --long --icons --git"
alias ls="eza -lh --group-directories-first --icons always"
alias la="ls -a"
if ! command -v bat &> /dev/null; then
  alias bat="batcat"
fi

alias ".."="cd .."
alias "..."="cd ../.."
alias "...."="cd ../../.."

# nvm
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"
[ -s "$NVM_DIR/zsh_completion" ] && \. "$NVM_DIR/zsh_completion"


# bun completions
[ -s "$BUN_INSTALL/_bun" ] && source "$BUN_INSTALL/_bun"


# opencode
[[ -d $HOME/.opencode/bin ]] && export PATH="$HOME/.opencode/bin:$PATH"

if [[ $- == *i* ]]; then
  eval "$(starship init zsh)"
fi

eval "$($HOME/.local/bin/mise activate zsh)"

export PATH="$HOME/go/bin:$PATH"

# zoxide replaces `cd` in your own terminals only. Agent shells (Claude Code sets
# CLAUDECODE=1) get the plain builtin cd, so they never see zoxide warnings.
if [[ -o interactive && -z ${CLAUDECODE:-} ]]; then
  eval "$(zoxide init zsh --cmd cd)"
fi
