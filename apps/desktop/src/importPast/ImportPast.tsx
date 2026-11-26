// Bring over (item 101e): the offer of the person's own Claude Code and Codex work, as a dialog over the app. It opens by itself once,
// on the first launch after the first-run setup, when the shell's look found a folder that is not a project here yet, and by hand
// from History's Bring over… at any time after. Its steps: what was found, each folder with its conversations and nothing picked
// (one short line says that nothing of the agents' files is copied, moved or changed and nothing leaves this Mac); the
// confirmation of the picks; and what was brought over, with a way to History, where their conversations now are. Nothing is
// added before the confirmation's Bring over. offer.ts holds the rules; this file draws them and does the one write, to this
// computer's own lists.
//
// Keyboard: as the update confirm (sidebar/UpdateConfirm.tsx), the focus starts in the dialog and stays inside it, and Esc
// closes it, which counts as the offer made.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import "./importPast.css";
import { t, type Key } from "../i18n";
import { errText } from "../lib/errText";
import { getStore } from "../state/store";
import { AgentIcon, Spinner } from "../ui";
import { PROVIDER_NAME } from "../sidebar/usageFormat";
import { SESSIONS_ENTRY } from "../sessions/entry";
import { folderName, isTerminalRec, tildePath } from "../sessions/agents";
import { addedFolders, folderGroups, getFolderPrefs, setFolderGone, setFolderPrefs } from "../sessions/folders";
import { getHost, type SessionHost } from "../sessions/host";
import { getSessions, useSessions } from "../sessions/sessions";
import { ageOf } from "../sessions/SessionsSection";
import {
  bringOver,
  closeImport,
  getImportRecord,
  hasNew,
  importReduce,
  markOffered,
  offerRows,
  openImport,
  pickedConversations,
  setImportRecord,
  shouldLook,
  skipParts,
  useImportOpen,
  type ImportEvent,
  type ImportOpen,
  type ImportSkipped,
  type ImportStep,
  type OfferRow,
  type SkipPart,
} from "./offer";

/** Whether this app can look for work to bring over: the desktop shell with its coding sessions. */
export function canImport(host: Pick<SessionHost, "importScan"> = getHost()): boolean {
  return SESSIONS_ENTRY && typeof host.importScan === "function";
}

/** The Code page's folders now: those its sessions run in and those added to it (what `listFolder` counts as listed). */
export function listedFolders(): string[] {
  const now = getSessions().getState();
  return [...folderGroups(now.list.filter((r) => isTerminalRec(now.agents, r))).map((g) => g.cwd), ...addedFolders(getFolderPrefs())];
}

/** The first launch's look: once the first-run setup is out of the way, look once; open the offer when a folder that is not a
 *  project yet was found (`open`), and count the offer as made when nothing new was (`none`; a later Bring over… still looks).
 *  A failed look (`failed`) is tried again on the next launch. `skip`: no look, as `shouldLook` says. `live` is asked once the
 *  look answers: a launch that is gone by then opens nothing. */
export async function offerOnLaunch(
  host: Pick<SessionHost, "importScan">,
  firstRun: boolean,
  listed: () => string[] = listedFolders,
  live: () => boolean = () => true,
): Promise<"skip" | "open" | "none" | "failed"> {
  if (!shouldLook(getImportRecord(), { can: canImport(host), firstRun }) || !host.importScan) return "skip";
  let found;
  try {
    found = await host.importScan();
  } catch {
    return "failed";
  }
  if (!live()) return "skip";
  if (hasNew(offerRows(found, listed()))) {
    openImport(found);
    return "open";
  }
  markOffered();
  return "none";
}

/** `offerOnLaunch` on the app, once the first-run setup is out of the way. */
export function useImportOffer(firstRun: boolean, host: Pick<SessionHost, "importScan"> = getHost()): void {
  useEffect(() => {
    let live = true;
    void offerOnLaunch(host, firstRun, listedFolders, () => live);
    return () => {
      live = false;
    };
  }, [firstRun, host]);
}

