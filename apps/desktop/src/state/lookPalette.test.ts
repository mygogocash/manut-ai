// The colour picker is gone (item 85i, docs/design-audit.md: "no accent for the person to pick"), and the brand's colours
// are everyone's. A look saved while the picker was there still opens: its colour set is read, found not to be one the
// app has, and read as the brand's, silently, with the rest of the look kept. Nothing saved can stop the app opening.
import { afterEach, describe, expect, it, vi } from "vitest";
import { initialState, PALETTES } from "./store";

function startWith(saved: string | null) {
  const disk = new Map<string, string>();
  if (saved !== null) disk.set("manut.look", saved);
  vi.stubGlobal("localStorage", { getItem: (k: string) => disk.get(k) ?? null, setItem: (k: string, v: string) => void disk.set(k, v), removeItem: (k: string) => void disk.delete(k) });
  return initialState().ui.look;
}

describe("the colour set, after the picker left", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("has one set, the brand's", () => {
    expect(PALETTES).toEqual(["manut"]);
  });

  it("reads a set the picker once saved as the brand's, and keeps the rest of the look", () => {
    for (const old of ["graphite", "ocean", "forest", "sunset", "rose"]) {
      const look = startWith(JSON.stringify({ palette: old, bubbles: "solid", text: "large" }));
      expect(look.palette, old).toBe("manut");
      expect(look.bubbles, old).toBe("solid");
      expect(look.text, old).toBe("large");
    }
  });

  it("never fails to open on what was saved: no look, junk, a wrong type, or a set it never had", () => {
    for (const saved of [null, "{not json", '"forest"', "null", "[]", '{"palette":42}', '{"palette":"neon"}', '{"palette":{"name":"ocean"}}']) {
      expect(() => startWith(saved), String(saved)).not.toThrow();
      expect(startWith(saved).palette, String(saved)).toBe("manut");
    }
  });
});
