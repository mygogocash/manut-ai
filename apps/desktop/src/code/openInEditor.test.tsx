// Open in <editor> (item 107), page side: the menus that offer it and the folder each one opens (a lane's own folder, never the
// developer's; a project's is the developer's), the command palette's rows, and Settings › Developer › Editor in every state.
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LANGS, setLang } from "../i18n";
import { MockHost, type MockCall } from "../sessions/host";
import { createSessions } from "../sessions/sessions";
import { rowMenuItems, termMenuItems } from "../sessions/SessionsSection";
import { createStore, type BridgeLike } from "../state/store";
import { doRows, ACTIONS, type PaletteCtx } from "../palette/registry";
import type { Places } from "../palette/places";
import { EditorSettingView } from "../settings/EditorSetting";
import { DeveloperView, type DeveloperViewProps } from "../settings/DeveloperPage";
import { emptyLane } from "./lane";
import { laneRowOf } from "./Lanes";

const DEV = "/Users/fon/shop";
const WT = "/Users/fon/.manut/lanes/shop/fix-totals";
const VS = { id: "vscode", label: "Visual Studio Code" };
const CUR = { id: "cursor", label: "Cursor" };
const words = (html: string) => html.replace(/<[^>]*>/g, " ").replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();

const bridge = (): BridgeLike => ({ connect: async () => undefined, onAny: () => () => {}, onStatus: () => () => {}, request: (async () => ({})) as BridgeLike["request"] });

function setup(editors?: { id: string; label: string }[]) {
  const g: Record<string, unknown> = { __manutMockAgents: ["claude"], ...(editors ? { __manutEditors: editors } : {}) };
  const host = new MockHost(g);
  const store = createStore(bridge());
  const m = new Map<string, string>();
  (globalThis as { localStorage?: unknown }).localStorage = { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) };
  const ss = createSessions(host, () => store);
  const opened = () => ((g.__manutSessionCalls as MockCall[] | undefined) ?? []).filter((c) => c.op === "editor");
  return { ss, g, opened };
}

beforeEach(() => setLang("en"));
afterEach(() => setLang("en"));

describe("the session row's menu", () => {
  it("offers Open in the editor after the two folder actions, only with a folder and only when an editor is installed", () => {
    expect(termMenuItems({ cwd: "/w" }, undefined, false, true)).toEqual(["rename", "reveal", "terminal", "editor", "here", "close"]);
    expect(termMenuItems({ cwd: "/w" }, undefined, false, false)).toEqual(["rename", "reveal", "terminal", "here", "close"]);
    expect(termMenuItems({ cwd: "/w" })).toEqual(["rename", "reveal", "terminal", "here", "close"]);
    expect(termMenuItems({ cwd: "", linkId: undefined }, undefined, false, true)).toEqual(["rename", "here", "close"]);
    expect(termMenuItems({ cwd: "/w", linkId: "x" }, null, false, true)).toEqual(["rename", "pin", "settle", "reveal", "terminal", "editor", "link", "here", "close"]);
    expect(rowMenuItems({ cwd: "/w", agentSession: undefined }, true)).toEqual(["rename", "reveal", "terminal", "editor", "here", "close"]);
  });
});

describe("the folder each action opens", () => {
  it("a session opens the folder it works in: a lane's own folder, else the session's", async () => {
    const { ss, opened } = setup();
    ss.restore([
      { id: "plain", agent: "claude", cwd: DEV, startedAt: 1, view: "chat", running: false, exitCode: 0 },
      { id: "lane", agent: "claude", cwd: DEV, startedAt: 2, view: "chat", running: false, exitCode: 0, lane: { name: "kit/fix-totals", base: "main", dir: WT, worktree: WT } },
    ]);
    await ss.openInEditor("plain");
    await ss.openInEditor("lane");
    expect(opened()).toEqual([
      { op: "editor", cwd: DEV, editor: "vscode" },
      { op: "editor", cwd: WT, editor: "vscode" },
    ]);
    // never the developer's folder for the lane
    expect(opened()[1]?.cwd).not.toBe(DEV);
  });

  it("a lane's row carries its own folder, so its menu opens that and not the project's", () => {
    const input = (lane?: { name: string; base: string; dir?: string; worktree?: string }) => ({
      rec: { id: "s1", agent: "claude" as const, cwd: DEV, status: "running" as const, view: "chat" as const, startedAt: 1, ...(lane ? { lane } : {}) },
      agent: "Claude Code",
      live: undefined,
      lane: emptyLane(),
      turn: null,
      asks: [],
    });
    expect(laneRowOf(input({ name: "kit/fix-totals", base: "main", dir: WT, worktree: WT })).folder).toBe(WT);
    // a folder inside the worktree, where the agent works
    expect(laneRowOf(input({ name: "kit/x", base: "main", dir: `${WT}/apps/web`, worktree: WT })).folder).toBe(`${WT}/apps/web`);
    // a lane with no folder of its own works in the session's
    expect(laneRowOf(input()).folder).toBe(DEV);
  });

  it("uses the editor the saved choice names, and the store's own host", async () => {
    const a = setup([VS, CUR]);
    (globalThis as { localStorage: Storage }).localStorage.setItem("manut.editor", "cursor");
    a.ss.restore([{ id: "p", agent: "claude", cwd: DEV, startedAt: 1, view: "chat", running: false, exitCode: 0 }]);
    await a.ss.openInEditor("p");
    expect(a.opened()).toEqual([{ op: "editor", cwd: DEV, editor: "cursor" }]);
    // another store with another host is not heard by this one
    const b = setup([VS]);
    b.ss.restore([{ id: "p", agent: "claude", cwd: DEV, startedAt: 1, view: "chat", running: false, exitCode: 0 }]);
    await b.ss.openInEditor("p");
    expect(a.opened()).toHaveLength(1);
    expect(b.opened()).toEqual([{ op: "editor", cwd: DEV, editor: "vscode" }]);
  });

  it("says why under the chat when the open fails, in plain words", async () => {
    const { ss, g, opened } = setup();
    g.__manutEditorFails = "the folder is not there";
    ss.restore([{ id: "p", agent: "claude", cwd: DEV, startedAt: 1, view: "chat", running: false, exitCode: 0 }]);
    // returned too, for a row that has no chat to say it under
    expect(await ss.openInEditor("p")).toBe("The folder is not there any more, so it was not opened.");
    expect(opened()).toHaveLength(1);
    expect(ss.getState().notes.p).toBe("The folder is not there any more, so it was not opened.");
  });

  it("opens nothing for a session with no folder, and nothing when no editor is installed", async () => {
    const { ss, opened } = setup([]);
    ss.restore([{ id: "p", agent: "claude", cwd: DEV, startedAt: 1, view: "chat", running: false, exitCode: 0 }]);
    await ss.openInEditor("p");
    await ss.openInEditor("missing");
    expect(opened()).toEqual([]);
    expect(ss.getState().notes.p).toBe("No editor was found on this computer, so nothing was opened.");
  });
});

