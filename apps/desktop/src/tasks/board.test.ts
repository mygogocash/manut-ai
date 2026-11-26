// Tasks › Pull requests (item 100): the readiness order with every state, the list of every project's repository read once each,
// what is noted for the lanes' rows, and when the list is read again (at most once a minute while shown, never while hidden).
import { beforeEach, describe, expect, it, vi } from "vitest";
import { BoardWatch, due, readiness, READINESS, REFRESH_MS, rowOf, sortRows, type BoardRow } from "./board";
import { MaskingTaskHost, type TaskHost } from "./host";
import { pullFor, resetPulls } from "./pulls";
import type { PullRow, TaskChecks } from "./types";

const checks = (passed: number, failed = 0, pending = 0): TaskChecks => ({ passed, failed, pending, total: passed + failed + pending });
const pull = (number: number, over: Partial<PullRow> = {}): PullRow => ({
  number,
  title: `change ${number}`,
  state: "open",
  url: `https://github.com/shop/site/pull/${number}`,
  labels: [],
  author: "noi",
  created: 1000,
  updated: 2000,
  checks: checks(2),
  head: `b${number}`,
  same: true,
  from: "shop/site",
  review: "",
  conflict: false,
  base: "main",
  ...over,
});
const row = (p: PullRow, repo = "shop/site"): BoardRow => ({ source: "github", repo, folder: "/code/site", pull: p });

beforeEach(() => resetPulls());

describe("how ready a request is", () => {
  it("reads every state, the first that holds of draft, conflict, changes asked, failing, running, review needed", () => {
    expect(readiness(pull(1, { review: "approved" }))).toBe("ready");
    // a repository that asks for no review: green and no conflict is ready
    expect(readiness(pull(2))).toBe("ready");
    expect(readiness(pull(3, { checks: checks(0) }))).toBe("ready");
    expect(readiness(pull(4, { checks: null }))).toBe("ready");
    expect(readiness(pull(5, { checks: checks(1, 0, 2), review: "approved" }))).toBe("checks");
    expect(readiness(pull(6, { review: "required" }))).toBe("review");
    expect(readiness(pull(7, { review: "required", checks: checks(1, 0, 1) }))).toBe("checks");
    expect(readiness(pull(8, { review: "changes", checks: checks(0, 1) }))).toBe("changes");
    expect(readiness(pull(9, { checks: checks(1, 1, 1), review: "approved" }))).toBe("failing");
    expect(readiness(pull(10, { conflict: true, review: "changes" }))).toBe("conflict");
    expect(readiness(pull(11, { state: "draft", conflict: true, review: "approved" }))).toBe("draft");
    expect(READINESS).toEqual(["ready", "checks", "review", "changes", "failing", "conflict", "draft"]);
  });

  it("sorts readiest first, then the most recently changed, then by repository and number", () => {
    const rows = [
      row(pull(1, { state: "draft", updated: 9000 })),
      row(pull(2, { review: "changes", updated: 8000 })),
      row(pull(3, { checks: checks(1, 0, 1), updated: 100 })),
      row(pull(4, { review: "approved", updated: 500 })),
      row(pull(5, { review: "approved", updated: 700 })),
      row(pull(6, { review: "required", updated: 5000 })),
      row(pull(7, { checks: checks(0, 2), updated: 9999 })),
      row(pull(8, { conflict: true })),
      row(pull(9, { review: "approved", updated: 700 }), "aaa/site"),
    ];
    expect(sortRows(rows).map((r) => r.pull.number)).toEqual([9, 5, 4, 3, 6, 2, 7, 8, 1]);
    expect(rowOf(rows, "github", "SHOP/site", 4)?.pull.number).toBe(4);
    expect(rowOf(rows, "gitlab", "shop/site", 4)).toBeUndefined();
  });

  it("reads again only when shown and a minute after the last read", () => {
    expect(due(null, 0, true)).toBe(true);
    expect(due(null, 0, false)).toBe(false);
    expect(due(1000, 1000 + REFRESH_MS - 1, true)).toBe(false);
    expect(due(1000, 1000 + REFRESH_MS, true)).toBe(true);
    expect(due(1000, 1000 + 10 * REFRESH_MS, false)).toBe(false);
  });
});

