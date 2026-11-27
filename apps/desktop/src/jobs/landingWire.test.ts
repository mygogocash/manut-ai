// What the shell answers for a landing (item 102i), read field by field: the shell's `Landed`, `TakenBack` and `KeptPatch`
// (src-tauri/src/lane_land.rs) as their serde names them, an answer of another shape taken for nothing, each outcome as item 102d's
// `Landing`, and a kept patch's text as the diff view's files for Show patch.
import { describe, expect, it } from "vitest";
import { landingOf, patchFiles, PATCH_LINES, readLanded, readPatch, readTakenBack, refusedLanding } from "./landingWire";
import { landed, landingOutcome } from "./rules";

const answer = (o: Record<string, unknown>) => ({ outcome: "landed", files: [], files_total: 0, conflicts: [], cut: [], cut_total: 0, keys: [], patch: "", why: "", outside: [], error: "", ...o });

describe("reading the shell's answers", () => {
  it("reads a landing as the shell's serde writes it, and nothing of another shape", () => {
    expect(readLanded(answer({ files: ["src/qr.ts", "src/qr.test.ts"], files_total: 2, conflicts: ["src/qr.ts"], keys: ["src/qr.ts"] }))).toEqual({
      outcome: "landed",
      files: ["src/qr.ts", "src/qr.test.ts"],
      filesTotal: 2,
      conflicts: ["src/qr.ts"],
      keys: ["src/qr.ts"],
      patch: "",
      why: "",
      outside: [],
      error: "",
    });
    // the shell names at most 500 files: the total counts the rest
    expect(readLanded(answer({ files: ["a"], files_total: 812 }))?.filesTotal).toBe(812);
    for (const bad of [null, "landed", 3, {}, answer({ outcome: "done" }), answer({ files: "a" }), answer({ files: [1] }), answer({ conflicts: {} })]) expect(readLanded(bad)).toBeNull();
  });

  it("reads Take back's answer and a kept patch", () => {
    expect(readTakenBack({ files: ["a.txt"], files_total: 1 })).toEqual({ files: ["a.txt"], filesTotal: 1 });
    expect(readTakenBack({ files: null })).toBeNull();
    expect(readPatch({ text: "diff --git a/a b/a\n", bytes: 19, cut: false, path: "/u/.manut/patches/j/x.patch" })).toEqual({ text: "diff --git a/a b/a\n", bytes: 19, cut: false, path: "/u/.manut/patches/j/x.patch" });
    expect(readPatch({ text: 3, path: "x" })).toBeNull();
  });
});

describe("a landing as the row and the round carry it (landingOf)", () => {
  it("names what landed, its conflicts and its keys", () => {
    const l = landingOf(readLanded(answer({ files: ["src/qr.ts", "src/receipt.tsx"], files_total: 2, conflicts: ["src/qr.ts"], keys: ["src/receipt.tsx"] }))!);
    expect(l).toEqual({ files: [{ path: "src/qr.ts" }, { path: "src/receipt.tsx" }], conflicts: ["src/qr.ts"], keys: ["src/receipt.tsx"] });
    expect([landed(l), landingOutcome(l)]).toEqual([true, "landed"]);
    expect(landingOf(readLanded(answer({ files: ["a"], files_total: 3 }))!).more).toBe(2);
  });

  it("a helper that changed nothing, a patch that would not apply and one kept untried", () => {
    expect(landingOutcome(landingOf(readLanded(answer({ outcome: "nothing" }))!))).toBe("changedNothing");
    const kept = landingOf(readLanded(answer({ outcome: "kept", files: ["a.txt"], files_total: 1, patch: "/u/.manut/patches/j/h.patch", why: "would_not_apply", error: "error: a.txt: does not exist in index" }))!);
    expect(kept).toMatchObject({ patchPath: "/u/.manut/patches/j/h.patch", error: "error: a.txt: does not exist in index", conflicts: [] });
    expect([landed(kept), landingOutcome(kept)]).toEqual([false, "keptPatch"]);
    const outside = landingOf(readLanded(answer({ outcome: "kept", files: ["../x.ts"], files_total: 1, patch: "/p", why: "outside", outside: ["../x.ts"] }))!);
    expect(outside).toMatchObject({ refusal: "outside", outside: ["../x.ts"], patchPath: "/p" });
    expect(landingOutcome(outside)).toBe("keptOutside");
    // a refusal of the shell's, or a shell that could not be asked: nothing was written
    expect(landingOutcome(refusedLanding("busy"))).toBe("failed");
    expect(refusedLanding("").error).toBe("unread");
  });

  it("a landing the person took back is no longer in the lead", () => {
    const l = { ...landingOf(readLanded(answer({ files: ["a"], files_total: 1 }))!), takenBack: true };
    expect([landed(l), landingOutcome(l)]).toEqual([false, "takenBack"]);
  });
});

describe("a kept patch as Show patch draws it (patchFiles)", () => {
  const patch = [
    "diff --git a/src/qr.ts b/src/qr.ts",
    "index 1111111111111111111111111111111111111111..2222222222222222222222222222222222222222 100644",
    "--- a/src/qr.ts",
    "+++ b/src/qr.ts",
    "@@ -1,3 +1,3 @@",
    " export function qr() {",
    "-  return 59;",
    "+  return 590;",
    " }",
    "\\ No newline at end of file",
    "diff --git a/src/new.ts b/src/new.ts",
    "new file mode 100644",
    "index 0000000000000000000000000000000000000000..3333333333333333333333333333333333333333",
    "--- /dev/null",
    "+++ b/src/new.ts",
    "@@ -0,0 +1 @@",
    "+export const n = 1;",
    "diff --git a/logo.png b/logo.png",
    "new file mode 100644",
    "index 0000000000000000000000000000000000000000..4444444444444444444444444444444444444444",
    "GIT binary patch",
    "literal 3",
    "KcmZ>Y00031",
    "",
    "literal 0",
    "HcmV?d00001",
    "",
    "diff --git a/old.txt b/old.txt",
    "deleted file mode 100644",
    "--- a/old.txt",
    "+++ /dev/null",
    "@@ -1 +0,0 @@",
    "--- a line that begins with dashes",
    "",
  ].join("\n");

  it("one file per block, its hunks' lines and counts, a binary file's note in place of lines", () => {
    const files = patchFiles(patch);
    expect(files.map((f) => [f.path, f.kind, f.added, f.removed, f.note ?? ""])).toEqual([
      ["src/qr.ts", "update", 1, 1, ""],
      ["src/new.ts", "add", 1, 0, ""],
      ["logo.png", "add", 0, 0, "binary"],
      ["old.txt", "delete", 0, 1, ""],
    ]);
    expect(files[0].lines).toEqual(["@@ -1,3 +1,3 @@", " export function qr() {", "-  return 59;", "+  return 590;", " }"]);
    expect(files[2].lines).toEqual([]);
    expect(files[3].lines).toEqual(["@@ -1 +0,0 @@", "--- a line that begins with dashes"]);
  });

  it("draws at most PATCH_LINES lines of a file and counts the rest; text before the first block is no file's", () => {
    const long = ["warning: ignored", "diff --git a/a b/a", "@@ -1 +1,900 @@", ...Array.from({ length: 900 }, (_, i) => `+${i}`)].join("\n");
    const [f] = patchFiles(long);
    expect(f.lines).toHaveLength(PATCH_LINES);
    expect(f.more).toBe(901 - PATCH_LINES);
    expect(f.added).toBe(900);
    expect(patchFiles("")).toEqual([]);
  });
});
