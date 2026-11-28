// The lane's next step (src/code/LaneStep.tsx, item 167e): the one dark button names the step the branch is at (Put up for review with
// no request, Merge once one is open, none once it merged or while it is a draft), the request's state beside it in Tasks' words, the
// board's two tags in the header, and a press that opens exactly item 75's ask (Review.tsx `ReviewFlow`) and sends nothing until
// approval-core settled it. No state offers a Commit, a Push or a Discard.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToString } from "react-dom/server";
import { LANGS, setLang, t } from "../i18n";
import type { LanePull } from "../tasks/pulls";
import { resetPulls } from "../tasks/pulls";
import type { LaneStatus } from "./lane";
import { LaneHeadTagsView, LaneStepView, nextStep, pressStep, requestWords, type NextStep, type NextStepInput } from "./LaneStep";
import { ReviewFlow, type FlowHost } from "./Review";
import { resetReviewAsks, reviewAskRecord } from "./reviewAsk";
import type { ReviewAsk, ReviewDone } from "./source";

const words = (html: string) => html.replace(/<[^>]*>/g, " ").replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
const noop = () => {};
const WT = "/home/you/.manut/lanes/shop/promptpay-qr";

const PULL: LanePull = { source: "github", repo: "you/shop", number: 12, state: "open", title: "Add the PromptPay QR", checks: { passed: 3, failed: 0, pending: 0, total: 3 } };
const checks = (passed: number, failed: number, pending: number) => ({ passed, failed, pending, total: passed + failed + pending });

const ASK: ReviewAsk = {
  id: "0123456789abcdef0123456789abcdef",
  kind: "open",
  source: "github",
  repo: "you/shop",
  remote: "origin",
  from: "",
  branch: "kit/promptpay-qr",
  base: "main",
  head: "a".repeat(40),
  commits: 2,
  uncommitted: 0,
  title: "PromptPay QR",
  body: "- Draw the QR\n- Read the amount",
  number: 0,
  url: "",
  method: "",
  subject: "",
  message: "",
  dropped: 0,
};
const MERGE: ReviewAsk = { ...ASK, id: "f".repeat(32), kind: "merge", from: "you/shop", number: 12, url: "https://github.com/you/shop/pull/12", method: "merge", subject: "Merge pull request #12 from kit/promptpay-qr", message: "Add the PromptPay QR" };
const OPENED: ReviewDone = { outcome: "opened", pushed: true, url: "https://github.com/you/shop/pull/12", number: 12, step: "", error: "" };

/** Every branch state the brief names, with the button and the words the top bar must show. */
const STATES: { name: string; in: Partial<NextStepInput>; button: "review" | "merge" | null; says: string[] }[] = [
  { name: "no request", in: {}, button: "review", says: [] },
  { name: "open, checks running", in: { pull: { ...PULL, checks: checks(1, 0, 2) } }, button: "merge", says: ["Pull request #12", "2 running"] },
  { name: "open, checks passing", in: { pull: PULL }, button: "merge", says: ["Pull request #12", "Checks passed"] },
  { name: "open, checks failing", in: { pull: { ...PULL, checks: checks(2, 1, 0) } }, button: "merge", says: ["Pull request #12", "1 failing"] },
  { name: "open, review asked", in: { pull: { ...PULL, review: "required" } }, button: "merge", says: ["Pull request #12", "Checks passed", "Review needed"] },
  { name: "merged", in: { merged: true }, button: null, says: ["Pull request merged"] },
  { name: "draft", in: { pull: { ...PULL, state: "draft" } }, button: null, says: ["Pull request #12", "Draft"] },
];
const input = (over: Partial<NextStepInput>): NextStepInput => ({ own: true, can: true, canMerge: true, pull: null, merged: false, ...over });
const drawStep = (next: NextStep, open = false) => renderToString(<LaneStepView next={next} open={open} onPress={noop} />);

