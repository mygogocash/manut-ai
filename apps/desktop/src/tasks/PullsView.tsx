// Tasks › Pull requests (item 100): every open pull / merge request of the projects the person has (the Code page's projects,
// code/KitPanel.tsx `codeProjects`), in one list under grey bands by how ready each is to merge (board.ts), readiest first. A row
// names the request, its repository and number, who opened it, when it last changed, its checks and its review, and whether it
// is a lane's. It opens the request in the app: its title, its description as plain text, its checks, its changed files with
// their counts, Open on GitHub (or GitLab), and Merge, which is the lane's own ask (code/PullMerge.tsx).
//
// Why it lives in Tasks and not on the Code page: Tasks is where pull requests are already read (a lane's row opens its request
// there, item 76), it is the page that names hosts and repositories, and a person who merges looks across every project at once,
// while the Code page shows one project, as an everyday page with no host's name on it.
//
// Reading costs little: once when shown, then at most once a minute while shown and in front, never while hidden (board.ts).
//
// A project on Azure DevOps, Gitea or Forgejo (item 100b) is listed too, read only, in the same bands: its row names its host and
// offers only Open on <host>, and nothing opens in the app or merges from here.
// `PullsListView` and `PullDetailView` draw given data so a test can draw each state; `PullsView` reads the hosts it is given.
import { useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from "react";
import { t, type Key } from "../i18n";
import { CloseIcon, IconButton, PrIcon, Spinner } from "../ui";
import { openExternal } from "../lib/openExternal";
import { addedFolders, pathKey, useFolderPrefs } from "../sessions/folders";
import { getSessions, useSessions } from "../sessions/sessions";
import { folderName } from "../sessions/agents";
import { pickTitle } from "../sessions/titles";
import { getStore } from "../state/store";
import { chatOfPull, useChatPullsVersion } from "../code/chatPull";
import { codeProjects } from "../code/KitPanel";
import { useLaneProjects } from "../code/KeptLanes";
import { PullMerge, type MergeHost } from "../code/PullMerge";
import { MERGE_METHODS, type MergeMethod } from "../code/source";
import type { TaskHost } from "./host";
import { BoardWatch, readiness, READINESS, REFRESH_MS, repoKey, rowOf, type BoardRow, type BoardState, type OtherRow } from "./board";
import { clearPick, useTasks } from "./state";
import { ago } from "./TasksPage";
import { SOURCE_NAME } from "./TasksBar";
import type { MergeMethods, PullDetail, PullRow } from "./types";
import "./pulls.css";

export const rowKey = (r: Pick<BoardRow, "source" | "repo"> & { pull: Pick<PullRow, "number"> }): string => `${r.source}:${r.repo}:${r.pull.number}`;

/** The checks of a request in words, and the meaning its colour carries. */
export function checksWord(p: Pick<PullRow, "checks">): { text: string; tone: "ok" | "fail" | "run" | "none" } {
  const c = p.checks;
  if (!c || c.total === 0) return { text: t("prs.checks.none"), tone: "none" };
  if (c.failed > 0) return { text: t("prs.checks.failing", { n: c.failed }), tone: "fail" };
  if (c.pending > 0) return { text: t("prs.checks.running", { n: c.pending }), tone: "run" };
  return { text: t("prs.checks.passed"), tone: "ok" };
}

/** The review of a request in words ("" when none is asked). */
export const reviewWord = (p: Pick<PullRow, "review">): string => (p.review ? t(`prs.review.${p.review}` as Key) : "");

/** The methods offered for `m` (all three when the repository's were not read). */
export const methodsOf = (m: MergeMethods | null): MergeMethod[] => (m ? MERGE_METHODS.filter((x) => m[x]) : [...MERGE_METHODS]);

export interface PullsListViewProps {
  state: Pick<BoardState, "rows" | "errors" | "repos" | "at"> & Partial<Pick<BoardState, "others" | "otherRepos">>;
  /** No project is open on the Code page. */
  noProjects: boolean;
  /** The selected request's key (`rowKey`). */
  selected: string | null;
  /** Whether a row is a lane's request. */
  isLane: (row: BoardRow) => boolean;
  /** The title of the chat that opened a row's request itself (code/chatPull.ts), or null. */
  chatOf?: (row: BoardRow) => string | null;
  onOpen: (row: BoardRow) => void;
  /** An other host's row's Open on <host> (item 100b): its address in the person's browser. */
  onOpenUrl?: (url: string) => void;
  onRetry: () => void;
  now?: number;
}

const noOpen = () => {};

export function PullsListView({ state, noProjects, selected, isLane, chatOf, onOpen, onOpenUrl, onRetry, now }: PullsListViewProps) {
  if (noProjects) return <p className="prs-none" data-testid="prs-noprojects">{t("prs.noProjects")}</p>;
  const others = state.others ?? [];
  if (state.repos !== null && state.repos.length === 0 && (state.otherRepos ?? []).length === 0) return <p className="prs-none" data-testid="prs-norepos">{t("prs.noRepos")}</p>;
  if (state.at === null)
    return (
      <div className="prs-wait">
        <Spinner />
      </div>
    );
  const groups = READINESS.map((r) => ({ r, rows: state.rows.filter((x) => readiness(x.pull) === r), others: others.filter((x) => readiness(x.pull) === r) })).filter((g) => g.rows.length + g.others.length > 0);
  return (
    <>
      {state.errors.map((e) => (
        <p key={`${e.source}:${e.repo}`} className="prs-err" role="alert" data-testid="prs-error">
          {t("prs.failed", { repo: e.repo, error: e.error })}{" "}
          <button type="button" className="lk" onClick={onRetry}>
            {t("prs.retry")}
          </button>
        </p>
      ))}
      {groups.length === 0 && state.errors.length === 0 && (
        <p className="prs-none" data-testid="prs-none">
          {t("prs.none")}
        </p>
      )}
      {groups.map((g) => (
        <section key={g.r} className="prs-group" aria-labelledby={`prs-band-${g.r}`} data-testid={`prs-group-${g.r}`}>
          <div className="band" id={`prs-band-${g.r}`}>
            <span>{t(`prs.band.${g.r}` as Key)}</span>
            <span className="prs-count">{g.rows.length + g.others.length}</span>
          </div>
          {g.rows.map((row) => (
            <PullRowView key={rowKey(row)} row={row} on={selected === rowKey(row)} lane={isLane(row)} chat={chatOf?.(row) ?? null} onOpen={onOpen} now={now} />
          ))}
          {g.others.map((row) => (
            <OtherRowView key={`${row.host}:${row.name}:${row.repo}:${row.pull.number}`} row={row} onOpenUrl={onOpenUrl ?? noOpen} now={now} />
          ))}
        </section>
      ))}
    </>
  );
}

function PullRowView({ row, on, lane, chat, onOpen, now }: { row: BoardRow; on: boolean; lane: boolean; chat: string | null; onOpen: (row: BoardRow) => void; now?: number }) {
  const p = row.pull;
  const checks = checksWord(p);
  const review = reviewWord(p);
  return (
    <button type="button" className={`rowl prs-row${on ? " on" : ""}`} aria-current={on ? "true" : undefined} onClick={() => onOpen(row)} data-testid="prs-row" data-pull={rowKey(row)} data-readiness={readiness(p)}>
      <span className="prs-mark">
        <PrIcon state={p.state === "draft" ? "draft" : "open"} size={14} />
      </span>
      <span className="grow">
        <span className="l1">{p.title}</span>
        <span className="l2">
          {t("prs.line", { repo: row.repo, n: p.number, author: p.author || "?", age: ago(p.updated || p.created, now) })}
          {" · "}
          <span className="prs-ck" data-tone={checks.tone} data-testid="prs-checks">
            {checks.text}
          </span>
          {review && (
            <>
              {" · "}
              <span data-testid="prs-review">{review}</span>
            </>
          )}
          {lane && (
            <>
              {" · "}
              <span data-testid="prs-lane">{t("prs.lane")}</span>
            </>
          )}
          {chat !== null && (
            <>
              {" · "}
              <span data-testid="prs-chat">{t("prs.chat", { title: chat })}</span>
            </>
          )}
        </span>
      </span>
    </button>
  );
}

/** A request on Azure DevOps, Gitea or Forgejo (item 100b): read only, so the row opens nothing in the app and offers no Merge. It
 *  names the request as a row does, its host, and Open on <host>. */
function OtherRowView({ row, onOpenUrl, now }: { row: OtherRow; onOpenUrl: (url: string) => void; now?: number }) {
  const p = row.pull;
  const review = reviewWord(p);
  return (
    <div className="rowl prs-row prs-other" data-testid="prs-other-row" data-host={row.host} data-pull={`${row.repo}#${p.number}`} data-readiness={readiness(p)}>
      <span className="prs-mark">
        <PrIcon state={p.state === "draft" ? "draft" : "open"} size={14} />
      </span>
      <span className="grow">
        <span className="l1">{p.title}</span>
        <span className="l2">
          {t("prs.line", { repo: row.repo, n: p.number, author: p.author || "?", age: ago(p.updated || p.created, now) })}
          {" · "}
          <span data-testid="prs-other-host">{row.name}</span>
          {review && (
            <>
              {" · "}
              <span data-testid="prs-review">{review}</span>
            </>
          )}
        </span>
      </span>
      <button type="button" className="lk" disabled={!p.url} onClick={() => onOpenUrl(p.url)} title={t("prs.otherTip", { host: row.name })} data-testid="prs-other-open">
        {t("prs.openOn", { host: row.name })}
      </button>
    </div>
  );
}

export interface PullDetailViewProps {
  row: BoardRow;
  detail: PullDetail | null;
  error: string | null;
  /** What the merge part draws (PullMerge), so a test can draw the detail alone. */
  merge?: ReactNode;
  /** The chat that opened the request itself, and what opens it. */
  chat?: string | null;
  onOpenChat?: () => void;
  onClose: () => void;
  onOpenUrl: (url: string) => void;
}

export function PullDetailView({ row, detail, error, merge, chat = null, onOpenChat, onClose, onOpenUrl }: PullDetailViewProps) {
  const p = detail?.pull ?? row.pull;
  const host = SOURCE_NAME[row.source];
  const shown = detail?.files ?? [];
  const changed = detail?.changed ?? null;
  const more = changed !== null && changed > shown.length && shown.length > 0 ? changed - shown.length : 0;
  return (
    <aside className="prs-detail" aria-label={t("prs.detail", { n: p.number })} data-testid="prs-detail" data-pull={rowKey(row)}>
      <div className="prs-dh">
        <PrIcon state={p.state === "draft" ? "draft" : "open"} size={14} />
        <span className="prs-dh-n">
          {row.repo} #{p.number}
        </span>
        <span className="grow" />
        <IconButton label={t("prs.close")} onClick={onClose}>
          <CloseIcon />
        </IconButton>
      </div>
      <h2 className="prs-title" data-testid="prs-detail-title">
        {p.title}
      </h2>
      <p className="l2 prs-sub">
        <span className="mono">{t("prs.into", { branch: p.head ?? "", base: p.base })}</span>
        {" · "}
        {p.author}
        {" · "}
        <span className="prs-ck" data-tone={checksWord(p).tone}>
          {checksWord(p).text}
        </span>
        {reviewWord(p) && ` · ${reviewWord(p)}`}
      </p>
      {chat !== null && (
        <p className="l2 prs-sub">
          <button type="button" className="lk" onClick={onOpenChat} data-testid="prs-open-chat">
            {t("prs.openChat", { title: chat })}
          </button>
        </p>
      )}
      <div className="prs-acts">
        {p.same === false ? (
          <p className="l2" data-testid="prs-fork">
            {p.from ? t("prs.fork", { from: p.from, host }) : t("prs.forkNoName", { host })}
          </p>
        ) : (
          merge
        )}
        <button type="button" className="btn" disabled={!p.url} onClick={() => onOpenUrl(p.url)} data-testid="prs-open-host">
          {t("prs.openOn", { host })}
        </button>
      </div>
      <div className="prs-body">
        {error ? (
          <p className="prs-err" role="alert">
            {t("prs.failed", { repo: row.repo, error })}
          </p>
        ) : !detail ? (
          <Spinner />
        ) : (
          <>
            <section className="prs-sec" data-testid="prs-detail-body">
              {detail.body.trim() ? <pre className="prs-text">{detail.body}</pre> : <p className="l2">{t("prs.noBody")}</p>}
            </section>
            {detail.checks.length > 0 && (
              <section className="prs-sec" data-testid="prs-detail-checks">
                <div className="band">{t("prs.checks")}</div>
                {detail.checks.map((c, n) => (
                  <div key={`${c.name}-${n}`} className="prs-check" data-state={c.state}>
                    <span className="grow">{c.name}</span>
                    <span className="l2">{t(`tasks.ck.${c.state}` as Key)}</span>
                  </div>
                ))}
              </section>
            )}
            {(shown.length > 0 || changed !== null) && (
              <section className="prs-sec" data-testid="prs-detail-files">
                <div className="band">
                  <span>{t("prs.files")}</span>
                  <span className="prs-count" data-testid="prs-counts">
                    {detail.additions !== null && detail.deletions !== null ? t("prs.counts", { files: changed ?? shown.length, add: detail.additions, del: detail.deletions }) : t("prs.countsFiles", { files: changed ?? shown.length })}
                  </span>
                </div>
                {shown.map((f) => (
                  <div key={f.path} className="prs-file">
                    <span className="grow mono">{f.path}</span>
                    <span className="prs-add">{`+${f.additions}`}</span>
                    <span className="prs-del">{`-${f.deletions}`}</span>
                  </div>
                ))}
                {more > 0 && <p className="l2">{t("prs.moreFiles", { n: more, host })}</p>}
              </section>
            )}
          </>
        )}
      </div>
    </aside>
  );
}

/** A request opened in the app: its detail and its methods read from `host`, its Merge asked through `merge`. */
function PullDetailPane({ host, merge, row, worktree, chat, onClose, onMerged }: { host: TaskHost; merge: MergeHost; row: BoardRow; worktree: string | null; chat: { id: string; title: string } | null; onClose: () => void; onMerged: () => void }) {
  const [detail, setDetail] = useState<PullDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [methods, setMethods] = useState<MergeMethods | null>(null);
  const key = rowKey(row);
  useEffect(() => {
    let live = true;
    setDetail(null);
    setError(null);
    host.pullView?.(row.source, row.repo, row.pull.number).then(
      (d) => live && setDetail(d),
      (e) => live && setError(e instanceof Error ? e.message : String(e)),
    );
    host.methods?.(row.source, row.repo).then(
      (m) => live && setMethods(m),
      () => live && setMethods(null),
    );
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [host, key]);
  return (
    <PullDetailView
      row={row}
      detail={detail}
      error={error}
      merge={<PullMerge host={merge} row={row} worktree={worktree} methods={methodsOf(methods)} onMerged={onMerged} />}
      chat={chat?.title ?? null}
      onOpenChat={() => chat && getStore().actions.openSession(chat.id)}
      onClose={onClose}
      onOpenUrl={(url) => void openExternal(url).catch(() => undefined)}
    />
  );
}

export function PullsView({ host, merge }: { host: TaskHost; merge: MergeHost }) {
  const ss = useSessions();
  const prefs = useFolderPrefs();
  const lanesMadeIn = useLaneProjects();
  const projects = codeProjects(
    ss.list.map((r) => r.cwd).filter(Boolean),
    addedFolders(prefs),
    lanesMadeIn,
  );
  const projectsKey = projects.join("\n");
  const watch = useMemo(() => new BoardWatch(host, () => typeof document === "undefined" || document.visibilityState !== "hidden"), [host]);
  const state = useSyncExternalStore(watch.subscribe, watch.get, watch.get);
  const tk = useTasks();
  const [sel, setSel] = useState<string | null>(null);

  useEffect(() => {
    void watch.setProjects(projectsKey ? projectsKey.split("\n") : []);
  }, [watch, projectsKey]);
  // at most once a minute while shown, and never while the window is hidden (board.ts `due`)
  useEffect(() => {
    const timer = setInterval(() => void watch.tick(), REFRESH_MS);
    const back = () => void watch.tick();
    document.addEventListener("visibilitychange", back);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", back);
    };
  }, [watch]);
  // a chat's header or a lane's row asked for this request: it opens once the list has it
  useEffect(() => {
    if (!tk.pick || state.at === null) return;
    const hit = rowOf(state.rows, tk.pick.source, tk.pick.repo, tk.pick.number);
    if (hit) setSel(rowKey(hit));
    clearPick();
  }, [tk.pick, state.rows, state.at]);

  // a request is a lane's when a lane of the app's, in a folder of the same repository, works on its branch (its own repository's)
  const lanes = new Map<string, string>();
  for (const rec of ss.list) {
    const repo = state.folders[pathKey(rec.cwd)];
    if (repo && rec.lane?.name && rec.lane.worktree) lanes.set(`${repo}\n${rec.lane.name}`, rec.lane.worktree);
  }
  // the chats that opened a request themselves (code/chatPull.ts), by their key
  useChatPullsVersion();
  const chats = new Map<string, { id: string; title: string }>();
  for (const rec of ss.list) {
    const key = getSessions().chatKey(rec.id);
    if (key) chats.set(key, { id: rec.id, title: pickTitle(rec, folderName(rec.cwd)).title });
  }
  const chatOf = (row: BoardRow) => {
    const key = chatOfPull(row.source, row.repo, row.pull.number);
    return key ? (chats.get(key) ?? null) : null;
  };
  const laneOf = (row: BoardRow): string | null => (row.pull.same === true && row.pull.head ? (lanes.get(`${repoKey(row.source, row.repo)}\n${row.pull.head}`) ?? null) : null);
  const open = sel ? state.rows.find((r) => rowKey(r) === sel) : undefined;
  return (
    <div className={`prs${open ? " has-detail" : ""}`} data-testid="prs">
      <div className="prs-main" role="region" aria-label={t("prs.list")} data-testid="prs-list" aria-busy={state.loading}>
        <PullsListView
          state={state}
          noProjects={projects.length === 0}
          selected={open ? sel : null}
          isLane={(r) => laneOf(r) !== null}
          chatOf={(r) => chatOf(r)?.title ?? null}
          onOpen={(r) => setSel(rowKey(r))}
          onOpenUrl={(url) => void openExternal(url).catch(() => undefined)}
          onRetry={() => void watch.read()}
        />
      </div>
      {open && <PullDetailPane host={host} merge={merge} row={open} worktree={laneOf(open)} chat={chatOf(open)} onClose={() => setSel(null)} onMerged={() => void watch.read()} />}
    </div>
  );
}

