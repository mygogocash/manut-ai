// Where a lane's preview runs (src/code/previewHost.ts): what the desktop asks the shell (the shell's own bridge stood in by a
// function), what it reads of the shell's events, and the browser's fake run, which also lists itself with what keeps running.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MockRunningHost } from "../running/host";
import { TauriHost } from "../sessions/host";
import { MOCK_PROJECT, MockPreviewHost, readEvent, TauriPreviewHost, type MockPreviewCall, type PreviewEvent } from "./previewHost";
import { START_WAIT_MS } from "./previewRun";

/** The shell's bridge stood in by a function, recording what the page invoked. */
class Bridged extends TauriPreviewHost {
  calls: { cmd: string; args?: Record<string, unknown> }[] = [];
  constructor(private answer: (cmd: string, args?: Record<string, unknown>) => unknown) {
    super();
  }
  protected override async core() {
    class Channel<T> {
      onmessage: (m: T) => void = () => {};
    }
    const invoke = async (cmd: string, args?: Record<string, unknown>) => {
      this.calls.push({ cmd, args });
      const a = this.answer(cmd, args);
      if (a instanceof Error) throw a;
      return a as never;
    };
    return { Channel: Channel as never, invoke: invoke as never };
  }
}

describe("the shell", () => {
  it("is asked for the lane's folder by its path, and its answer is read whole", async () => {
    const h = new Bridged(() => ({ packageJson: "{}", files: ["package.json"], envExample: null }));
    expect(await h.read("/home/you/.manut/lanes/a/b")).toEqual({ packageJson: "{}", files: ["package.json"], envExample: null });
    expect(h.calls).toEqual([{ cmd: "preview_read", args: { cwd: "/home/you/.manut/lanes/a/b" } }]);
    await expect(new Bridged(() => new Error("not_a_lane")).read("/x")).rejects.toThrow("not_a_lane");
    // a shell older than the preview: it cannot run one
    await expect(new Bridged(() => new Error("command preview_read not found")).read("/x")).rejects.toThrow("unsupported");
    await expect(new Bridged(() => "nonsense").read("/x")).rejects.toThrow("unsupported");
  });

  it("is told only the command, the package.json it was chosen from and the secrets, and its events reach the page", async () => {
    let channel: { onmessage: (m: unknown) => void } | null = null;
    const h = new Bridged((cmd, args) => {
      if (cmd === "preview_start") channel = args?.onEvent as never;
      return 4;
    });
    const got: PreviewEvent[] = [];
    const id = await h.start("/lanes/a/b", ["pnpm", "run", "dev"], '{"scripts":{"dev":"vite"}}', [["PROMPTPAY_SHOP_ID", "0000000000"]], (ev) => got.push(ev));
    expect(id).toBe(4);
    const { onEvent: _ch, ...sent } = h.calls[0].args!;
    expect(h.calls[0].cmd).toBe("preview_start");
    expect(sent).toEqual({ cwd: "/lanes/a/b", argv: ["pnpm", "run", "dev"], package: '{"scripts":{"dev":"vite"}}', env: [["PROMPTPAY_SHOP_ID", "0000000000"]] });
    channel!.onmessage({ event: "lines", lines: ["ready", 3] });
    channel!.onmessage({ event: "nonsense" });
    channel!.onmessage({ event: "exit", code: 1, stopped: false });
    expect(got).toEqual([
      { event: "lines", lines: ["ready"] },
      { event: "exit", code: 1, stopped: false },
    ]);
    await expect(new Bridged(() => new Error("missing:pnpm")).start("/x", [], "", [], () => {})).rejects.toThrow("missing:pnpm");
  });

  it("stops a preview by its id, and opens an address through its own command", async () => {
    const h = new Bridged((cmd) => (cmd === "preview_stop" ? "gone" : null));
    expect(await h.stop(4)).toBe("gone");
    await h.open("http://localhost:5173/");
    expect(h.calls).toEqual([
      { cmd: "preview_stop", args: { id: 4 } },
      { cmd: "preview_open", args: { url: "http://localhost:5173/" } },
    ]);
    expect(await new Bridged(() => "stopping").stop(4)).toBe("stopping");
    expect(new Bridged(() => null).startWait).toBe(START_WAIT_MS);
  });

  it("reads an end with no code as a signal's, and anything that is not an event as nothing", () => {
    expect(readEvent({ event: "exit", code: null, stopped: true })).toEqual({ event: "exit", code: null, stopped: true });
    expect(readEvent({ event: "exit", code: 1.5 })).toEqual({ event: "exit", code: null, stopped: false });
    for (const bad of [null, "lines", {}, { event: "lines", lines: "x" }, { event: "start" }]) expect(readEvent(bad), JSON.stringify(bad)).toBeNull();
  });
});