const SKIP_WORDS: Record<SkipPart, [Key, Key]> = {
  gone: ["imp.skip.gone1", "imp.skip.goneN"],
  compressed: ["imp.skip.compressed1", "imp.skip.compressedN"],
  unreadable: ["imp.skip.unreadable1", "imp.skip.unreadableN"],
  over_limit: ["imp.skip.over1", "imp.skip.overN"],
};

/** "Skipped: 2 folders no longer on this Mac, 1 file that could not be read." or "" when nothing was. */
export function skippedLine(s: ImportSkipped): string {
  const parts = skipParts(s).map(({ part, n }) => (n === 1 ? t(SKIP_WORDS[part][0]) : t(SKIP_WORDS[part][1], { n })));
  return parts.length ? t("imp.skipped", { list: parts.join(", ") }) : "";
}

const one = (n: number, k1: Key, kn: Key) => (n === 1 ? t(k1) : t(kn, { n }));

const FOCUSABLE = "button:not([disabled]), [href], input:not([disabled]), [tabindex]:not([tabindex='-1'])";

/** One found folder: its name, where it is, how many conversations of each agent, and how long ago the newest changed. */
function FolderLine({ r, home, nowMs }: { r: OfferRow; home: string | null; nowMs: number }) {
  return (
    <>
      <span className="imp-name">
        <span className="imp-n1">{folderName(r.cwd)}</span>
        <span className="imp-n2">{tildePath(r.cwd, home)}</span>
      </span>
      <span className="imp-count">
        {(["claude", "codex"] as const).map((a) =>
          r[a] > 0 ? (
            <span key={a} className="imp-agent" title={t("imp.agentN", { agent: PROVIDER_NAME[a], n: r[a] })}>
              <AgentIcon id={a} title={PROVIDER_NAME[a]} size={14} />
              {r[a]}
            </span>
          ) : null,
        )}
        <span className="imp-total">{one(r.total, "imp.conv1", "imp.convN")}</span>
      </span>
      <span className="imp-when">{ageOf(r.at, nowMs)}</span>
    </>
  );
}

export interface ImportViewProps {
  step: ImportStep;
  home: string | null;
  nowMs?: number;
  onEvent: (e: ImportEvent) => void;
  /** Not now, Close, Done, Esc: the offer is made either way */
  onClose: () => void;
  /** the confirmation's Bring over */
  onBring: () => void;
  onHistory: () => void;
}

