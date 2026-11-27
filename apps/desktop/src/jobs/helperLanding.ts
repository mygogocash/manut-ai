// Landings and the hand-over (items 102i and 102j; `docs/several-agents.md`, rules R8 and R9). Kept by the sessions store, which
// hands this item 102h's `whenBack` (each helper lane that came back), the lanes' records and chats, and the shell's landing.
//
// - A helper lane that came back in its round (`kept`) has its work landed in its lead lane's folder by the shell (`laneLand`,
//   item 102g): one landing at a time for a lead, and only while no turn of the lead runs and no ask or question of the lead
//   waits, so the lead's agent never edits a file the landing is writing. A helper that never started has nothing to land. What the
//   landing did is settled into the round (item 102d's `settleLanding`) and kept for its row: the files, the conflicts, a key the
//   masker found, or where a patch that was not applied is kept. Take back this landing puts the lead's folder back as it was.
// - When every helper of every round is back, every landing settled, the lead idle, nothing of the lead's waiting on the person, no
//   message of the person's waiting to go to it and no ask of a helper waiting, the reports go to the lead in one message
//   (`reportMessage`), taken from the rounds in one step (`takeHandOver`), so a report coming after is late and is never sent.
// - A late report (a helper the person stopped, back after its round was handed over) is shown on its row and nothing of it lands
//   or is sent.
//
// After a restart (item 102j-2, rule R11) the rounds the snapshot kept come back all back (helperRestore.ts), and `restore` holds
// them: nothing lands and nothing goes to the lead until the person presses Land what they did (`landRestored`, the same landing
// as above, one at a time while the lead is idle) or Report to Kit (`reportRestored`, which settles any landing still not done as
// not landed and lets the hand-over go as above). Each press is the person's, once.
//
// `createHelperLandings` takes everything it reads as `LandingDeps`, so a test drives it with stand-ins.
import type { LaneLanded } from "../code/laneBranch";
import type { HelperRow } from "./helperAsks";
import type { HelperBack } from "./helperRuns";
import { reportMessage } from "./helperReports";
import { landingOutcome, settleLanding, takeHandOver, type HelperReport, type Landing, type Rounds } from "./rules";

export interface LandingDeps {
  /** The folder a session's lane works in, or null when it has none. */
  laneDir(id: string): string | null;
  /** A turn of session `id` runs. */
  working(id: string): boolean;
  /** Session `id`'s agent runs and can take a message: the reports wait for it (a lead paused by a restart, or closed). */
  ready(id: string): boolean;
  /** The asks and questions of session `id` that wait on the person. */
  asks(id: string): string[];
  /** A message of the person's waits to go to session `id`. */
  personWaiting(id: string): boolean;
  rounds(lead: string): Rounds<HelperRow>;
  setRounds(lead: string, r: Rounds<HelperRow>): void;
  /** The sessions of lead `lead`'s helper lanes in its open rounds, whose asks hold the hand-over back. */
  helperSessions(lead: string): string[];
  land(helperDir: string): Promise<LaneLanded>;
  takeBack(helperDir: string): Promise<{ files: string[]; filesTotal: number }>;
  /** Sends the lead the app's own message: no bubble of the person's, and not counted as the person speaking (R4). */
  send(lead: string, text: string): Promise<boolean>;
  /** A quiet line in the lead's chat, with a longer text it can open under its own label. */
  note(lead: string, text: string, detail?: { label: string; text: string }): void;
  /** The quiet line's words, in the person's language: once the reports went ("Helpers reported to Kit"), when they could not
   *  go, and the label that opens what was sent. */
  words(): { reported: string; failed: string; showSent: string; showUnsent: string };
  every(ms: number, fn: () => void): () => void;
}

