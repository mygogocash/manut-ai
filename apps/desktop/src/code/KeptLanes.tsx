// Kit's folders kept on this computer, under the lanes on the Code page. Each lane works in a folder of its own (a git worktree
// under `~/.manut/lanes`, src-tauri/src/lane.rs). When its session closes the folder goes with it if nothing in it would be lost;
// a folder with changed or new files is kept instead, and listed here for its project with Show folder and Remove.
//
// Remove asks first, in a panel under the row: how many changed files go with the folder, and, when the person also ticks the
// branch, how many of its commits are on no other branch. The press is the person's yes to exactly those numbers: the shell
// does nothing if what is there differs from what was shown, and the panel then shows the new numbers. The branch stays unless
// it is ticked. `KeptLanesView` takes everything it shows as props and uses no hooks, so a test can draw it; `KeptLanes` reads
// the shell and the sessions.
import "./kit.css";
import { useCallback, useEffect, useRef, useState } from "react";
import { t, type Key } from "../i18n";
import { getHost } from "../sessions/host";
import { useSessions } from "../sessions/sessions";
import { keptLanesChanged, useKeptLanesVersion } from "./laneStore";
import { cleanupDue, lastCleanup, markCleanup, worktreeSettings } from "../lib/worktrees";
import type { KeptLane, LaneRemoveAsk } from "./laneBranch";

/** How often the kept folders are read again while the page stays open: what is in a folder changes only by hand. */
export const KEPT_POLL_MS = 60_000;

/** The Remove panel of one kept folder: the numbers the person sees (read again when the shell said they changed), whether
 *  the branch goes too, a press on its way, and what went wrong. */
export interface KeptOpen {
  worktree: string;
  changed: number;
  ahead: number | null;
  branch: boolean;
  busy: boolean;
  /** `changed`: what is there differs from what was shown, so nothing was done and the numbers are new. */
  why: "changed" | "failed" | null;
  error?: string;
}

export interface KeptLanesProps {
  rows: KeptLane[];
  home: string | null;
  open: KeptOpen | null;
  /** A line under the band after a removal that left the branch: git's words. */
  notice: string | null;
  /** Why a clean-up left a folder, by branch (a code from the shell), and why it could not tell at all. */
  why?: Record<string, string>;
  cannot?: string | null;
  onShow: (lane: KeptLane) => void;
  onRemove: (lane: KeptLane) => void;
  onBranch: (on: boolean) => void;
  onConfirm: () => void;
  onCancel: () => void;
}

/** A folder as the developer reads it: `~` for the home folder. */
const tilde = (path: string, home: string | null) => (home && (path === home || path.startsWith(`${home}/`)) ? `~${path.slice(home.length)}` : path);

/** What a kept folder holds, in a line. */
function heldLine(k: KeptLane): string {
  if (!k.exists) return t("lane.kept.gone");
  if (k.changed === null) return t("lane.kept.unread");
  if (k.changed === 0) return t("lane.kept.clean");
  return k.changed === 1 ? t("lane.kept.changedOne") : t("lane.kept.changedMany", { n: k.changed });
}

/** What goes with the branch, in a line. */
function aheadLine(ahead: number | null, base: string): string {
  if (ahead === null) return t("lane.kept.aheadUnknown", { base });
  if (ahead === 0) return t("lane.kept.aheadNone", { base });
  return ahead === 1 ? t("lane.kept.aheadOne", { base }) : t("lane.kept.aheadMany", { n: ahead, base });
}

/** The first few of a folder's ignored files, as the line names them. */
const fewFiles = (files: readonly string[]) => (files.length > 5 ? [...files.slice(0, 5), "…"] : files).join(", ");

/** What a kept folder says of the clean-up: the reason it left it, that its branch has commits on no remote, or that it holds
 *  files git ignores that may be the developer's (a `.env.local`, a local database), which a clean-up never takes unasked. */
function cleanLine(k: KeptLane, why: string | undefined): string | null {
  const ignored = k.exists && k.ignored?.length ? t("lane.kept.ignored", { files: fewFiles(k.ignored) }) : null;
  if (why === "ignored" && ignored) return ignored;
  if (why && why !== "open") return t(`lane.kept.why.${why}` as Key);
  if (k.exists && k.changed === 0 && k.unpushed) return k.unpushed === 1 ? t("lane.kept.unpushedOne") : t("lane.kept.unpushedMany", { n: k.unpushed });
  if (k.changed === 0 && ignored) return ignored;
  if (why === "open") return t("lane.kept.why.open");
  return null;
}

