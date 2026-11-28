// The Start helpers card's ask (item 102e; `docs/several-agents.md`, "4. Helper lanes a lane asks for", rule R4): one approval of
// the lead lane per round, opened in `packages/approval-core` and settled there once, by approval-core's own rules (a request leaves
// waiting once, only an option it offered can be chosen, an id is never reused, a request asked in a turn that has ended is
// superseded). As `code/reviewAsk.ts` does for a push, this file is the only place the card's request is opened, decided or
// withdrawn; nothing an agent writes reaches it, because the parser (`helperBlocks.ts`) has no verb that answers anything.
//
// The request's kind is `command`: starting agents on this Mac changes what runs on it and spends the person's own plans, which only
// the owner decides (approval-core's `mayDecide`). On this Mac the person is the owner of their own lanes.
import { InMemoryApprovalStore, type ApprovalOption, type DecideResult, type Running } from "@manut/approval-core";
import { agentDef, asksFirst, type AgentInfo } from "../sessions/agents";
import type { ModelOption } from "../sessions/sessionTypes";
import type { HelperBrief } from "./helperBlocks";
import { ROUND_MAX } from "./rules";

/** What the card offers: Start helpers, or Not now. approval-core has no standing yes, so neither does the card. */
export const HELPERS_OPTIONS: readonly ApprovalOption[] = [
  { id: "start", label: "start helpers", effect: "approve" },
  { id: "notNow", label: "not now", effect: "decline" },
];

/** Who decides on this Mac, as approval-core records it. */
export const DECIDED_BY = "this-mac";

/** Why a named agent will not start, as the card says it. Item 102h checks again when it starts each helper lane (signed in, its
 *  account's limit); the card says only what the app already knows from the agents it found on this Mac. */
export type AgentProblem = "unknown" | "notInstalled" | "noAsks";

/** One helper lane as its card row shows it: the block's words with what the app made of its agent, model and effort. */
export interface HelperRow {
  readonly title: string;
  readonly brief: string;
  /** the agent it runs on: the one the block named, or the lead's own when it named none */
  readonly agent: string;
  /** it runs on the lead's own agent */
  readonly own: boolean;
  /** the name the block wrote when it is not an agent this Mac runs in a lane */
  readonly asked?: string;
  readonly problem?: AgentProblem;
  /** the model the block named; none: the lead's model on the lead's agent, the agent's default on another */
  readonly model?: string;
  /** the lead's own agent listed its models and this one is not among them: it starts on that agent's default */
  readonly modelUnlisted?: boolean;
  readonly effort?: string;
  readonly effortUnlisted?: boolean;
}

/** The card's request: exactly what the person is shown, kept as approval-core's `detail`. */
export interface HelpersAsk {
  readonly id: string;
  /** the lead lane's session */
  readonly lead: string;
  /** the lead's agent */
  readonly leadAgent: string;
  /** the turn whose answer asked */
  readonly turn: string;
  readonly rows: readonly HelperRow[];
  /** helpers asked for past `ROUND_MAX`, left out of the round (`openRound`'s `heldBack`) */
  readonly heldBack: number;
}

/** What the lead knows of its own agent: what it listed, so a model or an effort it does not list is said on the card. */
export interface LeadKnows {
  readonly agent: string;
  readonly models: readonly ModelOption[];
  readonly efforts: readonly string[];
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** The agent a block named, as this Mac has it: by its id or its name, in any case. One that is not found, or that does not run as a
 *  chat (an oh-my-hermes folder chat, a terminal), is not an agent a lane runs on; pi and OmO, which cannot ask before a tool runs,
 *  are named as such (item 139). */
export function resolveAgent(named: string, agents: readonly AgentInfo[] | null): { id: string; problem?: AgentProblem } {
  const found = (agents ?? []).find((a) => same(a.id, named) || same(a.label, named) || same(agentDef(a.id).label, named));
  if (found && !asksFirst(found.id)) return { id: found.id, problem: "noAsks" };
  if (!found || (found.mode ?? agentDef(found.id).mode) !== "chat") return { id: named, problem: "unknown" };
  return found.path ? { id: found.id } : { id: found.id, problem: "notInstalled" };
}

/** A card row for each helper, at most `ROUND_MAX` (the rest are counted in `heldBack`). */
export function helperRows(briefs: readonly HelperBrief[], lead: LeadKnows, agents: readonly AgentInfo[] | null): { rows: HelperRow[]; heldBack: number } {
  const rows = briefs.slice(0, ROUND_MAX).map((b): HelperRow => {
    const a = b.agent ? resolveAgent(b.agent, agents) : { id: lead.agent };
    const own = !a.problem && a.id === lead.agent;
    // only the lead's own agent has said what it lists; another agent's list is read when 102h starts it
    const modelUnlisted = !!b.model && own && lead.models.length > 0 && !lead.models.some((m) => same(m.id, b.model!) || same(m.label, b.model!));
    const effortUnlisted = !!b.effort && own && lead.efforts.length > 0 && !lead.efforts.some((e) => same(e, b.effort!));
    return {
      title: b.title,
      brief: b.brief,
      agent: a.id,
      own,
      ...(a.problem ? { asked: b.agent, problem: a.problem } : {}),
      ...(b.model ? { model: b.model } : {}),
      ...(modelUnlisted ? { modelUnlisted } : {}),
      ...(b.effort ? { effort: b.effort } : {}),
      ...(effortUnlisted ? { effortUnlisted } : {}),
    };
  });
  return { rows, heldBack: Math.max(0, briefs.length - ROUND_MAX) };
}

let store = new InMemoryApprovalStore();

/** Tests: start from no asks. */
export function resetHelpersAsks(): void {
  store = new InMemoryApprovalStore();
}

/** Opens the card's request in approval-core, stamped with the turn whose answer asked: once another turn of the lead runs, a
 *  decision on it is refused as superseded. Throws when approval-core refuses it (an id already used). */
export async function openHelpersAsk(ask: HelpersAsk): Promise<void> {
  const opened = await store.open({ id: ask.id, kind: "command", options: HELPERS_OPTIONS, turnId: ask.turn, detail: ask });
  if (!opened.ok) throw new Error(opened.refused);
}

/** The person's Start helpers or Not now on request `id`. `running` is the lead's turn now, read from the chat itself, never from
 *  the card. Only an `ok` result settled the request; a refusal left it as it was. */
export function answerHelpersAsk(id: string, start: boolean, running: Running): Promise<DecideResult> {
  return store.decide({ requestId: id, optionId: start ? "start" : "notNow", seenRevision: 1, decidedBy: DECIDED_BY, role: "owner" }, { running });
}

/** Takes a waiting request back (the person wrote to the lead again), so a later press settles nothing. */
export async function withdrawHelpersAsk(id: string): Promise<void> {
  await store.withdraw(id);
}

/** Where the request stands in approval-core (tests, and the card before it draws its buttons). */
export const helpersAskRecord = (id: string) => store.get(id);
