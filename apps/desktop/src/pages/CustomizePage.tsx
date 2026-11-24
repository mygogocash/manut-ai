// Customize: two tabs in the top bar, as the canvas has them: Memory and routines, and Connections (the shop's vault and
// outposts for its owner, ConnectionsPane.tsx, around this Mac as one of the shop's outposts, OutpostPane.tsx).
//
// Memory and routines, as the design canvas draws it (Brain.dc.html). On the left, what the team knows, each fact
// with where it came from and the owner's Correct and Forget, what waits for the owner's OK and is not used until they
// confirm it, and a box to tell Buddy something to remember. On the right, the team's routines, each as its timing and what it
// does, with a switch, and a short form for a new one. The Automations and Plugins pages stay its entries when the runtime
// offers them (`can("automations")`, `can("plugins")`), keeping the sidebar's old test ids.
//
// The page never decides what the team knows or which routines there are: the runtime does, by `@manut/shop-memory`'s and
// `@manut/routine-rules`' rules. The page shows its answers, asks it to act, and never shows a waiting fact as used or a
// forgotten fact's words again. Correct and Forget ask once more, in place, before anything is done. The connected runtime
// answers "not yet" to all of memory and to every routine write, which each half shows in the runtime's own words. The rules
// and words are memory.ts and routines.ts; this file draws them.
import { useEffect, useReducer, useState, type ReactNode } from "react";
import "./customize.css";
import { weekdayName } from "../app/time";
import { t } from "../i18n";
import { can } from "../runtime";
import type { MemoryFact } from "../runtime/memory";
import type { RoutineRow } from "../runtime/routines";
import { MenuIcon, OnGlyph } from "../sidebar/menuIcons";
import { getStore, useStore } from "../state/store";
import { formKeys } from "./formKeys";
import { LOADING, load, type Load } from "./load";
import { Empty, MenuPageFrame } from "./MenuPage";
import { ShopOutpostsPane, useConnections, VaultPane, type ConnectionsProps } from "./ConnectionsPane";
import { GooglePane, useGoogle, type GoogleProps } from "./GooglePane";
import { thisMacRecord } from "./connections";
import { OutpostPane, useOutpost, type OutpostPaneProps } from "./OutpostPane";
import { correctionReady, groupFacts, MEMORY_START, memoryDo, memoryReduce, rememberReady, sourceLine, type MemoryAction, type MemoryDo, type MemoryUi } from "./memory";
import {
  FORM_ACTIONS,
  FORM_WHENS,
  formAsksFirst,
  formProblem,
  nameLine,
  nextLine,
  problemText,
  ROUTINES_START,
  routineDo,
  routinesReduce,
  type RoutineDo,
  type RoutineForm,
  type RoutinesAction,
  type RoutinesUi,
} from "./routines";

/** A fact's words with each run of Thai set in its own language, as the canvas does for "ค่ะ", so it is drawn in a Thai face.
 *  The baht sign sits in the Thai block but belongs to the amount beside it, so it stays out. */
function Words({ text }: { text: string }) {
  const parts = text.split(/([ก-ฺเ-๛]+)/u);
  return (
    <>
      {parts.map((part, i) =>
        i % 2 === 1 ? (
          <span key={i} lang="th">
            {part}
          </span>
        ) : (
          part || null
        ),
      )}
    </>
  );
}

const Band = ({ left, right }: { left: string; right: string }) => (
  <div className="band">
    <span>{left}</span>
    <span>{right}</span>
  </div>
);

// ---- what the team knows ------------------------------------------------------------------------------------------------

/** What the memory half needs of the page that draws it: the runtime's word on the facts, what the page itself holds (the open
 *  question, the Remember box, a request on its way), and what each button does. */
export interface MemoryPaneProps {
  state: Load<MemoryFact[]>;
  ui: MemoryUi;
  nowMs: number;
  dispatch: (a: MemoryAction) => void;
  onRemember: () => void;
  onConfirm: (id: string) => void;
  /** Save, in the open editor of this fact */
  onCorrect: (id: string) => void;
  /** Forget it, in the open question of this fact */
  onForget: (id: string) => void;
}

