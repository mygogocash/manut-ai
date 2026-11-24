// The page's side of the shell's snapshots (turnFiles.ts): the commands and their arguments as the shell takes them
// (src-tauri/src/turn_files.rs), and the browser stand-in's rules, which are the shell's.
import { describe, expect, it } from "vitest";
import { MockTurnFiles, tauriTurnFiles, type MockTurnGlobals } from "./turnFiles";
import { TauriHost } from "./host";

describe("the shell's commands", () => {
  it("go by name, with only the session, the folder, the turn, the files kept and the answer", async () => {
    const sent: [string, unknown][] = [];
    const host = tauriTurnFiles(async () => async <T>(cmd: string, args?: Record<string, unknown>) => {
      sent.push([cmd, args]);
      return undefined as T;
    });
    await host.take("s1", "/w/shop", "local-s1");
    await host.end("s1");
    await host.preview("s1", "local-s1");
    await host.restore("s1", "local-s1", ["README.md"]);
    await host.settle("s1", "local-s1", false);
    await host.backPreview("s1", "local-s1");
    await host.bringBack("s1", "local-s1", ["README.md"]);
    await host.forget("s1");
    await host.prune(["s1", "s2"]);
    expect(sent).toEqual([
      ["turn_files_take", { session: "s1", cwd: "/w/shop", turn: "local-s1" }],
      ["turn_files_end", { session: "s1" }],
      ["turn_files_preview", { session: "s1", turn: "local-s1" }],
      ["turn_files_restore", { session: "s1", turn: "local-s1", keep: ["README.md"] }],
      ["turn_files_settle", { session: "s1", turn: "local-s1", ok: false }],
      ["turn_files_back_preview", { session: "s1", turn: "local-s1" }],
      ["turn_files_bring_back", { session: "s1", turn: "local-s1", overwrite: ["README.md"] }],
      ["turn_files_forget", { session: "s1" }],
      ["turn_files_prune", { keep: ["s1", "s2"] }],
    ]);
  });

  it("go through the desktop host's own bridge", async () => {
    const sent: string[] = [];
    class Host extends TauriHost {
      protected override async core() {
        const invoke = async (cmd: string) => {
          sent.push(cmd);
          return { n: 1, files: 2, left: 0 };
        };
        return { invoke, Channel: class {} } as unknown as Awaited<ReturnType<TauriHost["core"]>>;
      }
    }
    expect(await new Host().turnFiles.take("s1", "/w/shop", "local-s1")).toEqual({ n: 1, files: 2, left: 0 });
    expect(sent).toEqual(["turn_files_take"]);
  });
});

describe("the browser stand-in", () => {
  it("keeps a pretend folder's files at each turn and puts them back as the shell does", async () => {
    const g: MockTurnGlobals = {};
    const t = new MockTurnFiles(g);
    expect(await t.take("s1", "/w/shop", "local-s1")).toEqual({ n: 1, files: 2, left: 0 });
    // the stand-in agent's turn writes a note
    await t.end("s1");
    expect(Object.keys(g.__manutMockFolders!["/w/shop"])).toContain("notes/turn-1.md");
    // the person, by hand, after the turn
    g.__manutMockFolders!["/w/shop"]["README.md"] = "# changed by hand\n";
    const p = await t.preview("s1", "local-s1");
    expect(p.back).toEqual([
      { path: "README.md", change: "changed" },
      { path: "notes/turn-1.md", change: "gone" },
    ]);
    expect(p.hand).toEqual(["README.md"]);
    expect(await t.restore("s1", "local-s1", ["README.md"])).toEqual({ changed: 1, kept: 1, tooBig: 0 });
    expect(g.__manutMockFolders!["/w/shop"]["notes/turn-1.md"]).toBeUndefined();
    expect(g.__manutMockFolders!["/w/shop"]["README.md"]).toBe("# changed by hand\n");
    // the chat did not go back: the files are as they were, and nothing is kept to bring back
    expect(await t.settle("s1", "local-s1", false)).toEqual({ back: false });
    expect(g.__manutMockFolders!["/w/shop"]["notes/turn-1.md"]).toBe("What turn 1 did.\n");
    await expect(t.backPreview("s1", "local-s1")).rejects.toThrow("why:no_snapshot");
    // it did: that turn is gone, and the files as they are are where the next turn starts
    await t.restore("s1", "local-s1", []);
    expect(await t.settle("s1", "local-s1", true)).toEqual({ back: true });
    await expect(t.preview("s1", "local-s1")).rejects.toThrow("why:no_snapshot");
    await t.take("s1", "/w/shop", "local-s2");
    expect((await t.preview("s1", "local-s2")).hand).toEqual([]);
    await t.prune([]);
    await expect(t.preview("s1", "local-s2")).rejects.toThrow("why:no_snapshot");
  });

  it("keeps the files from before a rewind that went through, and brings them back as the shell does", async () => {
    const g: MockTurnGlobals = {};
    const t = new MockTurnFiles(g);
    const folder = () => g.__manutMockFolders!["/w/shop"];
    await t.take("s1", "/w/shop", "local-s1");
    await t.end("s1");
    await t.restore("s1", "local-s1", []);
    // not before the agent has answered
    await expect(t.backPreview("s1", "local-s1")).rejects.toThrow("why:no_snapshot");
    await t.settle("s1", "local-s1", true);
    expect(folder()["notes/turn-1.md"]).toBeUndefined();
    // the person, by hand, after the rewind: one file the turn had also changed, and a new one
    folder()["README.md"] = "# changed by hand\n";
    folder()["mine.txt"] = "mine\n";
    const p = await t.backPreview("s1", "local-s1");
    expect(p.back).toEqual([
      { path: "README.md", change: "changed" },
      { path: "mine.txt", change: "gone" },
      { path: "notes/turn-1.md", change: "back" },
    ]);
    expect(p.hand).toEqual(["README.md", "mine.txt"]);
    // another turn's rewind has nothing kept
    await expect(t.backPreview("s1", "local-s2")).rejects.toThrow("why:no_snapshot");
    // ticked, as the panel offers them (nothing named to put back over): only the turn's note comes back
    expect(await t.bringBack("s1", "local-s1", [])).toEqual({ changed: 1, kept: 2, tooBig: 0 });
    expect(folder()["notes/turn-1.md"]).toBe("What turn 1 did.\n");
    expect(folder()["README.md"]).toBe("# changed by hand\n");
    expect(folder()["mine.txt"]).toBe("mine\n");
    // once is all, and the next turn starts from the files as they are: what came back is not changed by hand
    await expect(t.bringBack("s1", "local-s1", [])).rejects.toThrow("why:no_snapshot");
    await t.take("s1", "/w/shop", "local-s2");
    expect((await t.preview("s1", "local-s2")).hand).toEqual([]);
  });

  it("keeps them only until the next turn starts", async () => {
    const g: MockTurnGlobals = {};
    const t = new MockTurnFiles(g);
    await t.take("s1", "/w/shop", "local-s1");
    await t.end("s1");
    await t.restore("s1", "local-s1", []);
    await t.settle("s1", "local-s1", true);
    expect((await t.backPreview("s1", "local-s1")).back).toHaveLength(1);
    await t.take("s1", "/w/shop", "local-s2");
    await expect(t.backPreview("s1", "local-s1")).rejects.toThrow("why:no_snapshot");
    await expect(t.bringBack("s1", "local-s1", [])).rejects.toThrow("why:no_snapshot");
  });
});
