// The Ask several agents panel (item 102a, docs/several-agents.md "1. Ask several agents"): what the + menu's row opens. Up to
// three rows, each an agent with the account it runs as and that account's state, its model and its effort, and one message box
// under them, the chat box of item 80 (text, files, a folder by path) without Mention. Send starts one lane for each row through
// the sessions store's `startJob`; nothing starts before then, and an agent never starts another one.
//
// `AskSeveralView` takes everything it shows as props and uses no hooks, so a test can draw it and press its parts; the box is a
// slot, since the real chat box reads the stores. `AskSeveralPanel` reads the stores and fills the view.
import { useState, type ReactNode } from "react";
import "./ask.css";
import { Composer } from "../chat/parts/Composer";
import { setDraft } from "../app/drafts";
import { useAccounts } from "../settings/accounts/useAccounts";
import { clock } from "../sidebar/usageFormat";
import { t } from "../i18n";
import type { Bot } from "../lib/protocol";
import type { OutFile } from "../state/store";
import { AgentMark } from "../sessions/AgentMark";
import { agentLabel, chatAgents, folderName, offeredAgents, type AgentId } from "../sessions/agents";
import { agentSignedOut } from "../sessions/signedOut";
import { getSessions, useSessions } from "../sessions/sessions";
import { Icon } from "../ui";
import { agentLimit, askRefusal, firstPicks, MAX_ASK, MIN_ASK, tidyPick, type AgentChoices, type AskPick, type AskRefusal } from "./ask";
import { useAgentChoices } from "./choices";

/** One row as the view draws it. */
export interface AskRowView {
  pick: AskPick;
  /** The agents this row may be switched to, each with its name; a limited one is shown but cannot be picked. */
  agents: { id: AgentId; label: string; limit: string }[];
  /** The account a new lane of the agent runs as ("" for the CLI's own), and its state in Settings › Accounts' words. */
  account: string;
  limit: string;
  signedOut: boolean;
  models: { id: string; label: string }[];
  efforts: string[];
}

export interface AskSeveralViewProps {
  /** The folder the lanes are made from (the + menu's folder chip). */
  folder: string;
  rows: AskRowView[];
  onAgent: (i: number, agent: AgentId) => void;
  onModel: (i: number, model: string) => void;
  onEffort: (i: number, effort: string) => void;
  onAdd?: () => void;
  onRemove?: (i: number) => void;
  onBack: () => void;
  /** Why the message cannot be sent now, in words (a limited account's row), or "". */
  blocked: string;
  /** Why the last send was refused, in words, or "". */
  problem: string;
  /** The message box. */
  box: ReactNode;
}

/** "Limited until 14:00" as Settings › Accounts words it, or "Limited" when the account names no reset. */
export function limitWord(limit: { until: number | null } | null, nowS: number): string {
  if (!limit) return "";
  return limit.until !== null && limit.until > nowS ? t("acc.limitedUntil", { when: clock(limit.until, nowS) }) : t("acc.limited");
}

const effortWord = (e: string) => e.charAt(0).toUpperCase() + e.slice(1);

