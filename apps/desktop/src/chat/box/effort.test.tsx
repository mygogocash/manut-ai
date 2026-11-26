// The effort card's rules (item 132), as GoSpark's EffortSlider.swift and UltrathinkDraft.swift have them: the title
// words, the default and Reset, where a drag or a key lands, the provider's colour at the top level, the Ultrathink
// row's line, and the card drawn from props with react-dom/server. How it moves under a hand and what reaches the agent
// is e2e/effort-card.spec.ts's.
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DICT, LANGS, setLang } from "../../i18n";
import { brandColour, defaultEffort, effortTitle, isTop, keyStop, nearestStop, pointerFraction, restingIndex, stopFraction, TRACK_H } from "./effort";
import { keywordAt, settingUltrathink, takesSlashPath, ULTRATHINK_LINE, ultrathinkRow, ultrathinkState } from "./ultrathink";
import { EffortCard, type EffortCardProps } from "./EffortCard";

afterEach(() => setLang("en"));

const CLAUDE = ["low", "medium", "high", "xhigh", "max"];

describe("the title words", () => {
  it("are GoSpark's: the agent's word with a capital, and xhigh written out", () => {
    expect(CLAUDE.map(effortTitle)).toEqual(["Low", "Medium", "High", "Extra High", "Max"]);
    expect(["none", "minimal", "ultra", "extra-high"].map(effortTitle)).toEqual(["None", "Minimal", "Ultra", "Extra High"]);
    expect(effortTitle("")).toBe("Default");
  });

  it("stay in English in every language, as the agent's own setting names do", () => {
    for (const l of LANGS) {
      setLang(l);
      expect(effortTitle("xhigh")).toBe("Extra High");
    }
  });
});

describe("the default and where the knob rests", () => {
  it("falls back as GoSpark's defaultEffort does when a model names no default: high or medium in the agent's order, else the first", () => {
    expect(defaultEffort(CLAUDE)).toBe("medium");
    expect(defaultEffort(["low", "high"])).toBe("high");
    expect(defaultEffort(["minimal", "low"])).toBe("minimal");
    expect(defaultEffort([])).toBeNull();
  });

  it("rests on the level in force, else on the default, else on the first stop", () => {
    expect(restingIndex(CLAUDE, "xhigh")).toBe(3);
    expect(restingIndex(CLAUDE, "")).toBe(1);
    expect(restingIndex(CLAUDE, "turbo")).toBe(1);
    expect(restingIndex(["minimal", "low"], "")).toBe(0);
    expect(restingIndex([], "high")).toBe(0);
  });

  it("calls only the last of more than one level the top", () => {
    expect(isTop(4, 5)).toBe(true);
    expect(isTop(3, 5)).toBe(false);
    expect(isTop(0, 1)).toBe(false);
  });
});

describe("where a drag, a click or a key lands", () => {
  it("puts the first and last stops half the track's height in from its ends, and a pointer beyond them on them", () => {
    const width = 298;
    expect(pointerFraction(TRACK_H / 2, width)).toBe(0);
    expect(pointerFraction(width - TRACK_H / 2, width)).toBe(1);
    expect(pointerFraction(0, width)).toBe(0);
    expect(pointerFraction(width + 40, width)).toBe(1);
    expect(pointerFraction(width / 2, width)).toBeCloseTo(0.5);
    expect(pointerFraction(10, 20)).toBe(0);
  });

  it("snaps to the nearest stop", () => {
    expect([0, 0.12, 0.13, 0.5, 0.62, 0.63, 0.87, 0.88, 1].map((f) => nearestStop(f, 5))).toEqual([0, 0, 1, 2, 2, 3, 3, 4, 4]);
    expect(nearestStop(0.7, 1)).toBe(0);
    // a stop's place and the fraction that lands on it agree
    for (let i = 0; i < 6; i++) expect(nearestStop(stopFraction(i, 6), 6)).toBe(i);
  });

  it("moves one stop with the arrows, to either end with Home and End, and ignores other keys", () => {
    expect(keyStop("ArrowRight", 1, 5)).toBe(2);
    expect(keyStop("ArrowUp", 1, 5)).toBe(2);
    expect(keyStop("ArrowLeft", 1, 5)).toBe(0);
    expect(keyStop("ArrowDown", 1, 5)).toBe(0);
    expect(keyStop("ArrowRight", 4, 5)).toBe(4);
    expect(keyStop("ArrowLeft", 0, 5)).toBe(0);
    expect(keyStop("Home", 3, 5)).toBe(0);
    expect(keyStop("End", 1, 5)).toBe(4);
    expect(keyStop("Enter", 1, 5)).toBeNull();
    expect(keyStop("ArrowRight", 0, 0)).toBeNull();
  });
});

