// The activity log, as the design canvas draws it (Activity.dc.html): every event of the shop, newest first and grouped by
// day, with the time, who did it, what happened, what it was about, who approved and how it ended. Filters for who, kind and
// date, a search, an event's details beside the list, and an export to CSV. It is History's second tab and returns there.
// The rules (filters, days, the customer's hidden text, the file) are activity.ts and csv.ts; this file draws them.
//
// A customer's message text stays hidden until the owner shows it for that event, is never searched, and is left out of an
// export unless that export ticks "Include customer message text". Saving a file needs the shell's save dialog, which the
// desktop does not have yet (saveFile.ts), so Download CSV says "not yet" once it has made the file it would save.
import { useEffect, useReducer, useRef, useState, type ReactNode } from "react";
import "./mission.css";
import { hhmm, monthDay } from "../app/time";
import { t, type Key } from "../i18n";
import type { ShopRow } from "../lib/protocol";
import { helpedShop } from "../lib/shops";
import { OWNER, ACTIVITY_KINDS, type ActivityEvent, type ActivityKind, type OlderState } from "../runtime/mission";
import { selectSidebarBots, getStore, useStore } from "../state/store";
import { MenuIcon, SearchGlyph } from "../sidebar/menuIcons";
import { Avatar } from "../ui";
import {
  ALL,
  EXPORT_START,
  exportCsv,
  exportEvents,
  exportReduce,
  filterEvents,
  filterReduce,
  filtersOn,
  groupDays,
  NO_FILTERS,
  parseDay,
  RANGES,
  SAVE_NOT_YET,
  selectedEvent,
  textView,
  type ExportAction,
  type ExportState,
  type ExportWords,
  type FilterAction,
  type Filters,
  type Range,
} from "./activity";
import { dayBand } from "./history";
import { LOADING, load, type Load } from "./load";
import { Empty, MenuPageFrame } from "./MenuPage";
import { useShowOlder, type OlderView } from "./older";
import { OwnersOnly } from "./OwnersOnly";
import { saveCsv, type SaveResult } from "./saveFile";
import { ShowOlder } from "./ShowOlder";

export interface Person {
  id: string;
  label: string;
}

type Log = { events: ActivityEvent[]; keptMonths: number | null; older?: OlderState };

export interface ActivityViewProps {
  load: Load<Log>;
  nowMs: number;
  filters: Filters;
  onFilter: (a: FilterAction) => void;
  /** the people the Who chips offer after Everyone: the team in its order, then the owner */
  people: readonly Person[];
  /** a person's round face */
  face: (who: string) => ReactNode;
  /** a person's name and what they do, for the details */
  person: (who: string) => { name: string; role: string };
  pickedId: string | null;
  onPick: (id: string) => void;
  /** the events whose private message text the owner chose to show */
  shown: ReadonlySet<string>;
  onShow: (id: string) => void;
  onHide: (id: string) => void;
  exporting: ExportState;
  onExport: (a: ExportAction) => void;
  onDownload: () => void;
  /** the "Jobs and chats" tab: back to History */
  onBack: () => void;
  onOpenJob: (id: string) => void;
  /** the runtime has older events than the log holds, or Show older has shown all of them (older.ts): the line and the button under the list */
  older?: OlderView;
  /** The shop shown, when the person only helps there: its activity log is its owner's, so the page says whose it is and
   *  draws no event, filter or export. */
  helped?: Pick<ShopRow, "name" | "owner"> | null;
  /** opens Needs you, from the words a helper's shop shows */
  onNeeds?: () => void;
}

const KIND_KEY: Record<ActivityKind, Key> = {
  msg: "act.kind.msg",
  money: "act.kind.money",
  post: "act.kind.post",
  code: "act.kind.code",
  signin: "act.kind.signin",
  settings: "act.kind.settings",
};
const RANGE_KEY: Record<Range, Key> = { today: "act.range.today", "7": "act.range.7", "30": "act.range.30", custom: "act.range.custom" };
/** How an event ended, in the canvas's words and colours: green is done, amber waits on the owner. */
const STATUS: Record<string, { word: Key; cls: string }> = {
  sent: { word: "act.st.sent", cls: "tag ok" },
  checked: { word: "act.st.checked", cls: "tag ok" },
  posted: { word: "act.st.posted", cls: "tag ok" },
  used: { word: "act.st.used", cls: "tag" },
  changed: { word: "act.st.changed", cls: "tag" },
  needs_you: { word: "act.st.needs", cls: "tag warn" },
  drafted: { word: "act.st.drafted", cls: "tag" },
};
/** A status the app does not know is shown as the runtime wrote it, never dropped. */
const statusTag = (status: string): { text: string; cls: string } => {
  const known = STATUS[status];
  return known ? { text: t(known.word), cls: known.cls } : { text: status, cls: "tag" };
};