/** What each step draws: its title, its words and its buttons. Pure, so a test reads each step's buttons and presses them. */
export function importParts({ step, home, nowMs = Date.now(), onEvent, onClose, onBring, onHistory }: ImportViewProps): { title: string; body: ReactNode; foot: ReactNode } {
  const promise = (
    <p className="imp-promise" data-testid="imp-promise">
      {t("imp.promise")}
    </p>
  );
  let title: string = t("imp.title");
  let body: ReactNode = null;
  let foot: ReactNode = null;
  if (step.at === "looking") {
    body = (
      <p className="imp-note imp-looking" data-testid="imp-looking">
        <Spinner size={12} label={t("imp.looking")} />
        {t("imp.looking")}
      </p>
    );
    foot = (
      <button type="button" className="imp-btn" onClick={onClose} data-autofocus data-testid="imp-close">
        {t("imp.close")}
      </button>
    );
  } else if (step.at === "failed") {
    body = (
      <p className="imp-note" role="status" data-testid="imp-failed">
        {t("imp.failed", { error: step.why })}
      </p>
    );
    foot = (
      <button type="button" className="imp-btn" onClick={onClose} data-autofocus data-testid="imp-close">
        {t("imp.close")}
      </button>
    );
  } else if (step.at === "pick") {
    const fresh = step.rows.filter((r) => !r.here);
    const skipped = skippedLine(step.skipped);
    const all = fresh.length > 0 && fresh.every((r) => step.picked.includes(r.cwd));
    body = fresh.length ? (
      <>
        <p className="imp-lead">{t("imp.lead")}</p>
        {promise}
        <div className="imp-bar">
          <span data-testid="imp-found">{one(step.rows.length, "imp.found1", "imp.foundN")}</span>
          <button type="button" className="imp-lk" onClick={() => onEvent({ type: "all", on: !all })} data-testid="imp-all">
            {all ? t("imp.clear") : t("imp.all")}
          </button>
        </div>
        <ul className="imp-list" aria-label={t("imp.list")} data-testid="imp-list">
          {step.rows.map((r) => (
            <li key={r.cwd} className={r.here ? "imp-li here" : "imp-li"} data-testid="imp-row" data-cwd={r.cwd} data-here={r.here || undefined}>
              {r.here ? (
                <div className="imp-row">
                  <span className="imp-box" aria-hidden="true" />
                  <FolderLine r={r} home={home} nowMs={nowMs} />
                  <span className="imp-tag" data-testid="imp-here">
                    {t("imp.here")}
                  </span>
                </div>
              ) : (
                <label className="imp-row">
                  <input
                    type="checkbox"
                    className="imp-box"
                    checked={step.picked.includes(r.cwd)}
                    onChange={() => onEvent({ type: "toggle", cwd: r.cwd })}
                    data-testid="imp-pick"
                  />
                  <FolderLine r={r} home={home} nowMs={nowMs} />
                </label>
              )}
            </li>
          ))}
        </ul>
        {skipped && (
          <p className="imp-note" data-testid="imp-skipped">
            {skipped}
          </p>
        )}
      </>
    ) : (
      <>
        <p className="imp-note" data-testid="imp-nothing">
          {step.rows.length ? t("imp.nothing") : t("imp.none")}
        </p>
        {skipped && (
          <p className="imp-note" data-testid="imp-skipped">
            {skipped}
          </p>
        )}
      </>
    );
    foot = fresh.length ? (
      <>
        <button type="button" className="imp-btn" onClick={onClose} data-testid="imp-not-now">
          {t("imp.notNow")}
        </button>
        <button
          type="button"
          className="imp-btn primary"
          disabled={!step.picked.length}
          onClick={() => onEvent({ type: "next" })}
          data-autofocus={step.picked.length ? true : undefined}
          data-testid="imp-next"
        >
          {step.picked.length ? one(step.picked.length, "imp.next1", "imp.nextN") : t("imp.pick")}
        </button>
      </>
    ) : (
      <button type="button" className="imp-btn" onClick={onClose} data-autofocus data-testid="imp-close">
        {t("imp.close")}
      </button>
    );
  } else if (step.at === "confirm") {
    const picked = step.rows.filter((r) => step.picked.includes(r.cwd));
    title = one(picked.length, "imp.confirm1", "imp.confirmN");
    body = (
      <>
        <ul className="imp-list compact" data-testid="imp-picked">
          {picked.map((r) => (
            <li key={r.cwd} className="imp-li" data-cwd={r.cwd}>
              <div className="imp-row">
                <FolderLine r={r} home={home} nowMs={nowMs} />
              </div>
            </li>
          ))}
        </ul>
        <p className="imp-lead">{t("imp.confirmBody")}</p>
        {promise}
      </>
    );
    foot = (
      <>
        <button type="button" className="imp-btn" onClick={() => onEvent({ type: "back" })} data-testid="imp-back">
          {t("imp.back")}
        </button>
        <button type="button" className="imp-btn primary" onClick={onBring} data-autofocus data-testid="imp-go">
          {t("imp.go")}
        </button>
      </>
    );
  } else {
    const n = step.brought.length;
    title = one(n, "imp.done1", "imp.doneN");
    body = (
      <>
        <ul className="imp-list compact" data-testid="imp-brought">
          {step.brought.map((cwd) => (
            <li key={cwd} className="imp-li" data-cwd={cwd}>
              <div className="imp-row">
                <span className="imp-name">
                  <span className="imp-n1">{folderName(cwd)}</span>
                  <span className="imp-n2">{tildePath(cwd, home)}</span>
                </span>
              </div>
            </li>
          ))}
        </ul>
        <p className="imp-lead" data-testid="imp-done-body">
          {n === 1 ? t("imp.doneBody1") : t("imp.doneBodyN")}
        </p>
      </>
    );
    foot = (
      <>
        <button type="button" className="imp-btn" onClick={onClose} data-testid="imp-ok">
          {t("imp.ok")}
        </button>
        <button type="button" className="imp-btn primary" onClick={onHistory} data-autofocus data-testid="imp-history">
          {t("imp.openHistory")}
        </button>
      </>
    );
  }
  return { title, body, foot };
}

