// The lane's next step (item 167e; docs/paradev-ux.md, "Review"): the lane's top bar as the design canvas's Code board draws it, with
// Paradev's one-face ship control as the idea (its ShipControl.tsx was read, none of its presses taken). The session's header holds the
// lane's branch and its state as the board's two tags, and one dark button naming the step the branch is at: Put up for review while
// it has no open pull request, then Merge once its request is open, with the request's state beside it (its checks and its review, in
// the words a row of Tasks › Pull requests says them). A merged request leaves no button, only that it merged; a draft leaves none
// either, since the row's Merge was never offered for one.
//
// A press opens that step exactly as the row's quiet link does (Review.tsx, item 75): the draft or the method, in a panel under the
// header, then Ask, then the one ask through approval-core, settled once. Nothing is pushed, opened or merged by a press: only a Yes
// that approval-core settled reaches the shell. There is no Commit button (commits are Kit's, through the dial), no Push of its own and
// no Discard: Rewind and Bring it back are the ways back.
//
// Where the parts live: `LaneTop` belongs to the lane's split (SessionView.tsx `LaneSplit`, keyed by the lane, so each lane walks its own
// steps and an ask left waiting is taken back when the lane goes). It draws the panel where it stands, under the header, and puts the
// button and the request's state into the header's slot through a portal, since the session view draws one header for every kind of
// session. `LaneHeadTags` draws the branch and the state in the header itself, read as the Lanes band reads a row (Lanes.tsx).
// `LaneStepView` and `LaneHeadTagsView` take everything as props, so a test can draw each state.
import "./lanestep.css";
import { createPortal } from "react-dom";
import { t } from "../i18n";
import { titlesFor, useTitleModel } from "../lib/titleModel";
import type { AgentLive } from "../sessions/sessions";
import type { SessionRec } from "../sessions/agents";
import { getStore } from "../state/store";
import { checksWord, reviewWord } from "../tasks/board";
import { useLanePulls, type LanePull } from "../tasks/pulls";
import { showBoardPull } from "../tasks/state";
import type { Say } from "./command";
import { laneTag, type LaneStatus } from "./lane";
import { branchTitle, laneRowOf, type LaneBranchTag } from "./Lanes";
import { laneOf, useLanesVersion } from "./laneStore";
import { flowProps, ReviewView, useReviewFlow, type ReviewFlow } from "./Review";

/** The two steps a lane's branch can be at, each one ask (item 75). */
export type StepButton = "review" | "merge";

/** What the top bar offers: the one button (none when there is no step to take), the open or draft pull request made from the branch,
 *  and whether the host said that request merged. */
export interface NextStep {
  button: StepButton | null;
  pull: LanePull | null;
  merged: boolean;
}

export interface NextStepInput {
  /** The lane has a branch and a folder of its own (a lane in the developer's folder has nothing to put up). */
  own: boolean;
  /** The shell can ask (its ask and its settle), and can ask to merge. */
  can: boolean;
  canMerge: boolean;
  pull: LanePull | null;
  merged: boolean;
}

/** The step the branch is at. This function alone decides which button the top bar draws. */
export function nextStep(i: NextStepInput): NextStep {
  if (!i.own || !i.can) return { button: null, pull: null, merged: false };
  // an open request is the next thing, after a merge too: a new request from the branch is a new step
  if (i.pull) return { button: i.pull.state === "open" && i.canMerge ? "merge" : null, pull: i.pull, merged: false };
  if (i.merged) return { button: null, pull: null, merged: true };
  return { button: "review", pull: null, merged: false };
}

/** One word of a request's state, and the meaning its colour carries (Tasks' own tones). */
export interface RequestWord {
  id: "checks" | "review" | "conflict" | "draft";
  text: string;
  tone: "ok" | "fail" | "run" | "none";
}

/** A request's state beside the button: a draft says so; an open one says its checks (when the list said anything of them), its review
 *  (when one is asked) and a conflict with its base, in the words of a row of Tasks › Pull requests. */
export function requestWords(p: LanePull): RequestWord[] {
  if (p.state === "draft") return [{ id: "draft", text: t("tasks.st.draft"), tone: "none" }];
  const out: RequestWord[] = [];
  if (p.checks) out.push({ id: "checks", ...checksWord(p) });
  const review = reviewWord(p);
  if (review) out.push({ id: "review", text: review, tone: "none" });
  if (p.conflict) out.push({ id: "conflict", text: t("prs.band.conflict"), tone: "fail" });
  return out;
}

export interface LaneStepViewProps {
  next: NextStep;
  /** A step's panel is open under the header: the button says so, and a press opens nothing more. */
  open?: boolean;
  onPress: (button: StepButton) => void;
  /** The request's number was pressed: Tasks opens on it. */
  onPull?: (pull: LanePull) => void;
}

/** The header's part of the next step: the request's state, then the one dark button. Two boxes side by side, so the header lays them
 *  out as its own (lanestep.css): the words give way before the title does, and the button never does. */
