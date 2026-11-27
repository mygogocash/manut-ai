// The one reducer: every action and every bridge event, applied to the state. Split out of store.ts (item 125d),
// which re-exports what it exported before.
import type { BridgeStatus } from "../lib/bridge";
import { t as tr, type Lang } from "../i18n";
import type { FlowState } from "../onboarding/flow";
import type { ShopProfile } from "../onboarding/shop";
import type {
  Away,
  ApprovalChoice,
  Bot,
  BridgeEvent,
  ChatOpenResult,
  ClarifyAnswers,
  HelloResult,
  ModelCurrent,
  ModelOptions,
  AgentBox,
  PeekMsg,
  Routine,
  Automation,
  PassedOnNote,
  ShopLeft,
  ShopRow,
} from "../lib/protocol";
import { threadKey, type ThreadRow } from "../threads/types";
import {
  isMenuPage,
  type PanelTabId,
  type MessageItem,
  type SentFile,
  type ApprovalItem,
  type ClarifyItem,
  type RoutineAddedItem,
  type PluginAddedItem,
  type BriefNoticeItem,
  type ThreadLinkItem,
  type ThreadRouteItem,
  type HelpersAskItem,
  type ReachAskItem,
  type Turn,
  type Chat,
  type ReplyChip,
  type Theme,
  type Look,
  type MenuPage,
  type Ui,
  type AppState,
} from "./types";
import { activityText, THINKING, THINKING_MAX, parsePlan, answerSoFar, shownText, ownBlocksHidden } from "./activity";
import { hasHelperBlock, streamingHelpers } from "../jobs/helperBlocks";
import { hasReachBlock } from "../jobs/reachBlocks";
import {
  emptyChat,
  shopAskFields,
  withItems,
  rewind,
  EARLY_STATUS_MS,
  newTurn,
  patchTurn,
  patchTurnById,
  withSubagent,
  endTurn,
  lateStepEnd,
  touchChat,
  bumpUnread,
  answerSlot,
  applyOpened,
} from "./helpers";
import { folderKey, isSessionChat } from "./chatRoutes";
import { liveBeside, unsteer, consumeSteers, lastSent, markRead, ackSteer, reduceQueue, type QueueAction } from "./queue";
import { askOpen } from "./selectors";

// ---- reducer --------------------------------------------------------------------------------

// Three helpers only the reducer reads, moved here from the sections they stood in while this was one file.
// `doneWaiting` reads `askOpen` from the selectors, and the selectors read the chat helpers, so it could not stay
// with those without an import cycle; `backOf` and `FAILED_ROUTINE` stood in the steer queue's section.

/** The person answered a card: the running turn's "Waiting for approval / your answer" goes back to what the turn
 *  was doing (its latest step), or to the plain working line, unless another card still waits. */
function doneWaiting(c: Chat): Chat {
  const t = c.turn;
  if (!t || (t.status !== tr("live.waitApproval") && t.status !== tr("live.waitAnswer"))) return c;
  if (c.items.some((i) => (i.kind === "approval" || i.kind === "clarify") && askOpen(c.items, i))) return c;
  const last = t.steps[t.steps.length - 1];
  return patchTurn(c, (x) => ({ ...x, status: last && last.endedAt === undefined ? activityText(last.name, last.detail) : "" }));
}

/** The view a page returns to: the one it was opened from (the chat, a session or a menu page), or (page to page)
 *  where the first page returns. */
function backOf(ui: Ui): Ui["back"] {
  return ui.view === "chat" || ui.view === "session" || isMenuPage(ui.view) ? ui.view : ui.back;
}

/** Hermes' run states that mean a routine failed (the bridge's FAILED_RUN). */
const FAILED_ROUTINE = new Set(["error", "failed", "failure", "delivery_failed", "blocked_config"]);

