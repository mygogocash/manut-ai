// Put up for review (src/code/Review.tsx), drawn with react-dom/server: the link only for a lane with no pull request yet, the draft,
// the ask with the repository, the branch, the base, the title and the body exactly as they will be sent, and every outcome and
// refusal in words, in every language.
import { afterEach, describe, expect, it } from "vitest";
import { renderToString } from "react-dom/server";
import { LANGS, setLang, t } from "../i18n";
import { doneWords, draftOf, ReviewView, whyWords, type ReviewStep, type ReviewViewProps } from "./Review";
import type { ReviewAsk } from "./source";
import { pullMaterial } from "../sessions/titleWords";

const words = (html: string) => html.replace(/<[^>]*>/g, " ").replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
const noop = () => {};
const ASK: ReviewAsk = {
  id: "0123456789abcdef0123456789abcdef",
  kind: "open",
  source: "github",
  repo: "mygogocash/web-app",
  remote: "origin",
  from: "",
  branch: "kit/promptpay-qr",
  base: "main",
  head: "a".repeat(40),
  commits: 3,
  uncommitted: 2,
  title: "Add the PromptPay QR",
  body: "- Draw the QR\n- Read the amount\n\nCo-authored-by: Ana <ana@shop.co>",
  number: 0,
  url: "",
  method: "",
  subject: "",
  message: "",
  dropped: 0,
};
const MERGE: ReviewAsk = { ...ASK, kind: "merge", from: "mygogocash/web-app", number: 12, url: "https://github.com/mygogocash/web-app/pull/12", method: "squash", subject: "Add the PromptPay QR (#12)", message: "* Draw the QR\n\nCo-authored-by: Ana <ana@shop.co>\n\n* Read the amount", uncommitted: 0 };
const PULL = { source: "github" as const, repo: "mygogocash/web-app", number: 12, state: "open" as const, title: "Add the PromptPay QR" };

function draw(step: ReviewStep, over: Partial<ReviewViewProps> = {}) {
  return renderToString(<ReviewView step={step} onStart={noop} onTitle={noop} onBody={noop} onAsk={noop} onYes={noop} onNo={noop} onClose={noop} onChange={noop} {...over} />);
}

afterEach(() => setLang("en"));

