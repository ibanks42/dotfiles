# Extra rbw completions, layered over `rbw gen-completions bash` (_rbw_wrapper).
# The generated script offers filenames for --field/--folder and nothing for entry
# names. This fills in:
#   --field/-f   rbw's field names (rbw rejects anything else)
#   --folder     your folders           (rbw list --fields folder)
#   entry name   for get/code/edit/remove/history (rbw list)
# Vault lookups only run when the agent is already unlocked, so Tab never pops up
# pinentry, and only `rbw list` is used: it prints names, never secrets.

_rbw_fields="username password totp notes uris name email phone title first_name
middle_name last_name address address1 address2 address3 city state postcode country
identityname ssn license passport number exp exp_month exp_year cvv cardholder brand
fingerprint public_key private_key"

# Prints vault values (one per line) for `rbw list --fields $1`, if unlocked.
_rbw_vault_list() {
  rbw unlocked >/dev/null 2>&1 || return 1
  rbw list --fields "$1" 2>/dev/null | sort -u
}

# Fills COMPREPLY with the lines of stdin (feed it with < <(...), not a pipe,
# or COMPREPLY is set in a subshell and lost) that start with $1 (names can have spaces).
_rbw_reply_prefix() {
  local line
  COMPREPLY=()
  while IFS= read -r line; do
    [[ -n $line && $line == "$1"* ]] && COMPREPLY+=("$line")
  done
  # Let readline quote spaces in names; never fall back to filenames.
  compopt -o filenames +o default +o bashdefault 2>/dev/null
}

_rbw_more() {
  local cur=${COMP_WORDS[COMP_CWORD]} prev=${COMP_WORDS[COMP_CWORD - 1]}
  local sub=${COMP_WORDS[1]} word=${cur#[\"\']}

  case $prev in
    -f | --field)
      [[ $sub == get ]] || { _rbw_wrapper "$@"; return; }
      COMPREPLY=($(compgen -W "$_rbw_fields" -- "$word"))
      compopt +o default +o bashdefault 2>/dev/null
      return
      ;;
    --folder)
      _rbw_reply_prefix "$word" < <(_rbw_vault_list folder)
      return
      ;;
  esac

  # First positional argument (the entry) of these subcommands.
  case $sub in
    get | code | totp | edit | remove | rm | history)
      if [[ $COMP_CWORD -ge 2 && $cur != -* ]]; then
        local i positional=0
        for ((i = 2; i < COMP_CWORD; i++)); do
          case ${COMP_WORDS[i]} in
            --folder | -f | --field) ((i++)) ;; # skip the option's value
            -*) ;;
            *) ((positional++)) ;;
          esac
        done
        if ((positional == 0)); then
          _rbw_reply_prefix "$word" < <(_rbw_vault_list name)
          return
        fi
      fi
      ;;
  esac

  _rbw_wrapper "$@"
}

complete -F _rbw_more -o nosort -o bashdefault -o default rbw
