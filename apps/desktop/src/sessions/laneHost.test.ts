// A lane's own working folder through the two hosts (src-tauri/src/lane.rs): what TauriHost sends the shell and how it reads
// the answers, and the browser stand-in (MockHost), which keeps the shell's rules so a browser walk sees what the app does: the
// developer's folder never moves, each lane has a folder of its own, and a folder with changes goes only with the person's yes.
import { describe, expect, it } from "vitest";
import { MockHost, TauriHost, type MockCall } from "./host";
import { MOCK_MOVED, MOCK_MOVED_ROOT } from "../code/mockMoved";

class Host extends TauriHost {
  sent: { cmd: string; args: unknown }[] = [];
  constructor(private answer: (cmd: string) => unknown) {
    super();
  }
  protected override async core() {
    const invoke = async (cmd: string, args: unknown) => {
      this.sent.push({ cmd, args });
      return this.answer(cmd);
    };
    return { invoke, Channel: class {} } as unknown as Awaited<ReturnType<TauriHost["core"]>>;
  }
}

describe("TauriHost: a lane's folder", () => {
  const dir = "/Users/fon/.manut/lanes/web-app/qr";

  it("asks the shell for a folder of its own with the names to try, and believes only a folder it can use", async () => {
    const h = new Host(() => ({ branch: "kit/qr", base: "main", dir, worktree: dir, left: 1 }));
    expect(await h.laneWorktree("/Users/fon/web-app", ["kit/qr", "kit/qr-2"])).toEqual({ branch: "kit/qr", base: "main", dir, worktree: dir, left: 1, from: "", local: "", config: 0, stayed: 0 });
    expect(h.sent).toEqual([{ cmd: "lane_worktree", args: { cwd: "/Users/fon/web-app", names: ["kit/qr", "kit/qr-2"], start: null } }]);
    // Settings › Worktrees go with the call, and the shell says where the lane started
    const r = new Host(() => ({ branch: "team/ana/qr", base: "main", dir, worktree: dir, left: 0, from: "origin/main", local: "" }));
    expect(await r.laneWorktree("/w", ["team/ana/qr"], { root: "/Users/fon/lanes", remote: true })).toMatchObject({ branch: "team/ana/qr", from: "origin/main" });
    expect(r.sent[0].args).toEqual({ cwd: "/w", names: ["team/ana/qr"], start: { root: "/Users/fon/lanes", remote: true } });
    // an answer with no folder is no lane: the session then works in its own folder
    await expect(new Host(() => ({ branch: "kit/qr", base: "main" })).laneWorktree("/w", ["kit/qr"])).rejects.toThrow("no_folder");
  });

  it("says how many of the project's own agent settings came along and how many stayed", async () => {
    const h = new Host(() => ({ branch: "kit/qr", base: "main", dir, worktree: dir, left: 0, config: 4, stayed: 1 }));
    expect(await h.laneWorktree("/w", ["kit/qr"])).toMatchObject({ config: 4, stayed: 1 });
    const { h: m } = new MockSetup().make({ __manutConfig: { "/w": 3 }, __manutStayed: { "/w": 2 }, __manutBranches: { "/w": "main" } });
    expect(await m.laneWorktree("/w", ["kit/qr"])).toMatchObject({ config: 3, stayed: 2 });
  });

  it("asks the shell for the MCP servers and skills by name, with the project when one is chosen", async () => {
    const answer = [{ agent: "claude", found: true, servers: [{ name: "github", from: "home", state: "on", command: "gh-mcp", env: { T: "sk-SECRET" } }], skills: [] }];
    const h = new Host(() => answer);
    expect(await h.agentConfig("/Users/fon/web-app")).toEqual([{ agent: "claude", found: true, servers: [{ name: "github", from: "home", state: "on" }], skills: [] }]);
    expect(await h.agentConfig()).toHaveLength(1);
    expect(h.sent).toEqual([
      { cmd: "agent_config_list", args: { cwd: "/Users/fon/web-app" } },
      { cmd: "agent_config_list", args: { cwd: null } },
    ]);
    // a browser cannot read this computer's files
    expect(await new MockSetup().make({}).h.agentConfig()).toBeNull();
  });

  it("lists and removes with the numbers the person saw", async () => {
    const h = new Host((cmd) => (cmd === "lane_list" ? [{ worktree: dir, dir, branch: "kit/qr", base: "main", made: 3, exists: true, changed: 2, ahead: null, unpushed: 1 }, { nope: 1 }] : { removed: true, deleted: false, changed: null, ahead: null, error: null }));
    expect(await h.laneList("/Users/fon/web-app")).toEqual([{ worktree: dir, dir, branch: "kit/qr", base: "main", made: 3, exists: true, changed: 2, ahead: null, unpushed: 1 }]);
    expect(await h.laneRemove(dir, { changed: 2, branch: true, ahead: 0 })).toMatchObject({ removed: true });
    expect(h.sent[1]).toEqual({ cmd: "lane_remove", args: { worktree: dir, ask: { changed: 2, branch: true, ahead: 0 } } });
  });
});

