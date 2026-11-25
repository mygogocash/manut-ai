// A lane's branch, named from the work and planned before the shell makes it (src/code/laneBranch.ts).
import { describe, expect, it } from "vitest";
import { isLaneBranch, laneBranchNames, planLaneBranch, readCleaned, readKept, readMade, readReleased, readRemoved, validPrefix, workDir } from "./laneBranch";

/** What git takes as a branch name, as narrow as Kit makes them: one folder, lower case words joined by hyphens. */
const VALID = /^kit\/[a-z0-9]+(?:-[a-z0-9]+)*$/;
const first = (title: string) => laneBranchNames(title)[0];

describe("a lane's branch is named from its work", () => {
  it("takes the first words of the title, as the canvas's kit/promptpay-qr does", () => {
    expect(first("PromptPay QR")).toBe("kit/promptpay-qr");
    expect(first("PromptPay QR at checkout")).toBe("kit/promptpay-qr-checkout");
    expect(first("Add a PromptPay QR to the checkout")).toBe("kit/add-promptpay-qr-checkout");
    expect(first("Fix stock sync with Shopee")).toBe("kit/fix-stock-sync-shopee");
    expect(first("Thai date format")).toBe("kit/thai-date-format");
  });

  it("leaves out the small words a title is padded with, and the words that ask", () => {
    expect(first("Why is the QR code blurry?")).toBe("kit/qr-code-blurry");
    expect(first("Could you please fix the totals for me")).toBe("kit/fix-totals");
  });

  it("keeps four words at most, and never grows past a short name", () => {
    expect(first("Make the checkout page work for customers who pay in more than one currency")).toBe("kit/make-checkout-page-work");
    const long = first("internationalization localization infrastructure modernization framework");
    expect(long.length).toBeLessThanOrEqual(4 + 40);
    expect(long).toMatch(VALID);
  });

  it("writes lower case words and numbers only, whatever the title holds", () => {
    expect(first("fix: bug #12 (urgent!)")).toBe("kit/fix-bug-12-urgent");
    expect(first("WHY? QR_CODE & PromptPay—v2")).toBe("kit/qr-code-promptpay-v2");
    expect(first("  --spaced   out--  ")).toBe("kit/spaced-out");
    expect(first("Café menu")).toBe("kit/cafe-menu");
    expect(first("a/b\\c.d..e")).toBe("kit/b-c-d-e");
  });

  it("keeps the words it can write from a title in another script, and says work when there are none", () => {
    expect(first("PromptPay QR พร้อมเพย์ ที่หน้าชำระเงิน")).toBe("kit/promptpay-qr");
    expect(first("พร้อมเพย์")).toBe("kit/work");
    expect(first("결제 화면에 QR 추가")).toBe("kit/qr");
    expect(first("")).toBe("kit/work");
    expect(first("   ")).toBe("kit/work");
    expect(first("!!! ???")).toBe("kit/work");
    expect(first("the of and")).toBe("kit/work");
  });

  it("offers the same name with a number after it, for a branch that is taken", () => {
    expect(laneBranchNames("PromptPay QR")).toEqual(["kit/promptpay-qr", "kit/promptpay-qr-2", "kit/promptpay-qr-3", "kit/promptpay-qr-4", "kit/promptpay-qr-5", "kit/promptpay-qr-6", "kit/promptpay-qr-7", "kit/promptpay-qr-8", "kit/promptpay-qr-9"]);
    expect(laneBranchNames("x", 3)).toEqual(["kit/x", "kit/x-2", "kit/x-3"]);
  });

  it("is always a name git takes: no dots, no slash beyond kit/, no trailing hyphen, no .lock", () => {
    const titles = ["a.lock", "x--y", "-lead", "trail-", "a b c d e f g", "\u0000\u001f nul", "~^:?*[ ref", "HEAD", "@", "@{u}", "-", "kit/inside", "..", "a".repeat(500), "ß ǅ İ ı"];
    for (const t of titles) for (const n of laneBranchNames(t)) expect(n, JSON.stringify(t)).toMatch(VALID);
  });

  it("gives the same names for the same title", () => {
    expect(laneBranchNames("Thai date format")).toEqual(laneBranchNames("Thai date format"));
  });
});

describe("planning a lane's branch", () => {
  const plan = (current: string, title = "PromptPay QR") => planLaneBranch({ title, current });

  it("makes a branch from the one the developer's folder is on", () => {
    expect(plan("main")).toEqual({ kind: "make", base: "main", names: laneBranchNames("PromptPay QR") });
    expect(plan("feat/session-controls")).toMatchObject({ kind: "make", base: "feat/session-controls" });
  });

  it("makes it from the commit a detached folder is on", () => {
    expect(plan("3e3f4c1")).toMatchObject({ kind: "make", base: "3e3f4c1" });
  });

  it("makes none where there is no repository", () => {
    expect(plan("")).toEqual({ kind: "none", why: "no_repository" });
  });

  it("never joins or stacks on another lane: each has a folder of its own, made from the developer's branch", () => {
    // a second lane started while the first works is made from the same branch as the first, not from the first's
    expect(plan("main", "Thai date format")).toEqual(plan("main", "Thai date format"));
    expect(Object.keys(plan("main"))).toEqual(["kind", "names", "base"]);
  });
});

describe("where a session's agent works", () => {
  it("is its lane's own folder, else the session's", () => {
    expect(workDir({ cwd: "/home/you/code/web-app", lane: { name: "kit/qr", base: "main", dir: "/home/you/.manut/lanes/web-app/qr/apps/web", worktree: "/home/you/.manut/lanes/web-app/qr" } })).toBe(
      "/home/you/.manut/lanes/web-app/qr/apps/web",
    );
    expect(workDir({ cwd: "/home/you/code/web-app", lane: { name: "kit/qr", base: "main" } })).toBe("/home/you/code/web-app");
    expect(workDir({ cwd: "/home/you/code/web-app" })).toBe("/home/you/code/web-app");
  });
});

