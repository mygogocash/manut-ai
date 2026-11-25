// Put up for review (src/code/Review.tsx), drawn with react-dom/server: the link only for a lane with no pull request yet, the draft,
// the ask with the repository, the branch, the base, the title and the body exactly as they will be sent, and every outcome and
// refusal in words, in every language.
import { afterEach, describe, expect, it } from "vitest";
import { renderToString } from "react-dom/server";
import { LANGS, setLang, t } from "../i18n";
import { doneWords, draftOf, ReviewView, whyWords, type ReviewStep, type ReviewViewProps } from "./Review";
import type { ReviewAsk } from "./source";

const words = (html: string) => html.replace(/<[^>]*>/g, " ").replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
const noop = () => {};
const ASK: ReviewAsk = {
  id: "0123456789abcdef0123456789abcdef",
  kind: "open",
  source: "github",
  repo: "mygogocash/web-app",
  remote: "origin",
  branch: "kit/promptpay-qr",
  base: "main",
  head: "a".repeat(40),
  commits: 3,
  uncommitted: 2,
  title: "Add the PromptPay QR",
  body: "- Draw the QR\n- Read the amount\n\nCo-authored-by: Ana <ana@shop.co>",
};

function draw(step: ReviewStep, over: Partial<ReviewViewProps> = {}) {
  return renderToString(<ReviewView step={step} onStart={noop} onTitle={noop} onBody={noop} onAsk={noop} onYes={noop} onNo={noop} onClose={noop} onChange={noop} {...over} />);
}

afterEach(() => setLang("en"));

describe("Put up for review", () => {
  it("offers the link only to a lane with no open pull request yet", () => {
    expect(words(draw({ at: "closed" }))).toBe(t("review.start"));
    expect(draw({ at: "closed" }, { pull: { source: "github", repo: "o/r", number: 12, state: "open", title: "x" } })).toBe("");
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
      for (const code of ["no_remote", "not_installed", "not_signed_in", "no_commits", "base_not_on_remote", "mirror_remote", "bad_title", "bad_body", "not_a_lane", "gone", "moved", "unread", "git_missing", "bad_name", "already_decided", "withdrawn", "expired", "not_found", "changed", "no_shell"]) {
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
});
