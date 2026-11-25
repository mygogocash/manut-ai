// Each lane's preview while the app runs (src/code/previewStore.ts), driven through a host the test stands in for and a clock it moves
// by hand: the folder read before each Start, what the shell is asked to run and with what, the lines and the end it says, Stop, the
// minute's wait for an address, a refusal, one preview per lane, and a lane whose session closes.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Need } from "./preview";
import type { PreviewEvent, PreviewHost } from "./previewHost";
import type { PreviewProject } from "./previewRun";
import { chatOfPreview, forgetPreview, openPreview, previewRecord, readPreview, resetPreviewRuns, setPreviewTestHooks, startPreview, stopPreview, type PreviewClock } from "./previewStore";

const KEY = "agent:s1";
const DIR = "/home/you/.manut/lanes/baanmali-preorder/promptpay-qr";
const PACKAGE = JSON.stringify({ scripts: { dev: "vite" } });
const SHOP: Need = { name: "PROMPTPAY_SHOP_ID", kind: "shop_id" };

type Call = { op: string; [k: string]: unknown };

/** A shell the test answers: what each folder holds, how each call goes, and every call it was asked. */
class FakeHost implements PreviewHost {
  readonly kind = "mock" as const;
  startWait = 60_000;
  calls: Call[] = [];
  project: PreviewProject = { packageJson: PACKAGE, files: ["package.json", "pnpm-lock.yaml"], envExample: "STRIPE_SECRET_KEY=sk_test_x\nPORT=3000\n" };
  readError: string | null = null;
  startError: string | null = null;
  stopAnswer: "stopping" | "gone" | Error = "stopping";
  openError: Error | null = null;
  /** Each start's events go here, and its answer waits until the test lets it go. */
  emit: ((ev: PreviewEvent) => void) | null = null;
  private release: (() => void) | null = null;
  hold = false;
  next = 0;
  async read(dir: string) {
    this.calls.push({ op: "read", dir });
    if (this.readError) throw new Error(this.readError);
    return { ...this.project, files: [...this.project.files] };
  }
  async start(dir: string, argv: string[], packageJson: string, env: [string, string][], onEvent: (ev: PreviewEvent) => void) {
    this.calls.push({ op: "start", dir, argv, packageJson, env });
    if (this.hold) await new Promise<void>((r) => (this.release = r));
    if (this.startError) throw new Error(this.startError);
    this.emit = onEvent;
    return ++this.next;
  }
  letGo() {
    this.release?.();
  }
  async stop(id: number) {
    this.calls.push({ op: "stop", id });
    if (this.stopAnswer instanceof Error) throw this.stopAnswer;
    return this.stopAnswer;
  }
  async open(url: string) {
    this.calls.push({ op: "open", url });
    if (this.openError) throw this.openError;
  }
  ops() {
    return this.calls.map((c) => c.op);
  }
}

/** A clock moved by hand, with the timers it holds. */
class Clock implements PreviewClock {
  at = 1_000;
  timers: { at: number; fn: () => void; gone: boolean }[] = [];
  now = () => this.at;
  setTimer = (fn: () => void, ms: number) => {
    const t = { at: this.at + ms, fn, gone: false };
    this.timers.push(t);
    return t;
  };
  clearTimer = (t: unknown) => {
    (t as { gone: boolean }).gone = true;
  };
  move(ms: number) {
    this.at += ms;
    for (const t of this.timers) if (!t.gone && t.at <= this.at) {
      t.gone = true;
      t.fn();
    }
  }
  live() {
    return this.timers.filter((t) => !t.gone).length;
  }
}

let host: FakeHost;
let clock: Clock;
const run = () => previewRecord(KEY).run;
const settle = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  host = new FakeHost();
  clock = new Clock();
  setPreviewTestHooks({ host, clock });
});
afterEach(() => {
  resetPreviewRuns();
  setPreviewTestHooks({ host: null, clock: null });
});

describe("reading a lane's folder", () => {
  it("chooses the command from what it holds, and says why when it could not be read", async () => {
    await readPreview(KEY, DIR);
    expect(previewRecord(KEY)).toMatchObject({ dir: DIR, reading: false, plan: { argv: ["pnpm", "run", "dev"], label: "pnpm run dev" }, readWhy: null });
    host.readError = "not_a_lane";
    await readPreview(KEY, DIR);
    expect(previewRecord(KEY)).toMatchObject({ plan: null, project: null, readWhy: "not_a_lane" });
  });
});

