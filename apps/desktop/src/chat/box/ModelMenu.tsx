// The chat box's model control (item 80), the same for Kit's chat and Buddy's: a quiet button in the box with the model
// and, beside it, how hard it thinks; its menu lists the models the person's own agent listed (never a list of ours),
// with a search once there are more than six and the agent's provider groups, and the agent's own reasoning levels.
// It was a coding session's header pill (sessions/SessionView.tsx); each chat now hands it what its agent reported.
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import "../model/model.css";
import "./box.css";
import { ChevronDown, ModelIcon, Popover, SearchIcon } from "../../ui";
import { Seg } from "../model/Seg";
import { CheckIcon } from "../model/CheckIcon";
import { composing } from "../../lib/ime";
import { t } from "../../i18n";
import { levelLabel, levelOptions } from "../../sessions/controls";

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

export interface ModelMenuProps {
  /** The model's words on the button: what runs, or what was picked for the next turn. */
  label: string;
  /** What the model's mark is drawn from (`ModelIcon`). */
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
  onEffort: (level: string) => void;
  /** What the list says while it has nothing to show. */
  empty: string;
  /** Beside the model on the button: a pick that waits for the next turn. */
  badge?: ReactNode;
  /** Under the list: notes (a refusal, a pick for the next turn). */
  notes?: ReactNode;
  /** The menu's last line: where a choice applies. */
  foot: string;
}

/** The model and its effort, as one quiet button in the chat box; the menu opens above the box. */
export function ModelMenu(p: ModelMenuProps) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const pillRef = useRef<HTMLButtonElement>(null);
  const groups = useMemo(() => groupModels(p.options ?? [], query), [p.options, query]);
  const flat = groups.flatMap((g) => g.rows);
  const many = (p.options?.length ?? 0) > 6;
  useEffect(() => {
    if (open) {
      setQuery("");
      setActive(0);
    }
  }, [open]);
  useEffect(() => setActive(0), [query]);
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>('[data-active="true"]')?.scrollIntoView({ block: "nearest" });
  }, [active, open]);
  const choose = async (o: BoxModel) => {
    if (p.isOn(o) || busy || !p.canPick) return;
    setBusy(true);
    await p.onPick(o);
    setBusy(false);
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
        <span className="mp-l" title={p.label || undefined} data-testid="model-label">
          {p.label || t("ss.model")}
        </span>
        {p.effort && p.efforts.length > 0 && (
          <>
            <span className="sep" />
            <span className="eff" data-testid="reasoning-label">
              {levelLabel(p.effort, p.efforts)}
            </span>
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
        width={300}
        className="mp-pop bx-pop"
      >
        <div data-testid="model-pop" aria-busy={busy}>
          {many ? (
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
          ) : (
            <div className="mp-h">{t("ss.model")}</div>
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
          {p.efforts.length > 0 && (
            <>
              <div className="mp-h mp-h2">{t("mp.reasoning")}</div>
              <Seg
                label={t("mp.reasoning")}
                value={p.effort}
                options={levelOptions(p.efforts)}
                onChange={(v) => p.onEffort(v)}
                disabled={!p.canPick}
                small={p.efforts.length > 5}
                testId="reasoning-seg"
              />
            </>
          )}
          {p.notes}
          <div className="mp-f">{p.foot}</div>
        </div>
      </Popover>
    </span>
  );
}
