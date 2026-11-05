# Local intercom

Message named Codex, Claude Code, and OpenCode sessions in the current hc space. Names come from each CLI's `/rename`; sending requires an exact, unique name.

Discovery lists sessions open in that space, including idle ones. Historical saved conversations are not additional recipients. Every Codex candidate must appear in the local app-server's read-only `thread/loaded/list`, even if its saved name is unique or it has a cached hc binding. Saved records supply names only. With no loaded match, the session is absent; with unavailable live evidence or multiple loaded matches, discovery fails closed. Historical records and cached bindings never provide a fallback recipient. This uses the native Unix control socket and the Python standard library; no model request is made.

## Using another machine

Pull this checkout on the server and install the command/skills once:

```sh
git -C ~/dotfiles pull
python3 ~/dotfiles/intercom/install.py
intercom list
```

The runtime uses Python 3's standard library plus the installed `hc` and destination CLI executables. Authenticate those CLIs on that machine. Run intercom from an agent in a Herdr-managed hc space, with session names set using `/rename`. Keep `~/.local/bin` on PATH.

The installer links `~/.local/bin/intercom` to the checkout and installs the shared skill into `~/.agents/skills/intercom` (Codex/OpenCode) and `~/.claude/skills/intercom` (Claude/OpenCode), so projects outside dotfiles can discover it. Re-running is safe; existing different files/links are backed up under `~/.backup/dotfiles/`. These links persist across reboots. The repository's `.claude/skills/intercom` remains a relative compatibility symlink for this project.

For an existing session that has not discovered the new skill, have it read `~/.claude/skills/intercom/SKILL.md` or `~/.agents/skills/intercom/SKILL.md`. Do not substitute `pi-intercom`: that is a separate Pi-only integration with a different registry and broker.

Session IDs, validated hc bindings, sockets, CLI logins, and mailbox state are local to each machine; do not copy them from this computer. Native calls currently require the locally installed CLI versions/APIs described below. Remote terminals are excluded: execute the CLI on the server to address that server's hc space.

```sh
python3 intercom/intercom.py list
python3 intercom/intercom.py send claude-test 'Check the retry policy'
python3 intercom/intercom.py send oc-test 'Review this finding'
python3 intercom/intercom.py reply MESSAGE_ID 'Your answer'
python3 intercom/intercom.py wait MESSAGE_ID --timeout 30
python3 intercom/intercom.py inbox
```

The sender is inferred from `HC_TERMINAL_ID` and its native session. There is no `--sender` override, alias registration, terminal-ID addressing, or global-name fallback. Run these commands inside the agent's hc terminal. `list` shows the inferred self, current scope, and named sessions.

Codex is an exception to trusting the terminal environment: its shared daemon can give a tool another TUI's inherited `HC_TERMINAL_ID`. Intercom first binds the invocation's `CODEX_THREAD_ID` to a unique live local Codex terminal, then selects that terminal's space. A missing or ambiguous native binding fails; it never falls back to the stale terminal value. This fixes rc2fx tools incorrectly identifying as `codex-test` in the dotfiles space.

Once positively established, that binding is registered in hc labels keyed by native thread ID, foreground process ID, and terminal creation identity. It survives unrecognized transient titles and lagging agent-status reports. A changed foreground process invalidates it; a title that positively identifies another native thread supersedes it. Scope is always read from the current live terminal, never cached. Binding failures include the invocation thread and rejected candidates. The later intermittent rc2fx failures were confirmed in its transcript but lacked candidate diagnostics; the historical cause could not be proven. The transient-title failure was reproduced in a regression and fixed, and the existing live rc2fx process was registered without restarting it.

## Scope and identity

The namespace is the hc core's permanent identity, `HC_SESSION` (default when unset), and the caller terminal's `herdr.space` label. Discovery excludes other spaces and remote terminals. Without a known live local hc terminal and space, commands fail. The implementation currently depends on Herdr's space labels; a plain hc terminal without them has no supported scope.

Only live terminals in that namespace are considered. Claude identity/name/socket come from its PID-matched native session registry. OpenCode's terminal title is matched to an exact native session title and cwd through its API. Codex's terminal title is matched to the persisted native `/rename` name and cwd. Ambiguous native bindings or duplicate names in the space fail instead of selecting a candidate. These local metadata bindings may need additional adapters for future CLI versions.

