import { describe, expect, test } from "bun:test";
import { Container, Text, TuiAltScreen, visibleWidth, matchesKey } from "@earendil-works/pi-tui";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { clean, collectPrompts, promptHistory } from "./model";
import { HistoryPanel, panel } from "./panels";
import { jumpToLatest, jumpToPrompt } from "./navigation";
import extension, { PromptRail } from "./index";

const user = (id: string, text: string) => ({ type: "message", id, message: { role: "user", content: text } });
const assistant = (text: string) => ({ type: "message", message: { role: "assistant", content: [{ type: "text", text }] } });
const marker = "\x1b]133;A\x07";

function fixture(branch = [user("a", "first"), assistant("answer"), user("b", "second")]) {
  let current = branch;
  const overlays: any[] = [];
  const scrolls: any[] = [];
  const notifications: string[] = [];
  const listeners = new Set<any>();
  let ended = 0;
  let renders = 0;
  const scroll = { scrollTo: (...args: any[]) => scrolls.push(args), scrollToEnd: () => ended++ };
  const tui: any = {
    mode: "fullscreen", terminal: { rows: 40, columns: 100 },
    requestRender: () => renders++,
    currentLayout: { primaryScrollView: scroll, root: { children: [{ scrollView: scroll, scrollContentLines: ["header", marker + "one", "answer", marker + "two"], children: [{ rect: { width: 99 }, component: {
      constructor: { name: "Container" }, render: () => [], children: [
        { constructor: { name: "Text" }, render: () => ["header"] },
        { constructor: { name: "UserMessageComponent" }, render: () => [marker + "one"] },
        { constructor: { name: "AssistantMessageComponent" }, render: () => [marker + "answer"] },
        { constructor: { name: "UserMessageComponent" }, render: () => [marker + "two"] },
      ],
    } }] }] } },
    addInputListener: (fn: any) => { listeners.add(fn); return () => listeners.delete(fn); },
    showOverlay: (component: any, options: any) => {
      const handle = { hidden: false, removed: false, hide() { this.removed = true; }, setHidden(value: boolean) { this.hidden = value; }, getBounds: () => ({ col: 96, row: 2, width: 3, height: 6 }) };
      overlays.push({ component, options, handle });
      return handle;
    },
  };
  const theme: any = { fg: (_: string, text: string) => text, bg: (_: string, text: string) => text };
  const ctx: any = {
    mode: "tui", sessionManager: { getLeafId: () => current.at(-1)?.id ?? "leaf", getBranch: () => current, buildContextEntries: () => current, getSessionId: () => "session" },
    ui: { notify: (text: string) => notifications.push(text) },
  };
  const rail = new PromptRail(tui, theme, ctx);
  return { tui, ctx, theme, rail, overlays, scrolls, notifications, listeners, ended: () => ended, renders: () => renders,
    branch: (value: any) => { current = value; } };
}
const mouse = (y: number, type = "click") => ({ type, button: "left", x: 1, y });

describe("prompt model", () => {
  test("only user prompts and latest nonempty assistant text, no tools/thinking", () => {
    const branch: any = [user("a", "hello"), assistant("initial"), { type: "message", message: { role: "toolResult", content: [{ type: "text", text: "secret tool" }] } }, assistant("final"), assistant(""), user("b", "next")];
    expect(collectPrompts(branch)).toEqual([{ id: "a", text: "hello", reply: "final" }, { id: "b", text: "next", reply: "" }]);
  });
  test("image-only prompts retain an ordinal", () => {
    expect(collectPrompts([{ ...user("a", ""), message: { role: "user", content: [{ type: "image", data: "hidden", mimeType: "image/png" }] } }] as any)[0].text).toBe("[image / attachment]");
  });
  test("terminal control sequences and newlines are sanitized", () => {
    expect(clean("\x1b[31mred\x1b[0m\n\x1b]0;bad title\x07text\x00")).toBe("red text");
  });
});