describe("the provider's colour at the top level", () => {
  it("is the one colour a provider's mark is drawn in, and the ink for a mark drawn in the text's colour", () => {
    expect(brandColour("claude")).toBe("#d97757");
    expect(brandColour("claude-code")).toBe("#d97757");
    expect(brandColour("deepseek")).toBe("#4d6bfe");
    // Codex and OpenAI's marks are drawn in the text's colour, as GoSpark's silver brands are white
    expect(brandColour("codex")).toBeNull();
    expect(brandColour("openai")).toBeNull();
    expect(brandColour("pi")).toBeNull();
    // Gemini's star is drawn in its one blue (with a gradient over it); Antigravity's in several colours, so the ink
    expect(brandColour("gemini")).toBe("#3186ff");
    expect(brandColour("antigravity")).toBeNull();
    expect(brandColour("someone-else")).toBeNull();
    expect(brandColour("")).toBeNull();
  });
});

describe("the Ultrathink row", () => {
  it("reads the keyword as Claude Code does: whole words, any case, never in a slash command", () => {
    expect(keywordAt("please ULTRATHINK this")).toEqual([7]);
    expect(keywordAt("ultrathinking")).toEqual([]);
    expect(keywordAt("ultrathinkครับ")).toEqual([0]);
    expect(keywordAt("ultrathinK")).toEqual([]);
    expect(keywordAt("  /review ultrathink")).toEqual([]);
    expect(takesSlashPath("\n /x")).toBe(true);
    expect(takesSlashPath("a /x")).toBe(false);
  });

  it("adds its visible line at the top, and takes away only that line", () => {
    expect(settingUltrathink(true, "fix the checkout")).toBe(`${ULTRATHINK_LINE}\nfix the checkout`);
    expect(settingUltrathink(true, "")).toBe(`${ULTRATHINK_LINE}\n`);
    expect(ultrathinkState(`${ULTRATHINK_LINE}\nfix the checkout`)).toBe("inserted");
    expect(settingUltrathink(false, `${ULTRATHINK_LINE}\nfix the checkout`)).toBe("fix the checkout");
    expect(settingUltrathink(false, ULTRATHINK_LINE)).toBe("");
    // on and on again changes nothing; off when it is off changes nothing
    expect(settingUltrathink(true, `${ULTRATHINK_LINE}\nx`)).toBe(`${ULTRATHINK_LINE}\nx`);
    expect(settingUltrathink(false, "x")).toBe("x");
  });

  it("locks on a word the person typed, which only they can take out", () => {
    expect(ultrathinkState("ultrathink about the cart")).toBe("typed");
    expect(ultrathinkState(`${ULTRATHINK_LINE}\nand ultrathink again`)).toBe("typed");
    expect(settingUltrathink(false, "ultrathink about the cart")).toBe("ultrathink about the cart");
    expect(ultrathinkRow("ultrathink about the cart", true, true)).toEqual({ kind: "typed" });
    // the line edited into something else is the person's own text now
    expect(ultrathinkState("Ultrathink: and more")).toBe("typed");
    expect(ultrathinkState("Ultrathinker:\nx")).toBe("off");
  });

  it("is off and locked for a slash command, which never gets a line in front of it", () => {
    expect(ultrathinkRow("/review the cart", true, true)).toEqual({ kind: "slash" });
    expect(settingUltrathink(true, "/review the cart")).toBe("/review the cart");
  });

  it("shows only in a Claude Code chat whose model has levels", () => {
    expect(ultrathinkRow("hi", false, true)).toEqual({ kind: "hidden" });
    expect(ultrathinkRow("hi", true, false)).toEqual({ kind: "hidden" });
    expect(ultrathinkRow("hi", true, true)).toEqual({ kind: "toggle", on: false });
    expect(ultrathinkRow(`${ULTRATHINK_LINE}\nhi`, true, true)).toEqual({ kind: "toggle", on: true });
  });

  it("keeps the keyword in Latin in every language's words", () => {
    for (const l of LANGS) {
      for (const k of ["ef.utTitle", "ef.utAdds"] as const) expect(DICT[l][k], `${l} ${k}`).toMatch(/Ultrathink/);
      expect(DICT[l]["ef.utAdds"], l).toContain("Ultrathink:");
      expect(DICT[l]["ef.utTyped"], l).toContain("ultrathink");
    }
  });
});