describe("Start", () => {
  it("reads the folder again, then asks the shell to run the chosen command with the samples and nothing else", async () => {
    await startPreview(KEY, DIR, [SHOP]);
    expect(host.ops()).toEqual(["read", "start"]);
    expect(host.calls[1]).toEqual({
      op: "start",
      dir: DIR,
      argv: ["pnpm", "run", "dev"],
      packageJson: PACKAGE,
      // Kit's change reads the shop ID, the folder's .env.example names a Stripe key: both on samples; PORT is left to the project
      env: [
        ["PROMPTPAY_SHOP_ID", "0000000000"],
        ["STRIPE_SECRET_KEY", "sample-value"],
      ],
    });
    expect(run()).toMatchObject({ phase: "starting", id: 1, label: "pnpm run dev", since: 1_000 });
    expect(chatOfPreview(1)).toBe(KEY);
    expect(chatOfPreview(2)).toBeNull();
  });

  it("is Running at the address it prints, Open sends that address, and Stop ends it as Stopped", async () => {
    await startPreview(KEY, DIR, []);
    host.emit!({ event: "lines", lines: ["> vite", "  ➜  Local:   http://localhost:5173/"] });
    expect(run()).toMatchObject({ phase: "running", url: "http://localhost:5173/" });
    expect(clock.live()).toBe(1);
    await openPreview(KEY);
    expect(host.calls.at(-1)).toEqual({ op: "open", url: "http://localhost:5173/" });
    await stopPreview(KEY);
    expect(run().phase).toBe("stopping");
    expect(host.calls.at(-1)).toEqual({ op: "stop", id: 1 });
    host.emit!({ event: "exit", code: null, stopped: true });
    expect(run()).toMatchObject({ phase: "stopped", id: null });
    // the minute's wait went with it
    expect(clock.live()).toBe(0);
    // and nothing more is taken from that run
    host.emit!({ event: "lines", lines: ["late"] });
    expect(run().lines).not.toContain("late");
  });

  it("says when it ended by itself, with its code, and a Start after that is a new run", async () => {
    await startPreview(KEY, DIR, []);
    host.emit!({ event: "lines", lines: ["Error: Cannot find module 'vite'"] });
    host.emit!({ event: "exit", code: 1, stopped: false });
    expect(run()).toMatchObject({ phase: "ended", code: 1, lines: ["Error: Cannot find module 'vite'"] });
    await startPreview(KEY, DIR, []);
    expect(run()).toMatchObject({ phase: "starting", id: 2, lines: [] });
    expect(host.ops()).toEqual(["read", "start", "read", "start"]);
  });

  it("runs at most one preview per lane: a second Start while one is live asks the shell nothing", async () => {
    await startPreview(KEY, DIR, []);
    await startPreview(KEY, DIR, []);
    expect(host.ops()).toEqual(["read", "start"]);
    // another lane has its own
    await startPreview("agent:s2", "/home/you/.manut/lanes/baanmali-preorder/stock-sync", []);
    expect(host.ops()).toEqual(["read", "start", "read", "start"]);
  });

  it("starts nothing when the folder has no command, or could not be read", async () => {
    host.project = { ...host.project, packageJson: JSON.stringify({ scripts: { build: "vite build" } }) };
    await startPreview(KEY, DIR, []);
    expect(host.ops()).toEqual(["read"]);
    expect(previewRecord(KEY).plan).toEqual({ none: "no_script" });
    expect(run().phase).toBe("idle");
    host.readError = "not_a_lane";
    await startPreview(KEY, DIR, []);
    expect(host.ops()).toEqual(["read", "read"]);
  });

  it("says Could not start with the shell's word, and reads the folder again when package.json changed under it", async () => {
    host.startError = "missing:pnpm";
    await startPreview(KEY, DIR, []);
    expect(run()).toMatchObject({ phase: "failed", why: "missing:pnpm" });
    expect(clock.live()).toBe(0);
    host.startError = "changed";
    host.project = { ...host.project, packageJson: JSON.stringify({ scripts: { start: "vite" } }) };
    await startPreview(KEY, DIR, []);
    await settle();
    expect(run()).toMatchObject({ phase: "failed", why: "changed" });
    expect(host.ops()).toEqual(["read", "start", "read", "start", "read"]);
    expect(previewRecord(KEY).plan).toEqual({ argv: ["pnpm", "run", "start"], label: "pnpm run start" });
  });

  it("stops saying it is starting after the host's wait with no address, and an address later still counts", async () => {
    await startPreview(KEY, DIR, []);
    host.emit!({ event: "lines", lines: ["Compiling…"] });
    clock.move(59_999);
    expect(run().phase).toBe("starting");
    clock.move(1);
    expect(run().phase).toBe("quiet");
    host.emit!({ event: "lines", lines: ["Local: http://localhost:3000"] });
    expect(run()).toMatchObject({ phase: "running", url: "http://localhost:3000/" });
    // a host can make the wait shorter (a test's mock)
    resetPreviewRuns();
    host.startWait = 500;
    await startPreview(KEY, DIR, []);
    clock.move(500);
    expect(run().phase).toBe("quiet");
  });
});

