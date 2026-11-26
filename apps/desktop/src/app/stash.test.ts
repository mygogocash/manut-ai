// Drafts kept for later (item 95, app/stash.ts): the list at the top of Home holds five, newest first; a sixth lets the
// oldest go with an Undo; each draft's files are saved in a folder of its own and that folder goes with the draft; a
// draft taken into a chat fills that chat's box with its words and files and sends nothing; the list comes back after a
// restart.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  STASH_KEY,
  STASH_MAX,
  UNDO_MS,
  draftFolders,
  dropDraft,
  filesOf,
  intoChat,
  joinDraft,
  keepNewest,
  letGo,
  parseStash,
  reloadStash,
  setDraftFiles,
  stashDraft,
  stashed,
  takeDraft,
  takeHanded,
  undoLetGo,
  type DraftFiles,
  type Stashed,
} from "./stash";
import { clearDrafts, getDraft, setDraft } from "./drafts";
import { createStore, type BridgeLike, type OutFile } from "../state/store";

/** A page's storage and the shell's session files, both in memory. */
function world() {
  const store = new Map<string, string>();
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  };
  const disk = new Map<string, Uint8Array>();
  const removed: string[] = [];
  const host: DraftFiles = {
    saveFile: async (folder, name, data) => {
      if (name === "unsaveable.bin") throw new Error("disk full");
      const path = `/home/you/.manut/session-files/${folder}/1-${name}`;
      disk.set(path, data);
      return path;
    },
    readFile: async (path) => {
      const d = disk.get(path);
      if (!d) throw new Error("not a file Manut AI saved");
      return d;
    },
    removeFiles: async (folder) => {
      removed.push(folder);
      for (const k of [...disk.keys()]) if (k.includes(`/session-files/${folder}/`)) disk.delete(k);
    },
  };
  setDraftFiles(() => host);
  reloadStash();
  return { store, disk, removed };
}

/** A composer chip's file, as the box hands it over (its bytes as base64). */
const out = (name: string, text: string, kind: OutFile["kind"] = "image"): OutFile => ({
  name,
  size: text.length,
  kind,
  url: null,
  attach: kind === "image" ? "image" : "file",
  read: async () => btoa(text),
});

const tick = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => clearDrafts());
afterEach(() => {
  vi.useRealTimers();
  setDraftFiles(null);
  delete (globalThis as { localStorage?: unknown }).localStorage;
  reloadStash();
});

describe("the list", () => {
  it("keeps five, newest first; a sixth lets the oldest go and says which", () => {
    const e = (n: number): Stashed => ({ id: `d${n}`, text: `draft ${n}`, files: [], at: n, folder: null, from: "home" });
    let list: Stashed[] = [];
    for (let n = 1; n <= STASH_MAX; n++) {
      const r = keepNewest(list, e(n));
      expect(r.dropped).toBeNull();
      list = r.list;
    }
    expect(list.map((x) => x.id)).toEqual(["d5", "d4", "d3", "d2", "d1"]);
    const r = keepNewest(list, e(6));
    expect(r.list.map((x) => x.id)).toEqual(["d6", "d5", "d4", "d3", "d2"]);
    expect(r.dropped?.id).toBe("d1");
  });

  it("reads back what was saved, leaving out what cannot be read", () => {
    const ok = { id: "d1", text: "reply to Mali", files: [{ name: "a.png", size: 3, kind: "image", path: "/p/a.png" }], at: 5, folder: "s912345678", from: "kami" };
    const raw = JSON.stringify([ok, { id: "d2", text: "", files: [], at: 6 }, { nonsense: true }, { ...ok, id: "d3", at: 9, files: [{ name: 1 }], text: "words" }]);
    expect(parseStash(raw).map((x) => [x.id, x.files.length])).toEqual([
      ["d3", 0],
      ["d1", 1],
    ]);
    expect(parseStash("not json")).toEqual([]);
    expect(parseStash(null)).toEqual([]);
  });

  it("joins a taken draft's words after what a box held, a blank line between", () => {
    expect(joinDraft("", "the draft")).toBe("the draft");
    expect(joinDraft("already here\n", "the draft")).toBe("already here\n\nthe draft");
    expect(joinDraft("already here", "")).toBe("already here");
  });
});