/** A browser stand-in with the given globals. */
class MockSetup {
  make(g: Record<string, unknown>) {
    return { h: new MockHost({ __manutSessionCalls: [] as MockCall[], ...g } as never) };
  }
}

describe("MockHost: a lane's folder, as the shell makes it", () => {
  const DEV = "/home/you/code/web-app";
  const host = (g: Record<string, unknown> = {}) => {
    const globals = { __manutBranches: { [DEV]: "main" }, __manutMockTaken: [] as string[], __manutSessionCalls: [] as MockCall[], ...g };
    return { h: new MockHost(globals as never), g: globals as typeof globals & Record<string, unknown> };
  };

  it("makes each lane a folder of its own from the developer's branch, which never moves", async () => {
    const { h, g } = host({ __manutLeft: { [DEV]: 2 } });
    const a = await h.laneWorktree(DEV, ["kit/qr"]);
    const b = await h.laneWorktree(DEV, ["kit/qr", "kit/qr-2"]);
    expect(a).toEqual({ branch: "kit/qr", base: "main", dir: "/home/you/.manut/lanes/web-app/qr", worktree: "/home/you/.manut/lanes/web-app/qr", left: 2, from: "", local: "", config: 0, stayed: 0 });
    expect(b).toMatchObject({ branch: "kit/qr-2", base: "main", dir: "/home/you/.manut/lanes/web-app/qr-2" });
    expect(await h.branch(DEV)).toBe("main");
    expect(await h.branch(a.dir)).toBe("kit/qr");
    expect(g.__manutSessionCalls.filter((c) => c.op === "lane.worktree").map((c) => c.path)).toEqual([a.dir, b.dir]);
    await expect(h.laneWorktree("/home/you/plain", ["kit/x"])).rejects.toThrow("not_a_repository");
  });

  it("lists a repository's lanes from the developer's folder or a lane's, and keeps one with changes until the yes", async () => {
    const { h, g } = host();
    const a = await h.laneWorktree(DEV, ["kit/qr"]);
    g.__manutLaneChanged = { [a.worktree]: 3 };
    g.__manutLaneAhead = { [a.worktree]: 1 };
    expect((await h.laneList(DEV)).map((k) => [k.branch, k.changed, k.ahead])).toEqual([["kit/qr", 3, 1]]);
    expect(await h.laneList(a.dir)).toHaveLength(1);
    expect(await h.laneRemove(a.worktree, { changed: 0, branch: false, ahead: null })).toEqual({ removed: false, deleted: false, changed: 3, ahead: null, error: null });
    expect(await h.laneRemove(a.worktree, { changed: 3, branch: true, ahead: 0 })).toEqual({ removed: false, deleted: false, changed: 3, ahead: 1, error: null });
    expect(await h.laneRemove(a.worktree, { changed: 3, branch: true, ahead: 1 })).toMatchObject({ removed: true, deleted: true });
    expect(await h.laneList(DEV)).toEqual([]);
    await expect(h.laneRemove(a.worktree, { changed: 0, branch: false, ahead: null })).rejects.toThrow("not_a_lane");
    await expect(h.laneRemove(DEV, { changed: 9, branch: true, ahead: 9 })).rejects.toThrow("not_a_lane");
  });

  it("reads the main branch moving in a lane's folder as the developer's repository, for the lane's own branch", async () => {
    const { h } = host({ __manutBranches: { [MOCK_MOVED_ROOT]: "main" } });
    const a = await h.laneWorktree(MOCK_MOVED_ROOT, ["kit/thai-date"]);
    const view = await h.mainMoved(a.dir, { base: "main" });
    expect(view).toMatchObject({ branch: "kit/thai-date", base: "main", ours: MOCK_MOVED.ours, theirs: MOCK_MOVED.theirs });
  });
});