describe("Stop", () => {
  it("pressed before the shell answered the start, stops it as soon as it does", async () => {
    host.hold = true;
    const started = startPreview(KEY, DIR, []);
    await settle();
    expect(run()).toMatchObject({ phase: "starting", id: null });
    await stopPreview(KEY);
    expect(run().phase).toBe("stopping");
    expect(host.ops()).toEqual(["read", "start"]);
    host.letGo();
    await started;
    await settle();
    expect(host.calls.at(-1)).toEqual({ op: "stop", id: 1 });
    host.emit!({ event: "exit", code: null, stopped: true });
    expect(run().phase).toBe("stopped");
  });

  it("that the shell answers gone says Stopped, since the run's own end may never come", async () => {
    await startPreview(KEY, DIR, []);
    host.stopAnswer = "gone";
    await stopPreview(KEY);
    expect(run().phase).toBe("stopped");
  });

  it("that the shell does not answer leaves the run as it was, so Stop can be pressed again", async () => {
    await startPreview(KEY, DIR, []);
    host.emit!({ event: "lines", lines: ["Local: http://localhost:5173/"] });
    host.stopAnswer = new Error("no shell");
    await stopPreview(KEY);
    expect(run().phase).toBe("running");
  });
});

describe("Open", () => {
  it("is nothing until there is an address, and says when the browser could not be reached", async () => {
    await startPreview(KEY, DIR, []);
    await openPreview(KEY);
    expect(host.ops()).not.toContain("open");
    host.emit!({ event: "lines", lines: ["Local: http://localhost:5173/"] });
    host.openError = new Error("no browser");
    await openPreview(KEY);
    expect(previewRecord(KEY).openFailed).toBe(true);
    // once it has stopped, its old address is opened no more: nothing listens there
    host.openError = null;
    await stopPreview(KEY);
    host.emit!({ event: "exit", code: null, stopped: true });
    expect(run().url).toBe("http://localhost:5173/");
    const asked = host.ops().filter((o) => o === "open").length;
    await openPreview(KEY);
    expect(host.ops().filter((o) => o === "open").length).toBe(asked);
  });
});

describe("a lane whose session closes", () => {
  it("stops its preview and forgets it", async () => {
    await startPreview(KEY, DIR, []);
    forgetPreview(KEY);
    expect(host.calls.at(-1)).toEqual({ op: "stop", id: 1 });
    expect(run().phase).toBe("idle");
    expect(chatOfPreview(1)).toBeNull();
    expect(clock.live()).toBe(0);
  });

  it("stops a preview the shell was still starting, as soon as it answers, so none runs unseen", async () => {
    host.hold = true;
    const started = startPreview(KEY, DIR, []);
    await settle();
    forgetPreview(KEY);
    host.letGo();
    await started;
    await settle();
    expect(host.calls.at(-1)).toEqual({ op: "stop", id: 1 });
    expect(run().phase).toBe("idle");
  });

  it("asks nothing when it had no preview", () => {
    forgetPreview("agent:none");
    expect(host.calls).toEqual([]);
  });
});
