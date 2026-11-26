// Bring over's rules (offer.ts, item 101e): the shell's answer read defensively, the found folders marked when they are projects
// already, the steps from nothing picked to the confirmation and the result, bringing over twice adding nothing twice, History's
// folders, the record this computer keeps, and when a launch looks at all.
import { describe, expect, it } from "vitest";
import { addedFolders, parseFolderPrefs, type FolderPrefs } from "../sessions/folders";
import {
  bringOver,
  hasNew,
  historyFolders,
  importReduce,
  NO_SKIPS,
  offerRows,
  parseRecord,
  pickedConversations,
  readFound,
  shouldLook,
  skipParts,
  type ImportFound,
  type ImportStep,
} from "./offer";

const WEB = "/home/you/code/web-app";
const API = "/home/you/code/shop-api";
const OLD = "/home/you/code/manut";
const found: ImportFound = {
  projects: [
    { cwd: WEB, claude: 10, codex: 2, at: 300 },
    { cwd: API, claude: 0, codex: 4, at: 500 },
    { cwd: OLD, claude: 3, codex: 0, at: 100 },
  ],
  skipped: { gone: 2, compressed: 5, unreadable: 0, over_limit: 0 },
  partial: false,
};
const NONE: FolderPrefs = { collapsed: [], order: [] };

describe("the shell's answer", () => {
  it("keeps absolute folders with a conversation, and reads anything else as nothing", () => {
    const got = readFound({
      projects: [
        { cwd: WEB, claude: 1, codex: 0, at: 5 },
        { cwd: "relative/x", claude: 1, codex: 0, at: 5 },
        { cwd: "/no/conversations", claude: 0, codex: 0, at: 5 },
        { cwd: "C:\\work\\shop", claude: -3, codex: 2.7, at: "x" },
        "junk",
      ],
      skipped: { gone: 1, compressed: "7", unreadable: 2 },
      partial: true,
    });
    expect(got).toEqual({
      projects: [
        { cwd: WEB, claude: 1, codex: 0, at: 5 },
        { cwd: "C:\\work\\shop", claude: 0, codex: 2, at: 0 },
      ],
      skipped: { gone: 1, compressed: 0, unreadable: 2, over_limit: 0 },
      partial: true,
    });
    for (const bad of [null, "x", 3, {}, { projects: "no" }]) expect(readFound(bad)).toBeNull();
  });
});

describe("the offer's list", () => {
  it("lists the found folders newest first, each with its conversations, and marks the ones that are projects already", () => {
    const rows = offerRows(found, [`${OLD}/`, "/elsewhere"]);
    expect(rows.map((r) => [r.cwd, r.total, r.here])).toEqual([
      [API, 4, false],
      [WEB, 12, false],
      [OLD, 3, true],
    ]);
    expect(hasNew(rows)).toBe(true);
    expect(hasNew(offerRows(found, [WEB, API, OLD]))).toBe(false);
    expect(hasNew(offerRows({ projects: [], skipped: NO_SKIPS, partial: false }, []))).toBe(false);
  });

  it("names what was skipped in a fixed order, each only when there is one", () => {
    expect(skipParts(found.skipped)).toEqual([
      { part: "gone", n: 2 },
      { part: "compressed", n: 5 },
    ]);
    expect(skipParts(NO_SKIPS)).toEqual([]);
  });
});

