// Landings in the chat (item 102i; `docs/several-agents.md`, "4. Helper lanes a lane asks for" and rule R8). Kept by the sessions store
// (`sessions/sessions.ts`), which hands this item 102h's hand-off (`whenHelperBack`), its sessions' records, its chats' state and the
// shell's landing calls (`lane_land`, `lane_take_back` and `lane_patch`, item 102g's src-tauri/src/lane_land.rs).
//
// Each helper lane that reports finished work is landed in its lead lane's folder: one at a time per lead, in the order they
// reported, and only while the lead is idle (no turn of it runs and no ask or question of it waits on the person). A helper that
// reports while the lead is busy waits on its row until the lead is idle. The outcome goes on the helper's row in the Helpers card and
// into the round's report (item 102d's `settleLanding`), where item 102j reads it; once every helper of a round is back and every
// landing settled, `whenRoundLanded` hands the round over. Nothing here sends a word to the lead: the reports are item 102j's.
//
// What it never does: land while the lead works or an ask of the lead waits (`idle`), land two at once into one lead (`busy`, beside
// the shell's own lock), start a turn of the lead while a landing writes its folder (the sessions store asks `beforeSend` before each
// message to an agent and waits), land a helper that was stopped or failed (only finished work lands, as GoSpark's
// `buddyHeadTurnFinished`), or answer, settle or withdraw any ask. Take back this landing is only ever the person's press.
import type { SessionRec } from "../sessions/agents";
import type { HelperRow } from "./helperAsks";
import type { HelperBack } from "./helperRuns";
import { landingOf, refusedLanding, type LanePatch, type LaneLanded, type LaneTakenBack } from "./landingWire";
import { isQuiet, landed, settleLanding, type Landing, type Rounds } from "./rules";

/** Where a helper lane's landing is. `waiting`: it reported and waits for the lead to be idle, or for the landing before it;
 *  `landing`: the shell is writing it; `settled`: `landing` says what it did (null: nothing was tried, `skipped` says why). */
export type LandStep = "waiting" | "landing" | "settled";

/** One helper lane's landing, as its row in the Helpers card draws it. */
export interface HelperLanding {
  readonly lead: string;
  readonly round: string;
  /** its place in its round, from 0 */
  readonly index: number;
  /** its lane's folder, the one thing the shell is named (a closed chat keeps its folder, so this is read once, as it reports) */
  readonly worktree: string;
  readonly step: LandStep;
  /** what the landing did, once settled; null when nothing was tried */
  readonly landing?: Landing | null;
  /** why nothing was tried: it was stopped or failed, and only finished work lands */
  readonly skipped?: "unfinished";
  /** the person pressed Take back this landing and the shell has not answered yet */
  readonly takingBack?: boolean;
  /** why the last Take back was refused: the shell's short code (`changed`, `not_landed`, ...), its words, or `leadBusy` */
  readonly takeBackError?: string;
}

/** A round whose helpers are all back and whose landings are all settled (item 102i's hand-off to 102j): each helper's landing in
 *  helper order, null where nothing was tried. Nothing has been sent to the lead. */
export interface RoundLanded {
  readonly lead: string;
  readonly round: string;
  readonly landings: readonly { readonly index: number; readonly landing: Landing | null }[];
}

/** What the landings need from the sessions store and the shell. */
export interface LandDeps {
  rec(id: string): SessionRec | undefined;
  /** a turn of session `id` runs now */
  working(id: string): boolean;
  /** the ids of the asks and questions of session `id`'s chat that wait on the person */
  asks(id: string): string[];
  rounds(lead: string): Rounds<HelperRow>;
  setRounds(lead: string, r: Rounds<HelperRow>): void;
  /** the shell's `lane_land` for the helper lane in folder `helper`; rejects with its short code or git's line */
  land(helper: string): Promise<LaneLanded>;
  /** the shell's `lane_take_back` */
  takeBack(helper: string): Promise<LaneTakenBack>;
  /** the shell's `lane_patch`: the patch a landing kept, masked */
  patch(helper: string): Promise<LanePatch>;
  /** hears every change of the chats' state (the app store), until the returned function is called */
  watch(fn: () => void): () => void;
}

