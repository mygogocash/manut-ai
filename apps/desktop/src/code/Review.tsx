// Put up for review (item 75): a lane whose branch has commits can be pushed and its pull request opened from its row on the Code
// page or from the pane beside it. One ask covers both steps, in the app's own words: the repository, the branch, the base, the
// title and the body exactly as they will be sent, with Push and open or Not now. Nothing is pushed until the person says yes,
// and the answer is settled once (code/reviewAsk.ts: approval-core, then the shell's own once, src-tauri/src/review.rs).
//
// The steps: the link opens a draft (a title and a description, filled from the lane's commits and its title, which the person may
// change); Ask sends them to the shell, which reads the lane now and answers the ask, or why the lane cannot go up (no remote, the
// CLI not signed in, nothing to put up...); the ask shows what will go; Push and open runs it once. Changing the draft again takes
// the ask back first, so a Yes never lands on words the person no longer sees.
//
// `ReviewView` draws a given step so a test can draw each one; `Review` keeps the step and talks to the shell.
import "./review.css";
import { useCallback, useEffect, useRef, useState } from "react";
import { t, type Key } from "../i18n";
import { getHost } from "../sessions/host";
import { maskSecrets } from "../lib/secrets";
import { openExternal } from "../lib/openExternal";
import { notePulls, usePullRequests, type LanePull } from "../tasks/pulls";
import { answerReviewAsk, openReviewAsk, withdrawReviewAsk } from "./reviewAsk";
import type { ReviewAsk, ReviewDone, ReviewDraft } from "./source";

/** Where the panel is. `why` is a code (the shell's, or approval-core's) said in words by `whyWords`. */
export type ReviewStep =
  | { at: "closed"; done?: ReviewDone | null }
  | { at: "draft"; title: string; body: string; busy: boolean; why: string | null }
  | { at: "ask"; ask: ReviewAsk; busy: boolean; why: string | null };

/** The codes the panel has words for; anything else is the shell's or the CLI's own line, masked. */
const WHY_CODES = [
  "no_remote",
  "not_installed",
  "not_signed_in",
  "no_commits",
  "base_not_on_remote",
  "mirror_remote",
  "bad_title",
  "bad_body",
  "not_a_lane",
  "gone",
  "moved",
  "unread",
  "git_missing",
  "bad_name",
  "already_decided",
  "withdrawn",
  "expired",
  "not_found",
  "changed",
  "no_shell",
] as const;

export function whyWords(code: string): string {
  return (WHY_CODES as readonly string[]).includes(code) ? t(`review.why.${code}` as Key) : maskSecrets(code);
}

/** What a settled ask did, in a line. */
export function doneWords(d: ReviewDone): string {
  if (d.outcome === "declined") return t("review.done.declined");
  if (d.outcome === "opened") return d.number > 0 ? t("review.done.opened", { n: d.number }) : t("review.done.openedNoNumber");
  const error = maskSecrets(d.error);
  if (d.step === "settle") return d.error;
  if (d.step === "check") return t("review.done.check");
  if (d.step === "push") return t("review.done.push", { error });
  return t("review.done.create", { error });
}

/** The first words of a pull request: one commit's subject, else the lane's title; the body lists the commits, oldest first. */
export function draftOf(draft: ReviewDraft | null, laneTitle: string): { title: string; body: string } {
  const commits = draft?.commits ?? [];
  const title = commits.length === 1 ? commits[0] : laneTitle.trim() || commits[0] || "";
  const body = commits.length > 1 ? [...commits].reverse().map((c) => `- ${c}`).join("\n") : "";
  return { title, body };
}

export interface ReviewViewProps {
  step: ReviewStep;
  /** The lane already has an open pull request: the link to put it up is not offered. */
  pull?: LanePull | null;
  onStart: () => void;
  onTitle: (title: string) => void;
  onBody: (body: string) => void;
  onAsk: () => void;
  onYes: () => void;
  onNo: () => void;
  onClose: () => void;
  /** Back from the ask to the draft: the ask is taken back first. */
  onChange?: () => void;
  onOpenUrl?: (url: string) => void;
}