export type Action =
  | { type: "conn"; status: BridgeStatus; now?: number }
  | { type: "chat.failed"; bot: string; message: string }
  | { type: "hello"; hello: HelloResult }
  | { type: "error"; message: string | null }
  | { type: "bots"; bots: Bot[] }
  | { type: "select"; bot: string; behind?: boolean }
  | { type: "chat.opened"; bot: string; res: ChatOpenResult; now: number; since?: number }
  /** Automation answers that came in while manut was closed (or not attached): `count` more unread. */
  | { type: "watch.missed"; bot: string; count: number }
  | {
      type: "local.user";
      bot: string;
      id: string;
      text: string;
      now: number;
      reply?: { source: string; label: string };
      files?: SentFile[];
      sent?: string;
      skills?: string[];
      /** Typed while a turn ran: held in the steer queue, not sent yet. */
      held?: boolean;
      /** Held, and steered into the running turn at once: it joins that turn, so the answer is not kept above it. */
      steer?: boolean;
    }
  | { type: "reply.set"; bot: string; chip: ReplyChip | null }
  | QueueAction
  | { type: "send.failed"; bot: string; id: string; error: string }
  /** chat.send went through: the bot has the message (its "Read" mark). */
  | { type: "send.ok"; bot: string; id: string; now: number }
  | { type: "event"; ev: BridgeEvent; now: number }
  | { type: "approval.resolved"; bot: string; request_id: string; choice: ApprovalChoice; by?: string }
  | { type: "approval.passed"; bot: string; request_id: string; passed: PassedOnNote }
  | { type: "shops"; list: ShopRow[]; current: string | null; left: ShopLeft[] }
  | { type: "shops.dismiss"; id: string }
  | { type: "shop.switched" }
  | { type: "clarify.resolved"; bot: string; request_id: string; answer: string; answers?: ClarifyAnswers }
  | { type: "elsewhere"; bot: string; sessions: Away[] }
  | { type: "peek.loading"; id: string }
  | { type: "peek.loaded"; id: string; messages: PeekMsg[]; total: number }
  | { type: "peek.failed"; id: string; error: string }
  | { type: "routines"; bot: string; routines: Routine[] }
  | { type: "automations"; automations: Automation[] }
  | { type: "ui.automations"; job?: string | null }
  | { type: "ui.plugins"; bot?: string | null }
  | { type: "ui.tasks" }
  /** One job's page, or the activity log, each returning to where it was opened from. */
  | { type: "ui.job"; job: string }
  | { type: "ui.activity" }
  /** A page of the side menu fills the main column; `find` also asks History's search box for the focus. */
  | { type: "ui.page"; page: MenuPage; find?: boolean; query?: string }
  | { type: "ui.lang"; lang: Lang }
  /** The person and their shop as now kept on this computer (the first-run setup). */
  | { type: "ui.shop"; shop: ShopProfile }
  /** The first-run setup moved, opened again from Settings, or ended (null). */
  | { type: "ui.firstRun"; flow: FlowState | null }
  | { type: "models"; bot: string; options: ModelOptions }
  | { type: "agentBox"; key: string; box: AgentBox | null }
  | { type: "model.set"; bot: string; current: ModelCurrent }
  | { type: "ui.panel"; open?: boolean }
  | { type: "ui.panelTab"; tab: PanelTabId }
  | { type: "ui.run"; run: string | null }
  | { type: "ui.panelMax"; open: boolean; tab?: PanelTabId }
  | { type: "ui.draft"; bot: string; text: string }
  | { type: "ui.theme"; theme: Theme }
  | { type: "ui.look"; look: Partial<Look> }
  | { type: "ui.settings"; page?: string }
  | { type: "ui.closeSettings" }
  | { type: "system.note"; bot: string; text: string; now: number; detail?: { label: string; text: string } }
  | { type: "ui.pin"; bot: string; on: boolean }
  | { type: "ui.roster"; roster: string[] }
  /** A sidebar row moved (drag or ⌥↑/⌥↓): the pin list and roster in their new order. */
  | { type: "ui.order"; pinned: string[]; roster: string[] }
  | { type: "ui.focusAsk"; bot: string; id: string }
  | { type: "ui.session"; id: string | null }
  /** After a restart: the panel, Plans view and open session as they were (resume.ts). */
  | { type: "ui.restore"; ui: Pick<Ui, "panelOpen" | "panelTab" | "runId"> & { runsFull: boolean; session: string | null } }
  /** Drop a chat that is gone for good (a closed SESSIONS chat): its open asks go with it. */
  | { type: "chat.forget"; bot: string }
  /** A SESSIONS chat ended with `error`: its last turn, failed with that same reason, no longer repeats it (the
   *  Ended line above the composer says it once, beside Restart). */
  | { type: "turn.reasonMoved"; bot: string; error: string }
  /** A bot's threads as `thread.list` read them (rows the app already holds keep their live title and time). */
  | { type: "threads"; bot: string; threads: ThreadRow[] }
  /** One thread joined (made here, or the bot opened one) or changed (named, active). */
  | { type: "thread.upsert"; bot: string; row: ThreadRow }
  /** A thread was archived: its row, its chat and the asks in it go. */
  | { type: "thread.gone"; bot: string; thread: string }
  /** Show a thread of `bot` in the main column (null: the bot's main chat). */
  | { type: "ui.thread"; bot: string; thread: string | null }
  /** A link line or a route card under the main-chat answer `message` of `bot` (once per id). */
  | { type: "thread.note"; bot: string; message: string; item: ThreadLinkItem | ThreadRouteItem }
  /** The person answered a route card. */
  | { type: "thread.routed"; bot: string; id: string; done?: "sent" | "kept"; error?: string }
  /** A lead lane's Start helpers card, at the end of its chat (item 102e, src/jobs/leadLanes.ts). */
  | { type: "helpers.ask"; bot: string; item: HelpersAskItem }
  /** What became of a Start helpers card: started, Not now, or gone (the person wrote again). Only an open card changes. */
  | { type: "helpers.done"; bot: string; id: string; done: NonNullable<HelpersAskItem["done"]> }
  /** A reach card, at the end of the asking chat (item 102k, src/jobs/reachChats.ts). */
  | { type: "reach.ask"; bot: string; item: ReachAskItem }
  /** What became of a reach card: pressed yes (then the lane it opened, or what went wrong), pressed no, or gone. Only an open card
   *  changes, but for a yes's outcome. */
  | { type: "reach.done"; bot: string; id: string; done: NonNullable<ReachAskItem["done"]>; lane?: string; error?: string };

