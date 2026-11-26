// Rewind to before a turn (rewind.ts): which turns can be rewound, whether a turn sent something out, the words, and
// the turn book's order of calls against a stand-in for the shell. The store's `rewound` with a message's id is
// checked here too, with the reducer itself.
import { afterEach, describe, expect, it } from "vitest";
import { backWhyText, broughtBackNote, KEPT_TURNS, rewindable, RewindError, rewoundNote, TurnBook, turnTitle, wentLive, whyOf, whyText, type TurnMark } from "./rewind";
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

  it("leave out a message that never reached the agent: its send failed, or Stop threw it away", () => {
    const items: TimelineItem[] = [user("local-s1", "sent"), { ...user("local-s2", "failed"), error: "agent gone" } as TimelineItem, { ...user("local-s3", "dropped"), wait: "dropped" } as TimelineItem];
    const marks = ["local-s1", "local-s2", "local-s3"].map((id, n) => ({ id, n }));
    expect(rewindable(items, marks).map((t) => t.id)).toEqual(["local-s1"]);
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
    // a push to an address the agent wrote asks as a send, and still went out
    for (const line of ["wrangler deploy", "npm publish", "gh pr merge 12", "git push https://x.example/shop.git kit/qr"]) {
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

  it("say what Bring it back put back, and always that the chat stayed where the rewind left it", () => {
    const stays = "The chat stays where the rewind left it.";
    expect(broughtBackNote(3)).toBe(`3 files are back as they were just before the rewind. ${stays}`);
    expect(broughtBackNote(1)).toBe(`1 file is back as it was just before the rewind. ${stays}`);
    expect(broughtBackNote(0)).toBe(`No file came back. ${stays}`);
    expect(backWhyText(new Error("why:no_snapshot"))).toBe("The files from before the rewind are no longer kept.");
    expect(backWhyText(new Error("why:too_many"))).toMatch(/too many files/);
    expect(backWhyText(new Error("sub is a link, so nothing is written through it"))).toBe("sub is a link, so nothing is written through it");
    setLang("ko");
    expect(broughtBackNote(2)).toBe("파일 2개가 되감기 직전 상태로 돌아왔어요. 채팅은 되감기가 남긴 자리에 그대로 있어요.");
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
    settle: async (s, turn, ok) => {
      calls.push(`settle ${s} ${turn} ${ok}`);
      return { back: ok };
    },
    backPreview: async (s, turn) => {
      calls.push(`backPreview ${s} ${turn}`);
      return preview;
    },
    bringBack: async (s, turn, overwrite) => {
      calls.push(`bringBack ${s} ${turn} [${overwrite.join(",")}]`);
      return { changed: 1, kept: 0, tooBig: 0 };
    },
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

  it("lets a message go when its turn's files take too long to keep, and does not offer that turn", async () => {
    let finish: () => void = () => {};
    const { host } = fakeHost({
      take: () => new Promise((resolve) => (finish = () => resolve({ n: 1, files: 1, left: 0 }))),
    });
    const book = new TurnBook({ host, chatRewind: async () => {}, sendWaitMs: 10 });
    await book.beforeSend("s1", "/w/shop", "local-s1");
    expect(book.marksOf("s1")).toEqual([]);
    expect(book.getState().whyNot.s1).toBe("failed");
    // kept after all, once the agent may already have changed files: still not offered
    finish();
    await flush();
    expect(book.marksOf("s1")).toEqual([]);
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

describe("Bring it back, in the turn book", () => {
  /** A book with turns `local-s1` and `local-s2` kept, whose chat goes back when told to (`answer`). */
  async function bookWith(over: Partial<TurnFilesHost> = {}) {
    const { host, calls } = fakeHost(over);
    const state = { answer: "ok" as "ok" | "refuse", asked: [] as string[] };
    const book = new TurnBook({
      host,
      chatRewind: async (s, id) => {
        state.asked.push(`${s} ${id}`);
        if (state.answer === "refuse") throw new Error("Not taken back: busy");
      },
    });
    for (const id of ["local-s1", "local-s2"]) await book.beforeSend("s1", "/w/shop", id);
    return { book, calls, state };
  }

  it("is offered once the agent took the chat back, for the turn that rewind went back to", async () => {
    const { book, calls } = await bookWith();
    expect(book.backOf("s1")).toBeUndefined();
    let seen = 0;
    book.subscribe(() => seen++);
    await book.rewind("s1", "local-s2", []);
    expect(book.backOf("s1")).toBe("local-s2");
    expect(book.getState().backs).toEqual({ s1: "local-s2" });
    expect(seen).toBeGreaterThan(0);
    const p = await book.backPreview("s1");
    expect(p.back).toHaveLength(1);
    expect(calls.at(-1)).toBe("backPreview s1 local-s2");
  });

  it("is not offered after a rewind the agent refused, and one it refuses later leaves the earlier one's files kept", async () => {
    const { book, state } = await bookWith();
    state.answer = "refuse";
    await book.rewind("s1", "local-s2", []).catch(() => undefined);
    expect(book.backOf("s1")).toBeUndefined();
    state.answer = "ok";
    await book.rewind("s1", "local-s2", []);
    expect(book.backOf("s1")).toBe("local-s2");
    state.answer = "refuse";
    await book.rewind("s1", "local-s1", []).catch(() => undefined);
    expect(book.backOf("s1")).toBe("local-s2");
    // answered this time: the files kept are of this rewind, in place of the first's
    state.answer = "ok";
    await book.rewind("s1", "local-s1", []);
    expect(book.backOf("s1")).toBe("local-s1");
  });

  it("is not offered when the shell could not keep the files", async () => {
    const { book } = await bookWith({ settle: async () => ({ back: false }) });
    await book.rewind("s1", "local-s2", []);
    expect(book.backOf("s1")).toBeUndefined();
    await expect(book.backPreview("s1")).rejects.toThrow("why:no_snapshot");
    // nor from a shell that answers with nothing
    const old = await bookWith({ settle: async () => undefined as never });
    await old.book.rewind("s1", "local-s2", []);
    expect(old.book.backOf("s1")).toBeUndefined();
  });

  it("puts the files back with the person's choices (the files to put back over), asks the agent nothing, and leaves nothing to bring back", async () => {
    const { book, calls, state } = await bookWith();
    await book.rewind("s1", "local-s2", []);
    state.asked.length = 0;
    expect(await book.bringBack("s1", ["b.txt"])).toEqual({ changed: 1, kept: 0, tooBig: 0 });
    expect(calls.at(-1)).toBe("bringBack s1 local-s2 [b.txt]");
    expect(state.asked, "the chat is not brought back: neither agent has a message for it").toEqual([]);
    expect(book.backOf("s1")).toBeUndefined();
    await expect(book.bringBack("s1", [])).rejects.toThrow("why:no_snapshot");
  });

  it("keeps what it holds when the files could not be put back, so it can be tried again", async () => {
    let fail = true;
    const { book } = await bookWith({
      bringBack: async () => {
        if (fail) throw new Error("sub is a link, so nothing is written through it");
        return { changed: 1, kept: 0, tooBig: 0 };
      },
    });
    await book.rewind("s1", "local-s2", []);
    await expect(book.bringBack("s1", ["sub"])).rejects.toThrow("sub is a link");
    expect(book.backOf("s1")).toBe("local-s2");
    fail = false;
    await book.bringBack("s1", []);
    expect(book.backOf("s1")).toBeUndefined();
  });

  it("stops being offered when a turn begins (the person's message or one the agent began itself) and when the session goes", async () => {
    for (const end of [
      (b: TurnBook) => b.beforeSend("s1", "/w/shop", "local-s3"),
      (b: TurnBook) => b.turnStarted("s1"),
      (b: TurnBook) => b.forget("s1"),
    ]) {
      const { book } = await bookWith();
      await book.rewind("s1", "local-s2", []);
      expect(book.backOf("s1")).toBe("local-s2");
      await end(book);
      expect(book.backOf("s1")).toBeUndefined();
      await expect(book.backPreview("s1")).rejects.toThrow("why:no_snapshot");
      await expect(book.bringBack("s1", [])).rejects.toThrow("why:no_snapshot");
    }
  });

  it("does not put back files that a turn which began meanwhile has taken", async () => {
    let release: () => void = () => {};
    const { book, calls } = await bookWith({
      end: () => new Promise<void>((r) => (release = r)),
    });
    await book.rewind("s1", "local-s2", []);
    // a turn's end is still being kept; the call waits behind it, and a turn begins before it runs
    book.afterTurn("s1");
    const pending = book.bringBack("s1", []);
    book.turnStarted("s1");
    // the held call has started by now
    await flush();
    release();
    await expect(pending).rejects.toThrow("why:no_snapshot");
    expect(calls.some((c) => c.startsWith("bringBack"))).toBe(false);
  });

  it("does nothing without a shell", async () => {
    const none = new TurnBook({ chatRewind: async () => {} });
    await expect(none.backPreview("s1")).rejects.toThrow("why:no_snapshot");
    await expect(none.bringBack("s1", [])).rejects.toThrow("why:no_snapshot");
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
