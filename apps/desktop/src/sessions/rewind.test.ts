// Rewind to before a turn (rewind.ts): which turns can be rewound, whether a turn sent something out, the words, and
// the turn book's order of calls against a stand-in for the shell. The store's `rewound` with a message's id is
// checked here too, with the reducer itself.
import { afterEach, describe, expect, it } from "vitest";
import { KEPT_TURNS, rewindable, RewindError, rewoundNote, TurnBook, turnTitle, wentLive, whyOf, whyText, type TurnMark } from "./rewind";
import type { TurnFilesHost, TurnPreview } from "./turnFiles";
import { initialState, reduce, type Action, type AppState, type TimelineItem } from "../state/store";
import type { BridgeEvent } from "../lib/protocol";
import { setLang } from "../i18n";

afterEach(() => setLang("en"));

const user = (id: string, text: string): TimelineItem => ({ kind: "user", id, ts: 1, text });
const bot = (id: string, text: string): TimelineItem => ({ kind: "assistant", id, ts: 1, text });
const steps = (id: string, ...list: { name: string; detail: string; ok?: boolean }[]): TimelineItem => ({
  kind: "activity",
  id,
  ts: 1,
  turn: { id, startedAt: 1, status: "", skills: [], streaming: "", steps: list.map((s, i) => ({ id: `${id}-${i}`, startedAt: 1, ...s })) },
});

const where = { cwd: "/w/shop", root: "/w/shop", branch: "kit/promptpay-qr" };

describe("the turns a chat can rewind", () => {
  it("are the messages whose files were kept, newest first, named by their words", () => {
    const items = [user("local-s1", "Fix stock sync with Shopee"), bot("m1", "Done"), user("local-s2", "PromptPay QR at checkout"), user("local-s3", "Thai date format"), user("local-s4", "no snapshot")];
    const marks: TurnMark[] = [
      { id: "local-s1", n: 1 },
      { id: "local-s2", n: 2 },
      { id: "local-s3", n: 3 },
      { id: "local-s9", n: 9 },
    ];
    expect(rewindable(items, marks)).toEqual([
      { id: "local-s3", title: "Thai date format" },
      { id: "local-s2", title: "PromptPay QR at checkout" },
      { id: "local-s1", title: "Fix stock sync with Shopee" },
    ]);
    expect(rewindable(items, [])).toEqual([]);
  });

  it("are named by the message's first words, without code or links, cut short", () => {
    expect(turnTitle("Add a PromptPay QR to the checkout.\nAnd test it.")).toBe("Add a PromptPay QR to the checkout");
    // a leading /command is not a name; a message that is only one keeps it
    expect(turnTitle("/kit edit")).toBe("edit");
    expect(turnTitle("/compact")).toBe("/compact");
    expect(turnTitle("x".repeat(100)).length).toBeLessThanOrEqual(60);
  });
});

describe("a turn that sent something out", () => {
  it("is one with a push, a publish or a deploy since it began, read as Kit's dial reads a command", () => {
    const items = [user("local-s1", "go"), steps("t1", { name: "terminal", detail: "pnpm test", ok: true }), user("local-s2", "ship"), steps("t2", { name: "terminal", detail: "git push origin kit/promptpay-qr", ok: true })];
    expect(wentLive(items, "local-s1", where)).toBe(true);
    expect(wentLive(items, "local-s2", where)).toBe(true);
    const tests = [user("local-s1", "go"), steps("t1", { name: "terminal", detail: "pnpm test", ok: true }, { name: "patch", detail: "src/a.ts +1" })];
    expect(wentLive(tests, "local-s1", where)).toBe(false);
    for (const line of ["wrangler deploy", "npm publish", "gh pr merge 12"]) {
      expect(wentLive([user("u", "x"), steps("t", { name: "terminal", detail: line, ok: true })], "u", where), line).toBe(true);
    }
  });

  it("is not one whose push failed or was refused, nor one whose push came before it", () => {
    expect(wentLive([user("u", "x"), steps("t", { name: "terminal", detail: "git push", ok: false })], "u", where)).toBe(false);
    expect(wentLive([steps("t", { name: "terminal", detail: "git push", ok: true }), user("u", "x")], "u", where)).toBe(false);
    expect(wentLive([user("u", "x")], "gone", where)).toBe(false);
  });

  it("counts a subagent's push too", () => {
    const item = steps("t");
    if (item.kind !== "activity") throw new Error("not an activity");
    item.turn.fanouts = [{ key: "f", count: 1, startedAt: 1, updatedAt: 1, subs: [{ id: "s", index: 0, goal: "", state: "done", startedAt: 1, steps: [{ tool: "terminal", text: "git push origin main" }] }] }];
    expect(wentLive([user("u", "x"), item], "u", where)).toBe(true);
  });
});

