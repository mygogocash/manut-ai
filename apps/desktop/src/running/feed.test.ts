import { describe, expect, it } from "vitest";
import { POLL_MS, STOP_WAIT_MS, createRunningFeed } from "./feed";
import type { RunningHost, StopAnswer } from "./host";
import { rowKey, type RunningRow } from "./model";

const row = (o: Partial<RunningRow> = {}): RunningRow => ({ kind: "pty", session: 1, folder: "/home/you/code/app", pid: 100, started: 1_000_000, argv: ["pnpm", "dev"], ports: [3000], ...o });

/** A host the test drives: the list it answers, what it was asked to stop, and how it fails. */
class FakeHost implements RunningHost {
  readonly kind = "mock" as const;
  rows: RunningRow[] | null = [];
  listCalls = 0;
  stops: unknown[] = [];
  failList = false;
  failStop = false;
  answer: StopAnswer = "stopping";
  /** what the stopped command does: by default it is gone from the next list */
  onStop: (r: { pid: number }) => void = (r) => {
    this.rows = this.rows && this.rows.filter((x) => x.pid !== r.pid);
  };
  async list() {
    this.listCalls++;
    if (this.failList) throw new Error("the shell did not answer");
    return this.rows && this.rows.map((r) => ({ ...r }));
  }
  async stop(r: { pid: number }) {
    this.stops.push(r);
    if (this.failStop) throw new Error("refused");
    this.onStop(r);
    return this.answer;
  }
}

/** A clock and a scheduler the test moves by hand, so no real time passes and nothing is faked globally. */
function clock(start = 2_000_000) {
  let at = start;
  let next = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const flush = () => new Promise<void>((r) => setImmediate(r));
  return {
    now: () => at,
    setTimer: (fn: () => void, ms: number) => {
      timers.set(++next, { at: at + ms, fn });
      return next;
    },
    clearTimer: (id: unknown) => void timers.delete(id as number),
    pending: () => timers.size,
    flush,
    async advance(ms: number) {
      const end = at + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
        if (!due) break;
        at = due[1].at;
        timers.delete(due[0]);
        due[1].fn();
        await flush();
      }
      at = end;
      await flush();
    },
  };
}

function make(host: FakeHost, opts: { visible?: () => boolean } = {}) {
  const c = clock();
  const feed = createRunningFeed(host, { now: c.now, setTimer: c.setTimer, clearTimer: c.clearTimer, visible: opts.visible ?? (() => true) });
  return { c, feed, host };
}

describe("asking what runs", () => {
  it("asks at once when the first reader starts, then every few seconds, and stops with the last", async () => {
    const { c, feed, host } = make(new FakeHost());
    const stopA = feed.start();
    await c.flush();
    expect(host.listCalls).toBe(1);
    await c.advance(POLL_MS);
    expect(host.listCalls).toBe(2);
    // a second reader shares the one poll
    const stopB = feed.start();
    await c.advance(POLL_MS);
    expect(host.listCalls).toBe(3);
    stopA();
    await c.advance(POLL_MS);
    expect(host.listCalls).toBe(4);
    stopB();
    await c.advance(POLL_MS * 3);
    expect(host.listCalls).toBe(4);
    expect(c.pending()).toBe(0);
  });

  it("keeps the list the host gave, and the same list again changes nothing a reader sees", async () => {
    const host = new FakeHost();
    host.rows = [row()];
    const { c, feed } = make(host);
    let heard = 0;
    feed.subscribe(() => heard++);
    feed.start();
    await c.flush();
    expect(feed.getState().rows).toEqual([row()]);
    expect(feed.getState().loaded).toBe(true);
    const first = feed.getState();
    const before = heard;
    await c.advance(POLL_MS * 3);
    expect(feed.getState()).toBe(first);
    expect(heard).toBe(before);
    host.rows = [row(), row({ pid: 101, started: 1_500_000 })];
    await c.advance(POLL_MS);
    expect(feed.getState().rows.map((r) => r.pid)).toEqual([100, 101]);
    expect(heard).toBe(before + 1);
  });

  it("notes when it first saw a command whose start the system would not say, and forgets it when it is gone", async () => {
    const host = new FakeHost();
    const unknown = row({ pid: 7, started: null });
    host.rows = [unknown, row()];
    const { c, feed } = make(host);
    feed.start();
    await c.flush();
    const key = rowKey(unknown);
    const seenAt = c.now();
    expect(feed.getState().seen).toEqual({ [key]: seenAt });
    await c.advance(POLL_MS * 2);
    // seen once, and kept at that time
    expect(feed.getState().seen[key]).toBe(seenAt);
    host.rows = [row()];
    await c.advance(POLL_MS);
    expect(feed.getState().seen).toEqual({});
  });

  it("says it cannot, once, when the host cannot tell what runs on this computer, and stops asking", async () => {
    const host = new FakeHost();
    host.rows = null;
    const { c, feed } = make(host);
    feed.start();
    await c.flush();
    expect(feed.getState().supported).toBe(false);
    expect(host.listCalls).toBe(1);
    await c.advance(POLL_MS * 5);
    expect(host.listCalls).toBe(1);
    expect(c.pending()).toBe(0);
  });

  it("keeps the last list when a look fails, and looks again", async () => {
    const host = new FakeHost();
    host.rows = [row()];
    const { c, feed } = make(host);
    feed.start();
    await c.flush();
    host.failList = true;
    await c.advance(POLL_MS);
    expect(feed.getState().rows).toEqual([row()]);
    expect(feed.getState().supported).toBe(true);
    host.failList = false;
    host.rows = [];
    await c.advance(POLL_MS);
    expect(feed.getState().rows).toEqual([]);
  });

  it("does not ask while the window is hidden, and asks again when it shows", async () => {
    let shown = false;
    const { c, feed, host } = make(new FakeHost(), { visible: () => shown });
    feed.start();
    await c.flush();
    expect(host.listCalls).toBe(0);
    await c.advance(POLL_MS * 3);
    expect(host.listCalls).toBe(0);
    shown = true;
    await c.advance(POLL_MS);
    expect(host.listCalls).toBe(1);
  });

  it("leaves one poll behind when the readers stop and start again while a look is under way", async () => {
    const host = new FakeHost();
    let release: () => void = () => {};
    let held = false;
    const real = host.list.bind(host);
    host.list = async () => {
      if (!held) {
        held = true;
        await new Promise<void>((r) => (release = r));
      }
      return real();
    };
    const { c, feed } = make(host);
    const stopA = feed.start();
    await c.flush();
    stopA();
    const stopB = feed.start();
    await c.flush();
    release();
    await c.flush();
    expect(c.pending()).toBe(1);
    stopB();
    expect(c.pending()).toBe(0);
  });

  it("never overlaps two looks", async () => {
    const host = new FakeHost();
    let release: () => void = () => {};
    const hold = new Promise<void>((r) => (release = r));
    host.list = async () => {
      host.listCalls++;
      await hold;
      return [];
    };
    const { c, feed } = make(host);
    feed.start();
    await c.flush();
    void feed.refresh();
    void feed.refresh();
    await c.advance(POLL_MS * 2);
    expect(host.listCalls).toBe(1);
    release();
    await c.flush();
  });
});

