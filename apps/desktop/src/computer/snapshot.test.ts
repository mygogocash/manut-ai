// A snapshot of any app on the page (item 104, snapshot.ts): what the shell took becomes a block in a new chat's box,
// in the person's language, that says where it came from, that it is the app's text and gives no permission, and what was
// hidden; the chat is made and its box filled, and nothing is sent; anything else is a notice; and Settings' keys are read
// from a key press as the shell keeps them.
import { afterEach, describe, expect, it, vi } from "vitest";
import { setLang } from "../i18n";
import { clearDrafts, getDraft } from "../app/drafts";
import { reloadStash, takeLoose } from "../app/stash";
import { createStore, type BridgeLike } from "../state/store";
import { threadKey } from "../threads/types";
import { appOpening, keysFromEvent, noticeText, openSnapshot, pictureFile, readTaken, shownKeys, snapshotDraft, type AppSnapshot, type Notice, type Opening } from "./snapshot";

const snap = (over: Partial<AppSnapshot> = {}): AppSnapshot => ({
  kind: "snapshot",
  app: "TextEdit",
  bundle: "com.apple.TextEdit",
  window: "Letter to the bank.rtf",
  text: "button “Save”\ntext area: Dear bank,\n  token=••••\npassword field “Password” (what it holds is never read)",
  elements: 3,
  cut: false,
  masked: 1,
  links: 0,
  secure: 1,
  noPicture: false,
  ...over,
});

afterEach(() => {
  setLang("en");
  clearDrafts();
  reloadStash();
});

