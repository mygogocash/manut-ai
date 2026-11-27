// The Helpers card once a round runs (item 102h; `docs/several-agents.md`, "4. Helper lanes a lane asks for"): under the Start helpers
// card's settled line in the lead lane's chat, one row per helper lane in the form of the Subagents card (chat/activity/Subagents.tsx):
// the agent's mark, a link line that opens its chat ("→ Helper 1: Tests for the QR builder", the fork's `ThreadLinkLine`), its state,
// its current step and its time, "Waiting for you" in amber with Answer while its ask waits, and Stop on each row with Stop all in the
// head. Only the person presses them: nothing an agent writes reaches a Stop, and Answer only opens the helper's own chat at its ask,
// where its card is answered as any ask is.
//
// Once a helper lane reports, its row says how its work landed in the lead's folder (item 102i, `helperLandings.ts`): waiting for the
// lead to be idle, landing, "Landed 3 files", "Landed 2 files, 1 with conflicts: src/qr.ts", "Changed nothing", kept as a patch with
// the reason (it would not apply, or it names a file outside the project), or not landed and why; each file a key is in is named,
// never the key. A kept patch offers Show patch (its text, read-only, masked); a landing in the lead offers Take back this landing,
// which waits until the lead is idle and says the shell's reason when the lead's folder changed since.
//
// `HelperRunView` draws from props alone, so a test renders each state; `HelperRunCard` reads the sessions store (the runs, each
// helper's chat for its turn and asks, the landings) and presses through it.
import "../chat/activity/activity.css";
import "./helpers.css";
import { useState, useSyncExternalStore } from "react";
import { listText, t, type Key } from "../i18n";
import { elapsed } from "../app/time";
import { useClock } from "../app/clock";
import { maskSecrets, revealHidden } from "../lib/secrets";
import { DiffView } from "../chat/activity/Work";
import { AgentMark } from "../sessions/AgentMark";
import type { AgentId } from "../sessions/agents";
import { getSessions } from "../sessions/sessions";
import { getStore, selectAsks, useStore } from "../state/store";
import { Spinner } from "../ui";
import type { HelperLanding } from "./helperLandings";
import type { HelperRun } from "./helperRuns";
import { patchFiles, type LanePatch } from "./landingWire";
import { endingOf, landingOutcome, type Ending } from "./rules";

/** A row's state as the card says it. */
export type RowState = "waiting" | "starting" | "working" | "asking" | "idle" | "stopping" | "dropped" | Ending;

/** One row of the card, from props alone. */
export interface RunRow {
  readonly index: number;
  readonly title: string;
  readonly agent: string;
  readonly state: RowState;
  /** the step its turn names now, while it works */
  readonly step?: string;
  /** when its turn began (ms), while it works */
  readonly since?: number | null;
  /** the line under it: why it did not start, how it failed, that its process was closed */
  readonly line?: string;
  /** its chat can be opened */
  readonly canOpen: boolean;
  /** the person can stop it now */
  readonly canStop: boolean;
  /** how its work landed in the lead's folder, once it reported (item 102i) */
  readonly land?: LandRow;
}

/** A row's landing as the card says it. */
export interface LandRow {
  /** its colour: quiet while it waits or lands, green once landed, amber with conflicts, red when it did not land */
  readonly tone: "queued" | "running" | "done" | "waiting" | "failed" | "stopped";
  readonly line: string;
  /** git's or the shell's own words under it, masked */
  readonly detail?: string;
  /** the files a key is in, named only */
  readonly keys: readonly string[];
  /** a patch is kept: Show patch */
  readonly canShowPatch: boolean;
  /** the landing is in the lead's folder: Take back this landing */
  readonly canTakeBack: boolean;
  /** Take back waits: the lead's turn runs or an ask of the lead waits */
  readonly takeBackWaits: boolean;
  readonly takingBack: boolean;
  /** why the last Take back was refused, in the person's words */
  readonly takeBackError?: string;
}

/** Show patch's state for one row: being read, shown, or not readable. */
export type PatchShown = { readonly state: "reading" } | { readonly state: "shown"; readonly patch: LanePatch } | { readonly state: "error"; readonly why: string };

/** The shell's refusals the card words; anything else is git's or the system's own line, masked. */
const LAND_ERRS = ["busy", "no_snapshot", "no_lead", "landed", "no_commit", "git_missing", "not_a_lane", "no_shell", "unread", "no_patch"] as const;