export function LaneStepView({ next, open = false, onPress, onPull }: LaneStepViewProps) {
  const { button, pull, merged } = next;
  if (!button && !pull && !merged) return null;
  return (
    <>
      {(pull || merged) && (
        <span className="ss-step-state" data-testid="lane-step-state">
          {pull ? (
            <>
              <button type="button" className="ss-step-pull" title={t("lane.prTip")} onClick={() => onPull?.(pull)} data-testid="lane-step-pull" data-state={pull.state}>
                {t("lane.step.pull", { n: pull.number })}
              </button>
              {requestWords(pull).map((w) => (
                <span key={w.id}>
                  {" · "}
                  <span className="ss-step-w" data-tone={w.tone} data-testid={`lane-step-${w.id}`}>
                    {w.text}
                  </span>
                </span>
              ))}
            </>
          ) : (
            <span data-testid="lane-step-merged">{t("lane.step.merged")}</span>
          )}
        </span>
      )}
      {button && (
        <button
          type="button"
          className="btn dark ss-step-btn"
          aria-expanded={open}
          onClick={() => onPress(button)}
          title={t(button === "merge" ? "review.merge.startTip" : "review.startTip")}
          data-testid="lane-step-button"
          data-step={button}
        >
          {t(button === "merge" ? "prs.merge" : "review.start")}
        </button>
      )}
    </>
  );
}

/** The top bar's press: it opens the step only while none is open, so a second press (a double click) never starts a draft or an ask on
 *  screen over again. What it opens is the flow's own (`ReviewFlow.press`): the draft or the method, and nothing that writes. */
export function pressStep(flow: Pick<ReviewFlow, "get" | "press">, button: StepButton): void {
  if (flow.get().at === "closed") flow.press(button);
}

/** Opens a request where the chat's own link opens it: Tasks › Pull requests, with the request selected. */
const openPull = (p: LanePull) => {
  if (showBoardPull(p.source, p.repo, p.number)) getStore().actions.openTasks();
};

export interface LaneTopProps {
  /** The project's folder (the session's), whose repository the pull requests are read for. */
  root: string;
  /** The lane's own folder and branch, and its title. */
  worktree: string;
  branch: string;
  title: string;
  /** The header's place for the button and the request's state; none until the header is drawn. */
  slot: Element | null;
}

/** The next step of one lane: its button and the request's state in the header, and the step's panel under it. */
export function LaneTop({ root, worktree, branch, title, slot }: LaneTopProps) {
  // the same cache the lane's row on the Code page reads, so both say the same request
  const pulls = useLanePulls(root, [branch]);
  const pull = pulls.open.get(branch) ?? null;
  const flow = useReviewFlow(worktree, title, pull);
  const words = useTitleModel();
  if (!flow.can) return null;
  const step = flow.get();
  const next = nextStep({ own: true, can: flow.can, canMerge: flow.canMerge, pull, merged: pulls.merged.has(branch) });
  const open = step.at !== "closed";
  return (
    <>
      {slot && createPortal(<LaneStepView next={next} open={open} onPress={(button) => pressStep(flow, button)} onPull={openPull} />, slot)}
      {(open || !!step.done) && (
        <div className="ss-step-panel" data-testid="lane-step-panel">
          <ReviewView {...flowProps(flow, !!flow.host.titleRun && titlesFor("claude", words))} pull={pull} links={false} />
        </div>
      )}
    </>
  );
}

export interface LaneHeadTagsViewProps {
  branch: LaneBranchTag | null;
  status: LaneStatus;
  /** What the state means, as the row's line says it: the tag's tooltip. */
  line: Say | null;
}

/** The lane's states a tag in the header says. The header's own words already say Working, Needs you and an ending, so the tag says
 *  what the lane's work showed once a turn is over: its tests, or that it was reverted. */
const TAGGED: readonly LaneStatus[] = ["checked", "tests_failed", "unconfirmed", "not_run", "reverted"];

/** The board's two tags in the header: the lane's branch in mono, and its state. */
export function LaneHeadTagsView({ branch, status, line }: LaneHeadTagsViewProps) {
  const tagged = TAGGED.includes(status);
  if (!branch && !tagged) return null;
  const tag = laneTag(status);
  return (
    <span className="ss-head-lane" data-testid="lane-head">
      {branch && (
        <span className="tag mono" title={branchTitle(branch)} data-testid="lane-head-branch" data-kind={branch.kind}>
          {branch.name}
        </span>
      )}
      {tagged && (
        <span className={`tag ${tag.tone}`.trim()} title={line ? t(line.key, line.vars) : undefined} data-testid="lane-head-state" data-status={status}>
          {t(tag.key)}
        </span>
      )}
    </span>
  );
}

export interface LaneHeadTagsProps {
  rec: SessionRec;
  /** The agent's name, as the session's row names it. */
  agent: string;
  chatKey: string;
  live?: Pick<AgentLive, "branch">;
  /** The chat's running turn, if one runs, and whether an ask of it waits. */
  turn: { status: string; startedAt: number } | null;
  needs: boolean;
}

/** The branch and the state of the lane open in the session view, read as its row in the Lanes band reads them (`laneRowOf`). */
export function LaneHeadTags({ rec, agent, chatKey, live, turn, needs }: LaneHeadTagsProps) {
  // the lane's record moves with the session's events (its tests, a rewind)
  useLanesVersion();
  const row = laneRowOf({ rec, agent, ...(live ? { live } : {}), lane: laneOf(chatKey), turn, asks: needs ? [""] : [] });
  return <LaneHeadTagsView branch={row.branch} status={row.status} line={row.line} />;
}
