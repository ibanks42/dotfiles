#!/usr/bin/env bash
# Copy stdin to the local system clipboard via OSC 52.
#
# tmux's own OSC 52 re-emission is dropped by mosh (tmux/tmux#3423, closed
# wontfix), so we bypass it: the sequence is wrapped in tmux's DCS
# passthrough wrapper, which tmux unwraps and forwards verbatim to the
# outer terminal (mosh or ssh) — byte-identical to a sequence sent outside
# tmux, which mosh handles fine.
#
# Used by tmux's copy-command and by nvim's OSC 52 clipboard provider.
# Also mirrors the text into the tmux paste-buffer so `tmux save-buffer`
# (nvim's paste provider) can read back what was last copied.

tmp=$(mktemp)
trap 'rm -f "$tmp"' EXIT
cat > "$tmp"
b64=$(base64 -w0 < "$tmp")

if [[ -n $TMUX ]]; then
    tmux load-buffer - < "$tmp"
    tty=$(tmux display -p '#{client_tty}')
    printf '\033Ptmux;\033\033]52;c;%s\033\\' "$b64" > "$tty"
else
    printf '\033]52;c;%s\007' "$b64" > /dev/tty
fi
