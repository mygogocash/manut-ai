// Merge, from Tasks › Pull requests (item 100): the very ask a lane's Merge makes (Review.tsx, src-tauri/src/review.rs), opened
// from a request's detail. For a lane's request it is the lane's own call (`reviewMerge` with the lane's folder); for any other
// request of the project it is `reviewMergePull` with the project's folder, which the shell answers with the same ask and plan,
// naming the repository and the branch, or refuses (a request of another repository than the project's, a fork's branch, one
// that cannot merge yet, a method the repository does not allow). The steps, the words and the settling are Review.tsx's own:
// the method (only those the repository allows), Ask, the ask with exactly what will be sent, Yes once through approval-core.
// Nothing is merged until the person says yes, and no other write is reachable from here.
//
// `PullMergeView` draws a given step so a test can draw each one; `PullMerge` keeps the step and talks to the host it is given.
import { useCallback, useEffect, useRef, useState } from "react";
import { t } from "../i18n";
import { openExternal } from "../lib/openExternal";
import { setSourceSettings, sourceSettings, startMethod } from "../lib/sourceControl";
import type { SessionHost } from "../sessions/host";
import { dropPull } from "../tasks/pulls";
import type { BoardRow } from "../tasks/board";
import { doneWords, ReviewView, whyWords, type ReviewStep } from "./Review";
import { answerReviewAsk, openReviewAsk, withdrawReviewAsk } from "./reviewAsk";
import type { MergeMethod, ReviewAsk } from "./source";
import "./review.css";

export type MergeHost = Pick<SessionHost, "reviewMerge" | "reviewMergePull" | "reviewSettle" | "reviewWithdraw">;

/** The method the step starts on: the person's setting when the repository allows it, else the first it allows. */
export function firstMethod(want: MergeMethod, allowed: readonly MergeMethod[]): MergeMethod {
  return allowed.length === 0 || allowed.includes(want) ? want : allowed[0];
}

/** The ask for `row`'s request with `method`: the lane's own when it is a lane's, else the project's. */
export function askFor(host: MergeHost, row: BoardRow, worktree: string | null, method: MergeMethod, credits: boolean): Promise<ReviewAsk> {
  if (worktree && host.reviewMerge) return host.reviewMerge(worktree, row.pull.number, method, credits);
  if (!host.reviewMergePull) return Promise.reject(new Error("no_shell"));
  return host.reviewMergePull(row.folder, row.source, row.repo, row.pull.number, method, credits);
}

export interface PullMergeViewProps {
  step: ReviewStep;
  /** The request is a draft: it cannot be merged, and no Merge is offered. */
  draft: boolean;
  methods: readonly MergeMethod[];
  onStart: () => void;
  onMethod: (m: MergeMethod) => void;
  onAsk: () => void;
  onYes: () => void;
  onNo: () => void;
  onClose: () => void;
  onChange: () => void;
  onOpenUrl?: (url: string) => void;
}

const noop = () => {};

export function PullMergeView(p: PullMergeViewProps) {
  const s = p.step;
  if (s.at === "closed") {
    const done = s.done ?? null;
    return (
      <div className="pr-merge" data-testid="pr-merge">
        {done && (
          <p className={done.outcome === "failed" ? "rv-why" : "mut"} role="status" data-testid="review-done" data-outcome={done.outcome}>
            {doneWords(done, "merge")}
          </p>
        )}
        {!p.draft && done?.outcome !== "merged" && (
          <button type="button" className="btn dark" onClick={p.onStart} title={t("review.merge.startTip")} data-testid="pr-merge-start">
            {t("prs.merge")}
          </button>
        )}
      </div>
    );
  }
  return (
    <ReviewView
      step={s}
      methods={p.methods}
      onStart={noop}
      onTitle={noop}
      onBody={noop}
      onAsk={noop}
      onMethod={p.onMethod}
      onMergeAsk={p.onAsk}
      onYes={p.onYes}
      onNo={p.onNo}
      onClose={p.onClose}
      onChange={p.onChange}
      {...(p.onOpenUrl ? { onOpenUrl: p.onOpenUrl } : {})}
    />
  );
}

export interface PullMergeProps {
  host: MergeHost;
  row: BoardRow;
  /** The folder of the app's lane the request was made from, when it is a lane's. */
  worktree: string | null;
  /** The methods the repository allows (all three when it was not read). */
  methods: readonly MergeMethod[];
  /** The request merged: the list reads again. */
  onMerged?: () => void;
}

export function PullMerge({ host, row, worktree, methods, onMerged }: PullMergeProps) {
  const [step, setStep] = useState<ReviewStep>({ at: "closed" });
  const asked = useRef<string | null>(null);
  const key = `${row.source}:${row.repo}:${row.pull.number}`;

  // an ask left waiting when the request or the detail goes is taken back
  const drop = useCallback(() => {
    const id = asked.current;
    asked.current = null;
    if (id) void withdrawReviewAsk(host, id);
  }, [host]);
  useEffect(() => {
    setStep({ at: "closed" });
    return drop;
  }, [drop, key]);

  if (!host.reviewSettle || (!host.reviewMergePull && !(worktree && host.reviewMerge))) return null;

  const start = () => setStep({ at: "method", method: firstMethod(startMethod(sourceSettings()), methods), busy: false, why: null });
  const ask = async () => {
    if (step.at !== "method") return;
    const { method } = step;
    // the method the person chose is the one "the last one I chose" starts with next time, as a lane's Merge keeps it
    setSourceSettings({ lastMethod: method });
    setStep({ ...step, busy: true, why: null });
    try {
      const got = await askFor(host, row, worktree, method, sourceSettings().dropCredits);
      await openReviewAsk(got);
      asked.current = got.id;
      setStep({ at: "ask", ask: got, busy: false, why: null });
    } catch (e) {
      setStep({ at: "method", method, busy: false, why: e instanceof Error ? e.message : String(e) });
    }
  };
  const answer = async (yes: boolean) => {
    if (step.at !== "ask" || step.busy) return;
    const a = step.ask;
    setStep({ ...step, busy: true, why: null });
    const got = await answerReviewAsk(host, a.id, yes);
    asked.current = null;
    if (!got.ok) {
      setStep({ at: "closed", kind: "merge", done: { outcome: "failed", pushed: false, url: "", number: 0, step: "settle", error: whyWords(got.refused) } });
      return;
    }
    if (got.done.outcome === "merged") {
      dropPull(a.source, a.repo, a.number);
      onMerged?.();
    }
    setStep({ at: "closed", kind: "merge", done: got.done.outcome === "declined" ? null : got.done });
  };
  const change = () => {
    if (step.at !== "ask") return;
    drop();
    setStep({ at: "method", method: step.ask.method || firstMethod(startMethod(sourceSettings()), methods), busy: false, why: null });
  };
  return (
    <PullMergeView
      step={step}
      draft={row.pull.state === "draft"}
      methods={methods}
      onStart={start}
      onMethod={(method) => setStep((s) => (s.at === "method" ? { ...s, method, why: null } : s))}
      onAsk={() => void ask()}
      onYes={() => void answer(true)}
      onNo={() => void answer(false)}
      onClose={() => {
        drop();
        setStep({ at: "closed" });
      }}
      onChange={change}
      onOpenUrl={(url) => void openExternal(url).catch(() => undefined)}
    />
  );
}
