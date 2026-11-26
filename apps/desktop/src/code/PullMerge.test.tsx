// Merge from Tasks › Pull requests (item 100): a lane's request reaches the lane's own ask, any other the project's ask with its
// folder, and the steps are Review.tsx's own (the method, only those the repository allows; the ask with exactly what will be
// sent; the refusals in words). Nothing here can write: the ask is answered by the shell (review.rs, whose tests run the plan).
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToString } from "react-dom/server";
import { LANGS, setLang, t } from "../i18n";
import { askFor, firstMethod, PullMergeView, type MergeHost, type PullMergeViewProps } from "./PullMerge";
import { whyWords, type ReviewStep } from "./Review";
import type { ReviewAsk } from "./source";
import type { BoardRow } from "../tasks/board";

const words = (html: string) => html.replace(/<[^>]*>/g, " ").replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
const noop = () => {};
const ROW: BoardRow = {
  source: "github",
  repo: "shop/site",
  folder: "/code/site",
  pull: { number: 41, title: "Make the QR code bigger", state: "open", url: "", labels: [], author: "noi", created: 0, updated: 0, checks: null, head: "fix/qr-size", same: true, from: "shop/site", review: "approved", conflict: false, base: "main" },
};
const ASK: ReviewAsk = { id: "f".repeat(32), kind: "merge", source: "github", repo: "shop/site", remote: "origin", from: "shop/site", branch: "fix/qr-size", base: "main", head: "c".repeat(40), commits: 1, uncommitted: 0, title: "Make the QR code bigger", body: "", number: 41, url: "https://github.com/shop/site/pull/41", method: "squash", subject: "Make the QR code bigger (#41)", message: "* Make the QR code bigger", dropped: 0 };

function draw(step: ReviewStep, over: Partial<PullMergeViewProps> = {}) {
  return renderToString(<PullMergeView step={step} draft={false} methods={["merge", "squash", "rebase"]} onStart={noop} onMethod={noop} onAsk={noop} onYes={noop} onNo={noop} onClose={noop} onChange={noop} {...over} />);
}

afterEach(() => setLang("en"));

describe("which ask a request reaches", () => {
  it("a lane's request is asked as the lane's own Merge, with the lane's folder", async () => {
    const host: MergeHost = { reviewMerge: vi.fn(async () => ASK), reviewMergePull: vi.fn(async () => ASK) };
    await askFor(host, ROW, "/lanes/site/qr", "squash", true);
    expect(host.reviewMerge).toHaveBeenCalledWith("/lanes/site/qr", 41, "squash", true);
    expect(host.reviewMergePull).not.toHaveBeenCalled();
  });

  it("any other request is asked for the project's folder, its repository and number, and nothing else", async () => {
    const host: MergeHost = { reviewMerge: vi.fn(async () => ASK), reviewMergePull: vi.fn(async () => ASK) };
    await askFor(host, ROW, null, "merge", false);
    expect(host.reviewMergePull).toHaveBeenCalledWith("/code/site", "github", "shop/site", 41, "merge", false);
    expect(host.reviewMerge).not.toHaveBeenCalled();
    // a shell without the list's ask asks nothing
    await expect(askFor({}, ROW, null, "merge", false)).rejects.toThrow("no_shell");
  });

  it("starts on the person's method when the repository allows it, else on the first it allows", () => {
    expect(firstMethod("merge", ["merge", "squash", "rebase"])).toBe("merge");
    expect(firstMethod("merge", ["squash"])).toBe("squash");
    expect(firstMethod("rebase", [])).toBe("rebase");
  });
});

describe("the steps", () => {
  it("offers Merge as the one dark button, and none for a draft", () => {
    const html = draw({ at: "closed" });
    expect(html).toContain('data-testid="pr-merge-start"');
    expect(html).toContain("btn dark");
    expect(words(html)).toContain(t("prs.merge"));
    expect(draw({ at: "closed" }, { draft: true })).not.toContain("pr-merge-start");
  });

  it("offers only the methods the repository allows", () => {
    const html = draw({ at: "method", method: "squash", busy: false, why: null }, { methods: ["squash"] });
    expect(html).toContain('value="squash"');
    expect(html).not.toContain('value="merge"');
    expect(html).not.toContain('value="rebase"');
    // all three when the repository's were not read
    const all = draw({ at: "method", method: "merge", busy: false, why: null });
    for (const m of ["merge", "squash", "rebase"]) expect(all).toContain(`value="${m}"`);
  });

  it("shows the lane's own ask card, naming the repository, the branch and exactly the message", () => {
    const text = words(draw({ at: "ask", ask: ASK, busy: false, why: null }));
    expect(text).toContain("shop/site");
    expect(text).toContain("fix/qr-size");
    expect(text).toContain("Make the QR code bigger (#41)");
    expect(text).toContain("* Make the QR code bigger");
  });

  it("says why in every language when the request is not the project's or the method is not allowed", () => {
    for (const lang of LANGS) {
      setLang(lang);
      for (const code of ["not_this_project", "method_not_allowed"]) {
        expect(whyWords(code)).not.toBe(code);
        expect(words(draw({ at: "method", method: "merge", busy: false, why: code }))).toContain(whyWords(code));
      }
    }
  });

  it("after a merge says so and offers no second Merge", () => {
    const html = draw({ at: "closed", kind: "merge", done: { outcome: "merged", pushed: false, url: ASK.url, number: 41, step: "", error: "" } });
    expect(words(html)).toContain(t("review.done.merged", { n: 41 }));
    expect(html).not.toContain("pr-merge-start");
  });
});
