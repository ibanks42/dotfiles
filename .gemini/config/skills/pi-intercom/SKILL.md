---
name: pi-intercom
description: >-
  Connects Antigravity (agy) to the local pi-intercom broker so agy and Pi
  terminal sessions can discover and message each other asynchronously. Activate
  this skill whenever the user mentions intercom, pi-intercom, /intercom,
  /alias, or wants agy to communicate with, listen for, or reply to a Pi coding
  agent session.
---

# Pi Intercom Bridge for Antigravity (`agy`)

This skill connects the current `agy` session to the local `pi-intercom` broker using [agy-intercom.ts](./scripts/agy-intercom.ts). Sessions are only registered after the user runs `/alias <name>` (see [alias skill](../alias/SKILL.md)) and always use the exact `<name>` the user specified.

## Core Commands

Always invoke the helper script directly (it uses the local `tsx` loader in its shebang—do **not** prefix with `npx tsx`), and always pass `--name <alias>` with the alias set via `/alias <name>`:

```bash
~/.gemini/config/skills/pi-intercom/scripts/agy-intercom.ts <command> --name <alias> [options]
```

## Listening

Once `/alias <name>` has run, the listener stays on by itself for the whole session, including during your turns. Inside Herdr (`$HERDR_PANE_ID` is set) it types each incoming message into this pane as a new prompt. Do **not** run `wait` in Herdr, and never "re-arm" or restart the listener after a message or a turn.

### Available Subcommands

- **Wait for Next Incoming Message from Pi** (only outside Herdr, where messages can't be typed into the pane):
  ```bash
  ~/.gemini/config/skills/pi-intercom/scripts/agy-intercom.ts wait --name <alias>
  ```
- **Rename Session (`/alias <new-alias>`)**:
  ```bash
  ~/.gemini/config/skills/pi-intercom/scripts/agy-intercom.ts alias --name <current-alias> --new-name <new-alias>
  ```
- **List Connected Intercom Sessions**:
  ```bash
  ~/.gemini/config/skills/pi-intercom/scripts/agy-intercom.ts list --name <alias>
  ```
- **Reply to the Last Sender** (preserves `replyTo` threading for Pi's `ask`/`send`):
  ```bash
  ~/.gemini/config/skills/pi-intercom/scripts/agy-intercom.ts reply --name <alias> --text "<message>"
  ```
- **Send a Message to a Pi Session** (fire-and-forget by `/alias` name or session ID):
  ```bash
  ~/.gemini/config/skills/pi-intercom/scripts/agy-intercom.ts send --name <alias> --to <pi-alias> --text "<message>"
  ```
- **Ask a Pi Session a Clarifying Question and Wait for Reply** (blocking):
  ```bash
  ~/.gemini/config/skills/pi-intercom/scripts/agy-intercom.ts ask --name <alias> --to <pi-alias> --text "<question>"
  ```
- **Disconnect from Intercom**:
  ```bash
  ~/.gemini/config/skills/pi-intercom/scripts/agy-intercom.ts stop --name <alias>
  ```
