// The chat helpers the reducer is built from: a chat's rows and messages kept together, a turn started, patched and
// ended, a subagent's event placed in its fan-out, and a chat read again merged with what it already shows. Split
// out of store.ts (item 125d); the reducer and the steer queue read them, and the store re-exports what it
// exported before.
import type { Away, EventOf, ChatOpenResult, ReplyRef, SubagentState } from "../lib/protocol";
import type { Turn, SubagentRow, MessageItem, ActivityItem, ApprovalItem, ChatItem, Chat, ReplyChip, AppState } from "./types";
import { WORKING } from "./activity";

// ---- state helpers --------------------------------------------------------------------------

export const emptyChat = (): Chat => ({
  items: [],
  messages: [],
  turn: null,
  lastTurn: null,
  model: "",
  provider: "",
  reasoning: "",
  loaded: false,
  sessionId: null,
  turnSeq: 0,
});

/** An ask card with how an ask of one of several shops shows: its shop, and what the person's role there lets them do (its
 *  choices, passing it on) with any note passed on. An ask with no shop is left as it is. */
export function shopAskFields(item: ApprovalItem, ev: EventOf<"approval.request">): ApprovalItem {
  if (!ev.shop) return item;
  const { passOn: _p, passedOn: _n, outdated: _o, ...rest } = item;
  return {
    ...rest,
    choices: ev.choices,
    shop: ev.shop,
    outside: true,
    ...(ev.kind ? { approvalKind: ev.kind } : {}),
    ...(ev.outdated ? { outdated: true } : {}),
    ...(ev.pass_on ? { passOn: true } : {}),
    ...(ev.passed_on ? { passedOn: ev.passed_on } : {}),
  };
}

export function withItems(chat: Chat, items: ChatItem[]): Chat {
  const messages = items
    .filter((i): i is MessageItem => i.kind === "user" || i.kind === "assistant")
    .map((i) => ({ id: i.id, role: i.kind, text: i.text, ts: i.ts }));
  return { ...chat, items, messages };
}

/** The agent took back the person's last message: it and everything after it leave the chat. */
export function rewind(c: Chat, id?: string): Chat {
  // a rewind to a turn names the message it took back; the agent's own rewind of the last message names none
  let at = id ? c.items.findIndex((i) => i.kind === "user" && i.id === id) : -1;
  for (let i = c.items.length - 1; at < 0 && i >= 0; i--) {
    if (c.items[i].kind === "user") {
      at = i;
      break;
    }
  }
  if (at < 0) return c;
  return { ...withItems(c, c.items.slice(0, at)), lastTurn: c.turn ? c.lastTurn : null };
}

/** How long a status that came before its turn still opens that turn (Hermes sends it right before). */
export const EARLY_STATUS_MS = 5_000;

export function newTurn(chat: Chat, bot: string, now: number, status = ""): [Chat, Turn] {
  const seq = chat.turnSeq + 1;
  const turn: Turn = { id: `${bot}-t${seq}`, startedAt: now, status, steps: [], skills: [], streaming: "" };
  const item: ActivityItem = { kind: "activity", id: turn.id, ts: now / 1000, turn };
  return [{ ...withItems(chat, [...chat.items, item]), turn, turnSeq: seq }, turn];
}

export function patchTurn(chat: Chat, fn: (t: Turn) => Turn): Chat {
  if (!chat.turn) return chat;
  const turn = fn(chat.turn);
  const items = chat.items.map((i) => (i.kind === "activity" && i.id === turn.id ? { ...i, turn } : i));
  return { ...withItems(chat, items), turn };
}

/** Applies `fn` to the turn of activity item `id`, wherever it is (the running turn, the last one, or older). */
export function patchTurnById(chat: Chat, id: string, fn: (t: Turn) => Turn): Chat {
  let next: Turn | null = null;
  const items = chat.items.map((i) => (i.kind === "activity" && i.id === id ? { ...i, turn: (next = fn(i.turn)) } : i));
  if (!next) return chat;
  return {
    ...withItems(chat, items),
    turn: chat.turn?.id === id ? next : chat.turn,
    lastTurn: chat.lastTurn?.id === id ? next : chat.lastTurn,
  };
}

