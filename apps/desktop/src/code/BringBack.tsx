// Bring it back (the design canvas's StatesCode board, "Reverted": "You reverted this turn at 09:40. 3 files are back as they
// were. Bring it back"): the panel that opens under a Reverted lane's row. It reads what bringing the files back would do (the
// shell's `turn_files_back_preview`), lists the files the person changed by hand since the rewind (each stays as it is unless
// they untick it, as in Rewind's panel), says plainly that the chat stays where the rewind left it, and puts the files back
// with one press. `BringBackView` takes everything it shows as props and uses no hooks, so a test can draw it; `BringBack`
// reads the turn book and runs the call (sessions/sessions.ts `bringBack`).
//
// The chat is not brought back. Claude Code's `rewind_conversation` and Codex's `thread/revert` cut the conversation, and
// neither agent has a message that puts it back (docs/decisions.md, 24 Nov 2026), so this says so instead of leaving the
// person to guess what Kit will remember.
import "./kit.css";
import "../sessions/rewind.css";
import { useEffect, useState } from "react";
import { t } from "../i18n";
import { backWhyText } from "../sessions/rewind";
import { getSessions } from "../sessions/sessions";
import type { TurnPreview } from "../sessions/turnFiles";

export interface BringBackProps {
  /** what bringing the files back would do, once read */
  preview: TurnPreview | null;
  /** the preview is being read */
  loading: boolean;
  /** the files changed by hand since the rewind that stay as they are */
  keep: string[];
  /** the files are being put back */
  busy: boolean;
  /** what went wrong, in words */
  error: string;
  onKeep: (path: string, keep: boolean) => void;
  onGo: () => void;
  onClose: () => void;
}

/** What bringing the files back would do: how many files go back, the files changed by hand since the rewind (each kept
 *  unless unticked), and what does not go back. */
function Details(p: BringBackProps) {
  if (p.loading) return <p className="rw-mut">{t("bb.reading")}</p>;
  const v = p.preview;
  if (!v) return null;
  const n = v.back.length;
  return (
    <>
      <p className="rw-count" data-testid="bring-back-count">
        {n === 0 ? t("bb.none") : n === 1 ? t("bb.files1") : t("bb.filesN", { n })}
      </p>
      {v.hand.length > 0 && (
        <div className="rw-hand" data-testid="bring-back-hand">
          <p className="rw-mut">{t("bb.hand")}</p>
          {v.hand.map((path) => (
            <label key={path} className="rw-file">
              <input type="checkbox" checked={p.keep.includes(path)} onChange={(e) => p.onKeep(path, e.currentTarget.checked)} data-testid="bring-back-keep" />
              <span className="rw-path">{path}</span>
            </label>
          ))}
        </div>
      )}
      {v.tooBig > 0 && <p className="rw-mut">{v.tooBig === 1 ? t("rw.to.tooBig1") : t("rw.to.tooBigN", { n: v.tooBig })}</p>}
      {v.headMoved && (
        <p className="rw-note" data-testid="bring-back-branch">
          {t("bb.branch")}
        </p>
      )}
    </>
  );
}

/** The panel, drawn from its props (no hooks). Nothing can be pressed until the files have been read, and there is nothing to
 *  press when no file differs from the files before the rewind. */
export function BringBackView(p: BringBackProps) {
  const nothing = !!p.preview && p.preview.back.length === 0;
  return (
    <div className="bb" role="group" aria-label={t("bb.title")} data-testid="bring-back">
      <Details {...p} />
      {/* said every time, since it is what a person would otherwise have to guess: the files come back and the chat does not */}
      <p className="rw-mut" data-testid="bring-back-chat">
        {t("bb.chat")}
      </p>
      {p.error && (
        <p className="rw-err" role="alert" data-testid="bring-back-error">
          {p.error}
        </p>
      )}
      <div className="chips">
        <button type="button" className="btn dark" disabled={p.busy || p.loading || !p.preview || nothing} onClick={p.onGo} data-testid="bring-back-go">
          {p.busy ? t("bb.going") : t("bb.go")}
        </button>
        <button type="button" className="btn" disabled={p.busy} onClick={p.onClose} data-testid="bring-back-close">
          {t("bb.cancel")}
        </button>
      </div>
    </div>
  );
}

/** The panel for session `id`'s lane: reads what bringing its files back would do, and does it when the person presses. */
export function BringBack({ id, onClose }: { id: string; onClose: () => void }) {
  const book = getSessions().turns;
  const [preview, setPreview] = useState<TurnPreview | null>(null);
  const [loading, setLoading] = useState(true);
  const [keep, setKeep] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    let current = true;
    setLoading(true);
    book.backPreview(id).then(
      (p) => {
        if (!current) return;
        setPreview(p);
        // a file changed by hand since the rewind stays as it is unless the person unticks it
        setKeep(p.hand);
        setLoading(false);
      },
      (e) => {
        if (!current) return;
        setPreview(null);
        setError(backWhyText(e));
        setLoading(false);
      },
    );
    return () => {
      current = false;
    };
  }, [id, book]);
  const go = async () => {
    setBusy(true);
    setError("");
    try {
      await getSessions().bringBack(id, keep);
      // the lane reads by its tests again, so its row has no panel to show
      onClose();
    } catch (e) {
      setError(t("bb.failed", { error: backWhyText(e) }));
      setBusy(false);
    }
  };
  return (
    <BringBackView
      preview={preview}
      loading={loading}
      keep={keep}
      busy={busy}
      error={error}
      onKeep={(path, on) => setKeep((k) => (on ? [...k.filter((x) => x !== path), path] : k.filter((x) => x !== path)))}
      onGo={() => void go()}
      onClose={onClose}
    />
  );
}
