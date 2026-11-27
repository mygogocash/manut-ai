import { useState } from "react";
import { t } from "../../i18n";

/** A quiet line that opens a longer text under its own label: what the app sent the lead for its helpers (item 102j), so the
 *  person can read every word that went in their chat's name without it ever looking like a message of theirs. */
export function SystemDetail({ text, detail }: { text: string; detail: { label: string; text: string } }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="sys-detail" data-testid="system-line">
      <div className="line sys">
        <span className="line-t">{text}</span>
        <button type="button" className="sys-detail-toggle" aria-expanded={open} data-testid="system-line-detail" onClick={() => setOpen((o) => !o)}>
          {open ? t("act.hide") : detail.label}
        </button>
      </div>
      {open && <pre className="sys-detail-text">{detail.text}</pre>}
    </div>
  );
}
