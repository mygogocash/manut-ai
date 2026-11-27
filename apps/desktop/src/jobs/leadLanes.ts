// A lead lane's helper requests (item 102e; `docs/several-agents.md`, "4. Helper lanes a lane asks for", rules R1, R3 and R4), kept
// by the sessions store (`sessions/sessions.ts`), which hands this its sessions' records, their chats and their events. It decides
// where the Helpers switch is offered, puts the lead's note in front of each message while the switch is on, reads the lead's
// answer when its turn ends, and turns a request into the Start helpers card or a line that says why there is none.
//
// Nothing here starts an agent. Start helpers settles the card's one approval in approval-core (`helperAsks.ts`), records the round
// with item 102d's rules (`openRound` in `rules.ts`), and hands the round to whoever listens on `whenRoundApproved`: item 102h does,
// to start each helper lane in its asking mode (`helperRuns.ts`, which the sessions store hands every approved round). The person's
// press is the only way there: `answer` is called from the card's buttons, and nothing an agent writes reaches it.
import { t as tr, type Key } from "../i18n";
import { agentDef, sessionMode, type AgentInfo, type SessionRec } from "../sessions/agents";
import type { ChatEvent } from "../sessions/host";
import type { ModelOption } from "../sessions/sessionTypes";
import type { AppState, HelpersAskItem } from "../state/types";
import type { Action } from "../state/reducer";
import { BRIEF_MAX, helperOutcome, helperReply, type HelperRefusal } from "./helperBlocks";
import { answerHelpersAsk, helperRows, openHelpersAsk, withdrawHelpersAsk, type HelperRow, type HelpersAsk } from "./helperAsks";
import { withHelperPolicy } from "./helperPolicy";
import { MAX_ROUNDS, mayStartRound, noRounds, openRound, personSpoke, type Rounds } from "./rules";

/** A round the person approved with Start helpers: the hand-off to item 102h, which starts its helper lanes. Its rows are exactly
 *  what the card showed, at most `ROUND_MAX`; `heldBack` counts the ones asked for past that. */
export interface HelperRoundApproved {
  /** the lead lane's session */
  readonly lead: string;
  /** the round's id: the card's approval id */
  readonly round: string;
  readonly helpers: readonly HelperRow[];
  readonly heldBack: number;
}

/** What pressing a card's button did: settled, or why nothing was (approval-core's refusal, `already_decided` or `superseded`, or
 *  `roundsSpent` when the message had its rounds, `not_found` for a card that is gone). */
export type HelpersAnswer = { ok: true } | { ok: false; refused: string };

/** What the lead lanes need from the sessions store. */
export interface LeadDeps {
  rec(id: string): SessionRec | undefined;
  chatKey(id: string): string | undefined;
  store(): { getState(): Pick<AppState, "chats">; dispatch(a: Action): void };
  agents(): readonly AgentInfo[] | null;
  /** the models and efforts session `id`'s agent listed */
  models(id: string): readonly ModelOption[];
  efforts(id: string): readonly string[];
  now?(): number;
}

/** What a turn of a lead lane wrote, as its agent sent it (the chat keeps it with the blocks taken out). */
interface Said {
  texts: string[];
  streaming: string;
  helpers: boolean;
}

/** The words for a request that could not be read. */
export function refusalWords(r: HelperRefusal): string {
  switch (r.why) {
    case "key":
      return tr("helpers.why.key", { key: r.key });
    case "value":
      return tr("helpers.why.value", { key: r.key });
    case "long":
      return tr("helpers.why.long", { max: BRIEF_MAX.toLocaleString("en-US") });
    default:
      return tr(`helpers.why.${r.why}` as Key);
  }
}

/** Whether session `rec` may offer the Helpers switch (R1, R4): a lane's chat with a folder of its own, so a landing can only ever
 *  write there, never the developer's own folder; not a workflow's lane, which nobody may be watching and which is read careful;
 *  and only an agent that runs as a chat in the app. Buddy's chat and a terminal are not sessions of this kind at all. A helper
 *  lane (item 102h, `helperOf`) does not offer it either: a helper lane cannot ask for helper lanes. */
export function helpersOffered(rec: SessionRec | undefined, agents: readonly AgentInfo[] | null): boolean {
  if (!rec || rec.status === "draft" || rec.workflow || rec.helperOf || !rec.lane?.dir) return false;
  return sessionMode(agents as AgentInfo[] | null, rec) === "chat";
}

