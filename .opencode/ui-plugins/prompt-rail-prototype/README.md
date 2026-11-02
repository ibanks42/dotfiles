# Prompt rail — local prototype

A hoverable prompt minimap on the transcript side of OpenCode's sidebar.
Loaded globally through `~/.config/opencode/cli.json`; no build/install needed.

- Hover a tick: preview the user prompt and its latest assistant text.
- Click a tick: jump directly to that prompt. A grouped tick opens a range picker.
- Click `≡` or use `/prompt-jump`: open a searchable, navigation-only prompt picker.
  Selecting a prompt closes the picker and jumps; no message-actions menu.
- Click `↓`: return to the latest output.
- `/prompt-rail`: toggle the rail for this TUI instance.

The sidebar must be visible (Ctrl+X, then B). The rail uses the current theme.
User prompts are read from the connected OpenCode server, including older
history. Reply previews use already-loaded assistant messages. On short
terminals or long sessions, up to 26 ticks divide prompts into contiguous
ranges. Every prompt remains reachable through its range or the full picker.
For 100 prompts on a tall terminal, each tick covers roughly four prompts.
The highlighted tick is the last clicked prompt, not a live scroll position.

OpenCode has no public `jumpToMessage(id)` API. `navigation.ts` isolates a
compatibility bridge to the host's render tree and history loader. Mounted
messages align in one scroll operation. An unmounted target first loads
older pages as far as the target and uses one native latest-user command to mount the transcript,
then aligns the target directly. This first preparation may briefly show
the latest prompt, but never walks backward through intervening prompts.
History loading/mounting can be expensive in huge transcripts (thousands
of tool rows); the rail itself stays bounded, not the host transcript.
An incompatible host produces a warning instead of silently stepping.
Another click, toggling the plugin, switching sessions or unloading cancels
a pending jump. OpenCode updates may require adapting this internal bridge.
There is no transcript mutation, third-party request or stored prompt history.

The built-in `/timeline` command is unchanged; only this plugin's picker
is navigation-only.

Checks: `bun test ./.opencode/ui-plugins/prompt-rail-prototype/navigation.test.ts`.

To remove: delete this plugin's entry from `~/.config/opencode/cli.json`.
The independent Alt+PageUp / Alt+PageDown keybindings remain unchanged.
