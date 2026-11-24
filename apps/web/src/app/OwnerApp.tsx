import type { OptionEffect } from "@manut/approval-core";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { ApiError, useApiSetup, type PilotApi, type WebShop } from "../api";
import { SHOP_TIME_ZONE } from "../format";
import { joinStrings } from "../join/strings";
import { CodeStep, EmailStep } from "../signin/CodeSteps";
import { useCodeSignIn } from "../signin/useCodeSignIn";
import { BrandMark, ChatIcon, CloudOffIcon, useColorScheme } from "../ui/marks";
import { Loading, Notice, OWNER_CARD as CARD, Pulse, whenText } from "../ui/owner";
import { answeredWords, AskCard, outcomeWords, type Tone } from "./AskCard";
import { askId, type Outcome } from "./asks";
import { decideAsk, isOver, readNeeds, type Ask, type NeedsRead } from "./needs";
import { appStrings, type AppStrings } from "./strings";

/// The owner's web app (`/app/`, docs/web-app.md): what a shop owner, or one of their helpers, adds to their phone's home
/// screen. They sign in with a code sent to their email, see what waits for them across their shops, and approve or
/// decline each request with its exact words, through that shop's own session.
///
/// The session is in cookies the API sets and this page cannot read (docs/pilot-api.md, "The web app's session"), so the
/// page holds no token, and keeps nothing at all beyond the page's own memory: no `localStorage`, `sessionStorage`,
/// IndexedDB or cache, and nothing in a URL. What waits is read again on opening, every minute while the app is in view,
/// when the phone comes back online and after each answer. Offline, the app says so and offers no answer: what it read
/// before may have changed, and an answer must go to the API to count.

/// How often what waits is read again while the app is in view.
export const REFRESH_MS = 60_000;

type Phase =
  | { name: "starting" }
  | { name: "signIn" }
  /// Signing in by email is off where this app runs (`email_not_configured`).
  | { name: "off" }
  /// The API could not be reached to say who is signed in.
  | { name: "unreachable"; offline: boolean }
  | { name: "in"; shops: WebShop[] };

export type Tab = "today" | "needs" | "chat" | "shops";
const TABS: readonly Tab[] = ["today", "needs", "chat", "shops"];

/// The tab the address names (`#needs`), Today by default.
export function tabOf(hash: string): Tab {
  const name = hash.replace(/^#/, "");
  return (TABS as readonly string[]).includes(name) ? (name as Tab) : "today";
}

/// Whether the phone says it is online, kept current.
function useOnline(): boolean {
  const [online, setOnline] = useState(() => (typeof navigator === "undefined" ? true : navigator.onLine !== false));
  useEffect(() => {
    const update = () => setOnline(navigator.onLine !== false);
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, []);
  return online;
}

function useTab(): Tab {
  const [tab, setTab] = useState(() => tabOf(window.location.hash));
  useEffect(() => {
    const update = () => setTab(tabOf(window.location.hash));
    window.addEventListener("hashchange", update);
    return () => window.removeEventListener("hashchange", update);
  }, []);
  return tab;
}

/// Who is signed in, read from the API once at opening: their shops, or the sign-in, or that signing in is off. A signed-out
/// answer is read twice before it is believed: two of the person's tabs opening at once refresh one sign-in, and the
/// second can be refused while the first sets the cookie that works.
export async function openSession(api: PilotApi): Promise<Phase> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const session = await api.webShops();
      if (session.signedIn) return { name: "in", shops: session.shops };
      if (!session.emailSignIn) return { name: "off" };
      if (attempt > 0) return { name: "signIn" };
    } catch (err) {
      return { name: "unreachable", offline: err instanceof ApiError && err.status === 0 };
    }
  }
}

/// "morning", "afternoon" or "evening" on the shop's clock.
export function partOfDay(now: number): "morning" | "afternoon" | "evening" {
  const hour = Number(new Intl.DateTimeFormat("en-GB", { hour: "2-digit", hourCycle: "h23", timeZone: SHOP_TIME_ZONE })
    .format(now));
  return hour < 12 ? "morning" : hour < 18 ? "afternoon" : "evening";
}

type Answered = { ask: Ask; outcome: Outcome; tone: Tone; text: string };