const kindLabel = (k: ActivityKind) => t(KIND_KEY[k]);
const dayText = (ms: number) => monthDay(new Date(ms));

/** "12 events in the last 7 days", "1 event today", "2 events from Nov 16 to Nov 19": the canvas's count line. */
function countLine(n: number, f: Filters): string {
  const lo = parseDay(f.from);
  const hi = parseDay(f.to);
  const range =
    f.range !== "custom"
      ? t(`act.in.${f.range}` as Key)
      : lo !== null && hi !== null
        ? t("act.in.custom", { from: dayText(Math.min(lo, hi)), to: dayText(Math.max(lo, hi)) })
        : lo !== null
          ? t("act.in.since", { from: dayText(lo) })
          : hi !== null
            ? t("act.in.until", { to: dayText(hi) })
            : t("act.in.any");
  return t("act.countLine", { count: n === 1 ? t("act.nEvent") : t("act.nEvents", { n }), range });
}

/** The words an export is written in, in the owner's language. `nameOf` says a person's name. */
export function activityWords(nameOf: (who: string) => string): ExportWords {
  return {
    header: [t("act.csv.date"), t("act.csv.time"), t("act.who"), t("act.dt.kind"), t("act.csv.event"), t("act.dt.item"), t("act.dt.approved"), t("act.csv.status"), t("act.dt.where"), t("act.dt.undo"), t("act.csv.note"), t("act.csv.text")],
    who: nameOf,
    kind: kindLabel,
    status: (s) => statusTag(s).text,
  };
}

const pad = (n: number) => String(n).padStart(2, "0");
/** The file's name: the day it was made. */
export function csvName(nowMs: number): string {
  const d = new Date(nowMs);
  return `manut-activity-${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}.csv`;
}

/** Makes the file the export describes and hands it to the saver. "nothing" when no kind is chosen, so no file is made. */
export async function downloadCsv(
  events: readonly ActivityEvent[],
  x: ExportState,
  nowMs: number,
  words: ExportWords,
  save: (name: string, text: string) => Promise<SaveResult> = saveCsv,
): Promise<SaveResult | "nothing"> {
  if (x.kinds.length === 0) return "nothing";
  return save(csvName(nowMs), exportCsv(events, x, nowMs, words));
}

function Glyph({ d }: { d: string }) {
  return (
    <svg className="ic" viewBox="0 0 16 16" aria-hidden="true">
      <path d={d} />
    </svg>
  );
}

function Chip({ on, onClick, id, children }: { on: boolean; onClick: () => void; id: string; children: ReactNode }) {
  return (
    <button type="button" className="fchip" aria-pressed={on} onClick={onClick} data-testid={id}>
      {children}
    </button>
  );
}

function Check({ on, onClick, id, label, labelledby, describedby }: { on: boolean; onClick: () => void; id: string; label?: string; labelledby?: string; describedby?: string }) {
  return (
    <button
      type="button"
      className="check"
      role="checkbox"
      aria-checked={on}
      aria-label={label}
      aria-labelledby={labelledby}
      aria-describedby={describedby}
      onClick={onClick}
      data-testid={id}
    >
      <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M3.5 8.5l3 3 6-7" />
      </svg>
    </button>
  );
}