describe("keeping and dropping a draft with its files", () => {
  it("saves each file in the draft's own folder, keeps the list across a restart, and Delete removes the folder", async () => {
    const w = world();
    const d = (await stashDraft({ text: "the receipt and the shelf", files: [out("receipt.png", "PNG"), out("shelf.txt", "row 3", "file")], from: "kami" }))!;
    expect(d.folder).toMatch(/^s9\d{8}$/);
    expect(d.files.map((f) => [f.name, f.kind, f.path])).toEqual([
      ["receipt.png", "image", `/home/you/.manut/session-files/${d.folder}/1-receipt.png`],
      ["shelf.txt", "file", `/home/you/.manut/session-files/${d.folder}/1-shelf.txt`],
    ]);
    expect(new TextDecoder().decode(w.disk.get(d.files[1].path))).toBe("row 3");
    expect(draftFolders()).toEqual([d.folder]);
    // a restart: the list comes back from storage
    expect(JSON.parse(w.store.get(STASH_KEY)!)).toHaveLength(1);
    reloadStash();
    expect(stashed().map((x) => x.text)).toEqual(["the receipt and the shelf"]);
    dropDraft(d.id);
    expect(stashed()).toEqual([]);
    expect(w.removed).toEqual([d.folder]);
    expect(w.disk.size).toBe(0);
  });

  it("keeps nothing when a file cannot be saved, so the box keeps its draft, and leaves no files behind", async () => {
    const w = world();
    await expect(stashDraft({ text: "with a bad file", files: [out("ok.png", "x"), out("unsaveable.bin", "y", "file")], from: "kami" })).rejects.toThrow("disk full");
    expect(stashed()).toEqual([]);
    expect(w.removed).toHaveLength(1);
    expect(w.disk.size).toBe(0);
  });

  it("keeps nothing for an empty box", async () => {
    world();
    expect(await stashDraft({ text: "  \n", from: "home" })).toBeNull();
    expect(stashed()).toEqual([]);
  });

  it("a sixth lets the oldest go with an Undo; Undo brings it back, files and all", async () => {
    const w = world();
    const first = (await stashDraft({ text: "oldest", files: [out("a.png", "A")], from: "kami" }, 1))!;
    for (let n = 2; n <= 5; n++) await stashDraft({ text: `draft ${n}`, from: "home" }, n);
    await stashDraft({ text: "newest", from: "home" }, 6);
    expect(stashed().map((x) => x.text)).toEqual(["newest", "draft 5", "draft 4", "draft 3", "draft 2"]);
    // its files stay while the Undo is offered
    expect(w.removed).toEqual([]);
    expect(draftFolders()).toContain(first.folder);
    undoLetGo();
    expect(stashed().map((x) => x.text)).toContain("oldest");
    expect(w.disk.size).toBe(1);
  });

  it("without Undo, the draft let go and its files are gone after a while", async () => {
    vi.useFakeTimers();
    const w = world();
    const first = (await stashDraft({ text: "oldest", files: [out("a.png", "A")], from: "kami" }, 1))!;
    for (let n = 2; n <= 6; n++) await stashDraft({ text: `draft ${n}`, from: "home" }, n);
    vi.advanceTimersByTime(UNDO_MS + 1);
    expect(w.removed).toEqual([first.folder]);
    expect(draftFolders()).toEqual([]);
    undoLetGo();
    expect(stashed().map((x) => x.text)).not.toContain("oldest");
  });

  it("a draft let go goes for good as soon as another one is kept", async () => {
    const w = world();
    const first = (await stashDraft({ text: "oldest", files: [out("a.png", "A")], from: "kami" }, 1))!;
    for (let n = 2; n <= 6; n++) await stashDraft({ text: `draft ${n}`, from: "home" }, n);
    await stashDraft({ text: "seventh", from: "home" }, 7);
    expect(w.removed).toContain(first.folder);
    letGo();
  });
});

describe("taking a draft into another chat", () => {
  /** A store whose runtime counts every request, to show taking a draft asks for none. */
  function counting() {
    const ops: string[] = [];
    const bridge: BridgeLike = {
      connect: async () => undefined,
      onAny: () => () => {},
      onStatus: () => () => {},
      request: (async (op: string) => (ops.push(op), {})) as BridgeLike["request"],
    };
    return { store: createStore(bridge), ops };
  }

  it("puts its words after what that chat's box held and its files in that box; nothing is sent", async () => {
    const w = world();
    const { store, ops } = counting();
    const d = (await stashDraft({ text: "price list for the 12.12 sale", files: [out("prices.png", "PNG!")], from: "kami" }))!;
    setDraft("friren", "hello");
    const taken = takeDraft(d.id)!;
    expect(stashed()).toEqual([]);
    intoChat(store, "friren", taken);
    expect(getDraft("friren")).toBe("hello\n\nprice list for the 12.12 sale");
    expect(store.getState().ui.draft).toMatchObject({ bot: "friren", text: "hello\n\nprice list for the 12.12 sale" });
    // the box takes the files when it shows: read back, then their saved copies go
    const handed = takeHanded("friren")!;
    expect(takeHanded("friren")).toBeNull();
    const { files, missing } = await filesOf(handed);
    expect(files.map((f) => [f.name, f.type, f.size])).toEqual([["prices.png", "image/png", 4]]);
    expect(missing).toEqual([]);
    await tick();
    expect(w.disk.size).toBe(0);
    expect(w.removed).toEqual([d.folder]);
    expect(ops.filter((op) => op.startsWith("chat."))).toEqual([]);
  });

  it("a file whose saved copy is gone (a restart in a browser) is named, and the rest still come", async () => {
    const w = world();
    const d = (await stashDraft({ text: "two files", files: [out("a.png", "A"), out("b.png", "B")], from: "kami" }))!;
    w.disk.delete(d.files[0].path);
    const { files, missing } = await filesOf(takeDraft(d.id)!);
    expect(files.map((f) => f.name)).toEqual(["b.png"]);
    expect(missing).toEqual(["a.png"]);
  });
});