function FactRow({ fact, p, waiting }: { fact: MemoryFact; p: MemoryPaneProps; waiting: boolean }) {
  const { ui, dispatch } = p;
  const ask = ui.ask && ui.ask.fact === fact.id ? ui.ask : null;
  const row = waiting ? "fact-waiting" : "fact";
  const cls = waiting ? "rowl fact waits" : "rowl fact";
  const cancel = () => dispatch({ type: "cancel" });
  // Escape closes the question; an Enter or Escape that only finishes or cancels a composition does nothing (formKeys.ts).
  const keys = formKeys(cancel);

  // Correct: the fact's own words in a field, in its row. Nothing changes until Save.
  if (ask?.kind === "correct") {
    const ready = correctionReady(ask.draft, fact.text);
    return (
      <form
        className={cls}
        data-testid={row}
        data-fact={fact.id}
        onKeyDown={keys}
        onSubmit={(e) => {
          e.preventDefault();
          if (ready && !ui.busy) p.onCorrect(fact.id);
        }}
      >
        <div className="grow">
          <label className="vh" htmlFor={`fix-${fact.id}`}>
            {t("memory.correctLabel")}
          </label>
          <input id={`fix-${fact.id}`} className="input" type="text" value={ask.draft} autoFocus onChange={(e) => dispatch({ type: "draft", text: e.target.value })} data-testid="correct-input" />
        </div>
        <button type="submit" className="btn dark" disabled={ui.busy || !ready} data-testid="correct-save">
          {t("memory.save")}
        </button>
        <button type="button" className="btn" disabled={ui.busy} onClick={cancel} data-testid="correct-cancel">
          {t("memory.cancel")}
        </button>
      </form>
    );
  }

  // Forget: a question in its row, with the fact still shown and the safe answer holding the focus. Nothing is forgotten
  // until the owner says so.
  if (ask?.kind === "forget")
    return (
      <div className={cls} data-testid={row} data-fact={fact.id} onKeyDown={keys}>
        <div className="grow">
          <div className="strong">
            <Words text={fact.text} />
          </div>
          <p className="mut small" data-testid="forget-question">
            {t("memory.forgetAsk")}
          </p>
        </div>
        <button type="button" className="btn danger solid" disabled={ui.busy} onClick={() => p.onForget(fact.id)} data-testid="forget-yes">
          {t("memory.forgetYes")}
        </button>
        <button type="button" className="btn" autoFocus disabled={ui.busy} onClick={cancel} data-testid="forget-keep">
          {t("memory.keep")}
        </button>
      </div>
    );

  return (
    <div className={cls} data-testid={row} data-fact={fact.id}>
      <div className="grow">
        <div className="strong">
          <Words text={fact.text} />
        </div>
        <div className={waiting ? "small" : "mut small"}>{sourceLine(fact, p.nowMs)}</div>
      </div>
      {waiting ? (
        <>
          <span className="tag">{t("memory.notConfirmed")}</span>
          <button type="button" className="btn dark" disabled={ui.busy} onClick={() => p.onConfirm(fact.id)} data-testid="fact-confirm">
            {t("memory.itsTrue")}
          </button>
          <button type="button" className="btn" disabled={ui.busy} onClick={() => dispatch({ type: "forget", fact: fact.id })} data-testid="fact-forget">
            {t("memory.forget")}
          </button>
        </>
      ) : (
        <>
          <button type="button" className="lk" disabled={ui.busy} onClick={() => dispatch({ type: "correct", fact: fact.id, text: fact.text })} aria-label={`${t("memory.correct")}: ${fact.text}`} data-testid="fact-correct">
            {t("memory.correct")}
          </button>
          <button type="button" className="lk" disabled={ui.busy} onClick={() => dispatch({ type: "forget", fact: fact.id })} aria-label={`${t("memory.forget")}: ${fact.text}`} data-testid="fact-forget">
            {t("memory.forget")}
          </button>
        </>
      )}
    </div>
  );
}