describe("the words", () => {
  it("name the reasons the page knows, and pass any other line through", () => {
    expect(whyOf(new Error("why:too_many"))).toBe("too_many");
    expect(whyOf(new Error("git ls-files: fatal"))).toBeNull();
    expect(whyText(new Error("why:too_big"))).toMatch(/too big/);
    expect(whyText(new Error("why:no_snapshot"))).toBe("The files of that turn are no longer kept.");
    expect(whyText(new Error("Not taken back: busy"))).toBe("Not taken back: busy");
  });

  it("say what a rewind put back, as the canvas's Reverted state does", () => {
    expect(rewoundNote("Thai date format", 3)).toBe("Rewound to before “Thai date format”. 3 files are back as they were.");
    expect(rewoundNote("Thai date format", 1)).toBe("Rewound to before “Thai date format”. 1 file is back as it was.");
    expect(rewoundNote("Thai date format", 0)).toBe("Rewound to before “Thai date format”. No file had changed.");
    setLang("ko");
    expect(rewoundNote("태국 날짜", 2)).toBe("“태국 날짜” 이전으로 되감았어요. 파일 2개가 원래대로 돌아갔어요.");
  });
});

/** A stand-in for the shell that records each call, in order, and lets a test hold a call open. */
function fakeHost(over: Partial<TurnFilesHost> = {}) {
  const calls: string[] = [];
  const preview: TurnPreview = { back: [{ path: "a.txt", change: "changed" }], hand: [], tooBig: 0, headMoved: false };
  const host: TurnFilesHost = {
    take: async (s, cwd, turn) => {
      calls.push(`take ${s} ${cwd} ${turn}`);
      return { n: calls.length, files: 1, left: 0 };
    },
    end: async (s) => void calls.push(`end ${s}`),
    preview: async (s, turn) => {
      calls.push(`preview ${s} ${turn}`);
      return preview;
    },
    restore: async (s, turn, keep) => {
      calls.push(`restore ${s} ${turn} [${keep.join(",")}]`);
      return { changed: 1, kept: keep.length, tooBig: 0 };
    },
    settle: async (s, turn, ok) => void calls.push(`settle ${s} ${turn} ${ok}`),
    forget: async (s) => void calls.push(`forget ${s}`),
    prune: async (keep) => void calls.push(`prune [${keep.join(",")}]`),
    ...over,
  };
  return { host, calls };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("the turn book", () => {
  it("keeps the files before each turn and marks the turn, one call at a time per session", async () => {
    let release: () => void = () => {};
    const { host, calls } = fakeHost({
      end: (s) => {
        calls.push(`end ${s} (slow)`);
        return new Promise<void>((r) => (release = r));
      },
    });
    const book = new TurnBook({ host, chatRewind: async () => {} });
    await book.beforeSend("s1", "/w/shop", "local-s1");
    expect(book.marksOf("s1")).toEqual([{ id: "local-s1", n: 1 }]);
    // a turn's end that is still being kept holds back the next turn's start
    book.afterTurn("s1");
    const next = book.beforeSend("s1", "/w/shop", "local-s2");
    await flush();
    expect(calls).toEqual(["take s1 /w/shop local-s1", "end s1 (slow)"]);
    release();
    await next;
    expect(calls.at(-1)).toBe("take s1 /w/shop local-s2");
    expect(book.marksOf("s1").map((m) => m.id)).toEqual(["local-s1", "local-s2"]);
  });

  it("says why a turn could not be kept, and offers only the newest turns the shell keeps", async () => {
    let fail = "";
    const { host } = fakeHost({
      take: async (_s, _c, turn) => {
        if (fail) throw new Error(fail);
        return { n: Number(turn.slice(7)), files: 1, left: 0 };
      },
    });
    const book = new TurnBook({ host, chatRewind: async () => {} });
    for (let i = 1; i <= KEPT_TURNS + 2; i++) await book.beforeSend("s1", "/w/shop", `local-s${i}`);
    expect(book.marksOf("s1")).toHaveLength(KEPT_TURNS);
    expect(book.marksOf("s1")[0].id).toBe("local-s3");
    fail = "why:too_many";
    await book.beforeSend("s1", "/w/shop", "local-s99");
    expect(book.getState().whyNot.s1).toBe("too_many");
    fail = "git: something else";
    await book.beforeSend("s1", "/w/shop", "local-s100");
    expect(book.getState().whyNot.s1).toBe("failed");
    fail = "";
    await book.beforeSend("s1", "/w/shop", "local-s101");
    expect(book.getState().whyNot.s1).toBeUndefined();
  });

  it("rewinds the files, then the chat, and drops that turn and every later one", async () => {
    const { host, calls } = fakeHost();
    const asked: string[] = [];
    const book = new TurnBook({ host, chatRewind: async (s, id) => void asked.push(`${s} ${id}`) });
    for (const id of ["local-s1", "local-s2", "local-s3"]) await book.beforeSend("s1", "/w/shop", id);
    const done = await book.rewind("s1", "local-s2", ["b.txt"]);
    expect(done).toEqual({ changed: 1, kept: 1, tooBig: 0 });
    expect(asked).toEqual(["s1 local-s2"]);
    expect(calls.slice(3)).toEqual(["restore s1 local-s2 [b.txt]", "settle s1 local-s2 true"]);
    expect(book.marksOf("s1").map((m) => m.id)).toEqual(["local-s1"]);
  });

  it("puts the files back as they were when the chat does not go back, and says why", async () => {
    const { host, calls } = fakeHost();
    const book = new TurnBook({
      host,
      chatRewind: async () => {
        throw new Error("Not taken back: busy");
      },
    });
    await book.beforeSend("s1", "/w/shop", "local-s1");
    const e = await book.rewind("s1", "local-s1", []).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(RewindError);
    expect((e as RewindError).message).toBe("Not taken back: busy");
    expect((e as RewindError).filesBack).toBe(true);
    expect(calls.slice(1)).toEqual(["restore s1 local-s1 []", "settle s1 local-s1 false"]);
    expect(book.marksOf("s1").map((m) => m.id)).toEqual(["local-s1"]);
  });

  it("says so when the files could not be put back either", async () => {
    const { host } = fakeHost({
      settle: async () => {
        throw new Error("a.txt: permission denied");
      },
    });
    const book = new TurnBook({
      host,
      chatRewind: async () => {
        throw new Error("Claude Code did not answer");
      },
    });
    await book.beforeSend("s1", "/w/shop", "local-s1");
    const e = (await book.rewind("s1", "local-s1", []).catch((x: unknown) => x)) as RewindError;
    expect(e.filesBack).toBe(false);
    expect(e.message).toBe("Claude Code did not answer; a.txt: permission denied");
  });

  it("asks the agent nothing when the files could not be put back", async () => {
    const { host } = fakeHost({
      restore: async () => {
        throw new Error("why:no_snapshot");
      },
    });
    const asked: string[] = [];
    const book = new TurnBook({ host, chatRewind: async (_s, id) => void asked.push(id) });
    await book.beforeSend("s1", "/w/shop", "local-s1");
    const e = (await book.rewind("s1", "local-s1", []).catch((x: unknown) => x)) as RewindError;
    expect(e.message).toBe("The files of that turn are no longer kept.");
    expect(asked).toEqual([]);
  });

  it("forgets a session's turns, prunes the gone ones, and does nothing without a shell", async () => {
    const { host, calls } = fakeHost();
    const book = new TurnBook({ host, chatRewind: async () => {} });
    await book.beforeSend("s1", "/w/shop", "local-s1");
    let seen = 0;
    const stop = book.subscribe(() => seen++);
    book.forget("s1");
    expect(book.marksOf("s1")).toEqual([]);
    expect(seen).toBe(1);
    stop();
    book.prune(["s2"]);
    await flush();
    // the forget waits behind the session's own calls; the prune, at start, waits for none
    expect(calls.slice(1).sort()).toEqual(["forget s1", "prune [s2]"]);
    const none = new TurnBook({ chatRewind: async () => {} });
    await none.beforeSend("s1", "/w/shop", "local-s1");
    expect(none.marksOf("s1")).toEqual([]);
    await expect(none.preview("s1", "local-s1")).rejects.toThrow("why:no_snapshot");
  });
});

describe("the chat after a rewind to a turn", () => {
  const key = "agent:s1";
  const run = (s: AppState, evs: Record<string, unknown>[]) =>
    evs.reduce((acc, ev, i) => reduce(acc, { type: "event", ev: { ...ev, bot: key } as unknown as BridgeEvent, now: 1_800_000_000_000 + i } as Action), s);

  const ids = (st: AppState) => st.chats[key].items.filter((i) => i.kind === "user" || i.kind === "assistant").map((i) => i.id);

  it("loses the message the rewind named and everything after it", () => {
    let s = reduce(initialState(), { type: "chat.opened", bot: key, res: { session_id: key, messages: [], running: false, model: "", provider: "", reasoning: "" }, now: 1 });
    for (const [id, text] of [
      ["u1", "first"],
      ["u2", "second"],
      ["u3", "third"],
    ]) {
      s = reduce(s, { type: "local.user", bot: key, id, text, now: 2 });
      s = run(s, [{ event: "turn.start" }, { event: "message", id: `m-${id}`, text: `answer to ${text}` }, { event: "turn.end", outcome: "done" }]);
    }
    const named = run(s, [{ event: "rewound", id: "u2" }]);
    expect(ids(named)).toEqual(["u1", "m-u1"]);
    // without a name, as the agents' own rewind of the last message has always worked
    const last = run(s, [{ event: "rewound" }]);
    expect(ids(last)).toEqual(["u1", "m-u1", "u2", "m-u2"]);
    // a name the chat does not hold falls back to the last message
    expect(ids(run(s, [{ event: "rewound", id: "gone" }]))).toEqual(["u1", "m-u1", "u2", "m-u2"]);
  });
});
