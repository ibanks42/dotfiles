import type { Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi, type TuiMouseEvent } from "@earendil-works/pi-tui";

/** Fill every cell, including blank lines: overlays must not bleed into the transcript. */
export function panel(theme: Theme, title: string, lines: string[], width: number): string[] {
  const inner = Math.max(1, width - 4);
  const heading = `┌ ${title} `;
  const border = (line: string) => theme.fg("border", line);
  return [border(heading + "─".repeat(Math.max(0, width - visibleWidth(heading) - 1)) + "┐"),
    ...lines.map((line) => border("│ ") + theme.fg("text", truncateToWidth(line, inner, "", true)) + border(" │")),
    border("└" + "─".repeat(Math.max(0, width - 2)) + "┘")]
    .map((line) => theme.bg("toolPendingBg", truncateToWidth(line, width, "", true)));
}

export class HistoryPanel {
  private top = 0;
  private maxTop = 0;
  private page = 1;
  private cachedWidth = -1;
  private lines: string[] = [];

  constructor(private theme: Theme, private title: string, private prompt: string,
    private reply: string, private rows: () => number, private done: () => void,
    private requestRender: () => void) {}

  invalidate() { this.cachedWidth = -1; }

  render(width: number) {
    const inner = Math.max(1, width - 4);
    if (inner !== this.cachedWidth) {
      this.cachedWidth = inner;
      this.lines = [this.theme.fg("accent", "USER PROMPT"), ...wrapTextWithAnsi(this.prompt, inner), "",
        this.theme.fg("accent", "ASSISTANT TEXT"), ...wrapTextWithAnsi(this.reply || "No assistant text saved for this prompt.", inner)];
    }
    this.page = Math.max(1, Math.floor(this.rows() * 0.9) - 7);
    this.maxTop = Math.max(0, this.lines.length - this.page);
    this.top = Math.min(this.top, this.maxTop);
    return panel(this.theme, this.title, [this.theme.fg("muted", "Earlier history · compacted out of the live transcript"), "",
      ...this.lines.slice(this.top, this.top + this.page), "",
      this.theme.fg("muted", `↑/↓ PgUp/PgDn scroll · Esc close · ${this.top + 1}/${this.lines.length}`)], width);
  }

  private scroll(delta: number) {
    this.top = Math.max(0, Math.min(this.maxTop, this.top + delta));
    this.requestRender();
  }

  handleInput(data: string) {
    if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) this.done();
    else if (matchesKey(data, "up")) this.scroll(-1);
    else if (matchesKey(data, "down")) this.scroll(1);
    else if (matchesKey(data, "pageUp")) this.scroll(-this.page);
    else if (matchesKey(data, "pageDown")) this.scroll(this.page);
    else if (matchesKey(data, "home")) this.scroll(-this.maxTop);
    else if (matchesKey(data, "end")) this.scroll(this.maxTop);
  }

  handleMouse(event: TuiMouseEvent) {
    if (event.type !== "wheel") return undefined;
    this.scroll(event.wheelDelta ?? 0);
    return { handled: true, render: true };
  }
}