function MemoryPane(p: MemoryPaneProps) {
  const { state, ui } = p;
  const loading = state.kind === "loading";
  const { known, waiting } = state.kind === "ready" ? groupFacts(state.value) : { known: [], waiting: [] };
  return (
    <div className="pane" data-testid="memory-pane" aria-busy={loading || undefined}>
      {ui.error && (
        <p className="msg err" role="alert" data-testid="memory-error">
          {ui.error}
        </p>
      )}
      <div className="part" data-testid="memory-known">
        <Band left={t("memory.known")} right={t("memory.from")} />
        {loading && (
          <p className="none" data-testid="memory-loading">
            {t("memory.loading")}
          </p>
        )}
        {state.kind === "unavailable" && (
          <p className="none" role="status" data-testid="memory-unavailable">
            {state.message}
          </p>
        )}
        {state.kind === "ready" && known.length === 0 && <Empty icon={<MenuIcon row="customize" />} title={t("customize.emptyTitle")} text={t("customize.emptyText")} testId="customize-empty" />}
        {known.map((f) => (
          <FactRow key={f.id} fact={f} p={p} waiting={false} />
        ))}
      </div>
      {waiting.length > 0 && (
        <div className="part" data-testid="memory-waiting">
          <Band left={t("memory.waiting")} right={t("memory.waitingNote")} />
          {waiting.map((f) => (
            <FactRow key={f.id} fact={f} p={p} waiting />
          ))}
        </div>
      )}
      {state.kind === "ready" && (
        <form
          className="box remember"
          data-testid="remember-form"
          onKeyDown={formKeys()}
          onSubmit={(e) => {
            e.preventDefault();
            if (rememberReady(ui.add) && !ui.busy) p.onRemember();
          }}
        >
          <label className="vh" htmlFor="remember">
            {t("memory.rememberLabel")}
          </label>
          <input id="remember" className="askin" type="text" placeholder={t("memory.rememberLabel")} value={ui.add} onChange={(e) => p.dispatch({ type: "add", text: e.target.value })} data-testid="remember-input" />
          <button type="submit" className="btn dark" disabled={ui.busy || !rememberReady(ui.add)} data-testid="remember-submit">
            {t("memory.remember")}
          </button>
        </form>
      )}
    </div>
  );
}

// ---- the team's routines ------------------------------------------------------------------------------------------------

/** What the routines half needs of the page that draws it, as the memory half's. */
export interface RoutinesPaneProps {
  state: Load<RoutineRow[]>;
  ui: RoutinesUi;
  nowMs: number;
  dispatch: (a: RoutinesAction) => void;
  /** the form's Add routine */
  onAdd: () => void;
  /** a routine's switch: pauses it when it is on and resumes it when it is off */
  onSwitch: (row: RoutineRow) => void;
}

/** Monday first, as a shop's week runs; a weekday is 0 for Sunday, as the package counts. */
const WEEK = [1, 2, 3, 4, 5, 6, 0] as const;
/** A day of the week by its short name in the page's language. 2023-01-01 was a Sunday. */
const dayName = (d: number) => weekdayName(new Date(2023, 0, 1 + d));
const MONTH_DAYS = Array.from({ length: 28 }, (_, i) => i + 1);