describe("the command palette", () => {
  const ctx = (over: Partial<PaletteCtx>, places: Places): PaletteCtx => ({
    lang: "en",
    bots: [],
    buddy: null,
    people: false,
    places,
    openPage: () => {},
    openHistory: () => {},
    openSettings: () => {},
    newThread: () => {},
    setLanguage: () => {},
    openNewSessionMenu: () => {},
    openKeySheet: () => {},
    toggleSide: () => {},
    workflows: [],
    runWorkflow: () => {},
    ...over,
  });
  const ids = (c: PaletteCtx) => doRows(c).filter((r) => r.id.startsWith("do:open-editor"));

  it("offers the project and the session each only while its place is open and an editor is installed", () => {
    const pressed: string[] = [];
    const both: Places = { editorProject: { open: () => void pressed.push("project") }, editorSession: { open: () => void pressed.push("session") } };
    expect(ids(ctx({ editor: null }, both))).toEqual([]);
    expect(ids(ctx({}, both))).toEqual([]);
    expect(ids(ctx({ editor: CUR }, {}))).toEqual([]);
    const rows = ids(ctx({ editor: CUR }, both));
    expect(rows.map((r) => [r.id, r.label])).toEqual([
      ["do:open-editor:project", "Open the project in Cursor"],
      ["do:open-editor:session", "Open this session's folder in Cursor"],
    ]);
    rows.forEach((r) => r.run());
    expect(pressed).toEqual(["project", "session"]);
    expect(ids(ctx({ editor: CUR }, { editorSession: both.editorSession })).map((r) => r.id)).toEqual(["do:open-editor:session"]);
  });

  it("has its definitions found elsewhere in the app by the registry's own test", () => {
    for (const id of ["open-editor-project", "open-editor-session"]) expect(ACTIONS.some((a) => a.id === id)).toBe(true);
  });
});

describe("Settings › Developer › Editor", () => {
  const draw = (installed: typeof VS[] | null, pref = "auto") => renderToString(<EditorSettingView installed={installed} pref={pref} onPick={() => {}} />);

  it("offers Automatic and each installed editor, and says what Automatic does", () => {
    const html = draw([VS, CUR]);
    expect(html).toContain('data-testid="dev-editor"');
    expect(html).toMatch(/<option value="auto"[^>]*>Automatic<\/option>/);
    expect(html).toMatch(/<option value="vscode"[^>]*>Visual Studio Code<\/option>/);
    expect(html).toMatch(/<option value="cursor"[^>]*>Cursor<\/option>/);
    expect(html).not.toContain('value="zed"');
    expect(words(html)).toContain("Automatic takes the first one found on this computer, in this order: Visual Studio Code, Cursor, Windsurf, Zed, Xcode (Mac only).");
    // no field to type a command into
    expect(html).not.toContain("<input");
    expect(html).toMatch(/<option value="auto" selected/);
    expect(draw([VS, CUR], "cursor")).toMatch(/<option value="cursor" selected/);
  });

  it("shows nothing until the host answers, and says so when no editor is found", () => {
    expect(draw(null)).toBe("");
    const none = draw([]);
    expect(none).not.toContain("<select");
    expect(words(none)).toContain("No editor was found on this computer, so Open in editor is not offered.");
  });

  it("says when the saved editor is not found here and that the first found is used", () => {
    const html = draw([VS, CUR], "zed");
    expect(words(html)).toContain("Zed was not found on this computer, so the first editor found is used.");
    expect(html).toMatch(/<option value="auto" selected/);
  });

  it("is drawn in every language, and in the Developer page's own group only when given", () => {
    for (const lang of LANGS) {
      setLang(lang);
      expect(words(draw([VS]))).not.toMatch(/\{name\}|editor\./);
    }
    setLang("en");
    const base: DeveloperViewProps = { saved: { mode: "practice" }, restart: false, mode: "practice", originText: "", originError: null, signIn: null, notTold: false, token: "", nonce: "", onMode: () => {}, onOriginText: () => {}, onSave: () => {}, onRestart: () => {}, onToken: () => {}, onNonce: () => {}, onSignIn: () => {}, onSignOut: () => {} };
    expect(renderToString(<DeveloperView {...base} />)).not.toContain("dev-editor-group");
    expect(renderToString(<DeveloperView {...base} editor={<EditorSettingView installed={[VS]} pref="auto" onPick={() => {}} />} />)).toContain("dev-editor-group");
  });
});