function ExportDialog({ log, p }: { log: Log; p: ActivityViewProps }) {
  const x = p.exporting;
  const rows = exportEvents(log.events, x, p.nowMs).length;
  const none = x.kinds.length === 0;
  return (
    <div
      className="dialog"
      id="act-export"
      role="dialog"
      aria-labelledby="exp-title"
      aria-describedby="exp-desc"
      onKeyDown={(e) => e.key === "Escape" && p.onExport({ type: "close" })}
      data-testid="act-export-dialog"
    >
      <div className="dh">
        <h3 id="exp-title">{t("act.exp.title")}</h3>
        <button type="button" className="ib" aria-label={t("pn.close")} onClick={() => p.onExport({ type: "close" })} data-testid="act-export-close">
          <Glyph d="M4 4l8 8M12 4l-8 8" />
        </button>
      </div>
      <p id="exp-desc" className="mut">
        {t("act.exp.desc")}
      </p>
      <div className="field">
        <span className="lab" id="exp-range-l">
          {t("act.exp.range")}
        </span>
        <div className="modes" role="group" aria-labelledby="exp-range-l">
          {RANGES.map((r) => (
            <button key={r} type="button" className="mode" aria-pressed={x.range === r} onClick={() => p.onExport({ type: "range", range: r })} data-testid={`act-export-range-${r}`}>
              {t(RANGE_KEY[r])}
            </button>
          ))}
        </div>
        {x.range === "custom" && (
          <div className="pair">
            <div className="field">
              <label htmlFor="exp-from">{t("act.from")}</label>
              <input id="exp-from" className="input" type="date" value={x.from} onChange={(e) => p.onExport({ type: "from", from: e.target.value })} />
            </div>
            <div className="field">
              <label htmlFor="exp-to">{t("act.to")}</label>
              <input id="exp-to" className="input" type="date" value={x.to} onChange={(e) => p.onExport({ type: "to", to: e.target.value })} />
            </div>
          </div>
        )}
      </div>
      <div className="field">
        <span className="lab" id="exp-kinds-l">
          {t("act.exp.kinds")}
        </span>
        <div className="kinds" role="group" aria-labelledby="exp-kinds-l">
          {ACTIVITY_KINDS.map((k) => (
            <span key={k} className="kind">
              <Check on={x.kinds.includes(k)} onClick={() => p.onExport({ type: "kind", kind: k })} id={`act-export-kind-${k}`} label={kindLabel(k)} />
              <span>{kindLabel(k)}</span>
            </span>
          ))}
        </div>
      </div>
      <div className="soft textrow">
        <Check on={x.text} onClick={() => p.onExport({ type: "text" })} id="act-export-text" labelledby="exp-text-l" describedby="exp-text-h" />
        <span className="textwords">
          <span id="exp-text-l" className="strong">
            {t("act.exp.text")}
          </span>
          <span id="exp-text-h" className="help">
            {t("act.exp.textHelp")}
          </span>
        </span>
      </div>
      {x.note === "not_yet" && (
        <p className="hint" role="status" data-testid="act-export-notyet">
          {t("act.exp.notYet")}
        </p>
      )}
      <div className="dfoot">
        <span className="mut count">{none ? t("act.exp.noKind") : rows === 1 ? t("act.exp.row1") : t("act.exp.rows", { n: rows })}</span>
        <span className="dbtns">
          <button type="button" className="btn ghost" onClick={() => p.onExport({ type: "close" })} data-testid="act-export-cancel">
            {t("act.exp.cancel")}
          </button>
          <button type="button" className="btn dark" aria-disabled={none} onClick={() => !none && p.onDownload()} data-testid="act-export-go">
            {t("act.exp.go")}
          </button>
        </span>
      </div>
    </div>
  );
}

function Details({ e, p }: { e: ActivityEvent; p: ActivityViewProps }) {
  const who = p.person(e.who);
  const st = statusTag(e.status);
  const band = dayBand({ day: midnight(e.at * 1000), when: dayWhen(e.at, p.nowMs) }, p.nowMs);
  const day = band.date ? `${band.label}, ${band.date}` : band.label;
  const text = textView(e, p.shown);
  return (
    <>
      <div className="dh">
        <h2 className="h2">{t("act.details")}</h2>
        <span className={st.cls}>{st.text}</span>
      </div>
      <div className="whoid">
        {p.face(e.who)}
        <div>
          <div className="strong">{who.name}</div>
          <div className="mut small">{who.role}</div>
        </div>
      </div>
      <p className="big">{e.title}</p>
      <dl className="box dl">
        <div className="tr first">
          <dt className="mut">{t("act.dt.when")}</dt>
          <dd>{t("act.when", { day, time: hhmm(new Date(e.at * 1000)) })}</dd>
        </div>
        <div className="tr">
          <dt className="mut">{t("act.dt.kind")}</dt>
          <dd>{kindLabel(e.kind)}</dd>
        </div>
        <div className="tr">
          <dt className="mut">{t("act.dt.item")}</dt>
          <dd>{e.item}</dd>
        </div>
        <div className="tr">
          <dt className="mut">{t("act.dt.approved")}</dt>
          <dd>{e.approval}</dd>
        </div>
        <div className="tr">
          <dt className="mut">{t("act.dt.where")}</dt>
          <dd>{e.where}</dd>
        </div>
        <div className="tr">
          <dt className="mut">{t("act.dt.undo")}</dt>
          <dd>{e.undo}</dd>
        </div>
      </dl>
      {e.note && <p className="note">{e.note}</p>}
      {text.kind === "hidden" && (
        <div className="soft hid">
          <span className="grow">
            <span className="strong">{t("act.hidden")}</span>
            <span className="mut">{t("act.hiddenHint")}</span>
          </span>
          <button type="button" className="btn" onClick={() => p.onShow(e.id)} data-testid="act-show">
            {t("act.show")}
          </button>
        </div>
      )}
      {text.kind === "shown" && (
        <div className="soft shown">
          <div className="lab2">
            <span className="mut">{text.private ? t("act.msgSent") : t("act.postText")}</span>
            {text.canHide && (
              <button type="button" className="lk" onClick={() => p.onHide(e.id)} data-testid="act-hide">
                {t("act.hide")}
              </button>
            )}
          </div>
          <p className="prose" lang="th">
            {text.body}
          </p>
        </div>
      )}
      {e.job && (
        <div className="chips">
          <button type="button" className="btn" onClick={() => p.onOpenJob(e.job as string)} data-testid="act-open-job">
            {t("act.open", { item: e.item })}
          </button>
        </div>
      )}
    </>
  );
}