describe("the offer's steps", () => {
  const start = (listed: string[] = [OLD]): ImportStep => importReduce({ at: "looking" }, { type: "found", found, listed });

  it("start with nothing picked, and do not move on until something is", () => {
    const s = start();
    expect(s).toMatchObject({ at: "pick", picked: [] });
    expect(importReduce(s, { type: "next" })).toBe(s);
  });

  it("pick and unpick a folder, never one that is a project already, and keep the picks in the list's order", () => {
    let s = start();
    s = importReduce(s, { type: "toggle", cwd: WEB });
    s = importReduce(s, { type: "toggle", cwd: `${API}/` });
    expect(s.at === "pick" && s.picked).toEqual([API, WEB]);
    expect(importReduce(s, { type: "toggle", cwd: OLD })).toBe(s);
    expect(importReduce(s, { type: "toggle", cwd: "/not/found" })).toBe(s);
    s = importReduce(s, { type: "toggle", cwd: API });
    expect(s.at === "pick" && s.picked).toEqual([WEB]);
  });

  it("select all picks every folder that is not a project yet, and clear picks none", () => {
    const all = importReduce(start(), { type: "all", on: true });
    expect(all.at === "pick" && all.picked).toEqual([API, WEB]);
    const none = importReduce(all, { type: "all", on: false });
    expect(none.at === "pick" && none.picked).toEqual([]);
  });

  it("confirm the picks, go back to them, and end on what was brought over", () => {
    let s = importReduce(start(), { type: "toggle", cwd: WEB });
    s = importReduce(s, { type: "next" });
    expect(s).toMatchObject({ at: "confirm", picked: [WEB] });
    expect(s.at === "confirm" && pickedConversations(s.rows, s.picked)).toBe(12);
    // a pick cannot change on the confirmation
    expect(importReduce(s, { type: "toggle", cwd: API })).toBe(s);
    const back = importReduce(s, { type: "back" });
    expect(back).toMatchObject({ at: "pick", picked: [WEB] });
    expect(importReduce(s, { type: "brought", brought: [WEB], conversations: 12 })).toEqual({ at: "done", brought: [WEB], conversations: 12 });
    // nothing is brought over without the confirmation
    expect(importReduce(back, { type: "brought", brought: [WEB], conversations: 12 })).toBe(back);
  });

  it("say why a look failed", () => {
    expect(importReduce({ at: "looking" }, { type: "failed", why: "busy" })).toEqual({ at: "failed", why: "busy" });
  });
});

describe("bringing over", () => {
  it("adds each pick to the Code page's list, the newest on top, and keeps it for History", () => {
    const { rec, prefs } = bringOver({ offered: false, folders: [] }, NONE, [API, WEB], []);
    expect(addedFolders(prefs)).toEqual([API, WEB]);
    expect(prefs.order.slice(0, 2)).toEqual([API, WEB]);
    expect(rec).toEqual({ offered: true, folders: [API, WEB] });
  });

  it("adds nothing twice when it runs twice, and keeps what the person had", () => {
    const had = parseFolderPrefs(JSON.stringify({ collapsed: ["/mine"], order: ["/mine"], added: ["/mine"] }));
    const once = bringOver({ offered: false, folders: [] }, had, [WEB], ["/mine"]);
    const twice = bringOver(once.rec, once.prefs, [WEB, `${WEB}/`], ["/mine", WEB]);
    expect(addedFolders(twice.prefs)).toEqual([WEB, "/mine"]);
    expect(twice.prefs.collapsed).toEqual(["/mine"]);
    expect(twice.rec.folders).toEqual([WEB]);
    expect(JSON.stringify(twice.prefs)).toBe(JSON.stringify(once.prefs));
  });

  it("lists in History only the folders brought over that are still on the Code page's list", () => {
    const { rec, prefs } = bringOver({ offered: false, folders: [] }, NONE, [API, WEB], []);
    expect(historyFolders(rec, prefs)).toEqual([API, WEB]);
    // removed from the list on the Code page: no longer a project, so its conversations leave History
    const removed: FolderPrefs = { ...prefs, added: [WEB] };
    expect(historyFolders(rec, removed)).toEqual([WEB]);
    // a folder added by hand and never brought over is not History's
    expect(historyFolders({ offered: true, folders: [] }, prefs)).toEqual([]);
  });
});

describe("the record this computer keeps", () => {
  it("reads only what it wrote, once each folder, and anything else as nothing offered", () => {
    expect(parseRecord(JSON.stringify({ offered: true, folders: [WEB, `${WEB}/`, 3, "", API] }))).toEqual({ offered: true, folders: [WEB, API] });
    for (const raw of [null, "", "not json", "[]", "7", JSON.stringify({ offered: "yes", folders: "x" })]) expect(parseRecord(raw)).toEqual({ offered: false, folders: [] });
  });

  it("looks on a launch only where it can, after the first-run setup, and only until the offer was made", () => {
    const fresh = { offered: false, folders: [] };
    expect(shouldLook(fresh, { can: true, firstRun: false })).toBe(true);
    expect(shouldLook(fresh, { can: true, firstRun: true })).toBe(false);
    expect(shouldLook(fresh, { can: false, firstRun: false })).toBe(false);
    expect(shouldLook({ offered: true, folders: [] }, { can: true, firstRun: false })).toBe(false);
  });
});
