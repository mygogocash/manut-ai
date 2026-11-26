// Tasks › Pull requests (item 100), drawn with react-dom/server: the requests under grey bands by readiness, readiest first, each
// row with its repository, number, author, checks, review and whether it is a lane's; the detail with the description as plain
// text, the checks, the files and their counts, Open on the host, and no Merge for a fork's request; and the empty states.
import { afterEach, describe, expect, it } from "vitest";
import { renderToString } from "react-dom/server";
import { LANGS, setLang, t } from "../i18n";
import { checksWord, methodsOf, PullDetailView, PullsListView, reviewWord, rowKey, type PullsListViewProps } from "./PullsView";
import type { BoardRow } from "./board";
import type { PullDetail, PullRow } from "./types";

const words = (html: string) => html.replace(/<[^>]*>/g, " ").replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/\s+/g, " ").trim();
const noop = () => {};
const NOW = 2_000_000_000_000;
const pull = (number: number, over: Partial<PullRow> = {}): PullRow => ({
  number,
  title: `Change ${number}`,
  state: "open",
  url: `https://github.com/shop/site/pull/${number}`,
  labels: [],
  author: "noi",
  created: NOW / 1000 - 7200,
  updated: NOW / 1000 - 3600,
  checks: { passed: 2, failed: 0, pending: 0, total: 2 },
  head: `b${number}`,
  same: true,
  from: "shop/site",
  review: "",
  conflict: false,
  base: "main",
  ...over,
});
const row = (p: PullRow): BoardRow => ({ source: "github", repo: "shop/site", folder: "/code/site", pull: p });
const ROWS = [row(pull(41, { review: "approved", title: "Make the QR code bigger" })), row(pull(42, { checks: { passed: 1, failed: 0, pending: 1, total: 2 } })), row(pull(43, { review: "changes" })), row(pull(44, { state: "draft" }))];

function list(over: Partial<PullsListViewProps> = {}) {
  return renderToString(<PullsListView state={{ rows: ROWS, errors: [], repos: [{ source: "github", repo: "shop/site", folder: "/code/site" }], at: 1 }} noProjects={false} selected={null} isLane={(r) => r.pull.number === 41} onOpen={noop} onRetry={noop} now={NOW} {...over} />);
}

afterEach(() => setLang("en"));

describe("the list", () => {
  it("groups the requests under bands in readiness order, each row with its repository, number, author, age, checks and review", () => {
    const html = list();
    const order = ["ready", "checks", "changes", "draft"].map((g) => html.indexOf(`data-testid="prs-group-${g}"`));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    const text = words(html);
    expect(text).toContain(t("prs.band.ready"));
    expect(text).toContain("Make the QR code bigger");
    expect(text).toContain(t("prs.line", { repo: "shop/site", n: 41, author: "noi", age: t("unit.h", { n: 1 }) }));
    expect(text).toContain(t("prs.checks.passed"));
    expect(text).toContain(t("prs.review.approved"));
    expect(text).toContain(t("prs.checks.running", { n: 1 }));
    expect(text).toContain(t("prs.review.changes"));
    // the lane's request says so, and only it
    expect(html.match(/data-testid="prs-lane"/g)?.length).toBe(1);
  });

  it("names the chat that opened a request itself, on its row and in its detail", () => {
    const text = words(list({ chatOf: (r) => (r.pull.number === 42 ? "Order total" : null) }));
    expect(text).toContain(t("prs.chat", { title: "Order total" }));
    expect(text.split(t("prs.chat", { title: "Order total" })).length).toBe(2);
    const html = renderToString(<PullDetailView row={row(pull(42))} detail={null} error={null} chat="Order total" onOpenChat={noop} onClose={noop} onOpenUrl={noop} />);
    expect(html).toContain('data-testid="prs-open-chat"');
    expect(words(html)).toContain(t("prs.openChat", { title: "Order total" }));
    expect(renderToString(<PullDetailView row={row(pull(42))} detail={null} error={null} onClose={noop} onOpenUrl={noop} />)).not.toContain("prs-open-chat");
  });

  it("colours a check only by what it means", () => {
    expect(checksWord(pull(1)).tone).toBe("ok");
    expect(checksWord(pull(1, { checks: { passed: 1, failed: 1, pending: 1, total: 3 } }))).toEqual({ text: t("prs.checks.failing", { n: 1 }), tone: "fail" });
    expect(checksWord(pull(1, { checks: { passed: 0, failed: 0, pending: 2, total: 2 } })).tone).toBe("run");
    expect(checksWord(pull(1, { checks: null })).tone).toBe("none");
    expect(reviewWord(pull(1))).toBe("");
  });

  it("says why it is empty: no project, no project on a host, no open request, a repository that failed", () => {
    expect(list({ noProjects: true })).toContain("prs-noprojects");
    expect(list({ state: { rows: [], errors: [], repos: [], at: null } })).toContain("prs-norepos");
    expect(list({ state: { rows: [], errors: [], repos: [{ source: "github", repo: "shop/site", folder: "/a" }], at: 1 } })).toContain("prs-none");
    const failed = words(list({ state: { rows: [], errors: [{ source: "github", repo: "shop/gone", error: "not found" }], repos: [{ source: "github", repo: "shop/gone", folder: "/a" }], at: 1 } }));
    expect(failed).toContain(t("prs.failed", { repo: "shop/gone", error: "not found" }));
    expect(failed).not.toContain(t("prs.none"));
  });

  it("has every word in every language", () => {
    for (const lang of LANGS) {
      setLang(lang);
      const text = words(list());
      for (const k of ["prs.band.ready", "prs.band.checks", "prs.band.changes", "prs.band.draft", "prs.lane"] as const) expect(text).toContain(t(k));
    }
  });
});

