// Home: the page the menu's New row and the brand mark open, and the place the app starts. It is the design canvas's
// Main.dc.html: the ask box with its three modes and the mode's suggestions, a few of the asks waiting on the person,
// and the members working now. Its rules are in home.ts; this file draws them.
//
// Home shows only what the store already holds. Left out until the runtime has them: the budget pill (no money data),
// the quick links to Sales, Content, Books and Stock, Updates, Careful (no setting it fits), adding a file and
// speaking. Automations shows, with its count, only when the runtime offers them.
import { useEffect, useRef, useState, type ReactNode, type Ref } from "react";
import { firstWords } from "../threads/types";
import { modLabel, sendKey, stashKey, staysHome, useAfterSend } from "../chat/box/keys";
import { joinDraft, stashDraft } from "../app/stash";
import { HomeDrafts } from "./HomeDrafts";
import "./home.css";
import { t } from "../i18n";
import { can } from "../runtime";
import { holdImeEnter } from "../lib/ime";
import type { ShopRow } from "../lib/protocol";
import { helpedShop } from "../lib/shops";
import { askFrom, getStore, isSessionChat, selectAsks, selectSidebarBots, shopName, useStore, viewedShopName, type Actions, type AppState, type Ask } from "../state/store";
import { ALLOW_LABEL, settleApproval } from "../chat/cards/respond";
import { useNow } from "../elsewhere/useNow";
import { AskLine, age } from "../sidebar/Needs";
import { homeBot } from "../sidebar/menu";
import { BrandMark } from "../sidebar/menuIcons";
import { SessionFace } from "../sessions/SessionFace";
import { Avatar } from "../ui";
import { MenuPageFrame } from "./MenuPage";
import { ModePicker } from "./ModePicker";
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
  type Sent,
  workingMembers,
  type DoneHere,
  type HomeMode,
} from "./home";
import { Icon } from "../ui/icons";

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
  /** Send. `stay`: leave the person on Home (Cmd+Enter, or Enter when Settings says so; chat/box/keys.ts). */
  onSubmit: (stay: boolean) => void;
  /** What Enter does here (Settings › General › Chat box): Send's tooltip says it, and what Cmd+Enter does instead. */
  stays?: boolean;
  /** The last send that left the person here: one quiet line that says it went, and opens it. */
  started?: { name: string; words: string; open: () => void } | null;
  /** Cmd+S in the box: its words go to Drafts, at the top of this page (item 95). */
  onStash?: () => void;
  /** The drafts kept for later, drawn at the top of the page (HomeDrafts.tsx). */
  drafts?: ReactNode;
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
  /** The shop shown, when the person only helps there: Home says whose shop it is, and in place of who is working (the team is
   *  the owner's, and a helper's session is not told) says that only the owner sees it. */
  helped?: Pick<ShopRow, "name" | "owner"> | null;
}

/** The canvas's send arrow, routines calendar and settled tick, on its 16-unit grid (menuPages.css gives `.ic`). */
function SendGlyph() {
  return (
    <Icon name="arrow-up" />
  );
}
function CalendarGlyph() {
  return (
    <Icon name="calendar" />
  );
}
function TickGlyph() {
  return (
    <Icon name="check" />
  );
}