/** A helper's landing as its row shows it. */
export interface LandingView {
  /** `held`: back from before a restart and not landed; it lands only on the person's Land what they did (item 102j-2) */
  readonly state: "waiting" | "landing" | "landed" | "nothing" | "kept" | "failed" | "takenBack" | "held";
  readonly files: readonly string[];
  readonly filesTotal: number;
  readonly conflicts: readonly string[];
  /** files an added line of which holds a key the masker hides: the lead's next commit or push asks (item 117) */
  readonly keys: readonly string[];
  readonly patch: string;
  readonly why: LaneLanded["why"];
  readonly error: string;
}

const WAITING: LandingView = { state: "waiting", files: [], filesTotal: 0, conflicts: [], keys: [], patch: "", why: "", error: "" };

/** Why a patch was kept without being tried, in the words the lead reads (`reportMessage`'s "Not applied, because …"). */
const REFUSALS: Record<string, string> = {
  outside: "it names a file outside the project",
  bad_path: "it names a file the app cannot hold",
  other_repo: "it comes from another repository than the lead's",
};

/** The shell's answer as item 102d's `Landing`. The shell does not count lines, so a file's counts are left at none. */
export function toLanding(l: LaneLanded): Landing {
  const files = l.files.map((path) => ({ path, added: 0, removed: 0 }));
  if (l.outcome === "nothing") return { files: [], conflicts: [] };
  if (l.outcome === "kept") {
    const refusal = REFUSALS[l.why];
    return { files, conflicts: [], ...(l.patch ? { patchPath: l.patch } : {}), ...(refusal ? { refusal } : { error: l.error || "it would not apply" }) };
  }
  return { files, conflicts: l.conflicts };
}

const viewOf = (l: LaneLanded): LandingView => ({
  state: l.outcome === "landed" ? "landed" : l.outcome === "nothing" ? "nothing" : "kept",
  files: l.files,
  filesTotal: l.filesTotal,
  conflicts: l.conflicts,
  keys: l.keys,
  patch: l.patch,
  why: l.why,
  error: l.error,
});

/** A landing settled before a restart, as its row shows it. Its files are known; whether a key was in them is not kept. */
export function viewFromLanding(l: Landing | null): LandingView {
  if (!l) return { ...WAITING, state: "nothing" };
  const files = l.files.map((f) => f.path);
  const base = { ...WAITING, files, filesTotal: files.length, conflicts: l.conflicts, patch: l.patchPath ?? "" };
  switch (landingOutcome(l)) {
    case "changedNothing":
      return { ...base, state: "nothing" };
    case "keptOutside":
      return { ...base, state: "kept", why: "outside" };
    case "keptPatch":
      return { ...base, state: "kept", why: "would_not_apply" };
    case "failed":
      return { ...base, state: "failed", error: l.error ?? "" };
    default:
      return { ...base, state: "landed" };
  }
}

/** A helper of a round put back after a restart (item 102j-2). */
export interface RestoredHelper {
  readonly round: string;
  readonly index: number;
  readonly title: string;
  /** its lane's session, when it started and is still listed */
  readonly session: string | null;
  readonly report: HelperReport;
}

/** Where a lead's put-back rounds are: offered (nothing pressed), landing (Land what they did pressed), reporting (Report to Kit
 *  pressed, the reports waiting for the landings and an idle lead), reported. */
export interface RestartView {
  readonly state: "offered" | "landing" | "reporting" | "reported";
  readonly helpers: readonly { readonly round: string; readonly index: number; readonly title: string }[];
  /** a helper's work still waits for Land what they did */
  readonly canLand: boolean;
}

/** Why a put-back helper's work did not land, in the lead's words, when the person reported without landing it. */
export const NOT_LANDED = "the app closed before it landed, and the person reported without landing it; its work is still in its own lane";

