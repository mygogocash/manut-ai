// Customize › Connections' Google Sheets row for the shop's owner: the canvas's app row (its name and quiet lines, its tag and its
// buttons), above the Vault box (ConnectionsPane.tsx). Not connected, Connect opens Google's page in the system browser and the row
// waits for the owner to come back, which reads the status again; connected, it says the sheet's name and what was last sent, and
// offers Send a month's books and Disconnect, each with the questions the canvas asks first; broken, it says why in plain words and
// offers Connect again; and while the API says Google is not set up for Manut AI, it says that. The words and the moves are
// google.ts's; the boards are Connections.dc.html and Connect.dc.html.
//
// The views use no hooks, so a test calls them as plain functions to read their handlers. `useGoogle` feeds them through a client of
// the runtime of the tab's own, as the vault's does: nothing the row sends passes through the store, and Google's consent address
// goes from the runtime's answer to the system browser and nowhere else (google.ts says how).
import { useEffect, useReducer, useRef, useState } from "react";
import { t } from "../i18n";
import { openExternal } from "../lib/openExternal";
import type { Op, OpParams, OpResult } from "../lib/protocol";
import { createRuntime, runtimeKind, type RuntimeAdapter } from "../runtime";
import { endedMonths, type ShopGoogle } from "../runtime/google";
import { formKeys } from "./formKeys";
import {
  againText,
  GOOGLE_START,
  googleBooks,
  googleCheck,
  googleConnect,
  googleDisconnect,
  googleReduce,
  googleRow,
  monthOptions,
  optionText,
  refusalText,
  type GoogleAction,
  type GoogleCalls,
  type GoogleStep,
  type GoogleUi,
} from "./google";
import { LOADING, load, type Load } from "./load";

/** What the row needs of the page: the runtime's word on the shop's Google Sheets, the one question open, and what each button does. */
export interface GoogleProps {
  state: Load<ShopGoogle>;
  ui: GoogleUi;
  nowMs: number;
  dispatch: (a: GoogleAction) => void;
  /** Connect, and Connect again */
  onConnect: () => void;
  /** Check now, while Google's page is open */
  onCheck: () => void;
  /** Ask Ton, in the month picker, and Ask Ton anyway, in the question about a month that was sent */
  onSend: () => void;
  /** Disconnect, in the open question */
  onDisconnect: () => void;
  onOpenSheet: () => void;
  /** Open Needs you, from Ton's ask */
  onOpenNeeds: () => void;
}

/** What the last change said, in the row: why it did not happen, or what it did. Ton's ask offers Needs you, where it waits. */
function Said({ p }: { p: GoogleProps }) {
  const { ui } = p;
  return (
    <>
      {ui.error && (
        <p className="msg err" role="alert" data-testid="google-error">
          {ui.error}
        </p>
      )}
      {ui.notice && (
        <p className={ui.waiting ? "msg" : "msg ok"} role="status" data-testid="google-notice">
          {ui.notice}
          {ui.asked && (
            <>
              {" "}
              <button type="button" className="btn" onClick={p.onOpenNeeds} data-testid="google-open-needs">
                {t("google.openNeeds")}
              </button>
            </>
          )}
        </p>
      )}
    </>
  );
}

/** The buttons the row's state offers. Nothing is offered while a change is on its way, a question is open or Google's page is open. */
function Buttons({ p, g }: { p: GoogleProps; g: ShopGoogle }) {
  const { ui, dispatch } = p;
  const locked = ui.busy || ui.ask !== null || ui.waiting !== null;
  if (g.state === "off") return null;
  return (
    <span className="google-acts">
      {(g.state === "none" || g.state === "broken") && (
        <button type="button" className="btn dark" disabled={locked} onClick={p.onConnect} data-testid="google-connect">
          {g.state === "broken" ? t("google.connectAgain") : t("google.connect")}
        </button>
      )}
      {g.state === "working" && (
        <button type="button" className="btn" disabled={locked} onClick={() => dispatch({ type: "send", month: endedMonths(p.nowMs)[0] ?? "" })} data-testid="google-send">
          {t("google.send")}
        </button>
      )}
      {g.state === "working" && g.sheet?.url && (
        <button type="button" className="lk" disabled={ui.busy} onClick={p.onOpenSheet} data-testid="google-sheet">
          {t("google.openSheet")}
        </button>
      )}
      {(g.state === "working" || g.state === "broken") && (
        <button type="button" className="lk" disabled={locked} onClick={() => dispatch({ type: "disconnect" })} data-testid="google-disconnect">
          {t("google.disconnect")}
        </button>
      )}
    </span>
  );
}

