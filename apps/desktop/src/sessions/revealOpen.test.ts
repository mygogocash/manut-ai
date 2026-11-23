// Opening a session reveals its folder in the Code page's list (folders.ts `revealFolder`: a collapsed folder opens). The
// reveal used to run in the list's own effect, and the list is drawn only on the Code page, so a session opened from
// anywhere else (a Recent thread, Needs you's Look first, ⌘⇧], a new terminal) left its folder collapsed, and the Code
// page then listed nothing of the session in view. It now runs wherever the app is, from the two stores.
import { describe, expect, it } from "vitest";
import { createStore, getStore, type BridgeLike } from "../state/store";
import { getFolderPrefs, isCollapsed, setFolderPrefs, toggleFolder } from "./folders";
import { MockHost } from "./host";
import { createSessions, getSessions } from "./sessions";
import { watchOpenFolder } from "./revealOpen";

const bridgeStub = (): BridgeLike => ({
  connect: async () => undefined,
  onAny: () => () => {},
  onStatus: () => () => {},
  request: (async () => ({})) as BridgeLike["request"],
});

/** A New session that never started, in `cwd`: the plainest row a store can list. */
const draft = (id: string, cwd: string) => ({ id, agent: "claude", cwd, startedAt: 1, view: "chat" as const, draft: true, running: false });

describe("opening a session in the app", () => {
  it("opens its collapsed folder, with no list drawn", () => {
    getSessions().restore([draft("s1", "/w/api"), draft("s2", "/w/web")]);
    setFolderPrefs(toggleFolder(toggleFolder(getFolderPrefs(), "/w/api", true), "/w/web", true));
    getStore().actions.openSession("s1");
    expect(isCollapsed(getFolderPrefs(), "/w/api")).toBe(false);
    // only the folder of the session that opened; the other stays as the person left it
    expect(isCollapsed(getFolderPrefs(), "/w/web")).toBe(true);
  });
});

describe("watchOpenFolder", () => {
  function setup() {
    const store = createStore(bridgeStub());
    const ss = createSessions(new MockHost({}), () => store);
    ss.restore([draft("s1", "/w/api"), draft("s2", "/w/api"), draft("s3", "/w/web")]);
    const revealed: string[] = [];
    const stop = watchOpenFolder(store, ss, (cwd) => void revealed.push(cwd));
    return { store, ss, revealed, stop };
  }

  it("reveals the folder of a session that opens, once, and again for the next one", () => {
    const { store, revealed } = setup();
    expect(revealed).toEqual([]);
    store.actions.openSession("s1");
    expect(revealed).toEqual(["/w/api"]);
    store.actions.openSession("s3");
    expect(revealed).toEqual(["/w/api", "/w/web"]);
  });

  it("does not reveal again for changes that are not a new session in view, so a folder the person collapses stays shut", () => {
    const { store, ss, revealed } = setup();
    store.actions.openSession("s1");
    // the sessions' own state changes (a note, a status) and so does the app's (a page is read): the same session, the
    // same folder
    ss.rename("s2", "Notes");
    store.actions.openSession("s1");
    expect(revealed).toEqual(["/w/api"]);
  });

  it("reveals nothing while no terminal is in view, however the page changes", () => {
    const { store, revealed } = setup();
    store.actions.openSession("s1");
    store.actions.openPage("code");
    store.actions.openPage("team");
    expect(revealed).toEqual(["/w/api"]);
  });

  it("reveals again when the same session comes back into view", () => {
    const { store, revealed } = setup();
    store.actions.openSession("s1");
    store.actions.openPage("code");
    store.actions.openSession("s1");
    expect(revealed).toEqual(["/w/api", "/w/api"]);
  });

  it("finds the folder of a session that is listed after it opened (a new terminal opens as it starts)", () => {
    const store = createStore(bridgeStub());
    const ss = createSessions(new MockHost({}), () => store);
    const revealed: string[] = [];
    watchOpenFolder(store, ss, (cwd) => void revealed.push(cwd));
    store.actions.openSession("s9");
    expect(revealed).toEqual([]);
    ss.restore([draft("s9", "/w/late")]);
    expect(revealed).toEqual(["/w/late"]);
  });

  it("stops when it is told to", () => {
    const { store, revealed, stop } = setup();
    stop();
    store.actions.openSession("s1");
    expect(revealed).toEqual([]);
  });
});
