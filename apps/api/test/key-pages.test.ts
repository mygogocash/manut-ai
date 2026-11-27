// A shop's history listed a page at a time to be counted or deleted (pilot-store.ts): every key under the prefix, once, in key
// order, across pages, with nothing from beside the prefix.
import { describe, expect, it } from "vitest";
import { countPrefix, keyPages, LIST_PAGE } from "../src/pilot-store";

/** A storage whose `list` honours a prefix, a limit and a starting key, as a Durable Object's does. */
function fakeStorage(keys: string[]) {
  const sorted = [...keys].sort();
  return {
    list: async ({ prefix = "", limit = Infinity, startAfter }: { prefix?: string; limit?: number; startAfter?: string }) =>
      new Map(sorted.filter((k) => k.startsWith(prefix) && (startAfter === undefined || k > startAfter)).slice(0, limit).map((k) => [k, {}])),
  } as never;
}

describe("listing a page at a time", () => {
  it("counts and lists every key under the prefix across pages, once each, and none beside it", async () => {
    const n = LIST_PAGE * 2 + 7;
    const keys = [...Array.from({ length: n }, (_, i) => `pay:t1:${String(i).padStart(5, "0")}`), "pay:t2:x", "msg:t1:y"];
    const storage = fakeStorage(keys);
    expect(await countPrefix(storage, "pay:t1:")).toBe(n);
    const pages: string[][] = [];
    for await (const page of keyPages(storage, "pay:t1:")) pages.push(page);
    expect(pages.map((p) => p.length)).toEqual([LIST_PAGE, LIST_PAGE, 7]);
    expect(new Set(pages.flat()).size).toBe(n);
    expect(pages.flat().every((k) => k.startsWith("pay:t1:"))).toBe(true);
  });

  it("counts none for an empty prefix and stops after an exactly full last page", async () => {
    expect(await countPrefix(fakeStorage([]), "pay:")).toBe(0);
    const full = Array.from({ length: LIST_PAGE }, (_, i) => `k:${String(i).padStart(4, "0")}`);
    expect(await countPrefix(fakeStorage(full), "k:")).toBe(LIST_PAGE);
  });
});
