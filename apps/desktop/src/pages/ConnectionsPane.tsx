// Customize › Connections for the shop's owner, around this Mac's Outposts box (OutpostPane.tsx): the canvas's Vault box
// above it, with each site sign-in, who may use it, whether it works, when it was added, and its Change; and below it, every
// outpost the shop has, each with Rename and Remove. The words and the rows are connections.ts's; the boards are
// Connections.dc.html and StatesCustomize.dc.html.
//
// This Mac's own row stays as it was, from the shell, with its Start and Stop. The shell never tells the page which of the
// shop's outposts is this Mac (src-tauri/src/outpost/mod.rs, `View`), so the list below shows every one, this Mac's included,
// by the name it has, rather than guess which.
//
// The views use no hooks, so a test calls them as plain functions to read their handlers. `useConnections` feeds them through
// a client of the runtime of the tab's own: nothing the tab sends passes through the store, and the password typed into
// Change goes from the field to that client once and is then gone from the page (connections.ts says how).
import { useEffect, useReducer, useRef, useState } from "react";
import { t } from "../i18n";
import type { Op, OpParams, OpResult } from "../lib/protocol";
import { createRuntime, runtimeKind, type RuntimeAdapter } from "../runtime";
import { MAX_OUTPOST_NAME, MAX_PASSWORD, type ShopConnections, type ShopOutpost, type VaultSignIn } from "../runtime/connections";
import {
  addedLine,
  CONN_START,
  connectionsDo,
  connReduce,
  nameReady,
  outpostLine,
  passwordReady,
  refusalText,
  signInLine,
  type ConnAction,
  type ConnectionsCalls,
  type ConnUi,
} from "./connections";
import { formKeys } from "./formKeys";
import { LOADING, load, type Load } from "./load";

/** What the tab's two parts need of the page: the runtime's word on the shop's vault and outposts, the one question open,
 *  and what Save and Remove do. */
export interface ConnectionsProps {
  state: Load<ShopConnections>;
  ui: ConnUi;
  nowMs: number;
  dispatch: (a: ConnAction) => void;
  /** Save, in the open Change or Rename */
  onSave: () => void;
  /** Remove, in the open question */
  onRemove: () => void;
}

/** What the last change said, shown in the part of the tab it was in. */
function Said({ ui, at }: { ui: ConnUi; at: ConnUi["at"] }) {
  if (ui.at !== at) return null;
  return (
    <>
      {ui.error && (
        <p className="msg err" role="alert" data-testid={`${at}-error`}>
          {ui.error}
        </p>
      )}
      {ui.notice && (
        <p className="msg ok" role="status" data-testid={`${at}-notice`}>
          {ui.notice}
        </p>
      )}
    </>
  );
}

// ---- the vault ----------------------------------------------------------------------------------------------------------

/** Change, in the sign-in's own row: a password field and Save. Nothing is sent until Save, and what was typed leaves the
 *  field as it is sent. */
function PasswordForm({ s, p, draft }: { s: VaultSignIn; p: ConnectionsProps; draft: string }) {
  const { ui, dispatch } = p;
  const ready = passwordReady(draft);
  const cancel = () => dispatch({ type: "cancel" });
  return (
    <form
      className="ask"
      data-testid="password-form"
      onKeyDown={formKeys(cancel)}
      onSubmit={(e) => {
        e.preventDefault();
        if (ready && !ui.busy) p.onSave();
      }}
    >
      <label className="small" htmlFor={`password-${s.id}`}>
        {t("vault.newPassword", { site: s.site })}
      </label>
      <input
        id={`password-${s.id}`}
        className="input"
        type="password"
        value={draft}
        maxLength={MAX_PASSWORD}
        autoFocus
        autoComplete="new-password"
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        disabled={ui.busy}
        onChange={(e) => dispatch({ type: "draft", text: e.target.value })}
        data-testid="password-input"
      />
      <p className="help">{t("vault.changeHint")}</p>
      <div className="chips">
        <button type="submit" className="btn dark" disabled={ui.busy || !ready} data-testid="password-save">
          {ui.busy ? t("conn.saving") : t("conn.save")}
        </button>
        <button type="button" className="btn" disabled={ui.busy} onClick={cancel} data-testid="password-cancel">
          {t("conn.cancel")}
        </button>
      </div>
    </form>
  );
}

