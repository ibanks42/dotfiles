import { describe, expect, test } from "bun:test";
import { jumpDirect, promptRanges } from "./navigation";

describe("direct navigation", () => {
  test("a mounted target aligns once, with no intervening prompt jumps", async () => {
    const calls: string[] = [];
    const positions: number[] = [];
    const scroll = { y: 2, height: 30, scrollTop: 400, viewport: { y: 3 }, scrollTo: (y: number) => positions.push(y) };
    const node = { y: -100, height: 4, parent: scroll };
    const ok = await jumpDirect({
      root: () => ({ y: 0, height: 48, findDescendantById: () => node }),
      dispatch: (id) => calls.push(id), frame: async () => {},
    }, "prompt-1", () => true);
    expect(ok).toBe(true);
    expect(positions).toEqual([297]);
    expect(calls).toEqual(["session.line.up"]);
  });

  test("100+ prompts need one history preparation, not 100 previous commands", async () => {
    const calls: string[] = [];
    let mounted = false;
    let loads = 0;
    const scroll = { y: 0, height: 30, scrollTop: 0, scrollTo: () => {} };
    const node = { y: 100, height: 3, parent: scroll };
    const ok = await jumpDirect({
      root: () => ({ y: 0, height: 48, findDescendantById: () => mounted ? node : undefined }),
      loadHistory: async () => { loads++; },
      dispatch: (id) => calls.push(id),
      frame: async () => { mounted = true; },
    }, "prompt-125", () => true);
    expect(ok).toBe(true);
    expect(loads).toBe(1);
    expect(calls).toEqual(["session.messages_last_user", "session.line.up"]);
  });

  test("switching sessions during history loading cancels navigation", async () => {
    const calls: string[] = [];
    let active = true;
    expect(await jumpDirect({
      root: () => ({ y: 0, height: 48 }),
      loadHistory: async () => { active = false; },
      dispatch: (id) => calls.push(id), frame: async () => {},
    }, "old-session", () => active)).toBe(false);
    expect(calls).toEqual([]);
  });

  test("an incompatible host reports failure instead of walking the transcript", async () => {
    expect(await jumpDirect({
      root: () => ({ y: 0, height: 48 }),
      dispatch: () => {}, frame: async () => {},
    }, "missing", () => true)).toBe(false);
  });
});

describe("long-session rail", () => {
  for (const count of [0, 1, 6, 26, 100, 125, 1000]) {
    test(`${count} prompts are all reachable, with no gaps or duplicates`, () => {
      const ranges = promptRanges(count, 26);
      const indices = ranges.flatMap(({ start, end }) => Array.from({ length: end - start }, (_, i) => start + i));
      expect(ranges.length).toBeLessThanOrEqual(26);
      expect(indices).toEqual(Array.from({ length: count }, (_, i) => i));
    });
  }
});
