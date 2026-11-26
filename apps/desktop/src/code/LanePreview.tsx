// The Preview view beside a lane (the design canvas's Code board, "What to look at", Preview): the lane's project started with its
// own dev server, in the lane's own folder. The view names the exact command before anything runs (`$ pnpm run dev`, then Start),
// says in plain words why there is none, and follows the run: Starting, Running at its address with Open in browser and Stop,
// Stopped, Ended with its exit code and its last lines (any key hidden), and Could not start with why. A lane that works in the
// developer's own folder gets no Start: their folder can hold a real `.env.local`. While it runs at an address, the page at that
// address is drawn in a frame that fills the view, with Reload and Open in browser above it, as the board draws the page in a box;
// the frame goes the moment the run is no longer Running. Only that very address is ever put in the frame, and only when
// previewFrame.ts lets it (the shell's own loopback rule, a host the app's CSP names, not the app's own origin, not Windows);
// otherwise the view says why and keeps Open in browser. `LanePreviewView` takes everything it shows as props and uses no hooks,
// so a test can draw it; LanePane.tsx reads the store (previewStore.ts) and hands it over.
import { listText, t, type Key } from "../i18n";
import type { PreviewRecord } from "./previewStore";
import { FRAME_SANDBOX, framePlan, type FrameHere, type NoFrame } from "./previewFrame";
import { isLive, lastLines, NONE_WORDS, whyWords } from "./previewRun";

export interface LanePreviewProps {
  /** The lane's own folder, or null when the session works in the developer's own folder (no Start there). */
  dir: string | null;
  record: PreviewRecord;
  /** The names of the secrets the preview runs on a sample, shown as one line: names only, never a value. */
  samples: string[];
  onStart: () => void;
  onStop: () => void;
  onOpen: () => void;
  /** Where the page runs (its own origin, and whether this is Windows), which decides whether the preview's page is framed. */
  here: FrameHere;
  /** How many times Reload was pressed: the frame is made again at the preview's address each time. */
  reloads: number;
  onReload: () => void;
}

/** Why the page is not drawn, in words. */
const NO_FRAME_WORDS: Readonly<Record<NoFrame, Key>> = {
  not_loopback: "lane.preview.noFrame.not_loopback",
  windows: "lane.preview.noFrame.windows",
  unnamed: "lane.preview.noFrame.unnamed",
  own: "lane.preview.noFrame.own",
};

/** The page at the preview's own address, in a frame that fills the view, sandboxed (previewFrame.ts says what each token is for).
 *  Made again at that address on each Reload; it cannot be told to reload itself from here, since it is another origin's page. */
function PageFrame({ src, reloads }: { src: string; reloads: number }) {
  return (
    <>
      <div className="box lp-page" data-testid="lane-preview-page">
        <iframe
          key={`${src}#${reloads}`}
          className="lp-frame"
          src={src}
          sandbox={FRAME_SANDBOX}
          referrerPolicy="no-referrer"
          title={t("lane.preview.frame", { url: src })}
          data-testid="lane-preview-frame"
        />
      </div>
      <p className="mut lp-frame-note" data-testid="lane-preview-frame-note">
        {t("lane.preview.frameNote")}
      </p>
    </>
  );
}

/** The command in a code line, as the board writes a command, and what its script runs: the name alone says nothing of it. */
const Command = ({ label, script }: { label: string; script?: { name: string; text: string } }) => (
  <>
    <div className="mut mono lp-cmd" data-testid="lane-preview-command">
      $ {label}
    </div>
    {script && (
      <p className="mut" data-testid="lane-preview-script">
        {t("kit.ask.script", { name: script.name, text: script.text })}
      </p>
    )}
  </>
);

/** A run's last lines, any key hidden. */
function Lines({ lines }: { lines: string[] }) {
  if (lines.length === 0) return null;
  return (
    <pre className="mono lp-lines" aria-label={t("lane.preview.lines")} data-testid="lane-preview-lines">
      {lines.join("\n")}
    </pre>
  );
}

function StopButton({ busy, onStop }: { busy: boolean; onStop: () => void }) {
  return (
    <button
      type="button"
      className="btn"
      aria-busy={busy}
      aria-disabled={busy || undefined}
      onClick={() => {
        if (!busy) onStop();
      }}
      data-testid="lane-preview-stop"
    >
      {busy ? t("lane.preview.stopping") : t("lane.preview.stop")}
    </button>
  );
}