export function AskSeveralView(p: AskSeveralViewProps) {
  return (
    <div className="ask-panel" data-testid="ask-panel">
      {/* the heading and the explanation stay in view; only the rows and the box scroll under them */}
      <div className="ask-head">
      <div className="ask-top">
        <button type="button" role="menuitem" className="ask-back" onClick={p.onBack} aria-label={t("several.back")} title={t("several.back")} data-testid="ask-back">
          <Icon name="chevron-left" />
        </button>
        <span className="ask-title">{t("several.title")}</span>
        <span className="ask-folder mono" data-testid="ask-folder" title={p.folder}>
          {p.folder ? folderName(p.folder) : ""}
        </span>
      </div>
      <p className="ask-lead">{t("several.lead", { max: MAX_ASK })}</p>
      </div>
      <div className="ask-rows" data-testid="ask-rows">
        {p.rows.map((r, i) => (
          <div key={i} className={`ask-row${r.limit ? " limited" : ""}`} data-testid={`ask-row-${i}`} data-agent={r.pick.agent} data-limited={r.limit ? "true" : undefined}>
            <div className="ask-r1">
              <span className="ask-mark" aria-hidden="true">
                <AgentMark agent={r.pick.agent} size={16} />
              </span>
              <select className="ask-sel ask-agent" aria-label={t("several.agent")} value={r.pick.agent} onChange={(e) => p.onAgent(i, e.target.value as AgentId)} data-testid={`ask-agent-${i}`}>
                {r.agents.map((a) => (
                  <option key={a.id} value={a.id} disabled={!!a.limit && a.id !== r.pick.agent}>
                    {a.limit ? `${a.label} · ${a.limit}` : a.label}
                  </option>
                ))}
              </select>
              {p.onRemove && p.rows.length > MIN_ASK && (
                <button type="button" className="ask-x" onClick={() => p.onRemove?.(i)} aria-label={t("several.remove")} title={t("several.remove")} data-testid={`ask-remove-${i}`}>
                  <Icon name="x" />
                </button>
              )}
            </div>
            <div className="ask-r2">
              <select className="ask-sel" aria-label={t("several.model")} value={r.pick.model} onChange={(e) => p.onModel(i, e.target.value)} data-testid={`ask-model-${i}`}>
                <option value="">{t("several.own")}</option>
                {r.models.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label}
                  </option>
                ))}
              </select>
              <select className="ask-sel ask-effort" aria-label={t("several.effort")} value={r.pick.effort} onChange={(e) => p.onEffort(i, e.target.value)} data-testid={`ask-effort-${i}`} disabled={r.efforts.length === 0}>
                <option value="">{t("several.own")}</option>
                {r.efforts.map((e) => (
                  <option key={e} value={e}>
                    {effortWord(e)}
                  </option>
                ))}
              </select>
            </div>
            {(r.account || r.limit || r.signedOut) && (
              <div className="ask-r3">
                {r.account && (
                  <span className="mut" data-testid={`ask-account-${i}`}>
                    {r.account}
                  </span>
                )}
                {r.limit && (
                  <span className="ask-state ask-limit" role="status" data-testid={`ask-limit-${i}`}>
                    {r.limit}
                  </span>
                )}
                {!r.limit && r.signedOut && (
                  <span className="ask-state" data-testid={`ask-signedout-${i}`}>
                    {t("ss.notSignedIn")}
                  </span>
                )}
              </div>
            )}
          </div>
        ))}
      </div>
      {p.onAdd && p.rows.length < MAX_ASK && (
        <button type="button" role="menuitem" className="lk ask-add" onClick={p.onAdd} data-testid="ask-add">
          {t("several.add")}
        </button>
      )}
      {p.rows.length >= MAX_ASK && (
        <p className="mut ask-cap" data-testid="ask-cap">
          {t("several.cap", { max: MAX_ASK })}
        </p>
      )}
      {p.blocked && (
        <p className="ask-err" role="status" data-testid="ask-blocked">
          {p.blocked}
        </p>
      )}
      {p.problem && (
        <p className="ask-err" role="alert" data-testid="ask-problem">
          {p.problem}
        </p>
      )}
      <div className="ask-box" data-testid="ask-box">
        {p.box}
      </div>
      <p className="mut ask-foot">{t("several.foot")}</p>
    </div>
  );
}

/** The words for a refusal. */
export function refusalWords(r: AskRefusal, agents: Parameters<typeof agentLabel>[1]): string {
  switch (r.why) {
    case "few":
      return t("several.err.few", { min: MIN_ASK });
    case "many":
      return t("several.err.many", { max: MAX_ASK });
    case "empty":
      return t("several.err.empty");
    case "folder":
      return t("several.err.folder");
    case "agent":
      return t("several.err.agent", { agent: agentLabel(r.agent, agents) });
    case "limited":
      return t("several.err.limited", { agent: agentLabel(r.agent, agents) });
  }
}

/** The panel's own box key: its unsent text is kept as any chat's is (app/drafts.ts). */
const BOX_KEY = "agent:several";