const SUB_DONE: SubagentState[] = ["done", "failed", "cancelled"];
/** How many of a subagent's own steps its row keeps. */
export const SUB_STEPS = 8;
export const subagentEnded = (s: Pick<SubagentRow, "state">) => SUB_DONE.includes(s.state);

/** A subagent's steps with the step `ev` names: a new one is added (the oldest dropped past SUB_STEPS); the same
 *  step said again (an edit that has run) takes its final change. */
function withStep(steps: NonNullable<SubagentRow["steps"]>, ev: EventOf<"subagent">): NonNullable<SubagentRow["steps"]> {
  const diff = Array.isArray(ev.diff) ? ev.diff.filter((f) => f && typeof f.path === "string" && Array.isArray(f.lines)) : [];
  const last = steps.at(-1);
  if (last && last.text === ev.step) return diff.length ? [...steps.slice(0, -1), { ...last, diff }] : steps;
  return [...steps, { tool: ev.tool, text: ev.step ?? "", ...(diff.length ? { diff } : {}) }].slice(-SUB_STEPS);
}

/** A subagent event into its fan-out. A fan-out is named by its delegation id once Hermes gives one; the turn that
 *  already shows that delegation takes the event. Otherwise the running turn takes it, and with none running, the
 *  latest turn whose fan-out holds that subagent still out, else the latest turn that ran a delegate_task (a
 *  background fan-out outlives its turn). An event no turn can take (the chat opened afterwards) is left to Plans. */
export function withSubagent(chat: Chat, ev: EventOf<"subagent">, now: number): Chat {
  const acts = [...chat.items.filter((i): i is ActivityItem => i.kind === "activity")].reverse();
  const byDeleg = (t: Turn) => !!ev.delegation && !!t.fanouts?.some((f) => f.delegation === ev.delegation);
  const outHere = (t: Turn) => !!t.fanouts?.some((f) => f.subs.some((s) => s.id === ev.id && !subagentEnded(s)));
  const target =
    acts.find((i) => byDeleg(i.turn))?.id ??
    chat.turn?.id ??
    acts.find((i) => outHere(i.turn))?.id ??
    acts.find((i) => i.turn.steps.some((s) => s.name === "delegate_task"))?.id;
  if (!target) return chat;
  return patchTurnById(chat, target, (t) => {
    const fanouts = [...(t.fanouts ?? [])];
    // its fan-out by delegation id; a subagent id is matched only inside a fan-out with no other delegation id
    let fi = fanouts.findIndex(
      (f) => (!!ev.delegation && f.delegation === ev.delegation) || (f.subs.some((s) => s.id === ev.id) && (!f.delegation || !ev.delegation)),
    );
    // a first event names no delegation yet: it joins the newest fan-out still filling with that many children
    if (fi < 0) fi = fanouts.findIndex((f) => !f.delegation && f.count === ev.count && f.subs.length < f.count && !f.subs.some((s) => s.index === ev.index));
    if (fi < 0) {
      fanouts.push({ key: ev.delegation ?? `${t.id}-f${fanouts.length}`, count: ev.count, startedAt: now, updatedAt: now, subs: [] });
      fi = fanouts.length - 1;
    }
    const f = fanouts[fi];
    const old = f.subs.find((s) => s.id === ev.id);
    const ended = SUB_DONE.includes(ev.state);
    const row: SubagentRow = {
      ...(old ?? { id: ev.id, startedAt: now }),
      index: ev.index,
      goal: ev.goal || old?.goal || "",
      state: old && subagentEnded(old) && !ended ? old.state : ev.state,
      ...(ev.model ? { model: ev.model } : {}),
      ...(ev.agent ? { agent: ev.agent } : {}),
      ...(ev.name ? { name: ev.name } : {}),
      ...(ev.step ? { steps: withStep(old?.steps ?? [], ev) } : {}),
      ...(ev.dag ? { dag: ev.dag } : {}),
      // the step line is the current tool's; it goes when the child ends (its result line takes its place)
      ...(ev.step !== undefined ? { step: ev.step, tool: ev.tool } : {}),
      ...(ended ? { endedAt: old?.endedAt ?? now, summary: ev.summary, seconds: ev.seconds, step: undefined, tool: undefined } : {}),
    } as SubagentRow;
    const subs = old ? f.subs.map((s) => (s.id === ev.id ? row : s)) : [...f.subs, row].sort((a, b) => a.index - b.index);
    fanouts[fi] = { ...f, subs, updatedAt: now, count: Math.max(f.count, ev.count), ...(ev.delegation ? { delegation: ev.delegation } : {}) };
    return { ...t, fanouts };
  });
}

