// The palette adds no power of its own. This file holds the registry to that: no action that settles an ask, and every
// action it lists is something the app already offers somewhere else.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { LANGS, setLang } from "../i18n";
import { ACTIONS, doRows, goRows, type PaletteCtx } from "./registry";
import { buildGroups, CHAT_LIMIT, flat } from "./groups";
import type { Places } from "./places";

const here = dirname(fileURLToPath(import.meta.url));
const src = join(here, "..");

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? files(p) : [p];
  });
}
const isTest = (p: string) => /\.test\.tsx?$/.test(p);
const code = files(src).filter((p) => /\.tsx?$/.test(p));
const appSource = code.filter((p) => !isTest(p) && !p.startsWith(here)).map((p) => readFileSync(p, "utf8")).join("\n");

const calls: string[] = [];
const spy = (name: string) => (...a: unknown[]) => void calls.push(`${name}(${a.join(",")})`);

function ctx(over: Partial<PaletteCtx> = {}, places: Places = {}): PaletteCtx {
  return {
    lang: "en",
    bots: [
      { name: "buddy", displayName: "Buddy" },
      { name: "nam", displayName: "Nam" },
    ],
    buddy: { name: "buddy", displayName: "Buddy" },
    people: false,
    places,
    openPage: spy("openPage"),
    openHistory: spy("openHistory"),
    openSettings: spy("openSettings"),
    newThread: spy("newThread"),
    setLanguage: spy("setLanguage"),
    openNewSessionMenu: spy("openNewSessionMenu"),
    workflows: [],
    runWorkflow: spy("runWorkflow"),
    ...over,
  };
}

/** Every place at once, each press recorded. */
const everyPlace = (): Places => ({
  box: { micLive: () => false, modeLive: () => false, spoken: () => "Thai", toggleMic: spy("toggleMic"), toggleMode: spy("toggleMode") },
  lane: { newLane: spy("newLane") },
  pause: { ask: spy("pauseAsk") },
  runtime: { mode: "practice", set: spy("setRuntime") },
});

beforeEach(() => {
  calls.length = 0;
  setLang("en");
});