export function LanePreviewView({ dir, record, samples, onStart, onStop, onOpen, here, reloads, onReload }: LanePreviewProps) {
  if (!dir) {
    return (
      <div className="box lp-box" data-testid="lane-preview" data-phase="only">
        <p className="mut" data-testid="lane-preview-only">
          {t("lane.preview.only_lane")}
        </p>
      </div>
    );
  }
  const { run, plan, readWhy } = record;
  const live = isLive(run);
  const ready = plan && !("none" in plan) ? plan : null;
  // Under way or just over, the run is what is said; Start (again) is offered only with a command chosen from what the folder holds now.
  const startRow = (again: boolean) =>
    ready ? (
      <>
        <Command label={ready.label} script={ready.script} />
        <div className="lp-acts">
          <button type="button" className="btn dark" onClick={onStart} data-testid="lane-preview-start">
            {again ? t("lane.preview.startAgain") : t("lane.preview.start")}
          </button>
        </div>
      </>
    ) : plan && "none" in plan ? (
      <p className="mut" data-testid="lane-preview-none">
        {t(NONE_WORDS[plan.none])}
      </p>
    ) : readWhy ? (
      <p className="mut" data-testid="lane-preview-unread">
        {t(whyWords(readWhy).key, whyWords(readWhy).vars)}
      </p>
    ) : (
      <p className="mut" data-testid="lane-preview-reading">
        {t("lane.preview.reading")}
      </p>
    );
  const why = run.why ? whyWords(run.why) : null;
  // Only while it runs at an address: the frame goes the moment it stops, ends or is being stopped.
  const frame = run.phase === "running" && run.url ? framePlan(run.url, here) : null;
  return (
    <>
      <div className="box lp-box" data-testid="lane-preview" data-phase={run.phase}>
        {run.phase === "idle" && (
          <>
            {ready && <p className="mut">{t("lane.preview.where")}</p>}
            {startRow(false)}
          </>
        )}
        {run.phase === "starting" && (
          <>
            <div className="lp-state" role="status" data-testid="lane-preview-state">
              {t("lane.preview.starting")}
            </div>
            <Command label={run.label} />
            <div className="lp-acts">
              <StopButton busy={false} onStop={onStop} />
            </div>
          </>
        )}
        {run.phase === "running" && run.url && (
          <>
            <div className="lp-state lp-result ok" role="status" data-testid="lane-preview-state">
              {t("lane.preview.running", { url: run.url })}
            </div>
            <Command label={run.label} />
            <div className="lp-acts">
              {frame && "src" in frame && (
                <button type="button" className="btn" onClick={onReload} data-testid="lane-preview-reload">
                  {t("lane.preview.reload")}
                </button>
              )}
              <button type="button" className="btn dark" onClick={onOpen} data-testid="lane-preview-open">
                {t("lane.preview.open")}
              </button>
              <StopButton busy={false} onStop={onStop} />
            </div>
            {frame && "no" in frame && (
              <p className="mut" data-testid="lane-preview-noframe" data-why={frame.no}>
                {t(NO_FRAME_WORDS[frame.no])}
              </p>
            )}
            {record.openFailed && (
              <p className="mut lp-result err" role="status" data-testid="lane-preview-open-failed">
                {t("lane.preview.openFailed")}
              </p>
            )}
          </>
        )}
        {run.phase === "quiet" && (
          <>
            <div className="lp-state" role="status" data-testid="lane-preview-state">
              {t("lane.preview.quiet")}
            </div>
            <Command label={run.label} />
            <Lines lines={lastLines(run)} />
            <div className="lp-acts">
              <StopButton busy={false} onStop={onStop} />
            </div>
          </>
        )}
        {run.phase === "stopping" && (
          <>
            <div className="lp-state" role="status" data-testid="lane-preview-state">
              {t("lane.preview.stoppingNote")}
            </div>
            <Command label={run.label} />
            <div className="lp-acts">
              <StopButton busy onStop={onStop} />
            </div>
          </>
        )}
        {run.phase === "stopped" && (
          <>
            <div className="lp-state" role="status" data-testid="lane-preview-state">
              {t("lane.preview.stopped")}
            </div>
            {startRow(true)}
          </>
        )}
        {run.phase === "ended" && (
          <>
            <div className="lp-state lp-result err" role="status" data-testid="lane-preview-state">
              {run.code === null ? t("lane.preview.endedSignal") : t("lane.preview.ended", { code: run.code })}
            </div>
            <Lines lines={lastLines(run)} />
            {startRow(true)}
          </>
        )}
        {run.phase === "failed" && why && (
          <>
            <div className="lp-state lp-result err" role="status" data-testid="lane-preview-state">
              {t("lane.preview.failed", { why: t(why.key, why.vars) })}
            </div>
            {startRow(true)}
          </>
        )}
      </div>
      {frame && "src" in frame && <PageFrame src={frame.src} reloads={reloads} />}
      {samples.length > 0 && (live || ready) && (
        <p className="mut lp-samples" data-testid="lane-preview-samples">
          {t("lane.preview.samples", { names: listText(samples) })}
        </p>
      )}
    </>
  );
}
