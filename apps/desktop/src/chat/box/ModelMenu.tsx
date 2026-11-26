// The chat box's model control (item 80), the same for Kit's chat and Buddy's: a quiet button in the box with the model
// and, beside it, how hard it thinks. Since item 132 (the owner, 26 Nov 2026: work and look as GoSpark's does) the
// button opens the effort card first (EffortCard.tsx): the level large with the model under it, Reset, a slider with a
// stop for each of the agent's own levels and, in a Claude Code chat, the one-click Ultrathink row. The card's title
// opens its second view, the models the person's own agent listed (never a list of ours), with a search once there are
// more than six and the agent's provider groups; picking one, or Back, returns to the card. It was a coding session's
// header pill (sessions/SessionView.tsx); each chat now hands it what its agent reported, and a level goes to the agent
// by the caller's `onEffort`, as it did from the segmented control the card replaced.
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import "../model/model.css";
import "./box.css";
import "./effort.css";
import { ChevronDown, Icon, ModelIcon, Popover, SearchIcon } from "../../ui";
import { CheckIcon } from "../model/CheckIcon";
import { composing } from "../../lib/ime";
import { t } from "../../i18n";
import { EffortCard } from "./EffortCard";
import { brandColour, defaultEffort, effortTitle } from "./effort";
import { settingUltrathink, ultrathinkRow } from "./ultrathink";
import { useBoxDraft } from "./boxDraft";

/** One model the agent listed. */
export interface BoxModel {
  id: string;
  label: string;
  detail?: string;
  /** A Hermes provider slug (oh-my-hermes sessions). */
  provider?: string;
}

/** Model options grouped by provider in the order they came (a model's `provider`, else the agent's own options
 *  under one group), filtered by a search over label, id and provider. */
export function groupModels(options: BoxModel[], query: string): { provider: string; rows: BoxModel[] }[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const out: { provider: string; rows: BoxModel[] }[] = [];
  for (const o of options) {
    const hay = `${o.label} ${o.id} ${o.provider ?? ""} ${o.detail ?? ""}`.toLowerCase();
    if (!words.every((w) => hay.includes(w))) continue;
    const g = o.provider ?? "";
    const last = out.find((x) => x.provider === g);
    if (last) last.rows.push(o);
    else out.push({ provider: g, rows: [o] });
  }
  return out;
}

/** How long a level just picked stays on the card after the agent has been asked, when the agent has not yet said it
 *  took it: long enough for its answer to arrive, short enough that a refused level does not stay shown. */
const HOLD_MS = 1500;

export interface ModelMenuProps {
  /** The model's words on the button: what runs, or what was picked for the next turn. */
  label: string;
  /** What the model's mark is drawn from (`ModelIcon`); `provider` also gives the top level its colour. */
  mark: { model: string; provider: string };
  /** The agent runs now (the dot on the mark is green). */
  live: boolean;
  /** The models the agent listed; undefined or empty while it has not. */
  options: BoxModel[] | undefined;
  /** The row that is on (the model in force, or the one picked for the next turn). */
  isOn: (o: BoxModel) => boolean;
  onPick: (o: BoxModel) => Promise<void>;
  /** A pick can be made now (the agent runs, or the chat keeps it for its next start). */
  canPick: boolean;
  /** The agent's own reasoning levels, and the one in force or picked ("" for none shown). */
  efforts: string[];
  effort: string;
  /** Sends a level to the agent; a promise that settles once the agent has been asked. */
  onEffort: (level: string) => void | Promise<unknown>;
  /** The chat's agent is Claude Code: the card offers the one-click Ultrathink row for the draft. */
  ultrathink?: boolean;
  /** What the list says while it has nothing to show. */
  empty: string;
  /** Beside the model on the button: a pick that waits for the next turn. */
  badge?: ReactNode;
  /** Under the card or the list: notes (a refusal, a pick for the next turn). */
  notes?: ReactNode;
  /** The menu's last line: where a choice applies. */
  foot: string;
}