/** A refusal of the shell's, in the person's words. */
export function landError(code: string): string {
  if (code.startsWith("config:")) return t("helpers.land.err.config", { setting: revealHidden(code.slice(7)) });
  const k = code === "not_a_helper" ? "not_a_lane" : code;
  if ((LAND_ERRS as readonly string[]).includes(k)) return t(`helpers.land.err.${k}` as Key);
  return revealHidden(maskSecrets(code));
}

/** Why Take back was refused, in the person's words. */
export function takeBackWords(code: string): string {
  if (code === "changed" || code === "not_landed") return t(`helpers.land.tb.${code}` as Key);
  if (code === "leadBusy") return t("helpers.land.takeBackWait");
  return t("helpers.land.tb.other", { why: landError(code) });
}

/** Paths as the row names them: the first few, every character that does not show made visible (item 121). */
const paths = (list: readonly string[], more = 0): string => {
  const shown = list.slice(0, 3).map((p) => revealHidden(p));
  const rest = list.length - shown.length + more;
  return rest > 0 ? `${shown.join(", ")} (+${rest})` : listText(shown);
};

/** A helper's landing as its row says it. `leadBusy`: the lead's turn runs or one of its asks waits, so Take back waits. */
export function landRow(v: HelperLanding, leadBusy: boolean): LandRow {
  const base = { keys: [] as readonly string[], canShowPatch: false, canTakeBack: false, takeBackWaits: false, takingBack: false };
  if (v.step === "waiting") return { ...base, tone: "queued", line: t("helpers.land.waiting") };
  if (v.step === "landing") return { ...base, tone: "running", line: t("helpers.land.landing") };
  const l = v.landing;
  if (!l) return { ...base, tone: "stopped", line: t("helpers.land.unfinished") };
  const keys = (l.keys ?? []).map((k) => revealHidden(k));
  const n = l.files.length + (l.more ?? 0);
  const files = n === 1 ? t("helpers.land.landed.one") : t("helpers.land.landed.many", { n });
  switch (landingOutcome(l)) {
    case "changedNothing":
      return { ...base, tone: "stopped", line: t("helpers.land.nothing") };
    case "takenBack":
      return { ...base, tone: "stopped", line: t("helpers.land.takenBack") };
    case "landed":
      return {
        ...base,
        keys,
        tone: l.conflicts.length ? "waiting" : "done",
        line: l.conflicts.length ? t("helpers.land.conflicts", { landed: files, n: l.conflicts.length, files: paths(l.conflicts) }) : files,
        canTakeBack: true,
        takeBackWaits: leadBusy,
        takingBack: !!v.takingBack,
        ...(v.takeBackError ? { takeBackError: takeBackWords(v.takeBackError) } : {}),
      };
    case "keptPatch":
      return { ...base, keys, tone: "failed", line: t("helpers.land.kept"), canShowPatch: true, ...(l.error && l.error !== "would_not_apply" ? { detail: landError(l.error) } : {}) };
    case "keptOutside": {
      const named = paths(l.outside ?? []);
      const line =
        l.refusal === "other_repo" ? t("helpers.land.otherRepo") : l.refusal === "bad_path" ? t("helpers.land.badPath", { files: named }) : t("helpers.land.outside", { files: named });
      return { ...base, keys, tone: "failed", line, canShowPatch: true };
    }
    default:
      return { ...base, tone: "failed", line: t("helpers.land.failed", { why: landError(l.error ?? "") }) };
  }
}

const STATE_KEY: Record<RowState, Key> = {
  waiting: "helpers.run.st.waiting",
  starting: "helpers.run.st.starting",
  working: "helpers.run.st.working",
  asking: "helpers.run.st.asking",
  idle: "helpers.run.st.idle",
  stopping: "helpers.run.st.stopping",
  dropped: "helpers.run.st.dropped",
  done: "helpers.run.st.done",
  budgetSpent: "helpers.run.st.budgetSpent",
  failed: "helpers.run.st.failed",
  couldNotRun: "helpers.run.st.couldNotRun",
  stoppedByPerson: "helpers.run.st.stoppedByPerson",
};

/** The Subagents card's tone for each state: ink while it works, amber while it waits on the person, green once it reported, red
 *  when it failed, muted otherwise. */
const TONE: Record<RowState, string> = {
  waiting: "queued",
  starting: "running",
  working: "running",
  asking: "waiting",
  idle: "queued",
  stopping: "queued",
  dropped: "stopped",
  done: "done",
  budgetSpent: "waiting",
  failed: "failed",
  couldNotRun: "failed",
  stoppedByPerson: "stopped",
};