describe("readable panels and saved history", () => {
  test("every panel row is full-width and painted, including blank lines", () => {
    const f = fixture();
    let painted = 0;
    f.theme.bg = (_token: string, text: string) => { painted++; return text; };
    const lines = panel(f.theme, "Prompt picker", ["", "漢字 👩‍💻", ""], 70);
    expect(painted).toBe(lines.length);
    expect(lines.every((line) => visibleWidth(line) === 70)).toBe(true);
    expect(lines[0]).toStartWith("┌ Prompt picker");
    expect(lines.at(-1)).toStartWith("└");
  });
  test("saved history preserves paragraphs, omits tool/thinking content and stops at next user", () => {
    const branch: any = [user("a", "line1\nline2\x1b[31m"), assistant("first\n\nreply"),
      { type: "message", message: { role: "toolResult", content: [{ type: "text", text: "tool secret" }] } },
      { type: "message", message: { role: "assistant", content: [{ type: "thinking", thinking: "hidden" }] } },
      assistant("final"), user("b", "next"), assistant("different turn")];
    expect(promptHistory(branch, "a")).toEqual({ prompt: "line1\nline2", reply: "first\n\nreply\n\nfinal" });
    expect(promptHistory(branch, "missing")).toBeUndefined();
  });
  test("history reader scrolls, resizes, and closes without touching live transcript", () => {
    const f = fixture(); let closed = false;
    const view = new HistoryPanel(f.theme, "Saved prompt · read-only", "original prompt", Array.from({ length: 80 }, (_, i) => `reply-${i}`).join("\n"), () => 24, () => { closed = true; }, () => {});
    const top = view.render(50).join("\n");
    view.handleInput("\x1b[6~");
    expect(view.render(50).join("\n")).not.toBe(top);
    view.handleInput("\x1b[F");
    expect(view.render(50).join("\n")).toContain("reply-79");
    view.invalidate();
    expect(view.render(20).every((line) => visibleWidth(line) === 20)).toBe(true);
    view.handleInput("\x1b");
    expect(closed).toBe(true);
    expect(f.scrolls).toEqual([]);
  });
});

describe("navigation compatibility seam", () => {
  test("jumps directly in one scroll with follow-end disabled", () => {
    const f = fixture();
    expect(jumpToPrompt(f.tui, 1, 2)).toBe(true);
    expect(f.scrolls).toEqual([[3, { disableFollow: true }]]);
    expect(f.renders()).toBe(1);
  });
  test("missing layout, regular mode, compaction and invalid index do not scroll", () => {
    const f = fixture();
    expect(jumpToPrompt(f.tui, 0, 3)).toBe(false);
    expect(jumpToPrompt(f.tui, -1, 2)).toBe(false);
    expect(jumpToPrompt(f.tui, 10, 2)).toBe(false);
    f.tui.mode = "regular";
    expect(jumpToPrompt(f.tui, 0, 2)).toBe(false);
    f.tui.mode = "fullscreen";
    delete f.tui.currentLayout;
    expect(jumpToPrompt(f.tui, 0, 2)).toBe(false);
    expect(f.scrolls).toEqual([]);
  });
  test("latest resumes native follow-end", () => {
    const f = fixture();
    expect(jumpToLatest(f.tui)).toBe(true);
    expect(f.ended()).toBe(1);
  });
});

