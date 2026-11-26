// A key typed into the code: found in Kit's changes by the app's one masker (lib/secrets.ts), counted per file so a
// later change that takes it out clears it, and never shown. Every key here is plainly fake.
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DiffView } from "../chat/activity/Work";
import type { DiffFile } from "../lib/protocol";
import { holdsKey, keysAfter, keyFiles, readSaved, savedKeys } from "./secrets";

const FAKE_KEY = "sk-FAKE0000000000000000TEST";
const file = (path: string, lines: string[], kind: DiffFile["kind"] = "update"): DiffFile => ({
  path,
  kind,
  lines,
  added: lines.filter((l) => l.startsWith("+")).length,
  removed: lines.filter((l) => l.startsWith("-")).length,
});

describe("a key in a line", () => {
  it("is what the app's masker would hide", () => {
    expect(holdsKey(`const KEY = "${FAKE_KEY}";`)).toBe(true);
    expect(holdsKey("password=fake-password-123")).toBe(true);
    expect(holdsKey("export const SHOP_ID = process.env.PROMPTPAY_ID;")).toBe(false);
    expect(holdsKey("const total = order.items.reduce(sum, 0);")).toBe(false);
  });
});

describe("keys in Kit's changes", () => {
  const typed = file("src/config.ts", ["@@ -1,2 +1,3 @@", " export const CURRENCY = 'THB';", `+export const PROMPTPAY_KEY = "${FAKE_KEY}";`]);

  it("counts the keys a change adds, per file", () => {
    expect(keysAfter({}, [typed])).toEqual({ "src/config.ts": 1 });
    expect(keyFiles(keysAfter({}, [typed]))).toEqual(["src/config.ts"]);
  });

  it("never takes a key away (item 117): a later change that takes it out, or deletes the file, leaves it counted", () => {
    // a key committed and then taken out is still in the lane's history, which a push sends
    const moved = file("src/config.ts", ["@@ -1,3 +1,3 @@", `-export const PROMPTPAY_KEY = "${FAKE_KEY}";`, "+export const PROMPTPAY_KEY = process.env.PROMPTPAY_KEY;"]);
    expect(keysAfter(keysAfter({}, [typed]), [moved])).toEqual({ "src/config.ts": 1 });
    expect(keysAfter({ "src/config.ts": 2 }, [file("src/config.ts", [], "delete")])).toEqual({ "src/config.ts": 2 });
  });

  it("counts a key that takes a placeholder's place, which used to net to nothing", () => {
    const swapped = file(".env.example", ["@@ -1 +1 @@", "-API_KEY=changeme", `+STRIPE_SECRET=${FAKE_KEY}`]);
    expect(keysAfter({}, [swapped])).toEqual({ ".env.example": 1 });
  });

  it("keeps other files as they were, and counts no file a key only left", () => {
    const tidy = file("src/checkout.tsx", ["@@ -1 +1 @@", "-const a = 1;", "+const a = 2;"]);
    expect(keysAfter({ "src/config.ts": 1 }, [tidy])).toEqual({ "src/config.ts": 1 });
    const unrelated = file("src/old.ts", [`-const OLD = "${FAKE_KEY}";`]);
    expect(keysAfter({}, [unrelated])).toEqual({});
  });

  it("holds only file names and counts, never the key", () => {
    expect(JSON.stringify(keysAfter({}, [typed]))).not.toContain(FAKE_KEY);
  });
});