/** Google's page is open: the canvas's waiting box, with Check now where the canvas has "Open it again", which this row cannot offer
 *  (the address is used once and kept nowhere), and Not now where it has Cancel. */
function Waiting({ p }: { p: GoogleProps }) {
  return (
    <div className="ask google-wait" role="status" data-testid="google-waiting">
      <span className="conn-name">
        <span className="spin" aria-hidden="true" /> {t("google.waitingTitle")}
      </span>
      <span className="conn-line">{t("google.waitingHint")}</span>
      <div className="chips">
        <button type="button" className="btn" disabled={p.ui.busy} onClick={p.onCheck} data-testid="google-check">
          {t("google.checkNow")}
        </button>
        <button type="button" className="btn" disabled={p.ui.busy} onClick={() => p.dispatch({ type: "stopWaiting" })} data-testid="google-not-now">
          {t("google.notNow")}
        </button>
      </div>
    </div>
  );
}

/** The question open in the row, if any: which month to send, the month that was sent before, or Disconnect. Nothing is changed until
 *  the owner answers it. */
function Question({ p, g }: { p: GoogleProps; g: ShopGoogle }) {
  const { ui, dispatch } = p;
  const ask = ui.ask;
  const cancel = () => dispatch({ type: "cancel" });
  const keys = formKeys(cancel);
  if (!ask) return null;

  // Disconnect: what stops and what is kept, with the safe answer holding the focus. Its buttons have keys of their own, so they are
  // new elements rather than the row's buttons reused: `autoFocus` acts only on an element as it first appears.
  if (ask.kind === "disconnect") {
    return (
      <div className="ask" onKeyDown={keys} data-testid="google-disconnect-ask">
        <span className="conn-line" data-testid="google-disconnect-question">
          {t("google.disconnectAsk")}
        </span>
        <div className="chips">
          <button key="disconnect-yes" type="button" className="btn danger solid" disabled={ui.busy} onClick={p.onDisconnect} data-testid="google-disconnect-yes">
            {t("google.disconnect")}
          </button>
          <button key="disconnect-keep" type="button" className="btn" autoFocus disabled={ui.busy} onClick={cancel} data-testid="google-disconnect-keep">
            {t("google.keep")}
          </button>
        </div>
      </div>
    );
  }

  const options = monthOptions(g, p.nowMs);
  const chosen = options.find((o) => o.month === ask.month);

  // A month that was sent before: asking again adds its rows again, so the owner is asked first, with the safe answer holding the focus.
  if (ask.kind === "again" && chosen) {
    return (
      <div className="ask" onKeyDown={keys} data-testid="google-again">
        <span className="conn-line" data-testid="google-again-text">
          {againText(chosen, p.nowMs)}
        </span>
        <div className="chips">
          <button key="again-yes" type="button" className="btn" disabled={ui.busy} onClick={p.onSend} data-testid="google-again-yes">
            {ui.busy ? t("google.asking") : t("google.askAnyway")}
          </button>
          <button key="again-keep" type="button" className="btn" autoFocus disabled={ui.busy} onClick={cancel} data-testid="google-again-keep">
            {t("conn.cancel")}
          </button>
        </div>
      </div>
    );
  }

  // Send a month's books: the months that have ended, the ones already sent marked, and Ton's word that nothing goes until the owner
  // approves it in Needs you.
  return (
    <form
      className="ask"
      data-testid="google-pick"
      onKeyDown={keys}
      onSubmit={(e) => {
        e.preventDefault();
        if (!ui.busy) p.onSend();
      }}
    >
      <label className="small" htmlFor="google-month">
        {t("google.pick")}
      </label>
      <select id="google-month" className="input" value={ask.month} disabled={ui.busy} autoFocus onChange={(e) => dispatch({ type: "month", month: e.target.value })} data-testid="google-month">
        {options.map((o) => (
          <option key={o.month} value={o.month} data-sent={o.sent ? o.sent.outcome : undefined}>
            {optionText(o, p.nowMs)}
          </option>
        ))}
      </select>
      <p className="help">{t("google.pickHint")}</p>
      <div className="chips">
        <button type="submit" className="btn dark" disabled={ui.busy} data-testid="google-ask">
          {ui.busy ? t("google.asking") : t("google.ask")}
        </button>
        <button type="button" className="btn" disabled={ui.busy} onClick={cancel} data-testid="google-pick-cancel">
          {t("conn.cancel")}
        </button>
      </div>
    </form>
  );
}