describe("installed fullscreen renderer integration", () => {
  test("real layout and mouse dispatch jump directly, preserve focus, and resume follow", async () => {
    let input: (data: string) => void = () => {};
    const terminal: any = new Proxy({ columns: 100, rows: 24, kittyProtocolActive: false,
      start: (handler: any) => { input = handler; } }, { get: (target, key) => key in target ? target[key] : () => {} });
    const tui = new TuiAltScreen(terminal, false, undefined, { mouse: true });
    initTheme("dark", false);
    const piUrl = import.meta.resolve("@earendil-works/pi-coding-agent");
    const { UserMessageComponent } = await import(new URL("./modes/interactive/components/user-message.js", piUrl).href);
    const { AssistantMessageComponent } = await import(new URL("./modes/interactive/components/assistant-message.js", piUrl).href);
    const { createChatViewport } = await import(new URL("./modes/interactive/chat-viewport.js", piUrl).href);
    const document = new Container();
    document.addChild(new Text("header", 0, 0));
    document.addChild(new UserMessageComponent("first"));
    document.addChild(new AssistantMessageComponent({ role: "assistant", content: [{ type: "text", text: Array(50).fill("reply").join("\n\n") }] }));
    document.addChild(new UserMessageComponent("second"));
    document.addChild(new AssistantMessageComponent({ role: "assistant", content: [{ type: "text", text: Array(40).fill("reply").join("\n\n") }] }));
    const empty = { invalidate() {}, render: () => [] };
    const viewport = createChatViewport({ document, pendingMessages: empty, status: empty, editor: new Text("editor", 0, 0), footer: empty });
    tui.setLayoutRoot(viewport.root);
    const focus = { invalidate() {}, render: () => ["editor"] };
    tui.setFocus(focus);
    const f = fixture();
    const rail = new PromptRail(tui, f.theme, f.ctx);
    try {
      tui.start(); rail.mount(); tui.renderNow();
      expect(tui.isFollowingOutput).toBe(true);
      const { createInteractiveTuiReference } = await import(new URL("./modes/interactive/tui-renderer.js", import.meta.resolve("@earendil-works/pi-coding-agent")).href);
      const extensionTui = createInteractiveTuiReference(() => tui);
      expect(jumpToPrompt(extensionTui, 0, 2)).toBe(true);
      rail.latest();
      let opened = 0;
      f.ctx.ui.custom = async () => { opened++; return "a"; };
      // The Prompts button: SGR cell (95,3), inside the top-right overlay's bounds.
      input("\x1b[<0;95;3M"); input("\x1b[<0;95;3m");
      await Bun.sleep(10);
      expect(opened).toBe(1);
      expect(tui.viewportTop).toBe(1);
      expect(tui.isFollowingOutput).toBe(false);
      expect(tui.getFocusedComponent()).toBe(focus);
      expect(f.notifications).toEqual([]);
      rail.latest();
      expect(tui.isFollowingOutput).toBe(true);
    } finally { rail.dispose(); tui.stop(); }
  });
});