const midnight = (ms: number) => {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
};

/** Which of History's day names a moment has, as byDay says it: today, yesterday or an earlier day. */
function dayWhen(atSec: number, nowMs: number): "today" | "yesterday" | "earlier" {
  const age = Math.round((midnight(nowMs) - midnight(atSec * 1000)) / 86_400_000);
  return age <= 0 ? "today" : age === 1 ? "yesterday" : "earlier";
}

export function ActivityView(p: ActivityViewProps) {
  const log = p.load.kind === "ready" ? p.load.value : null;
  const f = p.filters;
  const visible = log ? filterEvents(log.events, f, p.nowMs, kindLabel) : [];
  const days = groupDays(visible, p.nowMs);
  const sel = selectedEvent(visible, p.pickedId);
  const tabs = (
    <div className="tabs" role="group" aria-label={t("menu.history")}>
      <button type="button" className="tab" onClick={p.onBack} data-testid="act-tab-jobs">
        {t("act.tab.jobs")}
      </button>
      <button type="button" className="tab on" aria-current="page" data-testid="act-tab-log">
        {t("act.title")}
      </button>
    </div>
  );
  if (p.helped)
    return (
      <MenuPageFrame page="activity" title={t("act.title")} hideTitle middle={tabs}>
        <div className="actv">
          <OwnersOnly shop={p.helped} screen="activity" icon={<MenuIcon row="history" />} onNeeds={p.onNeeds} />
        </div>
      </MenuPageFrame>
    );
  const full = !!log && log.events.length > 0;
  const acts = full && (
    <>
      <form className="find" role="search" onSubmit={(e) => e.preventDefault()}>
        <SearchGlyph />
        <label className="vh" htmlFor="act-find">
          {t("act.find")}
        </label>
        <input
          id="act-find"
          type="search"
          placeholder={t("act.findPh")}
          value={f.query}
          autoComplete="off"
          spellCheck={false}
          onChange={(e) => p.onFilter({ type: "query", query: e.target.value })}
          data-testid="act-find"
        />
      </form>
      <button type="button" className="btn" aria-haspopup="dialog" aria-expanded={p.exporting.open} aria-controls="act-export" onClick={() => p.onExport({ type: p.exporting.open ? "close" : "open" })} data-testid="act-export">
        <Glyph d="M8 2.5v8M4.5 7.5L8 11l3.5-3.5M3 13.5h10" />
        {t("act.export")}
      </button>
    </>
  );
  const frame = (body: ReactNode) => (
    <MenuPageFrame page="activity" title={t("act.title")} hideTitle middle={tabs} acts={acts || undefined}>
      <div className="actv">{body}</div>
    </MenuPageFrame>
  );

  if (p.load.kind === "loading")
    return frame(
      <p className="none" role="status" data-testid="act-loading">
        {t("act.loading")}
      </p>,
    );
  if (p.load.kind === "unavailable")
    return frame(
      <div className="off" role="alert" data-testid="act-unavailable">
        <h2>{t("act.unavailable")}</h2>
        <p>{p.load.message}</p>
      </div>,
    );
  if (!full || !log)
    return frame(
      <>
        <Empty icon={<MenuIcon row="history" />} title={t("act.emptyTitle")} text={t("act.emptyText")} testId="act-empty" />
        {p.older && <ShowOlder view={p.older} />}
      </>,
    );

  const person = (id: string, label: string) => (
    <Chip key={id} on={f.who === id} onClick={() => p.onFilter({ type: "who", who: id })} id={`act-who-${id}`}>
      {id === ALL ? <Glyph d="M6 3.8a2.2 2.2 0 100 4.4 2.2 2.2 0 000-4.4zM2 13c.4-2.2 2-3.3 4-3.3s3.6 1.1 4 3.3M11 4.2a2 2 0 010 3.8M12 9.9c1.3.4 2 1.4 2.3 3.1" /> : p.face(id)}
      {label}
    </Chip>
  );

  return frame(
    <>
      <div className="filters">
        <div className="frow">
          <span className="lab" id="act-who-l">
            {t("act.who")}
          </span>
          <div role="group" aria-labelledby="act-who-l" className="fgroup">
            {person(ALL, t("act.everyone"))}
            {p.people.map((x) => person(x.id, x.label))}
          </div>
        </div>
        <div className="frow">
          <span className="lab" id="act-kind-l">
            {t("act.kind")}
          </span>
          <div role="group" aria-labelledby="act-kind-l" className="fgroup">
            <Chip on={f.kind === ALL} onClick={() => p.onFilter({ type: "kind", kind: ALL })} id="act-kind-all">
              {t("act.allKinds")}
            </Chip>
            {ACTIVITY_KINDS.map((k) => (
              <Chip key={k} on={f.kind === k} onClick={() => p.onFilter({ type: "kind", kind: k })} id={`act-kind-${k}`}>
                {kindLabel(k)}
              </Chip>
            ))}
          </div>
          <span className="lab datel" id="act-date-l">
            {t("act.date")}
          </span>
          <div role="group" aria-labelledby="act-date-l" className="fgroup">
            {RANGES.map((r) => (
              <Chip key={r} on={f.range === r} onClick={() => p.onFilter({ type: "range", range: r })} id={`act-range-${r}`}>
                {t(RANGE_KEY[r])}
              </Chip>
            ))}
          </div>
          {f.range === "custom" && (
            <div className="pair small">
              <label htmlFor="act-from">{t("act.from")}</label>
              <input id="act-from" className="input" type="date" value={f.from} onChange={(e) => p.onFilter({ type: "from", from: e.target.value })} />
              <label htmlFor="act-to">{t("act.to")}</label>
              <input id="act-to" className="input" type="date" value={f.to} onChange={(e) => p.onFilter({ type: "to", to: e.target.value })} />
            </div>
          )}
        </div>
        <div className="frow count">
          <p aria-live="polite" className="countline" data-testid="act-count">
            {countLine(visible.length, f)}
          </p>
          {filtersOn(f) && (
            <button type="button" className="lk" onClick={() => p.onFilter({ type: "clear" })} data-testid="act-clear">
              {t("act.clear")}
            </button>
          )}
          {/* A runtime that keeps no fixed span says null, and the page then claims none. */}
          {log.keptMonths !== null && <span className="mut kept">{t("act.kept", { n: log.keptMonths })}</span>}
        </div>
      </div>
      {p.exporting.open && <ExportDialog log={log} p={p} />}
      <div className="split">
        <div className="list">
          {days.map((d) => {
            const band = dayBand(d, p.nowMs);
            return (
              <section key={d.day} className="day" aria-label={band.label}>
                <div className="band">
                  <span>{band.label}</span>
                  {band.date && <span>{band.date}</span>}
                </div>
                {d.events.map((e) => {
                  const st = statusTag(e.status);
                  const on = e.id === sel?.id;
                  return (
                    <div key={e.id} className={`rowl ev${on ? " on" : ""}`} data-testid="act-row">
                      <span className="when">{hhmm(new Date(e.at * 1000))}</span>
                      <span className="who" aria-hidden="true">
                        {p.face(e.who)}
                      </span>
                      <span className="grow evmain">
                        <button type="button" className="evtitle" aria-pressed={on} aria-controls="act-detail" onClick={() => p.onPick(e.id)} data-testid={`act-pick-${e.id}`}>
                          {e.title}
                        </button>
                        <span className="mut evsub">
                          <span>{kindLabel(e.kind)}</span>
                          {e.job ? (
                            <button type="button" className="lk" onClick={() => p.onOpenJob(e.job as string)}>
                              {e.item}
                            </button>
                          ) : (
                            <span>{e.item}</span>
                          )}
                          <span>{e.approval}</span>
                        </span>
                      </span>
                      <span className={st.cls}>{st.text}</span>
                    </div>
                  );
                })}
              </section>
            );
          })}
          {days.length === 0 && (
            <div className="empty" data-testid="act-none">
              <span className="ico" aria-hidden="true">
                <SearchGlyph />
              </span>
              <h2>{t("act.noneTitle")}</h2>
              <p>{t("act.noneText")}</p>
              <button type="button" className="btn" onClick={() => p.onFilter({ type: "clear" })} data-testid="act-clear-empty">
                {t("act.clear")}
              </button>
            </div>
          )}
          {p.older && <ShowOlder view={p.older} />}
        </div>
        <aside className="side2" id="act-detail" aria-label={t("act.details")} data-testid="act-details">
          {sel ? <Details e={sel} p={p} /> : <p className="hint">{t("act.pick")}</p>}
        </aside>
      </div>
    </>,
  );
}