export function KeptLanesView(p: KeptLanesProps) {
  if (p.rows.length === 0 && !p.notice && !p.cannot) return null;
  return (
    <>
      <div className="band">
        <span>{t("lane.kept.title")}</span>
      </div>
      {p.notice && (
        <p className="mut lline" role="status" data-testid="kept-notice">
          {p.notice}
        </p>
      )}
      {p.cannot && (
        <p className="mut lline" role="status" data-testid="kept-cannot">
          {t(`lane.kept.cannot.${p.cannot}` as Key)}
        </p>
      )}
      {p.rows.map((k) => {
        const clean = cleanLine(k, p.why?.[k.branch]);
        const open = p.open?.worktree === k.worktree ? p.open : null;
        return (
          <div key={k.worktree} className="lane kept" data-testid="kept-lane">
            <div className="rowl">
              <span className="tag mono" title={tilde(k.worktree, p.home)}>
                {k.branch}
              </span>
              <span className="grow mut" data-testid="kept-line">
                {heldLine(k)}
              </span>
              {k.exists && (
                <button type="button" className="lk" onClick={() => p.onShow(k)} data-testid="kept-show">
                  {t("lane.kept.show")}
                </button>
              )}
              <button type="button" className="lk" aria-expanded={!!open} onClick={() => (open ? p.onCancel() : p.onRemove(k))} data-testid="kept-remove">
                {t("lane.kept.remove")}
              </button>
            </div>
            {clean && (
              <p className="mut lline" data-testid="kept-clean">
                {clean}
              </p>
            )}
            {open && (
              <div className="banner warn kept-confirm" role="group" aria-label={t("lane.kept.confirm", { branch: k.branch })} data-testid="kept-confirm">
                <p>{t("lane.kept.confirm", { branch: k.branch })}</p>
                <p className="mono mut">{tilde(k.worktree, p.home)}</p>
                {open.changed > 0 && (
                  <p data-testid="kept-lose">{open.changed === 1 ? t("lane.kept.loseOne") : t("lane.kept.loseMany", { n: open.changed })}</p>
                )}
                {!!k.ignored?.length && <p data-testid="kept-lose-ignored">{t("lane.kept.loseIgnored", { files: fewFiles(k.ignored) })}</p>}
                <label className="kept-tick">
                  <input type="checkbox" checked={open.branch} onChange={(e) => p.onBranch(e.currentTarget.checked)} data-testid="kept-branch" />{" "}
                  {t("lane.kept.branchToo", { branch: k.branch })}
                </label>
                <p className={open.branch && open.ahead !== 0 ? "" : "mut"} data-testid="kept-ahead">
                  {open.branch ? aheadLine(open.ahead, k.base) : t("lane.kept.branchStays")}
                </p>
                {open.why === "changed" && (
                  <p role="alert" data-testid="kept-changed">
                    {t("lane.kept.changedSince")}
                  </p>
                )}
                {open.why === "failed" && (
                  <p role="alert" data-testid="kept-failed">
                    {t("lane.kept.failed", { error: open.error ?? "" })}
                  </p>
                )}
                <div className="chips">
                  <button type="button" className="btn dark" disabled={open.busy} onClick={p.onConfirm} data-testid="kept-confirm-remove">
                    {t("lane.kept.doRemove")}
                  </button>
                  <button type="button" className="btn" onClick={p.onCancel}>
                    {t("lane.kept.cancel")}
                  </button>
                </div>
              </div>
            )}
          </div>
        );
      })}
    </>
  );
}

/** The developer's folders the app's lanes were made from (the shell's records): the Code page lists these projects too, so a
 *  folder kept after its project's last session closed is never out of sight. Read when the page opens, when a folder was kept
 *  or removed, and when the window is looked at again. */
export function useLaneProjects(): string[] {
  const version = useKeptLanesVersion();
  const [got, setGot] = useState<string[]>([]);
  useEffect(() => {
    const host = getHost();
    if (!host.laneProjects) return;
    let live = true;
    const read = () =>
      void host.laneProjects!().then(
        (p) => live && setGot((was) => (was.join("\n") === p.join("\n") ? was : p)),
        () => undefined,
      );
    read();
    window.addEventListener("focus", read);
    return () => {
      live = false;
      window.removeEventListener("focus", read);
    };
  }, [version]);
  return got;
}

/** The ask the press sends: the numbers the person saw. */
export const askOf = (open: KeptOpen): LaneRemoveAsk => ({ changed: open.changed, branch: open.branch, ahead: open.ahead });

