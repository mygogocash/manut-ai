// The second line of a member's row on the Team page: what they are doing, what waits for them, or why they are not at
// work. These are the design canvas's member states (StatesTeam.dc.html: Working, Needs you, Idle, Paused, Could not
// finish). The line is decided from what the store already holds (the member's turn, their asks, why their last turn
// stopped) and from the runtime's jobs, so it is never a number or a sentence of the page's own: a runtime that cannot
// say gives less to say, and the row then says less.
import { t } from "../i18n";
import type { JobRow, JobStage } from "../runtime/mission";
import { askText, WORKING, type Ask, type Turn } from "../state/store";
import { elapsed } from "./home";
import { whenText } from "./job";
import { sinceText } from "./pause";
import type { MemberStatus } from "./team";

/** What a member's line says. The words come from `lineWords`, so that they can follow the clock and the language. */
export type TeamLine =
  /** at work: what the turn says it is doing (or the title of the running job, or nothing), and when the turn began (ms) */
  | { kind: "doing"; text: string; since: number | null }
  /** waiting on the person: the newest ask in the store's one-line words, and how many more wait behind it */
  | { kind: "asks"; text: string; more: number }
  /** held by Pause everyone since then (seconds), when the runtime says */
  | { kind: "paused"; since: number | null }
  /** the last turn stopped, and the reason it gave ("" when it gave none) */
  | { kind: "stuck"; reason: string }
  /** nothing to do: when the last finished job moved (seconds), when the runtime lists one */
  | { kind: "idle"; last: number | null };

/** The stages in which a job is over, one way or another. A job that is still open is not the member's last. */
const FINISHED: ReadonlySet<JobStage> = new Set<JobStage>(["sent", "checked", "failed", "cancelled", "partly"]);

/** The longest reason a line keeps. The row cuts what its width cannot show; this only keeps a long error short. */
const REASON_MAX = 140;

/** The first line of an error, trimmed and cut with an ellipsis when it is long. */
function reasonOf(error: string | undefined): string {
  const first =
    (error ?? "")
      .split("\n")
      .map((l) => l.trim())
      .find(Boolean) ?? "";
  return first.length > REASON_MAX ? `${first.slice(0, REASON_MAX - 1).trimEnd()}…` : first;
}

/** What a member's row says under their name, or null when the status already says all there is (a member the runtime
 *  cannot reach). `turn` is the running turn of the member's main chat, `asks` are the open asks of the member (any order),
 *  `jobs` are the runtime's jobs of this member, `error` is why the last turn stopped and `pausedSince` is when Pause
 *  everyone began, in seconds. */
export function teamLine(i: {
  status: MemberStatus;
  turn: Pick<Turn, "status" | "startedAt"> | null | undefined;
  asks: readonly Ask[];
  jobs: readonly JobRow[];
  error: string | undefined;
  pausedSince: number | null;
}): TeamLine | null {
  switch (i.status) {
    case "offline":
      return null;
    case "working": {
      // The placeholder a turn found running on open carries is not words about the work.
      const said = i.turn?.status && i.turn.status !== WORKING ? i.turn.status : "";
      const running = i.jobs.filter((j) => j.stage === "working").sort((a, b) => b.at - a.at)[0];
      return { kind: "doing", text: said || running?.title || "", since: i.turn?.startedAt ?? null };
    }
    case "needs": {
      const newest = [...i.asks].sort((a, b) => b.ts - a.ts);
      return newest.length ? { kind: "asks", text: askText(newest[0].item), more: newest.length - 1 } : null;
    }
    case "paused":
      return { kind: "paused", since: i.pausedSince };
    case "stuck":
      return { kind: "stuck", reason: reasonOf(i.error) };
    case "idle": {
      const last = i.jobs.filter((j) => FINISHED.has(j.stage)).reduce<number | null>((at, j) => (at === null || j.at > at ? j.at : at), null);
      return { kind: "idle", last };
    }
  }
}

/** A line as words: what it says, and a quiet part beside it (how long the turn has run, how many more asks wait). */
export function lineWords(line: TeamLine, nowMs: number): { words: string; meta: string | null } {
  switch (line.kind) {
    case "doing":
      return { words: line.text || t("team.line.working"), meta: line.since === null ? null : elapsed(line.since, nowMs) };
    case "asks":
      return { words: line.text, meta: line.more > 0 ? t("needs.more", { n: line.more }) : null };
    case "paused":
      return { words: line.since === null ? t("team.line.paused") : t("team.line.pausedSince", { since: sinceText(line.since, nowMs) }), meta: null };
    case "stuck":
      return { words: line.reason || t("team.line.stuck"), meta: null };
    case "idle":
      return { words: line.last === null ? t("team.line.idle") : t("team.line.idleLast", { when: whenText(line.last, nowMs) }), meta: null };
  }
}
