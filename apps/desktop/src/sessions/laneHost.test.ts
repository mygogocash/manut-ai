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
    expect(await h.laneWorktree("/Users/fon/web-app", ["kit/qr", "kit/qr-2"])).toEqual({ branch: "kit/qr", base: "main", dir, worktree: dir, left: 1 });
    expect(h.sent).toEqual([{ cmd: "lane_worktree", args: { cwd: "/Users/fon/web-app", names: ["kit/qr", "kit/qr-2"] } }]);
    // an answer with no folder is no lane: the session then works in its own folder
    await expect(new Host(() => ({ branch: "kit/qr", base: "main" })).laneWorktree("/w", ["kit/qr"])).rejects.toThrow("no_folder");
  });

  it("lists and removes with the numbers the person saw", async () => {
    const h = new Host((cmd) => (cmd === "lane_list" ? [{ worktree: dir, dir, branch: "kit/qr", base: "main", made: 3, exists: true, changed: 2, ahead: null }, { nope: 1 }] : { removed: true, deleted: false, changed: null, ahead: null, error: null }));
    expect(await h.laneList("/Users/fon/web-app")).toEqual([{ worktree: dir, dir, branch: "kit/qr", base: "main", made: 3, exists: true, changed: 2, ahead: null }]);
    expect(await h.laneRemove(dir, { changed: 2, branch: true, ahead: 0 })).toMatchObject({ removed: true });
    expect(h.sent[1]).toEqual({ cmd: "lane_remove", args: { worktree: dir, ask: { changed: 2, branch: true, ahead: 0 } } });
  });
});

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
    expect(a).toEqual({ branch: "kit/qr", base: "main", dir: "/home/you/.manut/lanes/web-app/qr", worktree: "/home/you/.manut/lanes/web-app/qr", left: 2 });
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