function fakeHost(boards: Record<string, PullRow[]>, remotes: Record<string, { source: "github" | "gitlab"; repo: string } | null>) {
  const board = vi.fn(async (source: "github" | "gitlab", repo: string) => {
    const items = boards[`${source}:${repo}`];
    if (!items) throw new Error("gh: Could not resolve to a Repository");
    return { items, more: false, at: 1 };
  });
  const host = {
    kind: "mock",
    status: async () => ({ installed: true, signed_in: true }),
    list: async () => ({ items: [], more: false }),
    view: async () => {
      throw new Error("not used");
    },
    remote: vi.fn(async (cwd: string) => remotes[cwd] ?? null),
    ghAccounts: async () => ({ installed: true, accounts: [] }),
    me: async () => {
      throw new Error("not used");
    },
    board,
  } as unknown as TaskHost;
  return { host, board };
}

describe("the list of every project's requests", () => {
  it("reads each repository once, however many projects are clones of it, and notes what it read for the lanes' rows", async () => {
    const { host, board } = fakeHost(
      { "github:shop/site": [pull(41, { review: "approved", head: "kit/qr" }), pull(42, { state: "draft" })], "gitlab:shop/sub/app": [pull(7, { review: "changes" })] },
      { "/a/site": { source: "github", repo: "shop/site" }, "/b/site-copy": { source: "github", repo: "Shop/Site" }, "/c/app": { source: "gitlab", repo: "shop/sub/app" }, "/d/notes": null },
    );
    let now = 10_000;
    const w = new BoardWatch(host, () => true, () => now);
    await w.setProjects(["/a/site", "/b/site-copy", "/c/app", "/d/notes"]);
    expect(board).toHaveBeenCalledTimes(2);
    const s = w.get();
    expect(s.repos?.map((r) => `${r.source}:${r.repo}:${r.folder}`)).toEqual(["github:shop/site:/a/site", "gitlab:shop/sub/app:/c/app"]);
    expect(s.folders).toEqual({ "/a/site": "github:shop/site", "/b/site-copy": "github:shop/site", "/c/app": "gitlab:shop/sub/app" });
    expect(s.rows.map((r) => r.pull.number)).toEqual([41, 7, 42]);
    expect(s.at).toBe(10_000);
    // the lane's row reads the same answer: no read of its own
    expect(pullFor("github", "shop/site", "kit/qr")?.number).toBe(41);
    // the same projects again: nothing is read
    await w.setProjects(["/a/site", "/b/site-copy", "/c/app", "/d/notes"]);
    expect(board).toHaveBeenCalledTimes(2);
    // the minute's timer: not yet, then once
    now += REFRESH_MS - 1;
    await w.tick();
    expect(board).toHaveBeenCalledTimes(2);
    now += 1;
    await w.tick();
    expect(board).toHaveBeenCalledTimes(4);
  });

  it("never reads while hidden, and reads at once on coming back when the last read is a minute old", async () => {
    const { host, board } = fakeHost({ "github:shop/site": [pull(1)] }, { "/a": { source: "github", repo: "shop/site" } });
    let now = 0;
    let shown = true;
    const w = new BoardWatch(host, () => shown, () => now);
    await w.setProjects(["/a"]);
    expect(board).toHaveBeenCalledTimes(1);
    shown = false;
    for (let i = 1; i <= 5; i++) {
      now += REFRESH_MS;
      await w.tick();
    }
    expect(board).toHaveBeenCalledTimes(1);
    shown = true;
    await w.tick();
    expect(board).toHaveBeenCalledTimes(2);
  });

  it("says which repository failed and keeps the others", async () => {
    const { host } = fakeHost({ "github:shop/site": [pull(1)] }, { "/a": { source: "github", repo: "shop/site" }, "/b": { source: "github", repo: "shop/gone" } });
    const w = new BoardWatch(host, () => true, () => 1);
    await w.setProjects(["/a", "/b"]);
    expect(w.get().rows.map((r) => r.pull.number)).toEqual([1]);
    expect(w.get().errors).toEqual([{ source: "github", repo: "shop/gone", error: "gh: Could not resolve to a Repository" }]);
  });

  it("asks one read at a time: a second ask while one runs waits for it", async () => {
    const { host, board } = fakeHost({ "github:shop/site": [pull(1)] }, { "/a": { source: "github", repo: "shop/site" } });
    const w = new BoardWatch(host, () => true, () => 1);
    await w.setProjects(["/a"]);
    await Promise.all([w.read(), w.read(), w.read()]);
    expect(board).toHaveBeenCalledTimes(2);
  });

  it("passes every title through the app's one masker whichever host answered", async () => {
    const fake = `ghp_${"aBcD".repeat(9)}`;
    const { host } = fakeHost({ "github:shop/site": [pull(1, { title: `Use ${fake} here` })] }, {});
    const masked = await new MaskingTaskHost(host).board("github", "shop/site");
    expect(masked.items[0].title).not.toContain(fake);
  });
});

