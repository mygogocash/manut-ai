// Settings › Report a problem (item 105). One page that gathers what is wrong on this computer, shows it, and then offers
// three things, none of which sends anything by itself:
//
// - Copy: the report, on the clipboard.
// - Ask my coding agent to fix it: a new coding chat on an agent the person picks, in a folder they pick, with the report in
//   its box. It is NOT sent: the person reads it and presses Send (the same draft a "Continue with" or a stashed draft makes).
// - Draft an issue: the repository's new-issue page in the browser, with the title and the report filled in, only after the page
//   names the address and says the text will be visible there. The repository is the one the updater already names
//   (tauri.conf.json), never another.
//
// `ReportView` draws a given state so a test can draw each one; `ReportPage` reads the computer and acts. What the report holds
// and never holds is report.ts's; the page says it in its own words under the report.
import { useCallback, useEffect, useMemo, useState } from "react";
import { t } from "../i18n";
import { getStore, useStore } from "../state/store";
import { getSessions, useSessions } from "../sessions/sessions";
import { agentLabel, chatAgents, draftAgent, draftFolder, offeredAgents, tildePath, type AgentId } from "../sessions/agents";
import { setDraft } from "../app/drafts";
import { openExternal } from "../lib/openExternal";
import conf from "../../src-tauri/tauri.conf.json";
import { Row } from "../settings/DevRow";
import "./report.css";
import { gather } from "./gather";
import { buildReport, issueOf, issueUrl, repoOf, type ReportInput } from "./report";

/** `owner/name` of the repository the updater already names. */
export const REPO = repoOf(conf.plugins.updater.endpoints[0] ?? "");

export interface ReportViewProps {
  /** The report, or null while it is read. */
  report: string | null;
  onRefresh: () => void;
  copied: boolean;
  onCopy: () => void;
  /** The agents a coding chat can start on, and the one and the folder picked. */
  agents: { id: AgentId; label: string }[];
  agent: AgentId | null;
  folder: string;
  onAgent: (id: AgentId) => void;
  onChoose: () => void;
  onAsk: () => void;
  /** The address the issue action would open; null when the repository is not known. */
  address: string | null;
  /** Whether the question about opening it is showing. */
  asking: boolean;
  onIssue: () => void;
  onIssueOpen: () => void;
  onIssueCancel: () => void;
}

export function ReportView(p: ReportViewProps) {
  const none = p.agents.length === 0;
  return (
    <div className="st-page rp" data-testid="report-page">
      <div className="st-gh st-gh0">{t("set.report")}</div>
      <p className="rp-lead">{t("rp.lead")}</p>
      <div className="st-gh">{t("rp.what")}</div>
      <pre className="rp-text" tabIndex={0} aria-label={t("rp.what")} aria-busy={p.report === null} data-testid="report-text" data-ready={String(p.report !== null)}>
        {p.report ?? t("rp.reading")}
      </pre>
      <div className="st-note">{t("rp.never")}</div>
      <div className="st-grp rp-acts">
        <Row title={t("rp.copy.title")} hint={t("rp.copy.hint")}>
          <button type="button" className="st-btn" onClick={p.onCopy} disabled={p.report === null} aria-live="polite" data-testid="report-copy">
            {p.copied ? t("rp.copied") : t("rp.copy.title")}
          </button>
        </Row>
        <Row title={t("rp.agent.title")} hint={none ? t("rp.agent.none") : t("rp.agent.hint")}>
          {!none && (
            <span className="rp-pick">
              <select className="dev-in rp-sel" value={p.agent ?? ""} aria-label={t("rp.agent.which")} onChange={(e) => p.onAgent(e.currentTarget.value as AgentId)} data-testid="report-agent">
                {p.agents.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.label}
                  </option>
                ))}
              </select>
              <button type="button" className="st-btn" onClick={p.onChoose} title={p.folder} aria-label={p.folder ? `${t("rp.folder.choose")}: ${p.folder}` : t("rp.folder.choose")} data-testid="report-folder">
                {p.folder ? t("rp.folder.in", { path: p.folder }) : t("rp.folder.choose")}
              </button>
              <button type="button" className="st-btn dark" onClick={p.onAsk} disabled={p.report === null || !p.agent} data-testid="report-ask">
                {t("rp.agent.go")}
              </button>
            </span>
          )}
        </Row>
        <Row title={t("rp.issue.title")} hint={p.address ? t("rp.issue.hint") : t("rp.issue.none")}>
          {p.address && (
            <button type="button" className="st-btn" onClick={p.onIssue} disabled={p.report === null || p.asking} data-testid="report-issue">
              {t("rp.issue.title")}
            </button>
          )}
        </Row>
      </div>
      {p.asking && p.address && (
        <div className="rp-ask" role="group" aria-label={t("rp.issue.title")} data-testid="report-issue-ask">
          <p>{t("rp.issue.ask", { address: p.address })}</p>
          <span className="rp-ask-btns">
            <button type="button" className="st-btn" onClick={p.onIssueOpen} data-testid="report-issue-open">
              {t("rp.issue.open")}
            </button>
            <button type="button" className="st-btn" onClick={p.onIssueCancel} data-testid="report-issue-cancel">
              {t("rp.issue.cancel")}
            </button>
          </span>
        </div>
      )}
      <div className="st-note">
        <button type="button" className="st-btn" onClick={p.onRefresh} data-testid="report-refresh">
          {t("rp.refresh")}
        </button>
      </div>
    </div>
  );
}