/** Closes the running turn (if any) and moves it to lastTurn. A step still open when the person stopped the turn
 *  reads as stopped, not as finished. */
export function endTurn(chat: Chat, now: number, outcome: NonNullable<Turn["outcome"]>, error?: string): Chat {
  if (!chat.turn) return chat;
  const stop = outcome === "interrupted";
  const patched = patchTurn(chat, (t) => ({
    ...t,
    endedAt: now,
    outcome,
    ...(error ? { error } : {}),
    steps: t.steps.map((s) => (s.endedAt ? s : { ...s, endedAt: now, ...(stop ? { ok: false, stopped: true } : {}) })),
  }));
  return { ...patched, lastTurn: patched.turn, turn: null };
}

/** The end of a step the person stopped, reported after its turn was over (Codex's command ran on): the stopped
 *  step, in whichever turn holds it, says it kept running and how it ended. Any other step end outside its turn
 *  is dropped. */
export function lateStepEnd(chat: Chat, ev: EventOf<"tool.end">, now: number): Chat {
  const held = [...chat.items]
    .reverse()
    .find((i): i is ActivityItem => i.kind === "activity" && i.turn.steps.some((s) => s.id === ev.tool_id && s.stopped && !s.late));
  if (!held) return chat;
  return patchTurnById(chat, held.id, (t) => ({
    ...t,
    steps: t.steps.map((s) => (s.id === ev.tool_id ? { ...s, late: { ok: ev.ok, endedAt: now, ms: ev.ms > 0 ? ev.ms : now - s.startedAt } } : s)),
  }));
}

export function touchChat(state: AppState, bot: string, fn: (c: Chat) => Chat): AppState {
  const chat = state.chats[bot] ?? emptyChat();
  return { ...state, chats: { ...state.chats, [bot]: fn(chat) } };
}

export function bumpUnread(state: AppState, bot: string): AppState {
  if (bot === state.selectedBot) return state;
  return { ...state, unread: { ...state.unread, [bot]: (state.unread[bot] ?? 0) + 1 } };
}

/** Where the running turn's answer goes: right before the message the person sent while that answer was already
 *  showing (`Turn.before`: it reads under the answer, as in a messenger, and is answered next), else at the end. */
export function answerSlot(chat: Chat): number {
  const id = chat.turn?.before;
  const at = id ? chat.items.findIndex((i) => i.kind === "user" && i.id === id) : -1;
  return at < 0 ? chat.items.length : at;
}

/** Insert `extra` rows into `base` by ts, after the last row whose ts is <= theirs. */
function mergeByTs(base: ChatItem[], extra: ChatItem[]): ChatItem[] {
  const out = [...base];
  for (const r of extra) {
    let idx = out.length;
    while (idx > 0 && out[idx - 1].ts > r.ts) idx -= 1;
    out.splice(idx, 0, r);
  }
  return out;
}

/** "slack:C1:1794.5" + "#og-dev" -> { source: "slack", label: "#og-dev" }. */
export function replyOf(ref: ReplyRef): { source: string; label: string } {
  return { source: ref.target.split(":")[0] || "elsewhere", label: ref.label };
}

