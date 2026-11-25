// The pull request on a lane's row (item 76): a lane's branch is matched to the open requests the app already lists, the repository is
// read at most once while its cache is fresh (never one call per lane, never on a timer), and a failed read shows nothing.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TaskHost } from "./host";
import { notePulls, PULLS_MAX_AGE, pullFor, readPulls, remoteOf, resetPulls, shouldRead } from "./pulls";
import { clearOpen, getTasks, resetTasks, showPull } from "./state";
import type { TaskItem } from "./types";

const pr = (number: number, head: string, state: TaskItem["state"] = "open"): TaskItem => ({ number, title: `change ${number}`, state, url: "", labels: [], author: "p", created: 0, updated: 0, checks: null, head });
const NOW = 1_000_000;

const fakeHost = (over: Partial<TaskHost> = {}): TaskHost & { list: ReturnType<typeof vi.fn>; remote: ReturnType<typeof vi.fn> } =>
  ({
    kind: "mock",
    status: async () => ({ installed: true, signed_in: true }),
    list: vi.fn(async () => ({ items: [pr(12, "kit/promptpay-qr"), pr(13, "kit/other", "draft")], more: false })),
    view: async () => {
      throw new Error("not used");
    },
    remote: vi.fn(async () => ({ source: "github" as const, repo: "o/r" })),
    ghAccounts: async () => ({ installed: true, accounts: [] }),
    me: async () => {
      throw new Error("not used");
    },
    ...over,
  }) as never;

beforeEach(() => {
  resetPulls();
  resetTasks();
});

describe("matching a lane's branch to a pull request", () => {
  it("finds the open or draft request made from the branch, in its own repository only", () => {
    notePulls("github", "o/r", [pr(12, "kit/promptpay-qr"), pr(13, "kit/other", "draft")], NOW);
    expect(pullFor("github", "o/r", "kit/promptpay-qr")).toMatchObject({ number: 12, state: "open" });
    expect(pullFor("github", "o/r", "kit/other")).toMatchObject({ number: 13, state: "draft" });
    expect(pullFor("github", "o/r", "main")).toBeNull();
    expect(pullFor("github", "x/y", "kit/promptpay-qr")).toBeNull();
    expect(pullFor("gitlab", "o/r", "kit/promptpay-qr")).toBeNull();
  });

  it("ignores a closed or merged request and one whose branch is not known (an older shell)", () => {
    notePulls("github", "o/r", [pr(1, "a", "merged"), pr(2, "b", "closed"), pr(3, "")], NOW);
    for (const b of ["a", "b", ""]) expect(pullFor("github", "o/r", b), b).toBeNull();
  });

  it("takes the newer of two open requests from one branch", () => {
    notePulls("github", "o/r", [pr(5, "kit/x"), pr(9, "kit/x")], NOW);
    expect(pullFor("github", "o/r", "kit/x")?.number).toBe(9);
  });

  it("adds to what is known from a page of a filtered list, and replaces it from a whole one", () => {
    notePulls("github", "o/r", [pr(1, "a")], NOW);
    notePulls("github", "o/r", [pr(2, "b")], NOW);
    expect(pullFor("github", "o/r", "a")?.number).toBe(1);
    // a whole first page: a request it leaves out is no longer open
    notePulls("github", "o/r", [pr(2, "b")], NOW, true);
    expect(pullFor("github", "o/r", "a")).toBeNull();
    expect(pullFor("github", "o/r", "b")?.number).toBe(2);
  });
});

describe("reading the repository", () => {
  it("makes one call for the repository, however many lanes ask, and none while the answer is fresh", async () => {
    const host = fakeHost();
    await readPulls(host, "github", "o/r", NOW);
    await readPulls(host, "github", "o/r", NOW + 1_000);
    await readPulls(host, "github", "o/r", NOW + PULLS_MAX_AGE - 1);
    expect(host.list).toHaveBeenCalledTimes(1);
    expect(host.list).toHaveBeenCalledWith("github", "o/r", "prs", "open", 0);
    expect(pullFor("github", "o/r", "kit/promptpay-qr")?.number).toBe(12);
  });

  it("reads again only when the answer is old", async () => {
    const host = fakeHost();
    await readPulls(host, "github", "o/r", NOW);
    expect(shouldRead("github", "o/r", NOW + PULLS_MAX_AGE)).toBe(true);
    await readPulls(host, "github", "o/r", NOW + PULLS_MAX_AGE);
    expect(host.list).toHaveBeenCalledTimes(2);
  });

  it("does not read what the Tasks page just listed", async () => {
    notePulls("github", "o/r", [pr(12, "kit/promptpay-qr")], NOW);
    const host = fakeHost();
    await readPulls(host, "github", "o/r", NOW + 1_000);
    expect(host.list).not.toHaveBeenCalled();
  });

  it("shows nothing and does not try again at once when gh is missing, signed out or offline", async () => {
    const host = fakeHost({ list: vi.fn(async () => Promise.reject(new Error("gh: not signed in"))) as never });
    await expect(readPulls(host, "github", "o/r", NOW)).resolves.toBeUndefined();
    await readPulls(host, "github", "o/r", NOW + 5_000);
    expect(host.list).toHaveBeenCalledTimes(1);
    expect(pullFor("github", "o/r", "kit/promptpay-qr")).toBeNull();
  });

  it("asks once per folder which repository it is", async () => {
    const host = fakeHost();
    await remoteOf(host, "/work/a");
    await remoteOf(host, "/work/a");
    expect(host.remote).toHaveBeenCalledTimes(1);
    expect(await remoteOf(fakeHost({ remote: vi.fn(async () => Promise.reject(new Error("x"))) as never }), "/work/b")).toBeNull();
  });
});

describe("opening it where Tasks already goes", () => {
  it("shows that repository's open pull requests and asks for the request to be selected", () => {
    expect(showPull("github", "o/r", 12, "/work/a")).toBe(true);
    const tk = getTasks();
    expect(tk).toMatchObject({ source: "github", kind: "prs", filter: "open", page: 0, scope: "repo", open: 12 });
    expect(tk.repo.github).toBe("o/r");
    expect(tk.folders["github:o/r"]).toBe("/work/a");
    clearOpen();
    expect(getTasks().open).toBeNull();
  });

  it("changes nothing for a bad repository name", () => {
    expect(showPull("github", "not a repo", 1)).toBe(false);
    expect(getTasks().open).toBeNull();
  });
});