export function createHelperLandings(d: LandingDeps) {
  /** Helpers back and waiting to land, by lead, in the order they came back. */
  const queues = new Map<string, HelperBack[]>();
  const busy = new Set<string>();
  /** Each helper's landing, by `round:index`, and the folder it came from. */
  const views = new Map<string, LandingView>();
  const dirs = new Map<string, string>();
  const leads = new Set<string>();
  /** Leads whose put-back rounds wait for the person's press: no hand-over goes for them (item 102j-2). */
  const held = new Set<string>();
  const restarts = new Map<string, { state: RestartView["state"]; helpers: RestoredHelper[] }>();
  let restartSnap: ReadonlyMap<string, RestartView> = new Map();
  const listeners = new Set<() => void>();
  let snap: ReadonlyMap<string, LandingView> = new Map();
  const changed = () => {
    snap = new Map(views);
    restartSnap = new Map(
      [...restarts].map(([lead, r]) => [
        lead,
        {
          state: r.state,
          helpers: r.helpers.map(({ round, index, title }) => ({ round, index, title })),
          canLand: r.state === "offered" && r.helpers.some((h) => views.get(keyOf(h.round, h.index))?.state === "held"),
        },
      ]),
    );
    for (const f of listeners) f();
  };
  const keyOf = (round: string, index: number) => `${round}:${index}`;
  const set = (key: string, v: LandingView) => {
    views.set(key, v);
    changed();
  };

  const settle = (b: HelperBack, landing: Landing | null) => d.setRounds(b.lead, settleLanding(d.rounds(b.lead), b.round, b.index, landing));

  /** The lead can take a landing now: no turn of it runs and nothing of it waits on the person (R8). */
  const leadIdle = (lead: string) => !d.working(lead) && d.asks(lead).length === 0;

  const handOver = async (lead: string): Promise<void> => {
    // rounds put back after a restart go only once the person pressed Report to Kit, and none go to a lead whose agent is not
    // running: they wait for it, rather than being taken and lost
    if (held.has(lead) || !d.ready(lead)) return;
    const r = d.rounds(lead);
    if (!r.rounds.length) return;
    const helperAsks = d.helperSessions(lead).reduce((n, s) => n + d.asks(s).length, 0);
    const now = { idle: !d.working(lead), asking: d.asks(lead).length > 0, personWaiting: d.personWaiting(lead) };
    const { rounds, handed } = takeHandOver(r, now, helperAsks);
    if (!handed) return;
    // taken in one step: once taken they are the lead's, and a report coming after is late
    d.setRounds(lead, rounds);
    const text = reportMessage(handed, r.roundsThisMessage);
    const w = d.words();
    // the person reads every word that went in their chat's name, and, when it could not go, the reports are still theirs to read
    if (await d.send(lead, text)) d.note(lead, w.reported, { label: w.showSent, text });
    else d.note(lead, w.failed, { label: w.showUnsent, text });
    const restart = restarts.get(lead);
    if (restart) {
      restarts.set(lead, { ...restart, state: "reported" });
      changed();
    }
  };

  const pump = async (lead: string): Promise<void> => {
    if (busy.has(lead)) return;
    const queue = queues.get(lead) ?? [];
    if (!queue.length) return void (await handOver(lead));
    if (!leadIdle(lead)) return;
    const b = queue.shift()!;
    const key = keyOf(b.round, b.index);
    const dir = b.session ? d.laneDir(b.session) : null;
    if (!dir) {
      settle(b, null);
      set(key, { ...WAITING, state: "nothing" });
      return pump(lead);
    }
    busy.add(lead);
    dirs.set(key, dir);
    set(key, { ...WAITING, state: "landing" });
    try {
      const landed = await d.land(dir);
      settle(b, toLanding(landed));
      set(key, viewOf(landed));
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      settle(b, { files: [], conflicts: [], error });
      set(key, { ...WAITING, state: "failed", error });
    } finally {
      busy.delete(lead);
    }
    return pump(lead);
  };

  // A lead that was busy is tried again: its turn ending, its ask answered and the person's message going all happen elsewhere.
  const stopTicking = d.every(1_000, () => {
    for (const lead of leads) void pump(lead);
  });

  return {
    /** A helper lane came back (item 102h's `whenBack`). */
    back(b: HelperBack): void {
      // a late report is its row's alone: nothing of it lands or goes to the lead
      if (!b.kept) return;
      leads.add(b.lead);
      const key = keyOf(b.round, b.index);
      if (!b.session) {
        settle(b, null);
        set(key, { ...WAITING, state: "nothing" });
        void pump(b.lead);
        return;
      }
      queues.set(b.lead, [...(queues.get(b.lead) ?? []), b]);
      set(key, WAITING);
      void pump(b.lead);
    },
    /** A lead's rounds put back after a restart (item 102j-2): shown, held, and nothing of them lands or goes until a press. */
    restore(lead: string, helpers: readonly RestoredHelper[]): void {
      leads.add(lead);
      held.add(lead);
      for (const h of helpers) {
        const l = h.report.landing;
        set(keyOf(h.round, h.index), l === "pending" ? { ...WAITING, state: "held" } : viewFromLanding(l));
      }
      restarts.set(lead, { state: "offered", helpers: [...helpers] });
      changed();
    },
    /** Land what they did: each put-back helper's work not landed yet lands as any landing does, while the lead is idle. Once. */
    landRestored(lead: string): boolean {
      const r = restarts.get(lead);
      if (!r || r.state !== "offered") return false;
      restarts.set(lead, { ...r, state: "landing" });
      for (const h of r.helpers) {
        const key = keyOf(h.round, h.index);
        if (views.get(key)?.state !== "held") continue;
        queues.set(lead, [...(queues.get(lead) ?? []), { lead, round: h.round, index: h.index, session: h.session, report: h.report, kept: true }]);
        set(key, WAITING);
      }
      changed();
      void pump(lead);
      return true;
    },
    /** Report to Kit: what was not landed is settled as not landed (its work stays in its lane), and the reports go to the lead as
     *  any hand-over does, after the landings Land what they did started have settled. Once. */
    reportRestored(lead: string): boolean {
      const r = restarts.get(lead);
      if (!r || r.state === "reported" || !held.has(lead)) return false;
      for (const h of r.helpers) {
        const key = keyOf(h.round, h.index);
        if (views.get(key)?.state !== "held") continue;
        d.setRounds(lead, settleLanding(d.rounds(lead), h.round, h.index, { files: [], conflicts: [], error: NOT_LANDED }));
        set(key, { ...WAITING, state: "failed", error: NOT_LANDED });
      }
      held.delete(lead);
      restarts.set(lead, { ...r, state: "reporting" });
      changed();
      void pump(lead);
      return true;
    },
    restartOf: (lead: string): RestartView | null => restartSnap.get(lead) ?? null,
    restartSnapshot: (): ReadonlyMap<string, RestartView> => restartSnap,
    /** Tries the lead's landings and hand-over now (a turn of it ended, an ask was answered). */
    poke(lead: string): Promise<void> {
      return leads.has(lead) ? pump(lead) : Promise.resolve();
    },
    /** Take back this landing: the lead's folder as it was before it. Only a landing that landed can be taken back. */
    async takeBack(round: string, index: number): Promise<boolean> {
      const key = keyOf(round, index);
      const v = views.get(key);
      const dir = dirs.get(key);
      if (!v || v.state !== "landed" || !dir) return false;
      try {
        await d.takeBack(dir);
      } catch {
        return false;
      }
      set(key, { ...v, state: "takenBack" });
      return true;
    },
    /** Helper `index` of round `round`'s landing, as its row shows it. */
    viewOf: (round: string, index: number): LandingView | null => snap.get(keyOf(round, index)) ?? null,
    snapshot: (): ReadonlyMap<string, LandingView> => snap,
    subscribe(fn: () => void): () => void {
      listeners.add(fn);
      return () => void listeners.delete(fn);
    },
    stop: stopTicking,
  };
}

export type HelperLandings = ReturnType<typeof createHelperLandings>;
