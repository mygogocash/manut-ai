// The page's side of a lane's ask (src/code/reviewAsk.ts): the shell's ask is an approval-core request, the person's answer settles
// it there once, and only a request approval-core settled reaches the shell's `review_settle`, once. The host has no call that
// writes without an ask, and its settle sends the ask's id and the answer only.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MockHost, TauriHost, type MockCall } from "../sessions/host";
import { answerReviewAsk, openReviewAsk, resetReviewAsks, reviewAskRecord, withdrawReviewAsk } from "./reviewAsk";
import type { ReviewAsk, ReviewDone } from "./source";

const ASK: ReviewAsk = { id: "0123456789abcdef0123456789abcdef", kind: "open", source: "github", repo: "o/r", remote: "origin", from: "", branch: "kit/qr", base: "main", head: "a".repeat(40), commits: 2, uncommitted: 0, title: "Add the PromptPay QR", body: "- one\n- two", number: 0, url: "", method: "", subject: "", message: "", dropped: 0 };
const OPENED: ReviewDone = { outcome: "opened", pushed: true, url: "https://github.com/o/r/pull/7", number: 7, step: "", error: "" };

const shell = (answer: () => Promise<ReviewDone> = async () => OPENED) => {
  const reviewSettle = vi.fn((_id: string, _yes: boolean) => answer());
  const reviewWithdraw = vi.fn(async (_id: string) => undefined);
  return { reviewSettle, reviewWithdraw };
};

beforeEach(() => resetReviewAsks());

describe("a lane's ask settles once", () => {
  it("opens as an owner's public_post that offers yes this once or no, with the shell's ask as its detail", async () => {
    await openReviewAsk(ASK);
    const rec = await reviewAskRecord(ASK.id);
    expect(rec?.status).toBe("pending");
    expect(rec?.request).toMatchObject({ kind: "public_post", revision: 1, detail: ASK });
    expect(rec?.request.options.map((o) => [o.id, o.effect])).toEqual([
      ["yes", "approve"],
      ["no", "decline"],
    ]);
    // an id is never opened twice
    await expect(openReviewAsk(ASK)).rejects.toThrow("already_exists");
  });

  it("a Yes reaches the shell only after approval-core settled it, and a second answer reaches nothing", async () => {
    const h = shell();
    await openReviewAsk(ASK);
    expect(await answerReviewAsk(h, ASK.id, true)).toEqual({ ok: true, done: OPENED });
    expect(h.reviewSettle).toHaveBeenCalledTimes(1);
    expect(h.reviewSettle).toHaveBeenCalledWith(ASK.id, true);
    expect(await answerReviewAsk(h, ASK.id, true)).toMatchObject({ ok: false, refused: "already_decided" });
    expect(await answerReviewAsk(h, ASK.id, false)).toMatchObject({ ok: false, refused: "already_decided" });
    expect(h.reviewSettle).toHaveBeenCalledTimes(1);
    expect((await reviewAskRecord(ASK.id))?.status).toBe("decided");
  });

  it("an answer to an ask that was never opened, or was taken back, reaches nothing", async () => {
    const h = shell();
    expect(await answerReviewAsk(h, ASK.id, true)).toEqual({ ok: false, refused: "not_found" });
    await openReviewAsk(ASK);
    await withdrawReviewAsk(h, ASK.id);
    expect(h.reviewWithdraw).toHaveBeenCalledWith(ASK.id);
    expect(await answerReviewAsk(h, ASK.id, true)).toMatchObject({ ok: false, refused: "superseded" });
    expect(h.reviewSettle).not.toHaveBeenCalled();
  });

  it("a No settles it too: the shell hears no, and a later Yes reaches nothing", async () => {
    const h = shell(async () => ({ outcome: "declined", pushed: false, url: "", number: 0, step: "", error: "" }));
    await openReviewAsk(ASK);
    expect(await answerReviewAsk(h, ASK.id, false)).toMatchObject({ ok: true, done: { outcome: "declined" } });
    expect(await answerReviewAsk(h, ASK.id, true)).toMatchObject({ ok: false, refused: "already_decided" });
    expect(h.reviewSettle.mock.calls).toEqual([[ASK.id, false]]);
  });

  it("says the shell's own refusal, and that a page with no shell can do nothing", async () => {
    await openReviewAsk(ASK);
    expect(await answerReviewAsk(shell(() => Promise.reject(new Error("expired"))), ASK.id, true)).toEqual({ ok: false, refused: "expired" });
    const other = { ...ASK, id: "f".repeat(32) };
    await openReviewAsk(other);
    expect(await answerReviewAsk({}, other.id, true)).toEqual({ ok: false, refused: "no_shell" });
  });
});

/** TauriHost with a stand-in for the shell's command bridge. */
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