function RoutineFormView({ p, f }: { p: RoutinesPaneProps; f: RoutineForm }) {
  const set = (patch: Partial<RoutineForm>) => p.dispatch({ type: "set", patch });
  const busy = p.ui.saving;
  const timeOfDay = f.when === "daily" || f.when === "weekly" || f.when === "monthly";
  return (
    <form
      className="box rform"
      aria-label={t("routines.form.title")}
      data-testid="routine-form"
      onKeyDown={formKeys(() => p.dispatch({ type: "close" }))}
      onSubmit={(e) => {
        e.preventDefault();
        if (!busy) p.onAdd();
      }}
    >
      <div className="field">
        <label htmlFor="routine-name">{t("routines.form.does")}</label>
        <input id="routine-name" className="input" type="text" value={f.name} placeholder={t("routines.form.doesHint")} autoFocus disabled={busy} onChange={(e) => set({ name: e.target.value })} />
      </div>
      <div className="field">
        <label htmlFor="routine-kind">{t("routines.form.kind")}</label>
        <select id="routine-kind" className="input" value={f.action} disabled={busy} onChange={(e) => set({ action: e.target.value as RoutineForm["action"] })} data-testid="routine-kind">
          {FORM_ACTIONS.map((a) => (
            <option key={a} value={a}>
              {t(`routines.kind.${a}`)}
            </option>
          ))}
        </select>
        {formAsksFirst(f) && (
          <p className="help" data-testid="routine-asks">
            <span className="tag">{t("routines.asksFirst")}</span> {t("routines.form.asks")}
          </p>
        )}
      </div>
      <div className="field">
        <label htmlFor="routine-when">{t("routines.form.when")}</label>
        <select id="routine-when" className="input" value={f.when} disabled={busy} onChange={(e) => set({ when: e.target.value as RoutineForm["when"] })} data-testid="routine-when">
          {FORM_WHENS.map((w) => (
            <option key={w} value={w}>
              {t(`routines.when.${w}`)}
            </option>
          ))}
        </select>
      </div>
      {f.when === "weekly" && (
        <fieldset className="field days" data-testid="routine-days">
          <legend>{t("routines.form.days")}</legend>
          <div className="chips">
            {WEEK.map((d) => (
              <label key={d} className={f.weekdays.includes(d) ? "daychip on" : "daychip"}>
                <input type="checkbox" value={d} checked={f.weekdays.includes(d)} disabled={busy} onChange={() => p.dispatch({ type: "weekday", day: d })} />
                {dayName(d)}
              </label>
            ))}
          </div>
        </fieldset>
      )}
      {f.when === "monthly" && (
        <div className="field">
          <label htmlFor="routine-day">{t("routines.form.day")}</label>
          <select id="routine-day" className="input" value={f.day} disabled={busy} onChange={(e) => set({ day: e.target.value })} data-testid="routine-day">
            {MONTH_DAYS.map((n) => (
              <option key={n} value={String(n)}>
                {n}
              </option>
            ))}
            <option value="last">{t("routines.form.dayLast")}</option>
          </select>
        </div>
      )}
      {f.when === "window" && (
        <div className="pair">
          <div className="field">
            <label htmlFor="routine-from">{t("routines.form.from")}</label>
            <input id="routine-from" className="input" type="time" value={f.from} disabled={busy} onChange={(e) => set({ from: e.target.value })} />
          </div>
          <div className="field">
            <label htmlFor="routine-to">{t("routines.form.to")}</label>
            <input id="routine-to" className="input" type="time" value={f.to} disabled={busy} onChange={(e) => set({ to: e.target.value })} />
          </div>
        </div>
      )}
      {f.when === "stock" && (
        <div className="field">
          <label htmlFor="routine-threshold">{t("routines.form.threshold")}</label>
          <input id="routine-threshold" className="input" type="number" min="1" step="1" value={f.threshold} disabled={busy} onChange={(e) => set({ threshold: e.target.value })} />
        </div>
      )}
      {timeOfDay && (
        <div className="field">
          <label htmlFor="routine-at">{t("routines.form.at")}</label>
          <input id="routine-at" className="input" type="time" value={f.at} disabled={busy} onChange={(e) => set({ at: e.target.value })} />
        </div>
      )}
      {p.ui.problem && (
        <p className="msg err" role="alert" data-testid="routine-problem">
          {problemText(p.ui.problem)}
        </p>
      )}
      <div className="chips">
        <button type="submit" className="btn dark" disabled={busy} data-testid="routine-add">
          {t("routines.form.add")}
        </button>
        <button type="button" className="btn" disabled={busy} onClick={() => p.dispatch({ type: "close" })} data-testid="routine-cancel">
          {t("routines.form.cancel")}
        </button>
      </div>
    </form>
  );
}

function RoutineLine({ row, p }: { row: RoutineRow; p: RoutinesPaneProps }) {
  const next = nextLine(row, p.nowMs);
  return (
    <div className="tr" data-testid="routine" data-routine={row.id}>
      <div className="grow">
        <div className="mut small">{row.when}</div>
        <div className="strong">{nameLine(row)}</div>
        {!row.enabled ? <div className="mut small">{t("routines.paused")}</div> : next && <div className="mut small">{next}</div>}
      </div>
      <button
        type="button"
        className="sw"
        role="switch"
        aria-checked={row.enabled}
        aria-label={row.name}
        disabled={p.ui.saving || p.ui.switching !== null}
        onClick={() => p.onSwitch(row)}
        data-testid="routine-switch"
      />
    </div>
  );
}

/** The Automations and Plugins pages, offered only when the runtime has them. */
export interface CustomizeEntries {
  /** how many scheduled jobs there are, and the page's opener */
  automations?: { count: number; open: () => void };
  plugins?: { open: () => void };
}