export function OwnerApp() {
  const { api, mode } = useApiSetup();
  const s = appStrings();
  const js = joinStrings();
  const scheme = useColorScheme();
  const online = useOnline();
  const tab = useTab();
  const [phase, setPhase] = useState<Phase>({ name: "starting" });
  const [needs, setNeeds] = useState<NeedsRead | null>(null);
  const [readAt, setReadAt] = useState<number | null>(null);
  const [reading, setReading] = useState(false);
  const [offline, setOffline] = useState(false);
  // Answers given here: what each came to, by ask id, shown on its card while the card is still listed, and above the
  // list for a moment after the shop is read again.
  const [answered, setAnswered] = useState<Map<string, Answered>>(new Map());
  const [busy, setBusy] = useState<{ ask: string; effect: OptionEffect } | null>(null);
  const [signingOut, setSigningOut] = useState(false);
  const [signOutError, setSignOutError] = useState<string | null>(null);
  const inFlight = useRef(false);
  const readSeq = useRef(0);
  const flow = useCodeSignIn(js, {
    api,
    exchange: (address, code) => api.webSignIn({ email: address, code }),
    onSignedIn: () => void start(),
    onOff: () => setPhase({ name: "off" }),
  });

  useEffect(() => {
    document.title = s.documentTitle;
  }, [s]);

  async function start(): Promise<void> {
    const next = await openSession(api);
    setPhase(next);
    if (next.name !== "in") {
      setNeeds(null);
      setReadAt(null);
    }
  }

  useEffect(() => {
    // Opening the app reads who is signed in once; everything after follows from what it said.
    void start();
  }, [api]);

  // Opened offline: try again by itself once the phone says it is back online.
  useEffect(() => {
    if (online && phase.name === "unreachable" && phase.offline) void start();
    // Only coming back online starts it; the phase it reads is the one this render has.
  }, [online]);

  const shops = phase.name === "in" ? phase.shops : null;

  async function read(): Promise<void> {
    if (!shops) return;
    const seq = ++readSeq.current;
    setReading(true);
    try {
      const next = await readNeeds(api, shops);
      if (seq !== readSeq.current) return;
      if (!next.ok && next.why === "signed_out") {
        flow.reset(s.signedOutBody);
        setPhase({ name: "signIn" });
        return;
      }
      if (!next.ok) {
        setOffline(true);
        return;
      }
      setOffline(false);
      setNeeds(next);
      setReadAt(Date.now());
      if (next.shops) setPhase({ name: "in", shops: next.shops });
    } catch {
      if (seq === readSeq.current) setOffline(true);
    } finally {
      if (seq === readSeq.current) setReading(false);
    }
  }

  // Read on signing in, when the shops change, when the phone comes back online, when the app comes back into view, and
  // every minute while it is in view.
  useEffect(() => {
    if (!shops || !online) return;
    void read();
    const timer = setInterval(() => {
      if (document.visibilityState !== "hidden") void read();
    }, REFRESH_MS);
    const visible = () => {
      if (document.visibilityState === "visible") void read();
    };
    document.addEventListener("visibilitychange", visible);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", visible);
    };
    // `read` reads the shops it closes over, which this effect follows.
  }, [shops, online]);

  // Leaving Needs you clears what was answered here; its outcomes are in Answered lately by then.
  useEffect(() => {
    setAnswered(new Map());
  }, [tab]);

  async function answer(ask: Ask, effect: OptionEffect): Promise<void> {
    if (inFlight.current || !online) return;
    inFlight.current = true;
    const id = askId(ask.approval);
    setBusy({ ask: id, effect });
    try {
      const outcome = await decideAsk(api, ask, effect);
      const words = outcomeWords(s, outcome, ask);
      setAnswered((current) => new Map(current).set(id, { ask, outcome, ...words }));
      if (isOver(outcome) || outcome.kind === "unclear" || outcome.kind === "session_ended") await read();
    } finally {
      inFlight.current = false;
      setBusy(null);
    }
  }

  async function signOut(): Promise<void> {
    if (signingOut) return;
    setSigningOut(true);
    setSignOutError(null);
    try {
      await api.webSignOut();
      setNeeds(null);
      setReadAt(null);
      setAnswered(new Map());
      flow.reset();
      setPhase({ name: "signIn" });
    } catch (err) {
      setSignOutError(err instanceof ApiError && err.status === 0 ? s.signOutOffline : s.signOutFailed);
    } finally {
      setSigningOut(false);
    }
  }

  let body: ReactNode;
  switch (phase.name) {
    case "starting":
      body = <Loading label={s.opening} />;
      break;
    case "off":
      body = <Notice icon={<CloudOffIcon />} title={s.offTitle} body={s.offBody} />;
      break;
    case "unreachable":
      body = (
        <Notice icon={<CloudOffIcon />} title={phase.offline ? s.offlineTitle : s.startFailedTitle}
          body={phase.offline ? s.offlineBody : s.startFailedBody}>
          <button type="button" className="btn" style={{ minHeight: 44 }} onClick={() => void start()}>
            {s.tryAgain}
          </button>
        </Notice>
      );
      break;
    case "signIn":
      body = flow.step.name === "email" ? (
        <EmailStep s={js} flow={flow} title={s.signInTitle} body={s.signInBody} titleId="app-sign-in-title" idPrefix="app" />
      ) : (
        <CodeStep s={js} flow={flow} practice={mode === "fake"} titleId="app-code-title" idPrefix="app" />
      );
      break;
    case "in":
      body = (
        <SignedIn
          s={s}
          tab={tab}
          shops={phase.shops}
          needs={needs}
          readAt={readAt}
          live={online && !offline}
          reading={reading}
          answered={answered}
          busy={busy}
          onAnswer={(ask, effect) => void answer(ask, effect)}
          signingOut={signingOut}
          signOutError={signOutError}
          onSignOut={() => void signOut()}
        />
      );
      break;
  }

  const waiting = phase.name === "in" && needs?.ok ? needs.asks.length : 0;
  return (
    <div className="r" data-t={scheme} style={{ minHeight: "100dvh", background: "var(--main)" }}>
      <div
        className="col"
        style={{
          maxWidth: 560,
          padding: "max(16px, env(safe-area-inset-top)) 16px calc(96px + env(safe-area-inset-bottom))",
          gap: 14,
        }}
      >
        <header style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <BrandMark />
          <span style={{ fontSize: 17, fontWeight: 600, letterSpacing: "-.02em" }}>{s.brand}</span>
          {waiting > 0 && (
            <span className="tag warn" style={{ marginLeft: "auto" }}>
              {s.needYou(waiting)}
            </span>
          )}
        </header>
        {mode === "fake" && (
          <div className="banner info" role="note">
            <span className="grow">{phase.name === "in" ? `${s.practiceMode} ${s.practiceReload}` : s.practiceMode}</span>
          </div>
        )}
        {phase.name === "in" && (!online || offline) && (
          <div className="banner warn" role="status">
            <CloudOffIcon />
            <span className="grow">
              {readAt === null ? s.offlineBody : `${s.offlineTitle}. ${s.offlineHeld(whenText(s, new Date(readAt).toISOString()))}`}
            </span>
          </div>
        )}
        <main aria-live="polite" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {body}
        </main>
      </div>
      {phase.name === "in" && <Tabs s={s} tab={tab} />}
    </div>
  );
}

