---
name: alias
description: >-
  Sets the pi-intercom session alias for the current Antigravity (agy) session
  (just like /alias in Pi) and immediately starts the background pi-intercom
  listener under that alias. Invoke via `/alias <name>`.
---

# `/alias` — Set Intercom Alias & Start Listener

When the user runs `/alias <name>` (for example, `/alias router-agy` or `/alias worker`):

1. **Determine the Alias Name**:
   - Extract `<name>` from the user's message following `/alias`.
   - If the user only typed `/alias` without a name, ask them what alias name they want to use for this session.

2. **Start the Intercom Bridge Under That Exact Alias**:
   - Run synchronously (`WaitMsBeforeAsync: 5000`):
     ```bash
     ~/.gemini/config/skills/pi-intercom/scripts/agy-intercom.ts start --name <name>
     ```
   - Because this session runs inside Herdr (`$HERDR_PANE_ID`), the `agy-intercom.ts` daemon automatically registers `<name>` (`antigravity [idle]`) in Pi's `/intercom` roster and injects incoming Intercom messages directly into this Herdr pane via `herdr pane send-text` + `herdr pane send-keys`.

3. **Confirm & End Turn**:
   - Briefly tell the user that this session is now registered in `/intercom` as **`<name>`**.