/** How long after a message to the lead went its turn may take to show before a landing may start anyway: the agent said nothing
 *  of a turn, so none runs. */
export const SEND_GRACE_MS = 10_000;

const NONE: readonly HelperLanding[] = [];
const keyOf = (round: string, index: number) => `${round}\0${index}`;
const words = (e: unknown): string => (e instanceof Error ? e.message : typeof e === "string" ? e : "") || "unread";

export function createHelperLandings(deps: LandDeps) {
  /** every landing, by round and place */
  const views = new Map<string, HelperLanding>();
  /** the helpers waiting to land, by lead, in the order they reported */
  const queues = new Map<string, { round: string; index: number }[]>();
  /** the shell's work under way for a lead (a landing or a Take back), one at a time */
  const busy = new Map<string, Promise<void>>();
  /** leads a message was just sent to whose turn has not shown yet: no landing starts in between (`beforeSend`) */
  const sending = new Map<string, number>();
  /** leads whose chat was closed: nothing lands in them, whatever their chat shows as it goes */
  const closing = new Set<string>();
  /** rounds already handed over by `whenRoundLanded`, until a helper of theirs reports again */
  const handed = new Set<string>();
  const roundListeners = new Set<(r: RoundLanded) => void>();
  const listeners = new Set<() => void>();
  let snap: Record<string, readonly HelperLanding[]> = {};
  let unwatch: (() => void) | null = null;

  const emit = () => {
    const by: Record<string, HelperLanding[]> = {};
    for (const v of views.values()) (by[v.round] ??= []).push(v);
    for (const list of Object.values(by)) list.sort((a, b) => a.index - b.index);
    snap = by;
    for (const l of [...listeners]) l();
  };
  const patch = (round: string, index: number, p: Partial<HelperLanding>) => {
    const k = keyOf(round, index);
    const v = views.get(k);
    if (!v) return;
    views.set(k, { ...v, ...p });
    emit();
  };

  /** The lead is idle (R8): no turn of it runs, no ask or question of it waits on the person, and no message just sent to it is
   *  still on its way to a turn. */
  const idle = (lead: string) => !!deps.rec(lead) && !closing.has(lead) && !deps.working(lead) && deps.asks(lead).length === 0 && !sending.has(lead);

  /** Hears the chats while a landing waits for its lead, or a message's turn has not shown: the next landing starts the moment the
   *  lead is idle. Stops hearing once nothing waits. */
  const syncWatch = () => {
    const need = sending.size > 0 || [...queues.values()].some((q) => q.length > 0);
    if (need && !unwatch) unwatch = deps.watch(onChats);
    else if (!need && unwatch) {
      unwatch();
      unwatch = null;
    }
  };
  let inChats = false;
  const onChats = () => {
    if (inChats) return;
    inChats = true;
    try {
      // a message's turn showed: the lead is busy by its turn from here
      for (const lead of [...sending.keys()]) if (deps.working(lead)) sending.delete(lead);
      for (const lead of [...queues.keys()]) pump(lead);
      syncWatch();
    } finally {
      inChats = false;
    }
  };

  /** Runs `fn` after whatever the shell is doing for `lead`, as the one piece of work for it then; the next waiting landing may
   *  start once it is done. */
  const serial = <T>(lead: string, fn: () => Promise<T>): Promise<T> => {
    const before = busy.get(lead) ?? Promise.resolve();
    const run = before.then(fn);
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    busy.set(lead, tail);
    void tail.then(() => {
      if (busy.get(lead) === tail) busy.delete(lead);
      pump(lead);
    });
    return run;
  };

  /** Helper `index` of `round` is settled: its row says so, the round's report carries it, and a round now whole is handed over. */
  const settle = (lead: string, round: string, index: number, landing: Landing | null, extra: Partial<HelperLanding> = {}) => {
    patch(round, index, { step: "settled", landing, ...extra });
    deps.setRounds(lead, settleLanding(deps.rounds(lead), round, index, landing));
    roundCheck(lead, round);
  };

  /** Hands round `round` over once every helper of it is back, every landing settled and none waiting or under way. */
  const roundCheck = (lead: string, round: string) => {
    if (handed.has(round)) return;
    const r = deps.rounds(lead).rounds.find((x) => x.id === round);
    if (!r || !r.back || r.reports.some((y) => y.landing === "pending")) return;
    if ([...views.values()].some((v) => v.round === round && v.step !== "settled")) return;
    handed.add(round);
    const landings = [...r.reports].sort((a, b) => a.index - b.index).map((y) => ({ index: y.index, landing: y.landing === "pending" ? null : y.landing }));
    const done: RoundLanded = { lead, round, landings };
    for (const l of [...roundListeners]) l(done);
  };

  /** Lands the next waiting helper of `lead` when the lead is idle and the shell is doing nothing for it. */
  const pump = (lead: string) => {
    const q = queues.get(lead);
    if (!q?.length) {
      queues.delete(lead);
      syncWatch();
      return;
    }
    if (busy.has(lead) || !idle(lead)) {
      syncWatch();
      return;
    }
    const next = q.shift()!;
    if (!q.length) queues.delete(lead);
    const v = views.get(keyOf(next.round, next.index));
    if (!v) return pump(lead);
    patch(next.round, next.index, { step: "landing" });
    void serial(lead, async () => {
      let landing: Landing;
      try {
        landing = landingOf(await deps.land(v.worktree));
      } catch (e) {
        landing = refusedLanding(words(e));
      }
      settle(lead, next.round, next.index, landing);
    });
    syncWatch();
  };

  return {
    /** Item 102h's hand-off: a helper lane came back. Finished work waits to land in its lead; a helper that was stopped or failed
     *  lands nothing (its work stays in its own folder); one whose earlier landing is still in the lead keeps that landing, since
     *  the shell lands a helper lane once until it is taken back. A late report (`kept` false) is not landed. */
    back(b: HelperBack): void {
      const k = keyOf(b.round, b.index);
      const prev = views.get(k);
      if (b.kept && b.report.landing === "pending") {
        handed.delete(b.round);
        const worktree = (b.session ? deps.rec(b.session)?.lane?.worktree : undefined) ?? prev?.worktree ?? "";
        const view: HelperLanding = { lead: b.lead, round: b.round, index: b.index, worktree, step: "waiting" };
        if (prev?.step === "waiting" || prev?.step === "landing") {
          // it is in line or being written: that landing settles its report again
        } else if (prev?.step === "settled" && prev.landing && landed(prev.landing)) {
          settle(b.lead, b.round, b.index, prev.landing);
        } else if (b.report.ended !== "done" || !worktree) {
          views.set(k, view);
          settle(b.lead, b.round, b.index, null, { skipped: "unfinished" });
        } else {
          views.set(k, view);
          emit();
          const q = queues.get(b.lead) ?? [];
          q.push({ round: b.round, index: b.index });
          queues.set(b.lead, q);
          pump(b.lead);
        }
      }
      roundCheck(b.lead, b.round);
    },
    /** Asked by the sessions store before each message goes to session `id`'s agent: a landing or a Take back under way for it is
     *  waited for (null when none, so nothing else waits), and no landing starts until the message's turn shows or `afterSend` says
     *  it did not go. Only a lead with rounds is held. */
    beforeSend(id: string): Promise<void> | null {
      if (isQuiet(deps.rounds(id)) && !busy.has(id) && !queues.has(id)) return null;
      const mark = () => {
        sending.set(id, Date.now());
        syncWatch();
      };
      const b = busy.get(id);
      if (!b) {
        mark();
        return null;
      }
      return (async () => {
        // another landing may start after this one ends and before this message goes: wait for every one
        for (let w = busy.get(id); w; w = busy.get(id)) await w;
        mark();
      })();
    },
    /** The message to session `id` went (`ok`) or did not. One that went holds landings until its turn shows, or for
     *  `SEND_GRACE_MS` when no turn ever does. */
    afterSend(id: string, ok: boolean): void {
      const at = sending.get(id);
      if (at === undefined) return;
      if (!ok || deps.working(id)) {
        sending.delete(id);
        pump(id);
        return;
      }
      setTimeout(() => {
        if (sending.get(id) !== at) return;
        sending.delete(id);
        pump(id);
      }, SEND_GRACE_MS);
    },
    /** The person's Take back this landing on helper `index` of `round`: only a landing in the lead, only while the lead is idle;
     *  the shell refuses (`changed`) when the lead's folder changed since, and the row says so. */
    async takeBack(round: string, index: number): Promise<{ ok: true } | { ok: false; why: string }> {
      const v = views.get(keyOf(round, index));
      if (!v || v.step !== "settled" || !v.landing || !landed(v.landing)) return { ok: false, why: "not_landed" };
      if (v.takingBack) return { ok: false, why: "busy" };
      if (!idle(v.lead)) {
        patch(round, index, { takeBackError: "leadBusy" });
        return { ok: false, why: "leadBusy" };
      }
      patch(round, index, { takingBack: true, takeBackError: undefined });
      return serial(v.lead, async (): Promise<{ ok: true } | { ok: false; why: string }> => {
        // the lead may have started something while the landing before this one was written
        if (!idle(v.lead)) {
          patch(round, index, { takingBack: false, takeBackError: "leadBusy" });
          return { ok: false, why: "leadBusy" };
        }
        try {
          await deps.takeBack(v.worktree);
        } catch (e) {
          const why = words(e);
          patch(round, index, { takingBack: false, takeBackError: why });
          return { ok: false, why };
        }
        const landing: Landing = { ...v.landing!, takenBack: true };
        patch(round, index, { takingBack: false, landing });
        deps.setRounds(v.lead, settleLanding(deps.rounds(v.lead), round, index, landing));
        return { ok: true };
      });
    },
    /** Show patch on helper `index` of `round`: the text of the patch its landing kept, masked by the shell. */
    async patch(round: string, index: number): Promise<{ ok: true; patch: LanePatch } | { ok: false; why: string }> {
      const v = views.get(keyOf(round, index));
      if (!v?.landing?.patchPath) return { ok: false, why: "no_patch" };
      try {
        return { ok: true, patch: await deps.patch(v.worktree) };
      } catch (e) {
        return { ok: false, why: words(e) };
      }
    },
    /** Session `id` closed. A lead's helpers still waiting land nothing (R11): their rows say the lead is gone. */
    closed(id: string): void {
      const q = queues.get(id);
      closing.add(id);
      sending.delete(id);
      if (!q) return syncWatch();
      queues.delete(id);
      for (const w of q) patch(w.round, w.index, { step: "settled", landing: refusedLanding("no_lead") });
      syncWatch();
    },
    /** The landings of round `round`, in helper order: the same value until one of them changes. */
    roundLandings: (round: string): readonly HelperLanding[] => snap[round] ?? NONE,
    /** Hear each round whose landings are all settled (item 102j). The returned function stops it. */
    whenRoundLanded(fn: (r: RoundLanded) => void): () => void {
      roundListeners.add(fn);
      return () => {
        roundListeners.delete(fn);
      };
    },
    subscribe(fn: () => void): () => void {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    /** Whether the shell is landing or taking back for `lead` now (tests). */
    busy: (lead: string): boolean => busy.has(lead),
  };
}

export type HelperLandings = ReturnType<typeof createHelperLandings>;