function Tabs({ s, tab }: { s: AppStrings; tab: Tab }) {
  return (
    <nav
      aria-label={s.sections}
      style={{
        position: "fixed",
        left: 0,
        right: 0,
        bottom: 0,
        padding: "8px 16px calc(8px + env(safe-area-inset-bottom))",
        background: "var(--main)",
        borderTop: "1px solid var(--line)",
      }}
    >
      <div style={{ maxWidth: 528, margin: "0 auto", display: "flex", gap: 4, padding: 4, borderRadius: "var(--rad-pill)",
        background: "var(--band)" }}>
        {TABS.map((name) => (
          <a
            key={name}
            href={`#${name}`}
            aria-current={tab === name ? "page" : undefined}
            style={{
              flex: "1 1 0",
              minHeight: 44,
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              borderRadius: "var(--rad-pill)",
              fontSize: 13,
              fontWeight: 500,
              textAlign: "center",
              ...(tab === name ? { background: "var(--bg)", boxShadow: "var(--sh)" } : { color: "var(--mut)" }),
            }}
          >
            {s.tabs[name]}
          </a>
        ))}
      </div>
    </nav>
  );
}

type SignedInProps = {
  s: AppStrings;
  tab: Tab;
  shops: WebShop[];
  needs: NeedsRead | null;
  readAt: number | null;
  live: boolean;
  reading: boolean;
  answered: Map<string, Answered>;
  busy: { ask: string; effect: OptionEffect } | null;
  onAnswer: (ask: Ask, effect: OptionEffect) => void;
  signingOut: boolean;
  signOutError: string | null;
  onSignOut: () => void;
};