export function createLeadLanes(deps: LeadDeps) {
  const now = () => deps.now?.() ?? Date.now();
  const rounds = new Map<string, Rounds<HelperRow>>();
  const said = new Map<string, Said>();
  const listeners = new Set<(r: HelperRoundApproved) => void>();
  let seq = 0;

  const offered = (id: string) => helpersOffered(deps.rec(id), deps.agents());
  const active = (id: string) => offered(id) && deps.rec(id)?.helpers === true;
  const note = (key: string, text: string) => deps.store().dispatch({ type: "system.note", bot: key, text, now: now() });
  const cardsOf = (key: string): HelpersAskItem[] =>
    (deps.store().getState().chats[key]?.items ?? []).filter((i): i is HelpersAskItem => i.kind === "helpersAsk");

  /** The agents a block may name, the lead's own first: those installed on this Mac that run as a chat. */
  const agentsFor = (r: SessionRec): string[] => {
    const others = (deps.agents() ?? []).filter((a) => a.path && (a.mode ?? agentDef(a.id).mode) === "chat" && a.id !== r.agent).map((a) => a.id);
    return [r.agent, ...others];
  };

  /** Every card of the lead still open is taken back: a later press settles nothing, and the card says why. */
  const withdrawOpen = (id: string) => {
    const key = deps.chatKey(id);
    if (!key) return;
    for (const card of cardsOf(key)) {
      if (card.done) continue;
      void withdrawHelpersAsk(card.id);
      deps.store().dispatch({ type: "helpers.done", bot: key, id: card.id, done: "gone" });
    }
  };

  /** The lead's turn ended: what its answer asked for becomes the card, or a line that says why there is none. */
  const turnEnded = async (id: string, outcome: unknown) => {
    const s = said.get(id);
    said.delete(id);
    const r = deps.rec(id);
    const key = deps.chatKey(id);
    if (!s?.helpers || !r || !key) return;
    const texts = [...s.texts, ...(s.streaming.trim() ? [s.streaming] : [])];
    const at = helperReply(texts);
    if (at === null) return;
    const asked = helperOutcome(texts[at]);
    // a stopped or failed turn asks for nothing: the person did not see it finish
    if (outcome !== "done") return note(key, tr("helpers.unfinished"));
    if (!active(id)) return note(key, tr("helpers.switchedOff"));
    if (asked.kind === "refused") return note(key, tr("helpers.refused", { why: refusalWords(asked.refusal) }));
    if (asked.kind !== "helpers") return;
    // a third round for one message of the person's shows no card (R4, GoSpark's maxDelegationRounds)
    if (!mayStartRound(rounds.get(id) ?? noRounds())) return note(key, tr("helpers.spent", { max: MAX_ROUNDS }));
    const turn = deps.store().getState().chats[key]?.lastTurn?.id;
    if (!turn) return;
    const { rows, heldBack } = helperRows(asked.helpers, { agent: r.agent, models: deps.models(id), efforts: deps.efforts(id) }, deps.agents());
    const ask: HelpersAsk = { id: `helpers-${id}-${turn}-${++seq}`, lead: id, leadAgent: r.agent, turn, rows, heldBack };
    await openHelpersAsk(ask);
    deps.store().dispatch({ type: "helpers.ask", bot: key, item: { kind: "helpersAsk", id: ask.id, ts: now() / 1000, ask } });
  };

  return {
    /** Session `id` may show the Helpers switch. */
    offered,
    /** Session `id` has Helpers on where it may. */
    active,
    /** The text that goes to session `id`'s agent for a message the person sent: with the lead's note in front while Helpers is
     *  on, as it is otherwise. */
    wire(id: string, text: string): string {
      const r = deps.rec(id);
      return r && active(id) ? withHelperPolicy(text, agentsFor(r)) : text;
    },
    /** Whether lead `id` may still start a round for the person's current message (R4): the app's report says so, and only then
     *  is the lead's note, with its block, put in front of it (GoSpark's closed policy leaves the block out once rounds are spent). */
    roundsLeft: (id: string): boolean => mayStartRound(rounds.get(id) ?? noRounds()),
    /** A message of the person's went to session `id`'s agent: it gets its own rounds (R4). */
    personSpoke(id: string): void {
      const r = rounds.get(id);
      if (r) rounds.set(id, personSpoke(r));
    },
    /** Helpers was turned off in session `id`: a card still open is taken back. */
    switchedOff(id: string): void {
      withdrawOpen(id);
    },
    /** An event of session `id`'s agent, before the chat takes it: a turn that starts with Helpers on is marked so (the chat then
     *  hides its blocks), and what the turn writes is kept as the agent sent it, for its end to read. */
    before(id: string, ev: ChatEvent): ChatEvent {
      if (ev.event === "turn.start") {
        // a new turn of the lead, the person's or the agent's own: an older card no longer answers what is going on
        withdrawOpen(id);
        const helpers = active(id);
        said.set(id, { texts: [], streaming: "", helpers });
        return helpers ? { ...ev, helpers: true } : ev;
      }
      const s = said.get(id);
      if (!s?.helpers) return ev;
      if (ev.event === "delta" && typeof ev.text === "string") s.streaming += ev.text;
      else if (ev.event === "message" && typeof ev.text === "string") {
        s.texts.push(ev.text);
        s.streaming = "";
      } else if (ev.event === "tool.start" && s.streaming) {
        // what was written before a tool call is commentary the chat never shows; a block in it still counts
        s.texts.push(s.streaming);
        s.streaming = "";
      }
      return ev;
    },
    /** An event of session `id`'s agent, after the chat took it: a turn's end reads what it asked for. */
    after(id: string, ev: ChatEvent): Promise<void> {
      return ev.event === "turn.end" ? turnEnded(id, ev.outcome) : Promise.resolve();
    },
    /** The person pressed Start helpers (`start`) or Not now on card `askId` of session `id`. The card's approval settles once in
     *  approval-core, against the lead's turn now (read from its chat, never from the card); a press after another turn started, or
     *  a second press, settles nothing. Start helpers then records the round (item 102d's `openRound`) and hands it to
     *  `whenRoundApproved`'s listeners; no agent starts here. */
    async answer(id: string, askId: string, start: boolean): Promise<HelpersAnswer> {
      const key = deps.chatKey(id);
      const chat = key ? deps.store().getState().chats[key] : undefined;
      const card = key ? cardsOf(key).find((c) => c.id === askId) : undefined;
      if (!key || !chat || !card) return { ok: false, refused: "not_found" };
      // the rounds of this message are spent: refused before anything is settled, so the card cannot read as approved
      if (start && !card.done && !mayStartRound(rounds.get(id) ?? noRounds())) {
        void withdrawHelpersAsk(askId);
        deps.store().dispatch({ type: "helpers.done", bot: key, id: askId, done: "gone" });
        return { ok: false, refused: "roundsSpent" };
      }
      const decided = await answerHelpersAsk(askId, start, { turnId: chat.turn?.id ?? chat.lastTurn?.id ?? null });
      if (!decided.ok) {
        if (decided.refused === "superseded") deps.store().dispatch({ type: "helpers.done", bot: key, id: askId, done: "gone" });
        return { ok: false, refused: decided.refused };
      }
      if (!start) {
        deps.store().dispatch({ type: "helpers.done", bot: key, id: askId, done: "notNow" });
        return { ok: true };
      }
      const opened = openRound(rounds.get(id) ?? noRounds<HelperRow>(), askId, card.ask.rows, now());
      if (opened.refused) return { ok: false, refused: opened.refused };
      rounds.set(id, opened.rounds);
      deps.store().dispatch({ type: "helpers.done", bot: key, id: askId, done: "started" });
      const approved: HelperRoundApproved = { lead: id, round: askId, helpers: card.ask.rows, heldBack: card.ask.heldBack };
      for (const l of [...listeners]) l(approved);
      return { ok: true };
    },
    /** Item 102h's hand-off: hear each round the person approved, to start its helper lanes (the sessions store hands each to
     *  `helperRuns.ts`). The returned function stops it. */
    whenRoundApproved(fn: (r: HelperRoundApproved) => void): () => void {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    /** Session `id`'s rounds as item 102d's rules keep them (tests, and item 102h). */
    roundsOf: (id: string): Rounds<HelperRow> => rounds.get(id) ?? noRounds<HelperRow>(),
    /** Item 102h moves session `id`'s rounds on as its helper lanes start, stop and come back (`startNext`, `recordBack`,
     *  `dropWaiting`); this store keeps the one value, so a card's next press reads where they stand. */
    setRounds(id: string, r: Rounds<HelperRow>): void {
      rounds.set(id, r);
    },
    /** Session `id` closed: what was kept for it goes. */
    forget(id: string): void {
      rounds.delete(id);
      said.delete(id);
    },
  };
}

export type LeadLanes = ReturnType<typeof createLeadLanes>;