describe("the registry holds no action that settles an ask or does anything that costs", () => {
  const forbidden = /approve|allow|deny|decline|reject|answer|settle|send|submit|remove|delete|discard|pay|buy|publish|post|resume|restart|kill|stop-run|interrupt/i;

  it("names no such action, by id or by row", () => {
    for (const a of ACTIONS) expect(a.id, a.id).not.toMatch(forbidden);
    for (const r of doRows(ctx({}, everyPlace()))) expect(r.id, r.id).not.toMatch(forbidden);
  });

  it("never reaches the code that settles an ask, sends, removes or pays", () => {
    const own = files(here).filter((p) => /\.tsx?$/.test(p) && !isTest(p));
    expect(own.length).toBeGreaterThan(4);
    const text = own.map((p) => readFileSync(p, "utf8")).join("\n");
    // the one ask path (settleApproval), the answer to a question, a chat's send, a removal and the pause's own
    // confirm and resume: the palette may open the Pause question, never press its buttons
    for (const bad of [/settleApproval/, /resolveAsk/, /chat\/cards/, /threadSend/, /\.send\(/, /removeBot/, /teamPause/, /teamResume/, /onPause\b/, /onResume\b/, /approval-core/]) {
      expect(text, String(bad)).not.toMatch(bad);
    }
  });

  it("offers the Pause question, which asks, and not the pause itself", () => {
    const rows = doRows(ctx({}, everyPlace()));
    const pause = rows.find((r) => r.id === "do:pause-question");
    expect(pause).toBeDefined();
    pause!.run();
    expect(calls).toEqual(["pauseAsk()"]);
  });
});

describe("every action it lists is reachable elsewhere in the app", () => {
  it("has a place in the app's own files for each definition", () => {
    for (const a of ACTIONS) {
      const found = a.elsewhere.includes("(") ? appSource.includes(a.elsewhere) : new RegExp(`test[iI]d=["'{\`]+${a.elsewhere}["'\`}]`).test(appSource);
      expect(found, `${a.id} names "${a.elsewhere}"`).toBe(true);
    }
  });

  it("has unique ids", () => {
    const ids = ACTIONS.map((a) => a.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("goes to pages the app has: each menu row's page and each Settings page", () => {
    const rows = goRows(ctx({ people: true }));
    for (const r of rows) r.run();
    const pages = calls.filter((c) => c.startsWith("openPage")).sort();
    expect(pages).toEqual(["openPage(artifacts)", "openPage(code)", "openPage(customize)", "openPage(history)", "openPage(home)", "openPage(needs)", "openPage(team)"]);
    const settings = calls.filter((c) => c.startsWith("openSettings"));
    expect(settings).toEqual([
      "openSettings(general)", "openSettings(bots)", "openSettings(bot:buddy)", "openSettings(bot:nam)", "openSettings(people)", "openSettings(voice)", "openSettings(remote)",
      "openSettings(terminal)", "openSettings(providers)", "openSettings(computer)", "openSettings(worktrees)", "openSettings(source)", "openSettings(artifacts)", "openSettings(mcp)", "openSettings(workflows)", "openSettings(developer)", "openSettings(report)",
    ]);
  });

  it("lists Settings › People only where Settings does", () => {
    expect(goRows(ctx({ people: false })).some((r) => r.id === "go:settings:people")).toBe(false);
    expect(goRows(ctx({ people: true })).some((r) => r.id === "go:settings:people")).toBe(true);
  });
});

describe("an action that needs a place that is not open is not listed", () => {
  it("lists only what no place is needed for when none is open", () => {
    const ids = doRows(ctx()).map((r) => r.id);
    expect(ids).toContain("do:new-chat");
    expect(ids).toContain("do:new-session");
    for (const gone of ["do:new-lane", "do:microphone", "do:voice-mode", "do:pause-question"]) expect(ids, gone).not.toContain(gone);
    expect(ids.some((i) => i.startsWith("do:runtime"))).toBe(false);
  });

  it("lists each once its place is open, and presses the button's own function", () => {
    const rows = doRows(ctx({}, everyPlace()));
    const byId = new Map(rows.map((r) => [r.id, r]));
    for (const id of ["do:new-lane", "do:microphone", "do:voice-mode", "do:pause-question", "do:runtime:connected"]) byId.get(id)!.run();
    expect(calls).toEqual(["newLane()", "toggleMic()", "toggleMode()", "pauseAsk()", "setRuntime(connected)"]);
  });

  it("draws Open in <editor> by the editor's own logo, every other row by an icon of the set (item 122)", () => {
    const rows = doRows(ctx({ editor: { id: "zed", label: "Zed" } }, { ...everyPlace(), editorProject: { open: spy("editorProject") }, editorSession: { open: spy("editorSession") } }));
    const marked = rows.filter((r) => r.mark);
    expect(marked.map((r) => [r.id, r.mark])).toEqual([
      ["do:open-editor:project", { id: "zed", title: "Zed" }],
      ["do:open-editor:session", { id: "zed", title: "Zed" }],
    ]);
    for (const r of rows) expect(r.icon, r.id).toBeTruthy();
  });

  it("names the microphone and voice mode by their state, as their buttons do", () => {
    const on = everyPlace();
    on.box = { ...on.box!, micLive: () => true, modeLive: () => true };
    const labels = doRows(ctx({}, on)).map((r) => r.label);
    expect(labels).toContain("Stop listening (Esc)");
    expect(labels).toContain("Stop voice mode (Esc)");
    expect(doRows(ctx({}, everyPlace())).map((r) => r.label)).toContain("Speak your message (Thai)");
  });

  it("offers the other runtime and the other languages only", () => {
    const places = everyPlace();
    expect(doRows(ctx({}, places)).map((r) => r.id)).toContain("do:runtime:connected");
    places.runtime = { mode: "connected", set: spy("setRuntime") };
    expect(doRows(ctx({}, places)).map((r) => r.id)).toContain("do:runtime:practice");
    expect(doRows(ctx()).filter((r) => r.id.startsWith("do:language:")).map((r) => r.id)).toEqual(LANGS.filter((l) => l !== "en").map((l) => `do:language:${l}`));
  });

  it("offers Run workflow for each workflow Settings › Workflows offers Run now for, and presses that Run now", () => {
    expect(doRows(ctx()).some((r) => r.id.startsWith("do:workflow:"))).toBe(false);
    const rows = doRows(ctx({ workflows: [{ file: "nightly.json", name: "Nightly tests" }, { file: "weekly.json", name: "Weekly tidy" }] })).filter((r) => r.id.startsWith("do:workflow:"));
    expect(rows.map((r) => r.label)).toEqual(["Run workflow: Nightly tests", "Run workflow: Weekly tidy"]);
    rows[1].run();
    expect(calls).toEqual(["runWorkflow(weekly.json)"]);
  });

  it("offers no new chat when Buddy cannot be reached", () => {
    expect(doRows(ctx({ buddy: null })).map((r) => r.id)).not.toContain("do:new-chat");
    const row = doRows(ctx()).find((r) => r.id === "do:new-chat")!;
    expect(row.label).toBe("New thread with Buddy");
    row.run();
    expect(calls).toEqual(["newThread(buddy)"]);
  });
});

describe("the list for what is typed", () => {
  const chat = (n: number) => ({ id: `chat:${n}`, label: `Refund ${n}`, hint: "Nam", run: spy(`chat${n}`) });

  it("is short with nothing typed: the menu's pages and what can be done, no Settings pages and no chats", () => {
    const groups = buildGroups(ctx(), "", [chat(1)]);
    expect(groups.map((g) => g.key)).toEqual(["go", "do"]);
    expect(groups[0].rows.every((r) => !r.id.startsWith("go:settings:"))).toBe(true);
  });

  it("orders the groups Go to, Do, Chats, then the History row, and finds by the words shown", () => {
    const groups = buildGroups(ctx({}, everyPlace()), "e", [chat(1), chat(2)]);
    expect(groups.map((g) => g.key)).toEqual(["go", "do", "chats", "history"]);
    const settings = buildGroups(ctx(), "voice", []).find((g) => g.key === "go")!;
    expect(settings.rows.map((r) => r.label)).toEqual(["Settings › Voice"]);
  });

  it("finds Settings pages by their names in each language", () => {
    setLang("ja");
    expect(flat(buildGroups(ctx(), "音声", [])).some((r) => r.id === "go:settings:voice")).toBe(true);
    setLang("zh");
    expect(flat(buildGroups(ctx(), "语音", [])).some((r) => r.id === "go:settings:voice")).toBe(true);
  });

  it("shows the chats History's search found, at most the first few, and ends with a row that searches History", () => {
    const found = Array.from({ length: CHAT_LIMIT + 3 }, (_, i) => chat(i));
    const groups = buildGroups(ctx(), "refund", found);
    expect(groups.find((g) => g.key === "chats")!.rows).toHaveLength(CHAT_LIMIT);
    const last = flat(groups).at(-1)!;
    expect(last.label).toBe('Search History for "refund"');
    last.run();
    expect(calls).toEqual(["openHistory(refund)"]);
  });

  it("keeps the History row alone when nothing else matches", () => {
    const groups = buildGroups(ctx(), "zzzz", []);
    expect(groups.map((g) => g.key)).toEqual(["history"]);
  });
});

vi.mock("../sessions/newMenu", () => ({ openNewSessionMenu: () => {} }));