/// The four tabs of a signed-in person, as the phone board has them: Today, Needs you, Chat, and their Shops.
export function SignedIn(props: SignedInProps) {
  const { s, tab } = props;
  if (tab === "chat") {
    return <Notice icon={<ChatIcon />} title={props.s.chatTitle} body={props.s.chatBody} />;
  }
  if (tab === "shops") return <Shops {...props} />;
  const read = props.needs?.ok ? props.needs : null;
  const owned = props.shops.find((shop) => shop.role === "owner");
  if (tab === "today") {
    const waiting = read?.asks.length ?? 0;
    return (
      <>
        <h1 style={{ margin: 0, fontSize: 28, lineHeight: 1.1, fontWeight: 600, letterSpacing: "-.04em" }}>
          {s.greeting(partOfDay(Date.now()), owned?.ownerName ?? null)}
        </h1>
        <section className="box" style={CARD} aria-labelledby="brief-title">
          <h2 className="mut" id="brief-title" style={{ margin: 0, fontSize: 13, fontWeight: 500 }}>
            {s.briefTitle}
          </h2>
          <p style={{ margin: 0, fontSize: 17, lineHeight: 1.4 }}>{read ? s.waitingCount(waiting) : s.loadingNeeds}</p>
          <p className="hint" style={{ margin: 0 }}>
            {s.briefWaits}
          </p>
          {waiting > 0 && (
            <div>
              <a className="btn" href="#needs" style={{ minHeight: 44 }}>
                {s.openNeeds}
              </a>
            </div>
          )}
        </section>
        <Needs {...props} limit={2} />
      </>
    );
  }
  return (
    <>
      <h1 style={{ margin: 0, fontSize: 24, fontWeight: 600, letterSpacing: "-.03em" }}>{s.needsTitle}</h1>
      <Needs {...props} />
      <Recent {...props} />
    </>
  );
}

/// What waits, oldest first: the asks of the last read, each answerable while the phone is online, and above them the asks
/// answered here since, with what each came to.
function Needs({ s, needs, readAt, live, answered, busy, onAnswer, limit }: SignedInProps & { limit?: number }) {
  if (needs === null) return readAt === null && live ? <Loading label={s.loadingNeeds} /> : null;
  if (!needs.ok) return null;
  const held = [...answered.values()].filter((one) => !needs.asks.some((ask) => askId(ask.approval) === askId(one.ask.approval)));
  const asks = limit === undefined ? needs.asks : needs.asks.slice(0, limit);
  return (
    <>
      {limit === undefined && needs.problems.map((problem) => (
        <div key={problem.shop.id} className={`banner ${problem.why === "left" ? "err" : "warn"}`} role="status">
          <span className="grow">
            {problem.why === "left"
              ? s.shopLeft(problem.shop.name, problem.left.why, problem.left.at === null ? null : whenText(s, new Date(problem.left.at).toISOString()))
              : s.shopUnreadable(problem.shop.name)}
          </span>
        </div>
      ))}
      {limit === undefined && needs.unreadable > 0 && (
        <p className="hint" style={{ margin: 0 }}>
          {s.unreadable(needs.unreadable)}
        </p>
      )}
      {limit === undefined && held.map((one) => (
        <AskCard key={`held-${askId(one.ask.approval)}`} s={s} ask={one.ask} outcome={one} busy={null} live={false}
          onAnswer={() => undefined} />
      ))}
      {asks.map((ask) => {
        const id = askId(ask.approval);
        return (
          <AskCard
            key={`${ask.shop.id}/${id}`}
            s={s}
            ask={ask}
            outcome={answered.get(id) ?? null}
            busy={busy?.ask === id ? busy.effect : null}
            live={live}
            waiting={busy !== null && busy.ask !== id}
            onAnswer={(effect) => onAnswer(ask, effect)}
          />
        );
      })}
      {needs.asks.length === 0 && held.length === 0 && limit === undefined && (
        <Notice icon={<CheckIconBig />} title={s.nothingWaitsTitle} body={s.nothingWaitsBody} />
      )}
    </>
  );
}

