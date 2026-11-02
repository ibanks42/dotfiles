import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { getSelectListTheme } from "@earendil-works/pi-coding-agent";
import { Input, SelectList, truncateToWidth, wrapTextWithAnsi, type Component, type OverlayHandle, type TUI, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { collectPrompts, promptHistory, type Prompt } from "./model";
import { HistoryPanel, panel } from "./panels";
import { jumpToLatest, jumpToPrompt, navigationStatus } from "./navigation";

export class PromptRail implements Component {
  private overlay?: OverlayHandle;
  private leaf?: string | null;
  private prompts: Prompt[] = [];
  private picking = false;
  private cancelPicker?: () => void;
  private disposed = false;

  constructor(private tui: TUI, private theme: Theme, private ctx: ExtensionContext) {}

  mount() {
    if (this.tui.mode !== "fullscreen") return;
    this.overlay = this.tui.showOverlay(this, {
      anchor: "top-right", width: 11, row: 2, margin: { right: 1 }, nonCapturing: true,
      visible: (width, height) => width >= 40 && height >= 8 && this.getPrompts().length > 0,
    });
  }

  private getPrompts() {
    const leaf = this.ctx.sessionManager.getLeafId();
    if (leaf !== this.leaf) {
      this.leaf = leaf;
      this.prompts = collectPrompts(this.ctx.sessionManager.getBranch());
    }
    return this.prompts;
  }

  invalidate() {}

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.cancelPicker?.();
    this.overlay?.hide();
  }

  render(width: number) {
    return [this.theme.bg("toolPendingBg", this.theme.fg("accent", truncateToWidth(" ≡ Prompts", width, "", true)))];
  }

  handleMouse(event: TuiMouseEvent) {
    // Act on click, not both press and release. Never steal editor focus.
    if (event.type === "click" && event.button === "left") void this.pick();
    return { handled: true };
  }

  private async jump(id?: string) {
    if (this.disposed || !id) return;
    const prompts = this.getPrompts();
    // Pi's live transcript is compaction-aware; saved branch history is not.
    const visible = collectPrompts(this.ctx.sessionManager.buildContextEntries());
    const index = visible.findIndex((p) => p.id === id);
    if (index >= 0) {
      if (!jumpToPrompt(this.tui, index, visible.length)) this.ctx.ui.notify(`Prompt rail: transcript position unavailable (${navigationStatus(this.tui, visible.length)}). Nothing was changed.`, "warning");
      return;
    }
    const historicalIndex = prompts.findIndex((p) => p.id === id);
    const history = promptHistory(this.ctx.sessionManager.getBranch(), id);
    if (historicalIndex < 0 || !history) return;
    this.overlay?.setHidden(true);
    try {
      await this.ctx.ui.custom<void>((tui, theme, _kb, done) => {
        this.cancelPicker = () => done();
        return new HistoryPanel(theme, `Prompt ${historicalIndex + 1}/${prompts.length} · read-only`, history.prompt, history.reply,
          () => tui.terminal.rows, () => done(), () => tui.requestRender());
      }, { overlay: true, overlayOptions: { width: "80%", maxHeight: "90%", anchor: "center" } });
    } finally {
      this.cancelPicker = undefined;
      if (!this.disposed && !this.picking) this.overlay?.setHidden(false);
    }
  }

  latest() {
    if (!jumpToLatest(this.tui)) this.ctx.ui.notify("Prompt rail: jumping requires Pi fullscreen mode.", "warning");
  }

  async pick() {
    if (this.disposed || this.picking) return;
    const prompts = this.getPrompts();
    if (!prompts.length) {
      this.ctx.ui.notify("No user prompts on this session branch yet.", "info");
      return;
    }
    this.picking = true;
    this.overlay?.setHidden(true);
    const sessionId = this.ctx.sessionManager.getSessionId();
    const leaf = this.ctx.sessionManager.getLeafId();
    try {
      const id = await this.ctx.ui.custom<string | undefined>((tui, theme, kb, done) => {
        this.cancelPicker = () => done(undefined);
        const input = new Input({ prompt: "Search: " });
        const visibleIds = new Set(collectPrompts(this.ctx.sessionManager.buildContextEntries()).map((p) => p.id));
        const items = prompts.map((p, index) => ({ value: p.id, label: `${index + 1}. ${visibleIds.has(p.id) ? "" : "[history] "}${p.text}` })).reverse();
        let selected: string | undefined;
        const makeList = (query: string) => {
          const words = query.toLowerCase().trim().split(/\s+/);
          const filtered = items.filter((item) => words.every((word) => item.label.toLowerCase().includes(word)));
          const next = new SelectList(filtered, Math.max(1, Math.min(10, Math.floor(tui.terminal.rows * 0.9) - 15)), getSelectListTheme());
          selected = filtered[0]?.value;
          next.onSelectionChange = (item) => { selected = item.value; };
          next.onSelect = (item) => done(item.value);
          next.onCancel = () => done(undefined);
          return next;
        };
        let list = makeList("");
        return {
          get focused() { return input.focused; },
          set focused(value: boolean) { input.focused = value; },
          invalidate() { input.invalidate(); list.invalidate(); },
          render: (width) => {
            const prompt = prompts.find((p) => p.id === selected);
            const inner = Math.max(1, width - 4);
            const historical = prompt && !visibleIds.has(prompt.id);
            const compact = tui.terminal.rows < 20;
            return panel(theme, "Jump to prompt", [...input.render(inner), "", ...list.render(inner), "",
              theme.fg("accent", historical ? "SAVED HISTORY · opens read-only" : "LIVE TRANSCRIPT · jumps directly"),
              ...wrapTextWithAnsi(prompt?.text.slice(0, 600) ?? "No matching prompts", inner).slice(0, compact ? 1 : 3),
              ...wrapTextWithAnsi(prompt?.reply.slice(0, 400) ?? "", inner).slice(0, compact ? 0 : 2).map((line) => theme.fg("muted", line)), "",
              theme.fg("muted", "↑/↓ choose · Enter open · Esc cancel")], width);
          },
          handleInput(data) {
            if (kb.matches(data, "tui.select.up") || kb.matches(data, "tui.select.down") || kb.matches(data, "tui.select.confirm") || kb.matches(data, "tui.select.cancel")) list.handleInput(data);
            else { input.handleInput(data); list = makeList(input.getValue()); }
            tui.requestRender();
          },
        };
      }, { overlay: true, overlayOptions: { width: "80%", maxHeight: "90%", anchor: "center" } });
      // The agent may have continued while the picker was open: don't use stale ordinals.
      if (!this.disposed && sessionId === this.ctx.sessionManager.getSessionId()) {
        if (leaf !== this.ctx.sessionManager.getLeafId()) this.leaf = undefined;
        await this.jump(id);
      }
    } finally {
      this.cancelPicker = undefined;
      this.picking = false;
      if (!this.disposed) this.overlay?.setHidden(false);
      this.tui.requestRender();
    }
  }
}