/** Kit's folders kept for project `root`: the lanes' folders the shell made for its repository that no listed session holds. */
export function KeptLanes({ root }: { root: string }) {
  const ss = useSessions();
  const version = useKeptLanesVersion();
  const [rows, setRows] = useState<KeptLane[]>([]);
  const [open, setOpen] = useState<KeptOpen | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [why, setWhy] = useState<Record<string, string>>({});
  const [cannot, setCannot] = useState<string | null>(null);

  // another project: nothing of the last one's stays on the page
  useEffect(() => {
    setRows([]);
    setOpen(null);
    setNotice(null);
    setWhy({});
    setCannot(null);
  }, [root]);
  // Settings › Worktrees: remove the folders of lanes whose pull request merged. Asked when the project opens and when the
  // window is looked at again, never on a timer, and at most once an hour for a project; the shell removes nothing with work
  // of its own in it and names every folder it left. `held` are the folders a session still works in.
  const heldNow = ss.list.map((r) => r.lane?.worktree).filter((w): w is string => !!w);
  const heldRef = useRef(heldNow);
  heldRef.current = heldNow;
  useEffect(() => {
    const host = getHost();
    if (!host.laneCleanMerged || !root) return;
    let live = true;
    const run = () => {
      if (!worktreeSettings().cleanMerged || !cleanupDue(Date.now(), lastCleanup(root))) return;
      markCleanup(root, Date.now());
      void host.laneCleanMerged!(root, heldRef.current).then(
        (got) => {
          if (!live) return;
          setCannot(got.cannot);
          setWhy(Object.fromEntries(got.kept.map((k) => [k.branch, k.why])));
          if (got.removed.length > 0) {
            setNotice(got.removed.length === 1 ? t("lane.kept.cleanedOne") : t("lane.kept.cleanedMany", { n: got.removed.length }));
            keptLanesChanged();
          }
        },
        () => undefined,
      );
    };
    run();
    window.addEventListener("focus", run);
    return () => {
      live = false;
      window.removeEventListener("focus", run);
    };
  }, [root]);
  // read when the project opens, when a folder was kept or removed, when the window is looked at again, and once a minute; a
  // read keeps what was said after a removal (the branch that stayed) until the project changes
  useEffect(() => {
    const host = getHost();
    if (!host.laneList || !root) return;
    let live = true;
    const read = () =>
      void host.laneList!(root).then(
        (got) => live && setRows(got),
        () => undefined,
      );
    read();
    const timer = setInterval(read, KEPT_POLL_MS);
    window.addEventListener("focus", read);
    return () => {
      live = false;
      clearInterval(timer);
      window.removeEventListener("focus", read);
    };
  }, [root, version]);

  // a folder a listed session holds is that lane's own, not kept
  const held = new Set(ss.list.map((r) => r.lane?.worktree).filter((w): w is string => !!w));
  const kept = rows.filter((k) => !held.has(k.worktree));

  const confirm = useCallback(async () => {
    const host = getHost();
    if (!open || open.busy || !host.laneRemove) return;
    setOpen({ ...open, busy: true, why: null });
    try {
      const got = await host.laneRemove(open.worktree, askOf(open));
      if (!got.removed) {
        // what is there is not what the person saw: nothing was done, and the panel shows the numbers there are now
        setOpen({ ...open, busy: false, why: "changed", changed: got.changed ?? open.changed, ahead: open.branch ? got.ahead : open.ahead });
        return;
      }
      setOpen(null);
      setNotice(open.branch && !got.deleted ? t("lane.kept.branchFailed", { error: got.error ?? "" }) : null);
      keptLanesChanged();
    } catch (e) {
      setOpen({ ...open, busy: false, why: "failed", error: e instanceof Error ? e.message : String(e) });
    }
  }, [open]);

  return (
    <KeptLanesView
      rows={kept}
      home={ss.home}
      open={open}
      notice={notice}
      why={why}
      cannot={cannot}
      onShow={(k) => void getHost().reveal(k.worktree).catch(() => undefined)}
      onRemove={(k) => setOpen({ worktree: k.worktree, changed: k.exists ? (k.changed ?? 0) : 0, ahead: k.ahead, branch: false, busy: false, why: null })}
      onBranch={(on) => open && setOpen({ ...open, branch: on, why: null })}
      onConfirm={() => void confirm()}
      onCancel={() => setOpen(null)}
    />
  );
}
