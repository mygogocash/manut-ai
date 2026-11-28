// The key sheet (item 167d, ⌘/ by default; Paradev's keyboard page opens on the same chord): one box that lists every key the app
// has, by group, with a search over the words and the keys. It is read only. The keys the person can set are listed as they set
// them, each with a Change that opens that row in Settings › General › Keyboard, where item 99a's page records new ones; the fixed
// keys (⌘1 to ⌘9, Esc, an approval card's 1, 2 and 3, the terminal's own) are listed and say nothing more. It answers no ask: an
// approval card's 1, 2 and 3 stay the card's, and the sheet only names them.
//
// `KeySheetView` draws a given list so tests can draw any state; `KeySheet` keeps the typing and acts. It looks as the palette does
// (`.pal`, palette.css): a modal box over the page whose field has the focus, which Esc closes and gives the focus back from.
import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type RefObject } from "react";
import "../palette/palette.css";
import "./keysheet.css";
import { t } from "../i18n";
import { composing } from "../lib/ime";
import { getStore } from "../state/store";
import { Icon } from "../ui/icons";
import { KeyCaps } from "../ui/KeyCaps";
import { useLeaving } from "../ui/leave";
import { useKeys } from "../app/keyHints";
import { isMacHere, type KeyAction } from "../app/keys";
import { sheetGroups, type SheetGroup } from "../app/keyList";
import { askKeysFocus } from "../settings/keysFocus";
import { closeKeySheet, useKeySheetOpen } from "./state";

export interface KeySheetViewProps {
  query: string;
  onQuery: (q: string) => void;
  groups: readonly SheetGroup[];
  /** Change on a row the person can set: Settings › General › Keyboard opens at that row */
  onChange: (action: KeyAction) => void;
  /** the foot's link: Settings › General › Keyboard */
  onSettings: () => void;
  onBackdrop: () => void;
  onKeyDown: (e: ReactKeyboardEvent<HTMLElement>) => void;
  inputRef?: RefObject<HTMLInputElement | null>;
  /** Closed and fading out (ui/leave.ts): drawn inert, so nothing in it takes a key or a press. */
  leaving?: boolean;
}

/** Where the Keyboard list is, as Settings names its places (the palette writes a page the same way). */
const where = () => `${t("set.title")} › ${t("set.general")} › ${t("set.keyboard")}`;

export function KeySheetView(p: KeySheetViewProps) {
  const total = p.groups.reduce((n, g) => n + g.rows.length, 0);
  return (
    <div
      className="pal-back"
      onMouseDown={(e) => e.target === e.currentTarget && p.onBackdrop()}
      data-testid="keysheet-backdrop"
      {...(p.leaving ? { "data-leaving": "", inert: true, "aria-hidden": true } : {})}
    >
      <div className="pal ks" role="dialog" aria-modal="true" aria-label={t("keysheet.title")} onKeyDown={p.onKeyDown} data-testid="keysheet">
        <div className="pal-s">
          <Icon name="search" />
          <input
            ref={p.inputRef}
            className="pal-in"
            type="text"
            role="searchbox"
            aria-label={t("keysheet.ph")}
            placeholder={t("keysheet.ph")}
            value={p.query}
            onChange={(e) => p.onQuery(e.target.value)}
            autoComplete="off"
            spellCheck={false}
            data-testid="keysheet-input"
          />
          <span className="pal-kbd" aria-hidden="true">
            Esc
          </span>
        </div>
        <div className="ks-list" data-testid="keysheet-list">
          {p.groups.map((g) => (
            <section key={g.group} className="pal-g" aria-labelledby={`ks-h-${g.group}`} data-testid={`keysheet-group-${g.group}`}>
              <div className="pal-h" id={`ks-h-${g.group}`} role="heading" aria-level={2}>
                {t(g.heading)}
              </div>
              <ul className="ks-rows">
                {g.rows.map((r) => (
                  <li key={r.id} className="ks-row" data-testid="keysheet-row" data-row={r.id}>
                    <span className="pal-n">{r.label}</span>
                    <span className="ks-keys" data-testid="keysheet-keys">
                      {r.keys.length ? (
                        r.keys.map((k) => (
                          <kbd key={k} className="kcap ks-k">
                            {k}
                          </kbd>
                        ))
                      ) : (
                        <span className="ks-none">{t("key.none")}</span>
                      )}
                    </span>
                    {r.action ? (
                      <button type="button" className="ks-change" onClick={() => p.onChange(r.action!)} aria-label={t("keysheet.changeFor", { action: r.label })} data-testid="keysheet-change">
                        {t("key.change")}
                      </button>
                    ) : (
                      <span className="ks-change ks-fixed" aria-hidden="true" />
                    )}
                  </li>
                ))}
              </ul>
            </section>
          ))}
          {total === 0 && (
            <div className="pal-none" role="status" data-testid="keysheet-none">
              {t("keysheet.none", { q: p.query.trim() })}
            </div>
          )}
        </div>
        <div className="pal-foot ks-foot">
          <button type="button" className="ks-link" onClick={p.onSettings} data-testid="keysheet-settings">
            {t("keysheet.open", { where: where() })}
          </button>
          <span className="pal-fh pal-fe">
            <KeyCaps shown={{ caps: ["Esc"] }} />
            {t("pal.footClose")}
          </span>
        </div>
      </div>
    </div>
  );
}

/** Tab stays inside the sheet: from its last control to its first, and back (the palette keeps the focus in its one field). */
export function trapTab(e: ReactKeyboardEvent<HTMLElement>): void {
  const items = [...e.currentTarget.querySelectorAll<HTMLElement>("input, button:not([disabled])")];
  if (!items.length) return e.preventDefault();
  const first = items[0]!;
  const last = items[items.length - 1]!;
  const at = document.activeElement;
  if (e.shiftKey ? at === first : at === last) {
    e.preventDefault();
    (e.shiftKey ? last : first).focus();
  }
}

function OpenKeySheet({ leaving }: { leaving: boolean }) {
  const keys = useKeys();
  const mac = isMacHere();
  const [query, setQuery] = useState("");
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.focus(), []);
  const groups = useMemo(() => sheetGroups(keys, mac, query), [keys, mac, query]);
  // Settings opens on General with the Keyboard list asked for; the focus is Settings' now, so it is not given back to the page behind
  const toSettings = (what: KeyAction | "list") => {
    closeKeySheet({ restore: false });
    askKeysFocus(what);
    getStore().actions.openSettings("general");
  };
  return (
    <KeySheetView
      query={query}
      onQuery={setQuery}
      groups={groups}
      onChange={toSettings}
      onSettings={() => toSettings("list")}
      onBackdrop={() => closeKeySheet()}
      inputRef={input}
      leaving={leaving}
      onKeyDown={(e) => {
        // an input method's own keys (its candidate list, its Enter, its Esc) are not the sheet's
        if (composing(e)) return;
        if (e.key === "Tab") return trapTab(e);
        if (e.key === "Escape" && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey) {
          e.preventDefault();
          e.stopPropagation();
          closeKeySheet();
        }
      }}
    />
  );
}

/** Mounted once by the app: draws nothing until its key, the palette's row or Settings' button opens it. As the palette does, it
 *  fades out where it stands once closed; opened again meanwhile, it starts afresh. */
export function KeySheet() {
  const { drawn, leaving, opened } = useLeaving(useKeySheetOpen());
  return drawn ? <OpenKeySheet key={opened} leaving={leaving} /> : null;
}
