// Ask several agents (item 102a, docs/several-agents.md "1. Ask several agents"): the person's one message, sent to up to three
// agents at once. Each row of the panel becomes an ordinary lane, started in its agent's Ask mode, and the lanes are one job
// (`SessionRec.job`). This file holds the rules that need no screen and no store, so the + menu, the panel and the sessions
// store read one answer: when the + menu offers the row, what a pick is, and why a send is refused. The rules for how many
// lanes run at once are item 102d's (`rules.ts`), not here.
import type { AccountGroup } from "../lib/protocol";
import { accountForNewSessions } from "../settings/accounts/rules";
import { chatAgents, type AgentId, type AgentInfo, type Recent } from "../sessions/agents";
import { SESSION_CLI } from "../sessions/sessionCli";

/** Three agents a message at most: item 97 carries at most three chats a message, so Compare in a chat (102c) takes the whole job,
 *  and more columns do not fit side by side at 1280 wide (docs/decisions/102-several-agents.md). */
export const MAX_ASK = 3;
/** Asking one agent is a plain chat, so Ask several takes at least two. */
export const MIN_ASK = 2;

/** A model an agent listed for itself. */
export interface ChoiceModel {
  id: string;
  label: string;
}

/** What one agent listed the last time it ran on this computer: its models and its effort levels. Before it has listed any the
 *  panel offers only "Agent's own", never a list of ours. */
export interface AgentChoice {
  models: ChoiceModel[];
  efforts: string[];
}
export type AgentChoices = Partial<Record<AgentId, AgentChoice>>;

/** One row of the panel: an agent, and the model and effort it is asked with ("" is the agent's own). */
export interface AskPick {
  agent: AgentId;
  model: string;
  effort: string;
}

/** Whether the account a new lane of `agent` would run as is at its limit, as Settings › Accounts reads it ("Limited until 14:00",
 *  or "Limited" when it names no reset). An agent with no account in the app is never limited here. `until` is the reset in
 *  seconds, null when none is named. */
export function agentLimit(groups: readonly AccountGroup[] | null, agent: AgentId): { until: number | null } | null {
  const cli = SESSION_CLI[agent];
  if (!cli) return null;
  const a = accountForNewSessions(groups ? [...groups] : null, cli);
  if (!a || a.state !== "limited") return null;
  return { until: typeof a.resets_at === "number" ? a.resets_at : null };
}

/** The chat rows that can start now: each installed chat agent that is not limited, once for each model it listed (an agent that
 *  listed none is one row). The + menu offers Ask several only when there are two or more, "two agents, or one agent with two
 *  models" (docs/several-agents.md). */
export function startableRows(agents: AgentInfo[], recent: Recent[], choices: AgentChoices, groups: readonly AccountGroup[] | null): number {
  let n = 0;
  for (const a of chatAgents(agents, recent)) {
    if (agentLimit(groups, a.id)) continue;
    n += Math.max(1, choices[a.id]?.models.length ?? 0);
  }
  return n;
}

export const offersAskSeveral = (agents: AgentInfo[] | null, recent: Recent[], choices: AgentChoices, groups: readonly AccountGroup[] | null): boolean =>
  !!agents && startableRows(agents, recent, choices, groups) >= MIN_ASK;

/** The rows a panel opens with: the first two choices, an agent or one agent's models, in the + menu's order. */
export function firstPicks(agents: AgentInfo[], recent: Recent[], choices: AgentChoices, groups: readonly AccountGroup[] | null): AskPick[] {
  const out: AskPick[] = [];
  for (const a of chatAgents(agents, recent)) {
    if (agentLimit(groups, a.id)) continue;
    const models = choices[a.id]?.models ?? [];
    if (models.length === 0) out.push({ agent: a.id, model: "", effort: "" });
    else for (const m of models) out.push({ agent: a.id, model: m.id, effort: "" });
    if (out.length >= MIN_ASK) break;
  }
  return out.slice(0, MIN_ASK);
}

/** Why a send is refused, none when it may go. Nothing starts when any row is refused, so a message is never sent to some of the
 *  agents the person picked and not the others. */
export type AskRefusal = { why: "few" | "many" | "empty" | "folder" } | { why: "agent" | "limited"; agent: AgentId };

export interface AskCheck {
  cwd: string;
  /** The message has words or files. */
  hasMessage: boolean;
  picks: readonly AskPick[];
  /** The agents the shell found here, and the accounts list as the app last read it. */
  agents: readonly AgentInfo[];
  groups: readonly AccountGroup[] | null;
}

export function askRefusal(c: AskCheck): AskRefusal | null {
  if (!c.cwd) return { why: "folder" };
  if (c.picks.length < MIN_ASK) return { why: "few" };
  if (c.picks.length > MAX_ASK) return { why: "many" };
  if (!c.hasMessage) return { why: "empty" };
  const here = chatAgents([...c.agents], []);
  for (const p of c.picks) {
    // an agent that is not installed, or that does not run as the app's chat, has no lane to start in
    if (!here.some((a) => a.id === p.agent)) return { why: "agent", agent: p.agent };
    // a limited account's row cannot be sent (Settings › Accounts words the state; the row says it too)
    if (agentLimit(c.groups, p.agent)) return { why: "limited", agent: p.agent };
  }
  return null;
}

/** A pick tidied against what its agent listed: a model or effort the agent did not list becomes its own, so the panel never
 *  sends a name the agent never offered. */
export function tidyPick(p: AskPick, choices: AgentChoices): AskPick {
  const c = choices[p.agent];
  return {
    agent: p.agent,
    model: p.model && c?.models.some((m) => m.id === p.model) ? p.model : "",
    effort: p.effort && c?.efforts.includes(p.effort) ? p.effort : "",
  };
}

// ---- what each agent listed (kept on this computer) -------------------------------------------------------------------------

export const CHOICES_KEY = "manut.agentChoices";
const MAX_MODELS = 60;

/** The saved lists; anything that cannot be read is left out, as the app's other saved lists are. */
export function parseChoices(raw: string | null | undefined): AgentChoices {
  let v: unknown;
  try {
    v = JSON.parse(raw ?? "{}");
  } catch {
    return {};
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) return {};
  const out: AgentChoices = {};
  for (const [agent, x] of Object.entries(v as Record<string, unknown>)) {
    if (!x || typeof x !== "object") continue;
    const { models, efforts } = x as { models?: unknown; efforts?: unknown };
    const ms = (Array.isArray(models) ? models : []).flatMap((m): ChoiceModel[] => {
      const o = m as Partial<ChoiceModel> | null;
      return o && typeof o.id === "string" && o.id && typeof o.label === "string" ? [{ id: o.id.slice(0, 200), label: o.label.slice(0, 200) }] : [];
    });
    const es = (Array.isArray(efforts) ? efforts : []).filter((e): e is string => typeof e === "string" && !!e).map((e) => e.slice(0, 40));
    out[agent as AgentId] = { models: ms.slice(0, MAX_MODELS), efforts: es.slice(0, 12) };
  }
  return out;
}

/** What `agent` listed now, merged into the saved lists: a part it did not send is kept as it was. */
export function withChoices(all: AgentChoices, agent: AgentId, part: Partial<AgentChoice>): AgentChoices {
  const had = all[agent] ?? { models: [], efforts: [] };
  return { ...all, [agent]: { models: part.models ?? had.models, efforts: part.efforts ?? had.efforts } };
}