export default function promptRailExtension(pi: ExtensionAPI) {
  let rail: PromptRail | undefined;
  let enabled = true;
  const install = (ctx: ExtensionContext) => {
    rail?.dispose();
    rail = undefined;
    if (ctx.mode !== "tui") return;
    ctx.ui.setWidget("prompt-rail", undefined);
    if (!enabled) return;
    // A zero-height widget obtains Pi's TUI without replacing its editor/footer.
    ctx.ui.setWidget("prompt-rail", (tui, theme) => {
      const instance = new PromptRail(tui, theme, ctx);
      rail = instance;
      instance.mount();
      return { render: () => [], invalidate: () => instance.invalidate(), dispose: () => instance.dispose() };
    });
  };
  pi.on("session_start", (_event, ctx) => install(ctx));
  pi.on("session_shutdown", () => { rail?.dispose(); rail = undefined; });
  pi.registerCommand("prompt-rail", {
    description: "Toggle the fullscreen Prompts button",
    handler: async (_args, ctx) => { enabled = !enabled; install(ctx); ctx.ui.notify(`Prompts button ${enabled ? "on" : "off"}`, "info"); },
  });
  pi.registerCommand("prompt-jump", {
    description: "Search prompts and jump without changing session history",
    handler: async (_args, ctx) => {
      if (ctx.mode !== "tui") { ctx.ui.notify("Prompt jumping requires interactive fullscreen Pi.", "warning"); return; }
      if (!rail) { enabled = true; install(ctx); }
      await rail?.pick();
    },
  });
  pi.registerCommand("prompt-latest", {
    description: "Return to latest transcript output",
    handler: async (_args, ctx) => {
      if (!rail && ctx.mode === "tui") { enabled = true; install(ctx); }
      rail?.latest();
    },
  });
}
