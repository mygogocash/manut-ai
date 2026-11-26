// Continue with… (item 97): a coding chat handed to another agent or model mid-way. The old chat's agent chip offers the installed
// agents that chat (and the other models of its own agent); a pick makes a NEW chat in the same lane or folder, linked from the
// old one both ways ("Continued in …", "Continued from …"), with the old chat's context above its box as one chip, unsent
// (chat/box/threadContext.ts). No turn starts: the new agent starts only with the person's first message, as any New session
// does. The old chat is left as it is; it is stopped only if it is idle and the person says so.
//
// One lane, one working agent (decided 26 Nov 2026, docs/decisions.md): the two chats share the lane's folder and branch, so
// while one of them works (its turn runs, an ask of it included), the other's box holds what is typed and does not send; the
// line under it says who works there. The rule binds only chats linked this way, so two chats the person opened on their own in
// one folder go on as before. The lane's folder goes only when the last chat in it is closed.
import { workDir } from "../code/laneBranch";
import type { AgentId, AgentInfo, SessionRec } from "./agents";
import type { ModelOption } from "./sessions";

/** What the menu offers: an agent, and for the chat's own agent a model of the ones it listed. */
export interface ContinuePick {
  agent: AgentId;
  model?: { id: string; label: string };
}

/** The picks for chat `rec`: its own agent's other models first (the ones it listed, not the one it runs), then each other
 *  installed agent that chats (`chatting`, in the + menu's order), with its own default model. */
export function continuePicks(rec: Pick<SessionRec, "agent" | "model">, chatting: readonly AgentInfo[], models: readonly ModelOption[] | undefined): ContinuePick[] {
  const own = (models ?? []).filter((m) => m.label !== rec.model && m.id !== rec.model).map((m): ContinuePick => ({ agent: rec.agent, model: { id: m.id, label: m.label } }));
  const others = chatting.filter((a) => a.id !== rec.agent).map((a): ContinuePick => ({ agent: a.id }));
  return [...own, ...others];
}

/** The new chat that continues `old` with `pick`: a draft in the same folder and, for a lane, the same lane (no second folder or
 *  branch is made), linked to `old` by its link id. Its own agent keeps `old`'s account, so a chat continues under the account
 *  it ran as; another agent runs as the account picked for its new chats. `modelWant` is set when its agent starts. */
export function continuedDraft(old: SessionRec, pick: ContinuePick, made: { id: string; linkId: string; now: number }): SessionRec {
  const same = pick.agent === old.agent;
  return {
    id: made.id,
    linkId: made.linkId,
    agent: pick.agent,
    cwd: old.cwd,
    startedAt: made.now,
    status: "draft",
    view: "chat",
    ...(old.lane ? { lane: old.lane } : {}),
    ...(old.linkId ? { continuedFrom: old.linkId } : {}),
    ...(same && old.account ? { account: old.account } : {}),
    ...(same && old.startedAs ? { startedAs: old.startedAs } : {}),
    ...(pick.model ? { modelWant: pick.model.id } : {}),
  };
}

/** The chats linked to `rec` by Continue with: the one it continued from and the ones continued from it. */
export function linkedOf(list: readonly SessionRec[], rec: Pick<SessionRec, "id" | "linkId" | "continuedFrom">): SessionRec[] {
  return list.filter((r) => r.id !== rec.id && ((!!rec.continuedFrom && r.linkId === rec.continuedFrom) || (!!rec.linkId && r.continuedFrom === rec.linkId)));
}

/** The linked chat that works in `rec`'s folder now (`working`: its turn runs), so `rec` waits; null when none does. */
export function busyMate(list: readonly SessionRec[], rec: SessionRec, working: (id: string) => boolean): SessionRec | null {
  return linkedOf(list, rec).find((r) => workDir(r) === workDir(rec) && r.status !== "draft" && working(r.id)) ?? null;
}

/** Whether a lane's folder may go as chat `rec` closes: no other chat in the list works in it. */
export function laneFree(list: readonly SessionRec[], rec: Pick<SessionRec, "id" | "lane">): boolean {
  const w = rec.lane?.worktree;
  return !w || !list.some((r) => r.id !== rec.id && r.lane?.worktree === w);
}
