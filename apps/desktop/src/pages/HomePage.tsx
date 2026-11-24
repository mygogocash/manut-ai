// Home: the page the menu's New row and the brand mark open, and the place the app starts. It is the design canvas's
// Main.dc.html: the ask box with its three modes and the mode's suggestions, a few of the asks waiting on the person,
// and the members working now. Its rules are in home.ts; this file draws them.
//
// Home shows only what the store already holds. Left out until the runtime has them: the budget pill (no money data),
// the quick links to Sales, Content, Books and Stock, Updates, Careful (no setting it fits), adding a file and
// speaking. Automations shows, with its count, only when the runtime offers them.
import { useRef, useState, type ReactNode, type Ref } from "react";
import "./home.css";
import { t } from "../i18n";
import { can } from "../runtime";
import { holdImeEnter } from "../lib/ime";
import { askFrom, getStore, isSessionChat, selectAsks, selectSidebarBots, shopName, useStore, viewedShopName, type Actions, type AppState, type Ask } from "../state/store";
import { ALLOW_LABEL, settleApproval } from "../chat/cards/respond";
import { useNow } from "../elsewhere/useNow";
import { AskLine, age } from "../sidebar/Needs";
import { homeBot } from "../sidebar/menu";
import { BrandMark } from "../sidebar/menuIcons";
import { SessionFace } from "../sessions/SessionFace";
import { Avatar } from "../ui";
import { MenuPageFrame } from "./MenuPage";
import { RecentWorkList, recentRows, useJobs, type RecentRow } from "./RecentWork";
import {
  askLines,
  askRoute,
  canApproveHere,
  elapsed,
  FIRST_MODE,
  homeAsks,
  kitOf,
  MODE_WORDS,
  offeredModes,
  sendAsk,
  settledAsks,
  workingMembers,
  type DoneHere,
  type HomeMode,
} from "./home";

/** One ask as its Needs you row shows it. */
export interface HomeAskRow {
  key: string;
  /** the ask in its card's words: an approval's title, or the question */
  title: string;
  /** the exact action an approval names (its command), as its card shows it; null for a question */
  action: string | null;
  /** the action is shown whole, as its card shows it: a browser write's sentence, never cut or scrolled away */
  whole?: boolean;
  /** who asks: the member's name, or a terminal session's folder and agent */
  who: string;
  /** the shop the ask comes from, when the runtime shows several */
  shop?: string;
  /** how long it has waited ("now", "3m") */
  age: string;
  face: ReactNode;
  /** approved from Home: the settled line's words ("Allowed once"); null while it waits */
  settled: string | null;
  /** offered only where Home may settle the ask itself (home.ts `canApproveHere`) */
  approve?: () => void;
  /** opens the ask's chat with its card in view and focused, as the Needs you page does */
  look: () => void;
  /** an Approve is on its way */
  busy?: boolean;
  /** why the last Approve was not taken */
  error?: string | null;
}

/** One member at work as its Working now row shows it. */
export interface WorkingRow {
  name: string;
  displayName: string;
  description: string;
  /** what the running turn says it is doing; "" before it says anything */
  status: string;
  /** how long that turn has run ("38s"), when the member's main chat has one */
  elapsed: string | null;
  open: () => void;
}

export interface HomeViewProps {
  mode: HomeMode;
  modes: readonly HomeMode[];
  text: string;
  /** there is someone to take the ask, and words to send */
  canSend: boolean;
  onMode: (mode: HomeMode) => void;
  onText: (text: string) => void;
  onSubmit: () => void;
  /** why the last ask did not go (the store's error); the box keeps its words */
  sendError?: string | null;
  /** a suggestion was picked: its words go into the box, and nothing is sent until Send */
  onChip: (words: string) => void;
  inputRef?: Ref<HTMLInputElement>;
  asks: HomeAskRow[];
  /** every open ask, as the menu counts them */
  waiting: number;
  onSeeAll: () => void;
  working: WorkingRow[];
  onSeeTeam: () => void;
  /** offered when the runtime has automations: how many jobs there are, and the page's opener */
  automations?: { count: number; open: () => void };
  /** the shop's name as the first-run setup took it; "" or absent until then */
  shop?: string;
  /** the newest jobs the runtime has, each opening its page; the part is not drawn without any */
  recent?: RecentRow[];
  onSeeHistory?: () => void;
}