export function ReportPage() {
  const s = useStore();
  const ss = useSessions();
  const [input, setInput] = useState<ReportInput | null>(null);
  const report = useMemo(() => (input ? buildReport(input) : null), [input]);
  const [copied, setCopied] = useState(false);
  const [asking, setAsking] = useState(false);
  const [agent, setAgent] = useState<AgentId | null>(null);
  const [folder, setFolder] = useState<string | null>(null);

  const read = useCallback(() => {
    setInput(null);
    void gather().then(setInput, () => setInput({ app: "", edition: "github", macos: "", chip: "", agents: [], git: { installed: false, version: "" }, errors: [], switches: [], home: "" }));
  }, []);
  useEffect(read, [read]);
  useEffect(() => {
    if (ss.agents === null) void getSessions().loadAgents();
  }, [ss.agents]);

  const offered = useMemo(() => (ss.agents ? chatAgents(offeredAgents(ss.agents), ss.recent) : []), [ss.agents, ss.recent]);
  const agents = offered.map((a) => ({ id: a.id, label: agentLabel(a.id, ss.agents) }));
  const first = ss.agents ? draftAgent(ss.recent, ss.agents) : null;
  const chosen = agent && agents.some((a) => a.id === agent) ? agent : agents.some((a) => a.id === first) ? first : (agents[0]?.id ?? null);
  const at = folder ?? draftFolder(ss.recent, ss.home);
  const address = REPO ? `https://github.com/${REPO}/issues/new` : null;

  const copy = () => {
    if (report === null) return;
    void navigator.clipboard?.writeText(report).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1800);
      },
      () => undefined,
    );
  };
  const ask = () => {
    if (report === null || !chosen) return;
    s.openPage("code");
    const id = getSessions().draftChat(chosen, at || undefined);
    // shown in the chat's box and kept as its unsent text; nothing is sent, the person presses Send
    const key = `agent:${id}`;
    setDraft(key, report);
    getStore().dispatch({ type: "ui.draft", bot: key, text: report });
  };
  const open = () => {
    if (report === null || !input || !REPO) return;
    setAsking(false);
    void openExternal(issueUrl(REPO, issueOf(report, input.app)));
  };
  const choose = async () => {
    const got = await getSessions().pickFolder(at || ss.home || "");
    if (got) setFolder(got);
  };

  return (
    <ReportView
      report={report}
      onRefresh={read}
      copied={copied}
      onCopy={copy}
      agents={agents}
      agent={chosen}
      folder={at ? tildePath(at, ss.home) : ""}
      onAgent={setAgent}
      onChoose={() => void choose()}
      onAsk={ask}
      address={address}
      asking={asking}
      onIssue={() => setAsking(true)}
      onIssueOpen={open}
      onIssueCancel={() => setAsking(false)}
    />
  );
}