function RoutinesPane({ p, automations, plugins }: { p: RoutinesPaneProps } & CustomizeEntries) {
  const { state, ui } = p;
  const loading = state.kind === "loading";
  const rows = state.kind === "ready" ? state.value : [];
  return (
    <aside className="side2" data-testid="routines" aria-busy={loading || undefined}>
      <div className="rhead">
        <h2 className="h2">{t("routines.title")}</h2>
        {state.kind === "ready" && (
          <button type="button" className="btn" disabled={ui.saving} onClick={() => p.dispatch({ type: "open" })} data-testid="routine-new">
            <svg className="ic" viewBox="0 0 16 16" aria-hidden="true">
              <path d="M8 3v10M3 8h10" />
            </svg>
            {t("routines.new")}
          </button>
        )}
      </div>
      <p className="hint">{t("routines.hint")}</p>
      {ui.error && (
        <p className="msg err" role="alert" data-testid="routines-error">
          {ui.error}
        </p>
      )}
      {state.kind === "ready" && ui.form && <RoutineFormView p={p} f={ui.form} />}
      {loading && (
        <p className="none" data-testid="routines-loading">
          {t("routines.loading")}
        </p>
      )}
      {state.kind === "unavailable" && (
        <p className="none" role="status" data-testid="routines-unavailable">
          {state.message}
        </p>
      )}
      {state.kind === "ready" && rows.length === 0 && (
        <p className="none" data-testid="routines-empty">
          {t("routines.empty")}
        </p>
      )}
      {rows.map((r) => (
        <RoutineLine key={r.id} row={r} p={p} />
      ))}
      {state.kind === "ready" && (
        <div data-testid="routines-words">
          <p className="hint">{t("routines.words")}</p>
          <p className="hint">{t("routines.wordsNotYet")}</p>
        </div>
      )}
      {(automations || plugins) && (
        <ul className="rows entries">
          {automations && (
            <li>
              <button type="button" className="rowl" onClick={automations.open} data-testid="nav-automations">
                <span className="grow">
                  <span className="l1">{t("nav.automations")}</span>
                  <span className="l2">{t("customize.automations")}</span>
                </span>
                {automations.count > 0 && <span className="when">{automations.count}</span>}
                <OnGlyph />
              </button>
            </li>
          )}
          {plugins && (
            <li>
              <button type="button" className="rowl" onClick={plugins.open} data-testid="nav-plugins">
                <span className="grow">
                  <span className="l1">{t("nav.plugins")}</span>
                  <span className="l2">{t("customize.plugins")}</span>
                </span>
                <OnGlyph />
              </button>
            </li>
          )}
        </ul>
      )}
    </aside>
  );
}

/** The page's two tabs, as the canvas draws them in the top bar (Brain.dc.html, Connections.dc.html). The canvas's third,
 *  Budget and plan, waits for the owner's billing page. */
export type CustomizeTab = "memory" | "connections";

const TABS: readonly CustomizeTab[] = ["memory", "connections"];

export function CustomizeView({
  memory,
  routines,
  automations,
  plugins,
  tab = "memory",
  onTab,
  connections,
  vault,
  google,
}: {
  memory: MemoryPaneProps;
  routines: RoutinesPaneProps;
  /** the tab shown; Memory and routines unless told */
  tab?: CustomizeTab;
  /** with it, the tabs are drawn and switch the page */
  onTab?: (tab: CustomizeTab) => void;
  /** the Connections tab's Outposts box for this Mac */
  connections?: OutpostPaneProps;
  /** the Connections tab's vault and the shop's outposts, on a runtime that answers them */
  vault?: ConnectionsProps | null;
  /** the Connections tab's Google Sheets row for the shop's owner, on a runtime that answers it */
  google?: GoogleProps | null;
} & CustomizeEntries): ReactNode {
  const tabs = onTab && (
    <div className="tabs" role="tablist" aria-label={t("menu.customize")}>
      {TABS.map((id) => (
        <button
          key={id}
          type="button"
          role="tab"
          className={tab === id ? "tab on" : "tab"}
          aria-selected={tab === id}
          onClick={() => onTab(id)}
          data-testid={`customize-tab-${id}`}
        >
          {id === "memory" ? t("customize.tab.memory") : t("customize.tab.connections")}
        </button>
      ))}
    </div>
  );
  const showConnections = tab === "connections" && connections !== undefined;
  // This Mac's own record on the shop's list, which its row takes in once the shell says which outpost it is (the list then
  // leaves it out), so the owner never sees this Mac twice.
  const fold = vault ? { p: vault, record: thisMacRecord(vault.state, connections?.thisMac ?? null) } : undefined;
  return (
    <MenuPageFrame
      page="customize"
      title={t("menu.customize")}
      hideTitle={!!tabs}
      middle={tabs || undefined}
      acts={showConnections ? undefined : <span className="mut small">{t("memory.lead")}</span>}
    >
      {showConnections ? (
        <div className="brain conn" data-testid="connections">
          <div className="conncol">
            {google && <GooglePane p={google} />}
            {vault && <VaultPane p={vault} />}
            <OutpostPane {...connections} fold={fold} />
            {vault && <ShopOutpostsPane p={vault} thisMac={fold?.record?.id ?? null} />}
          </div>
        </div>
      ) : (
        <div className="brain">
          <MemoryPane {...memory} />
          <RoutinesPane p={routines} automations={automations} plugins={plugins} />
        </div>
      )}
    </MenuPageFrame>
  );
}