describe("Settings › Worktrees through the hosts", () => {
  it("TauriHost sends the folder to check, the folder to release and the project to clean up, and reads only what it can", async () => {
    const h = new Host((cmd) =>
      cmd === "lane_root_check"
        ? "/Users/fon/lanes"
        : cmd === "lane_release"
          ? { removed: false, kept: "unpushed", changed: 0, unpushed: 2 }
          : { removed: ["kit/a", "main", 3], kept: [{ branch: "kit/b", why: "open" }, { branch: "main", why: "open" }, { branch: "kit/c" }], cannot: null },
    );
    expect(await h.laneRootCheck("/Users/fon/lanes")).toBe("/Users/fon/lanes");
    expect(await h.laneRelease("/w/x")).toEqual({ removed: false, kept: "unpushed", changed: 0, unpushed: 2 });
    expect(await h.laneCleanMerged("/Users/fon/web-app", ["/w/held"])).toEqual({ removed: ["kit/a"], kept: [{ branch: "kit/b", why: "open" }], cannot: null });
    expect(h.sent.map((s) => s.cmd)).toEqual(["lane_root_check", "lane_release", "lane_clean_merged"]);
    expect(h.sent[2].args).toEqual({ cwd: "/Users/fon/web-app", held: ["/w/held"] });
  });

  const DEV = "/home/you/code/web-app";
  const mock = (g: Record<string, unknown> = {}) => {
    const globals = { __manutBranches: { [DEV]: "main" }, __manutMockTaken: [] as string[], __manutSessionCalls: [] as MockCall[], ...g };
    return { h: new MockHost(globals as never), g: globals as typeof globals & Record<string, unknown> };
  };

  it("MockHost makes a lane under the chosen folder and says where it started", async () => {
    const { h } = mock({ __manutRemoteFrom: { [DEV]: "origin/main" } });
    const made = await h.laneWorktree(DEV, ["team/ana/qr"], { root: "/home/you/lanes/", remote: true });
    expect(made).toMatchObject({ worktree: "/home/you/lanes/web-app/qr", from: "origin/main", local: "" });
    expect(await mock().h.laneWorktree(DEV, ["kit/x"], { root: "", remote: true })).toMatchObject({ from: "", local: "no_remote" });
    expect(await mock().h.laneWorktree(DEV, ["kit/x"], { root: "", remote: false })).toMatchObject({ from: "", local: "" });
  });

  it("MockHost refuses a folder for lanes inside a checkout, too broad or not absolute, as the shell does", async () => {
    const { h } = mock();
    await expect(h.laneRootCheck(`${DEV}/lanes`)).rejects.toThrow("root_in_checkout");
    await expect(h.laneRootCheck("/home/you")).rejects.toThrow("root_too_broad");
    await expect(h.laneRootCheck("relative")).rejects.toThrow("bad_root");
    expect(await h.laneRootCheck("/home/you/lanes")).toBe("/home/you/lanes");
  });

  it("MockHost releases a folder only when nothing in it is changed or unpushed", async () => {
    const { h, g } = mock();
    const a = await h.laneWorktree(DEV, ["kit/a"]);
    const b = await h.laneWorktree(DEV, ["kit/b"]);
    const c = await h.laneWorktree(DEV, ["kit/c"]);
    g.__manutLaneChanged = { [a.worktree]: 2 };
    g.__manutLaneUnpushed = { [b.worktree]: 1 };
    expect(await h.laneRelease(a.worktree)).toMatchObject({ removed: false, kept: "changes", changed: 2 });
    expect(await h.laneRelease(b.worktree)).toMatchObject({ removed: false, kept: "unpushed", unpushed: 1 });
    expect(await h.laneRelease(c.worktree)).toMatchObject({ removed: true });
    expect((await h.laneList(DEV)).map((l) => l.branch).sort()).toEqual(["kit/a", "kit/b"]);
    await expect(h.laneRelease("/nowhere")).rejects.toThrow("not_a_lane");
  });
});

