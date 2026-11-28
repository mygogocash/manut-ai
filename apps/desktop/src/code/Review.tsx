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
// `ReviewView` draws a given step so a test can draw each one; `ReviewFlow` walks the steps and talks to the shell, apart from any
// page, so the panel under a lane's row (`Review`) and the lane's top bar (LaneStep.tsx, item 167e) walk the very same steps and a
// test walks them without a page.
import "./review.css";
import { useEffect, useState, useSyncExternalStore } from "react";
import { t, type Key } from "../i18n";
import { titleModel, titlesFor, useTitleModel } from "../lib/titleModel";
import { pullMaterial, whyKey } from "../sessions/titleWords";
import { getHost, type SessionHost } from "../sessions/host";
import { maskSecrets } from "../lib/secrets";
import { openExternal } from "../lib/openExternal";
import { setSourceSettings, sourceSettings, startMethod } from "../lib/sourceControl";
import { dropPull, notePulls, usePullRequests, type LanePull } from "../tasks/pulls";
import { answerReviewAsk, openReviewAsk, withdrawReviewAsk } from "./reviewAsk";
import { MERGE_METHODS, type MergeMethod, type ReviewAsk, type ReviewDone, type ReviewDraft } from "./source";

/** Where the panel is. `why` is a code (the shell's, or approval-core's) said in words by `whyWords`. */
export type ReviewStep =
  | { at: "closed"; done?: ReviewDone | null; kind?: "open" | "merge" }
  | { at: "draft"; title: string; body: string; busy: boolean; why: string | null; writing?: boolean }
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
  "other_repo",
  "lane_ahead",
  "pull_ahead",
  "not_pushed",
  "bad_method",
  "bad_number",
  "not_this_project",
  "method_not_allowed",
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
  /** Suggest (item 96): offered only when the person turned on Settings › Titles and words and the host can. */
  onSuggest?: () => void;
  onMergeStart?: () => void;
  onMethod?: (method: MergeMethod) => void;
  onMergeAsk?: () => void;
  onYes: () => void;
  onNo: () => void;
  onClose: () => void;
  /** Back from the ask to what it was made from: the ask is taken back first. */
  onChange?: () => void;
  onOpenUrl?: (url: string) => void;
  /** The merge methods the repository allows (the Pull requests list reads them, item 100); none: all three. */
  methods?: readonly MergeMethod[];
  /** false: closed, the panel shows only what the last answer did, since the lane's top bar holds the one button that opens it (item
   *  167e); the quiet links are the row's. */
  links?: boolean;
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
        <dd data-testid="review-pull">{t("review.merge.pullLine", { n: a.number, title: a.title, head: a.head.slice(0, 7) })}</dd>
        <dt>{t("review.ask.branch")}</dt>
        <dd className="mono" data-testid="review-branch">
          {t("review.merge.into", { branch: a.branch, from: a.from, base: a.base })}
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
    const links = p.links !== false;
    const offer = links && !p.pull;
    const mergeable = links && !!p.pull && p.pull.state === "open" && !!p.onMergeStart;
    if (!done && !offer && !mergeable) return null;
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
        {offer && (
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
            {p.onSuggest && (
              <button type="button" className="btn" disabled={s.busy || !!s.writing} onClick={p.onSuggest} data-testid="review-suggest">
                {s.writing ? t("titles.suggesting") : t("titles.suggest")}
              </button>
            )}
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
              {(p.methods?.length ? MERGE_METHODS.filter((m) => p.methods!.includes(m)) : MERGE_METHODS).map((m) => (
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

/** What the steps need of the shell: the reads and asks of src-tauri/src/review.rs, and the title run behind Suggest. Nothing here
 *  can write: a push, a pull request or a merge runs only from a settled ask (reviewAsk.ts). */
export type FlowHost = Pick<SessionHost, "reviewDraft" | "reviewAsk" | "reviewMerge" | "reviewSettle" | "reviewWithdraw" | "titleRun" | "laneDiff">;

/** The steps of one lane's Put up for review and Merge (item 75): closed with what the last answer did, a draft or a method, then
 *  the one ask, settled once. It keeps the step itself and says when it moved, so a page subscribes to it and a test drives it.
 *  `title` and `pull` follow the lane (its title, and the open pull request made from its branch when the app has read one). */
export class ReviewFlow {
  private step: ReviewStep = { at: "closed" };
  /** The ask now waiting, taken back when the lane or the panel goes. */
  private asked: string | null = null;
  private listeners = new Set<() => void>();
  title = "";
  pull: LanePull | null = null;

  constructor(
    readonly host: FlowHost,
    readonly worktree: string,
  ) {}

  get = (): ReviewStep => this.step;

  subscribe = (l: () => void): (() => void) => {
    this.listeners.add(l);
    return () => void this.listeners.delete(l);
  };

  private set(next: ReviewStep | ((s: ReviewStep) => ReviewStep)): void {
    this.step = typeof next === "function" ? next(this.step) : next;
    this.listeners.forEach((l) => l());
  }

  /** Whether this shell can ask at all: without its ask and its settle nothing is offered. */
  get can(): boolean {
    return !!this.host.reviewAsk && !!this.host.reviewSettle;
  }

  /** Whether it can ask to merge. */
  get canMerge(): boolean {
    return !!this.host.reviewMerge;
  }

  /** Takes an ask left waiting back, on both sides, so a later answer runs nothing. */
  drop = (): void => {
    const id = this.asked;
    this.asked = null;
    if (id) void withdrawReviewAsk(this.host, id);
  };

  /** Put up for review: the draft, its words from the lane's commits and its title, both the person's to change. Only reads. */
  start = async (): Promise<void> => {
    this.set({ at: "draft", ...draftOf(null, this.title), busy: true, why: null });
    const draft = await this.host.reviewDraft?.(this.worktree).catch(() => null);
    this.set((s) => (s.at === "draft" && s.busy ? { ...s, ...draftOf(draft ?? null, this.title), busy: false } : s));
  };

  /** Merge: the method, starting from Settings › Source control. Asks nothing. */
  mergeStart = (): void => this.set({ at: "method", method: startMethod(sourceSettings()), busy: false, why: null });

  /** The lane's top bar's one button (item 167e): it opens the step it names, the draft or the method, exactly as the row's quiet link
   *  does. A press asks the shell for nothing that writes and answers no ask: the push, the pull request and the merge wait for Ask
   *  and then for a Yes that approval-core settled. */
  press = (step: "review" | "merge"): void => {
    if (step === "merge") this.mergeStart();
    else void this.start();
  };

  private asking = async (make: () => Promise<ReviewAsk>, back: ReviewStep): Promise<void> => {
    try {
      const got = await make();
      await openReviewAsk(got);
      this.asked = got.id;
      this.set({ at: "ask", ask: got, busy: false, why: null });
    } catch (e) {
      this.set({ ...back, why: e instanceof Error ? e.message : String(e) } as ReviewStep);
    }
  };

  /** Ask (the draft's): the shell reads the lane now and answers the ask, or why not. Writes nothing. */
  ask = async (): Promise<void> => {
    const s = this.step;
    const host = this.host;
    if (s.at !== "draft" || !host.reviewAsk) return;
    const { title, body } = s;
    this.set({ ...s, busy: true, why: null });
    // called on the host, as its own method: a host's asks read its own state
    await this.asking(() => host.reviewAsk!(this.worktree, title, body), { at: "draft", title, body, busy: false, why: null });
  };

  /** Ask (the method's): the shell reads the pull request now and answers the merge's ask, or why not. Writes nothing. */
  mergeAsk = async (): Promise<void> => {
    const s = this.step;
    const pull = this.pull;
    const host = this.host;
    if (s.at !== "method" || !pull || !host.reviewMerge) return;
    const { method } = s;
    // the method the person chose is the one "the last one I chose" starts with next time
    setSourceSettings({ lastMethod: method });
    this.set({ ...s, busy: true, why: null });
    await this.asking(() => host.reviewMerge!(this.worktree, pull.number, method, sourceSettings().dropCredits), { at: "method", method, busy: false, why: null });
  };

  /** The person's Yes or No to the ask shown: approval-core settles it, and only then does the shell hear of it, once. */
  answer = async (yes: boolean): Promise<void> => {
    const s = this.step;
    if (s.at !== "ask" || s.busy) return;
    const a = s.ask;
    this.set({ ...s, busy: true, why: null });
    const got = await answerReviewAsk(this.host, a.id, yes);
    this.asked = null;
    if (!got.ok) {
      this.set({ at: "closed", kind: a.kind, done: { outcome: "failed", pushed: false, url: "", number: 0, step: "settle", error: whyWords(got.refused) } });
      return;
    }
    // an opened pull request shows on the lane's row at once, as Tasks would list it, until the next read of the list; a merged
    // one leaves it
    if (got.done.outcome === "opened" && got.done.number > 0) {
      notePulls(a.source, a.repo, [{ number: got.done.number, title: a.title, state: "open", url: got.done.url, labels: [], author: "", created: 0, updated: 0, checks: null, head: a.branch, same: true }], Date.now());
    }
    if (got.done.outcome === "merged") dropPull(a.source, a.repo, a.number);
    this.set({ at: "closed", kind: a.kind, done: got.done.outcome === "declined" ? null : got.done });
  };

  close = (): void => {
    this.drop();
    this.set({ at: "closed" });
  };

  edit = (patch: { title?: string; body?: string }): void => this.set((s) => (s.at === "draft" ? { ...s, ...patch, why: null } : s));

  method = (method: MergeMethod): void => this.set((s) => (s.at === "method" ? { ...s, method, why: null } : s));

  /** Back from the ask to what it was made from: the ask is taken back first, so a Yes never lands on words the person no longer
   *  sees. */
  change = (): void => {
    const s = this.step;
    if (s.at !== "ask") return;
    this.drop();
    const a = s.ask;
    this.set(a.kind === "merge" ? { at: "method", method: a.method || startMethod(sourceSettings()), busy: false, why: null } : { at: "draft", title: a.title, body: a.body, busy: false, why: null });
  };

  /** Suggest: the person's chosen model writes a title and a description from the lane's commits and changed files, and they go into
   *  the two fields to be read and changed. Nothing is asked of the host's pull request path: Ask is still the person's. */
  suggest = async (): Promise<void> => {
    const s = this.step;
    const host = this.host;
    if (s.at !== "draft" || s.writing || !host.titleRun) return;
    this.set({ ...s, writing: true, why: null });
    const settings = titleModel();
    try {
      const draft = await this.host.reviewDraft?.(this.worktree).catch(() => null);
      const folder = await this.host.laneDiff(this.worktree).catch(() => null);
      const got = await host.titleRun({ agent: "claude", model: settings.model, effort: settings.effort, purpose: "pull", key: this.worktree, material: pullMaterial(draft?.commits ?? [], folder?.files ?? []) });
      if (!got.title) throw new Error("empty");
      this.set((x) => (x.at === "draft" ? { ...x, title: got.title, body: got.body, writing: false, why: null } : x));
    } catch (e) {
      this.set((x) => (x.at === "draft" ? { ...x, writing: false, why: t(`titles.why.${whyKey(e)}` as Key) } : x));
    }
  };
}

/** The steps of the lane whose own folder is `worktree`, kept while it is shown: a new lane gets new steps, and an ask left waiting is
 *  taken back when the lane or the page that shows it goes. */
export function useReviewFlow(worktree: string, title: string, pull: LanePull | null): ReviewFlow {
  const [held, setHeld] = useState(() => new ReviewFlow(getHost(), worktree));
  let flow = held;
  if (held.worktree !== worktree) {
    // another lane in the same place: its own steps, from closed (React's own way to start over from what a render was given)
    flow = new ReviewFlow(getHost(), worktree);
    setHeld(flow);
  }
  flow.title = title;
  flow.pull = pull;
  useSyncExternalStore(flow.subscribe, flow.get, flow.get);
  useEffect(() => flow.drop, [flow]);
  return flow;
}

/** The props that draw `flow`'s step: every press goes to the flow. */
export function flowProps(flow: ReviewFlow, suggest: boolean): Omit<ReviewViewProps, "pull"> {
  return {
    step: flow.get(),
    onStart: () => void flow.start(),
    onTitle: (v) => flow.edit({ title: v }),
    onBody: (v) => flow.edit({ body: v }),
    onAsk: () => void flow.ask(),
    ...(suggest ? { onSuggest: () => void flow.suggest() } : {}),
    ...(flow.canMerge ? { onMergeStart: flow.mergeStart } : {}),
    onMethod: flow.method,
    onMergeAsk: () => void flow.mergeAsk(),
    onYes: () => void flow.answer(true),
    onNo: () => void flow.answer(false),
    onClose: flow.close,
    onChange: flow.change,
    onOpenUrl: (url) => void openExternal(url).catch(() => undefined),
  };
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
  const flow = useReviewFlow(worktree, title, pull);
  const words = useTitleModel();
  if (!flow.can) return null;
  return <ReviewView {...flowProps(flow, !!flow.host.titleRun && titlesFor("claude", words))} pull={pull} />;
}

/** The panel of the lane whose branch is `branch` in project `root`, with the open pull request made from it when the app has read
 *  one (the same cache the lane's row reads, tasks/pulls.ts), so the row and the pane offer the same thing. */
export function LaneReview({ root, worktree, branch, title }: { root: string; worktree: string; branch: string; title: string }) {
  const pulls = usePullRequests(root, [branch]);
  return <Review worktree={worktree} title={title} pull={pulls.get(branch) ?? null} />;
}
