/** @jsxImportSource @opentui/solid */
// Prototype: does a hoverable prompt minimap beside the sidebar feel useful?
import { Plugin, usePlugin } from "@opencode/plugin/tui";
import { useTerminalDimensions } from "@opentui/solid";
import type { SessionMessageUser } from "@opencode/client";
import { createEffect, createMemo, createSignal, For, onCleanup, Show } from "solid-js";
import { jumpDirect, promptRanges } from "./navigation";

type Anchor = { readonly x: number; readonly isDestroyed: boolean };

export default Plugin.define({
  id: "local.prompt-rail-prototype",
  setup(context) {
    const [enabled, setEnabled] = createSignal(true);
    const [anchor, setAnchor] = createSignal<Anchor>();
    context.keymap.layer(() => ({
      commands: [{
        id: "prompt-rail.toggle",
        title: "Toggle prompt rail (prototype)",
        group: "Session",
        palette: true,
        slash: { name: "prompt-rail" },
        run: () => { setEnabled((value) => !value); },
      }],
    }));
    context.ui.slot({
      prepend: "sidebar.content",
      render: () => {
        onCleanup(() => setAnchor(undefined));
        return <box height={0} ref={setAnchor} />;
      },
    });
    context.ui.slot({
      append: "app",
      render: () => <PromptRail enabled={enabled()} anchor={anchor()} />,
    });
  },
});

