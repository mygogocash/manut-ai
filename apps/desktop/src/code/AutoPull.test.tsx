// Settings › Source control › Automatically pull from the page's side (src/code/AutoPull.tsx, src/lib/sourceControl.ts): off by
// default, asked for only while on and at most every fifteen minutes for a project, never for a lane's folder by the page's own
// choice either, and each answer of the shell said in words, with the shell's answer read before it is believed.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { renderToString } from "react-dom/server";
import { LANGS, setLang, t } from "../i18n";
import type { MockCall } from "../sessions/host";
import { lastPull, markPull, parseSource, PULL_EVERY_MS, pullDue, setSourceSettings, SOURCE_DEFAULTS, sourceSettings, startMethod } from "../lib/sourceControl";
import { AutoPullView, pullIfDue, pullLine, resetAutoPull } from "./AutoPull";
import { PULL_CODES, readPulled, type Pulled } from "./source";

const store = new Map<string, string>();
beforeEach(() => {
  store.clear();
  (globalThis as { localStorage?: unknown }).localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) };
  resetAutoPull();
  setLang("en");
});
afterEach(() => setLang("en"));

const P = (o: Partial<Pulled>): Pulled => ({ done: false, why: "current", branch: "main", remote: "origin", from: "a1b2c3d", to: "a1b2c3d", count: 0, ...o });

describe("the switch", () => {
  it("is off by default and a damaged value is the default", () => {
    expect(sourceSettings()).toEqual(SOURCE_DEFAULTS);
    expect(SOURCE_DEFAULTS.autoPull).toBe(false);
    for (const damaged of [null, "", "not json", "[]", '{"autoPull":"yes","mergeMethod":"fast-forward","lastMethod":7,"dropCredits":"on"}']) expect(parseSource(damaged), String(damaged)).toEqual(SOURCE_DEFAULTS);
    // what a merge's ask starts with: the last method chosen (a merge commit until one is), or the one set
    expect(SOURCE_DEFAULTS).toMatchObject({ mergeMethod: "last", lastMethod: "merge", dropCredits: false });
    expect(startMethod(sourceSettings())).toBe("merge");
    setSourceSettings({ lastMethod: "squash" });
    expect(startMethod(sourceSettings())).toBe("squash");
    setSourceSettings({ mergeMethod: "rebase" });
    expect(startMethod(sourceSettings())).toBe("rebase");
    setSourceSettings({ autoPull: true });
    expect(sourceSettings().autoPull).toBe(true);
  });

  it("runs a project's pull at most every fifteen minutes, and again when the clock went back", () => {
    expect(pullDue(1000, undefined)).toBe(true);
    expect(pullDue(1000 + PULL_EVERY_MS - 1, 1000)).toBe(false);
    expect(pullDue(1000 + PULL_EVERY_MS, 1000)).toBe(true);
    expect(pullDue(500, 1000)).toBe(true);
    markPull("/w/a", 10);
    expect(lastPull("/w/a")).toBe(10);
    expect(lastPull("/w/b")).toBeUndefined();
  });
});

describe("asking the shell", () => {
  // the page's host in a test is the browser stand-in, which reads what e2e would set on the window
  const host = (pulled: Record<string, unknown> = {}) => {
    const calls: MockCall[] = [];
    Object.assign(globalThis, { __manutSessionCalls: calls, __manutPulled: pulled });
    return calls;
  };

  it("asks nothing while the switch is off", async () => {
    const calls = host();
    expect(await pullIfDue("/w/shop", 1_000_000)).toBeNull();
    expect(calls).toEqual([]);
  });

  it("asks once while it is on, then not again within fifteen minutes", async () => {
    const calls = host({ "/w/shop": { done: true, why: "pulled", branch: "main", remote: "origin", from: "a1b2c3d", to: "e4f5a6b", count: 3 } });
    setSourceSettings({ autoPull: true });
    expect(await pullIfDue("/w/shop", 1_000_000)).toMatchObject({ done: true, count: 3 });
    expect(await pullIfDue("/w/shop", 1_000_000 + 60_000)).toBeNull();
    expect(await pullIfDue("/w/shop", 1_000_000 + PULL_EVERY_MS)).toMatchObject({ why: "pulled" });
    expect(calls.map((c) => [c.op, c.cwd])).toEqual([
      ["source.pull", "/w/shop"],
      ["source.pull", "/w/shop"],
    ]);
  });
});

describe("what the line says", () => {
  it("says what came, or why nothing was done, for every code the shell answers", () => {
    expect(pullLine(P({ done: true, why: "pulled", count: 3, from: "a1b2c3d", to: "e4f5a6b" }))).toBe("Brought main up to date with origin: 3 new commits (a1b2c3d to e4f5a6b).");
    expect(pullLine(P({ done: true, why: "pulled", count: 1 }))).toContain("1 new commit (");
    expect(pullLine(P({}))).toBe("main is up to date with origin.");
    expect(pullLine(P({ why: "changes" }))).toBe("Did not pull main: the folder has changed or new files.");
    expect(pullLine(P({ why: "diverged" }))).toContain("cannot simply move forward");
    // a folder that is not a repository, or a lane's: nothing on the page
    expect(pullLine(P({ why: "not_a_repository" }))).toBeNull();
    expect(pullLine(P({ why: "lane" }))).toBeNull();
    for (const l of LANGS) {
      setLang(l);
      for (const why of PULL_CODES) {
        const line = pullLine(P({ why }));
        if (why === "not_a_repository" || why === "lane") continue;
        expect(line, `${l} ${why}`).toBeTruthy();
        expect(line, `${l} ${why}`).not.toContain("pull.why.");
      }
    }
  });

  it("draws the line only for an answer that says something", () => {
    expect(renderToString(<AutoPullView pulled={P({ why: "ahead" })} />)).toContain('data-why="ahead"');
    expect(renderToString(<AutoPullView pulled={P({ why: "lane" })} />)).toBe("");
    expect(renderToString(<AutoPullView pulled={null} />)).toBe("");
    expect(t("pull.why.ahead", { branch: "main" })).toContain("not on a remote");
  });

  it("believes only an answer that is a pull's", () => {
    expect(readPulled({ done: true, why: "pulled", branch: "main", remote: "origin", from: "a", to: "b", count: 2 })).toMatchObject({ done: true, count: 2 });
    // done only with `pulled`
    expect(readPulled({ done: true, why: "changes" })?.done).toBe(false);
    for (const bad of [null, "pulled", { why: "merged" }, { done: true }, []]) expect(readPulled(bad), JSON.stringify(bad)).toBeNull();
    expect(readPulled({ why: "pulled", count: -4 })?.count).toBe(0);
  });
});