describe("the host's way to the shell", () => {
  it("has no call that writes without an ask: its review calls are a draft, three asks, a settle by id and a withdraw", () => {
    const names = Object.getOwnPropertyNames(TauriHost.prototype);
    // the third ask is the Pull requests list's Merge (item 100): the same ask, for a request of the project's
    expect(names.filter((n) => /^review/.test(n)).sort()).toEqual(["reviewAsk", "reviewDraft", "reviewMerge", "reviewMergePull", "reviewSettle", "reviewWithdraw"]);
    // nothing else pushes, creates or merges (laneCleanMerged removes the folders of lanes that merged; it writes to no remote)
    expect(names.filter((n) => !/^review/.test(n) && /push|Push|create|Create|[mM]erge(?!d)/.test(n))).toEqual([]);
  });

  it("sends the ask's words to be checked and written down, then only the id and the answer", async () => {
    const h = new Host((cmd) => (cmd === "review_ask_open" ? ASK : cmd === "review_settle" ? OPENED : cmd === "review_draft" ? { branch: "kit/qr", base: "main", commits: ["b", "a"], count: 2 } : null));
    expect(await h.reviewDraft("/w/qr")).toEqual({ branch: "kit/qr", base: "main", commits: ["b", "a"], count: 2 });
    expect(await h.reviewAsk("/w/qr", "Add the PromptPay QR", "- one\n- two")).toEqual(ASK);
    expect(await h.reviewSettle(ASK.id, true)).toEqual(OPENED);
    await h.reviewWithdraw(ASK.id);
    expect(h.sent).toEqual([
      { cmd: "review_draft", args: { worktree: "/w/qr" } },
      { cmd: "review_ask_open", args: { worktree: "/w/qr", title: "Add the PromptPay QR", body: "- one\n- two" } },
      { cmd: "review_settle", args: { id: ASK.id, yes: true } },
      { cmd: "review_withdraw", args: { id: ASK.id } },
    ]);
    // an answer that is not an ask or an outcome is not believed
    await expect(new Host(() => ({ id: "x" })).reviewAsk("/w", "t", "")).rejects.toThrow("unread");
    await expect(new Host(() => ({ outcome: "merged-maybe" })).reviewSettle(ASK.id, true)).rejects.toThrow("unread");
  });

  it("sends a merge's pull request, method and the credit switch to be checked, and believes only a merge's ask", async () => {
    const MERGE = { ...ASK, kind: "merge", from: "o/r", number: 7, url: "https://github.com/o/r/pull/7", method: "squash", subject: "Add the PromptPay QR (#7)", message: "* one", dropped: 2 };
    const h = new Host(() => MERGE);
    expect(await h.reviewMerge("/w/qr", 7, "squash", true)).toEqual(MERGE);
    expect(await h.reviewMerge("/w/qr", 7, "squash")).toEqual(MERGE);
    expect(h.sent).toEqual([
      { cmd: "review_ask_merge", args: { worktree: "/w/qr", number: 7, method: "squash", credits: true } },
      { cmd: "review_ask_merge", args: { worktree: "/w/qr", number: 7, method: "squash", credits: false } },
    ]);
    await expect(new Host(() => ASK).reviewMerge("/w/qr", 7, "squash")).rejects.toThrow("unread");
    await expect(new Host(() => ({ ...MERGE, method: "fast-forward" })).reviewMerge("/w/qr", 7, "merge")).rejects.toThrow("unread");
    // a merge's ask that does not say where the pull request comes from, or at which commit, is not shown
    await expect(new Host(() => ({ ...MERGE, from: "" })).reviewMerge("/w/qr", 7, "squash")).rejects.toThrow("unread");
    await expect(new Host(() => ({ ...MERGE, head: "not-a-commit" })).reviewMerge("/w/qr", 7, "squash")).rejects.toThrow("unread");
    // the list's Merge sends the project's folder, the repository and the number, and believes only a merge's ask too
    const l = new Host(() => MERGE);
    expect(await l.reviewMergePull("/code/r", "github", "o/r", 7, "squash", true)).toEqual(MERGE);
    expect(l.sent).toEqual([{ cmd: "review_ask_merge_pull", args: { folder: "/code/r", source: "github", repo: "o/r", number: 7, method: "squash", credits: true } }]);
    await expect(new Host(() => ASK).reviewMergePull("/code/r", "github", "o/r", 7, "squash")).rejects.toThrow("unread");
  });

  it("MockHost keeps the shell's rules: one answer per ask, and the text the ask showed is the text it sends", async () => {
    const calls: MockCall[] = [];
    const lane = { worktree: "/home/you/.manut/lanes/web-app/qr", dir: "/home/you/.manut/lanes/web-app/qr", branch: "kit/qr", base: "main", project: "/home/you/code/web-app", made: 1 };
    const m = new MockHost({ __manutSessionCalls: calls, __manutLanes: [lane] } as never);
    const ask = await m.reviewAsk(lane.worktree, "  QR  ", "body\r\n");
    expect(ask).toMatchObject({ repo: "you/web-app", branch: "kit/qr", base: "main", title: "QR", body: "body" });
    expect(await m.reviewSettle(ask.id, true)).toMatchObject({ outcome: "opened" });
    await expect(m.reviewSettle(ask.id, true)).rejects.toThrow("already_decided");
    expect(calls.filter((c) => c.op === "review.settle")).toEqual([{ op: "review.settle", path: "kit/qr", yes: true, title: "QR", body: "body" }]);
    await expect(m.reviewAsk("/nowhere", "x", "")).rejects.toThrow("not_a_lane");
    await expect(m.reviewSettle("f".repeat(32), true)).rejects.toThrow("not_found");
  });
});