function PromptRail(props: { enabled: boolean; anchor?: Anchor }) {
  const ctx = usePlugin();
  const dimensions = useTerminalDimensions();
  const [left, setLeft] = createSignal<number>();
  const [hovered, setHovered] = createSignal<number>();
  const [selected, setSelected] = createSignal<string>();
  const [jumping, setJumping] = createSignal(false);
  let generation = 0;
  let navigationAbort: AbortController | undefined;
  const cancelJump = () => {
    generation++;
    navigationAbort?.abort();
    setJumping(false);
  };
  const sessionID = createMemo(() => {
    const route = ctx.ui.router.current();
    return route.type === "session" ? route.sessionID : undefined;
  });
  const messages = createMemo(() => {
    const id = sessionID();
    if (!id) return [];
    const all = ctx.data.session.message.list(id) ?? [];
    const revert = ctx.data.session.get(id)?.revert?.messageID;
    const end = revert ? all.findIndex((message) => message.id === revert) : -1;
    return end < 0 ? all : all.slice(0, end);
  });
  const [history, setHistory] = createSignal<{ sessionID: string; users: SessionMessageUser[] }>();
  const userVersion = createMemo(() => messages().filter((message) => message.type === "user").map((message) => message.id).join(","));
  createEffect(() => {
    const id = sessionID();
    userVersion();
    if (!id || !props.enabled) return;
    const abort = new AbortController();
    onCleanup(() => abort.abort());
    void (async () => {
      const users: SessionMessageUser[] = [];
      let cursor: string | undefined;
      const seen = new Set<string>();
      do {
        const page = await ctx.client.message.list({
          sessionID: id, type: "user", limit: 100,
          ...(cursor ? { cursor } : { order: "asc" as const }),
        }, { signal: abort.signal });
        for (const message of page.data) if (message.type === "user") users.push(message);
        cursor = page.cursor.next ?? undefined;
        if (cursor && seen.has(cursor)) throw new Error("Repeated prompt history cursor");
        if (cursor) seen.add(cursor);
      } while (cursor);
      if (!abort.signal.aborted) setHistory({ sessionID: id, users });
    })().catch(() => {
      // The currently loaded transcript remains usable if the history read fails.
      if (!abort.signal.aborted) ctx.ui.toast.show({ message: "Prompt rail: older prompts could not be loaded", variant: "warning" });
    });
  });
  const prompts = createMemo(() => {
    const saved = history();
    const users = new Map<string, SessionMessageUser>();
    if (saved && saved.sessionID === sessionID()) for (const message of saved.users) users.set(message.id, message);
    for (const message of messages()) if (message.type === "user") users.set(message.id, message);
    const id = sessionID();
    const revert = id ? ctx.data.session.get(id)?.revert?.messageID : undefined;
    return [...users.values()].filter((message) => message.text.trim() && (!revert || message.id < revert));
  });
  const height = () => Math.max(1, Math.min(26, dimensions().height - 10));
  const markers = createMemo(() => promptRanges(prompts().length, height()));
  const hoveredPrompt = () => {
    const index = hovered();
    return index === undefined ? undefined : prompts()[index];
  };
  const preview = createMemo(() => {
    const prompt = hoveredPrompt();
    if (!prompt || prompt.type !== "user") return undefined;
    const list = messages();
    const start = list.findIndex((message) => message.id === prompt.id);
    const following = start < 0 ? [] : list.slice(start + 1);
    const end = following.findIndex((message) => message.type === "user");
    const turn = end < 0 ? following : following.slice(0, end);
    const reply = turn.filter((message) => message.type === "assistant").at(-1);
    return {
      prompt: clean(prompt.text).slice(0, 320),
      reply: reply?.type === "assistant"
        ? clean(reply.content.filter((part) => part.type === "text").map((part) => part.text).join(" ")).slice(0, 240)
        : "",
    };
  });
  const updateAnchor = () => {
    const node = props.anchor;
    const x = node && !node.isDestroyed ? node.x - 4 : undefined;
    setLeft(x !== undefined && x > 10 && x < dimensions().width - 2 ? x : undefined);
  };
  createEffect(updateAnchor);
  // Layout coordinates aren't reactive. Track sidebar resizes without inspecting host internals.
  const layoutTimer = setInterval(updateAnchor, 200);
  onCleanup(() => { clearInterval(layoutTimer); cancelJump(); });
  createEffect(() => {
    sessionID();
    props.enabled;
    cancelJump();
    setHovered(undefined);
    setSelected(undefined);
  });

  const jump = async (index: number) => {
    const prompt = prompts()[index];
    if (!prompt) return;
    cancelJump();
    const token = generation;
    const id = sessionID();
    const targetID = prompt.id;
    navigationAbort = new AbortController();
    const signal = navigationAbort.signal;
    setJumping(true);
    const active = () => generation === token && sessionID() === id && !signal.aborted;
    // OpenCode currently forwards its full message store to plugins, although
    // history loading isn't declared in the public plugin SDK yet.
    const store = ctx.data.session.message as typeof ctx.data.session.message & {
      loadMore?: (id: string, options: { signal: AbortSignal }) => Promise<void>;
    };
    try {
      const ok = await jumpDirect({
        root: () => ctx.renderer.root,
        dispatch: (command) => ctx.keymap.dispatch(command),
        loadHistory: store.loadMore && id ? async () => {
          while (active() && !store.get(id, targetID)) {
            const oldest = store.list(id)[0]?.id;
            await store.loadMore!(id, { signal });
            if (store.list(id)[0]?.id === oldest) break;
          }
        } : undefined,
        frame: () => new Promise((resolve) => setTimeout(resolve, 32)),
      }, targetID, active);
      if (!active()) return;
      if (ok) setSelected(targetID);
      else ctx.ui.toast.show({ message: "Prompt rail: this OpenCode build could not expose that transcript position", variant: "warning" });
    } catch {
      if (active()) ctx.ui.toast.show({ message: "Prompt rail: unable to load the target message", variant: "warning" });
    } finally {
      if (active()) setJumping(false);
    }
  };
  const openPicker = async (start = 0, end = prompts().length) => {
    cancelJump();
    setHovered(undefined);
    const id = sessionID();
    const options = prompts().slice(start, end).map((message, offset) => ({
      title: `${start + offset + 1}. ${clean(message.text).slice(0, 220)}`,
      value: message.id,
    })).reverse();
    const selectedID = await ctx.ui.dialog.select({
      title: start === 0 && end === prompts().length ? "Jump to prompt" : `Jump to prompt ${start + 1}–${end}`,
      options,
      current: selected(),
      search: (query, items) => items.filter((item) => clean(query).toLowerCase().split(" ").every((word) => item.title.toLowerCase().includes(word))),
    });
    if (selectedID === undefined || sessionID() !== id) return;
    const index = prompts().findIndex((message) => message.id === selectedID);
    if (index >= 0) await jump(index);
  };
  ctx.keymap.layer(() => ({ commands: [{
    id: "prompt-rail.picker", title: "Jump to prompt (no actions menu)",
    group: "Session", palette: true, slash: { name: "prompt-jump" },
    enabled: () => !!sessionID(), run: () => openPicker(),
  }] }));
  const visible = () => props.enabled && !!sessionID() && left() !== undefined && prompts().length > 0;
  const popupWidth = () => Math.max(12, Math.min(52, (left() ?? 55) - 2));
  const popupTop = () => {
    const row = markers().findIndex((range) => range.start === hovered());
    return Math.max(1, Math.min(4 + Math.max(0, row) - 2, dimensions().height - 13));
  };

  return <Show when={visible()}>
    <box position="absolute" left={left()} top={2} width={3} flexDirection="column">
      <text fg={ctx.theme.text.muted} onMouseUp={(event) => {
        if (event.button !== 0) return;
        cancelJump();
        void openPicker();
      }}>≡</text>
      <box height={1} />
      <For each={markers()}>{(range) => <box
        width={3} height={1}
        onMouseOver={() => setHovered(range.start)}
        onMouseOut={() => setHovered(undefined)}
        onMouseUp={(event) => {
          event.stopPropagation();
          if (event.button !== 0) return;
          if (range.end - range.start === 1) void jump(range.start);
          else void openPicker(range.start, range.end);
        }}
      >
        <text fg={hovered() === range.start || prompts().slice(range.start, range.end).some((message) => selected() === message.id)
          ? ctx.theme.text.base : ctx.theme.text.muted}>
          {hovered() === range.start || prompts().slice(range.start, range.end).some((message) => selected() === message.id) ? "━━" : "╴"}
        </text>
      </box>}</For>
      <box height={1} />
      <text fg={ctx.theme.text.muted} onMouseUp={(event) => {
        if (event.button !== 0) return;
        cancelJump();
        setSelected(undefined);
        ctx.keymap.dispatch("session.last");
      }}> ↓</text>
    </box>
    <Show when={preview()}>{(item) => <box
      position="absolute" left={Math.max(0, (left() ?? 0) - popupWidth() - 1)} top={popupTop()}
      width={popupWidth()} maxHeight={11} padding={1} flexDirection="column"
      backgroundColor={ctx.theme.background.panel}
    >
      <text fg={ctx.theme.text.muted}>{(() => {
        const range = markers().find((range) => range.start === hovered());
        const grouped = range && range.end - range.start > 1;
        return `${grouped ? "Prompts" : "Prompt"} ${(hovered() ?? 0) + 1}${grouped ? `–${range.end}` : ""}/${prompts().length}${jumping() ? " · loading…" : grouped ? " · click to choose" : " · click to jump"}`;
      })()}</text>
      <text fg={ctx.theme.text.base} maxHeight={4} wrapMode="word">{item().prompt}</text>
      <Show when={item().reply}>
        <text fg={ctx.theme.text.muted} maxHeight={3} wrapMode="word">{item().reply}</text>
      </Show>
    </box>}</Show>
  </Show>;
}

function clean(text: string) {
  return text.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").replace(/\s+/g, " ").trim();
}