/** The model and its effort, as one quiet button in the chat box; the card opens above the box. */
export function ModelMenu(p: ModelMenuProps) {
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<"effort" | "models">("effort");
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  // the level just picked, shown until the agent says which level is in force (HOLD_MS)
  const [held, setHeld] = useState<string | null>(null);
  const settle = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const listRef = useRef<HTMLDivElement>(null);
  const pillRef = useRef<HTMLButtonElement>(null);
  const sliderRef = useRef<HTMLDivElement>(null);
  const titleRef = useRef<HTMLButtonElement>(null);
  const groups = useMemo(() => groupModels(p.options ?? [], query), [p.options, query]);
  const flat = groups.flatMap((g) => g.rows);
  const many = (p.options?.length ?? 0) > 6;
  const draft = useBoxDraft();
  useEffect(() => {
    if (open) {
      setView("effort");
      setQuery("");
      setActive(0);
    } else setHeld(null);
  }, [open]);
  // the agent says the level it picked is in force: the card shows the agent's word from here. A word about an earlier
  // pick, arriving after a later one, leaves the later one shown (its own word follows, or HOLD_MS lets it go)
  useEffect(() => setHeld((h) => (h === p.effort ? null : h)), [p.effort]);
  useEffect(() => () => clearTimeout(settle.current), []);
  useEffect(() => setActive(0), [query]);
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>('[data-active="true"]')?.scrollIntoView({ block: "nearest" });
  }, [active, open, view]);
  // the card takes the keys at once (the slider, or the title when there is none to move); back from the list, the
  // title the person left it by. The list's search field, or Back, takes them in the list
  const fromList = useRef(false);
  useEffect(() => {
    if (!open || view !== "effort") return;
    const back = fromList.current;
    fromList.current = false;
    (!back && sliderRef.current?.tabIndex === 0 ? sliderRef.current : titleRef.current)?.focus();
  }, [open, view]);
  const toCard = () => {
    fromList.current = true;
    setView("effort");
  };
  const level = held ?? p.effort;
  const pickLevel = (next: string) => {
    if (!p.canPick || next === level || !p.efforts.includes(next)) return;
    setHeld(next);
    clearTimeout(settle.current);
    void Promise.resolve(p.onEffort(next)).finally(() => {
      clearTimeout(settle.current);
      settle.current = setTimeout(() => setHeld((h) => (h === next ? null : h)), HOLD_MS);
    });
  };
  const choose = async (o: BoxModel) => {
    if (busy) return;
    if (p.isOn(o)) {
      toCard();
      return;
    }
    if (!p.canPick) return;
    setBusy(true);
    await p.onPick(o);
    setBusy(false);
    toCard();
  };
  const onSearchKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (flat.length) setActive((i) => (i + (e.key === "ArrowDown" ? 1 : -1) + flat.length) % flat.length);
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (composing(e)) return;
      if (flat[active]) void choose(flat[active]);
    }
  };
  const ut = p.ultrathink && draft ? ultrathinkRow(draft.text, true, p.efforts.length > 0) : null;
  return (
    <span className="bx-w">
      <button
        ref={pillRef}
        type="button"
        className={`mp bx-pick${open ? " on" : ""}`}
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={t("mp.title")}
        data-testid="model-pill"
      >
        <span className="mp-mk" title={p.live ? t("ss.running") : t("ss.notRunning")}>
          <ModelIcon model={p.mark.model} provider={p.mark.provider} size={14} />
          <span className={`mp-d${p.live ? " live" : ""}`} aria-hidden="true" />
        </span>
        {open ? (
          // GoSpark's chip says what the open card is for, in place of the model and its level
          <span className="mp-l" data-testid="model-select">
            {t("ef.select")}
          </span>
        ) : (
          <>
            <span className="mp-l" title={p.label || undefined} data-testid="model-label">
              {p.label || t("ss.model")}
            </span>
            {p.effort && p.efforts.length > 0 && (
              <>
                <span className="sep" />
                <span className="eff" data-testid="reasoning-label">
                  {effortTitle(p.effort)}
                </span>
              </>
            )}
          </>
        )}
        {p.badge}
        <ChevronDown />
      </button>
      <Popover
        open={open}
        onClose={(why) => {
          setOpen(false);
          if (why === "escape") pillRef.current?.focus();
        }}
        side="top"
        align="right"
        label={t("mp.title")}
        width={330}
        className="mp-pop bx-pop ef-pop"
      >
        <div data-testid="model-pop" data-view={view} aria-busy={busy}>
          {view === "effort" ? (
            <EffortCard
              modelName={p.label || t("ss.model")}
              mark={p.mark}
              levels={p.efforts}
              level={level}
              canPick={p.canPick}
              brand={brandColour(p.mark.provider)}
              onLevel={pickLevel}
              onReset={() => {
                const d = defaultEffort(p.efforts);
                if (d) pickLevel(d);
              }}
              onModels={() => setView("models")}
              empty={!p.options?.length ? p.empty : t("ef.none")}
              ultrathink={ut && ut.kind !== "hidden" && draft ? { row: ut, onChange: (on) => draft.set(settingUltrathink(on, draft.text)) } : null}
              sliderRef={sliderRef}
              titleRef={titleRef}
            />
          ) : (
            <div className="ef-list" data-testid="model-list">
              <div className="ef-lh">
                <button
                  type="button"
                  className="ef-ib ef-back"
                  onClick={toCard}
                  aria-label={t("ef.back")}
                  title={t("ef.back")}
                  autoFocus={!many}
                  data-testid="model-back"
                >
                  <Icon name="chevron-left" />
                </button>
                <span className="ef-lt">{t("ef.selectModel")}</span>
              </div>
              {many && (
                <label className="mp-search">
                  <SearchIcon />
                  <input
                    type="search"
                    placeholder={t("mp.search")}
                    aria-label={t("mp.search")}
                    autoFocus
                    autoComplete="off"
                    spellCheck={false}
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    onKeyDown={onSearchKey}
                    data-testid="model-search"
                  />
                </label>
              )}
              <div className="mp-list" ref={listRef}>
                {!p.options || p.options.length === 0 ? (
                  <div className="mp-empty" data-testid="model-empty">
                    {p.empty}
                  </div>
                ) : !flat.length ? (
                  <div className="mp-empty" data-testid="model-empty">
                    {t("mp.none")}
                  </div>
                ) : (
                  groups.map((g) => (
                    <div key={g.provider || "-"} role="group" aria-label={g.provider || p.label} data-testid="model-group">
                      {groups.length > 1 && g.provider && <div className="mp-g">{g.provider}</div>}
                      {g.rows.map((o) => {
                        const on = p.isOn(o);
                        const i = flat.indexOf(o);
                        return (
                          <button
                            key={`${o.provider ?? ""}/${o.id}`}
                            type="button"
                            className={`mp-opt${on ? " on" : ""}${many && i === active ? " kb" : ""}`}
                            aria-pressed={on}
                            data-active={many && i === active}
                            disabled={busy || !p.canPick}
                            title={o.detail || undefined}
                            onClick={() => void choose(o)}
                            onMouseMove={() => many && i !== active && setActive(i)}
                            data-testid="model-opt"
                          >
                            <ModelIcon model={`${o.id} ${o.label}`} provider={o.provider ?? p.mark.provider} size={16} />
                            <span className="mp-n">{o.label}</span>
                            <span className="mp-ck">
                              <CheckIcon />
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  ))
                )}
              </div>
            </div>
          )}
          <div className="ef-foot">
            {p.notes}
            <div className="mp-f">{p.foot}</div>
          </div>
        </div>
      </Popover>
    </span>
  );
}