const DETAIL: PullDetail = {
  pull: pull(41, { review: "approved", title: "Make the QR code bigger", head: "fix/qr-size" }),
  body: "Makes the QR **bigger**.\n\n<img src=x onerror=alert(1)> [a link](https://example.com)",
  checks: [{ name: "build", state: "passed", url: "" }, { name: "test", state: "failed", url: "" }],
  files: [{ path: "src/qr.ts", additions: 12, deletions: 3 }, { path: "src/qr.test.ts", additions: 20, deletions: 0 }],
  additions: 32,
  deletions: 3,
  changed: 5,
};

describe("a request opened in the app", () => {
  it("shows the description as plain text, the checks, the files and their counts, and Open on the host", () => {
    const html = renderToString(<PullDetailView row={row(DETAIL.pull)} detail={DETAIL} error={null} merge={<span data-testid="merge-here" />} onClose={noop} onOpenUrl={noop} />);
    const text = words(html);
    expect(text).toContain("Make the QR code bigger");
    expect(text).toContain(t("prs.into", { branch: "fix/qr-size", base: "main" }));
    // nothing in the description is drawn: no bold, no picture, no link
    expect(html).not.toContain("<strong");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<a ");
    expect(text).toContain("Makes the QR **bigger**.");
    expect(text).toContain("build");
    expect(text).toContain(t("tasks.ck.failed"));
    expect(text).toContain("src/qr.ts +12 -3");
    expect(text).toContain(t("prs.counts", { files: 5, add: 32, del: 3 }));
    expect(text).toContain(t("prs.moreFiles", { n: 3, host: "GitHub" }));
    expect(text).toContain(t("prs.openOn", { host: "GitHub" }));
    expect(html).toContain('data-testid="merge-here"');
  });

  it("offers no Merge for a request from another repository, and says where to merge it", () => {
    const fork = pull(46, { same: false, from: "stranger/site" });
    const html = renderToString(<PullDetailView row={row(fork)} detail={null} error={null} merge={<span data-testid="merge-here" />} onClose={noop} onOpenUrl={noop} />);
    expect(html).not.toContain("merge-here");
    expect(words(html)).toContain(t("prs.fork", { from: "stranger/site", host: "GitHub" }));
    // GitLab names no fork's repository: the note says so without a name
    const gl = renderToString(<PullDetailView row={{ ...row(pull(5, { same: false, from: "" })), source: "gitlab" }} detail={null} error={null} merge={<span data-testid="merge-here" />} onClose={noop} onOpenUrl={noop} />);
    expect(gl).not.toContain("merge-here");
    expect(words(gl)).toContain(t("prs.forkNoName", { host: "GitLab" }));
  });

  it("reads GitLab's count of changed files alone", () => {
    const gl: PullDetail = { ...DETAIL, files: [], additions: null, deletions: null, changed: 1000 };
    expect(words(renderToString(<PullDetailView row={{ ...row(gl.pull), source: "gitlab" }} detail={gl} error={null} onClose={noop} onOpenUrl={noop} />))).toContain(t("prs.countsFiles", { files: 1000 }));
  });

  it("knows a request by its repository and number, and offers the methods a repository allows", () => {
    expect(rowKey(row(pull(7)))).toBe("github:shop/site:7");
    expect(methodsOf({ merge: false, squash: true, rebase: true, read: true })).toEqual(["squash", "rebase"]);
    expect(methodsOf(null)).toEqual(["merge", "squash", "rebase"]);
  });
});