function CheckIconBig() {
  return (
    <svg className="ic" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M3.5 8.5l3 3 6-7" />
    </svg>
  );
}

/// The newest requests answered lately, or that nobody answered in time: who decided and when, as approval-core recorded it.
function Recent({ s, needs }: SignedInProps) {
  if (!needs?.ok) return null;
  return (
    <section aria-labelledby="recent-title" style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 8 }}>
      <h2 id="recent-title" style={{ margin: 0, fontSize: 15, fontWeight: 600 }}>
        {s.recentTitle}
      </h2>
      {needs.recent.length === 0 ? (
        <p className="hint" style={{ margin: 0 }}>
          {s.recentNone}
        </p>
      ) : (
        <ul style={{ margin: 0, padding: 0, listStyle: "none", display: "flex", flexDirection: "column", gap: 8 }}>
          {needs.recent.map((ask) => (
            <RecentRow key={`${ask.shop.id}/${askId(ask.approval)}`} s={s} ask={ask} />
          ))}
        </ul>
      )}
    </section>
  );
}

function RecentRow({ s, ask }: { s: AppStrings; ask: Ask }) {
  const request = ask.approval.record.request;
  const detail = request.detail as { text?: unknown } | undefined;
  const words = typeof detail?.text === "string" ? detail.text : "";
  return (
    <li className="box" style={{ padding: "10px 12px", display: "flex", flexDirection: "column", gap: 4 }}>
      <span className="mut" style={{ fontSize: 12.5 }}>
        {ask.shop.name}
      </span>
      {words && (
        <span style={{ overflowWrap: "anywhere", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical",
          overflow: "hidden" }}>
          {words}
        </span>
      )}
      <span className="hint" style={{ margin: 0 }}>
        {answeredWords(s, ask)}
      </span>
    </li>
  );
}

/// The shops the person is in, what they are there, and signing out.
function Shops({ s, shops, signingOut, signOutError, onSignOut, live }: SignedInProps) {
  return (
    <>
      <h1 style={{ margin: 0, fontSize: 24, fontWeight: 600, letterSpacing: "-.03em" }}>{s.shopsTitle}</h1>
      <ul style={{ margin: 0, padding: 0, listStyle: "none", display: "flex", flexDirection: "column", gap: 10 }}>
        {shops.map((shop) => (
          <li key={shop.id} className="box" style={CARD}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              <span style={{ fontWeight: 600, overflowWrap: "anywhere" }}>{shop.name}</span>
              <span className="tag" style={{ marginLeft: "auto" }}>
                {shop.role === "owner" ? s.youOwn : s.youHelp(shop.ownerName)}
              </span>
            </div>
            {shop.role === "helper" && (
              <p className="hint" style={{ margin: 0 }}>
                {s.helperRule(shop.ownerName)}
              </p>
            )}
            {!shop.ready && (
              <p className="hint" style={{ margin: 0 }}>
                {s.shopNotReady}
              </p>
            )}
          </li>
        ))}
      </ul>
      {signOutError && (
        <div className="banner warn" role="alert">
          <span className="grow">{signOutError}</span>
        </div>
      )}
      <div>
        <button
          type="button"
          className="btn"
          style={{ minHeight: 44 }}
          disabled={signingOut || !live}
          aria-busy={signingOut || undefined}
          onClick={onSignOut}
        >
          {signingOut ? (
            <>
              <Pulse />
              {s.signingOut}
            </>
          ) : (
            s.signOut
          )}
        </button>
      </div>
      {!live && (
        <p className="hint" style={{ margin: 0 }}>
          {s.signOutOffline}
        </p>
      )}
    </>
  );
}
