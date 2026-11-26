// The line a press of the snapshot's key leaves when nothing was read (item 104, snapshot.ts): Accessibility is not on,
// with the same Open button Settings › Computer has, which opens the pane of System Settings and grants nothing by
// itself (macOS is never asked from here); a window computer use never reads; nothing in front to read; or, when no new
// chat could be made, that what was read waits in Drafts on Home. It stays until the person closes it or presses the key
// again.
import { t } from "../i18n";
import { CloseIcon } from "../ui";
import { getComputerShell } from "./computer";
import { noticeText, showNotice, useSnapshotNotice, type Notice } from "./snapshot";
import "./snapshot.css";

export function SnapshotNoticeView({ notice, onOpen, onClose }: { notice: Notice; onOpen: () => void; onClose: () => void }) {
  return (
    <div className="snap-notice" role="status" aria-label={t("snap.notice")} data-testid="snap-notice" data-kind={notice.kind}>
      <span className="snap-notice-t">{noticeText(notice)}</span>
      {notice.kind === "needs" && (
        <button type="button" className="st-btn" onClick={onOpen} data-testid="snap-notice-open" aria-label={t("computer.openAria", { what: t("computer.accessibility") })}>
          {t("computer.open")}
        </button>
      )}
      <button type="button" className="ui-ib" onClick={onClose} aria-label={t("snap.close")} title={t("snap.close")} data-testid="snap-notice-close">
        <CloseIcon />
      </button>
    </div>
  );
}

export function SnapshotNotice() {
  const notice = useSnapshotNotice();
  if (!notice) return null;
  return <SnapshotNoticeView notice={notice} onOpen={() => void getComputerShell().open("accessibility").catch(() => undefined)} onClose={() => showNotice(null)} />;
}