describe("Put up for review", () => {
  it("offers the link only to a lane with no open pull request yet", () => {
    expect(words(draw({ at: "closed" }))).toBe(t("review.start"));
    expect(draw({ at: "closed" }, { pull: { source: "github", repo: "o/r", number: 12, state: "open", title: "x" } })).toBe("");
  });

  it("offers no link where the lane's top bar holds the button (item 167e), and still says what the last answer did", () => {
    expect(draw({ at: "closed" }, { links: false })).toBe("");
    expect(draw({ at: "closed" }, { links: false, pull: PULL, onMergeStart: noop })).toBe("");
    const done = draw({ at: "closed", done: { outcome: "opened", pushed: true, url: "https://github.com/o/r/pull/7", number: 7, step: "", error: "" } }, { links: false });
    expect(words(done)).toBe(`${t("review.done.opened", { n: 7 })} ${t("review.done.openLink")}`);
    expect(done).not.toContain("review-start");
    // the steps after the press are the row's very own
    expect(draw({ at: "draft", title: "x", body: "", busy: false, why: null }, { links: false })).toContain('data-testid="review-draft"');
  });

  it("asks with exactly what will go: the repository, the branch, the base, the title and the body, line ends kept", () => {
    const html = draw({ at: "ask", ask: ASK, busy: false, why: null });
    const text = words(html);
    expect(text).toContain("Push kit/promptpay-qr and open a pull request?");
    expect(text).toContain("mygogocash/web-app on GitHub");
    expect(text).toContain("kit/promptpay-qr, 3 commits, pushed to origin");
    expect(html).toMatch(/data-testid="review-base">main</);
    // the texts as they will be sent, in a box each, every line as it is
    expect(html).toContain(`data-testid="review-ask-title">Add the PromptPay QR</pre>`);
    expect(html).toContain(`data-testid="review-ask-body">- Draw the QR\n- Read the amount\n\nCo-authored-by: Ana &lt;ana@shop.co&gt;</pre>`);
    expect(text).toContain("2 changed files in the lane's folder are not committed, so they do not go.");
    expect(text).toContain(t("review.ask.never"));
    expect(text).toContain(t("review.ask.yes"));
    expect(text).toContain(t("review.ask.no"));
    // an empty body says so rather than showing nothing
    expect(words(draw({ at: "ask", ask: { ...ASK, body: "", uncommitted: 0 }, busy: false, why: null }))).toContain(t("review.empty"));
    // while the answer runs, neither button can be pressed again
    expect(draw({ at: "ask", ask: ASK, busy: true, why: null }).match(/disabled=""/g)?.length).toBeGreaterThanOrEqual(2);
  });

  it("offers Merge for an open pull request, never for a draft, and starts from the method chosen", () => {
    expect(words(draw({ at: "closed" }, { pull: PULL, onMergeStart: noop }))).toBe("Merge pull request #12");
    expect(draw({ at: "closed" }, { pull: { ...PULL, state: "draft" }, onMergeStart: noop })).toBe("");
    const html = draw({ at: "method", method: "rebase", busy: false, why: null }, { pull: PULL });
    expect(html).toMatch(/<option value="rebase" selected="">Rebase and merge<\/option>/);
    expect(words(html)).toContain("Create a merge commit");
    expect(words(draw({ at: "method", method: "merge", busy: false, why: "cannot_merge:blocked" }))).toContain("The app does not turn on auto-merge.");
  });

  it("asks to merge with the pull request, the method and exactly the message that will be sent", () => {
    const html = draw({ at: "ask", ask: MERGE, busy: false, why: null });
    const text = words(html);
    expect(text).toContain("Merge pull request #12 into main?");
    // where the pull request comes from, and its head commit beside the title
    expect(text).toContain("#12 Add the PromptPay QR (commit aaaaaaa)");
    expect(text).toContain("kit/promptpay-qr of mygogocash/web-app into main");
    expect(html).toContain('data-method="squash"');
    expect(text).toContain("Squash and merge");
    expect(html).toContain(`data-testid="review-subject">Add the PromptPay QR (#12)</pre>`);
    expect(html).toContain(`data-testid="review-message">* Draw the QR\n\nCo-authored-by: Ana &lt;ana@shop.co&gt;\n\n* Read the amount</pre>`);
    expect(text).toContain(t("review.merge.never"));
    expect(t("review.merge.never")).toContain("the app never deletes it");
    expect(text).toContain(t("review.merge.yes"));
    // a rebase makes no message, and the ask says so instead of showing an empty one
    const rebase = draw({ at: "ask", ask: { ...MERGE, method: "rebase", subject: "", message: "" }, busy: false, why: null });
    expect(rebase).toContain('data-testid="review-no-message"');
    expect(rebase).not.toContain('data-testid="review-message"');
    // GitLab's squash sends the one message for both commits it may make, and says so
    expect(words(draw({ at: "ask", ask: { ...MERGE, source: "gitlab" }, busy: false, why: null }))).toContain(t("review.merge.messageBoth"));
    expect(doneWords({ outcome: "merged", pushed: false, url: "", number: 12, step: "", error: "" }, "merge")).toBe("Merged pull request #12.");
    // how many agent credit lines went, when the switch took any out; nothing said when none did
    expect(words(draw({ at: "ask", ask: { ...MERGE, dropped: 2 }, busy: false, why: null }))).toContain("2 agent credit lines were taken out (Settings, Source control). Every human co-author stays.");
    expect(draw({ at: "ask", ask: MERGE, busy: false, why: null })).not.toContain('data-testid="review-dropped"');
    expect(doneWords({ outcome: "failed", pushed: false, url: "", number: 0, step: "check", error: "changed" }, "merge")).toBe(t("review.done.mergeCheck"));
  });

  it("holds Ask until there is a title, and says why the shell refused one", () => {
    expect(draw({ at: "draft", title: " ", body: "", busy: false, why: null })).toMatch(/disabled=""[^>]*data-testid="review-ask-button"|data-testid="review-ask-button"[^>]*disabled=""/);
    expect(words(draw({ at: "draft", title: "x", body: "", busy: false, why: "not_signed_in" }))).toContain("gh auth login");
  });

  it("says what a settled ask did", () => {
    expect(doneWords({ outcome: "opened", pushed: true, url: "https://github.com/o/r/pull/7", number: 7, step: "", error: "" })).toBe("Opened pull request #7.");
    expect(doneWords({ outcome: "failed", pushed: false, url: "", number: 0, step: "push", error: "! [rejected] kit/qr (non-fast-forward)" })).toContain("the push was refused");
    expect(doneWords({ outcome: "failed", pushed: true, url: "", number: 0, step: "create", error: "token ghp_abcdefghijklmnopqrstuvwxyz0123456789" })).not.toContain("ghp_abc");
    expect(doneWords({ outcome: "failed", pushed: false, url: "", number: 0, step: "check", error: "changed" })).toBe(t("review.done.check"));
    const html = draw({ at: "closed", done: { outcome: "opened", pushed: true, url: "https://github.com/o/r/pull/7", number: 7, step: "", error: "" } });
    expect(html).toContain('data-testid="review-done-open"');
  });

  it("words every refusal, and shows anything else as the shell said it, masked", () => {
    for (const l of LANGS) {
      setLang(l);
      for (const code of ["no_remote", "not_installed", "not_signed_in", "no_commits", "base_not_on_remote", "mirror_remote", "bad_title", "bad_body", "not_a_lane", "gone", "moved", "unread", "git_missing", "bad_name", "already_decided", "withdrawn", "expired", "not_found", "changed", "no_shell", "not_this_lane", "bad_method", "bad_number", ...["closed", "draft", "conflicts", "behind", "blocked", "checking"].map((w) => `cannot_merge:${w}`)]) {
        expect(whyWords(code), `${l} ${code}`).not.toContain("review.why");
        expect(whyWords(code), `${l} ${code}`).not.toBe(code);
      }
    }
    setLang("en");
    expect(whyWords("gh: HTTP 502")).toBe("gh: HTTP 502");
  });

  it("starts a pull request's words from the lane's commits", () => {
    expect(draftOf({ branch: "kit/qr", base: "main", commits: ["Draw the QR"], count: 1 }, "PromptPay QR")).toEqual({ title: "Draw the QR", body: "" });
    expect(draftOf({ branch: "kit/qr", base: "main", commits: ["Read the amount", "Draw the QR"], count: 2 }, "PromptPay QR")).toEqual({ title: "PromptPay QR", body: "- Draw the QR\n- Read the amount" });
    expect(draftOf(null, "PromptPay QR")).toEqual({ title: "PromptPay QR", body: "" });
  });

  it("offers Suggest in the draft only when it is given, and it never asks by itself", () => {
    const step: ReviewStep = { at: "draft", title: "t", body: "b", busy: false, why: null };
    expect(draw(step)).not.toContain("review-suggest");
    const html = draw(step, { onSuggest: noop });
    expect(words(html)).toContain(t("titles.suggest"));
    expect(html).toContain("review-suggest");
    // while it writes, the button says so and waits
    const writing = draw({ ...step, writing: true }, { onSuggest: noop });
    expect(words(writing)).toContain(t("titles.suggesting"));
    expect(writing).toMatch(/disabled[^>]*data-testid="review-suggest"|data-testid="review-suggest"[^>]*disabled/);
    for (const l of LANGS) {
      setLang(l);
      expect(t("titles.suggest")).not.toBe("");
    }
  });

  it("gives a pull request run the commits, the files and a few lines of each, masked", () => {
    const m = pullMaterial(["Add the QR"], [{ path: "src/qr.ts", kind: "add", added: 2, removed: 0, lines: ["+const k = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';", "+x"] }]);
    expect(m).toContain("- Add the QR");
    expect(m).toContain("add src/qr.ts (+2 -0)");
    expect(m).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz0123456789");
  });
});