describe("the browser's fake preview", () => {
  type G = { __manutPreviewCalls?: MockPreviewCall[] };
  let g: G;
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    g = {};
  });
  afterEach(() => vi.useRealTimers());

  it("holds the canvas's project unless a test says what a folder holds, and records each call", async () => {
    const h = new MockPreviewHost(g);
    expect(await h.read("/lanes/a/b")).toEqual(MOCK_PROJECT);
    h.control.projects["/lanes/a/c"] = { packageJson: null, files: [], envExample: null };
    expect((await h.read("/lanes/a/c")).packageJson).toBeNull();
    h.control.readError = "not_a_lane";
    await expect(h.read("/lanes/a/b")).rejects.toThrow("not_a_lane");
    expect(g.__manutPreviewCalls?.map((c) => c.op)).toEqual(["read", "read", "read"]);
  });

  it("serves: prints a dev server's lines, then its address, and Stop ends it as stopped", async () => {
    const h = new MockPreviewHost(g);
    const got: PreviewEvent[] = [];
    const id = await h.start("/lanes/a/b", ["pnpm", "run", "dev"], "{}", [["PROMPTPAY_SHOP_ID", "0000000000"]], (ev) => got.push(ev));
    await vi.advanceTimersByTimeAsync(h.control.delay);
    const lines = got.flatMap((e) => (e.event === "lines" ? e.lines : []));
    expect(lines.join("\n")).toContain("http://localhost:");
    expect(g.__manutPreviewCalls?.[0]).toEqual({ op: "start", dir: "/lanes/a/b", argv: ["pnpm", "run", "dev"], env: [["PROMPTPAY_SHOP_ID", "0000000000"]], id });
    // one per lane, as the shell has it
    await expect(h.start("/lanes/a/b", ["pnpm", "run", "dev"], "{}", [], () => {})).rejects.toThrow("running");
    expect(await h.stop(id)).toBe("stopping");
    await vi.advanceTimersByTimeAsync(200);
    expect(got.at(-1)).toEqual({ event: "exit", code: null, stopped: true });
    expect(await h.stop(id)).toBe("gone");
  });

  it("crashes when told: an error with a key in it, and an end with exit 1 by itself", async () => {
    const h = new MockPreviewHost(g);
    h.control.mode = "crash";
    const got: PreviewEvent[] = [];
    await h.start("/lanes/a/b", ["npm", "run", "start"], "{}", [], (ev) => got.push(ev));
    await vi.advanceTimersByTimeAsync(h.control.delay);
    expect(got.flatMap((e) => (e.event === "lines" ? e.lines : [])).join("\n")).toContain("sk-FAKE");
    expect(got.at(-1)).toEqual({ event: "exit", code: 1, stopped: false });
  });

  it("refuses when told, with the shell's word", async () => {
    const h = new MockPreviewHost(g);
    h.control.mode = "refuse:missing:pnpm";
    await expect(h.start("/lanes/a/b", ["pnpm", "run", "dev"], "{}", [], () => {})).rejects.toThrow("missing:pnpm");
  });
});

describe("the fake preview with what keeps running", () => {
  it("lists itself as a preview once it serves, leaves the list when it ends, and its row's Stop stops it", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    try {
      // the page's own mock of what keeps running, as getRunningHost makes it in a plain browser
      const running = (await import("../running/host")).getRunningHost();
      expect(running).toBeInstanceOf(MockRunningHost);
      const list = (running as MockRunningHost).control;
      const h = new MockPreviewHost({});
      const got: PreviewEvent[] = [];
      const id = await h.start("/lanes/a/b", ["pnpm", "run", "dev"], "{}", [], (ev) => got.push(ev));
      expect(list.rows).toEqual([]);
      await vi.advanceTimersByTimeAsync(h.control.delay);
      expect(list.rows).toHaveLength(1);
      expect(list.rows[0]).toMatchObject({ kind: "preview", session: id, folder: "/lanes/a/b", ports: [5173] });
      // as the system holds a pnpm run, which the row shows as `pnpm run dev` (running/model.ts)
      expect(list.rows[0].argv).toEqual(["node", "/usr/local/lib/node_modules/pnpm/bin/pnpm.cjs", "run", "dev"]);
      const row = list.rows[0];
      expect(await running.stop({ kind: "preview", session: row.session, pid: row.pid, started: row.started })).toBe("stopping");
      await vi.advanceTimersByTimeAsync(200);
      expect(got.at(-1)).toEqual({ event: "exit", code: null, stopped: true });
      expect(list.rows).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("a page that loads again", () => {
  /** The sessions' host, whose reset the page runs as it loads, over a stand-in shell that refuses the commands it is told to. */
  class Reset extends TauriHost {
    sent: string[] = [];
    constructor(private refuse: string[] = []) {
      super();
    }
    protected override async core() {
      const invoke = async (cmd: string) => {
        this.sent.push(cmd);
        if (this.refuse.includes(cmd)) throw new Error(`command ${cmd} not found`);
        return null;
      };
      return { invoke, Channel: class {} } as unknown as Awaited<ReturnType<TauriHost["core"]>>;
    }
  }

  it("stops every preview with the terminals and chats, and a shell older than the preview stops those all the same", async () => {
    const h = new Reset();
    await h.reset();
    expect([...h.sent].sort()).toEqual(["chat_close_all", "preview_close_all", "session_close_all"]);
    const old = new Reset(["preview_close_all"]);
    await expect(old.reset()).resolves.toBeUndefined();
    expect([...old.sent].sort()).toEqual(["chat_close_all", "preview_close_all", "session_close_all"]);
  });
});
