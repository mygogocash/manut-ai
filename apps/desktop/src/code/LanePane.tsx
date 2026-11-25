// The pane beside a lane (the design canvas's Code board, "What to look at"): three chips, Diff, Preview and Tests, and what the one
// picked shows for the coding session whose chat is beside it. Diff lists each file the session changed, the newest change to each,
// drawn as the timeline draws a file edit's change (chat/activity/Work.tsx) with the same masker. Preview says the app has no preview
// of its own yet, and shows the Sample rows of the secrets Kit's changed code reads (PreviewSample.tsx), so it starts nothing.
// Tests shows what the lane keeps of its tests (lane.ts): the last run that finished, as testRun.ts read it, with when it finished
// and the command that ran it, whether a file changed since, and any run still in progress. The lane keeps none of a test's output
// (it can print anything), so the board's sample output is not drawn: what is shown is the result that was read.
// `LanePaneView` takes everything it shows as props and uses no hooks, so a test can draw it; `LanePane` reads the stores.
import "./lanepane.css";
import { memo, useState } from "react";
import { hhmm } from "../app/time";
import { DiffView } from "../chat/activity/Work";
import { t, type Key } from "../i18n";
import type { DiffFile } from "../lib/protocol";
import type { Chat } from "../state/store";
import { diffsOf, newestFirst, sameDiffs } from "./changes";
import { laneTests, type LaneTests } from "./lane";
import { laneOf, useLanesVersion } from "./laneStore";
import { PreviewSampleView } from "./PreviewSample";
import { needsOfChat, onSample, usePreviewVersion, type Need } from "./preview";

export type PaneView = "diff" | "preview" | "tests";
const VIEWS: readonly PaneView[] = ["diff", "preview", "tests"];

export interface LanePaneProps {
  /** The chip that is pressed: Diff until the person picks another. */
  view: PaneView;
  onView: (view: PaneView) => void;
  /** The files the session changed, the newest change to each, the file that changed last first (changes.ts). */
  files: DiffFile[];
  /** The secrets Kit's changed code reads that a preview would run on a sample (preview.ts). */
  needs: Need[];
  /** The secret whose Add was pressed: the vault's note shows under it. */
  asked: string | null;
  onAdd: (name: string) => void;
  /** What the lane keeps of its tests (lane.ts). */
  tests: LaneTests;
  /** How a time (ms) is written; the time of day by default. */
  time?: (ms: number) => string;
}

// Memoised on its files, which stay the same array while no step's change moved: a long diff is not drawn again for each word of
// an answer that streams in beside it.
const ChangedFiles = memo(function ChangedFiles({ files }: { files: DiffFile[] }) {
  return <DiffView files={files} scroll={false} testId="lane-diff" />;
});

function DiffPane({ files }: { files: DiffFile[] }) {
  if (files.length === 0) {
    return (
      <p className="mut lp-none" data-testid="lane-diff-none">
        {t("lane.pane.diff.none")}
      </p>
    );
  }
  return <ChangedFiles files={files} />;
}

function PreviewPane({ needs, asked, onAdd }: Pick<LanePaneProps, "needs" | "asked" | "onAdd">) {
  return (
    <>
      {/* the app has no preview to run yet: what the owner is told is that, and which secrets a preview would run on a sample */}
      <div className="box lp-box" data-testid="lane-preview-note">
        <p className="mut">{t("lane.pane.preview.none")}</p>
      </div>
      <PreviewSampleView needs={needs} asked={asked} onAdd={onAdd} bare />
    </>
  );
}

function TestsPane({ tests, time }: { tests: LaneTests; time: (ms: number) => string }) {
  const { running, last, stale } = tests;
  if (!last && running.length === 0) {
    return (
      <p className="mut lp-none" data-testid="lane-tests-none">
        {t("lane.pane.tests.none")}
      </p>
    );
  }
  return (
    <>
      {running.length > 0 && (
        <div className="box mono lp-box" data-testid="lane-tests-running">
          <div className="lp-state">{t("lane.pane.tests.running")}</div>
          {running.map((command, i) => (
            <div key={i} className="mut lp-cmd">
              $ {command}
            </div>
          ))}
        </div>
      )}
      {last && (
        <div className="box mono lp-box" data-testid="lane-tests-last">
          <div className="mut lp-cmd" data-testid="lane-tests-command">
            $ {last.command}
          </div>
          <div className={`lp-result ${last.tone}`.trim()} data-testid="lane-tests-result" data-tone={last.tone}>
            {t(last.say.key, last.say.vars)}
          </div>
          {last.why && (
            <div className="mut lp-why" data-testid="lane-tests-why">
              {t(last.why)}
            </div>
          )}
          {last.names.length > 0 && (
            <ul className="lnames" data-testid="lane-tests-names">
              {last.names.map((name) => (
                <li key={name}>{name}</li>
              ))}
              {last.more > 0 && <li className="mut">{t("lane.moreNames", { n: last.more })}</li>}
            </ul>
          )}
          <div className="mut" data-testid="lane-tests-at">
            {t("lane.pane.tests.at", { time: time(last.at) })}
          </div>
        </div>
      )}
      {last && stale && (
        <p className="mut lp-stale" data-testid="lane-tests-stale">
          {t("lane.pane.tests.stale")}
        </p>
      )}
    </>
  );
}

export function LanePaneView({ view, onView, files, needs, asked, onAdd, tests, time = (ms) => hhmm(new Date(ms)) }: LanePaneProps) {
  return (
    <aside className="lpane" data-testid="lane-pane" data-view={view}>
      <div className="fgroup" role="group" aria-label={t("lane.pane.title")}>
        {VIEWS.map((v) => (
          <button key={v} type="button" className="fchip" aria-pressed={view === v} onClick={() => onView(v)} data-testid={`lane-chip-${v}`}>
            {t(`lane.pane.${v}` satisfies Key)}
          </button>
        ))}
      </div>
      <div className="lp-view" data-testid={`lane-view-${view}`}>
        {view === "diff" && <DiffPane files={files} />}
        {view === "preview" && <PreviewPane needs={needs} asked={asked} onAdd={onAdd} />}
        {view === "tests" && <TestsPane tests={tests} time={time} />}
      </div>
    </aside>
  );
}

/** The files the chat's steps changed, the same array while no step's change moved. */
function useChangedFiles(chat: Chat | undefined): DiffFile[] {
  const steps = diffsOf(chat);
  const [held, setHeld] = useState(() => ({ steps, files: newestFirst(steps) }));
  if (sameDiffs(held.steps, steps)) return held.files;
  const next = { steps, files: newestFirst(steps) };
  // kept for the next time, as React's own way to keep what a render worked out from what it was given before
  setHeld(next);
  return next.files;
}

/** The pane of the lane whose chat has key `chatKey`, which holds `chat`. */
export function LanePane({ chatKey, chat }: { chatKey: string; chat: Chat | undefined }) {
  // the lane and what Kit's changes read move with the session's events
  useLanesVersion();
  usePreviewVersion();
  const [view, setView] = useState<PaneView>("diff");
  const [asked, setAsked] = useState<string | null>(null);
  const files = useChangedFiles(chat);
  // The owner can add no secret yet (there is no vault), so every secret the code reads is still on its sample.
  return <LanePaneView view={view} onView={setView} files={files} needs={onSample(needsOfChat(chatKey))} asked={asked} onAdd={setAsked} tests={laneTests(laneOf(chatKey))} />;
}
