// Settings › Report a problem, drawn with react-dom/server: the report in a read-only block, the three actions, the question
// that comes before an issue, the repository the updater names, and the words in every language.
import { afterEach, describe, expect, it } from "vitest";
import { renderToString } from "react-dom/server";
import { LANGS, setLang, t } from "../i18n";
import { REPO, ReportView, type ReportViewProps } from "./ReportPage";

const words = (html: string) => html.replace(/<[^>]*>/g, " ").replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
const noop = () => {};

const props = (over: Partial<ReportViewProps> = {}): ReportViewProps => ({
  report: "Manut AI problem report\n\nApp: Manut AI 0.1.1 (GitHub)",
  onRefresh: noop,
  copied: false,
  onCopy: noop,
  agents: [{ id: "claude", label: "Claude Code" }, { id: "codex", label: "Codex" }],
  agent: "claude",
  folder: "~/code/manut",
  onAgent: noop,
  onChoose: noop,
  onAsk: noop,
  address: "https://github.com/mygogocash/manut-ai/issues/new",
  asking: false,
  onIssue: noop,
  onIssueOpen: noop,
  onIssueCancel: noop,
  ...over,
});
const draw = (over: Partial<ReportViewProps> = {}) => {
  setLang("en");
  return renderToString(<ReportView {...props(over)} />);
};

afterEach(() => setLang("en"));

describe("Settings › Report a problem", () => {
  it("shows the report in a read-only block that can be focused and scrolled, then the three actions", () => {
    const html = draw();
    expect(html).toMatch(/<pre[^>]*tabindex="0"[^>]*data-testid="report-text"/);
    expect(words(html)).toContain("App: Manut AI 0.1.1 (GitHub)");
    for (const id of ["report-copy", "report-ask", "report-issue", "report-agent", "report-folder"]) expect(html, id).toContain(`data-testid="${id}"`);
    // asking the agent says it does not send
    expect(words(html)).toContain("You read it and press Send.");
    // the question is not showing until the issue action is pressed
    expect(html).not.toContain("report-issue-ask");
  });

  it("holds the actions until the report is read", () => {
    const html = draw({ report: null });
    expect(words(html)).toContain(t("rp.reading"));
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*data-testid="report-copy"/);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*data-testid="report-ask"/);
  });

  it("says so instead of offering the agent action when no agent can chat", () => {
    const html = draw({ agents: [], agent: null });
    expect(html).not.toContain("report-ask");
    expect(words(html)).toContain(t("rp.agent.none"));
  });

  it("asks before the issue page opens, naming the address and that the text will be visible", () => {
    const html = draw({ asking: true });
    const text = words(html);
    expect(html).toContain('data-testid="report-issue-ask"');
    expect(text).toContain("https://github.com/mygogocash/manut-ai/issues/new");
    expect(text).toContain("anyone who can see that repository's issues can read it");
    expect(html).toContain("report-issue-open");
    expect(html).toContain("report-issue-cancel");
  });

  it("offers no issue action when the build names no repository", () => {
    const html = draw({ address: null });
    expect(html).not.toContain('data-testid="report-issue"');
    expect(words(html)).toContain(t("rp.issue.none"));
  });

  it("names the repository the updater already names, and no other", () => {
    expect(REPO).toBe("mygogocash/manut-ai");
  });

  it("has every word in every language, with no em-dash", () => {
    for (const lang of LANGS) {
      setLang(lang);
      for (const k of ["set.report", "rp.lead", "rp.what", "rp.reading", "rp.never", "rp.copy.title", "rp.copy.hint", "rp.copied", "rp.agent.title", "rp.agent.hint", "rp.agent.none", "rp.agent.which", "rp.agent.go", "rp.folder.choose", "rp.folder.in", "rp.issue.title", "rp.issue.hint", "rp.issue.none", "rp.issue.ask", "rp.issue.open", "rp.issue.cancel", "rp.refresh"] as const) {
        const v = t(k, { address: "ADDR" });
        expect(v, `${lang} ${k}`).not.toBe(k);
        expect(v, `${lang} ${k}`).not.toMatch(/—/);
        if (k === "rp.issue.ask") expect(v, lang).toContain("ADDR");
      }
    }
  });
});
