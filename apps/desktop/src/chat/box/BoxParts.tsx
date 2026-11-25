// The parts the chat box's + adds above the text (item 80): the folders named for the next message, as chips beside
// the files', and the `@` menu of teammates, drawn as the `/` menu is (chat/parts/Skills.tsx). Keys stay in the text
// field: the composer moves the highlighted row and picks it.
import "../parts/skills.css";
import "../parts/attach.css";
import "./box.css";
import { t } from "../../i18n";
import { folderLabel, type Member } from "./context";

const FolderMark = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" aria-hidden="true">
    <path d="M3 7.5A1.5 1.5 0 0 1 4.5 6h4.4l2 2h8.6A1.5 1.5 0 0 1 21 9.5v8a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5z" />
  </svg>
);

/** The folders named for the next message: the folder's own name, its whole path as the tooltip, and × to leave it out. */
export function FolderChips({ folders, onRemove }: { folders: string[]; onRemove: (path: string) => void }) {
  if (!folders.length) return null;
  return (
    <div className="att-chips" data-testid="folder-chips">
      {folders.map((f) => (
        <div key={f} className="att-chip bx-folder" title={f} data-testid="folder-chip" data-path={f}>
          <span className="att-thumb att-badge">
            <FolderMark />
          </span>
          <span className="att-name">{folderLabel(f)}</span>
          <button type="button" className="att-x" aria-label={t("att.removeOf", { name: folderLabel(f) })} onClick={() => onRemove(f)} data-testid="folder-remove">
            ×
          </button>
        </div>
      ))}
    </div>
  );
}

/** The `@` menu: one row per teammate, the name a mention is written with and the name people read. */
export function MentionPicker({ items, active, onPick, onHover }: { items: Member[]; active: number; onPick: (m: Member) => void; onHover: (i: number) => void }) {
  return (
    <div className="sk-pop" role="listbox" aria-label={t("box.mentions")} data-testid="mention-picker">
      {items.length ? (
        items.map((m, i) => (
          <div
            key={m.name}
            role="option"
            aria-selected={i === active}
            className={`sk-row${i === active ? " on" : ""}`}
            data-testid="mention-option"
            data-name={m.name}
            onMouseDown={(e) => e.preventDefault()}
            onMouseMove={() => i !== active && onHover(i)}
            onClick={() => onPick(m)}
          >
            <span className="sk-name">@{m.name}</span>
            <span className="sk-d">{m.label}</span>
          </div>
        ))
      ) : (
        <div className="sk-none">{t("box.mentionNone")}</div>
      )}
    </div>
  );
}
