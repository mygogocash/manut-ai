// The pane beside a lane (the design canvas's Code board, "What to look at"): three chips, Diff, Preview and Tests, and what the one
// picked shows for the coding session whose chat is beside it. Diff lists each file the session changed, the newest change to each,
// drawn as the timeline draws a file edit's change (chat/activity/Work.tsx) with the same masker. Preview is the lane's project run
// with its own dev server in the lane's own folder (LanePreview.tsx, previewStore.ts): the command first, then Start, its address
// with Open in browser and Stop, its page in a frame that fills the view while it runs, and how it ended; under it the Sample
// rows of the secrets Kit's changed code reads (PreviewSample.tsx).
// Tests shows what the lane keeps of its tests (lane.ts): the last run that finished, as testRun.ts read it, with when it finished
// and the command that ran it, whether a file changed since, and any run still in progress. The lane keeps none of a test's output
// (it can print anything), so the board's sample output is not drawn: what is shown is the result that was read.
// `LanePaneView` takes everything it shows as props and uses no hooks, so a test can draw it; `LanePane` reads the stores.
import "./lanepane.css";
import { memo, useEffect, useMemo, useState, type ReactNode } from "react";
import { hhmm } from "../app/time";
import { DiffView } from "../chat/activity/Work";
import { t, type Key } from "../i18n";
import type { DiffFile } from "../lib/protocol";
import type { Chat } from "../state/store";
import { diffsOf, newestFirst, sameDiffs } from "./changes";
import { changeMark, filesShown } from "./laneFolder";
import { useLaneFolder } from "./useLaneFolder";
import { laneTests, type LaneTests } from "./lane";
import { laneOf, useLanesVersion } from "./laneStore";
import { LanePreviewView, type LanePreviewProps } from "./LanePreview";
import { PreviewSampleView } from "./PreviewSample";
import { needsOfChat, onSample, usePreviewVersion, type Need } from "./preview";
import { frameHere } from "./previewFrame";
import { isLive, previewSecrets } from "./previewRun";
import { openPreview, readPreview, startPreview, stopPreview, usePreviewRecord } from "./previewStore";

export type PaneView = "diff" | "preview" | "tests";
const VIEWS: readonly PaneView[] = ["diff", "preview", "tests"];

export interface LanePaneProps {
  /** The chip that is pressed: Diff until the person picks another. */
  view: PaneView;
  onView: (view: PaneView) => void;
  /** The files the session changed, the newest change to each, the file that changed last first (changes.ts). */
  files: DiffFile[];
  /** How many more files the lane's folder changed than are listed (laneFolder.ts); 0 when the files come from the chat's events. */
  moreFiles?: number;
  /** The secrets Kit's changed code reads that a preview would run on a sample (preview.ts). */
  needs: Need[];
  /** The secret whose Add was pressed: the vault's note shows under it. */
  asked: string | null;
  onAdd: (name: string) => void;
  /** The lane's preview (LanePreview.tsx): its folder, its run and what Start, Stop and Open do. */
  preview: LanePreviewProps;
  /** What the lane keeps of its tests (lane.ts). */
  tests: LaneTests;
  /** How a time (ms) is written; the time of day by default. */
  time?: (ms: number) => string;
  /** Put up for review and its ask (Review.tsx), over the chips, for a lane with a folder and a branch of its own. */
  review?: ReactNode;
}

// Memoised on its files, which stay the same array while no step's change moved: a long diff is not drawn again for each word of
// an answer that streams in beside it.
const ChangedFiles = memo(function ChangedFiles({ files }: { files: DiffFile[] }) {
  return <DiffView files={files} scroll={false} testId="lane-diff" />;
});

function DiffPane({ files, moreFiles = 0 }: { files: DiffFile[]; moreFiles?: number }) {
  if (files.length === 0) {
    return (
      <p className="mut lp-none" data-testid="lane-diff-none">
        {t("lane.pane.diff.none")}
      </p>
    );
  }
  return (
    <>
      <ChangedFiles files={files} />
      {moreFiles > 0 && (
        <p className="mut lp-none" data-testid="lane-diff-more-files">
          {t("lane.pane.diff.moreFiles", { n: moreFiles })}
        </p>
      )}
    </>
  );
}