describe("other hosts, read only (item 100b)", () => {
  const azure = { host: "azure" as const, name: "Azure DevOps", repo: "Shop Site/site" };
  const gitea = { host: "gitea" as const, name: "gitea.example.com", repo: "baanmali/app" };

  it("asks the other hosts' reader only for a folder not on GitHub or GitLab, and lists what it answers in the same order", async () => {
    const { host, board } = fakeHost({ "github:shop/site": [pull(41)] }, { "/a/site": { source: "github", repo: "shop/site" } });
    const otherRemote = vi.fn(async (cwd: string) => (cwd === "/b/az" ? azure : cwd === "/c/gt" ? gitea : null));
    const otherBoard = vi.fn(async (cwd: string) =>
      cwd === "/b/az" ? { ...azure, items: [pull(31, { review: "changes" }), pull(32, { review: "approved" })], more: false, at: 1 } : cwd === "/c/gt" ? { ...gitea, items: [pull(7, { state: "draft" })], more: false, at: 1 } : null,
    );
    Object.assign(host, { otherRemote, otherBoard });
    const w = new BoardWatch(host, () => true, () => 1);
    await w.setProjects(["/a/site", "/b/az", "/c/gt", "/d/none"]);
    // a GitHub project's folder is never asked of the other hosts' reader
    expect(otherRemote.mock.calls.map((c) => c[0])).toEqual(["/b/az", "/c/gt", "/d/none"]);
    const s = w.get();
    expect(s.otherRepos.map((r) => `${r.host}:${r.repo}:${r.folder}`)).toEqual(["azure:Shop Site/site:/b/az", "gitea:baanmali/app:/c/gt"]);
    expect(s.others.map((r) => `${r.host}:${r.pull.number}`)).toEqual(["azure:32", "azure:31", "gitea:7"]);
    expect(s.rows.map((r) => r.pull.number)).toEqual([41]);
    expect(board).toHaveBeenCalledTimes(1);
    // nothing of another host's is noted for a lane's row
    expect(pullFor("github", "Shop Site/site", "b31") ?? null).toBeNull();
  });

  it("a host whose CLI is not here gives nothing and no error; a list that fails says so", async () => {
    const { host } = fakeHost({}, {});
    Object.assign(host, {
      otherRemote: vi.fn(async (cwd: string) => (cwd === "/b/az" ? azure : null)),
      otherBoard: vi.fn(async () => Promise.reject(new Error("az: ERROR: TF400813: not authorized"))),
    });
    const w = new BoardWatch(host, () => true, () => 1);
    await w.setProjects(["/b/az", "/d/none"]);
    expect(w.get().errors).toEqual([{ source: "azure", repo: "Shop Site/site", error: "az: ERROR: TF400813: not authorized" }]);
    const { host: bare } = fakeHost({}, {});
    const w2 = new BoardWatch(bare, () => true, () => 1);
    await w2.setProjects(["/b/az"]);
    expect(w2.get().others).toEqual([]);
    expect(w2.get().errors).toEqual([]);
  });

  it("passes another host's titles through the app's one masker", async () => {
    const inner = {
      otherRemote: async () => azure,
      otherBoard: async () => ({ ...azure, items: [pull(31, { title: "Read the total ghp_aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789" })], more: false, at: 1 }),
    } as unknown as TaskHost;
    const b = await new MaskingTaskHost(inner).otherBoard!("/b/az");
    expect(b?.items[0].title).not.toContain("ghp_aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789");
  });
});