OpenCode internal tabs are also discoverable. Its saved `latest/tui/tabs.json` supplies the tab IDs for the terminal's directory, anchored by the live selected session. Every tab's current title and cwd are checked through the native API. This binding is accepted only when exactly one live OpenCode terminal owns that directory across the core; a second TUI in another space makes the shared tab state ambiguous and causes refusal, not expanded discovery. A future per-TUI registration plugin can remove that limitation. Global/beta tab stores are not yet supported.

For replies and waits, the message's native recipient/sender identity selects the calling OpenCode tab, checked against the caller's terminal and scope. For new sends from model tools, a unique currently executing tab selects the sender; multiple working tabs make sender inference ambiguous and cause refusal. With no executing tab, the selected tab is the caller. This prevents an inactive tab's reply from being mislabeled as the selected tab.

Each message stores the namespace, names at send time, and sender/recipient native identities. Replies require the caller to be the original recipient in that namespace and the original sender still to be present there. Renaming does not redirect a reply to a different session reusing the old name. Inbox and wait are restricted to the calling native identity and scope.

## Delivery

Claude uses its built-in Unix inbox socket, with the destination session ID guarding against session drift. OpenCode uses `/api/session/{ID}/synthetic` with explicit queue delivery, peer description, and correlation metadata. Codex uses `codex queue`. There is no terminal typing, paste, or hc send. hc provides discovery and scope only.

The shared [intercom skill](../.agents/skills/intercom/SKILL.md) defines collaboration within the user's assigned work and normal permission boundaries. Claude discovers it through `.claude/skills/intercom`; OpenCode can load it through its native skill API. The skill permits ordinary relevant peer requests without treating a peer as user approval.

SQLite messages live in `~/.local/state/intercom/scoped-mail.sqlite`; set `INTERCOM_STATE_DIR` for isolated testing. The earlier manual-alias MVP's `mail.sqlite` is retained as historical evidence and is not consulted for routing. Native admission means `submitted`; an explicit correlated reply advances the original message to `replied`. Transport timeouts persist `delivery_unknown` and are never automatically retried.

## Verification

The live dotfiles hc space resolved exactly `codex-test`, `claude-test`, and `oc-test`. Named sends returned `NAMED_CLAUDE_ACK_6284` and `NAMED_OC_ACK_6284` to the native `codex-test` queue, with matching message IDs, native identities, and scope. Both peers inferred their sender names without overrides. Before named discovery was added, a direct Claude → OpenCode → Claude round trip also passed through the native adapters.

```sh
python3 -m unittest discover -s intercom -p test_scope.py
```

Sixteen tests cover sole-historical/cached-name exclusion and unavailable-live-evidence refusal, plus persistent installation/backups, reboot-created duplicate Codex names, and scope isolation, unknown scope refusal, exact/ambiguous names, identity after rename, ambiguous delivery without retry, inactive-tab reply identity, working-tab sender inference, multiple-TUI ownership refusal, saved-tab anchor/directory validation, stale daemon terminal context, unknown/duplicate native caller rejection, and registered binding through transient title/status plus process/session replacement. Live model calls are separate from these tests. Live internal-tab tests returned `INACTIVE_TAB_ACK_7308` from `oc-test` and `ACTIVE_TAB_ACK_7308` from `oc-test1`, each correlated to the right named/native session. A read-only live-inventory replay with rc2fx's native thread ID and stale `HC_TERMINAL_ID=t21` correctly returned `orchestrator` in rc2fx with `thinker` present and dotfiles peers excluded.

Current limits: remote delivery is excluded; discovery/session routing is not an atomic transaction across hc and native CLIs; there is no automatic deduplication, retention, or process-restart reconciliation. Same-user local processes are trusted; this is not an authentication boundary against another program running as your OS user. Native session permission controls remain in force.

References: [Claude inbox socket](https://code.claude.com/docs/en/cross-session-messaging#the-sessions-inbox-socket), [OpenCode v2 API](https://dev.opencode.ai/v2/docs/api), [Codex queue](https://learn.chatgpt.com/docs/developer-commands).

After-reboot verification: the installed command, invoked outside the checkout using the rc2fx UI caller context, resolved `ui`, `general`, `orchestrator`, and `thinker`, excluding dotfiles sessions. The restored native orchestrator was selected over its historical duplicate. Run all checks with `python3 -W error::ResourceWarning -m unittest discover -s intercom -p "test_*.py"`.