function TextBox({ text, testId }: { text: string; testId: string }) {
  return (
    <pre className="rv-text" data-testid={testId}>
      {text === "" ? t("review.empty") : text}
    </pre>
  );
}

export function ReviewView(p: ReviewViewProps) {
  const s = p.step;
  if (s.at === "closed") {
    const done = s.done ?? null;
    if (p.pull && !done) return null;
    return (
      <div className="review" data-testid="review">
        {done && (
          <p className={done.outcome === "failed" ? "rv-why" : "mut"} role="status" data-testid="review-done" data-outcome={done.outcome}>
            {doneWords(done)}
            {done.outcome === "opened" && done.url && (
              <>
                {" "}
                <button type="button" className="lk" onClick={() => p.onOpenUrl?.(done.url)} data-testid="review-done-open">
                  {t("review.done.openLink")}
                </button>
              </>
            )}
          </p>
        )}
        {!p.pull && (
          <p>
            <button type="button" className="lk" onClick={p.onStart} title={t("review.startTip")} data-testid="review-start">
              {t("review.start")}
            </button>
          </p>
        )}
      </div>
    );
  }
  if (s.at === "draft") {
    return (
      <div className="review" data-testid="review">
        <div className="rv-panel" role="group" aria-label={t("review.start")} data-testid="review-draft">
          <label>
            <span>{t("review.title")}</span>
            <input type="text" value={s.title} onChange={(e) => p.onTitle(e.currentTarget.value)} maxLength={256} data-testid="review-title" />
          </label>
          <label>
            <span>{t("review.body")}</span>
            <textarea value={s.body} onChange={(e) => p.onBody(e.currentTarget.value)} data-testid="review-body" />
          </label>
          {s.why && (
            <p className="rv-why" role="alert" data-testid="review-why">
              {whyWords(s.why)}
            </p>
          )}
          <div className="rv-actions">
            <button type="button" className="btn dark" disabled={s.busy || s.title.trim() === ""} onClick={p.onAsk} data-testid="review-ask-button">
              {t("review.ask")}
            </button>
            <button type="button" className="btn" onClick={p.onClose} data-testid="review-cancel">
              {t("review.cancel")}
            </button>
          </div>
        </div>
      </div>
    );
  }
  const a = s.ask;
  const where = t(a.source === "github" ? "src.github" : "src.gitlab");
  return (
    <div className="review" data-testid="review">
      <div className="rv-panel warn" role="group" aria-label={t("review.ask.open", { branch: a.branch })} data-testid="review-ask" data-kind={a.kind}>
        <p className="rv-h">{t("review.ask.open", { branch: a.branch })}</p>
        <dl>
          <dt>{t("review.ask.repo")}</dt>
          <dd className="mono" data-testid="review-repo">
            {t("review.ask.repoOn", { repo: a.repo, where })}
          </dd>
          <dt>{t("review.ask.branch")}</dt>
          <dd data-testid="review-branch">{t(a.commits === 1 ? "review.ask.branchOne" : "review.ask.branchMany", { branch: a.branch, n: a.commits, remote: a.remote })}</dd>
          <dt>{t("review.ask.base")}</dt>
          <dd className="mono" data-testid="review-base">
            {a.base}
          </dd>
        </dl>
        <p>{t("review.title")}</p>
        <TextBox text={a.title} testId="review-ask-title" />
        <p>{t("review.body")}</p>
        <TextBox text={a.body} testId="review-ask-body" />
        {a.uncommitted > 0 && <p data-testid="review-uncommitted">{a.uncommitted === 1 ? t("review.ask.uncommittedOne") : t("review.ask.uncommittedMany", { n: a.uncommitted })}</p>}
        <p className="mut">{t("review.ask.never")}</p>
        {s.why && (
          <p className="rv-why" role="alert" data-testid="review-why">
            {whyWords(s.why)}
          </p>
        )}
        <div className="rv-actions">
          <button type="button" className="btn dark" disabled={s.busy} aria-busy={s.busy} onClick={p.onYes} data-testid="review-yes">
            {t("review.ask.yes")}
          </button>
          <button type="button" className="btn" disabled={s.busy} onClick={p.onNo} data-testid="review-no">
            {t("review.ask.no")}
          </button>
          {p.onChange && (
            <button type="button" className="lk" disabled={s.busy} onClick={p.onChange} data-testid="review-change">
              {t("review.change")}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

export interface ReviewProps {
  /** The lane's own folder (its worktree) and its title. */
  worktree: string;
  title: string;
  /** The open pull request already made from the branch, when the app has read one (tasks/pulls.ts). */
  pull?: LanePull | null;
}

/** The panel of one lane: closed with its link, a draft, or an ask, and what the last answer did. */
export function Review({ worktree, title, pull = null }: ReviewProps) {
  const [step, setStep] = useState<ReviewStep>({ at: "closed" });
  const asked = useRef<string | null>(null);
  const host = getHost();

  // an ask left waiting when the lane or the panel goes is taken back
  const drop = useCallback(() => {
    const id = asked.current;
    asked.current = null;
    if (id) void withdrawReviewAsk(getHost(), id);
  }, []);
  useEffect(() => drop, [drop, worktree]);

  if (!host.reviewAsk || !host.reviewSettle) return null;

  const start = async () => {
    setStep({ at: "draft", ...draftOf(null, title), busy: true, why: null });
    const draft = await host.reviewDraft?.(worktree).catch(() => null);
    setStep((s) => (s.at === "draft" && s.busy ? { ...s, ...draftOf(draft ?? null, title), busy: false } : s));
  };
  const ask = async () => {
    if (step.at !== "draft") return;
    const { title: tt, body } = step;
    setStep({ ...step, busy: true, why: null });
    try {
      const got = await host.reviewAsk!(worktree, tt, body);
      await openReviewAsk(got);
      asked.current = got.id;
      setStep({ at: "ask", ask: got, busy: false, why: null });
    } catch (e) {
      setStep({ at: "draft", title: tt, body, busy: false, why: e instanceof Error ? e.message : String(e) });
    }
  };
  const answer = async (yes: boolean) => {
    if (step.at !== "ask" || step.busy) return;
    const a = step.ask;
    setStep({ ...step, busy: true, why: null });
    const got = await answerReviewAsk(host, a.id, yes);
    asked.current = null;
    if (!got.ok) {
      setStep({ at: "closed", done: { outcome: "failed", pushed: false, url: "", number: 0, step: "settle", error: whyWords(got.refused) } });
      return;
    }
    // an opened pull request shows on the lane's row at once, as Tasks would list it, until the next read of the list
    if (got.done.outcome === "opened" && got.done.number > 0) {
      notePulls(a.source, a.repo, [{ number: got.done.number, title: a.title, state: "open", url: got.done.url, labels: [], author: "", created: 0, updated: 0, checks: null, head: a.branch }], Date.now());
    }
    setStep({ at: "closed", done: got.done.outcome === "declined" ? null : got.done });
  };
  const close = () => {
    drop();
    setStep({ at: "closed" });
  };
  const edit = (patch: { title?: string; body?: string }) => setStep((s) => (s.at === "draft" ? { ...s, ...patch, why: null } : s));
  const change = () => {
    if (step.at !== "ask") return;
    drop();
    setStep({ at: "draft", title: step.ask.title, body: step.ask.body, busy: false, why: null });
  };

  return (
    <ReviewView
      step={step}
      pull={pull}
      onStart={() => void start()}
      onTitle={(v) => edit({ title: v })}
      onBody={(v) => edit({ body: v })}
      onAsk={() => void ask()}
      onYes={() => void answer(true)}
      onNo={() => void answer(false)}
      onClose={close}
      onChange={change}
      onOpenUrl={(url) => void openExternal(url).catch(() => undefined)}
    />
  );
}

/** The panel of the lane whose branch is `branch` in project `root`, with the open pull request made from it when the app has read
 *  one (the same cache the lane's row reads, tasks/pulls.ts), so the row and the pane offer the same thing. */
export function LaneReview({ root, worktree, branch, title }: { root: string; worktree: string; branch: string; title: string }) {
  const pulls = usePullRequests(root, [branch]);
  return <Review worktree={worktree} title={title} pull={pulls.get(branch) ?? null} />;
}
