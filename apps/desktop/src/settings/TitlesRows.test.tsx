// Settings › General › Titles and words (item 96): off unless the person turns it on, what is saved and how a damaged value reads,
// which agent it is for, and the rows a person sees. What a run is given and how its title is ranked: sessions/titleWords.test.ts.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToString } from "react-dom/server";
import { setLang } from "../i18n";
import { TITLE_MODEL_DEFAULTS, TITLE_MODEL_KEY, parseTitleModel, setTitleModel, titleModel, titlesFor } from "../lib/titleModel";
import { TitlesRows } from "./Settings.slot";

const words = (html: string) => html.replace(/<[^>]*>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ");

function fakeStorage(seed: Record<string, string> = {}): Storage {
  const m = new Map(Object.entries(seed));
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k),
    clear: () => m.clear(), key: () => null, length: 0 } as Storage;
}

beforeEach(() => {
  setLang("en");
  vi.stubGlobal("localStorage", fakeStorage());
});
afterEach(() => vi.unstubAllGlobals());

describe("Settings › General › Titles and words (item 96)", () => {
  it("is off with nothing saved, and for anything saved that is not a plain yes", () => {
    expect(titleModel()).toEqual(TITLE_MODEL_DEFAULTS);
    expect(TITLE_MODEL_DEFAULTS.on).toBe(false);
    expect(parseTitleModel(null).on).toBe(false);
    expect(parseTitleModel("{not json").on).toBe(false);
    for (const on of ['"yes"', "1", '"true"', "null", "[]"]) expect(parseTitleModel(`{"on":${on}}`).on, on).toBe(false);
    expect(parseTitleModel('{"on":true}').on).toBe(true);
  });

  it("keeps only a model and an effort it offers: anything else is Claude Code's own default", () => {
    expect(parseTitleModel('{"on":true,"model":"haiku","effort":"low"}')).toEqual({ on: true, model: "haiku", effort: "low" });
    expect(parseTitleModel('{"on":true,"model":"--dangerously-skip-permissions","effort":"max; rm"}')).toEqual({ on: true, model: "", effort: "" });
    expect(parseTitleModel('{"on":true,"model":7,"effort":["low"]}')).toEqual({ on: true, model: "", effort: "" });
  });

  it("saves what the person picks on this computer and reads it back", () => {
    setTitleModel({ on: true });
    setTitleModel({ model: "sonnet" });
    expect(JSON.parse(localStorage.getItem(TITLE_MODEL_KEY) ?? "{}")).toEqual({ on: true, model: "sonnet", effort: "" });
    expect(titleModel()).toEqual({ on: true, model: "sonnet", effort: "" });
    setTitleModel({ on: false });
    expect(titleModel().on).toBe(false);
  });

  it("is for Claude Code's chats only, and only while it is on", () => {
    expect(titlesFor("claude")).toBe(false);
    setTitleModel({ on: true });
    expect(titlesFor("claude")).toBe(true);
    for (const agent of ["codex", "opencode", "gemini", ""]) expect(titlesFor(agent), agent).toBe(false);
  });

  it("shows the switch off, what a run reads, the model, the effort and which agent it works with", () => {
    const off = renderToString(<TitlesRows />);
    expect(words(off)).toContain("Titles and words");
    expect(words(off)).toContain("Off until you turn it on.");
    expect(words(off)).toContain("What it reads");
    expect(words(off)).toContain("nothing is read from a file that holds keys");
    expect(words(off)).toContain("Only Claude Code can write them for now.");
    expect(off).toMatch(/data-testid="set-titles-on"[^>]*aria-checked="false"|aria-checked="false"[^>]*data-testid="set-titles-on"/);
    setTitleModel({ on: true, model: "haiku" });
    const on = renderToString(<TitlesRows />);
    expect(on).toMatch(/data-testid="set-titles-on"[^>]*aria-checked="true"|aria-checked="true"[^>]*data-testid="set-titles-on"/);
    expect(on).toMatch(/<option value="haiku" selected="">Haiku<\/option>/);
  });
});
