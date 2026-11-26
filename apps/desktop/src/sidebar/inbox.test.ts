// The side menu's own choices (item 94): read defensively, off or at their defaults until the person changes them.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getInbox, INBOX_DEFAULTS, INBOX_KEY, parseInbox, reloadInbox, setInbox } from "./inbox";

describe("the inbox's settings", () => {
  it("default to the Working group off, settling after 3 quiet days and on a merged pull request", () => {
    expect(INBOX_DEFAULTS).toEqual({ working: false, quietDays: 3, merged: true });
    for (const raw of [null, "", "not json", "[]", "5", "{}"]) expect(parseInbox(raw), String(raw)).toEqual(INBOX_DEFAULTS);
  });

  it("keeps each field of the right type and drops the rest", () => {
    expect(parseInbox(JSON.stringify({ working: true, quietDays: 0, merged: false, colour: "red" }))).toEqual({ working: true, quietDays: 0, merged: false });
    expect(parseInbox(JSON.stringify({ working: "yes", quietDays: -1, merged: 1 }))).toEqual(INBOX_DEFAULTS);
    expect(parseInbox(JSON.stringify({ quietDays: 2.5 })).quietDays).toBe(3);
  });

  describe("kept on this computer", () => {
    const disk = new Map<string, string>();
    beforeEach(() => {
      disk.clear();
      vi.stubGlobal("localStorage", { getItem: (k: string) => disk.get(k) ?? null, setItem: (k: string, v: string) => void disk.set(k, v) });
      reloadInbox();
    });
    afterEach(() => vi.unstubAllGlobals());

    it("saves a change and reads it back after a restart", () => {
      setInbox({ working: true });
      expect(JSON.parse(disk.get(INBOX_KEY)!)).toEqual({ working: true, quietDays: 3, merged: true });
      reloadInbox();
      expect(getInbox().working).toBe(true);
    });
  });
});
