// The look's colours: the brand's, or a theme of the person's own (item 99b; the owner chose full themes on 27 Nov 2026,
// lifting item 85i's single colour set). The five sets the old picker offered are still gone: a look saved with one still
// opens, its set read as the brand's, silently, with the rest of the look kept. Nothing saved can stop the app opening.
import { afterEach, describe, expect, it, vi } from "vitest";
import { initialState, PALETTES } from "./store";

function startWith(saved: string | null) {
  const disk = new Map<string, string>();
  if (saved !== null) disk.set("manut.look", saved);
  vi.stubGlobal("localStorage", { getItem: (k: string) => disk.get(k) ?? null, setItem: (k: string, v: string) => void disk.set(k, v), removeItem: (k: string) => void disk.delete(k) });
  return initialState().ui.look;
}

describe("the look's colours", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("has one built in, the brand's; the person's own themes are kept beside it", () => {
    expect(PALETTES).toEqual(["manut"]);
    expect(startWith(JSON.stringify({ palette: "mine-ab12cd34", bubbles: "open", text: "medium" })).palette).toBe("mine-ab12cd34");
  });

  it("reads a set the old picker saved as the brand's, and keeps the rest of the look", () => {
    for (const old of ["graphite", "ocean", "forest", "sunset", "rose"]) {
      const look = startWith(JSON.stringify({ palette: old, bubbles: "solid", text: "large" }));
      expect(look.palette, old).toBe("manut");
      expect(look.bubbles, old).toBe("solid");
      expect(look.text, old).toBe("large");
    }
  });

  it("never fails to open on what was saved: no look, junk, a wrong type, or a set it never had", () => {
    for (const saved of [null, "{not json", '"forest"', "null", "[]", '{"palette":42}', '{"palette":"neon"}', '{"palette":{"name":"ocean"}}', '{"palette":"mine-"}']) {
      expect(() => startWith(saved), String(saved)).not.toThrow();
      expect(startWith(saved).palette, String(saved)).toBe("manut");
    }
  });
});
