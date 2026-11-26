// Settings › General › Suggested next message (item 76): off unless the person turned it on, kept on this computer, and offered only
// for the agent that has an honest way to be asked.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LANGS, setLang, t, type Key } from "../i18n";
import { reloadSuggest, setSuggestOn, SUGGEST_KEY, suggestOn, suggestWorks } from "./suggest";

const disk = new Map<string, string>();
beforeEach(() => {
  disk.clear();
  vi.stubGlobal("localStorage", { getItem: (k: string) => disk.get(k) ?? null, setItem: (k: string, v: string) => void disk.set(k, v), removeItem: (k: string) => void disk.delete(k) });
  reloadSuggest();
});
afterEach(() => {
  vi.unstubAllGlobals();
  reloadSuggest();
});

describe("the setting", () => {
  it("is off by default, and for anything but the one saved word", () => {
    expect(suggestOn()).toBe(false);
    for (const bad of ["true", "1", "yes", "ON", ""]) {
      disk.set(SUGGEST_KEY, bad);
      reloadSuggest();
      expect(suggestOn(), bad).toBe(false);
    }
  });

  it("is kept on this computer when turned on, and forgotten when turned off", () => {
    setSuggestOn(true);
    expect(suggestOn()).toBe(true);
    expect(disk.get(SUGGEST_KEY)).toBe("on");
    reloadSuggest();
    expect(suggestOn()).toBe(true);
    setSuggestOn(false);
    expect(disk.has(SUGGEST_KEY)).toBe(false);
    expect(suggestOn()).toBe(false);
  });

  it("works for Claude Code only: Codex and the other agents have no way to ask", () => {
    expect(suggestWorks("claude")).toBe(true);
    for (const other of ["codex", "pi", "omo", "opencode", "cursor", "dsh", "grok", "shell"]) expect(suggestWorks(other), other).toBe(false);
  });
});

describe("what the setting says", () => {
  it("says in plain words what it costs, that it is off until turned on, that nothing is sent, and which agents it works with", () => {
    setLang("en");
    const hint = t("suggest.hintCost");
    expect(hint).toContain("extra request on your own AI plan");
    expect(hint).toContain("off until you turn it on");
    expect(hint).toContain("never sends anything by itself");
    expect(t("suggest.agentsHint")).toContain("Codex");
    expect(t("suggest.agentsValue")).toBe("Claude Code");
  });

  it("has every word in all four languages", () => {
    const keys: Key[] = ["suggest.group", "suggest.title", "suggest.hintCost", "suggest.agents", "suggest.agentsHint", "suggest.agentsValue", "suggest.hint"];
    for (const l of LANGS) {
      setLang(l);
      for (const k of keys) expect(t(k), `${l} ${k}`).not.toBe(k);
    }
    setLang("en");
  });
});
