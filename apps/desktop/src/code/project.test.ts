// What Kit keeps per project on this computer: the dial's level, the rules kept with "Always allow in this project",
// the folders Kit may read beside it, and the latest steps stopped outside it. A saved record that is broken in any
// part reads as the careful default for that part.
import { describe, expect, it } from "vitest";
import {
  BLOCKED_MAX,
  addRule,
  allowFolder,
  dropRule,
  emptyProject,
  mayAllow,
  noteBlocked,
  parseProjects,
  projectOf,
  removeFolder,
  setLevel,
  type Projects,
} from "./project";

const root = "/Users/fon/baanmali-preorder";
const none: Projects = {};

describe("a project's settings", () => {
  it("start at the lowest level with nothing kept", () => {
    expect(projectOf(none, root)).toEqual(emptyProject());
    expect(emptyProject()).toEqual({ level: "asks_every_time", rules: [], folders: [], blocked: [] });
  });

  it("are kept per project, however its path is spelled", () => {
    const p = setLevel(none, `${root}/`, "edits_and_safe_commands");
    expect(projectOf(p, root).level).toBe("edits_and_safe_commands");
    expect(projectOf(p, "/Users/fon/other").level).toBe("asks_every_time");
  });

  it("keep each rule once, and take it back", () => {
    let p = addRule(none, root, { words: ["pnpm", "add"] });
    p = addRule(p, root, { words: ["pnpm", "add"] });
    p = addRule(p, root, { words: ["rm", "-rf", "./build"], exact: true });
    expect(projectOf(p, root).rules).toEqual([{ words: ["pnpm", "add"] }, { words: ["rm", "-rf", "./build"], exact: true }]);
    p = dropRule(p, root, { words: ["pnpm", "add"] });
    expect(projectOf(p, root).rules).toEqual([{ words: ["rm", "-rf", "./build"], exact: true }]);
  });

  it("allow a folder once, which clears what was stopped there, and take it back", () => {
    let p = noteBlocked(none, root, { what: "read", path: "~/Documents/tax-2026.xlsx", folder: "/Users/fon/Documents", at: 1 });
    p = noteBlocked(p, root, { what: "read", path: "/etc/hosts", folder: "/etc", at: 2 });
    p = allowFolder(p, root, "/Users/fon/Documents");
    p = allowFolder(p, root, "/Users/fon/Documents/");
    expect(projectOf(p, root).folders).toEqual(["/Users/fon/Documents"]);
    expect(projectOf(p, root).blocked.map((b) => b.path)).toEqual(["/etc/hosts"]);
    p = removeFolder(p, root, "/Users/fon/Documents");
    expect(projectOf(p, root).folders).toEqual([]);
  });

  it("never allows a folder the project is in, such as the home folder or the root of the disk", () => {
    expect(mayAllow("/Users/fon/Documents", root)).toBe(true);
    for (const f of ["/", "/Users", "/Users/fon", root, "~", "~/Documents", ""]) expect([f, mayAllow(f, root)]).toEqual([f, false]);
    expect(projectOf(allowFolder(none, root, "/Users/fon"), root).folders).toEqual([]);
    expect(projectOf(allowFolder(none, root, "/"), root).folders).toEqual([]);
    expect(projectOf(allowFolder(none, root, "~"), root).folders).toEqual([]);
    expect(projectOf(allowFolder(none, root, ""), root).folders).toEqual([]);
  });

  it("list what was stopped newest first, once per path, and only the latest few", () => {
    let p = none;
    for (let i = 0; i < BLOCKED_MAX + 3; i++) p = noteBlocked(p, root, { what: "read", path: `/tmp/${i}`, folder: "/tmp", at: i });
    p = noteBlocked(p, root, { what: "command", path: "/tmp/3", folder: "/tmp", at: 99 });
    const list = projectOf(p, root).blocked;
    expect(list.length).toBe(BLOCKED_MAX);
    expect(list[0]).toEqual({ what: "command", path: "/tmp/3", folder: "/tmp", at: 99 });
    expect(list.filter((b) => b.path === "/tmp/3").length).toBe(1);
  });
});

describe("a saved record", () => {
  it("reads back what was saved", () => {
    const p = setLevel(addRule(allowFolder(none, root, "/Users/fon/Documents"), root, { words: ["pnpm", "add"] }), root, "edits_alone");
    expect(parseProjects(JSON.stringify(p))).toEqual(p);
  });

  it("reads a broken part as its careful default, and drops what it cannot read", () => {
    const raw = JSON.stringify({
      [root]: {
        level: "everything",
        rules: [{ words: ["pnpm", "add"] }, { words: [] }, { words: "rm" }, { words: ["rm", 3] }, null],
        folders: ["/Users/fon/Documents", 7, "", "~/x"],
        blocked: [{ what: "read", path: "/etc/hosts", folder: "/etc", at: 1 }, { what: "fly", path: "x", folder: "/", at: 1 }, "x"],
      },
      "": { level: "edits_alone" },
      "/broken": "x",
    });
    expect(parseProjects(raw)).toEqual({
      [root]: {
        level: "asks_every_time",
        rules: [{ words: ["pnpm", "add"] }],
        folders: ["/Users/fon/Documents"],
        blocked: [{ what: "read", path: "/etc/hosts", folder: "/etc", at: 1 }],
      },
    });
    for (const bad of [null, "", "{", "[]", "3", "null"]) expect(parseProjects(bad)).toEqual({});
  });
});
