# quick-archive

OpenCode Desktop GUI plugin: hover a session in the left sidebar and click the archive icon to
archive it in one click. Clicks can be mashed — rows hide immediately and are archived in order.

## How it works

The plugin never identifies sessions or calls the API itself. Clicking the icon opens the row's own
context menu (invisibly) and selects its native **Archive** item, so OpenCode archives exactly that
row through its own code path (row removal, tab closing, Archived section).

- One fixed-position overlay button on `<body>`; nothing is inserted into the app's lists.
- The only attribute set on app nodes is `data-qa-pending` while a row is queued (hides it).
- If a row has no Archive item, it reappears and an error toast is shown. If the app hasn't removed
  an archived row after 4s, it reappears.

## Build / enable

```sh
bun install
bun run build      # dist/gui-experimental.cjs (the app hot-reloads on rebuild)
```

Enabled via `~/.config/opencode/opencode.jsonc`:

```jsonc
"plugins": ["{env:HOME}/dotfiles/opencode-plugins/quick-archive"]
```

## Limitations

- Relies on OpenCode 2.3.0 sidebar markup (`#vertical-tabs-sidebar`, `[data-slot="sidebar-inbox-item"]`,
  project/tab rows) and an English "Archive" menu label. Tested live on the Inbox layout.
- No undo toast; restore from the sidebar's **Archived** section.