describe("rail component", () => {
  test("single noncapturing Prompts button, no minimap, regardless of history length", () => {
    const f = fixture(Array.from({ length: 100 }, (_, i) => user(String(i), "emoji 👩‍💻 漢字")));
    f.rail.mount();
    expect(f.overlays.length).toBe(1);
    expect(f.overlays[0].options.nonCapturing).toBe(true);
    expect(f.overlays[0].options.visible(39, 40)).toBe(false);
    expect(f.overlays[0].options.visible(100, 7)).toBe(false);
    expect(f.overlays[0].options.visible(100, 40)).toBe(true);
    expect(f.rail.render(11)).toEqual([" ≡ Prompts "]);
    for (const width of [1, 3, 10, 80]) expect(f.rail.render(width).every((line) => visibleWidth(line) <= width)).toBe(true);
    f.branch([]);
    expect(f.overlays[0].options.visible(100, 40)).toBe(false);
    f.rail.dispose();
  });
  test("button opens the picker on click only; hover and press do nothing; cleanup is idempotent", async () => {
    const f = fixture();
    let opened = 0;
    f.ctx.ui.custom = async () => { opened++; return undefined; };
    f.rail.mount();
    f.rail.handleMouse(mouse(0, "move") as any);
    f.rail.handleMouse(mouse(0, "press") as any);
    f.rail.handleMouse(mouse(0, "click") as any);
    await Bun.sleep(0);
    expect(opened).toBe(1);
    expect(f.overlays.length).toBe(1);
    expect(f.scrolls).toEqual([]);
    f.rail.dispose(); f.rail.dispose();
    expect(f.overlays[0].handle.removed).toBe(true);
  });
  test("branch change refreshes prompts, never retains another branch's index", async () => {
    const f = fixture();
    f.rail.mount();
    f.ctx.ui.custom = async () => { f.branch([user("c", "replacement")]); return "a"; };
    await f.rail.pick();
    expect(f.scrolls.length).toBe(0);
    f.rail.dispose();
  });
  test("search picker filters, cancels, and navigates without editor mutation", async () => {
    initTheme("dark", false);
    const f = fixture();
    f.rail.mount();
    let dialog: any;
    f.ctx.ui.custom = (factory: any) => new Promise((resolve) => {
      dialog = factory(f.tui, f.theme, { matches: (data: string, action: string) => matchesKey(data, ({ "tui.select.up": "up", "tui.select.down": "down", "tui.select.confirm": "enter", "tui.select.cancel": "escape" } as any)[action]) }, resolve);
    });
    const picking = f.rail.pick();
    expect(f.overlays[0].handle.hidden).toBe(true);
    dialog.focused = true;
    dialog.handleInput("f"); dialog.handleInput("i");
    expect(dialog.render(40).some((line: string) => line.includes("first"))).toBe(true);
    expect(dialog.render(40).every((line: string) => visibleWidth(line) <= 40)).toBe(true);
    dialog.handleInput("\r");
    await picking;
    expect(f.scrolls).toEqual([[1, { disableFollow: true }]]);
    expect(f.overlays[0].handle.hidden).toBe(false);
    const cancelled = f.rail.pick();
    dialog.handleInput("\x1b"); await cancelled;
    expect(f.scrolls.length).toBe(1);
    const pending = f.rail.pick();
    f.rail.dispose(); await pending;
    expect(f.overlays[0].handle.removed).toBe(true);
  });
  test("compacted session: latest prompt uses visible context index, not all-history index", async () => {
    const branch = Array.from({ length: 5 }, (_, i) => user(String(i), `prompt ${i}`));
    const f = fixture(branch);
    f.ctx.sessionManager.buildContextEntries = () => branch.slice(4);
    const content = f.tui.currentLayout.root.children[0].children[0].component;
    content.children = [{ constructor: { name: "UserMessageComponent" }, render: () => ["prompt 4"] }];
    f.rail.mount();
    f.ctx.ui.custom = async () => "4";
    await f.rail.pick();
    expect(f.scrolls).toEqual([[0, { disableFollow: true }]]);
    expect(f.notifications).toEqual([]);
    f.rail.dispose();
  });
  test("compacted session: historical prompt opens an opaque, read-only history view", async () => {
    initTheme("dark", false);
    const branch = [user("old", "historical prompt"), assistant("historical answer"), user("new", "live prompt")];
    const f = fixture(branch);
    f.ctx.sessionManager.buildContextEntries = () => branch.slice(2);
    const panels: string[][] = [];
    f.ctx.ui.custom = async (factory: any) => {
      const panel = factory(f.tui, f.theme, { matches: () => false }, () => {});
      panels.push(panel.render(70));
      return panels.length === 1 ? "old" : undefined;
    };
    await f.rail.pick();
    expect(panels.length).toBe(2);
    expect(panels[1].join("\n")).toContain("read-only");
    expect(panels[1].join("\n")).toContain("historical answer");
    expect(panels.every((panel) => panel.every((line) => visibleWidth(line) === 70))).toBe(true);
    expect(f.notifications).toEqual([]);
    expect(f.scrolls).toEqual([]);
    f.rail.dispose();
  });
  test("extension registers only commands; non-TUI sessions create no widgets", () => {
    const events = new Map<string, any>(); const commands = new Map<string, any>();
    extension({ on: (name: string, handler: any) => events.set(name, handler), registerCommand: (name: string, config: any) => commands.set(name, config) } as any);
    events.get("session_start")({}, { mode: "print" });
    expect([...commands.keys()]).toEqual(["prompt-rail", "prompt-jump", "prompt-latest"]);
    events.get("session_shutdown")();
  });
});