describe("the card", () => {
  const card = (over: Partial<EffortCardProps> = {}) =>
    renderToString(
      createElement(EffortCard, {
        modelName: "Opus 5.5",
        mark: { model: "Opus 5.5", provider: "claude" },
        levels: CLAUDE,
        level: "high",
        canPick: true,
        brand: brandColour("claude"),
        onLevel: vi.fn(),
        onReset: vi.fn(),
        onModels: vi.fn(),
        empty: "nothing yet",
        ...over,
      }),
    );

  it("names the level large with the model under it, one stop for each level, and Reset", () => {
    const html = card();
    expect(html).toMatch(/data-testid="effort-level"[^>]*>High</);
    expect(html).toMatch(/data-testid="effort-model"/);
    expect(html).toContain("Opus 5.5");
    expect(html.match(/data-testid="effort-stop"/g)).toHaveLength(5);
    expect(html).toMatch(/role="slider"[^>]*aria-valuemin="0"[^>]*aria-valuemax="4"[^>]*aria-valuenow="2"[^>]*aria-valuetext="High"/);
    expect(html).toMatch(/data-testid="effort-reset"/);
    expect(html).not.toMatch(/data-testid="effort-reset"[^>]*disabled/);
    expect(html).not.toContain("data-top");
  });

  it("takes the provider's colour at the top level only, and the ink for a provider drawn in it", () => {
    const top = card({ level: "max" });
    expect(top).toContain("data-top");
    expect(top).toContain("--ef-brand:#d97757");
    expect(top).toContain('data-brand="colour"');
    const codex = card({ level: "max", brand: brandColour("codex"), mark: { model: "GPT-6", provider: "openai" } });
    expect(codex).toContain("--ef-brand:var(--ink)");
    expect(codex).toContain('data-brand="ink"');
  });

  it("rests on the default while the agent has not said which level runs", () => {
    expect(card({ level: "" })).toMatch(/data-testid="effort-level"[^>]*>Medium</);
  });

  it("with no levels: Standard, the reason in the slider's place, and nothing to reset", () => {
    const html = card({ levels: [], level: "" });
    expect(html).toMatch(/data-testid="effort-level"[^>]*>Standard</);
    expect(html).toMatch(/data-testid="effort-none"[^>]*>nothing yet</);
    expect(html).not.toContain('role="slider"');
    expect(html).toMatch(/data-testid="effort-reset"[^>]*disabled|disabled[^>]*data-testid="effort-reset"/);
  });

  it("holds the slider while no level can be picked", () => {
    const html = card({ canPick: false });
    expect(html).toMatch(/role="slider"[^>]*tabindex="-1"[^>]*aria-disabled="true"/);
  });

  it("draws the Ultrathink row as its state says, with the line that says why it is locked", () => {
    const onChange = vi.fn();
    expect(card()).not.toContain("ultrathink-row");
    const off = card({ ultrathink: { row: { kind: "toggle", on: false }, onChange } });
    expect(off).toMatch(/data-testid="ultrathink-row"[^>]*data-state="toggle"/);
    expect(off).toMatch(/role="switch"[^>]*aria-checked="false"/);
    expect(off).toContain("Adds “Ultrathink:” to the top of this message");
    const typed = card({ ultrathink: { row: { kind: "typed" }, onChange } });
    expect(typed).toMatch(/role="switch"[^>]*aria-checked="true"[^>]*disabled/);
    expect(typed).toContain("Delete “ultrathink” from your message to turn this off.");
    const slash = card({ ultrathink: { row: { kind: "slash" }, onChange } });
    expect(slash).toMatch(/role="switch"[^>]*aria-checked="false"[^>]*disabled/);
    expect(slash).toContain("Claude Code ignores ultrathink in a slash command.");
    expect(card({ ultrathink: { row: { kind: "hidden" }, onChange } })).not.toContain("ultrathink-row");
  });
});