function PreviewPane({ needs, asked, onAdd, preview }: Pick<LanePaneProps, "needs" | "asked" | "onAdd" | "preview">) {
  return (
    <>
      <LanePreviewView {...preview} />
      {/* which secrets Kit's code reads, each on its sample: the preview runs with the sample, never a real one */}
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

export function LanePaneView({ view, onView, files, moreFiles, needs, asked, onAdd, preview, tests, time = (ms) => hhmm(new Date(ms)), review }: LanePaneProps) {
  return (
    // the diff, the tests and a preview's text can be selected and noted for the chat beside it (item 97, chat/box/SelectionNote.tsx);
    // ⌘F here is not the chat's find (item 150): this pane keeps the key for a find of its own (src/chat/find/host.ts)
    <aside className="lpane" data-testid="lane-pane" data-view={view} data-note-source data-own-find>
      {review}
      <div className="fgroup" role="group" aria-label={t("lane.pane.title")}>
        {VIEWS.map((v) => (
          <button key={v} type="button" className="fchip" aria-pressed={view === v} onClick={() => onView(v)} data-testid={`lane-chip-${v}`}>
            {t(`lane.pane.${v}` satisfies Key)}
          </button>
        ))}
      </div>
      <div className="lp-view" data-testid={`lane-view-${view}`}>
        {view === "diff" && <DiffPane files={files} moreFiles={moreFiles} />}
        {view === "preview" && <PreviewPane needs={needs} asked={asked} onAdd={onAdd} preview={preview} />}
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

/** The pane of the lane whose chat has key `chatKey`, which holds `chat`. `laneDir` is the lane's own folder, or null when the
 *  session works in the developer's own folder, where no preview is started. */
export function LanePane({ chatKey, chat, laneDir = null, review }: { chatKey: string; chat: Chat | undefined; laneDir?: string | null; review?: ReactNode }) {
  // the lane and what Kit's changes read move with the session's events
  useLanesVersion();
  usePreviewVersion();
  const [view, setView] = useState<PaneView>("diff");
  const [asked, setAsked] = useState<string | null>(null);
  const [reloads, setReloads] = useState(0);
  // Where the page runs does not change while it is open.
  const here = useMemo(frameHere, []);
  const fromEvents = useChangedFiles(chat);
  // The folder is the truth where the shell can read it; the chat's events are the hint to read again, and the files shown where it cannot.
  const folder = useLaneFolder(laneDir, changeMark(chat));
  const files = filesShown(folder, fromEvents);
  const record = usePreviewRecord(chatKey);
  const live = isLive(record.run);
  // The folder is read each time its Preview is looked at, so the command named is chosen from what the folder holds now.
  useEffect(() => {
    if (view === "preview" && laneDir && !live) void readPreview(chatKey, laneDir);
  }, [view, laneDir, chatKey, live]);
  const all = needsOfChat(chatKey);
  // The owner can add no secret yet (there is no vault), so every secret the code reads is still on its sample.
  const preview: LanePreviewProps = {
    dir: laneDir,
    record,
    samples: previewSecrets(all, record.project?.envExample ?? null).map(([name]) => name),
    onStart: () => {
      if (laneDir) void startPreview(chatKey, laneDir, all);
    },
    onStop: () => void stopPreview(chatKey),
    onOpen: () => void openPreview(chatKey),
    here,
    reloads,
    onReload: () => setReloads((n) => n + 1),
  };
  return <LanePaneView view={view} onView={setView} files={files} moreFiles={folder?.moreFiles ?? 0} needs={onSample(all)} asked={asked} onAdd={setAsked} preview={preview} tests={laneTests(laneOf(chatKey))} review={review} />;
}