function SignInRow({ s, p }: { s: VaultSignIn; p: ConnectionsProps }) {
  const ask = p.ui.ask?.kind === "password" && p.ui.ask.signIn === s.id ? p.ui.ask : null;
  const broken = s.state === "broken";
  return (
    <div className={broken ? "tr signin broken" : "tr signin"} data-testid="signin" data-signin={s.id}>
      <span className="grow">
        <span className="conn-name">{s.site}</span>
        <span className="conn-line" data-testid="signin-line">
          {signInLine(s, p.nowMs)}
        </span>
        <span className="conn-line" data-testid="signin-added">
          {addedLine(s, p.nowMs)}
        </span>
      </span>
      <span className={broken ? "tag warn" : "tag ok"} data-testid="signin-tag">
        {broken ? t("vault.needsPassword") : t("vault.working")}
      </span>
      {!ask && (
        <button
          type="button"
          className={broken ? "btn" : "lk"}
          disabled={p.ui.busy || p.ui.ask !== null}
          onClick={() => p.dispatch({ type: "change", signIn: s.id })}
          aria-label={`${t("vault.change")}: ${s.site}`}
          data-testid="signin-change"
        >
          {t("vault.change")}
        </button>
      )}
      {ask && <PasswordForm s={s} p={p} draft={ask.draft} />}
    </div>
  );
}

/** The canvas's Vault box: "Sign-ins your team may use. The vault types the password in. The AI never sees it." */
export function VaultPane({ p }: { p: ConnectionsProps }) {
  const { state, ui } = p;
  return (
    <section className="side2 vault" aria-labelledby="vault-title" aria-busy={state.kind === "loading" || undefined} data-testid="vault">
      <div className="vhead">
        <h2 className="h2" id="vault-title">
          {t("vault.title")}
        </h2>
        <span className="tag run">{t("vault.hidden")}</span>
      </div>
      <p className="hint">{t("vault.hint")}</p>
      <Said ui={ui} at="vault" />
      {state.kind === "loading" && (
        <p className="none" data-testid="vault-loading">
          {t("vault.loading")}
        </p>
      )}
      {state.kind === "unavailable" && (
        <p className="none" role="status" data-testid="vault-unavailable">
          {refusalText(state.code, state.message)}
        </p>
      )}
      {state.kind === "ready" && (
        <div className="box">
          {state.value.signIns.length === 0 && (
            <p className="none" data-testid="vault-empty">
              {t("vault.empty")}
            </p>
          )}
          {state.value.signIns.map((s) => (
            <SignInRow key={s.id} s={s} p={p} />
          ))}
        </div>
      )}
    </section>
  );
}

// ---- the shop's outposts ------------------------------------------------------------------------------------------------

function OutpostRow({ o, p }: { o: ShopOutpost; p: ConnectionsProps }) {
  const { ui, dispatch } = p;
  const ask = ui.ask && ui.ask.kind !== "password" && ui.ask.outpost === o.id ? ui.ask : null;
  const cancel = () => dispatch({ type: "cancel" });
  const keys = formKeys(cancel);

  // Rename: the outpost's name in a field, in its row. Nothing changes until Save.
  if (ask?.kind === "rename") {
    const ready = nameReady(ask.draft, o.name);
    const long = [...ask.draft.trim()].length > MAX_OUTPOST_NAME;
    return (
      <form
        className="tr ask"
        data-testid="shop-outpost"
        data-outpost={o.id}
        onKeyDown={keys}
        onSubmit={(e) => {
          e.preventDefault();
          if (ready && !ui.busy) p.onSave();
        }}
      >
        <label className="small" htmlFor={`outpost-name-${o.id}`}>
          {t("outposts.newName", { name: o.name })}
        </label>
        <input
          id={`outpost-name-${o.id}`}
          className="input"
          type="text"
          value={ask.draft}
          autoFocus
          disabled={ui.busy}
          aria-invalid={long || undefined}
          onChange={(e) => dispatch({ type: "draft", text: e.target.value })}
          data-testid="outpost-name-input"
        />
        {long && (
          <p className="help" data-testid="outpost-name-long">
            {t("conn.err.name", { max: MAX_OUTPOST_NAME })}
          </p>
        )}
        <div className="chips">
          <button type="submit" className="btn dark" disabled={ui.busy || !ready} data-testid="outpost-name-save">
            {ui.busy ? t("conn.saving") : t("conn.save")}
          </button>
          <button type="button" className="btn" disabled={ui.busy} onClick={cancel} data-testid="outpost-name-cancel">
            {t("conn.cancel")}
          </button>
        </div>
      </form>
    );
  }

  // Remove: a question in its row, with the safe answer holding the focus. Nothing is removed until the owner says so. Its
  // buttons have keys of their own, so they are new elements rather than the row's Rename and Remove reused: `autoFocus`
  // acts only on an element as it first appears.
  if (ask?.kind === "remove")
    return (
      <div className="tr" data-testid="shop-outpost" data-outpost={o.id} onKeyDown={keys}>
        <span className="grow">
          <span className="conn-name">{o.name}</span>
          <span className="conn-line" data-testid="outpost-remove-question">
            {t("outposts.removeAsk", { name: o.name })}
          </span>
        </span>
        <button key="remove-yes" type="button" className="btn danger solid" disabled={ui.busy} onClick={p.onRemove} data-testid="outpost-remove-yes">
          {t("outposts.remove")}
        </button>
        <button key="remove-keep" type="button" className="btn" autoFocus disabled={ui.busy} onClick={cancel} data-testid="outpost-remove-keep">
          {t("outposts.keep")}
        </button>
      </div>
    );

  return (
    <div className="tr" data-testid="shop-outpost" data-outpost={o.id}>
      <span className="grow">
        <span className="conn-name">{o.name}</span>
        <span className="conn-line" data-testid="shop-outpost-line">
          {outpostLine(o, p.nowMs)}
        </span>
      </span>
      <span className={o.online ? "tag ok" : "tag"} data-testid="shop-outpost-tag">
        {o.online ? t("outpost.online") : t("outpost.asleep")}
      </span>
      <button
        type="button"
        className="lk"
        disabled={ui.busy || ui.ask !== null}
        onClick={() => dispatch({ type: "rename", outpost: o.id, name: o.name })}
        aria-label={`${t("outposts.rename")}: ${o.name}`}
        data-testid="outpost-rename"
      >
        {t("outposts.rename")}
      </button>
      <button
        type="button"
        className="lk"
        disabled={ui.busy || ui.ask !== null}
        onClick={() => dispatch({ type: "remove", outpost: o.id })}
        aria-label={`${t("outposts.remove")}: ${o.name}`}
        data-testid="outpost-remove"
      >
        {t("outposts.remove")}
      </button>
    </div>
  );
}