/** The chip for an away session, or null when it has no thread to reply in. */
export function replyChipFor(a: Away): ReplyChip | null {
  if (!a.reply_target) return null;
  const parts = a.reply_target.split(":");
  const source = parts[0] || a.source;
  const name = SOURCE_NAMES[source] ?? source;
  return { session_id: a.id, source, place: a.place?.trim() || name, kind: parts.length >= 3 ? "thread" : "channel" };
}
const SOURCE_NAMES: Record<string, string> = { slack: "Slack", discord: "Discord", telegram: "Telegram" };

/** `since`: when the chat.open request went out. A turn that started or ended after that is newer than the reply's
 *  `running`, which then changes nothing: the live events are the truth for it. */
export function applyOpened(chat: Chat, res: ChatOpenResult, now: number, bot: string, since = Infinity): Chat {
  const server: MessageItem[] = res.messages.map((m) => ({
    kind: m.role,
    id: m.id,
    ts: m.ts,
    text: m.text,
    ...(m.reply_to ? { reply: replyOf(m.reply_to) } : {}),
    ...(m.watch ? { watch: m.watch } : {}),
    ...(m.steered && m.role === "user" ? { steered: true, ...(m.steer_reply ? { steerReply: m.steer_reply } : {}) } : {}),
  }));
  // a reopened chat: a row of the person's with any bot row after it reached the bot (read at that row's time; a
  // steer at the time of the bot's first words after it); in a turn still running, its last row did too
  server.forEach((m, k) => {
    if (m.kind !== "user") return;
    const next = server.slice(k + 1).find((x) => x.kind === "assistant");
    const steerAt = res.messages[k]?.steer_read;
    if (next || steerAt) m.readAt = (steerAt ?? next?.ts ?? 0) * 1000;
  });
  const lastUser = [...server].reverse().find((m) => m.kind === "user");
  if (res.running && lastUser && lastUser.readAt === undefined) lastUser.readAt = 0;
  const ids = new Set(server.map((m) => m.id));
  const lastServerTs = server.length ? server[server.length - 1].ts : 0;
  const keep = chat.items.filter((i) => {
    if (i.kind !== "user" && i.kind !== "assistant") return true;
    if (i.kind === "user" && i.held) return true; // never sent: no server row can be its twin
    if (ids.has(i.id)) {
      const twin = server.find((s) => s.id === i.id);
      if (twin && i.kind === "user" && i.readAt !== undefined && twin.readAt === undefined) twin.readAt = i.readAt;
      return false;
    }
    // the words before a question, kept live above its card: the history now carries that row too (bridge
    // `_ask_notes`), so the local copy goes once the server has it
    if (i.kind === "assistant" && i.id.startsWith("clarify-note-")) {
      const said = i.text.trim();
      return !server.some((s) => s.kind === "assistant" && s.text.trim() === said);
    }
    if (i.id.startsWith("local-")) {
      const sent = i.sent ?? i.text;
      const twin = server.find((s) => s.kind === "user" && s.text === sent && s.ts >= i.ts - 120);
      // what this app already saw (the send went through) stays read until the history says when
      if (twin && i.readAt !== undefined && twin.readAt === undefined) twin.readAt = i.readAt;
      // keep the local pictures, and the text as typed with its skill tokens (they go out hoisted)
      if (twin && (i.files || i.sent || i.skills))
        Object.assign(twin, { text: i.text, sent, ...(i.files ? { files: i.files } : {}), ...(i.skills ? { skills: i.skills } : {}) });
      return !twin;
    }
    return i.ts >= lastServerTs;
  });
  let next: Chat = {
    ...withItems(chat, mergeByTs(server, keep)),
    model: res.model,
    provider: res.provider,
    reasoning: res.reasoning,
    loaded: true,
    sessionId: res.session_id,
    stale: false,
  };
  if (res.running && !next.turn && !((next.lastTurn?.endedAt ?? -Infinity) >= since)) {
    next = newTurn(next, bot, now, WORKING)[0];
  } else if (!res.running && next.turn && next.turn.startedAt < since) {
    next = endTurn(next, now, "done");
  }
  return next;
}