const firstLine = (s: string) => s.split("\n").map((l) => l.trim()).find(Boolean) ?? "";

/** The rows of a round from its runs and what each helper's chat shows now. `chat` answers for a helper's session: whether a turn
 *  runs (its step and start), and how many of its asks wait. */
export function runRows(
  runs: readonly HelperRun[],
  chat: (session: string) => { turn: { status: string; startedAt: number } | null; asks: number; starting: boolean },
  landings: readonly HelperLanding[] = [],
  leadBusy = false,
): RunRow[] {
  return runs.map((r): RunRow => {
    const lv = r.state === "back" ? landings.find((x) => x.index === r.index) : undefined;
    const base = { index: r.index, title: r.row.title, agent: r.row.agent, canOpen: !!r.session, ...(lv ? { land: landRow(lv, leadBusy) } : {}) };
    if (r.state === "waiting") return { ...base, state: "waiting", canStop: true };
    if (r.state === "starting") return { ...base, state: r.stopping ? "stopping" : "starting", canStop: !r.stopping };
    if (r.state === "dropped") return { ...base, state: "dropped", canStop: false, line: t(r.dropped === "breaker" ? "helpers.run.dropped.breaker" : "helpers.run.dropped.person") };
    if (r.state === "notStarted") return { ...base, state: "couldNotRun", canStop: false, ...(r.why ? { line: r.why } : {}) };
    if (r.state === "back" && r.report) {
      const ending = endingOf(r.report);
      const line = ending === "failed" ? firstLine(r.report.words) : r.ended ? t("helpers.run.ended") : "";
      return { ...base, state: ending, canStop: false, ...(line ? { line } : {}) };
    }
    const c = r.session ? chat(r.session) : { turn: null, asks: 0, starting: true };
    if (r.stopping) return { ...base, state: "stopping", canStop: false };
    if (c.asks > 0) return { ...base, state: "asking", canStop: true, ...(c.turn ? { since: c.turn.startedAt } : {}) };
    if (c.turn) return { ...base, state: "working", canStop: true, step: c.turn.status, since: c.turn.startedAt };
    return { ...base, state: c.starting ? "starting" : "idle", canStop: true };
  });
}

export interface HelperRunViewProps {
  rows: readonly RunRow[];
  /** how many run at once on this Mac, once known */
  atOnce?: number | null;
  now: number;
  /** Show patch, by row: what is shown under it */
  patches?: Readonly<Record<number, PatchShown>>;
  onOpen?: (index: number) => void;
  onAnswer?: (index: number) => void;
  onStop?: (index: number) => void;
  onStopAll?: () => void;
  /** Show patch, or Hide patch when it shows */
  onPatch?: (index: number) => void;
  onTakeBack?: (index: number) => void;
}

/** The KB a patch's size reads as, at least 1. */
const kb = (bytes: number) => Math.max(1, Math.round(bytes / 1024));

/** Show patch's view under a row: the patch as the diff view draws a change, read-only and masked line by line, where it is kept, and
 *  whether it was cut. */
function PatchView({ n, shown }: { n: number; shown: PatchShown }) {
  if (shown.state === "reading")
    return (
      <div className="hr-patch" data-testid="landing-patch" data-state="reading">
        <span className="hr-patch-note">{t("helpers.land.patchReading")}</span>
      </div>
    );
  if (shown.state === "error")
    return (
      <div className="hr-patch" data-testid="landing-patch" data-state="error">
        <span className="hr-patch-note" role="alert">
          {t("helpers.land.patchError", { why: landError(shown.why) })}
        </span>
      </div>
    );
  const files = patchFiles(shown.patch.text);
  return (
    <div className="hr-patch" role="region" aria-label={t("helpers.land.patchLabel", { n })} data-testid="landing-patch" data-state="shown">
      {/* opened by the person's click, it scrolls itself into view, as a file edit's change does */}
      {files.length ? <DiffView files={files} testId="landing-patch" /> : <span className="hr-patch-note">{t("helpers.land.patchNone")}</span>}
      {shown.patch.cut && <span className="hr-patch-note">{t("helpers.land.patchCut", { kb: kb(shown.patch.text.length), total: kb(shown.patch.bytes) })}</span>}
      <span className="hr-patch-note hr-patch-at" title={shown.patch.path} data-testid="landing-patch-at">
        {t("helpers.land.patchAt", { path: revealHidden(shown.patch.path) })}
      </span>
    </div>
  );
}

