import type { TUI } from "@earendil-works/pi-tui";

interface ScrollHost {
  scrollTo(row: number, options?: { disableFollow: boolean }): void;
  scrollToEnd(): void;
}
interface RenderNode {
  constructor: { name: string };
  children?: RenderNode[];
  render(width: number): readonly string[];
}
interface LayoutBox {
  component?: RenderNode;
  rect?: { width: number };
  scrollView?: ScrollHost;
  scrollContentLines?: readonly string[];
  children: LayoutBox[];
}
interface HostLayout {
  primaryScrollView?: ScrollHost;
  root: LayoutBox;
}

/** The sole private API seam: Pi's last rendered fullscreen layout.
 * OSC 133 boundaries cannot identify user prompts: assistant replies have them too.
 * Only descend through plain vertical Containers; treat specialized components
 * as opaque. Width comes from the transcript's laid-out content (not the terminal).
 */
function transcript(tui: TUI) {
  if (tui.mode !== "fullscreen") return;
  const layout = (tui as TUI & { currentLayout?: HostLayout }).currentLayout;
  const scroll = layout?.primaryScrollView;
  if (!layout || !scroll || typeof scroll.scrollTo !== "function" || typeof scroll.scrollToEnd !== "function") return;
  const find = (box: LayoutBox): LayoutBox | undefined => {
    if (box.scrollView === scroll && box.scrollContentLines) return box;
    for (const child of box.children ?? []) {
      const found = find(child);
      if (found) return found;
    }
  };
  const box = find(layout.root);
  return box?.scrollContentLines ? { scroll, box } : undefined;
}

function userPromptRows(box: LayoutBox): number[] | undefined {
  const content = box.children[0];
  const document = content?.component;
  const width = content?.rect?.width;
  if (!document || !width || document.constructor.name !== "Container") return;
  const rows: number[] = [];
  const visit = (node: RenderNode, top: number) => {
    if (node.constructor.name === "UserMessageComponent") rows.push(top);
    else if (node.constructor.name === "Container" && Array.isArray(node.children)) {
      let row = top;
      for (const child of node.children) {
        visit(child, row);
        row += child.render(width).length;
      }
    }
  };
  visit(document, 0);
  return rows;
}

export function navigationStatus(tui: TUI, expectedCount: number): string {
  const host = transcript(tui);
  const rows = host ? userPromptRows(host.box) : undefined;
  return `rendered user prompts=${rows?.length ?? "unavailable"}, history prompts=${expectedCount}`;
}

export function jumpToPrompt(tui: TUI, index: number, count: number): boolean {
  const host = transcript(tui);
  if (!host) return false;
  const rows = userPromptRows(host.box);
  // Compaction or an unsupported renderer must not silently shift ordinals.
  if (!rows || rows.length !== count) return false;
  const row = rows[index];
  if (row === undefined) return false;
  host.scroll.scrollTo(row, { disableFollow: true });
  tui.requestRender();
  return true;
}

export function jumpToLatest(tui: TUI): boolean {
  const host = transcript(tui);
  if (!host) return false;
  host.scroll.scrollToEnd();
  tui.requestRender();
  return true;
}