export function HomeView(p: HomeViewProps) {
  const words = MODE_WORDS[p.mode];
  return (
    <MenuPageFrame
      page="home"
      title={t("home.title")}
      // the mode at the top left, as ChatGPT names its model there (the owner, 27 Nov 2026); "Home" stays for screen readers
      lead={<ModePicker mode={p.mode} modes={p.modes} onMode={p.onMode} />}
      hideTitle
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
      <div className="home hero" data-arrive="home" data-arrive-rows=".rows > li">
        {p.drafts}
        <div className="lockup">
          <BrandMark size={46} />
          <span>Manut AI</span>
          <span className="mut">{t(words.word)}</span>
        </div>
        {/* The desktop's own: the canvas's Home names the person and the shop only in the menu's account row. Home names
            the shop here too, once the first-run setup took it, so the person sees the app is set up for their shop. */}
        {p.shop && (
          <p className="for" data-testid="home-shop">
            {p.helped?.owner ? t("home.forHelped", { shop: p.shop, owner: p.helped.owner }) : t("home.forShop", { shop: p.shop })}
          </p>
        )}
        <form
          className="ask"
          onKeyDown={holdImeEnter}
          onSubmit={(e) => {
            e.preventDefault();
            p.onSubmit(!!p.stays);
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
            // Enter and Cmd+Enter: one opens what it started, the other stays here (keys.ts); the form's own submit is
            // held back so a send happens once
            onKeyDown={(e) => {
              // Cmd+S puts the words aside in Drafts, never the browser's Save
              if (stashKey(e)) {
                e.preventDefault();
                return p.onStash?.();
              }
              const k = sendKey(e);
              if (!k) return;
              e.preventDefault();
              p.onSubmit(staysHome(k, p.stays ? "stay" : "open"));
            }}
            data-testid="home-ask"
          />
          <div className="askrow">
            {/* the mode is picked at the top left (ModePicker.tsx); the box's words already say where this goes */}
            <button type="submit" className="send" aria-label={t("cmp.send")} title={t(p.stays ? "home.sendStays" : "home.sendOpens", { mod: modLabel() })} disabled={!p.canSend} data-testid="home-send">
              <SendGlyph />
            </button>
          </div>
          {p.sendError && (
            <p className="err" role="alert" data-testid="home-send-error">
              {t("card.notSent", { error: p.sendError })}
            </p>
          )}
        </form>
        {/* A send that left the person here says it went, once, and opens what it started (item 95). */}
        {p.started && (
          <p className="started mo-rise" role="status" data-testid="home-started">
            <span className="grow">{t("home.started", { name: p.started.name, words: p.started.words })}</span>
            <button type="button" className="lk" onClick={p.started.open} data-testid="home-started-open">
              {t("home.open")}
            </button>
          </p>
        )}
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
                  <li key={r.key} className="rowl" data-ask data-testid="home-settled">
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
                  <li key={r.key} className="rowl" data-ask data-testid="home-need">
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
          {p.helped ? (
            <p className="none" data-testid="home-owners">
              {t("owners.working", { owner: p.helped.owner || t("owners.theOwner"), shop: p.helped.name || t("shops.aShop") })}
            </p>
          ) : p.working.length ? (
            <ul className="rows">
              {p.working.map((w) => (
                <li key={w.name}>
                  <button type="button" className="rowl" onClick={w.open} data-testid="home-worker">
                    <Avatar bot={w.name} size={32} live />
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
      face: isSessionChat(a.bot) ? <SessionFace chatKey={a.bot} size={32} /> : <Avatar bot={a.bot} size={32} live />,
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
  const [started, setStarted] = useState<{ sent: Sent; words: string } | null>(null);
  const after = useAfterSend();
  const [done, setDone] = useState<DoneHere[]>([]);
  const [rowStates, setRowStates] = useState<Record<string, RowState>>({});
  const input = useRef<HTMLInputElement>(null);
  const inFlight = useRef(new Set<string>());
  const asks = selectAsks(s);
  // Ages and working times move on while something waits or works.
  const now = useNow(asks.length > 0 || listed.some((b) => b.running || !!s.chats[b.name]?.turn), 5_000);
  const route = askRoute(mode, home, kit);
  const jobs = useJobs();
  const helped = helpedShop(s.shops);

  const submit = async (stay: boolean) => {
    const words = text.trim();
    if (!words || !route || sending) return;
    // these words are on their way: a send that opens the chat leaves Home before the box empties, and must not keep
    // them as a draft too
    typed.current = "";
    setSending(true);
    setSendError(null);
    setStarted(null);
    // The store reports a failed request only through lastError: clear it, then look after the call, as the model
    // picker does.
    const store = getStore();
    store.dispatch({ type: "error", message: null });
    const sent = await sendAsk(s, route, words, stay);
    setSending(false);
    // A thread that could not be made leaves the words in the box, with the store's reason under it.
    if (!sent) return setSendError(store.getState().lastError || t("card.notTaken"));
    setText("");
    // Cmd+Enter left the person here: the box is ready for the next one, and a line says where this one went.
    if (stay) {
      setStarted({ sent, words: firstWords(words) });
      input.current?.focus();
    }
  };
  const nameOf = (bot: string) => s.bots.find((b) => b.name === bot)?.display_name ?? bot;

  // Words left unsent in this box are a new chat's draft: leaving Home, or the app closing, keeps them in Drafts at the
  // top of this page (app/stash.ts), so the next new chat starts from an empty box and nothing typed is lost.
  const typed = useRef(text);
  typed.current = text;
  useEffect(() => {
    const keep = () => {
      const words = typed.current;
      typed.current = "";
      if (words.trim()) void stashDraft({ text: words, from: "home" }).catch(() => undefined);
    };
    window.addEventListener("pagehide", keep);
    return () => {
      window.removeEventListener("pagehide", keep);
      keep();
    };
  }, []);
  const stash = () => {
    const words = text;
    if (!words.trim()) return;
    typed.current = "";
    setText("");
    void stashDraft({ text: words, from: "home" }).catch(() => setText(words));
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
      onSubmit={(stay) => void submit(stay)}
      onStash={stash}
      drafts={
        <HomeDrafts
          s={s}
          nowMs={now}
          here={(words) => {
            setText((cur) => joinDraft(cur, words));
            input.current?.focus();
          }}
        />
      }
      stays={after === "stay"}
      started={
        started && {
          name: nameOf(started.sent.bot),
          words: started.words,
          open: () => {
            const to = started.sent;
            void (to.to === "thread" ? s.openThread(to.bot, to.thread) : s.selectBot(to.bot));
          },
        }
      }
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
      // A shop the person only helps at has no routines they may see, so no count of them is offered.
      automations={can("automations") && !helped ? { count: s.automations?.length ?? 0, open: () => s.openAutomations() } : undefined}
      shop={viewedShopName(s)}
      helped={helped}
      recent={recentRows(jobs, { nameOf: (b) => s.bots.find((x) => x.name === b)?.display_name ?? b, nowMs: now, open: (id) => s.openJob(id) })}
      onSeeHistory={() => s.openPage("history")}
    />
  );
}