describe("keys in what a commit or a push saves, from the lane's own diff (item 117)", () => {
  // the shell's `lane_diff` answer: each file's diff already passed through the masker, so a key reads as the mask
  const answer = (files: Record<string, unknown>[], more = 0) => ({ start: "abc1234", files, more_files: more });
  const diff = (...lines: string[]) => ["diff --git a/x b/x", "--- a/x", "+++ b/x", "@@ -1,2 +1,2 @@", ...lines].join("\n");

  it("names each file an added line of which holds a key, whoever wrote it", () => {
    const raw = answer([
      { path: "notes.md", state: "changed", diff: diff(" # Notes", "+OPENAI_API_KEY=••••") },
      { path: "src/a.ts", state: "changed", diff: diff("-const a = 1;", "+const a = 2;") },
    ]);
    expect(savedKeys(raw)).toEqual({ files: ["notes.md"], unread: false });
  });

  it("never subtracts: a key's line taken out elsewhere, or a placeholder's line replaced, still counts the added one", () => {
    const raw = answer([{ path: ".env.example", state: "changed", diff: diff("-API_KEY=••••", "+STRIPE_SECRET=••••") }]);
    expect(savedKeys(raw)).toEqual({ files: [".env.example"], unread: false });
    // a removed line alone holds nothing that is saved
    expect(savedKeys(answer([{ path: "old.env", state: "changed", diff: diff("-API_KEY=••••") }]))).toEqual({ files: [], unread: false });
    // a header naming a file is no added line
    expect(savedKeys(answer([{ path: "x", state: "changed", diff: "+++ b/••••\n@@ -0,0 +1 @@\n+fine" }]))).toEqual({ files: [], unread: false });
  });

  it("reads the whole diff, past the lines the Diff pane draws", () => {
    const long = diff(...Array.from({ length: 1_000 }, (_, i) => `+line ${i}`), "+TOKEN=••••");
    expect(savedKeys(answer([{ path: "big.ts", state: "new", diff: long }]))).toEqual({ files: ["big.ts"], unread: false });
  });

  it("is unread, so the step asks, for any file it could not read whole, and for files past its list", () => {
    for (const note of ["binary", "too_large", "left_out", "something_new"]) {
      expect(savedKeys(answer([{ path: "f", state: "changed", diff: "", note }])), note).toEqual({ files: [], unread: true });
    }
    expect(savedKeys(answer([], 3))).toEqual({ files: [], unread: true });
  });

  it("is nothing at all for an answer it does not understand", () => {
    for (const raw of [null, undefined, "x", [], {}, { files: "no" }, { files: [{ diff: "+TOKEN=••••" }] }]) expect(savedKeys(raw), JSON.stringify(raw)).toBeNull();
  });

  it("keeps what the shell read of the commits a push would send, apart from the folder's diff (item 120)", () => {
    // a key added in one commit and taken out in the next is in no diff of the folder, but in the history a push sends
    expect(savedKeys({ ...answer([]), history: { files: ["notes.txt", "1a2b3c4d5e6f"], unread: false } })).toEqual({ files: [], unread: false, history: { files: ["1a2b3c4d5e6f", "notes.txt"], unread: false } });
    expect(savedKeys({ ...answer([]), history: { files: [], unread: true } })?.history).toEqual({ files: [], unread: true });
    // a history this does not understand was not read
    for (const h of ["x", [], { files: "no" }, { files: [1], unread: false }, { files: [] }]) expect(savedKeys({ ...answer([]), history: h })?.history, JSON.stringify(h)).toEqual({ files: [], unread: true });
    // an answer with no history (the pane's own read, an older shell) says nothing of it
    expect(savedKeys(answer([]))).toEqual({ files: [], unread: false });
  });

  it("gives up on a read that takes too long, or fails, as unread", async () => {
    expect(await readSaved(() => new Promise(() => {}), 20)).toBeNull();
    expect(await readSaved(() => Promise.reject(new Error("not a lane")), 20)).toBeNull();
    expect(await readSaved(async () => ({ files: [], unread: false }), 20)).toEqual({ files: [], unread: false });
  });
});

describe("a diff on screen", () => {
  it("shows no key, the rest of the line as it is", () => {
    const html = renderToString(createElement(DiffView, { files: [file("src/config.ts", [`+export const PROMPTPAY_KEY = "${FAKE_KEY}";`])] }));
    expect(html).not.toContain(FAKE_KEY);
    expect(html).toContain("export const PROMPTPAY_KEY = &quot;••••&quot;;");
  });
});
