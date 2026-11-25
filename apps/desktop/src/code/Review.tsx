// Put up for review, and merge (item 75): from a lane's row on the Code page, or from the pane beside it.
//
// - A lane with no open pull request offers Put up for review. One ask covers both steps, in the app's own words: the repository,
//   the branch, the base, the title and the body exactly as they will be sent, with Push and open or Not now.
// - A lane whose pull request is open (not a draft) offers Merge. Its ask names the pull request, the method (merge, squash or
//   rebase, starting from Settings › Source control › Default merge method) and exactly what the merge's message will be, with the
//   recognised agent credit lines taken out when the person turned that on. Merging cannot be undone, so it is always asked: there
//   is no auto-merge and no setting that skips the ask, and the branch stays.
//
// Nothing is pushed, opened or merged until the person says yes, and the answer is settled once (code/reviewAsk.ts: approval-core,
// then the shell's own once, src-tauri/src/review.rs). The steps: the link opens a draft (a title and a description from the
// lane's commits and its title, which the person may change) or the method; Ask sends them to the shell, which reads the lane and
// the pull request now and answers the ask, or why not (no remote, the CLI not signed in, nothing to put up, it cannot merge
// yet...); the ask shows what will happen; Yes runs it once. Changing what is asked takes the ask back first, so a Yes never lands
// on words the person no longer sees.
//
// `ReviewView` draws a given step so a test can draw each one; `Review` keeps the step and talks to the shell.
import "./review.css";
import { useCallback, useEffect, useRef, useState } from "react";
import { t, type Key } from "../i18n";
import { getHost } from "../sessions/host";
import { maskSecrets } from "../lib/secrets";
import { openExternal } from "../lib/openExternal";
import { setSourceSettings, sourceSettings, startMethod } from "../lib/sourceControl";
import { dropPull, notePulls, usePullRequests, type LanePull } from "../tasks/pulls";
import { answerReviewAsk, openReviewAsk, withdrawReviewAsk } from "./reviewAsk";
import { MERGE_METHODS, type MergeMethod, type ReviewAsk, type ReviewDone, type ReviewDraft } from "./source";

/** Where the panel is. `why` is a code (the shell's, or approval-core's) said in words by `whyWords`. */
export type ReviewStep =
  | { at: "closed"; done?: ReviewDone | null; kind?: "open" | "merge" }
  | { at: "draft"; title: string; body: string; busy: boolean; why: string | null }
  | { at: "method"; method: MergeMethod; busy: boolean; why: string | null }
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
  "not_this_lane",
  "bad_method",
  "bad_number",
] as const;

/** Why a pull request cannot merge now, as the shell says it (`cannot_merge:<why>`). */
const CANNOT = ["closed", "draft", "conflicts", "behind", "blocked", "checking"] as const;

export function whyWords(code: string): string {
  if (code.startsWith("cannot_merge:")) {
    const why = code.slice("cannot_merge:".length);
    return (CANNOT as readonly string[]).includes(why) ? t(`review.why.cannot.${why}` as Key) : maskSecrets(code);
  }
  return (WHY_CODES as readonly string[]).includes(code) ? t(`review.why.${code}` as Key) : maskSecrets(code);
}