export function AskSeveralPanel({ at, accountWord, onBack, onClose }: { at: string; accountWord: (agent: AgentId) => string; onBack: () => void; onClose: () => void }) {
  const ss = useSessions();
  const accounts = useAccounts();
  const choices = useAgentChoices();
  const nowS = Math.floor(Date.now() / 1000);
  const here = chatAgents(offeredAgents(ss.agents ?? []), ss.recent);
  const [picks, setPicks] = useState<AskPick[]>(() => firstPicks(offeredAgents(ss.agents ?? []), ss.recent, choices, accounts.groups));
  const [problem, setProblem] = useState("");
  // the box is made again after a refused send, so the words the person typed come back (the box clears what it sends)
  const [again, setAgain] = useState(0);
  const change = (i: number, part: Partial<AskPick>) => setPicks((cur) => cur.map((p, j) => (j === i ? { ...p, ...part } : p)));
  const rows: AskRowView[] = picks.map((pick) => {
    const c = choices[pick.agent];
    return {
      pick,
      agents: here.map((a) => ({ id: a.id, label: agentLabel(a.id, ss.agents), limit: limitWord(agentLimit(accounts.groups, a.id), nowS) })),
      account: accountWord(pick.agent),
      limit: limitWord(agentLimit(accounts.groups, pick.agent), nowS),
      signedOut: agentSignedOut(accounts, pick.agent),
      models: c?.models ?? [],
      efforts: c?.efforts ?? [],
    };
  });
  // a limited account's row cannot be sent: the box is held, and says which row
  const limited = picks.find((p) => agentLimit(accounts.groups, p.agent));
  const blocked = limited ? t("several.err.limited", { agent: agentLabel(limited.agent, ss.agents) }) : "";
  const send = async (text: string, files: OutFile[] = []) => {
    setProblem("");
    const tidy = picks.map((p) => tidyPick(p, choices as AgentChoices));
    const refused = askRefusal({ cwd: at, hasMessage: !!text.trim() || files.length > 0, picks: tidy, agents: ss.agents ?? [], groups: accounts.groups });
    const res = refused ? { ok: false as const, refused, ids: [] as string[] } : await getSessions().startJob({ cwd: at, text, files, picks: tidy });
    if (res.ok) return onClose();
    const words = res.refused.why === "no_lane" ? t("several.err.noLane") : refusalWords(res.refused, ss.agents);
    setProblem(words);
    // the words come back in a fresh box; files stay in the one that threw
    setDraft(BOX_KEY, text);
    setAgain((n) => n + 1);
    throw new Error(words);
  };
  const bot: Bot = { name: BOX_KEY, display_name: t("several.title"), is_default: false, model: "", provider: "", description: "", status: "online", running: false };
  return (
    <AskSeveralView
      folder={at}
      rows={rows}
      onAgent={(i, agent) => change(i, { agent, model: "", effort: "" })}
      onModel={(i, model) => change(i, { model })}
      onEffort={(i, effort) => change(i, { effort })}
      onAdd={() => {
        const next = here.find((a) => !agentLimit(accounts.groups, a.id) && !picks.some((p) => p.agent === a.id)) ?? here.find((a) => !agentLimit(accounts.groups, a.id));
        if (next) setPicks((cur) => [...cur, { agent: next.id, model: "", effort: "" }]);
      }}
      onRemove={(i) => setPicks((cur) => cur.filter((_, j) => j !== i))}
      onBack={onBack}
      blocked={blocked}
      problem={problem}
      box={
        <Composer
          key={`${BOX_KEY}:${again}`}
          bot={bot}
          running={false}
          offline={!!limited || !at}
          offlineText={limited ? blocked : t("sessions.findingHome")}
          onSend={(text) => void send(text).catch(() => undefined)}
          onSendFiles={(text, files) => send(text, files)}
          onFolder={() => getSessions().pickFolder(at)}
          onStop={() => undefined}
          steers={false}
          rows
        />
      }
    />
  );
}