describe("Stop", () => {
  it("sends the shell only which command it is, marks it stopping, and looks again soon", async () => {
    const host = new FakeHost();
    const r = row({ pid: 4242, started: 1_234_567, argv: ["node", "/x/server.js", "--token=ghp_secretsecretsecret1234"] });
    host.rows = [r];
    const { c, feed } = make(host);
    feed.start();
    await c.flush();
    const looked = host.listCalls;
    const done = feed.stop(r);
    expect(feed.getState().stopping[rowKey(r)]).toBe(c.now());
    await done;
    // nothing of the command's words goes back to the shell, only its identity
    expect(host.stops).toEqual([{ kind: "pty", session: 1, pid: 4242, started: 1_234_567 }]);
    await c.advance(600);
    expect(host.listCalls).toBeGreaterThan(looked);
    expect(feed.getState().rows).toEqual([]);
    expect(feed.getState().stopping).toEqual({});
    expect(feed.getState().failed).toEqual({});
  });

  it("stops a command once when pressed twice", async () => {
    const host = new FakeHost();
    host.rows = [row()];
    const { c, feed } = make(host);
    feed.start();
    await c.flush();
    await Promise.all([feed.stop(row()), feed.stop(row())]);
    expect(host.stops).toHaveLength(1);
  });

  it("says so when the shell would not, and lets Stop be pressed again", async () => {
    const host = new FakeHost();
    host.rows = [row()];
    const { c, feed } = make(host);
    feed.start();
    await c.flush();
    host.failStop = true;
    await feed.stop(row());
    expect(feed.getState().stopping).toEqual({});
    expect(feed.getState().failed).toEqual({ [rowKey(row())]: true });
    host.failStop = false;
    await feed.stop(row());
    expect(feed.getState().failed).toEqual({});
    expect(host.stops).toHaveLength(2);
  });

  it("gives the button back, with a note, when the command is still there after a while", async () => {
    const host = new FakeHost();
    host.rows = [row()];
    host.onStop = () => {}; // it ignores the stop
    const { c, feed } = make(host);
    feed.start();
    await c.flush();
    await feed.stop(row());
    await c.advance(STOP_WAIT_MS - 1000);
    expect(feed.getState().stopping[rowKey(row())]).toBeDefined();
    await c.advance(POLL_MS + 1000);
    expect(feed.getState().stopping).toEqual({});
    expect(feed.getState().failed).toEqual({ [rowKey(row())]: true });
    expect(feed.getState().rows).toHaveLength(1);
  });

  it("is done at once when the shell says the command had ended already", async () => {
    const host = new FakeHost();
    host.rows = [row()];
    host.answer = "gone";
    host.onStop = (r) => {
      host.rows = host.rows && host.rows.filter((x) => x.pid !== r.pid);
    };
    const { c, feed } = make(host);
    feed.start();
    await c.flush();
    await feed.stop(row());
    await c.advance(600);
    expect(feed.getState().stopping).toEqual({});
    expect(feed.getState().failed).toEqual({});
  });
});