/** The bots whose "will brief you here" line was already shown (`localStorage["manut.briefNoticed"]`). */
export function briefNoticed(): string[] {
  try {
    const raw = typeof localStorage !== "undefined" ? localStorage.getItem("manut.briefNoticed") : null;
    const v = raw ? JSON.parse(raw) : [];
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}
function saveBriefNoticed(bots: string[]): void {
  try {
    if (typeof localStorage !== "undefined") localStorage.setItem("manut.briefNoticed", JSON.stringify([...new Set(bots)]));
  } catch {
    /* storage is best effort */
  }
}

/** While a lead lane's answer streams with a helper block in it (item 102e), the hidden block's place in the activity line: how many
 *  helper lanes it asks for so far, from the whole helpers written yet (`streamingHelpers`). Nothing starts from it. Any other turn,
 *  or an answer with no block, is as it was. */
function askingHelpers(t: Turn): Turn {
  if (!t.helpers || !t.streaming.includes("```")) return t;
  const text = t.streaming.slice(t.cut ?? 0);
  if (!hasHelperBlock(text)) return t;
  const so = streamingHelpers(text);
  const n = so.kind === "helpers" || so.kind === "partial" ? so.helpers.length : 0;
  const status = n === 0 ? tr("helpers.writing") : n === 1 ? tr("helpers.writing.one") : tr("helpers.writing.many", { n });
  return t.status === status ? t : { ...t, status };
}

/** While a coding chat's answer streams with a reach block in it (item 102k), the hidden block's place in the activity line. Nothing
 *  happens from it: the card comes once the turn ends. Any other turn, or an answer with no block, is as it was. */
function askingReach(t: Turn): Turn {
  if (!t.reach || !t.streaming.includes("```") || !hasReachBlock(t.streaming.slice(t.cut ?? 0))) return t;
  const status = tr("reach.writing");
  return t.status === status ? t : { ...t, status };
}

function reduceEvent(state: AppState, ev: BridgeEvent, now: number): AppState {
  if (ev.session && ev.event !== "folder.closed") {
    if (ev.event === "bot.status") return state; // a folder chat's turn never moves the bot's own status
    return reduceEvent(state, { ...ev, bot: folderKey(ev.bot, ev.session), session: undefined }, now);
  }
  const bot = ev.bot;
  switch (ev.event) {
    // A turn starts only on turn.start (or a chat found running on open). Every other live event belongs to the
    // running turn and is dropped without one: an agent's own status after its turn ended (OmO's setStatus after
    // agent_end) must not start a turn that nothing ends.
    case "turn.start":
      return touchChat(state, bot, (c) => {
        const early = c.early && now - c.early.at <= EARLY_STATUS_MS ? c.early.text : "";
        // its turn started: the bot has the person's last sent message
        const got = markRead(c, lastSent(c)?.id, now);
        const started = newTurn(endTurn(got, now, "done"), bot, now, early)[0];
        // a lead lane's turn with Helpers on: its helper blocks are hidden and read by the app (item 102e)
        // a coding chat's turn with chats on its "Kit may reach" list: its reach blocks likewise (item 102k)
        const marks = { ...(ev.helpers === true ? { helpers: true as const } : {}), ...(ev.reach === true ? { reach: true as const } : {}) };
        const turn = marks.helpers || marks.reach ? patchTurn(started, (t) => ({ ...t, ...marks })) : started;
        return { ...turn, early: null, pendingTurn: null, steeredUnread: undefined, steerAck: null };
      });
    case "status": {
      // the agent's own retry of this turn: the line says which try, in the person's language
      const text = ev.retry ? tr("live.retrying", { n: ev.retry.attempt, max: ev.retry.max }) : ev.text;
      return touchChat(state, bot, (c) => (c.turn ? patchTurn(c, (t) => ({ ...t, status: text })) : { ...c, early: { text, at: now } }));
    }
    case "thinking":
      return touchChat(state, bot, (c) => {
        if (!c.turn) return c;
        const text = typeof ev.text === "string" ? ev.text : "";
        const had = c.turn.thinking ?? "";
        const kept = text && had.length < THINKING_MAX ? (had + text).slice(0, THINKING_MAX) : had;
        if (c.turn.status && kept === had) return c;
        return patchTurn(c, (t) => ({ ...t, ...(t.status ? {} : { status: THINKING }), ...(kept ? { thinking: kept } : {}) }));
      });
    case "tool.diff": {
      const files = Array.isArray(ev.files) ? ev.files.filter((f) => f && typeof f.path === "string" && Array.isArray(f.lines)) : [];
      if (!files.length) return state;
      // the step's line says the same counts as its change (`calc.py +4`, `a.ts +3 -1, b.ts +1`)
      const detail = files.map((f) => `${f.path}${f.added ? ` +${f.added}` : ""}${f.removed ? ` -${f.removed}` : ""}`).join(", ");
      return touchChat(state, bot, (c) =>
        patchTurn(c, (t) => ({ ...t, steps: t.steps.map((s) => (s.id === ev.tool_id ? { ...s, diff: files, detail } : s)) })),
      );
    }
    case "plan":
      return touchChat(state, bot, (c) => patchTurn(c, (t) => ({ ...t, plan: parsePlan(ev.items) })));
    case "rewound":
      return touchChat(state, bot, (c) => rewind(c, ev.id));
    case "tool.start":
      return touchChat(state, bot, (c0) => {
        // the note written before this call is the bot's first word on a steer it read
        const c = c0.steerAck && c0.turn ? ackSteer(c0, c0.turn.streaming.slice(c0.steerAck.from)) : c0;
        // an ask is a tool call too, and the words just before it are what the person has to read to answer:
        // keep them before the cut takes them (they show right above the card, see clarify.request)
        const ask = ev.name === "clarify";
        return patchTurn(c, (t) => ({
          ...t,
          status: activityText(ev.name, ev.detail),
          ...(ask ? { askNote: shownText(t, t.streaming.slice(t.cut ?? 0).trim()) } : {}),
          // what was written before this call was commentary on it, not the answer
          cut: t.streaming.length,
          steps: [
            ...t.steps,
            { id: ev.tool_id, name: ev.name, detail: ev.detail, startedAt: now, ...(ev.dag?.length ? { dag: ev.dag } : {}) },
          ],
        }));
      });
    case "tool.end":
      // a tool step ended: Hermes hands what was steered in to the model with its result
      return touchChat(state, bot, (c0) => {
        const c = c0.steeredUnread ? consumeSteers({ ...c0, steeredUnread: undefined }, c0.steeredUnread) : c0;
        return c.turn?.steps.some((s) => s.id === ev.tool_id)
          ? patchTurn(c, (t) => ({
              ...t,
              steps: t.steps.map((s) => (s.id === ev.tool_id ? { ...s, endedAt: now, ok: ev.ok } : s)),
            }))
          : lateStepEnd(c, ev, now);
      });
    case "subagent": {
      const c = state.chats[bot];
      const next = c && withSubagent(c, ev, now);
      return next && next !== c ? { ...state, chats: { ...state.chats, [bot]: next } } : state;
    }
    case "skill":
      return touchChat(state, bot, (c) =>
        patchTurn(c, (t) => (t.skills.includes(ev.name) ? t : { ...t, skills: [...t.skills, ev.name] })),
      );
    case "delta":
      return touchChat(state, bot, (c) => patchTurn(c, (t) => askingReach(askingHelpers({ ...t, streaming: t.streaming + ev.text }))));
    case "message": {
      // an answer that was only blocks the app reads itself, a lead lane's helper blocks (item 102e) or a coding chat's reach blocks
      // (item 102k): nothing to show, and nothing unread
      const live = state.chats[bot]?.turn;
      const onlyBlocks = !!(live?.helpers || live?.reach) && !ownBlocksHidden(live, ev.text);
      const next = touchChat(state, bot, (c) => {
        // the answer came: a steer Hermes took by now runs in this turn or right after it (never dropped by a Stop)
        const read = c.steeredUnread ? consumeSteers(c, c.steeredUnread) : c;
        // a steer read before this answer, with no note since: the answer is the bot's first word on it
        const acked = read.steerAck ? ackSteer(read, ev.text) : read;
        const cleared = patchTurn({ ...acked, steeredUnread: undefined, steerAck: null }, (t) => ({ ...t, streaming: "", cut: undefined }));
        // a lead lane's helper blocks never stay in the answer kept (item 102e): the app has read them for its card. An answer that
        // was only blocks leaves no bubble.
        const text = ownBlocksHidden(c.turn, ev.text);
        const exists = cleared.items.some((i) => i.kind === "assistant" && i.id === ev.id);
        if (onlyBlocks && !exists) return cleared;
        const msg: MessageItem = { kind: "assistant", id: ev.id, ts: now / 1000, text, ...(ev.watch ? { watch: ev.watch } : {}) };
        const slot = answerSlot(cleared);
        const items = exists
          ? cleared.items.map((i) => (i.kind === "assistant" && i.id === ev.id ? { ...i, text } : i))
          : [...cleared.items.slice(0, slot), msg, ...cleared.items.slice(slot)];
        return withItems(cleared, items);
      });
      const existed = state.chats[bot]?.items.some((i) => i.kind === "assistant" && i.id === ev.id);
      return existed || onlyBlocks ? next : bumpUnread(next, bot);
    }
    case "approval.request":
      return touchChat(state, bot, (c) => {
        // chat.open replays asks that are still waiting; the card is already there. An ask of one of several shops that
        // comes again says how it shows now (a note passed on since, a role that moved), which its open card takes.
        const known = c.items.find((i): i is ApprovalItem => i.kind === "approval" && i.request_id === ev.request_id);
        if (known) return ev.shop && !known.resolved && !known.expired ? withItems(c, c.items.map((i) => (i === known ? shopAskFields(known, ev) : i))) : c;
        // A shop's request is no turn's: it does not make a running turn wait, and no turn's end closes it.
        const base = ev.shop ? c : patchTurn(c, (t) => ({ ...t, status: tr("live.waitApproval") }));
        const asked = typeof ev.asked_at === "number" && Number.isFinite(ev.asked_at) && ev.asked_at > 0 ? ev.asked_at : null;
        const item: ApprovalItem = shopAskFields(
          {
            kind: "approval",
            id: `approval-${ev.request_id}`,
            ts: asked ?? now / 1000,
            request_id: ev.request_id,
            title: ev.title,
            command: ev.command,
            ...(ev.whole ? { whole: true } : {}),
            choices: ev.choices,
            ...(ev.cwd ? { cwd: ev.cwd } : {}),
            ...(typeof ev.plan === "string" && ev.plan.trim() ? { plan: ev.plan } : {}),
            // kept as it came, a broken one too: the dial reads an ask by its words only when it named nothing
            ...(ev.tool !== undefined ? { tool: ev.tool } : {}),
            ...(ev.subagent?.id ? { subagent: ev.subagent } : {}),
            ...(c.turn || !bot.startsWith("agent:") ? {} : { outside: true }),
            ...(ev.outdated ? { outdated: true } : {}),
          },
          ev,
        );
        return withItems(base, [...base.items, item]);
      });
    case "clarify.request":
      return touchChat(state, bot, (c) => {
        if (c.items.some((i) => i.kind === "clarify" && i.request_id === ev.request_id)) return c;
        // The words written right before the question are its context. Hermes asks through a tool call, and the
        // commentary beside a tool call is dropped (`cut`, see tool.start), so the card used to arrive alone with
        // the explanation the person was supposed to read gone. Keep that commentary as a row above the card.
        const note = c.turn?.askNote ?? "";
        const asked = patchTurn(c, (t) => ({ ...t, status: tr("live.waitAnswer") }));
        const qs = (ev.questions ?? []).filter((q) => q && typeof q.question === "string" && q.question.trim());
        const item: ClarifyItem = {
          kind: "clarify",
          id: `clarify-${ev.request_id}`,
          ts: now / 1000,
          request_id: ev.request_id,
          question: ev.question || qs[0]?.question || "",
          choices: ev.choices,
          ...(ev.multi_select ? { multi: true } : {}),
          ...(qs.length > 1 ? { questions: qs } : {}),
          ...(ev.subagent?.id ? { subagent: ev.subagent } : {}),
          ...(c.turn || !bot.startsWith("agent:") ? {} : { outside: true }),
        };
        const noted: MessageItem = { kind: "assistant", id: `clarify-note-${ev.request_id}`, ts: now / 1000, text: note };
        const withNote = note ? withItems(asked, [...asked.items, noted]) : asked;
        const base = withItems(withNote, [...withNote.items, item]);
        // the note now lives in its own row: it is not the answer still being written
        return note ? patchTurn(base, (t) => ({ ...t, streaming: "", cut: undefined, askNote: undefined })) : base;
      });
    case "prompt.expired":
      return touchChat(state, bot, (c) =>
        withItems(
          c,
          c.items.map((i) => {
            if (i.kind === "approval" && i.request_id === ev.request_id && !i.resolved) return { ...i, expired: ev.reason, ...(ev.note ? { expiredNote: ev.note } : {}) };
            if (i.kind === "clarify" && i.request_id === ev.request_id && i.answer === undefined) return { ...i, expired: ev.reason };
            return i;
          }),
        ),
      );
    case "turn.end":
      return touchChat(state, bot, (c) => {
        let base = c;
        // A done turn that streamed text but never sent the final message: keep what was said.
        // Only what came after the latest tool call: the text before it was commentary on that call, not the answer.
        const said = c.turn ? shownText(c.turn, c.turn.streaming.slice(c.turn.cut ?? 0).trim()) : "";
        if (ev.outcome === "done" && c.turn && said) {
          const text = said;
          const slot = answerSlot(c);
          base = withItems(c, [...c.items.slice(0, slot), { kind: "assistant", id: `${c.turn.id}-a`, ts: now / 1000, text }, ...c.items.slice(slot)]);
          base = patchTurn(base, (t) => ({ ...t, streaming: "", cut: undefined }));
        }
        // a steer read with no note before the end: what the turn said last is the bot's word on it
        if (ev.outcome === "done" && c.turn && c.steerAck) base = ackSteer(base, c.turn.streaming.slice(c.steerAck.from));
        // stopped before the turn read what was steered in: Hermes dropped it, so it says so and waits for Send / Delete
        if (ev.outcome === "interrupted" && c.steeredUnread?.length) base = unsteer(base, c.steeredUnread);
        return { ...endTurn(base, now, ev.outcome, ev.error), early: null, pendingTurn: null, steeredUnread: undefined, steerAck: null };
      });
    case "bot.status":
      return {
        ...state,
        bots: state.bots.map((b) => (b.name === bot ? { ...b, status: ev.status, running: ev.running } : b)),
      };
    case "elsewhere.update":
    case "bots.update":
    case "agent.box":
    case "bot.restarted":
    case "accounts.update":
      return state; // the store refetches; nothing to change here
    case "routine.added": {
      const id = `routine-added-${ev.routine_id}`;
      if (state.chats[bot]?.items.some((i) => i.id === id)) return state;
      const item: RoutineAddedItem = {
        kind: "routineAdded",
        id,
        ts: ev.ts || now / 1000,
        routine_id: ev.routine_id,
        name: ev.name,
        schedule: ev.schedule,
        next_run_at: ev.next_run_at,
        deliver: ev.deliver,
        origin: ev.origin,
      };
      return bumpUnread(touchChat(state, bot, (c) => withItems(c, [...c.items, item])), bot);
    }
    case "brief.ready": {
      // once per bot on this computer: the line never comes back after it was shown
      if (briefNoticed().includes(bot) || state.chats[bot]?.items.some((i) => i.kind === "briefNotice")) return state;
      saveBriefNoticed([...briefNoticed(), bot]);
      const item: BriefNoticeItem = { kind: "briefNotice", id: `brief-notice-${bot}`, ts: now / 1000, bot };
      return touchChat(state, bot, (c) => withItems(c, [...c.items, item]));
    }
    case "plugin.added": {
      const id = `plugin-added-${ev.name}-${ev.ts}`;
      if (state.chats[bot]?.items.some((i) => i.id === id)) return state;
      const item: PluginAddedItem = { kind: "pluginAdded", id, ts: ev.ts || now / 1000, name: ev.name, title: ev.title, tools: ev.tools, hooks: ev.hooks };
      return bumpUnread(touchChat(state, bot, (c) => withItems(c, [...c.items, item])), bot);
    }
    case "routine.ran": {
      // a delivered bot-chat run: its answer comes as that chat's message, which is the line and the unread
      if (ev.delivered) return state;
      // a run that went fine says nothing in the chat (a 30-minute job would fill it); Automations shows its last run.
      // Only a failed run draws a line and an unread.
      if (!FAILED_ROUTINE.has(String(ev.status ?? "").trim().toLowerCase())) return state;
      // the same routine failing again with nothing between: one line counts the runs (×12 · 03:56–09:37), no new
      // unread; the first failure drew the unread already
      const tail = state.chats[bot]?.items.at(-1);
      if (tail?.kind === "routine" && tail.routine_id === ev.routine_id) {
        if (ev.ts <= tail.ts) return state;
        return touchChat(state, bot, (c) =>
          withItems(c, [
            ...c.items.slice(0, -1),
            { ...tail, ts: ev.ts, status: ev.status, count: (tail.count ?? 1) + 1, since: tail.since ?? tail.ts },
          ]),
        );
      }
      const next = touchChat(state, bot, (c) =>
        withItems(c, [
          ...c.items,
          {
            kind: "routine",
            id: `routine-${ev.routine_id}-${ev.ts}`,
            ts: ev.ts,
            routine_id: ev.routine_id,
            name: ev.name,
            status: ev.status,
          },
        ]),
      );
      return bumpUnread(next, bot);
    }
    // a message sent while a turn ran (a SESSIONS chat): waiting until the agent takes it, or thrown away by Stop
    case "message.queued":
    case "message.taken":
    case "message.dropped": {
      const id = (ev as { id?: unknown }).id;
      if (typeof id !== "string" || !state.chats[bot]?.items.some((i) => i.kind === "user" && i.id === id)) return state;
      const wait = ev.event === "message.queued" ? ("queued" as const) : ev.event === "message.dropped" ? ("dropped" as const) : undefined;
      return touchChat(state, bot, (c) =>
        withItems(
          c,
          c.items.map((i) => {
            if (i.kind !== "user" || i.id !== id) return i;
            const { wait: _old, ...rest } = i;
            return wait ? { ...rest, wait } : rest;
          }),
        ),
      );
    }
    default:
      return state;
  }
}

export function reduce(state: AppState, a: Action): AppState {
  switch (a.type) {
    case "conn": {
      if (a.status === "open" || a.status === state.conn) return { ...state, conn: a.status };
      // The bridge went away: whatever was running is no longer observed. End live turns as interrupted
      // now, so the activity line and Stop do not stay up for the whole outage (a later chat.open with
      // running:false must not turn them into "done").
      const t = a.now ?? Date.now();
      const chats: AppState["chats"] = {};
      // agent:<id> chats run in the desktop shell, not through Hermes: a bridge outage does not touch them
      for (const [b, c] of Object.entries(state.chats)) {
        const ended = c.turn && !b.startsWith("agent:") ? endTurn(c, t, "interrupted", tr("live.lost")) : c;
        // what Hermes runs is not known until the chat is read again: the steer queue waits for that
        chats[b] = isSessionChat(b) ? ended : { ...ended, stale: true, pendingTurn: null, steeredUnread: undefined, steerAck: null };
      }
      return { ...state, conn: a.status, chats };
    }
    case "chat.failed":
      // read again (or tried): the steer queue no longer waits on a re-read that is not coming
      return touchChat(state, a.bot, (c) => ({ ...c, loaded: true, openError: a.message, stale: false }));
    case "hello":
      return { ...state, hello: a.hello };
    case "error":
      return { ...state, lastError: a.message };
    case "bots":
      return { ...state, bots: a.bots };
    case "select":
      // `behind`: the member is chosen behind the page shown, which stays (the app starting while the person already opened one)
      return a.behind
        ? { ...state, selectedBot: a.bot }
        : { ...state, selectedBot: a.bot, unread: { ...state.unread, [a.bot]: 0 }, ui: { ...state.ui, view: "chat", thread: null } };
    case "ui.thread":
      return {
        ...state,
        selectedBot: a.bot,
        unread: a.thread ? state.unread : { ...state.unread, [a.bot]: 0 },
        ui: { ...state.ui, view: "chat", thread: a.thread },
      };
    case "threads": {
      const had = new Map((state.threads[a.bot] ?? []).map((r) => [r.thread, r]));
      const rows = a.threads.map((r) => {
        const old = had.get(r.thread);
        // a re-list keeps what the app already learned: the name, the last activity, and the folder thread.open gave
        return old ? { ...r, title: r.title || old.title, cwd: r.cwd || old.cwd, last: Math.max(old.last ?? 0, r.last ?? 0) || undefined } : r;
      });
      return { ...state, threads: { ...state.threads, [a.bot]: rows } };
    }
    case "thread.upsert": {
      const list = state.threads[a.bot] ?? [];
      const i = list.findIndex((r) => r.thread === a.row.thread);
      const rows = i < 0 ? [a.row, ...list] : list.map((r, j) => (j === i ? { ...r, ...a.row, title: a.row.title || r.title } : r));
      return { ...state, threads: { ...state.threads, [a.bot]: rows } };
    }
    case "thread.note":
      return touchChat(state, a.bot, (c) => {
        if (c.items.some((i) => i.id === a.item.id)) return c;
        // right under the answer and the lines already under it; at the end when that answer is not here
        let at = c.items.findIndex((i) => i.id === a.message);
        if (at < 0) at = c.items.length;
        else {
          at += 1;
          while (at < c.items.length && (c.items[at].kind === "threadLink" || c.items[at].kind === "threadRoute")) at += 1;
        }
        return withItems(c, [...c.items.slice(0, at), a.item, ...c.items.slice(at)]);
      });
    case "helpers.ask":
      // a lead lane's Start helpers card, after the answer that asked (item 102e)
      return touchChat(state, a.bot, (c) => (c.items.some((i) => i.id === a.item.id) ? c : withItems(c, [...c.items, a.item])));
    case "helpers.done":
      return touchChat(state, a.bot, (c) =>
        withItems(
          c,
          c.items.map((i) => (i.kind === "helpersAsk" && i.id === a.id && !i.done ? { ...i, done: a.done } : i)),
        ),
      );
    case "reach.ask":
      // a reach card, after the answer that asked (item 102k)
      return touchChat(state, a.bot, (c) => (c.items.some((i) => i.id === a.item.id) ? c : withItems(c, [...c.items, a.item])));
    case "reach.done":
      return touchChat(state, a.bot, (c) =>
        withItems(
          c,
          // an open card takes what became of it; a card already pressed yes takes only what its press then did (the lane it opened,
          // or what went wrong)
          c.items.map((i) =>
            i.kind === "reachAsk" && i.id === a.id && (!i.done || (i.done === "yes" && a.done === "yes"))
              ? { ...i, done: a.done, ...(a.lane ? { lane: a.lane } : {}), ...(a.error ? { error: a.error } : {}) }
              : i,
          ),
        ),
      );
    case "thread.routed":
      return touchChat(state, a.bot, (c) =>
        withItems(
          c,
          c.items.map((i) => (i.kind === "threadRoute" && i.id === a.id ? { ...i, done: a.done, error: a.error } : i)),
        ),
      );
    case "thread.gone": {
      const list = state.threads[a.bot];
      const key = threadKey(a.bot, a.thread);
      if (!list?.some((r) => r.thread === a.thread) && !state.chats[key] && state.ui.thread !== a.thread) return state;
      const chats = { ...state.chats };
      delete chats[key];
      const open = state.selectedBot === a.bot && state.ui.thread === a.thread;
      return {
        ...state,
        chats,
        threads: { ...state.threads, [a.bot]: (list ?? []).filter((r) => r.thread !== a.thread) },
        ui: open ? { ...state.ui, thread: null } : state.ui,
      };
    }
    case "watch.missed":
      return a.count > 0 && a.bot !== state.selectedBot
        ? { ...state, unread: { ...state.unread, [a.bot]: (state.unread[a.bot] ?? 0) + a.count } }
        : state;
    case "chat.opened":
      return touchChat(state, a.bot, (c) => ({ ...applyOpened(c, a.res, a.now, a.bot, a.since), openError: null }));
    case "local.user":
      return touchChat(state, a.bot, (c0) => {
        // the running turn's answer stays above this message (answerSlot) when it is held (it goes out after the
        // turn, so the answer never covers it) or typed once the answer already shows; one steered in joins the
        // turn, so the answer and the live dots come under it, as in a messenger
        const c = c0.turn && !c0.turn.before && !a.steer && (a.held || answerSoFar(c0.turn)) ? patchTurn(c0, (t) => ({ ...t, before: a.id })) : c0;
        const next = withItems(c, [
          ...c.items,
          {
            kind: "user",
            id: a.id,
            ts: a.now / 1000,
            text: a.text,
            ...(a.reply ? { reply: a.reply } : {}),
            ...(a.files?.length ? { files: a.files } : {}),
            ...(a.sent !== undefined && a.sent !== a.text ? { sent: a.sent } : {}),
            ...(a.skills?.length ? { skills: a.skills } : {}),
            ...(a.held ? { held: true } : {}),
            ...(a.held && a.steer ? { autoSteer: true } : {}),
          },
        ]);
        const queued = a.held ? { ...next, queue: [...(c.queue ?? []), a.id] } : next;
        return a.held && a.steer ? liveBeside(queued, a.id, 1) : queued;
      });
    case "reply.set":
      return { ...state, replyTo: { ...state.replyTo, [a.bot]: a.chip } };
    case "send.ok":
      return state.chats[a.bot] ? touchChat(state, a.bot, (c) => markRead(c, a.id, a.now)) : state;
    case "send.failed":
      return touchChat(state, a.bot, (c) => ({
        ...withItems(
          c,
          c.items.map((i) => (i.kind === "user" && i.id === a.id ? (({ readAt: _r, ...m }) => ({ ...m, error: a.error }))(i) : i)),
        ),
        ...(c.pendingTurn === a.id ? { pendingTurn: null } : {}),
      }));
    case "queue.take":
    case "queue.front":
    case "queue.drop":
    case "queue.steering":
    case "queue.steered":
    case "queue.resend":
    case "queue.idle":
      return state.chats[a.bot] ? touchChat(state, a.bot, (c) => reduceQueue(c, a)) : state;
    case "event":
      return reduceEvent(state, a.ev, a.now);
    case "approval.passed":
      return touchChat(state, a.bot, (c) =>
        withItems(
          c,
          c.items.map((i) => {
            if (i.kind !== "approval" || i.request_id !== a.request_id) return i;
            const { passOn: _passOn, ...rest } = i;
            return { ...rest, passedOn: a.passed };
          }),
        ),
      );
    case "shops":
      return { ...state, shops: { ...state.shops, list: a.list, current: a.current, left: a.left, loaded: true } };
    case "shops.dismiss":
      return state.shops.dismissed.includes(a.id) ? state : { ...state, shops: { ...state.shops, dismissed: [...state.shops.dismissed, a.id] } };
    case "shop.switched": {
      // Every page shows another shop now: what the last one's pages showed goes (its chats, threads, schedules, places),
      // and is read again for the new one. Every shop's asks stay, since Needs you is one across the shops.
      const chats = Object.fromEntries(
        Object.entries(state.chats).map(([k, c]) => [k, withItems(emptyChat(), c.items.filter((i) => i.kind === "approval" && !!i.shop))]),
      );
      const ui = { ...state.ui, thread: null, ...(state.ui.view === "job" ? { view: "home" as const, job: null } : {}) };
      return { ...state, chats, threads: {}, routines: {}, automations: null, elsewhere: {}, peeks: {}, unread: {}, replyTo: {}, ui };
    }
    case "approval.resolved":
      return touchChat(state, a.bot, (c) =>
        doneWaiting(
          withItems(
            c,
            c.items.map((i) =>
              i.kind === "approval" && i.request_id === a.request_id ? { ...i, resolved: a.choice, ...(a.by ? { decidedBy: a.by } : {}) } : i,
            ),
          ),
        ),
      );
    case "clarify.resolved":
      return touchChat(state, a.bot, (c) =>
        doneWaiting(
          withItems(
            c,
            c.items.map((i) =>
              i.kind === "clarify" && i.request_id === a.request_id
                ? { ...i, answer: a.answer, ...(a.answers ? { answers: a.answers } : {}) }
                : i,
            ),
          ),
        ),
      );
    case "elsewhere":
      return {
        ...state,
        elsewhere: { ...state.elsewhere, [a.bot]: [...a.sessions].sort((x, y) => y.last_active - x.last_active) },
      };
    case "peek.loading":
      return {
        ...state,
        peeks: {
          ...state.peeks,
          [a.id]: { messages: state.peeks[a.id]?.messages ?? [], total: state.peeks[a.id]?.total ?? 0, loading: true },
        },
      };
    case "peek.loaded":
      return { ...state, peeks: { ...state.peeks, [a.id]: { messages: a.messages, total: a.total, loading: false } } };
    case "peek.failed":
      return {
        ...state,
        peeks: {
          ...state.peeks,
          [a.id]: { messages: state.peeks[a.id]?.messages ?? [], total: state.peeks[a.id]?.total ?? 0, loading: false, error: a.error },
        },
      };
    case "routines":
      return { ...state, routines: { ...state.routines, [a.bot]: a.routines } };
    case "automations":
      return { ...state, automations: a.automations };
    case "ui.automations":
      return { ...state, ui: { ...state.ui, view: "automations", back: backOf(state.ui), ...(a.job !== undefined ? { automation: a.job } : {}) } };
    case "ui.plugins":
      return { ...state, ui: { ...state.ui, view: "plugins", back: backOf(state.ui), ...(a.bot ? { pluginsBot: a.bot } : {}) } };
    case "ui.tasks":
      return { ...state, ui: { ...state.ui, view: "tasks", back: backOf(state.ui) } };
    case "ui.job":
      return { ...state, ui: { ...state.ui, view: "job", back: backOf(state.ui), job: a.job } };
    case "ui.activity":
      return { ...state, ui: { ...state.ui, view: "activity", back: backOf(state.ui) } };
    case "ui.page":
      // A menu page is a place of its own, not a page in front of one, so it keeps no way back: the shortcuts that
      // leave a page for the chat (⌘., ⌘⇧G) call closeSettings, and from here that must land on the chat.
      return { ...state, ui: { ...state.ui, view: a.page, back: "chat", ...(a.find ? { findSeq: state.ui.findSeq + 1, findQuery: a.query ?? "" } : {}) } };
    case "ui.lang":
      return { ...state, ui: { ...state.ui, lang: a.lang } };
    case "ui.shop":
      return { ...state, ui: { ...state.ui, shop: a.shop } };
    case "ui.firstRun":
      return { ...state, ui: { ...state.ui, firstRun: a.flow } };
    case "models":
      return { ...state, models: { ...state.models, [a.bot]: a.options } };
    case "agentBox":
      return { ...state, agentBox: { ...state.agentBox, [a.key]: a.box } };
    case "model.set": {
      const next = touchChat(state, a.bot, (c) => ({
        ...c,
        model: a.current.model,
        provider: a.current.provider,
        reasoning: a.current.reasoning,
      }));
      return {
        ...next,
        bots: next.bots.map((b) =>
          b.name === a.bot ? { ...b, model: a.current.model, provider: a.current.provider } : b,
        ),
        models: next.models[a.bot]
          ? { ...next.models, [a.bot]: { ...next.models[a.bot], current: a.current } }
          : next.models,
      };
    }
    case "ui.panel": {
      const open = a.open ?? !state.ui.panelOpen;
      // closing the panel also restores it: it opens again at its own width
      return { ...state, ui: { ...state.ui, panelOpen: open, ...(open ? {} : { panelMax: false }) } };
    }
    case "ui.panelTab":
      return { ...state, ui: { ...state.ui, panelOpen: true, panelTab: a.tab } };
    case "ui.run":
      return { ...state, ui: { ...state.ui, panelOpen: true, panelTab: "runs", runId: a.run } };
    case "ui.panelMax":
      return {
        ...state,
        ui: { ...state.ui, panelMax: a.open, ...(a.open ? { panelOpen: true, ...(a.tab ? { panelTab: a.tab } : {}) } : {}) },
      };
    case "ui.draft":
      return { ...state, ui: { ...state.ui, draft: { bot: a.bot, text: a.text, n: (state.ui.draft?.n ?? 0) + 1 } } };
    case "ui.theme":
      return { ...state, ui: { ...state.ui, theme: a.theme } };
    case "ui.look":
      return { ...state, ui: { ...state.ui, look: { ...state.ui.look, ...a.look } } };
    case "ui.settings":
      return { ...state, ui: { ...state.ui, view: "settings", back: backOf(state.ui), settingsPage: a.page ?? state.ui.settingsPage } };
    case "ui.closeSettings":
      // Back to the menu page or the session the page was opened from (a session only while it is still open),
      // otherwise to the chat.
      return { ...state, ui: { ...state.ui, view: state.ui.back === "session" && !state.ui.session ? "chat" : state.ui.back, back: "chat" } };
    case "system.note":
      return touchChat(state, a.bot, (c) =>
        withItems(c, [...c.items, { kind: "system", id: `system-${a.now}-${c.items.length}`, ts: a.now / 1000, text: a.text, ...(a.detail ? { detail: a.detail } : {}) }]),
      );
    case "ui.restore": {
      const { session, runsFull, ...rest } = a.ui;
      // the snapshot's `runsFull` carries the maximised panel
      const max = runsFull && rest.panelOpen;
      return { ...state, ui: { ...state.ui, ...rest, panelMax: max, ...(session ? { view: "session" as const, session } : {}) } };
    }
    case "ui.session":
      return a.id
        ? { ...state, ui: { ...state.ui, view: "session", session: a.id } }
        : { ...state, ui: { ...state.ui, view: state.ui.view === "session" ? "chat" : state.ui.view, session: null } };
    case "ui.pin": {
      const rest = state.ui.pinned.filter((b) => b !== a.bot);
      return { ...state, ui: { ...state.ui, pinned: a.on ? [...rest, a.bot] : rest } };
    }
    case "ui.roster":
      return { ...state, ui: { ...state.ui, roster: a.roster } };
    case "ui.order":
      return { ...state, ui: { ...state.ui, pinned: a.pinned, roster: a.roster } };
    case "ui.focusAsk":
      return { ...state, ui: { ...state.ui, focusAsk: { bot: a.bot, id: a.id, seq: (state.ui.focusAsk?.seq ?? 0) + 1 } } };
    case "turn.reasonMoved": {
      const c = state.chats[a.bot];
      const last = c?.lastTurn;
      if (!c || !last || last.outcome !== "error" || last.error?.trim() !== a.error.trim()) return state;
      return { ...state, chats: { ...state.chats, [a.bot]: patchTurnById(c, last.id, ({ error: _, ...t }) => t) } };
    }
    case "chat.forget": {
      if (!state.chats[a.bot]) return state;
      const chats = { ...state.chats };
      delete chats[a.bot];
      return { ...state, chats };
    }
    default:
      return state;
  }
}