/** A stand-in shell that records what it was asked: reads answer, asks answer the shell's ask, and a settle answers what it ran. */
function shell() {
  return {
    reviewDraft: vi.fn(async (_w: string) => ({ branch: "kit/promptpay-qr", base: "main", commits: ["Read the amount", "Draw the QR"], count: 2 })),
    reviewAsk: vi.fn(async (_w: string, _t: string, _b: string) => ASK),
    reviewMerge: vi.fn(async (_w: string, _n: number, _m: string, _c?: boolean) => MERGE),
    reviewSettle: vi.fn(async (_id: string, yes: boolean): Promise<ReviewDone> => (yes ? OPENED : { outcome: "declined", pushed: false, url: "", number: 0, step: "", error: "" })),
    reviewWithdraw: vi.fn(async (_id: string) => undefined),
    laneDiff: vi.fn(async () => null),
  } satisfies FlowHost;
}
/** What reached the shell that could write: an ask made, or a settle. */
const writesAsked = (h: ReturnType<typeof shell>) => h.reviewAsk.mock.calls.length + h.reviewMerge.mock.calls.length + h.reviewSettle.mock.calls.length;
const settle = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  resetReviewAsks();
  resetPulls();
});
afterEach(() => setLang("en"));

describe("the one button names the step the branch is at", () => {
  for (const s of STATES) {
    it(`${s.name}: ${s.button ?? "no button"}`, () => {
      const next = nextStep(input(s.in));
      expect(next.button).toBe(s.button);
      const html = drawStep(next);
      const text = words(html);
      if (s.button) {
        // one dark button, and only one
        expect(html.match(/data-testid="lane-step-button"/g)).toHaveLength(1);
        expect(html).toMatch(/class="btn dark ss-step-btn"/);
        expect(html).toContain(`data-step="${s.button}"`);
        expect(text).toContain(t(s.button === "merge" ? "prs.merge" : "review.start"));
      } else {
        expect(html).not.toContain("lane-step-button");
      }
      for (const w of s.says) expect(text, s.name).toContain(w);
    });
  }

  it("offers nothing for a lane with no folder of its own, or a shell that cannot ask", () => {
    expect(nextStep(input({ own: false }))).toEqual({ button: null, pull: null, merged: false });
    expect(nextStep(input({ can: false, pull: PULL }))).toEqual({ button: null, pull: null, merged: false });
    expect(drawStep(nextStep(input({ own: false })))).toBe("");
    // an open request on a shell that cannot ask to merge is said, with no button
    expect(nextStep(input({ canMerge: false, pull: PULL }))).toMatchObject({ button: null, pull: PULL });
  });

  it("puts an open request first, a merged branch's new request included", () => {
    expect(nextStep(input({ merged: true, pull: PULL })).button).toBe("merge");
  });

  it("says the request's state as Tasks says it, and nothing it was not told", () => {
    expect(requestWords({ ...PULL, checks: checks(0, 0, 0) }).map((w) => w.text)).toEqual([t("prs.checks.none")]);
    // a request the app noted itself as it opened it: no checks are known yet, so none are said
    expect(requestWords({ ...PULL, checks: null })).toEqual([]);
    expect(requestWords({ ...PULL, review: "approved", conflict: true }).map((w) => [w.id, w.tone])).toEqual([
      ["checks", "ok"],
      ["review", "none"],
      ["conflict", "fail"],
    ]);
    expect(requestWords({ ...PULL, checks: checks(1, 1, 1) })[0]).toMatchObject({ tone: "fail" });
    expect(requestWords({ ...PULL, checks: checks(1, 0, 1) })[0]).toMatchObject({ tone: "run" });
  });

  it("says whether its panel is open, and the request's number opens it in Tasks", () => {
    expect(drawStep(nextStep(input({})), true)).toContain('aria-expanded="true"');
    expect(drawStep(nextStep(input({})), false)).toContain('aria-expanded="false"');
    const html = drawStep(nextStep(input({ pull: PULL })));
    expect(html).toMatch(/data-testid="lane-step-pull"[^>]*>Pull request #12</);
    expect(html).toContain(`title="${t("lane.prTip")}"`);
  });

  it("reads in every language, with no key left showing", () => {
    for (const l of LANGS) {
      setLang(l);
      for (const s of STATES) {
        const text = words(drawStep(nextStep(input(s.in))));
        expect(text, `${l} ${s.name}`).not.toMatch(/\b(lane|prs|review|tasks)\.[a-z]/);
      }
    }
  });
});

describe("no state offers a Commit, a Push or a Discard", () => {
  // the visible name of every button the top bar or its tags draw, in every state
  const buttons = (html: string) => [...html.matchAll(/<button[^>]*>(.*?)<\/button>/g)].map((m) => words(m[1]));
  const testIds = (html: string) => [...html.matchAll(/data-testid="([^"]+)"/g)].map((m) => m[1]);
  const STATUSES: LaneStatus[] = ["needs_you", "working", "failed", "reverted", "checked", "tests_failed", "unconfirmed", "not_run"];

  it("in the button and the request's state, open or not", () => {
    for (const s of STATES)
      for (const open of [false, true]) {
        const html = drawStep(nextStep(input(s.in)), open);
        for (const b of buttons(html)) expect(b, s.name).not.toMatch(/\b(commit|push|discard)\b/i);
        for (const id of testIds(html)) expect(id, s.name).not.toMatch(/\b(commit|push|discard)\b/i);
        // a press alone opens a step; the ask's own Yes is never in the header
        expect(html).not.toContain("review-yes");
      }
  });

  it("in the header's tags, whatever the lane's state", () => {
    for (const status of STATUSES) {
      const html = renderToString(<LaneHeadTagsView branch={{ name: "kit/promptpay-qr", kind: "own", base: "main" }} status={status} line={null} />);
      expect(buttons(html)).toEqual([]);
      for (const id of testIds(html)) expect(id).not.toMatch(/\b(commit|push|discard)\b/i);
    }
  });
});

describe("a press opens exactly item 75's ask, and nothing is sent until it is settled", () => {
  it("Put up for review: the press opens the draft (a read), Ask opens the shell's ask in approval-core, and only a Yes reaches the settle", async () => {
    const h = shell();
    const flow = new ReviewFlow(h, WT);
    flow.title = "PromptPay QR";
    pressStep(flow, "review");
    expect(flow.get().at).toBe("draft");
    await settle();
    // the draft's words come from the lane's commits, as the row's link makes them
    expect(flow.get()).toMatchObject({ at: "draft", title: "PromptPay QR", body: "- Draw the QR\n- Read the amount", busy: false });
    expect(h.reviewDraft).toHaveBeenCalledWith(WT);
    expect(writesAsked(h)).toBe(0);
    expect(await reviewAskRecord(ASK.id)).toBeUndefined();

    await flow.ask();
    expect(h.reviewAsk.mock.calls).toEqual([[WT, "PromptPay QR", "- Draw the QR\n- Read the amount"]]);
    expect(flow.get()).toMatchObject({ at: "ask", ask: ASK });
    // the shell's own ask, opened as item 75 opens it: the owner's public_post, yes this once or no
    const rec = await reviewAskRecord(ASK.id);
    expect(rec?.status).toBe("pending");
    expect(rec?.request).toMatchObject({ kind: "public_post", detail: ASK });
    expect(h.reviewSettle).not.toHaveBeenCalled();

    await flow.answer(true);
    expect(h.reviewSettle.mock.calls).toEqual([[ASK.id, true]]);
    expect((await reviewAskRecord(ASK.id))?.status).toBe("decided");
    expect(flow.get()).toMatchObject({ at: "closed", kind: "open", done: { outcome: "opened", number: 12 } });
    // settled once: another answer reaches nothing
    await flow.answer(true);
    expect(h.reviewSettle).toHaveBeenCalledTimes(1);
  });

  it("Merge: the press opens the method and asks the shell nothing; Ask names the request; a No settles it and runs nothing", async () => {
    const h = shell();
    const flow = new ReviewFlow(h, WT);
    flow.pull = PULL;
    pressStep(flow, "merge");
    expect(flow.get()).toMatchObject({ at: "method", method: "merge" });
    await settle();
    expect(writesAsked(h) + h.reviewDraft.mock.calls.length).toBe(0);

    await flow.mergeAsk();
    expect(h.reviewMerge.mock.calls).toEqual([[WT, 12, "merge", false]]);
    expect(flow.get()).toMatchObject({ at: "ask", ask: MERGE });
    expect(h.reviewSettle).not.toHaveBeenCalled();

    await flow.answer(false);
    expect(h.reviewSettle.mock.calls).toEqual([[MERGE.id, false]]);
    expect(flow.get()).toEqual({ at: "closed", kind: "merge", done: null });
  });

  it("a second press while a step is open starts nothing over, and closing takes a waiting ask back", async () => {
    const h = shell();
    const flow = new ReviewFlow(h, WT);
    flow.pull = PULL;
    pressStep(flow, "review");
    await settle();
    flow.edit({ title: "My own words" });
    pressStep(flow, "review");
    pressStep(flow, "merge");
    expect(flow.get()).toMatchObject({ at: "draft", title: "My own words" });
    expect(h.reviewDraft).toHaveBeenCalledTimes(1);

    await flow.ask();
    pressStep(flow, "merge");
    expect(flow.get().at).toBe("ask");
    flow.close();
    expect(flow.get()).toEqual({ at: "closed" });
    // taken back on both sides: approval-core first, then the shell
    await settle();
    expect(h.reviewWithdraw).toHaveBeenCalledWith(ASK.id);
    expect((await reviewAskRecord(ASK.id))?.status).not.toBe("pending");
    expect(h.reviewSettle).not.toHaveBeenCalled();
  });

  it("the shell's refusal of an ask is said in words, and nothing is opened in approval-core", async () => {
    const h = { ...shell(), reviewAsk: vi.fn(async () => Promise.reject(new Error("not_signed_in"))) };
    const flow = new ReviewFlow(h, WT);
    pressStep(flow, "review");
    await settle();
    await flow.ask();
    expect(flow.get()).toMatchObject({ at: "draft", why: "not_signed_in" });
    expect(await reviewAskRecord(ASK.id)).toBeUndefined();
    expect(h.reviewSettle).not.toHaveBeenCalled();
  });
});

describe("the header's tags", () => {
  const own = { name: "kit/promptpay-qr", kind: "own" as const, base: "main" };

  it("draw the branch in mono, with where it was made, and the lane's state as the board's tag", () => {
    const html = renderToString(<LaneHeadTagsView branch={own} status="checked" line={{ key: "lane.line.checkedN", vars: { n: 14 } }} />);
    expect(html).toMatch(/class="tag mono"[^>]*title="Made from main\. Kit never pushes or merges from here\."[^>]*data-testid="lane-head-branch"[^>]*>kit\/promptpay-qr</);
    expect(html).toMatch(/class="tag ok"[^>]*data-testid="lane-head-state"[^>]*data-status="checked"[^>]*>Checked</);
    // what the state means, as the row's line says it, is the tag's tooltip
    expect(html).toContain(`title="${t("lane.line.checkedN", { n: 14 })}"`);
    expect(renderToString(<LaneHeadTagsView branch={own} status="tests_failed" line={null} />)).toMatch(/class="tag err"[^>]*>Tests failed</);
  });

  it("leave Working, Needs you and an ending to the header's own words", () => {
    for (const status of ["working", "needs_you", "failed"] as const) {
      const html = renderToString(<LaneHeadTagsView branch={own} status={status} line={null} />);
      expect(html).toContain("lane-head-branch");
      expect(html).not.toContain("lane-head-state");
      expect(renderToString(<LaneHeadTagsView branch={null} status={status} line={null} />)).toBe("");
    }
  });
});
