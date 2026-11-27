// The effort card (item 132): what the chat box's model chip opens first, as GoSpark's composer does
// (`EffortSliderCard` and `EffortSlider` in GoGoCode/Views/Composer/EffortSlider.swift). The level's name large, with
// the model under it (both one button, which opens the model list); Reset, back to the default level; a slider with one
// stop for each level the agent reported, which a drag, a click or the arrow keys move; and, in a Claude Code chat, the
// one-click Ultrathink row. At the top level the title and the track take the provider's colour, as GoSpark's
// `EffortBrand` paints them; below it they are the ink, since the brand's look has no accent of its own (a theme of the
// person's own, item 99b, reaches the card through the ink and its greys).
//
// What GoSpark adds at the top level and in fast mode (drifting particles, speed streaks, lightning, a sweeping sheen)
// is left out: the Motion board lets only work in progress loop (docs/motion.md). No agent reports a fast mode, so the
// gold of GoSpark's fast mode is left out too (docs/decisions/132-effort-card.md).
//
// A drag shows each stop it crosses (the title follows, and each crossing ticks with item 131's effort sound) and sends
// the level it lets go on, once, so an agent is not sent every level the knob passed over. A click sends the stop
// clicked, a key the stop it moves to (and ticks for it).
import { useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent, type Ref } from "react";
import "./effort.css";
import { ChevronRight, Icon, ModelIcon } from "../../ui";
import { Toggle } from "../../pages/kit";
import { t } from "../../i18n";
import { effortTitle, isTop, keyStep, pointerFraction, restingIndex, stopFraction, stopTracker } from "./effort";
import type { UltrathinkRow } from "./ultrathink";

export interface EffortCardProps {
  /** The model's name under the title. */
  modelName: string;
  /** What the model's mark is drawn from (`ModelIcon`). */
  mark: { model: string; provider: string };
  /** The levels the agent reported, lowest first; empty while it reported none. */
  levels: readonly string[];
  /** The level in force, or the one just picked ("" when the agent has not said). */
  level: string;
  /** A level can be picked now. */
  canPick: boolean;
  /** The provider's colour for the top level; null for one whose mark is drawn in the ink. */
  brand: string | null;
  onLevel: (level: string) => void;
  onReset: () => void;
  /** The title was clicked: the card's second view, the model list. */
  onModels: () => void;
  /** What stands in the slider's place when there are no levels. */
  empty: string;
  /** Claude Code's one-click Ultrathink for the draft, or null where it is not offered. */
  ultrathink?: { row: UltrathinkRow; onChange: (on: boolean) => void } | null;
  sliderRef?: Ref<HTMLDivElement>;
  titleRef?: Ref<HTMLButtonElement>;
}

export function EffortCard(p: EffortCardProps) {
  // the stop under the pointer while a drag is on, so the title names it before it is sent
  const [preview, setPreview] = useState<number | null>(null);
  const count = p.levels.length;
  const resting = restingIndex(p.levels, p.level);
  const shown = preview ?? resting;
  const title = count ? effortTitle(p.levels[shown]) : t("ef.standard");
  const top = isTop(shown, count);
  const style = { "--ef-brand": p.brand ?? "var(--ink)" } as CSSProperties;
  return (
    <div className="ef-card" style={style} data-top={top || undefined} data-brand={p.brand ? "colour" : "ink"} data-testid="effort-card">
      <div className="ef-head">
        <button type="button" className="ef-title" onClick={p.onModels} title={t("ef.chooseModel")} ref={p.titleRef} data-testid="effort-title">
          <span className="ef-t">
            <span data-testid="effort-level">{title}</span>
            <ChevronRight size={12} />
          </span>
          <span className="ef-m" data-testid="effort-model">
            <ModelIcon model={p.mark.model} provider={p.mark.provider} size={12} />
            <span className="ef-mn">{p.modelName}</span>
          </span>
        </button>
        <button
          type="button"
          className="ef-ib ef-reset"
          onClick={p.onReset}
          disabled={!p.canPick || !count}
          aria-label={t("ef.reset")}
          title={t("ef.reset")}
          data-testid="effort-reset"
        >
          <Icon name="rotate-ccw" />
        </button>
      </div>
      {count ? (
        <EffortSlider
          levels={p.levels}
          index={resting}
          shown={shown}
          title={title}
          disabled={!p.canPick}
          onPreview={setPreview}
          onPick={(i) => p.onLevel(p.levels[i])}
          sliderRef={p.sliderRef}
        />
      ) : (
        <div className="ef-none" data-testid="effort-none">
          {p.empty}
        </div>
      )}
      {p.ultrathink && p.ultrathink.row.kind !== "hidden" && <UltrathinkLine row={p.ultrathink.row} onChange={p.ultrathink.onChange} />}
    </div>
  );
}

