// The parts the chat box's + adds above the text (item 80): the folders named for the next message, as chips beside
// the files', and the `@` menu of teammates, drawn as the `/` menu is (chat/parts/Skills.tsx). Keys stay in the text
// field: the composer moves the highlighted row and picks it.
import "../parts/skills.css";
import "../parts/attach.css";
import "./box.css";
import { useState } from "react";
import { t } from "../../i18n";
import { folderLabel, type Member } from "./context";
import { Icon } from "../../ui/icons";
import { chipTitle, chipWords, dropCarried, refusalWords, scopeRefusal, type Carried, type Scope } from "./carry";

const FolderMark = () => (
  <Icon name="folder" />
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

/** What this chat's box carries besides files and folders (item 97, carry.ts): a note on a selection, as “first words…” · the
 *  note, and another chat's context, as its title, which opens to show exactly the text that goes. A chip made under another
 *  shop or account is red and says it will not be sent here; × takes any chip out. */
export function CarriedChips({ chatKey, list, scope, onRemoved }: { chatKey: string; list: readonly Carried[]; scope: Scope; onRemoved?: () => void }) {
  const [open, setOpen] = useState<string | null>(null);
  if (!list.length) return null;
  const shown = list.find((c) => c.id === open && c.kind === "thread");
  return (
    <>
      <div className="att-chips" data-testid="carry-chips">
        {list.map((c) => {
          const why = refusalWords(scopeRefusal(c.scope, scope));
          const words = chipWords(c);
          return (
            <div key={c.id} className={`att-chip bx-carry${why ? " bad" : ""}${open === c.id ? " on" : ""}`} title={why ? `${chipTitle(c)} · ${why}` : chipTitle(c)} data-testid="carry-chip" data-kind={c.kind} data-refused={why ? "true" : undefined}>
              <span className="att-thumb att-badge" aria-hidden="true">
                <Icon name={c.kind === "note" ? "pencil" : "message"} />
              </span>
              {c.kind === "thread" ? (
                <button type="button" className="bx-carry-n" aria-expanded={open === c.id} onClick={() => setOpen((o) => (o === c.id ? null : c.id))} data-testid="carry-open">
                  {words}
                </button>
              ) : (
                <span className="att-name bx-carry-n">{words}</span>
              )}
              {why && (
                <span className="att-size" data-testid="carry-refused">
                  {why}
                </span>
              )}
              <button
                type="button"
                className="att-x"
                aria-label={t("att.removeOf", { name: words })}
                onClick={() => {
                  if (open === c.id) setOpen(null);
                  dropCarried(chatKey, c.id);
                  onRemoved?.();
                }}
                data-testid="carry-remove"
              >
                ×
              </button>
            </div>
          );
        })}
      </div>
      {shown && shown.kind === "thread" && (
        <div className="bx-ctx" role="region" aria-label={shown.title} data-testid="carry-panel">
          <p className="bx-ctx-note">{t("carry.sees")}</p>
          <pre className="bx-ctx-text" tabIndex={0} data-testid="carry-text">
            {shown.text}
          </pre>
          <button type="button" className="card-btn" onClick={() => setOpen(null)} data-testid="carry-close">
            {t("carry.close")}
          </button>
        </div>
      )}
    </>
  );
}
