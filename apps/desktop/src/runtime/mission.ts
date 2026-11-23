// What Mission Control asks of a runtime: a job and how it went, the shop's activity log, and Pause everyone. These are
// the ops behind the job view, the activity log and the pause page (src/pages/Job*, Activity*, Pause*). The shapes live
// here, beside the runtime, and `OpMap` in lib/protocol.ts extends them, so a runtime that does not answer one does not
// compile (both hosts type their handler tables against every op) and a screen asks through the same typed seam.
//
// Everything a page shows is in these shapes and nothing else: a page never fills a gap with a number of its own, so a
// runtime that has no cost for a step says `null` and the page shows no cost. Times are seconds since the epoch, as
// everywhere in the protocol. Money is integer satang, never a float.

/** The member's name that stands for the shop's owner in the activity log ("You"). No member can be called this. */
export const OWNER = "you";

/** Where a job stands, and each step of its timeline. `proposed` waits for the owner; `paused` is what Pause everyone
 *  does to a job that was running. */
export type JobStage = "proposed" | "approved" | "working" | "paused" | "sent" | "checked" | "failed" | "cancelled" | "partly";

export interface JobStep {
  stage: JobStage;
  /** when the job reached it */
  at: number;
}

/** A job as History, Home and a member's page list it. */
export interface JobRow {
  id: string;
  title: string;
  /** the team member who does it */
  bot: string;
  stage: JobStage;
  /** when it last moved: the time of its latest step */
  at: number;
}

/** How a message to one customer stands. `waiting` has not gone out yet. */
export type RecipientStatus = "waiting" | "delivered" | "read" | "failed";

/** A customer the job wrote to. A job that wrote to nobody (a summary for the owner, a draft) has none. */
export interface JobRecipient {
  name: string;
  status: RecipientStatus;
}

/** How a step of the trace ended; null while the step has no verdict (most steps just run). */
export type TraceResult = "pass" | "fail" | "running";

/** One tool call or model call of a job, for the developers' view. */
export interface TraceStep {
  tool: string;
  /** what the step found or did, in a few words */
  found: string;
  ms: number;
  /** integer satang this step cost, or null when it cost nothing */
  costSatang: number | null;
  /** tokens a model step used, or null */
  tokens: number | null;
  result: TraceResult | null;
}

/** A job, whole: what the owner reads on top of its page and what a developer reads under the hood. */
export interface Job extends JobRow {
  /** what the owner asked for, in the owner's words */
  goal: string;
  steps: JobStep[];
  /** what happened, in one or two sentences */
  summary: string;
  recipients: JobRecipient[];
  /** integer satang the whole job cost; the sum of its steps' */
  costSatang: number;
  /** how long the work took, not counting waits for the owner; null while it still runs */
  tookSeconds: number | null;
  trace: TraceStep[];
}

/** The kinds the activity log filters by, in the order its chips show them. */
export const ACTIVITY_KINDS = ["msg", "money", "post", "code", "signin", "settings"] as const;
export type ActivityKind = (typeof ACTIVITY_KINDS)[number];

export type ActivityStatus = "sent" | "checked" | "posted" | "used" | "changed" | "needs_you";

/** The words an event holds: a customer's message (private, hidden until the owner shows it and kept out of exports
 *  unless they choose it) or the shop's own post (public, so shown). */
export interface ActivityText {
  body: string;
  private: boolean;
}

export interface ActivityEvent {
  id: string;
  at: number;
  /** a member's name, or `OWNER` */
  who: string;
  kind: ActivityKind;
  /** what happened, as a sentence */
  title: string;
  /** what it was about ("Replies about late parcels") */
  item: string;
  /** the job the item opens, when it is one */
  job: string | null;
  /** who approved it, in words ("You approved at 09:14") */
  approval: string;
  status: ActivityStatus;
  /** where it happened ("LINE Official Account") */
  where: string;
  /** whether it can be undone, and how */
  undo: string;
  /** one more line, or "" */
  note: string;
  text: ActivityText | null;
}

/** A job Pause everyone stopped or would stop, with what has already gone out of it. */
export interface PausedJob {
  id: string;
  title: string;
  bot: string;
  /** replies (or other messages) already sent of all it will send; null when the job sends nothing */
  out: { sent: number; total: number } | null;
}

export interface TeamState {
  paused: boolean;
  /** when everyone was paused; null while nobody is */
  since: number | null;
  /** the members a pause stops. The lead (the default member) keeps answering, so the owner can ask why. */
  members: string[];
  /** routines that skip their runs while paused */
  routines: number;
  /** the jobs running now, or while paused the ones that were running when it began */
  running: PausedJob[];
}

export interface MissionOps {
  "jobs.list": { params: Record<string, never>; result: { jobs: JobRow[] } };
  "jobs.get": { params: { job: string }; result: Job };
  /** Newest first. `keptMonths` is how long the shop's log keeps an event before it is deleted for good. */
  "activity.list": { params: Record<string, never>; result: { events: ActivityEvent[]; keptMonths: number } };
  "team.state": { params: Record<string, never>; result: TeamState };
  /** Stops every member at the next safe point and starts nothing new. Unsends nothing, takes no page offline. */
  "team.pause": { params: Record<string, never>; result: TeamState };
  "team.resume": { params: Record<string, never>; result: TeamState };
}