/** The canvas's app row for Google Sheets: "G", its name over its quiet lines, its tag and its buttons, then the waiting box or the
 *  question under it. */
export function GooglePane({ p }: { p: GoogleProps }) {
  const { state, ui } = p;
  // A shop the person only helps at is its owner's, which the Vault box says already: this row stays out of it.
  if (state.kind === "unavailable" && state.code === "owner_only") return null;
  const g = state.kind === "ready" ? state.value : null;
  const row = g ? googleRow(g, p.nowMs) : null;
  return (
    <section className="side2 google" aria-labelledby="google-title" aria-busy={state.kind === "loading" || undefined} data-testid="google">
      <div className="vhead">
        <h2 className="h2" id="google-title">
          {t("google.title")}
        </h2>
      </div>
      <p className="hint">{t("google.hint")}</p>
      <Said p={p} />
      {state.kind === "loading" && (
        <p className="none" data-testid="google-loading">
          {t("google.loading")}
        </p>
      )}
      {state.kind === "unavailable" && (
        <p className="none" role="status" data-testid="google-unavailable">
          {refusalText(state.code, state.message)}
        </p>
      )}
      {g && row && (
        <div className="box">
          <div className={g.state === "broken" ? "tr google-row broken" : "tr google-row"} data-testid="google-row" data-state={g.state}>
            <span className="av google-av" aria-hidden="true">
              G
            </span>
            <span className="grow">
              <span className="conn-name" data-testid="google-name">
                {row.name}
              </span>
              {row.lines.map((line, i) => (
                <span key={i} className="conn-line" data-testid="google-line">
                  {line}
                </span>
              ))}
            </span>
            <span className={row.tag.tone === "ok" ? "tag ok" : row.tag.tone === "warn" ? "tag warn" : "tag"} data-testid="google-tag">
              {row.tag.text}
            </span>
            <Buttons p={p} g={g} />
          </div>
          {ui.waiting && <Waiting p={p} />}
          {!ui.waiting && <Question p={p} g={g} />}
        </div>
      )}
    </section>
  );
}

// ---- the tab's own client of the runtime ---------------------------------------------------------------------------------

/** Waits for a client that is opening, a moment at most: one the runtime cannot open now (signed out, offline) is asked anyway, and
 *  its refusal says why, as the store's own client says it. */
async function opened(client: RuntimeAdapter): Promise<void> {
  if (client.status === "open") return;
  await Promise.race([client.connect().catch(() => undefined), new Promise((resolve) => setTimeout(resolve, 0))]);
}

/** The row, read when the tab is shown (`active`) and again when the switcher shows another shop (`viewing`), and read again when the
 *  window comes back to the front while Google's page is open. Null on a runtime that is not this computer's own or the API (the
 *  loopback bridge of the Playwright suite): nothing is sent there. `openNeeds` opens Needs you, where Ton's ask waits. */