export function CustomizePage() {
  const s = useStore();
  const [tab, setTab] = useState<CustomizeTab>("memory");
  const outpost = useOutpost(s.shops.current, s.shops.list);
  const vault = useConnections(tab === "connections", s.shops.current);
  const google = useGoogle(tab === "connections", s.shops.current, () => s.openPage("needs"));
  const [facts, setFacts] = useState<Load<MemoryFact[]>>(LOADING);
  const [rows, setRows] = useState<Load<RoutineRow[]>>(LOADING);
  const [memoryUi, memoryDispatch] = useReducer(memoryReduce, MEMORY_START);
  const [routinesUi, routinesDispatch] = useReducer(routinesReduce, ROUTINES_START);
  // Each half is read when the page opens, and on its own: the connected runtime shows routines but not memory.
  useEffect(() => {
    let live = true;
    void load(async () => (await getStore().actions.memoryList()).facts).then((r) => live && setFacts(r));
    void load(async () => (await getStore().actions.routineList()).routines).then((r) => live && setRows(r));
    return () => {
      live = false;
    };
  }, []);

  const remember = async (todo: MemoryDo) => {
    if (facts.kind !== "ready") return;
    memoryDispatch({ type: "begin" });
    const step = await memoryDo(s, facts.value, todo);
    setFacts({ kind: "ready", value: step.facts });
    memoryDispatch(step.action);
  };
  const routine = async (todo: RoutineDo) => {
    if (rows.kind !== "ready") return;
    routinesDispatch(todo.what === "save" ? { type: "begin", what: "save" } : { type: "begin", what: "switch", routine: todo.row.id });
    const step = await routineDo(s, rows.value, todo);
    setRows({ kind: "ready", value: step.rows });
    routinesDispatch(step.action);
  };

  const memory: MemoryPaneProps = {
    state: facts,
    ui: memoryUi,
    nowMs: Date.now(),
    dispatch: memoryDispatch,
    onRemember: () => void remember({ what: "remember", text: memoryUi.add }),
    onConfirm: (fact) => void remember({ what: "confirm", fact }),
    onCorrect: (fact) => {
      const ask = memoryUi.ask;
      if (ask?.kind === "correct" && ask.fact === fact) void remember({ what: "correct", fact, text: ask.draft });
    },
    onForget: (fact) => void remember({ what: "forget", fact }),
  };
  const routines: RoutinesPaneProps = {
    state: rows,
    ui: routinesUi,
    nowMs: Date.now(),
    dispatch: routinesDispatch,
    onAdd: () => {
      const form = routinesUi.form;
      if (!form) return;
      // The package says whether this is a routine, before anything is sent; the runtime says it again.
      const problem = formProblem(form);
      if (problem) routinesDispatch({ type: "problem", reason: problem });
      else void routine({ what: "save", form });
    },
    onSwitch: (row) => void routine({ what: "switch", row }),
  };
  return (
    <CustomizeView
      memory={memory}
      routines={routines}
      automations={can("automations") ? { count: s.automations?.length ?? 0, open: () => s.openAutomations() } : undefined}
      plugins={can("plugins") ? { open: () => s.openPlugins() } : undefined}
      tab={tab}
      onTab={setTab}
      connections={outpost}
      vault={vault}
      google={google}
    />
  );
}
