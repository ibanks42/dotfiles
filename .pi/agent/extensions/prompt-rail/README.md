# Prompt rail for Pi

Local, globally discovered Pi extension, modeled on
`.opencode/ui-plugins/prompt-rail-prototype/`. No install or build step.
Run `/reload` in an existing Pi session, or start a new one.

## Controls

- **Click ≡ Prompts** or run **`/prompt-jump`**: search all prompts on the current branch.
  Type words to filter; ↑/↓ choose; Enter jumps to a live prompt; Esc cancels.
  `[history]` marks prompts removed from the live transcript by compaction;
  Enter opens those in the saved-history viewer instead.
- **Saved history:** an opaque, bordered, read-only prompt/reply viewer.
  ↑/↓, PgUp/PgDn, Home/End, or the mouse wheel scroll; Esc closes.
- **`/prompt-latest`**: return to live output and resume following it
  (Pi's own "Jump to latest message" indicator does the same).
- **`/prompt-rail`**: toggle the Prompts button for this extension runtime.

The button is a single-row, non-focus-capturing overlay at the transcript's
top-right, inside the native scrollbar. It does not replace the editor,
header, footer, or native scrolling. It covers a few transcript columns on
one row; toggle it off when needed.
The picker and history reader paint every cell, including blank lines, so
underlying transcript text cannot show through. Both use visible borders.

## Limits and safety

Direct transcript jumps require **fullscreen Pi** (already enabled in this
configuration). The button hides below 40 columns or 8 rows, or when the
branch has no prompts; `/prompt-jump` remains available.

Pi has no public extension `jumpToMessage()` API. `navigation.ts` isolates a
feature-detected compatibility seam to the fullscreen renderer's last layout.
It identifies rendered `UserMessageComponent` instances and measures their
positions at the transcript's actual content width, then performs one scroll
operation. OSC 133 boundaries are deliberately not used to identify prompts:
Pi also adds them to assistant replies. There are no repeated synthetic keys.
Tested against Pi **1.4.0**, including its actual user/assistant components,
fullscreen layout, mouse dispatch, stable TUI proxy, and bundled CLI.
Pi upgrades may require adapting that seam.

The picker reads the full current session branch, not abandoned branches or a
separate prompt database. Live navigation indexes Pi's compaction-aware context,
not the full saved branch. Prompts compacted out of that context open a separate
read-only history view containing the original prompt and saved assistant text
(no thinking or tool results). This never restores old messages into model context
or changes the live transcript. If the live renderer itself is incompatible
(for example, an unsupported image-only message), it warns rather than guessing.

Nothing resends prompts, edits the editor, navigates the session tree, changes
model context, stores prompt history, or makes network requests. Previews strip
terminal escapes and use the active theme. Overlays and input listeners are
removed on toggle, reload, shutdown, and session replacement.

## Checks

```bash
bash .pi/agent/extensions/prompt-rail/check.sh
```

Runs tests against installed Pi dependencies using an isolated temporary copy,
bundled-CLI PTY smoke tests with normal and compacted synthetic history (no model calls), then strict
TypeScript checking when the same installation contains TypeScript.
Set `PI_NODE_MODULES` if Pi's dependencies live somewhere other than
`~/.bun/install/global/node_modules`.

To remove, delete or move this directory, then `/reload`.