/** A row's landing: its line, git's words, the files a key is in, and its two presses. */
function LandLine({ r, shown, onPatch, onTakeBack }: { r: RunRow & { land: LandRow }; shown?: PatchShown; onPatch?: (index: number) => void; onTakeBack?: (index: number) => void }) {
  const l = r.land;
  return (
    <span className="hr-land-wrap" data-testid="helper-landing">
      <span className={`hr-land t-${l.tone}`} data-testid="helper-landing-line" data-tone={l.tone}>
        {l.line}
      </span>
      {l.detail && (
        <span className="hr-land-detail" data-testid="helper-landing-detail">
          {l.detail}
        </span>
      )}
      {l.keys.length > 0 && (
        <span className="hr-land-keys" data-testid="helper-landing-keys">
          {t("helpers.land.keys", { files: paths(l.keys) })}
        </span>
      )}
      {(l.canShowPatch || l.canTakeBack) && (
        <span className="hr-land-acts">
          {l.canShowPatch && onPatch && (
            <button type="button" className="hr-act" aria-expanded={!!shown} onClick={() => onPatch(r.index)} data-testid="helper-landing-patch">
              {t(shown ? "helpers.land.hidePatch" : "helpers.land.showPatch")}
            </button>
          )}
          {l.canTakeBack && onTakeBack && (
            <button
              type="button"
              className="hr-act"
              disabled={l.takeBackWaits || l.takingBack}
              onClick={() => onTakeBack(r.index)}
              title={l.takeBackWaits ? t("helpers.land.takeBackWait") : t("helpers.land.takeBackTip")}
              data-testid="helper-landing-take-back"
            >
              {t(l.takingBack ? "helpers.land.takingBack" : "helpers.land.takeBack")}
            </button>
          )}
        </span>
      )}
      {l.takeBackError && (
        <span className="hr-land-error" role="alert" data-testid="helper-landing-take-back-error">
          {l.takeBackError}
        </span>
      )}
      {shown && <PatchView n={r.index + 1} shown={shown} />}
    </span>
  );
}

