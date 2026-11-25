// The chat box's approval control (item 80), the same for Kit's chat and Buddy's: how much the agent may do before it
// asks, as a quiet word in the box. Its menu offers only the levels the product already has: the agent's own presets
// (sessions/controls.ts, which never offers one that skips the asks or lifts the sandbox; Buddy's are fewer still,
// runtime/mock/buddy.ts `BUDDY_MODES`) and, in a coding chat, Kit's dial for the project (packages/member-grants
// `KIT_LEVELS`), where going live asks at every level. It was a coding session's mode control (sessions/SessionView.tsx).
import { useState, type ReactNode } from "react";
import "./box.css";
import { ChevronDown, Popover } from "../../ui";
import { CheckIcon } from "../model/CheckIcon";
import { t } from "../../i18n";
import { modeHint, modeLabel } from "../../sessions/controls";

/** A small shield: what the word beside it is about (who may act before asking). */
export const ShieldIcon = () => (
  <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" aria-hidden="true">
    <path d="M8 1.8 13 3.6v3.9c0 3.1-2.1 5.6-5 6.7-2.9-1.1-5-3.6-5-6.7V3.6z" />
  </svg>
);

export interface ApprovalMenuProps {
  /** The agent's own levels on offer (its permission modes), in order. */
  modes: readonly string[];
  /** The level in force (or chosen for the next start). */
  current: string | undefined;
  /** The agent's own setting when it asks for nothing or reaches the whole disk (sessions/ownSetting.ts), and where it
   *  comes from: said where the level is, in the warning colour. */
  own?: { words: string; from: string } | null;
  /** A level can be chosen now. */
  live: boolean;
  onPick: (mode: string) => void;
  /** The line under each level; the coding chat's own hints by default. */
  hint?: (mode: string) => string;
  /** The button's word when the agent has no levels of its own (the dial's level, in a coding chat). */
  label?: string;
  /** More of the menu under the levels (Kit's dial). */
  extra?: ReactNode;
  /** The menu's last line. */
  foot?: string;
  /** Test ids: `<testId>` on the button, `-menu`, `-opt` and `-own` on the parts. */
  testId: string;
}

export function ApprovalMenu(p: ApprovalMenuProps) {
  const [open, setOpen] = useState(false);
  const cur = p.current;
  const own = p.own ?? null;
  const pick = (m: string) => {
    setOpen(false);
    if (m !== cur) p.onPick(m);
  };
  const word = own?.words ?? (p.modes.length ? modeLabel(cur) : (p.label ?? modeLabel(cur)));
  return (
    <span className="ss-pick-w">
      <button
        type="button"
        className={`ss-pick ss-mode bx-approval${cur && cur !== "default" && cur !== "ask" ? " set" : ""}${own ? " own" : ""}`}
        title={own ? `${own.words} · ${own.from}` : t("box.approval")}
        aria-label={`${t("box.approval")}: ${own ? `${own.words} · ${own.from}` : word}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        disabled={!p.live}
        onClick={() => setOpen((v) => !v)}
        data-testid={p.testId}
        data-mode={cur ?? ""}
        {...(own ? { "data-own": "unguarded" } : {})}
      >
        <ShieldIcon />
        <span className="ss-pick-n">{word}</span>
        <ChevronDown />
      </button>
      <Popover open={open} onClose={() => setOpen(false)} side="top" align="right" width={280} label={t("box.approval")} className="ss-dpop">
        <ApprovalRows {...p} onPick={pick} />
      </Popover>
    </span>
  );
}

/** The approval menu's inside: the agent's own levels with their lines, the agent's own setting when it skips the asks,
 *  then whatever the chat adds (Kit's dial) and the last line. No hooks, so a test draws it as it is. */
export function ApprovalRows(p: ApprovalMenuProps) {
  const own = p.own ?? null;
  return (
    <div data-testid={`${p.testId}-menu`}>
      {p.modes.length > 0 && <div className="ss-h ss-h-plain">{t("box.approval")}</div>}
      {own && (
        <div className="ss-mode-own" data-testid={`${p.testId}-own`}>
          {own.words} · {own.from}
        </div>
      )}
      {p.modes.map((m) => {
        const on = m === p.current;
        return (
          <button key={m} type="button" className={`ss-item ss-mode-row${on ? " on" : ""}`} aria-pressed={on} onClick={() => p.onPick(m)} data-testid={`${p.testId}-opt`} data-mode={m}>
            <span className="ss-mode-t">
              <span className="ss-n">{modeLabel(m)}</span>
              <span className="ss-mode-d">{(p.hint ?? modeHint)(m)}</span>
            </span>
            <span className="ss-ck">{on && <CheckIcon />}</span>
          </button>
        );
      })}
      {p.extra}
      {p.foot && <div className="mp-f">{p.foot}</div>}
    </div>
  );
}

/** A dial of levels inside the approval menu (Kit's, for the project): one row per level, the chosen one ticked, and
 *  what it lets the agent do alone under them. */
export function DialRows<L extends string>({
  title,
  levels,
  level,
  label,
  line,
  onLevel,
  note,
  testId,
}: {
  title: string;
  levels: readonly L[];
  level: L;
  label: (l: L) => string;
  line: string;
  onLevel: (l: L) => void;
  note?: string;
  testId: string;
}) {
  return (
    <div className="bx-dial" role="group" aria-label={title} data-testid={testId}>
      <div className="ss-h ss-h-plain bx-dial-h">{title}</div>
      {levels.map((l) => {
        const on = l === level;
        return (
          <button key={l} type="button" className={`ss-item bx-dial-row${on ? " on" : ""}`} aria-pressed={on} onClick={() => !on && onLevel(l)} data-testid={`${testId}-${l}`}>
            <span className="ss-n">{label(l)}</span>
            <span className="ss-ck">{on && <CheckIcon />}</span>
          </button>
        );
      })}
      <p className="bx-dial-line" aria-live="polite" data-testid={`${testId}-line`}>
        {line}
      </p>
      {note && <p className="bx-dial-line bx-dial-note">{note}</p>}
    </div>
  );
}
