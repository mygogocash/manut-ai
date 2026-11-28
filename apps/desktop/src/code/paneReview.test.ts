// What the pane's Diff lists in each scope and how Prev and Next walk it (paneReview.ts, item 146), and the layout the person chose
// that is kept on this computer (diffPrefs.ts).
import { describe, expect, it } from "vitest";
import type { DiffFile } from "../lib/protocol";
import { DIFF_DEFAULTS, parseDiffPrefs } from "./diffPrefs";
import type { LaneReview } from "./laneFolder";
import { entriesOf, placeOf, sectionsOf, stepPlace, type WholeList } from "./paneReview";

const f = (path: string): DiffFile => ({ path, kind: "update", lines: ["@@ -1,1 +1,1 @@", "-a", "+b"], added: 1, removed: 1 });
const WHOLE: WholeList = { files: [f("src/a.ts"), f("src/b.ts"), f("src/c.ts")], moreFiles: 4 };
const REVIEW: LaneReview = {
  uncommitted: { files: [f("src/b.ts"), f("notes.md")], moreFiles: 0 },
  commits: [
    { id: "3f2a1bcd9e01", subject: "Add the QR", files: [f("src/a.ts"), f("src/b.ts")], moreFiles: 1, unread: false },
    { id: "9c8d7e6f5a43", subject: "Start", files: [], moreFiles: 0, unread: true },
    { id: "1a2b3c4d5e6f", subject: "Rename a", files: [f("src/b.ts")], moreFiles: 0, unread: false },
  ],
  moreCommits: 2,
};

describe("the sections each scope lists", () => {
  it("lists All changes as one section with no heading: the whole list, as it always was, and its count of more files", () => {
    const [only, ...rest] = sectionsOf("all", WHOLE, null);
    expect(rest).toEqual([]);
    expect(only).toEqual({ id: "all", files: WHOLE.files, moreFiles: 4 });
    expect(only.commit).toBeUndefined();
  });

  it("lists Not committed as one section of the folder against HEAD", () => {
    const sections = sectionsOf("uncommitted", WHOLE, REVIEW);
    expect(sections).toHaveLength(1);
    expect(sections[0].id).toBe("uncommitted");
    expect(sections[0].files.map((x) => x.path)).toEqual(["src/b.ts", "notes.md"]);
  });

  it("lists Commits as one section for each commit, newest first, each with its files, its subject and whether they were read", () => {
    const sections = sectionsOf("commits", WHOLE, REVIEW);
    expect(sections.map((s) => s.id)).toEqual(["3f2a1bcd9e01", "9c8d7e6f5a43", "1a2b3c4d5e6f"]);
    expect(sections.map((s) => s.commit?.subject)).toEqual(["Add the QR", "Start", "Rename a"]);
    expect(sections.map((s) => s.files.length)).toEqual([2, 0, 1]);
    expect(sections.map((s) => s.moreFiles)).toEqual([1, 0, 0]);
    expect(sections.map((s) => s.commit?.unread)).toEqual([false, true, false]);
  });

  it("lists nothing in a scope that needs the review until it has been read", () => {
    expect(sectionsOf("uncommitted", WHOLE, null)).toEqual([]);
    expect(sectionsOf("commits", WHOLE, null)).toEqual([]);
  });
});

describe("the files Prev and Next walk", () => {
  it("are every file of every section in the order drawn, a file changed in two commits being two of them", () => {
    const entries = entriesOf(sectionsOf("commits", WHOLE, REVIEW));
    expect(entries.map((e) => e.file.path)).toEqual(["src/a.ts", "src/b.ts", "src/b.ts"]);
    expect(new Set(entries.map((e) => e.key)).size).toBe(3);
    expect(entries[0].section.commit?.id).toBe("3f2a1bcd9e01");
  });

  it("number the whole list's files when the scope is All changes", () => {
    expect(entriesOf(sectionsOf("all", WHOLE, null)).map((e) => e.file.path)).toEqual(["src/a.ts", "src/b.ts", "src/c.ts"]);
  });
});

describe("the place of the file shown by itself", () => {
  const entries = entriesOf(sectionsOf("all", WHOLE, null));

  it("is the place of the file with the key, and follows it when the list is read again with it somewhere else", () => {
    const key = entries[1].key;
    expect(placeOf(entries, key, 1)).toBe(1);
    // a file that changed last comes first: the same file is now at 2
    const moved = entriesOf([{ id: "all", files: [f("src/new.ts"), WHOLE.files[0], WHOLE.files[1]], moreFiles: 0 }]);
    expect(placeOf(moved, key, 1)).toBe(2);
  });

  it("is the place the person was at, held inside the list, once the file has gone", () => {
    const gone = `all\u0000src/gone.ts`;
    expect(placeOf(entries, gone, 1)).toBe(1);
    expect(placeOf(entries, gone, 9)).toBe(2);
    expect(placeOf(entries, gone, -3)).toBe(0);
  });

  it("is the first file when none was chosen, and -1 for an empty list", () => {
    expect(placeOf(entries, null, 0)).toBe(0);
    expect(placeOf([], null, 0)).toBe(-1);
    expect(placeOf([], "x", 3)).toBe(-1);
  });

  it("is the same file in two commits only for the one the key names", () => {
    const two = entriesOf(sectionsOf("commits", WHOLE, REVIEW));
    expect(placeOf(two, two[2].key, 0)).toBe(2);
    expect(placeOf(two, two[1].key, 0)).toBe(1);
  });
});

describe("Prev and Next", () => {
  it("move one file and stop at the ends", () => {
    expect(stepPlace(1, 3, 1)).toBe(2);
    expect(stepPlace(1, 3, -1)).toBe(0);
    expect(stepPlace(2, 3, 1)).toBe(2);
    expect(stepPlace(0, 3, -1)).toBe(0);
  });

  it("stay put on one file or none", () => {
    expect(stepPlace(0, 1, 1)).toBe(0);
    expect(stepPlace(0, 0, 1)).toBe(0);
    expect(stepPlace(0, 0, -1)).toBe(0);
  });
});

describe("the choices kept on this computer", () => {
  it("start as unified and the list", () => {
    expect(parseDiffPrefs(null)).toEqual({ layout: "unified", one: false });
    expect(DIFF_DEFAULTS).toEqual({ layout: "unified", one: false });
  });

  it("read back what was saved", () => {
    expect(parseDiffPrefs(JSON.stringify({ layout: "split", one: true }))).toEqual({ layout: "split", one: true });
    expect(parseDiffPrefs(JSON.stringify({ layout: "unified", one: false }))).toEqual({ layout: "unified", one: false });
  });

  it("take what is usable and the default for the rest, and survive a damaged value", () => {
    expect(parseDiffPrefs(JSON.stringify({ layout: "triple", one: "yes" }))).toEqual(DIFF_DEFAULTS);
    expect(parseDiffPrefs(JSON.stringify({ layout: "split" }))).toEqual({ layout: "split", one: false });
    for (const bad of ["", "{", "[]", "null", "42", '"split"']) expect(parseDiffPrefs(bad), bad).toEqual(DIFF_DEFAULTS);
  });
});