/** The card from props alone. */
export function HelperRunView({ rows, atOnce, now, patches, onOpen, onAnswer, onStop, onStopAll, onPatch, onTakeBack }: HelperRunViewProps) {
  const running = rows.filter((r) => r.state === "starting" || r.state === "working" || r.state === "asking" || r.state === "idle" || r.state === "stopping").length;
  const waiting = rows.filter((r) => r.state === "waiting").length;
  const back = rows.length - running - waiting;
  const asking = rows.some((r) => r.state === "asking");
  const live = running + waiting > 0;
  return (
    <div className="sa-card hr-card" role="group" aria-label={t("helpers.run.label")} data-testid="helper-run-card" data-live={live || undefined}>
      <div className="sa-head">
        {asking ? <span className="sa-ic waiting" aria-hidden="true" /> : live ? <Spinner size={10} label={t("ui.working")} /> : <span className="sa-ic" aria-hidden="true" />}
        <span className={`sa-sum${asking ? " waiting" : ""}`} data-testid="helper-run-summary">
          {t("helpers.run.summary", { running, waiting, back })}
          {atOnce ? <span className="hr-cap"> · {t("helpers.run.cap", { n: atOnce })}</span> : null}
        </span>
        {live && onStopAll && (
          <button type="button" className="sa-open hr-stop-all" onClick={onStopAll} title={t("helpers.run.stopAllTip")} data-testid="helper-run-stop-all">
            {t("helpers.run.stopAll")}
          </button>
        )}
      </div>
      <div className="sa-rows">
        {rows.map((r) => (
          <div key={r.index} className={`sa-row hr-row s-${r.state}`} data-testid="helper-run-row" data-state={r.state} data-index={r.index}>
            <span className="sa-mark" aria-hidden="true">
              <AgentMark agent={r.agent as AgentId} size={12} />
            </span>
            <span className="sa-main">
              <span className="hr-top">
                <button
                  type="button"
                  className="hr-link"
                  disabled={!r.canOpen}
                  onClick={() => onOpen?.(r.index)}
                  title={t("helpers.run.open", { n: r.index + 1 })}
                  data-testid="helper-run-link"
                >
                  <span className="hr-arrow" aria-hidden="true">
                    →
                  </span>
                  <span className="hr-title">{t("helpers.run.link", { n: r.index + 1, title: revealHidden(r.title) })}</span>
                </button>
                <span className={`sa-st ${TONE[r.state]}`} data-testid="helper-run-state">
                  {t(STATE_KEY[r.state])}
                </span>
                {r.since != null && (
                  <span className="sa-t" data-testid="helper-run-time">
                    {elapsed(Math.max(0, now - r.since))}
                  </span>
                )}
                {r.state === "asking" && onAnswer && (
                  <button type="button" className="hr-act hr-answer" onClick={() => onAnswer(r.index)} data-testid="helper-run-answer">
                    {t("helpers.run.answer")}
                  </button>
                )}
                {r.canStop && onStop && (
                  <button type="button" className="hr-act" onClick={() => onStop(r.index)} title={t("helpers.run.stopTip", { n: r.index + 1 })} data-testid="helper-run-stop">
                    {t("helpers.run.stop")}
                  </button>
                )}
              </span>
              {(r.state === "working" && r.step) || r.line ? (
                <span className="sa-line" title={r.line ?? r.step} data-testid="helper-run-line">
                  {r.state === "working" && r.step ? <code>{r.step}</code> : r.line}
                </span>
              ) : null}
              {r.land ? <LandLine r={r as RunRow & { land: LandRow }} shown={patches?.[r.index]} onPatch={onPatch} onTakeBack={onTakeBack} /> : null}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

const noRuns: readonly HelperRun[] = [];
const noLandings: readonly HelperLanding[] = [];

/** The timeline's card for round `round`: the runs and their landings from the sessions store, each helper's chat read for its turn
 *  and its asks, and the lead's for whether Take back must wait. */
export function HelperRunCard({ round }: { round: string }) {
  const ss = getSessions();
  const runs = useSyncExternalStore(ss.onHelperRuns, () => ss.helperRuns(round) ?? noRuns, () => noRuns);
  const landings = useSyncExternalStore(ss.onHelperLandings, () => ss.helperLandings(round) ?? noLandings, () => noLandings);
  const atOnce = useSyncExternalStore(ss.onHelperRuns, ss.helpersAtOnce, ss.helpersAtOnce);
  const [patches, setPatches] = useState<Record<number, PatchShown>>({});
  const app = useStore();
  const asks = selectAsks(app);
  const leadKey = runs[0] ? ss.chatKey(runs[0].lead) : null;
  const leadBusy = !!leadKey && (!!app.chats[leadKey]?.turn || asks.some((a) => a.bot === leadKey));
  const rows = runRows(
    runs,
    (session) => {
      const key = ss.chatKey(session);
      const turn = key ? app.chats[key]?.turn : undefined;
      const status = ss.getState().list.find((r) => r.id === session)?.status;
      return {
        turn: turn ? { status: turn.status, startedAt: turn.startedAt } : null,
        asks: key ? asks.filter((a) => a.bot === key).length : 0,
        starting: status === "starting" || status === "draft",
      };
    },
    landings,
    leadBusy,
  );
  const live = rows.some((r) => r.since != null);
  const now = useClock(live);
  const session = (i: number) => runs.find((r) => r.index === i)?.session;
  const showPatch = async (i: number) => {
    if (patches[i]) {
      const next = { ...patches };
      delete next[i];
      return setPatches(next);
    }
    setPatches((p) => ({ ...p, [i]: { state: "reading" } }));
    const got = await ss.landingPatch(round, i);
    setPatches((p) => (p[i] ? { ...p, [i]: got.ok ? { state: "shown", patch: got.patch } : { state: "error", why: got.why } } : p));
  };
  return (
    <HelperRunView
      rows={rows}
      atOnce={atOnce}
      now={now}
      patches={patches}
      onPatch={(i) => void showPatch(i)}
      onTakeBack={(i) => void ss.takeBackLanding(round, i)}
      onOpen={(i) => {
        const id = session(i);
        if (id) getStore().actions.openSession(id);
      }}
      onAnswer={(i) => {
        const id = session(i);
        const key = id ? ss.chatKey(id) : null;
        const first = key ? selectAsks(getStore().getState()).find((a) => a.bot === key) : undefined;
        if (key && first) void getStore().actions.jumpToAsk(key, first.item.id);
        else if (id) getStore().actions.openSession(id);
      }}
      onStop={(i) => void ss.stopHelper(round, i)}
      onStopAll={() => void ss.stopHelpers(round)}
    />
  );
}