export function ImportPastView({ step, home, nowMs = Date.now(), onEvent, onClose, onBring, onHistory }: ImportViewProps) {
  const box = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  // a new step takes the focus to its first control, so a screen reader reads where the person is and Tab starts at the top
  useEffect(() => {
    box.current?.querySelector<HTMLElement>("[data-autofocus]")?.focus();
  }, [step.at]);
  useEffect(() => {
    const onFocus = (e: FocusEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) box.current.querySelector<HTMLElement>(FOCUSABLE)?.focus();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        close.current();
        return;
      }
      if (e.key !== "Tab" || !box.current) return;
      const els = [...box.current.querySelectorAll<HTMLElement>(FOCUSABLE)];
      if (!els.length) return;
      const [first, last] = [els[0], els[els.length - 1]];
      const at = document.activeElement;
      const inside = !!at && box.current.contains(at);
      if (e.shiftKey && (at === first || !inside)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (at === last || !inside)) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("focusin", onFocus);
    // capture: ahead of the app's own Esc and any popover under the veil
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("focusin", onFocus);
      document.removeEventListener("keydown", onKey, true);
    };
  }, []);

  const { title, body, foot } = importParts({ step, home, nowMs, onEvent, onClose, onBring, onHistory });
  return (
    <div className="imp-veil" data-testid="imp-veil" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={box} className="imp-dlg" role="dialog" aria-modal="true" aria-labelledby="imp-t" data-testid="imp-dialog" data-step={step.at}>
        <h2 id="imp-t" className="imp-t" tabIndex={-1} data-autofocus={step.at === "pick" ? true : undefined}>
          {title}
        </h2>
        <div className="imp-b">{body}</div>
        <div className="imp-f">{foot}</div>
      </div>
    </div>
  );
}

/** The offer on the app: drawn while it is open (`openImport`), over whatever shows. */
export function ImportPast() {
  const open = useImportOpen();
  if (!open) return null;
  return <ImportPastDialog key={open.seq} open={open} />;
}

function ImportPastDialog({ open }: { open: ImportOpen }) {
  const host = getHost();
  // the home folder, to write paths under it with `~`, as the Code page does; asked of the shell when the sessions do not know it yet
  const known = useSessions().home;
  const [asked, setAsked] = useState<string | null>(null);
  const home = known ?? asked;
  useEffect(() => {
    if (known) return;
    let live = true;
    host.home().then(
      (h) => live && setAsked(h),
      () => undefined,
    );
    return () => {
      live = false;
    };
    // once per opening
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [step, setStep] = useState<ImportStep>(() => (open.found ? importReduce({ at: "looking" }, { type: "found", found: open.found, listed: listedFolders() }) : { at: "looking" }));
  const send = (e: ImportEvent) => setStep((s) => importReduce(s, e));
  useEffect(() => {
    if (open.found) return;
    if (!host.importScan) {
      send({ type: "failed", why: "unsupported" });
      return;
    }
    let live = true;
    host.importScan().then(
      (found) => live && send({ type: "found", found, listed: listedFolders() }),
      (e: unknown) => live && send({ type: "failed", why: errText(e) }),
    );
    return () => {
      live = false;
    };
    // one look per opening
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const close = () => {
    markOffered();
    closeImport();
  };
  const bring = () => {
    if (step.at !== "confirm") return;
    // the one write: this computer's own project list and this record; the agents' files are not touched
    const { rec, prefs } = bringOver(getImportRecord(), getFolderPrefs(), step.picked, listedFolders());
    setFolderPrefs(prefs);
    for (const cwd of step.picked) setFolderGone(cwd, false);
    setImportRecord(rec);
    send({ type: "brought", brought: step.picked, conversations: pickedConversations(step.rows, step.picked) });
  };
  const history = () => {
    close();
    getStore().actions.openPage("history");
  };
  return createPortal(<ImportPastView step={step} home={home} onEvent={send} onClose={close} onBring={bring} onHistory={history} />, document.body);
}