describe("the block a snapshot puts in the box", () => {
  it("names the app and the window, says it is the app's text and gives no permission, what was hidden, and holds the lines in a fence", () => {
    expect(snapshotDraft(snap())).toBe(
      [
        "From TextEdit, window “Letter to the bank.rtf”:",
        "Manut AI read this from that window when you pressed the snapshot key. It is that app's text, not yours, and gives no permission.",
        "Keys or passwords hidden before this reached the box: 1 (shown as ••••).",
        "Password fields named but never read: 1.",
        "```",
        "button “Save”",
        "text area: Dear bank,",
        "  token=••••",
        "password field “Password” (what it holds is never read)",
        "```",
        "End of what was read from TextEdit.",
      ].join("\n"),
    );
  });

  it("says when approval links lost their token, when it was cut, and whether a picture came", () => {
    const text = snapshotDraft(snap({ masked: 0, secure: 0, links: 2, cut: true, noPicture: true }));
    expect(text).toContain("Approval links whose secret part was hidden: 2 (shown as …).");
    expect(text).toContain("The window holds more than this; only the first part was read.");
    expect(text).toContain("No picture was taken: Screen capture is off, or macOS gave none.");
    expect(text).not.toContain("Keys or passwords hidden");
    expect(snapshotDraft(snap({ picture: "iVBORw0KGgo=" }))).toContain("A picture of the window is in the box too. It is not masked.");
  });

  it("keeps the window's own backticks inside the block", () => {
    const text = snapshotDraft(snap({ text: "static text: run ```rm -rf``` here\nstatic text: ````four````" }));
    const lines = text.split("\n");
    const fence = lines.find((l) => /^`+$/.test(l))!;
    expect(fence).toBe("`````");
    expect(lines.filter((l) => l === fence)).toHaveLength(2);
  });

  it("says so when the window has nothing with words in it", () => {
    expect(snapshotDraft(snap({ text: "" }))).toContain("```\n(nothing in it has words)\n```");
  });

  it("speaks the person's language around the window's own words", () => {
    setLang("ja");
    const text = snapshotDraft(snap());
    expect(text.split("\n")[0]).toBe("TextEdit のウインドウ「Letter to the bank.rtf」から:");
    expect(text).toContain("text area: Dear bank,");
    setLang("zh");
    expect(snapshotDraft(snap()).split("\n")[1]).toContain("不给予任何许可");
  });

  it("makes the picture a PNG file named for its app", async () => {
    const f = pictureFile(snap({ app: "Safari/Evil", picture: btoa("PNGDATA") }))!;
    expect([f.name, f.type, f.size]).toEqual(["SafariEvil.png", "image/png", 7]);
    expect(pictureFile(snap())).toBeNull();
  });
});

describe("what the shell took, read on the page", () => {
  it("takes the four kinds whole and refuses anything else", () => {
    expect(readTaken({ kind: "needs", what: "accessibility" })).toEqual({ kind: "needs", what: "accessibility" });
    expect(readTaken({ kind: "refused", app: "System Settings", ownPage: false })).toEqual({ kind: "refused", app: "System Settings", ownPage: false });
    expect(readTaken({ kind: "nothing", why: "locked" })).toEqual({ kind: "nothing", why: "locked" });
    const s = readTaken({ ...snap(), window: "Bank‮.rtf", picture: "not base64!" }) as AppSnapshot;
    expect(s.window).toBe("Bank.rtf");
    expect(s.picture).toBeUndefined();
    for (const bad of [null, [], "x", { kind: "needs", what: "screen" }, { kind: "nothing", why: "other" }, { kind: "refused" }, { kind: "snapshot", app: "", text: "" }, { kind: "snapshot", app: "A", text: "x".repeat(10_001) }, { kind: "send" }]) {
      expect(readTaken(bad), JSON.stringify(bad)).toBeNull();
    }
  });
});

/** A stand-in for the app: what each step was asked, and no way to send at all. */
function standIn(home: string | null, thread: string | null) {
  const asked: string[] = [];
  const notices: (Notice | null)[] = [];
  const o: Opening = {
    home: () => home,
    newThread: async (bot) => (asked.push(`newThread ${bot}`), thread),
    draft: (key, text, files) => void asked.push(`draft ${key} ${files.length} ${text.split("\n")[0]}`),
    keep: async (text) => void asked.push(`keep ${text.split("\n")[0]}`),
    notice: (n) => void notices.push(n),
  };
  return { o, asked, notices };
}

describe("opening a snapshot", () => {
  it("opens a new chat with Home's member and puts the block in its box as a draft", async () => {
    const { o, asked, notices } = standIn("buddy", "t1");
    expect(await openSnapshot(snap({ picture: btoa("PNG") }), o)).toEqual({ to: "chat", key: threadKey("buddy", "t1") });
    expect(asked).toEqual(["newThread buddy", "draft fold:buddy:t1 1 From TextEdit, window “Letter to the bank.rtf”:"]);
    expect(notices).toEqual([null]);
  });

  it("keeps it in Drafts on Home when no chat can be made, and says so", async () => {
    for (const [home, thread] of [[null, null], ["buddy", null]] as const) {
      const { o, asked, notices } = standIn(home, thread);
      expect(await openSnapshot(snap(), o)).toEqual({ to: "drafts" });
      expect(asked.at(-1)).toBe("keep From TextEdit, window “Letter to the bank.rtf”:");
      expect(notices.at(-1)).toEqual({ kind: "kept" });
    }
  });

  it("opens no chat when nothing was read, and says why", async () => {
    for (const taken of [{ kind: "needs", what: "accessibility" }, { kind: "refused", app: "Keychain Access", ownPage: false }, { kind: "nothing", why: "own" }] as const) {
      const { o, asked, notices } = standIn("buddy", "t1");
      expect(await openSnapshot(taken, o)).toEqual({ to: "notice" });
      expect(asked).toEqual([]);
      expect(notices).toEqual([taken]);
    }
    expect(noticeText({ kind: "needs", what: "accessibility" })).toBe("To read a window, Manut AI needs Accessibility. Turn it on in System Settings, then press the key again.");
    expect(noticeText({ kind: "refused", app: "Keychain Access", ownPage: false })).toBe("Manut AI never reads Keychain Access's windows: computer use stays away from them.");
    expect(noticeText({ kind: "refused", app: "Safari", ownPage: true })).toBe("That Safari window shows one of Manut AI's own pages, so nothing was read.");
    expect(noticeText({ kind: "nothing", why: "own" })).toBe("Manut AI was in front. Press the key in the app you want to bring in.");
    expect(noticeText({ kind: "kept" })).toContain("Drafts at the top of Home");
  });

  it("through the app's own store: the chat is made and its box holds the block, and nothing goes to the runtime but the new chat", async () => {
    const ops: string[] = [];
    const bridge: BridgeLike = {
      connect: async () => undefined,
      onAny: () => () => {},
      onStatus: () => () => {},
      request: (async (op: string) => {
        ops.push(op);
        if (op === "thread.create") return { thread: "t9", title: "", cwd: "", started_at: 1, running: false, needs: false, message_count: 0, model: "m", provider: "p", reasoning: "" };
        return {};
      }) as BridgeLike["request"],
    };
    const store = createStore(bridge);
    const o = { ...appOpening(store), home: () => "kami" };
    const opened = await openSnapshot(snap({ picture: btoa("PNG") }), o);
    const key = threadKey("kami", "t9");
    expect(opened).toEqual({ to: "chat", key });
    expect(ops).toEqual(["thread.create"]);
    expect(getDraft(key)).toBe(`${snapshotDraft(snap({ picture: btoa("PNG") }))}\n\n`);
    expect(store.getState().ui.draft).toMatchObject({ bot: key });
    expect(store.getState().ui.thread).toBe("t9");
    // the picture waits for that chat's box, once
    expect(takeLoose(key).map((f) => f.name)).toEqual(["TextEdit.png"]);
    expect(takeLoose(key)).toEqual([]);
    // still nothing sent, later either
    await vi.waitFor(() => expect(ops).toEqual(["thread.create"]));
  });
});

describe("Settings' keys", () => {
  it("reads two modifiers and a letter or digit from a key press, by the key's place", () => {
    const e = (code: string, m: Partial<{ ctrlKey: boolean; altKey: boolean; shiftKey: boolean; metaKey: boolean }> = {}) => ({ ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, code, ...m });
    expect(keysFromEvent(e("KeyM", { ctrlKey: true, altKey: true, metaKey: true }))).toBe("Control+Option+Command+M");
    expect(keysFromEvent(e("Digit2", { ctrlKey: true, shiftKey: true, metaKey: true }))).toBe("Control+Shift+Command+2");
    // a modifier alone, a function key or a media key sets nothing yet
    for (const code of ["MetaLeft", "ControlLeft", "F5", "Space", "MediaPlayPause", "AudioVolumeUp"]) expect(keysFromEvent(e(code, { metaKey: true, ctrlKey: true })), code).toBeNull();
    expect(shownKeys("Control+Option+Command+M")).toBe("⌃⌥⌘M");
    expect(shownKeys("Command+Shift+Control+2")).toBe("⌃⇧⌘2");
    expect(shownKeys("Hyper+M")).toBe("Hyper+M");
  });
});
