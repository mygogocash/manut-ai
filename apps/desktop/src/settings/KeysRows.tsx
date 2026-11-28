// Settings › General › Keyboard (item 99): the app-wide shortcuts the person can set, each with its keys, Change and, once
// changed, Reset; under them, Reset all. Change waits for the person to press the new keys (Esc cancels), and no shortcut acts
// on what they press meanwhile; keys that macOS or text editing keep, or that another action has, are refused with why. The
// keys are kept on this Mac only (keys.ts). The fixed keys (team members, Esc, the terminal's and split panes' own) are listed
// after these by Settings.slot.tsx, as before.
//
// `KeysRowsView` draws from props alone, so a test draws each state; `KeysRows` reads and sets the keys.
import { useEffect, useState } from "react";
import { t, type Key } from "../i18n";
import { isMac } from "../app/shortcuts";
import { chordFromEvent, defaultKeys, keysText, KEY_ACTIONS, resetKeys, sameChord, setKeys, setKeysRecording, chordText, type Chord, type KeyAction, type Keys } from "../app/keys";
import { Row } from "./DevRow";
import { onKeysFocus, takeKeysFocus } from "./keysFocus";
import { useKeys } from "../app/keyHints";

/** Each action's words, as the fixed list's are (`key.*`). */
export const ACTION_WORDS: Record<KeyAction, Key> = {
  search: "key.search",
  find: "key.find",
  details: "key.details",
  settings: "key.settings",
  "key-sheet": "key.sheet",
  "next-ask": "key.nextAsk",
  "new-session": "key.newSession",
  "session-next": "key.sessionNext",
  "session-prev": "key.sessionPrev",
  graph: "key.graph",
  terminal: "key.terminal",
  sidebar: "key.sidebar",
};

export interface KeysRowsViewProps {
  readonly keys: Keys;
  readonly defaults: Keys;
  readonly mac: boolean;
  /** the action waiting for its new keys, if one is */
  readonly recording: KeyAction | null;
  /** why the last keys pressed were refused, in words */
  readonly refused: string | null;
  onChange: (a: KeyAction) => void;
  onReset: (a: KeyAction) => void;
  onResetAll: () => void;
}

const same = (a: readonly Chord[], b: readonly Chord[]) => a.length === b.length && a.every((c, i) => sameChord(c, b[i]!));

export function KeysRowsView(p: KeysRowsViewProps) {
  const changed = KEY_ACTIONS.filter((a) => !same(p.keys[a], p.defaults[a]));
  return (
    <>
      {KEY_ACTIONS.map((a) => {
        const waiting = p.recording === a;
        return (
          <Row key={a} title={t(ACTION_WORDS[a])}>
            <span className="st-pair keys-row" data-testid={`keys-${a}`} data-changed={changed.includes(a) || undefined}>
              {waiting ? (
                <span className="keys-wait" role="status" data-testid="keys-wait">
                  {t("key.press")}
                </span>
              ) : (
                <kbd className="st-kbd" data-testid="keys-now">
                  {p.keys[a].length ? keysText(p.keys[a], p.mac) : t("key.none")}
                </kbd>
              )}
              <button type="button" className="st-btn" onClick={() => p.onChange(a)} aria-pressed={waiting} data-testid="keys-change">
                {waiting ? t("key.cancel") : t("key.change")}
              </button>
              {changed.includes(a) && !waiting && (
                <button type="button" className="st-btn" onClick={() => p.onReset(a)} title={keysText(p.defaults[a], p.mac)} data-testid="keys-reset">
                  {t("key.reset")}
                </button>
              )}
            </span>
          </Row>
        );
      })}
      {p.refused && (
        <div className="st-note" role="alert" data-testid="keys-refused">
          {p.refused}
        </div>
      )}
      {changed.length > 0 && (
        <Row>
          <button type="button" className="st-btn" onClick={p.onResetAll} data-testid="keys-reset-all">
            {t("key.resetAll")}
          </button>
        </Row>
      )}
    </>
  );
}

/** Why keys were refused, in words. */
export function refusalWords(r: ReturnType<typeof setKeys>, c: Chord, mac: boolean): string | null {
  if (r.ok) return null;
  const keys = chordText(c, mac);
  if (r.why === "taken" && r.by) return t("key.taken", { keys, action: t(ACTION_WORDS[r.by]) });
  return t(`key.reserved.${r.why}` as Key, { keys });
}

export function KeysRows() {
  const mac = isMac();
  const keys = useKeys();
  const [recording, setRecording] = useState<KeyAction | null>(null);
  const [refused, setRefused] = useState<string | null>(null);

  // the key sheet's Change (or its link) lands here: the action's row comes to the middle with its Change focused, or the list's head
  useEffect(() => {
    const go = () => {
      const what = takeKeysFocus();
      if (!what) return;
      if (what === "list") return void document.querySelector('[data-testid="keyboard-head"]')?.scrollIntoView?.({ block: "start" });
      const row = document.querySelector<HTMLElement>(`[data-testid="keys-${what}"]`);
      row?.closest(".st-row")?.scrollIntoView?.({ block: "center" });
      row?.querySelector<HTMLElement>('[data-testid="keys-change"]')?.focus({ preventScroll: true });
    };
    go();
    return onKeysFocus(go);
  }, []);

  useEffect(() => {
    if (!recording) return;
    setKeysRecording(true);
    // first in line: the keys pressed are the keys being set, and nothing else takes them
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Tab") return;
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape" && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey) return setRecording(null);
      if (["Meta", "Control", "Alt", "Shift"].includes(e.key)) return;
      const c = chordFromEvent(e);
      if (!c) return setRefused(t("key.needsMod", { mods: mac ? "⌘, ⌃ or ⌥" : "Ctrl or Alt" }));
      const r = setKeys(recording, [c], mac);
      setRefused(refusalWords(r, c, mac));
      if (r.ok) setRecording(null);
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      setKeysRecording(false);
    };
  }, [recording, mac]);

  return (
    <KeysRowsView
      keys={keys}
      defaults={defaultKeys(mac)}
      mac={mac}
      recording={recording}
      refused={refused}
      onChange={(a) => {
        setRefused(null);
        setRecording((now) => (now === a ? null : a));
      }}
      onReset={(a) => {
        setRefused(null);
        resetKeys(a);
      }}
      onResetAll={() => {
        setRefused(null);
        setRecording(null);
        resetKeys();
      }}
    />
  );
}