export function useGoogle(active: boolean, viewing: string | null, openNeeds: () => void): GoogleProps | null {
  const offered = runtimeKind() !== "websocket";
  const client = useRef<RuntimeAdapter | null>(null);
  const [state, setState] = useState<Load<ShopGoogle>>(LOADING);
  const [ui, dispatch] = useReducer(googleReduce, GOOGLE_START);
  /** What the window coming back does: always the latest state's, so a listener added once never reads a stale one. */
  const back = useRef<() => void>(() => undefined);

  useEffect(() => {
    if (!offered) return;
    const own = createRuntime();
    client.current = own;
    return () => {
      client.current = null;
      own.close();
    };
  }, [offered]);

  const ask = async <K extends Op>(op: K, params: OpParams<K>): Promise<OpResult<K>> => {
    const own = client.current;
    if (!own) throw { code: "disconnected", message: t("bot.offline") };
    await opened(own);
    return own.request(op, params);
  };

  useEffect(() => {
    if (!offered || !active) return;
    let live = true;
    setState(LOADING);
    dispatch({ type: "reset" });
    void load(() => ask("google.status", {})).then((r) => live && setState(r));
    return () => {
      live = false;
    };
    // `ask` reads the client from its ref, so it is the same whenever it is called.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [offered, active, viewing]);

  // The window coming to the front again is when Google's page was closed and the owner is back: the status is read, and says whether
  // the connection is there. Only while Google's page is open.
  const waiting = ui.waiting !== null;
  useEffect(() => {
    if (!offered || !waiting) return;
    const onBack = () => {
      if (document.visibilityState !== "hidden") back.current();
    };
    window.addEventListener("focus", onBack);
    document.addEventListener("visibilitychange", onBack);
    return () => {
      window.removeEventListener("focus", onBack);
      document.removeEventListener("visibilitychange", onBack);
    };
  }, [offered, waiting]);

  if (!offered) return null;

  const calls: GoogleCalls = {
    status: () => ask("google.status", {}),
    connect: (shop) => ask("google.connect", { shop }),
    disconnect: (shop) => ask("google.disconnect", { shop }),
    books: (shop, month) => ask("google.books", { shop, month }),
    open: openExternal,
  };
  const data = state.kind === "ready" ? state.value : null;
  const apply = (step: GoogleStep) => {
    setState({ kind: "ready", value: step.data });
    dispatch(step.action);
  };
  const run = async (step: (data: ShopGoogle) => Promise<GoogleStep>) => {
    if (!data || ui.busy) return;
    dispatch({ type: "begin" });
    apply(await step(data));
  };
  back.current = () => {
    const open = ui.waiting;
    if (!data || !open || ui.busy) return;
    void googleCheck(calls, data, open, Date.now()).then(apply);
  };

  return {
    state,
    ui,
    nowMs: Date.now(),
    dispatch,
    onConnect: () => void run((d) => googleConnect(calls, d)),
    onCheck: () => back.current(),
    onSend: () => {
      const open = ui.ask;
      if (!data || ui.busy || (open?.kind !== "send" && open?.kind !== "again")) return;
      const chosen = monthOptions(data, Date.now()).find((o) => o.month === open.month);
      // A month that went to the sheet before is asked about first: asking again adds its rows again.
      if (open.kind === "send" && chosen?.sent) {
        dispatch({ type: "again" });
        return;
      }
      void run((d) => googleBooks(calls, d, open.month));
    },
    onDisconnect: () => {
      if (ui.ask?.kind === "disconnect") void run((d) => googleDisconnect(calls, d));
    },
    onOpenSheet: () => {
      if (data?.state === "working" && data.sheet?.url) void openExternal(data.sheet.url).catch(() => undefined);
    },
    onOpenNeeds: openNeeds,
  };
}
