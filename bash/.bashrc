# Shared bash config (tracked in ~/dotfiles/bash/.bashrc, linked to ~/.bashrc).
# Put anything specific to one machine in ~/.bashrc.local (not in git).
# PATH and exports live in ~/.shellenv.

[ -f /etc/bashrc ] && . /etc/bashrc
[ -r "$HOME/.shellenv" ] && . "$HOME/.shellenv"
case ":$PATH:" in *":$HOME/go/bin:"*) ;; *) PATH="$HOME/go/bin:$PATH" ;; esac

# Everything below is for interactive shells only.
[[ $- == *i* ]] || return

# Folder this file really lives in (follows the ~/.bashrc symlink).
_dotbash="$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")"

[ -f "$HOME/.cargo/env" ] && . "$HOME/.cargo/env"

if [[ -n $SSH_CONNECTION ]]; then
  export EDITOR=vim
else
  export EDITOR=nvim
fi
export SUDOEDITOR=vim

# Herdr remote attaches lack SSH markers; forward Pi copies to the client clipboard.
[[ ${HERDR_ENV:-} == 1 ]] && export PI_CLIPBOARD_OSC52=1

# ── Shell options and history ───────────────────────────────────────────
shopt -s histappend checkwinsize
HISTFILE=~/.bash_history HISTSIZE=50000 HISTFILESIZE=50000
HISTCONTROL=ignoredups
bind 'set bell-style none'

# ── Aliases ─────────────────────────────────────────────────────────────
alias ls="eza -lh --group-directories-first --icons always"
alias la="ls -a"
alias lsa="ls -a"
alias lt="eza --tree --level=2 --long --icons --git"
alias lta="lt -a"
alias ff="fzf --preview 'bat --style=numbers --color=always {}'"
command -v fd  >/dev/null || alias fd=fdfind
command -v bat >/dev/null || alias bat=batcat
alias ..="cd .."
alias ...="cd ../.."
alias ....="cd ../../.."

# ── Completions ─────────────────────────────────────────────────────────
# bash-completion supplies every per-command completion (mise, git, docker...,
# including ~/.local/share/bash-completion/completions). Fedora's /etc/bashrc
# loads it for every shell, but Ubuntu only loads it from /etc/profile (login
# shells). Load it here so both behave the same.
if [[ -z ${BASH_COMPLETION_VERSINFO:-} ]] && [ -r /usr/share/bash-completion/bash_completion ]; then
  . /usr/share/bash-completion/bash_completion
fi
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
[ -s "$NVM_DIR/bash_completion" ] && . "$NVM_DIR/bash_completion"
if command -v rbw >/dev/null; then
  eval "$(rbw gen-completions bash)"
  . "$_dotbash/rbw-completion.sh"
fi

# fzf-tab-completion (github.com/lincheney/fzf-tab-completion), vendored.
if command -v fzf >/dev/null && [ -r "$_dotbash/fzf-bash-completion.sh" ]; then
  . "$_dotbash/fzf-bash-completion.sh"
  bind -x '"\t": fzf_bash_completion'
fi

# ── Prompt and tool hooks ───────────────────────────────────────────────
command -v starship >/dev/null && eval "$(starship init bash)"
[ -x "$HOME/.local/bin/mise" ] && eval "$("$HOME/.local/bin/mise" activate bash)"

# zoxide replaces `cd` in your own terminals only. Agent shells (Claude Code sets
# CLAUDECODE=1) get the plain builtin cd, so they never see zoxide warnings.
if [[ -z ${CLAUDECODE:-} ]] && command -v zoxide >/dev/null; then
  eval "$(zoxide init bash --cmd cd)"
fi

# Show the cursor again before each prompt, in case a program (pi, nvim, a TUI
# that crashed) exited with the cursor still hidden. Added last, as its own
# PROMPT_COMMAND entry, so starship's rewrite doesn't drop it. Keeps $?.
_show_cursor() { local s=$?; printf '\e[?25h'; return $s; }
PROMPT_COMMAND+=(_show_cursor)

# User snippets, then machine-specific settings (last, so they can override anything).
if [ -d ~/.bashrc.d ]; then
  for rc in ~/.bashrc.d/*; do [ -f "$rc" ] && . "$rc"; done
  unset rc
fi
[ -f "$HOME/.bashrc.local" ] && . "$HOME/.bashrc.local"
unset _dotbash

# Flyline (github.com/HalFrgrd/flyline) replaces readline; only where it's installed.
# Suggestions open on Tab only, not while typing.
if enable flyline 2>/dev/null || { [ -r "$HOME/.local/lib/libflyline.so" ] &&
  enable -f "$HOME/.local/lib/libflyline.so" flyline; }; then
  flyline suggestions --auto-suggest false
fi
