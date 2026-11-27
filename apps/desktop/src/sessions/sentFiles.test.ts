// The files messages carried (sentFiles.ts, lifted out of sessions.ts): saved before a message goes, kept in the book for a
// restart and read back into their bubbles, and each session's previews let go when it is closed. Driven with stand-in file
// calls and an in-memory storage.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OutFile } from "../state/store";
import { SENT_FILES_KEY } from "./attach";
import { createSentFiles } from "./sentFiles";

const storage = new Map<string, string>();
beforeEach(() => {
  storage.clear();
  (globalThis as { localStorage?: unknown }).localStorage = { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => void storage.set(k, v), removeItem: (k: string) => void storage.delete(k) };
});

const out = (name: string, kind: OutFile["kind"], body = "x"): OutFile => ({ name, size: body.length, kind, read: async () => btoa(body) }) as unknown as OutFile;

function make(fail?: string) {
  const disk = new Map<string, Uint8Array>();
  const files = createSentFiles({
    saveFile: async (sid, name, bytes) => {
      if (name === fail) throw new Error("disk full");
      const path = `/s/${sid}/${name}`;
      disk.set(path, bytes);
      return path;
    },
    readFile: async (path) => {
      const b = disk.get(path);
      if (!b) throw new Error("gone");
      return b;
    },
  });
  return { files, disk };
}

describe("a session's sent files", () => {
  it("saves each file before the message goes, sends a small picture apart and names the rest in the text", async () => {
    const { files } = make();
    const p = await files.prepare("s1", "look", [out("a.png", "image", "PNG"), out("notes.txt", "file")]);
    expect(p.input.images).toEqual(["/s/s1/a.png"]);
    expect(p.input.text).toContain("/s/s1/notes.txt");
    expect(p.saved.map((f) => f.path)).toEqual(["/s/s1/a.png", "/s/s1/notes.txt"]);
    expect(p.shown[0].url).toMatch(/^blob:/);
    expect(p.shown[1].url).toBeNull();
  });

  it("sends nothing when a file cannot be saved, and says which", async () => {
    const { files } = make("b.txt");
    await expect(files.prepare("s1", "", [out("a.txt", "file"), out("b.txt", "file")])).rejects.toThrow("b.txt");
  });

  it("keeps a sent message for a restart and brings its bubble back, one that can no longer be read as a plain file", async () => {
    const first = make();
    const p = await first.files.prepare("s1", "look", [out("a.png", "image", "PNG"), out("b.png", "image", "PNG")]);
    first.files.keep("s1", "look", p.saved, 5_000);
    expect(first.files.has("s1")).toBe(true);
    expect(JSON.parse(storage.get(SENT_FILES_KEY)!).s1).toBeTruthy();
    // the next run reads the same book; one of the saved copies is gone
    const again = make();
    again.disk.set("/s/s1/a.png", new Uint8Array([1]));
    const back = [];
    for await (const e of again.files.shownBack("s1", 0)) back.push(e);
    expect(back).toEqual([{ mid: "5000", text: "look", ts: 5, files: [expect.objectContaining({ name: "a.png", kind: "image", url: expect.stringMatching(/^blob:/) }), { name: "b.png", size: 3, kind: "file", url: null }] }]);
    // older than what the chat kept: left out
    const old = [];
    for await (const e of again.files.shownBack("s1", 100)) old.push(e);
    expect(old).toEqual([]);
  });

  it("forgets a closed session's book and lets go of its previews only; a restore keeps only the sessions still there", async () => {
    const { files } = make();
    const a = await files.prepare("s1", "", [out("a.png", "image")]);
    const b = await files.prepare("s2", "", [out("b.png", "image")]);
    files.keep("s1", "", a.saved);
    files.keep("s2", "", b.saved);
    const revoked: string[] = [];
    const spy = vi.spyOn(URL, "revokeObjectURL").mockImplementation((u) => void revoked.push(u));
    try {
      files.forget("s1");
      expect(revoked).toEqual([a.shown[0].url]);
      expect(files.has("s1")).toBe(false);
      expect(files.has("s2")).toBe(true);
      files.keepOnly([]);
      expect(files.has("s2")).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });
});