/** The track, its stops and the knob. `index` is where the knob rests (the level in force); `shown` the stop the title
 *  names, which a drag moves before anything is sent. */
function EffortSlider({
  levels,
  index,
  shown,
  title,
  disabled,
  onPreview,
  onPick,
  sliderRef,
}: {
  levels: readonly string[];
  index: number;
  shown: number;
  title: string;
  disabled: boolean;
  onPreview: (i: number | null) => void;
  onPick: (i: number) => void;
  sliderRef?: Ref<HTMLDivElement>;
}) {
  const count = levels.length;
  const track = useRef<HTMLDivElement>(null);
  // where the knob is while it is held (0 at the first stop, 1 at the last); null at rest
  const [held, setHeld] = useState<number | null>(null);
  // the pointer has moved since it went down: from then the knob follows it with no delay. Before that, the jump to
  // where it went down slides, as GoSpark's knob springs to the pointer
  const [moving, setMoving] = useState(false);
  // the drag under way: the stop under the pointer, which ticks as the knob crosses into it (effort.ts)
  const drag = useRef<ReturnType<typeof stopTracker> | null>(null);
  const at = (e: PointerEvent) => {
    const r = track.current?.getBoundingClientRect();
    return r ? pointerFraction(e.clientX - r.left, r.width) : stopFraction(index, count);
  };
  const follow = (f: number) => {
    const t = drag.current;
    if (!t) return;
    setHeld(f);
    const before = t.under;
    if (t.move(f) !== before) onPreview(t.under);
  };
  const end = (send: boolean) => {
    const t = drag.current;
    if (!t) return;
    drag.current = null;
    setHeld(null);
    setMoving(false);
    onPreview(null);
    if (send && t.under !== index) onPick(t.under);
  };
  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (disabled || e.button !== 0) return;
    // keep the knob's own focus ring off the text and take the keys from here on
    e.preventDefault();
    e.currentTarget.focus();
    e.currentTarget.setPointerCapture?.(e.pointerId);
    drag.current = stopTracker(index, count);
    follow(at(e));
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (disabled) return;
    const next = keyStep(e.key, index, count);
    if (next === null) return;
    e.preventDefault();
    if (next !== index) onPick(next);
  };
  const p = held ?? stopFraction(index, count);
  return (
    <div
      ref={sliderRef}
      className={`ef-slider${moving ? " drag" : ""}`}
      role="slider"
      tabIndex={disabled ? -1 : 0}
      aria-label={t("ef.slider")}
      aria-valuemin={0}
      aria-valuemax={count - 1}
      aria-valuenow={shown}
      aria-valuetext={title}
      aria-disabled={disabled || undefined}
      data-testid="effort-slider"
      onKeyDown={onKeyDown}
      onPointerDown={onPointerDown}
      onPointerMove={(e) => {
        if (!drag.current) return;
        setMoving(true);
        follow(at(e));
      }}
      onPointerUp={() => end(true)}
      onPointerCancel={() => end(false)}
      onLostPointerCapture={() => end(false)}
    >
      <div className="ef-track" ref={track} style={{ "--ef-p": p } as CSSProperties}>
        <span className="ef-fill" />
        {levels.map((l, i) => {
          const f = stopFraction(i, count);
          return (
            <span
              key={l}
              className={`ef-stop${f <= p + 1e-6 ? " on" : ""}`}
              style={{ "--ef-s": f } as CSSProperties}
              data-level={l}
              data-testid="effort-stop"
            />
          );
        })}
        <span className="ef-knob" />
      </div>
    </div>
  );
}

/** One switch under the slider: its glyph, a title over the line that says what it does (or why it cannot be turned
 *  on), and the app's switch. */
function UltrathinkLine({ row, onChange }: { row: UltrathinkRow; onChange: (on: boolean) => void }) {
  const on = row.kind === "typed" || (row.kind === "toggle" && row.on);
  const line = row.kind === "typed" ? t("ef.utTyped") : row.kind === "slash" ? t("ef.utSlash") : t("ef.utAdds");
  return (
    <div className="ef-rows">
      <div className="ef-row" data-testid="ultrathink-row" data-state={row.kind}>
        <span className="ef-ri" aria-hidden="true">
          <Icon name="sparkle" />
        </span>
        <span className="ef-rt">
          <span className="ef-rn">{t("ef.utTitle")}</span>
          <span className="ef-rl" data-testid="ultrathink-line">
            {line}
          </span>
        </span>
        <Toggle on={on} label={t("ef.utTitle")} onChange={onChange} disabled={row.kind !== "toggle"} testId="ultrathink-switch" />
      </div>
    </div>
  );
}