/** What a settled ask of `kind` did, in a line. */
export function doneWords(d: ReviewDone, kind: "open" | "merge" = "open"): string {
  if (d.outcome === "declined") return t(kind === "merge" ? "review.done.notMerged" : "review.done.declined");
  if (d.outcome === "opened") return d.number > 0 ? t("review.done.opened", { n: d.number }) : t("review.done.openedNoNumber");
  if (d.outcome === "merged") return t("review.done.merged", { n: d.number });
  const error = maskSecrets(d.error);
  if (d.step === "settle") return d.error;
  if (d.step === "check") return t(kind === "merge" ? "review.done.mergeCheck" : "review.done.check");
  if (d.step === "push") return t("review.done.push", { error });
  if (d.step === "merge") return t("review.done.merge", { error });
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
  /** The open pull request made from the lane's branch, when the app has read one: Merge is offered instead of Put up for review,
   *  and only while it is not a draft. */
  pull?: LanePull | null;
  onStart: () => void;
  onTitle: (title: string) => void;
  onBody: (body: string) => void;
  onAsk: () => void;
  onMergeStart?: () => void;
  onMethod?: (method: MergeMethod) => void;
  onMergeAsk?: () => void;
  onYes: () => void;
  onNo: () => void;
  onClose: () => void;
  /** Back from the ask to what it was made from: the ask is taken back first. */
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

function Why({ why }: { why: string | null }) {
  return why ? (
    <p className="rv-why" role="alert" data-testid="review-why">
      {whyWords(why)}
    </p>
  ) : null;
}

/** What the ask's buttons and its way back look like, for both kinds. */
function AskButtons({ yes, busy, p }: { yes: Key; busy: boolean; p: ReviewViewProps }) {
  return (
    <div className="rv-actions">
      <button type="button" className="btn dark" disabled={busy} aria-busy={busy} onClick={p.onYes} data-testid="review-yes">
        {t(yes)}
      </button>
      <button type="button" className="btn" disabled={busy} onClick={p.onNo} data-testid="review-no">
        {t("review.ask.no")}
      </button>
      {p.onChange && (
        <button type="button" className="lk" disabled={busy} onClick={p.onChange} data-testid="review-change">
          {t("review.change")}
        </button>
      )}
    </div>
  );
}

function OpenAsk({ a, s, p }: { a: ReviewAsk; s: { busy: boolean; why: string | null }; p: ReviewViewProps }) {
  const where = t(a.source === "github" ? "src.github" : "src.gitlab");
  return (
    <div className="rv-panel warn" role="group" aria-label={t("review.ask.open", { branch: a.branch })} data-testid="review-ask" data-kind="open">
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
      <Why why={s.why} />
      <AskButtons yes="review.ask.yes" busy={s.busy} p={p} />
    </div>
  );
}

function MergeAsk({ a, s, p }: { a: ReviewAsk; s: { busy: boolean; why: string | null }; p: ReviewViewProps }) {
  const where = t(a.source === "github" ? "src.github" : "src.gitlab");
  const method = a.method || "merge";
  return (
    <div className="rv-panel warn" role="group" aria-label={t("review.merge.ask", { n: a.number, base: a.base })} data-testid="review-ask" data-kind="merge">
      <p className="rv-h">{t("review.merge.ask", { n: a.number, base: a.base })}</p>
      <dl>
        <dt>{t("review.ask.repo")}</dt>
        <dd className="mono" data-testid="review-repo">
          {t("review.ask.repoOn", { repo: a.repo, where })}
        </dd>
        <dt>{t("review.merge.pull")}</dt>
        <dd data-testid="review-pull">{t("review.merge.pullLine", { n: a.number, title: a.title })}</dd>
        <dt>{t("review.ask.branch")}</dt>
        <dd className="mono" data-testid="review-branch">
          {t("review.merge.into", { branch: a.branch, base: a.base })}
        </dd>
        <dt>{t("review.merge.method")}</dt>
        <dd data-testid="review-method" data-method={method}>
          {t(`review.method.${method}` as Key)}
        </dd>
      </dl>
      {method === "rebase" ? (
        <p data-testid="review-no-message">{t("review.merge.noMessage", { base: a.base })}</p>
      ) : (
        <>
          <p>{t(a.source === "gitlab" && method === "squash" ? "review.merge.messageBoth" : "review.merge.message")}</p>
          <TextBox text={a.subject} testId="review-subject" />
          <TextBox text={a.message} testId="review-message" />
          {a.dropped > 0 && (
            <p className="mut" data-testid="review-dropped">
              {a.dropped === 1 ? t("review.merge.droppedOne") : t("review.merge.droppedMany", { n: a.dropped })}
            </p>
          )}
        </>
      )}
      <p className="mut">{t("review.merge.never")}</p>
      <Why why={s.why} />
      <AskButtons yes="review.merge.yes" busy={s.busy} p={p} />
    </div>
  );
}

export function ReviewView(p: ReviewViewProps) {
  const s = p.step;
  if (s.at === "closed") {
    const done = s.done ?? null;
    const mergeable = !!p.pull && p.pull.state === "open" && !!p.onMergeStart;
    if (p.pull && !done && !mergeable) return null;
    return (
      <div className="review" data-testid="review">
        {done && (
          <p className={done.outcome === "failed" ? "rv-why" : "mut"} role="status" data-testid="review-done" data-outcome={done.outcome}>
            {doneWords(done, s.kind)}
            {(done.outcome === "opened" || done.outcome === "merged") && done.url && (
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
        {mergeable && p.pull && (
          <p>
            <button type="button" className="lk" onClick={p.onMergeStart} title={t("review.merge.startTip")} data-testid="review-merge-start">
              {t("review.merge.start", { n: p.pull.number })}
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
          <Why why={s.why} />
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
  if (s.at === "method") {
    return (
      <div className="review" data-testid="review">
        <div className="rv-panel" role="group" aria-label={t("review.merge.method")} data-testid="review-method-step">
          <label>
            <span>{t("review.merge.method")}</span>
            <select value={s.method} onChange={(e) => p.onMethod?.(e.currentTarget.value as MergeMethod)} data-testid="review-method-pick">
              {MERGE_METHODS.map((m) => (
                <option key={m} value={m}>
                  {t(`review.method.${m}` as Key)}
                </option>
              ))}
            </select>
          </label>
          <Why why={s.why} />
          <div className="rv-actions">
            <button type="button" className="btn dark" disabled={s.busy} onClick={p.onMergeAsk} data-testid="review-merge-ask">
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
  return <div className="review" data-testid="review">{s.ask.kind === "merge" ? <MergeAsk a={s.ask} s={s} p={p} /> : <OpenAsk a={s.ask} s={s} p={p} />}</div>;
}

export interface ReviewProps {
  /** The lane's own folder (its worktree) and its title. */
  worktree: string;
  title: string;
  /** The open pull request made from the branch, when the app has read one (tasks/pulls.ts). */
  pull?: LanePull | null;
}

/** The panel of one lane: closed with its link, a draft or a method, or an ask, and what the last answer did. */
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
  const asking = async (make: () => Promise<ReviewAsk>, back: ReviewStep) => {
    try {
      const got = await make();
      await openReviewAsk(got);
      asked.current = got.id;
      setStep({ at: "ask", ask: got, busy: false, why: null });
    } catch (e) {
      setStep({ ...back, why: e instanceof Error ? e.message : String(e) } as ReviewStep);
    }
  };
  const ask = async () => {
    if (step.at !== "draft") return;
    const { title: tt, body } = step;
    setStep({ ...step, busy: true, why: null });
    await asking(() => host.reviewAsk!(worktree, tt, body), { at: "draft", title: tt, body, busy: false, why: null });
  };
  const mergeAsk = async () => {
    if (step.at !== "method" || !pull || !host.reviewMerge) return;
    const { method } = step;
    // the method the person chose is the one "the last one I chose" starts with next time
    setSourceSettings({ lastMethod: method });
    setStep({ ...step, busy: true, why: null });
    await asking(() => host.reviewMerge!(worktree, pull.number, method, sourceSettings().dropCredits), { at: "method", method, busy: false, why: null });
  };
  const answer = async (yes: boolean) => {
    if (step.at !== "ask" || step.busy) return;
    const a = step.ask;
    setStep({ ...step, busy: true, why: null });
    const got = await answerReviewAsk(host, a.id, yes);
    asked.current = null;
    if (!got.ok) {
      setStep({ at: "closed", kind: a.kind, done: { outcome: "failed", pushed: false, url: "", number: 0, step: "settle", error: whyWords(got.refused) } });
      return;
    }
    // an opened pull request shows on the lane's row at once, as Tasks would list it, until the next read of the list; a merged
    // one leaves it
    if (got.done.outcome === "opened" && got.done.number > 0) {
      notePulls(a.source, a.repo, [{ number: got.done.number, title: a.title, state: "open", url: got.done.url, labels: [], author: "", created: 0, updated: 0, checks: null, head: a.branch }], Date.now());
    }
    if (got.done.outcome === "merged") dropPull(a.source, a.repo, a.number);
    setStep({ at: "closed", kind: a.kind, done: got.done.outcome === "declined" ? null : got.done });
  };
  const close = () => {
    drop();
    setStep({ at: "closed" });
  };
  const edit = (patch: { title?: string; body?: string }) => setStep((s) => (s.at === "draft" ? { ...s, ...patch, why: null } : s));
  const change = () => {
    if (step.at !== "ask") return;
    drop();
    const a = step.ask;
    setStep(a.kind === "merge" ? { at: "method", method: a.method || startMethod(sourceSettings()), busy: false, why: null } : { at: "draft", title: a.title, body: a.body, busy: false, why: null });
  };

  return (
    <ReviewView
      step={step}
      pull={pull}
      onStart={() => void start()}
      onTitle={(v) => edit({ title: v })}
      onBody={(v) => edit({ body: v })}
      onAsk={() => void ask()}
      {...(host.reviewMerge ? { onMergeStart: () => setStep({ at: "method", method: startMethod(sourceSettings()), busy: false, why: null }) } : {})}
      onMethod={(method) => setStep((s) => (s.at === "method" ? { ...s, method, why: null } : s))}
      onMergeAsk={() => void mergeAsk()}
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
