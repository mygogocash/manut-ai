// Settings › Computer (item 82): whether macOS has given Manut AI the two permissions computer use needs, read from
// the Mac without asking for either; a button for each that opens its pane of System Settings, where only the person
// can turn Manut AI on; one line that says when all is ready or what is missing; and Re-check, which reads again (as
// does coming back to the window from System Settings). Under them, what the agent may look at and what asks first,
// and, for a copy not signed with a Developer ID, that macOS forgets both after each update.
//
// `ComputerView` draws a given state so a test can draw each one (ComputerPage.test.tsx); `ComputerPage` reads and acts.
import { useCallback, useEffect, useState } from "react";
import { t } from "../i18n";
import { isAppStore } from "../appStore";
import { computerOffered, getComputerShell, statusLine, type ComputerStatus, type Pane } from "../computer/computer";
import { Row } from "./DevRow";

export interface ComputerViewProps {
  /** Computer use works here (the Mac app). */
  offered: boolean;
  /** Where things stand; null while it is being read, or when it could not be. */
  status: ComputerStatus | null;
  /** The read failed. */
  failed?: boolean;
  onOpen: (pane: Pane) => void;
  onRecheck: () => void;
  /** The Mac App Store edition, whose sandbox refuses what computer use needs (docs/app-store.md). */
  appStore?: boolean;
}

export function ComputerView(p: ComputerViewProps) {
  if (!p.offered) {
    return (
      <div className="st-page" data-testid="computer-page">
        <div className="st-gh st-gh0">{t("set.computer")}</div>
        <div className="st-note" data-testid="computer-not-here">
          {t("computer.notMac")}
        </div>
      </div>
    );
  }
  const s = p.status;
  const ready = !!s && s.accessibility && s.screen;
  const access = (on: boolean | undefined) => (on === undefined ? t("computer.checking") : on ? t("computer.granted") : t("computer.notGranted"));
  return (
    <div className="st-page" data-testid="computer-page">
      <div className="st-gh st-gh0">{t("set.computer")}</div>
      {p.appStore && (
        // the page stays, so a person sees what the feature is; the sandbox's refusal is said first (app_store.rs)
        <div className="st-note" data-testid="computer-store">
          {t("computer.store")}
        </div>
      )}
      <div className="st-grp">
        <Row title={t("computer.title")} hint={s ? t(statusLine(s)) : p.failed ? t("computer.failed") : t("computer.checking")}>
          <span className="st-pair">
            <span className="st-val" data-testid="computer-status" data-ready={String(ready)}>
              <i className={`st-dot ${ready ? "online" : "offline"}`} aria-hidden="true" />
              {ready ? t("computer.readyShort") : t("computer.notReadyShort")}
            </span>
            <button type="button" className="st-btn" onClick={p.onRecheck} data-testid="computer-recheck">
              {t("computer.recheck")}
            </button>
          </span>
        </Row>
      </div>
      <div className="st-gh">{t("computer.permissions")}</div>
      <div className="st-grp" data-testid="computer-permissions">
        {(
          [
            ["accessibility", "computer.accessibility", "computer.accessibilityHint", s?.accessibility],
            ["screen", "computer.screen", "computer.screenHint", s?.screen],
          ] as const
        ).map(([pane, title, hint, on]) => (
          <Row key={pane} title={t(title)} hint={t(hint)}>
            <span className="st-pair">
              <span className="st-val" data-testid={`computer-${pane}`} data-granted={on === undefined ? "" : String(on)}>
                {access(on)}
              </span>
              <button type="button" className="st-btn" onClick={() => p.onOpen(pane)} data-testid={`computer-open-${pane}`} aria-label={t("computer.openAria", { what: t(title) })}>
                {t("computer.open")}
              </button>
            </span>
          </Row>
        ))}
      </div>
      <div className="st-note">{t("computer.how")}</div>
      <div className="st-note" data-testid="computer-new-chats">
        {t("computer.newChats")}
      </div>
      <div className="st-gh">{t("computer.bounds")}</div>
      <div className="st-note" data-testid="computer-looks">
        {t("computer.looks")}
      </div>
      <div className="st-note" data-testid="computer-acts">
        {t("computer.acts")}
      </div>
      <div className="st-note" data-testid="computer-never">
        {t("computer.never")}
      </div>
      {s && !s.signed && !p.appStore && (
        <div className="st-note" data-testid="computer-unsigned">
          {t("computer.unsigned")}
        </div>
      )}
    </div>
  );
}

export function ComputerPage() {
  const offered = computerOffered();
  const [status, setStatus] = useState<ComputerStatus | null>(null);
  const [failed, setFailed] = useState(false);
  const read = useCallback(() => {
    if (!offered) return;
    void getComputerShell()
      .status()
      .then(
        (s) => {
          setStatus(s);
          setFailed(false);
        },
        () => setFailed(true),
      );
  }, [offered]);
  // read once the page opens, and again whenever the window comes back to the front, as it does from System Settings
  useEffect(() => {
    read();
    if (!offered || typeof window === "undefined") return;
    window.addEventListener("focus", read);
    return () => window.removeEventListener("focus", read);
  }, [offered, read]);
  return <ComputerView offered={offered} status={status} failed={failed} onOpen={(pane) => void getComputerShell().open(pane).catch(() => undefined)} onRecheck={read} appStore={isAppStore()} />;
}
