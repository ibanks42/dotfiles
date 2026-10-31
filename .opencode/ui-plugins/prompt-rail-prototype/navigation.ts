/** The only compatibility seam that knows about OpenCode's transcript render tree. */
type Node = {
  id?: string;
  y: number;
  height: number;
  isDestroyed?: boolean;
  parent?: Node | null;
  getChildren?(): Node[];
  findDescendantById?(id: string): Node | undefined;
  scrollTop?: number;
  viewport?: { y: number };
  scrollTo?(top: number): void;
  stickyScroll?: boolean;
};

export type NavigationHost = {
  root(): Node;
  dispatch(command: string): void;
  /** Undocumented, feature-detected host method. Loads history without navigating it. */
  loadHistory?(): Promise<void>;
  frame(): Promise<void>;
};

function target(host: NavigationHost, id: string) {
  const root = host.root();
  const node = root.findDescendantById?.(id);
  if (!node || node.isDestroyed) return;
  // The nearest scroll ancestor owns the transcript, not a sidebar/dialog scrollbox.
  let scroll = node.parent;
  while (scroll && !scroll.scrollTo) scroll = scroll.parent;
  if (!scroll?.scrollTo || scroll.isDestroyed || scroll.scrollTop === undefined) return;
  return { node, scroll };
}

export async function jumpDirect(host: NavigationHost, id: string, active: () => boolean) {
  if (!active()) return false;
  if (!target(host, id)) {
    await host.loadHistory?.();
    if (!active()) return false;
    // Native navigation mounts the host's virtualized rows. One preparation,
    // never a walk through N user messages. Most subsequent jumps skip this.
    host.dispatch("session.messages_last_user");
    for (let attempt = 0; attempt < 8; attempt++) {
      await host.frame();
      if (!active()) return false;
      // Native alignment itself spans multiple layout passes.
      if (attempt >= 3 && target(host, id)) break;
    }
  }
  if (!active()) return false;
  if (!target(host, id)) return false;
  // Reset native previous/next's remembered selection before our direct jump.
  // The one-line offset and final alignment happen together before paint.
  host.dispatch("session.line.up");
  const found = target(host, id);
  if (!found) return false;
  const { node, scroll } = found;
  scroll.stickyScroll = false;
  scroll.scrollTo!(Math.max(0, scroll.scrollTop! + node.y - (scroll.viewport?.y ?? scroll.y)));
  return true;
}

export function promptRanges(count: number, capacity: number) {
  const slots = Math.min(count, Math.max(1, capacity));
  return Array.from({ length: slots }, (_, slot) => ({
    start: Math.floor(slot * count / slots),
    end: Math.floor((slot + 1) * count / slots),
  }));
}