describe("the shell's answers about a lane's folder", () => {
  it("takes a made folder only with a branch Kit makes and absolute folders", () => {
    const ok = { branch: "kit/qr", base: "main", dir: "/h/.manut/lanes/a/qr", worktree: "/h/.manut/lanes/a/qr", left: 2, from: "", local: "" };
    expect(readMade(ok)).toEqual(ok);
    expect(readMade({ ...ok, left: undefined })).toEqual({ ...ok, left: 0 });
    for (const bad of [null, "x", { ...ok, branch: "main" }, { ...ok, dir: "relative" }, { ...ok, worktree: "" }, { ...ok, base: "" }]) expect(readMade(bad), JSON.stringify(bad)).toBeNull();
  });

  it("lists the kept folders it can read, and counts it cannot as unknown", () => {
    const k = { worktree: "/h/.manut/lanes/a/qr", dir: "/h/.manut/lanes/a/qr", branch: "kit/qr", base: "main", made: 5, exists: true, changed: 2, ahead: 0, unpushed: 1 };
    expect(readKept([k, { ...k, branch: "main" }, null, { ...k, worktree: "" }, { ...k, changed: -1, ahead: "2", unpushed: -1, exists: "yes" }])).toEqual([k, { ...k, changed: null, ahead: null, unpushed: null, exists: false }]);
    expect(readKept({})).toEqual([]);
  });

  it("takes nothing as removed unless the shell said so", () => {
    expect(readRemoved({ removed: true, deleted: true, changed: null, ahead: null, error: null })).toEqual({ removed: true, deleted: true, changed: null, ahead: null, error: null });
    expect(readRemoved({ removed: "yes", changed: 3, ahead: 1, error: "" })).toEqual({ removed: false, deleted: false, changed: 3, ahead: 1, error: null });
    expect(readRemoved(undefined)).toEqual({ removed: false, deleted: false, changed: null, ahead: null, error: null });
  });
});

describe("the branch prefix (Settings › Worktrees)", () => {
  it("takes one or two lower case words that each end in a slash, and nothing git or a shell could read as more", () => {
    for (const ok of ["kit/", "manut/", "team/ana/", "fix-it/", "a1/"]) expect(validPrefix(ok), ok).toBe(true);
    const long = `${"a".repeat(30)}/`;
    for (const bad of ["", "/", "kit", "Kit/", "kit//", "/kit/", "a/b/c/", "kit/ana", "refs/", "kit /", "-kit/", "kit-/", "ki..t/", "kit/.lock/", "é/", "kit\n/", "x y/", "--help/", long]) expect(validPrefix(bad), JSON.stringify(bad)).toBe(false);
  });

  it("names a lane's branch under the prefix, and under kit/ when the prefix is not one", () => {
    expect(laneBranchNames("PromptPay QR", 2, "team/ana/")).toEqual(["team/ana/promptpay-qr", "team/ana/promptpay-qr-2"]);
    expect(laneBranchNames("PromptPay QR", 1, "Bad Prefix")).toEqual(["kit/promptpay-qr"]);
    expect(planLaneBranch({ title: "Fix totals", current: "main", prefix: "manut/" })).toMatchObject({ kind: "make", names: expect.arrayContaining(["manut/fix-totals"]) });
    expect(planLaneBranch({ title: "Fix totals", current: "main" })).toMatchObject({ names: expect.arrayContaining(["kit/fix-totals"]) });
    for (const prefix of ["kit/", "manut/", "team/ana/"]) for (const n of laneBranchNames("Ünïcode ✓ Fix", 3, prefix)) expect(isLaneBranch(n), n).toBe(true);
  });

  it("reads a lane made under any earlier prefix, and no branch that is not one Kit makes", () => {
    for (const ok of ["kit/qr", "team/ana/qr"]) expect(isLaneBranch(ok), ok).toBe(true);
    for (const bad of ["main", "kit/", "kit/Qr", "a/b/c/d", "kit/a b", "refs/heads/x"]) expect(isLaneBranch(bad), bad).toBe(false);
    const k = { worktree: "/h/l/a/qr", dir: "/h/l/a/qr", branch: "team/ana/qr", base: "main", made: 5, exists: true, changed: 0, ahead: 0, unpushed: 0 };
    expect(readKept([k])).toEqual([k]);
    expect(readMade({ branch: "team/ana/qr", base: "main", dir: "/h/l/a/qr", worktree: "/h/l/a/qr", left: 0, from: "origin/main", local: "" })).toMatchObject({ from: "origin/main" });
  });
});

describe("the shell's answers to a clean-up", () => {
  it("takes nothing as removed unless the shell said so", () => {
    expect(readReleased({ removed: true, kept: null, changed: null, unpushed: null })).toEqual({ removed: true, kept: null, changed: null, unpushed: null });
    expect(readReleased({ removed: "yes", kept: "unpushed", changed: 0, unpushed: 2 })).toEqual({ removed: false, kept: "unpushed", changed: 0, unpushed: 2 });
    expect(readReleased(undefined)).toEqual({ removed: false, kept: null, changed: null, unpushed: null });
    expect(readCleaned({ removed: ["kit/a", "main", 3], kept: [{ branch: "kit/b", why: "changes" }, { branch: "kit/c" }, null], cannot: "not_signed_in" })).toEqual({ removed: ["kit/a"], kept: [{ branch: "kit/b", why: "changes" }], cannot: "not_signed_in" });
    expect(readCleaned("x")).toEqual({ removed: [], kept: [], cannot: null });
  });
});