/** Every outpost the shop has, as the API lists it, each with Rename and Remove. Drawn once the vault was read: until then, or
 *  when it could not be, the Vault box says why. */
export function ShopOutpostsPane({ p }: { p: ConnectionsProps }) {
  if (p.state.kind !== "ready") return null;
  const outposts = p.state.value.outposts;
  return (
    <section className="side2 shop-outposts" aria-labelledby="shop-outposts-title" data-testid="shop-outposts">
      <h2 className="h2" id="shop-outposts-title">
        {t("outposts.title")}
      </h2>
      <p className="hint">{t("outposts.hint")}</p>
      <Said ui={p.ui} at="outposts" />
      <div className="box">
        {outposts.length === 0 && (
          <p className="none" data-testid="shop-outposts-empty">
            {t("outposts.empty")}
          </p>
        )}
        {outposts.map((o) => (
          <OutpostRow key={o.id} o={o} p={p} />
        ))}
      </div>
    </section>
  );
}

// ---- the tab's own client of the runtime ---------------------------------------------------------------------------------

/** Waits for a client that is opening, a moment at most: one the runtime cannot open now (signed out, offline) is asked
 *  anyway, and its refusal says why, as the store's own client says it. */
async function opened(client: RuntimeAdapter): Promise<void> {
  if (client.status === "open") return;
  await Promise.race([client.connect().catch(() => undefined), new Promise((resolve) => setTimeout(resolve, 0))]);
}

/** The tab's two parts, read when the tab is shown (`active`) and again when the switcher shows another shop (`viewing`).
 *  Null on a runtime that is not this computer's own or the API (the loopback bridge of the Playwright suite): a password is
 *  never sent there. */
export function useConnections(active: boolean, viewing: string | null): ConnectionsProps | null {
  const offered = runtimeKind() !== "websocket";
  const client = useRef<RuntimeAdapter | null>(null);
  const [state, setState] = useState<Load<ShopConnections>>(LOADING);
  const [ui, dispatch] = useReducer(connReduce, CONN_START);

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
    void load(() => ask("connections.list", {})).then((r) => live && setState(r));
    return () => {
      live = false;
    };
    // `ask` reads the client from its ref, so it is the same whenever it is called.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [offered, active, viewing]);

  if (!offered) return null;

  const calls: ConnectionsCalls = {
    password: (shop, signIn, password) => ask("connections.password", { shop, signIn, password }),
    rename: (shop, outpost, name) => ask("connections.rename", { shop, outpost, name }),
    remove: (shop, outpost) => ask("connections.remove", { shop, outpost }),
  };
  const run = async (todo: Parameters<typeof connectionsDo>[2]) => {
    if (state.kind !== "ready") return;
    const data = state.value;
    dispatch({ type: "begin" });
    const step = await connectionsDo(calls, data, todo);
    setState({ kind: "ready", value: step.data });
    dispatch(step.action);
  };

  return {
    state,
    ui,
    nowMs: Date.now(),
    dispatch,
    onSave: () => {
      const open = ui.ask;
      if (ui.busy || !open) return;
      // The draft is read once, here, and `begin` takes it out of the page's state before anything is sent.
      if (open.kind === "password" && passwordReady(open.draft)) void run({ what: "password", signIn: open.signIn, password: open.draft });
      if (open.kind === "rename" && state.kind === "ready") {
        const current = state.value.outposts.find((o) => o.id === open.outpost)?.name ?? "";
        if (nameReady(open.draft, current)) void run({ what: "rename", outpost: open.outpost, name: open.draft.trim() });
      }
    },
    onRemove: () => {
      const open = ui.ask;
      if (!ui.busy && open?.kind === "remove") void run({ what: "remove", outpost: open.outpost });
    },
  };
}