export function ActivityPage() {
  const s = useStore();
  const [state, setState] = useState<Load<Log>>(LOADING);
  // Show older has the log read again, which leaves what the page holds (the event picked, the messages shown) as it is. Only the
  // dates may move: the read that follows a press widens a range of the last days to the oldest event it holds (`widenFor`), so
  // the older work the press read shows. A read for any other reason leaves the filters alone.
  const [reads, setReads] = useState(0);
  const widenNext = useRef(false);
  const more = useShowOlder(() => {
    widenNext.current = true;
    setReads((n) => n + 1);
  });
  const [filters, onFilter] = useReducer(filterReduce, NO_FILTERS);
  const [exporting, onExport] = useReducer(exportReduce, EXPORT_START);
  const [picked, setPicked] = useState<string | null>(null);
  // Which customers' messages are showing is this page's and no one else's: it is not kept, so leaving the page hides them.
  const [shown, setShown] = useState<ReadonlySet<string>>(() => new Set());
  // A shop the person only helps at: its log is its owner's, so it is never read here.
  const helped = helpedShop(s.shops);
  useEffect(() => {
    if (helped) return;
    let live = true;
    void load(() => getStore().actions.missionActivity()).then((r) => {
      if (!live) return;
      setState(r);
      if (!widenNext.current || r.kind !== "ready" || r.value.events.length === 0) return;
      widenNext.current = false;
      // The filters' own action, so the widening starts from the filters as they are now, not as this read found them.
      onFilter({ type: "widen", oldest: r.value.events.reduce((low, e) => Math.min(low, e.at), Infinity), now: Date.now() });
    });
    return () => {
      live = false;
    };
    // `helped` is read by its id: a new object for the same shop reads nothing again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reads, helped?.id]);

  const listed = selectSidebarBots(s);
  const nameOf = (who: string) => (who === OWNER ? t("act.you") : (s.bots.find((b) => b.name === who)?.display_name ?? who));
  const owner = [s.ui.shop.person, s.ui.shop.shop].filter(Boolean).join(", ");
  const people: Person[] = [...listed.map((b) => ({ id: b.name, label: b.display_name })), { id: OWNER, label: t("act.you") }];

  return (
    <ActivityView
      load={state}
      nowMs={Date.now()}
      filters={filters}
      onFilter={onFilter}
      people={people}
      face={(who) => (who === OWNER ? <span className="own">{(s.ui.shop.person || t("act.you")).slice(0, 1).toUpperCase()}</span> : <Avatar bot={who} size={24} />)}
      person={(who) => (who === OWNER ? { name: t("act.you"), role: owner } : { name: nameOf(who), role: s.bots.find((b) => b.name === who)?.description ?? "" })}
      pickedId={picked}
      onPick={setPicked}
      shown={shown}
      onShow={(id) => setShown((cur) => new Set(cur).add(id))}
      onHide={(id) =>
        setShown((cur) => {
          const next = new Set(cur);
          next.delete(id);
          return next;
        })
      }
      exporting={exporting}
      onExport={onExport}
      onDownload={() => {
        if (state.kind !== "ready") return;
        void downloadCsv(state.value.events, exporting, Date.now(), activityWords(nameOf)).then((r) => {
          if (r === "not_yet") onExport(SAVE_NOT_YET);
          else if (r === "saved") onExport({ type: "close" });
        });
      }}
      onBack={() => s.closeSettings()}
      onOpenJob={(id) => s.openJob(id)}
      older={state.kind === "ready" && state.value.older ? { state: state.value.older, ui: more.ui, onShow: more.show } : undefined}
      helped={helped}
      onNeeds={() => s.openPage("needs")}
    />
  );
}