/** The canvas's send arrow, routines calendar and settled tick, on its 16-unit grid (menuPages.css gives `.ic`). */
function SendGlyph() {
  return (
    <svg className="ic" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M8 13V3M4 7l4-4 4 4" />
    </svg>
  );
}
function CalendarGlyph() {
  return (
    <svg className="ic" viewBox="0 0 16 16" aria-hidden="true">
      <rect x="2.5" y="3.5" width="11" height="10" rx="2" />
      <path d="M2.5 7h11M5.5 2v3M10.5 2v3" />
    </svg>
  );
}
function TickGlyph() {
  return (
    <svg className="ic" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M3.5 8.5l3 3 6-7" />
    </svg>
  );
}

export function HomeView(p: HomeViewProps) {
  const words = MODE_WORDS[p.mode];
  return (
    <MenuPageFrame
      page="home"
      title={t("home.title")}
      acts={
        p.automations && (
          <button type="button" className="btn" onClick={p.automations.open} data-testid="home-automations">
            <CalendarGlyph />
            {t("nav.automations")}
            {p.automations.count > 0 && <span className="tag">{p.automations.count}</span>}
          </button>
        )
      }
    >
      <div className="home hero">
        <div className="lockup">
          <BrandMark size={46} />
          <span>Manut AI</span>
          <span className="mut">{t(words.word)}</span>
        </div>
        {/* The desktop's own: the canvas's Home names the person and the shop only in the menu's account row. Home names
            the shop here too, once the first-run setup took it, so the person sees the app is set up for their shop. */}
        {p.shop && (
          <p className="for" data-testid="home-shop">
            {t("home.forShop", { shop: p.shop })}
          </p>
        )}
        <form
          className="ask"
          onKeyDown={holdImeEnter}
          onSubmit={(e) => {
            e.preventDefault();
            p.onSubmit();
          }}
        >
          {/* The box is named for where the ask goes, so each mode's name reaches a screen reader too. */}
          <label className="vh" htmlFor="home-ask">
            {t(words.title)}
          </label>
          <input
            id="home-ask"
            ref={p.inputRef}
            className="askin"
            type="text"
            autoComplete="off"
            value={p.text}
            placeholder={t(words.placeholder)}
            onChange={(e) => p.onText(e.target.value)}
            data-testid="home-ask"
          />
          <div className="askrow">
            <div className="modes" role="group" aria-label={t("home.where")}>
              {p.modes.map((m) => (
                <button key={m} type="button" className="mode" aria-pressed={m === p.mode} onClick={() => p.onMode(m)} data-testid={`home-mode-${m}`}>
                  {t(MODE_WORDS[m].label)}
                </button>
              ))}
            </div>
            <button type="submit" className="send" aria-label={t("cmp.send")} title={t("cmp.send")} disabled={!p.canSend} data-testid="home-send">
              <SendGlyph />
            </button>
          </div>
          {p.sendError && (
            <p className="err" role="alert" data-testid="home-send-error">
              {t("card.notSent", { error: p.sendError })}
            </p>
          )}
        </form>
        <div className="wide sugg">
          <p className="sugg-h" id="home-sugg">
            {t(words.title)}
          </p>
          <div className="chips" role="group" aria-labelledby="home-sugg">
            {words.chips.map((k) => (
              <button key={k} type="button" className="chip" onClick={() => p.onChip(t(k))} data-testid="home-chip">
                {t(k)}
              </button>
            ))}
          </div>
        </div>

        <section className="wide part" aria-labelledby="home-needs-h" data-testid="home-needs">
          <div className="band">
            <h2 id="home-needs-h">{t("menu.needs")}</h2>
            {p.waiting > 0 ? (
              <button type="button" className="lk" onClick={p.onSeeAll} data-testid="home-see-all">
                {t("home.seeAll", { n: p.waiting })}
              </button>
            ) : (
              <span>{t("home.nothingWaiting")}</span>
            )}
          </div>
          {p.asks.length ? (
            <ul className="rows">
              {p.asks.map((r, i) =>
                r.settled !== null ? (
                  <li key={r.key} className="rowl" data-testid="home-settled">
                    <span className="tag ok">
                      <TickGlyph />
                      {r.settled}
                    </span>
                    <span className="grow">
                      {r.action ? (
                        <code className={r.whole ? "act whole" : "act"}>{r.action}</code>
                      ) : (
                        <span className="l2">
                          <AskLine text={r.title} />
                        </span>
                      )}
                    </span>
                  </li>
                ) : (
                  <li key={r.key} className="rowl" data-testid="home-need">
                    {r.face}
                    <span className="grow">
                      <span className="l1" id={`home-need-${i}`}>
                        <AskLine text={r.title} />
                      </span>
                      {r.action && <code className={r.whole ? "act whole" : "act"}>{r.action}</code>}
                      <span className="l2">{[r.who, r.shop, r.age].filter(Boolean).join(" · ")}</span>
                    </span>
                    {/* Approve sends the card's Allow once through the card's own path (respond.ts), and only where
                        the card would show nothing more than this row does. */}
                    {r.approve && (
                      <button type="button" className="btn dark" aria-describedby={`home-need-${i}`} disabled={r.busy} onClick={r.approve} data-testid="home-approve">
                        {t("home.approve")}
                      </button>
                    )}
                    <button type="button" className="btn" aria-describedby={`home-need-${i}`} onClick={r.look} data-testid="home-look">
                      {t("home.look")}
                    </button>
                    {r.error && (
                      <span className="err" role="alert">
                        {t("card.notSent", { error: r.error })}
                      </span>
                    )}
                  </li>
                ),
              )}
            </ul>
          ) : (
            // The empty Needs you of the canvas's first-day Home (HomeEmpty.dc.html). Its heading is an h3 under the
            // section's h2.
            <div className="empty" data-testid="home-needs-empty">
              <h3>{t("home.needsEmptyTitle")}</h3>
              <p>{t("home.needsEmptyText")}</p>
            </div>
          )}
        </section>

        <section className="wide part" aria-labelledby="home-working-h" data-testid="home-working">
          <div className="band">
            <h2 id="home-working-h">{t("home.working")}</h2>
            <button type="button" className="lk" onClick={p.onSeeTeam} data-testid="home-see-team">
              {t("home.seeTeam")}
            </button>
          </div>
          {p.working.length ? (
            <ul className="rows">
              {p.working.map((w) => (
                <li key={w.name}>
                  <button type="button" className="rowl" onClick={w.open} data-testid="home-worker">
                    <Avatar bot={w.name} size={32} />
                    <span className="grow">
                      <span className="l1">{w.displayName}</span>
                      {w.description && <span className="l2">{w.description}</span>}
                    </span>
                    {/* The turn's own words, not the canvas's rolling working words: those are made up, these are
                        what the member is doing. */}
                    <span className="think">
                      <span className="dotst run" aria-hidden="true" />
                      <span>{w.status || t("thread.st.running")}</span>
                      {w.elapsed && <span className="when">{w.elapsed}</span>}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="none" data-testid="home-idle">
              {t("home.idle")}
            </p>
          )}
        </section>

        {p.recent && p.recent.length > 0 && (
          <section className="wide part" aria-labelledby="home-recent-h" data-testid="home-recent">
            <div className="band">
              <h2 id="home-recent-h">{t("home.recent")}</h2>
              {p.onSeeHistory && (
                <button type="button" className="lk" onClick={p.onSeeHistory} data-testid="home-see-history">
                  {t("home.seeHistory")}
                </button>
              )}
            </div>
            <RecentWorkList rows={p.recent} />
          </section>
        )}
      </div>
    </MenuPageFrame>
  );
}

/** An Approve on its way, or why the last one was not taken, by row key. */
export interface RowState {
  busy: boolean;
  error: string | null;
}

const askKey = (a: Pick<Ask, "bot" | "item">) => `${a.bot}:${a.item.id}`;

/** The Needs you rows for the store's open asks and the ones approved here (`done`), each with Look first, and with
 *  Approve where Home may settle the ask itself; Approve hands the ask to `onApprove`. */
export function needsYouRows(
  s: AppState & Actions,
  done: readonly DoneHere[],
  rows: Readonly<Record<string, RowState>>,
  nowMs: number,
  onApprove: (a: Ask) => void,
): HomeAskRow[] {
  return homeAsks(selectAsks(s), settledAsks(s.chats, done)).map((a) => {
    const key = askKey(a);
    const { title, action, whole } = askLines(a.item);
    const state = rows[key];
    const resolved = a.item.kind === "approval" ? a.item.resolved : undefined;
    return {
      key,
      title,
      action,
      ...(whole ? { whole: true } : {}),
      who: askFrom(s, a.bot),
      ...(a.item.kind === "approval" && a.item.shop ? { shop: shopName(s, a.item.shop) } : {}),
      age: age(a.ts, nowMs),
      face: isSessionChat(a.bot) ? <SessionFace chatKey={a.bot} size={32} /> : <Avatar bot={a.bot} size={32} />,
      settled: a.settled && resolved ? t(ALLOW_LABEL[resolved]) : null,
      ...(!a.settled && canApproveHere(a.item) ? { approve: () => onApprove(a) } : {}),
      look: () => void s.jumpToAsk(a.bot, a.item.id),
      busy: state?.busy ?? false,
      error: state?.error ?? null,
    };
  });
}

/** The Working now rows: the listed members at work, each opening that member's chat, which is their page. */
export function workingRows(s: AppState & Actions, nowMs: number): WorkingRow[] {
  return workingMembers(selectSidebarBots(s), s.chats, selectAsks(s)).map((w) => ({
    name: w.name,
    displayName: w.displayName,
    description: w.description,
    status: w.status,
    elapsed: w.since === null ? null : elapsed(w.since, nowMs),
    open: () => void s.selectBot(w.name),
  }));
}

export function HomePage() {
  const s = useStore();
  const listed = selectSidebarBots(s);
  const names = listed.map((b) => b.name);
  const home = homeBot(s.bots, names);
  const kit = kitOf(names);
  const modes = offeredModes(kit);
  const [picked, setPicked] = useState<HomeMode>(FIRST_MODE);
  // A mode that is no longer offered (Kit left the team) gives way to the first one.
  const mode = modes.includes(picked) ? picked : FIRST_MODE;
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [done, setDone] = useState<DoneHere[]>([]);
  const [rowStates, setRowStates] = useState<Record<string, RowState>>({});
  const input = useRef<HTMLInputElement>(null);
  const inFlight = useRef(new Set<string>());
  const asks = selectAsks(s);
  // Ages and working times move on while something waits or works.
  const now = useNow(asks.length > 0 || listed.some((b) => b.running || !!s.chats[b.name]?.turn), 5_000);
  const route = askRoute(mode, home, kit);
  const jobs = useJobs();

  const submit = async () => {
    const words = text.trim();
    if (!words || !route || sending) return;
    setSending(true);
    setSendError(null);
    // The store reports a failed request only through lastError: clear it, then look after the call, as the model
    // picker does.
    const store = getStore();
    store.dispatch({ type: "error", message: null });
    const sent = await sendAsk(s, route, words);
    setSending(false);
    // A thread that could not be made leaves the words in the box, with the store's reason under it.
    if (sent) setText("");
    else setSendError(store.getState().lastError || t("card.notTaken"));
  };

  const approve = async (a: Ask) => {
    const key = askKey(a);
    // One answer per ask: a second press while the first is on its way does nothing, as on the card.
    if (inFlight.current.has(key)) return;
    inFlight.current.add(key);
    setRowStates((cur) => ({ ...cur, [key]: { busy: true, error: null } }));
    // The card's own Allow once, through the card's own path: there is one way an approval is settled.
    const error = await settleApproval(getStore(), a.bot, a.item, "once");
    inFlight.current.delete(key);
    setRowStates((cur) => ({ ...cur, [key]: { busy: false, error } }));
    if (!error) setDone((cur) => [...cur, { bot: a.bot, id: a.item.id }]);
  };

  return (
    <HomeView
      mode={mode}
      modes={modes}
      text={text}
      canSend={!!route && !!text.trim() && !sending}
      // The focus stays on the mode just pressed, so a keyboard can move on through the modes; a suggestion, which
      // puts words in the box, takes the focus there instead.
      onMode={setPicked}
      onText={(words) => {
        setText(words);
        setSendError(null);
      }}
      onSubmit={() => void submit()}
      sendError={sendError}
      onChip={(words) => {
        setText(words);
        input.current?.focus();
      }}
      inputRef={input}
      asks={needsYouRows(s, done, rowStates, now, (a) => void approve(a))}
      waiting={asks.length}
      onSeeAll={() => s.openPage("needs")}
      working={workingRows(s, now)}
      onSeeTeam={() => s.openPage("team")}
      automations={can("automations") ? { count: s.automations?.length ?? 0, open: () => s.openAutomations() } : undefined}
      shop={viewedShopName(s)}
      recent={recentRows(jobs, { nameOf: (b) => s.bots.find((x) => x.name === b)?.display_name ?? b, nowMs: now, open: (id) => s.openJob(id) })}
      onSeeHistory={() => s.openPage("history")}
    />
  );
}
