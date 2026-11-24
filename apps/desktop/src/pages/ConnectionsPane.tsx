// Customize › Connections for the shop's owner, around this Mac's Outposts box (OutpostPane.tsx): the canvas's Vault box
// above it, with each site sign-in, who may use it, whether it works, when it was added, its Change, Who uses it and Remove,
// and the canvas's Add a sign-in under them; and below it, every outpost the shop has, each with Rename and Remove. The words
// and the rows are connections.ts's; the boards are Connections.dc.html and StatesCustomize.dc.html, which draw Add a sign-in
// as a link and no form, and Change as a link, so each form is the tab's own in-place question. Change keeps the canvas's word
// and grows to the sign-in's account and addresses as well as its password; Remove asks once, naming the site and the
// account, before anything is removed.
//
// This Mac's own row stays the shell's, with its Start and Stop. The shell gives the page the id this Mac's outpost has on
// the shop's list (src-tauri/src/outpost/mod.rs, `View`), never its credential, so this Mac's record is folded into that row
// (`ThisMacRecord`: its name, Rename and Remove) and the list below shows the shop's other outposts. Until the shell says
// which it is, or when this Mac is not this shop's outpost, the list shows every one by its name rather than guess.
//
// The views use no hooks, so a test calls them as plain functions to read their handlers. `useConnections` feeds them through
// a client of the runtime of the tab's own: nothing the tab sends passes through the store, and the password typed into
// Change or Add a sign-in goes from the field to that client once and is then gone from the page (connections.ts says how).
import { useEffect, useReducer, useRef, useState } from "react";
import { t } from "../i18n";
import type { Op, OpParams, OpResult } from "../lib/protocol";
import { createRuntime, runtimeKind, type RuntimeAdapter } from "../runtime";
import {
  MAX_ORIGINS,
  MAX_OUTPOST_NAME,
  MAX_PASSWORD,
  MAX_SITE,
  MAX_USERNAME,
  SIGN_IN_MEMBERS,
  type ShopConnections,
  type ShopOutpost,
  type VaultSignIn,
} from "../runtime/connections";
import {
  addedLine,
  addFields,
  addressProblem,
  changeTodo,
  CONN_START,
  connectionsDo,
  connReduce,
  memberName,
  membersReady,
  nameReady,
  outpostLine,
  passwordNeeded,
  readAddresses,
  refusalText,
  signInLine,
  siteProblem,
  usernameProblem,
  type AddDraft,
  type ChangeDraft,
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
  /** Save, in the open Change, Who uses it or Rename; Add, in Add a sign-in */
  onSave: () => void;
  /** Remove, in the open question about a sign-in or an outpost */
  onRemove: () => void;
}

/** What the last change said, shown in the part of the tab it was in. */
export function Said({ ui, at }: { ui: ConnUi; at: ConnUi["at"] }) {
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

/** A sign-in's address fields, in Add a sign-in (`prefix` "add") or Change ("change"): one field for each address, each
 *  read as the vault would keep it and said under it when it cannot be (not https, an account in it, a repeat) or when only
 *  its site's part is kept, with Remove beside each while there is more than one, and room for up to five. */
function AddressesField({ addresses, p, prefix }: { addresses: readonly string[]; p: ConnectionsProps; prefix: "add" | "change" }) {
  const { ui, dispatch } = p;
  const reads = readAddresses(addresses);
  return (
    <fieldset className="field" data-testid={`${prefix}-addresses`}>
      <legend>{t("vault.add.addresses")}</legend>
      <p className="help">{t("vault.add.addressesHint")}</p>
      {addresses.map((text, i) => {
        const read = reads[i];
        const problem = read?.kind === "problem";
        return (
          <div key={i} className="address" data-testid={`${prefix}-address-row`}>
            <div className="address-row">
              <input
                className="input"
                type="text"
                inputMode="url"
                value={text}
                placeholder={t("vault.add.addressExample")}
                aria-label={t("vault.add.addressN", { n: i + 1 })}
                aria-invalid={problem || undefined}
                autoComplete="off"
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
                disabled={ui.busy}
                onChange={(e) => dispatch({ type: "address", index: i, text: e.target.value })}
                data-testid={`${prefix}-address`}
              />
              {addresses.length > 1 && (
                <button
                  type="button"
                  className="lk"
                  disabled={ui.busy}
                  onClick={() => dispatch({ type: "addressLess", index: i })}
                  aria-label={t("vault.add.addressRemove", { n: i + 1 })}
                  data-testid={`${prefix}-address-remove`}
                >
                  {t("outposts.remove")}
                </button>
              )}
            </div>
            {read?.kind === "problem" && (
              <p className="help err" data-testid={`${prefix}-address-problem`}>
                {addressProblem(read.problem)}
              </p>
            )}
            {read?.kind === "origin" && read.changed && (
              <p className="help" data-testid={`${prefix}-address-kept`}>
                {t("vault.add.kept", { origin: read.origin })}
              </p>
            )}
          </div>
        );
      })}
      {addresses.length < MAX_ORIGINS && (
        <button type="button" className="lk more" disabled={ui.busy} onClick={() => dispatch({ type: "addressMore" })} data-testid={`${prefix}-address-more`}>
          {t("vault.add.addressMore")}
        </button>
      )}
    </fieldset>
  );
}

/** Change, in the sign-in's own row: its password first, as "Needs a new password" asks, then the account's name and the
 *  addresses as the vault has them. Save waits for something new the vault would take: a new password, or a new account or
 *  address with the password typed again (addresses only taken away need none), and says under the password when it is
 *  needed. Nothing is sent until Save, and what was typed into the password leaves the page's state as it is sent. */
function ChangeForm({ s, p, draft }: { s: VaultSignIn; p: ConnectionsProps; draft: ChangeDraft }) {
  const { ui, dispatch } = p;
  const ready = changeTodo(s, draft) !== null;
  const needed = draft.password === "" && passwordNeeded(s, draft);
  const badUser = usernameProblem(draft);
  const cancel = () => dispatch({ type: "cancel" });
  const set = (field: "username" | "password") => (e: { target: { value: string } }) => dispatch({ type: "field", field, text: e.target.value });
  return (
    <form
      className="ask change-signin"
      data-testid="change-form"
      onKeyDown={formKeys(cancel)}
      onSubmit={(e) => {
        e.preventDefault();
        if (ready && !ui.busy) p.onSave();
      }}
    >
      <div className="field">
        <label className="small" htmlFor={`password-${s.id}`}>
          {t("vault.change.password", { site: s.site })}
        </label>
        <input
          id={`password-${s.id}`}
          className="input"
          type="password"
          value={draft.password}
          maxLength={MAX_PASSWORD}
          autoFocus
          autoComplete="new-password"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          disabled={ui.busy}
          aria-invalid={needed || undefined}
          onChange={set("password")}
          data-testid="password-input"
        />
        <p className={needed ? "help err" : "help"} data-testid="change-password-help">
          {needed ? t("vault.change.again") : t("vault.changeHint")}
        </p>
      </div>
      <div className="field">
        <label htmlFor={`change-username-${s.id}`}>{t("vault.add.username")}</label>
        <input
          id={`change-username-${s.id}`}
          className="input"
          type="text"
          value={draft.username}
          autoComplete="off"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          disabled={ui.busy}
          aria-invalid={badUser || undefined}
          onChange={set("username")}
          data-testid="change-username"
        />
        <p className={badUser ? "help err" : "help"} data-testid="change-username-help">
          {badUser ? t("conn.err.username", { max: MAX_USERNAME }) : t("vault.add.usernameHint")}
        </p>
      </div>
      <AddressesField addresses={draft.addresses} p={p} prefix="change" />
      <div className="chips">
        <button type="submit" className="btn dark" disabled={ui.busy || !ready} data-testid="change-save">
          {ui.busy ? t("conn.saving") : t("conn.save")}
        </button>
        <button type="button" className="btn" disabled={ui.busy} onClick={cancel} data-testid="change-cancel">
          {t("conn.cancel")}
        </button>
      </div>
    </form>
  );
}

/** Who may use a sign-in: a box for each member whose jobs run through a connection, by name, ticked for those who may.
 *  Nam, Pim, Ton and Kit are named the same in every language. */
function MembersField({ chosen, p, legend, testid }: { chosen: readonly string[]; p: ConnectionsProps; legend: string; testid: string }) {
  return (
    <fieldset className="field" data-testid={testid}>
      <legend>{legend}</legend>
      <div className="chips">
        {SIGN_IN_MEMBERS.map((m) => (
          <label key={m} className={chosen.includes(m) ? "daychip on" : "daychip"}>
            <input type="checkbox" value={m} checked={chosen.includes(m)} disabled={p.ui.busy} onChange={() => p.dispatch({ type: "member", member: m })} data-testid={`member-${m}`} />
            {memberName(m)}
          </label>
        ))}
      </div>
      <p className="help">{t("vault.whoHint")}</p>
    </fieldset>
  );
}

/** Who uses it, in the sign-in's own row: the members' boxes and Save, which is ready once someone is ticked and it says
 *  something new. Nothing is sent until Save. */
function MembersForm({ s, p, chosen }: { s: VaultSignIn; p: ConnectionsProps; chosen: readonly string[] }) {
  const { ui, dispatch } = p;
  const ready = membersReady(chosen, s.members);
  const cancel = () => dispatch({ type: "cancel" });
  return (
    <form
      className="ask"
      data-testid="members-form"
      onKeyDown={formKeys(cancel)}
      onSubmit={(e) => {
        e.preventDefault();
        if (ready && !ui.busy) p.onSave();
      }}
    >
      <MembersField chosen={chosen} p={p} legend={t("vault.whoAsk", { site: s.site })} testid="members-field" />
      <div className="chips">
        <button type="submit" className="btn dark" disabled={ui.busy || !ready} data-testid="members-save">
          {ui.busy ? t("conn.saving") : t("conn.save")}
        </button>
        <button type="button" className="btn" disabled={ui.busy} onClick={cancel} data-testid="members-cancel">
          {t("conn.cancel")}
        </button>
      </div>
    </form>
  );
}

/** Remove, asked in the sign-in's own row: the site and the account named, that the team can no longer sign in there, and
 *  that it cannot be undone but by adding it again with its password, with the safe answer holding the focus. Nothing is
 *  removed until the owner says so. Its buttons have keys of their own, so they are new elements rather than the row's links
 *  reused: `autoFocus` acts only on an element as it first appears. */
function RemoveSignInQuestion({ s, p }: { s: VaultSignIn; p: ConnectionsProps }) {
  const { ui, dispatch } = p;
  const cancel = () => dispatch({ type: "cancel" });
  return (
    <div className="tr signin" data-testid="signin" data-signin={s.id} onKeyDown={formKeys(cancel)}>
      <span className="grow">
        <span className="conn-name">{s.site}</span>
        <span className="conn-line" data-testid="signin-remove-question">
          {t("vault.removeAsk", { site: s.site, account: s.username })}
        </span>
      </span>
      <button key="remove-yes" type="button" className="btn danger solid" disabled={ui.busy} onClick={p.onRemove} data-testid="signin-remove-yes">
        {t("outposts.remove")}
      </button>
      <button key="remove-keep" type="button" className="btn" autoFocus disabled={ui.busy} onClick={cancel} data-testid="signin-remove-keep">
        {t("outposts.keep")}
      </button>
    </div>
  );
}

function SignInRow({ s, p }: { s: VaultSignIn; p: ConnectionsProps }) {
  const asked = p.ui.ask !== null && "signIn" in p.ui.ask && p.ui.ask.signIn === s.id ? p.ui.ask : null;
  if (asked?.kind === "removeSignIn") return <RemoveSignInQuestion s={s} p={p} />;
  const broken = s.state === "broken";
  const locked = p.ui.busy || p.ui.ask !== null;
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
      {!asked && (
        <span className="signin-acts">
          <button
            type="button"
            className={broken ? "btn" : "lk"}
            disabled={locked}
            onClick={() => p.dispatch({ type: "change", signIn: s.id, username: s.username, origins: s.origins })}
            aria-label={`${t("vault.change")}: ${s.site}`}
            data-testid="signin-change"
          >
            {t("vault.change")}
          </button>
          <button
            type="button"
            className="lk"
            disabled={locked}
            onClick={() => p.dispatch({ type: "who", signIn: s.id, members: s.members })}
            aria-label={`${t("vault.who")}: ${s.site}`}
            data-testid="signin-who"
          >
            {t("vault.who")}
          </button>
          <button
            type="button"
            className="lk"
            disabled={locked}
            onClick={() => p.dispatch({ type: "removeSignIn", signIn: s.id })}
            aria-label={`${t("outposts.remove")}: ${s.site}`}
            data-testid="signin-remove"
          >
            {t("outposts.remove")}
          </button>
        </span>
      )}
      {asked?.kind === "change" && <ChangeForm s={s} p={p} draft={asked.draft} />}
      {asked?.kind === "members" && <MembersForm s={s} p={p} chosen={asked.members} />}
    </div>
  );
}

/** Add a sign-in, in place of its link under the sign-ins: the site's name, its address or addresses, the account's name on
 *  it, its password and who may use it. What the vault would not keep is said under its field as it is typed, and Add waits
 *  until everything is there. The password leaves the page's state as Add is pressed, and is never shown. */
function AddSignInForm({ p, draft }: { p: ConnectionsProps; draft: AddDraft }) {
  const { ui, dispatch } = p;
  const ready = addFields(draft) !== null;
  const cancel = () => dispatch({ type: "cancel" });
  const set = (field: "site" | "username" | "password") => (e: { target: { value: string } }) => dispatch({ type: "field", field, text: e.target.value });
  const longSite = siteProblem(draft);
  const badUser = usernameProblem(draft);
  return (
    <form
      className="ask add-signin"
      aria-labelledby="add-signin-title"
      data-testid="add-form"
      onKeyDown={formKeys(cancel)}
      onSubmit={(e) => {
        e.preventDefault();
        if (ready && !ui.busy) p.onSave();
      }}
    >
      <p className="conn-name" id="add-signin-title">
        {t("vault.add.title")}
      </p>
      <div className="field">
        <label htmlFor="add-site">{t("vault.add.site")}</label>
        <input
          id="add-site"
          className="input"
          type="text"
          value={draft.site}
          placeholder={t("vault.add.siteExample")}
          autoFocus
          autoComplete="off"
          disabled={ui.busy}
          aria-invalid={longSite || undefined}
          onChange={set("site")}
          data-testid="add-site"
        />
        {longSite && (
          <p className="help err" data-testid="add-site-problem">
            {t("conn.err.site", { max: MAX_SITE })}
          </p>
        )}
      </div>
      <AddressesField addresses={draft.addresses} p={p} prefix="add" />
      <div className="field">
        <label htmlFor="add-username">{t("vault.add.username")}</label>
        <input
          id="add-username"
          className="input"
          type="text"
          value={draft.username}
          autoComplete="off"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          disabled={ui.busy}
          aria-invalid={badUser || undefined}
          onChange={set("username")}
          data-testid="add-username"
        />
        <p className={badUser ? "help err" : "help"} data-testid="add-username-help">
          {badUser ? t("conn.err.username", { max: MAX_USERNAME }) : t("vault.add.usernameHint")}
        </p>
      </div>
      <div className="field">
        <label htmlFor="add-password">{t("vault.add.password")}</label>
        <input
          id="add-password"
          className="input"
          type="password"
          value={draft.password}
          maxLength={MAX_PASSWORD}
          autoComplete="new-password"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          disabled={ui.busy}
          onChange={set("password")}
          data-testid="add-password"
        />
        <p className="help">{t("vault.changeHint")}</p>
      </div>
      <MembersField chosen={draft.members} p={p} legend={t("vault.add.who")} testid="add-members" />
      <div className="chips">
        <button type="submit" className="btn dark" disabled={ui.busy || !ready} data-testid="add-save">
          {ui.busy ? t("conn.saving") : t("vault.add.save")}
        </button>
        <button type="button" className="btn" disabled={ui.busy} onClick={cancel} data-testid="add-cancel">
          {t("conn.cancel")}
        </button>
      </div>
    </form>
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
          {/* The canvas's last row: Add a sign-in, which opens its form in the row's place. */}
          <div className="tr add-row" data-testid="signin-add-row">
            {ui.ask?.kind === "add" ? (
              <AddSignInForm p={p} draft={ui.ask.draft} />
            ) : (
              <button type="button" className="lk" disabled={ui.busy || ui.ask !== null} onClick={() => p.dispatch({ type: "add" })} data-testid="signin-add">
                {t("vault.add")}
              </button>
            )}
          </div>
        </div>
      )}
    </section>
  );
}

// ---- the shop's outposts ------------------------------------------------------------------------------------------------

/** The question open about outpost `o`, if any: Rename or Remove. */
const askAbout = (o: ShopOutpost, p: ConnectionsProps) => ((p.ui.ask?.kind === "rename" || p.ui.ask?.kind === "remove") && p.ui.ask.outpost === o.id ? p.ui.ask : null);

/** The question open about outpost `o`, drawn in place of its row (`testid` names the row: the shop's list, or this Mac's
 *  own row in the Outposts box), or nothing when none is open. */
function OutpostQuestion({ o, p, testid }: { o: ShopOutpost; p: ConnectionsProps; testid: string }) {
  const { ui, dispatch } = p;
  const ask = askAbout(o, p);
  const cancel = () => dispatch({ type: "cancel" });
  const keys = formKeys(cancel);
  if (!ask) return null;

  // Rename: the outpost's name in a field, in its row. Nothing changes until Save.
  if (ask.kind === "rename") {
    const ready = nameReady(ask.draft, o.name);
    const long = [...ask.draft.trim()].length > MAX_OUTPOST_NAME;
    return (
      <form
        className="tr ask"
        data-testid={testid}
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
  return (
    <div className="tr" data-testid={testid} data-outpost={o.id} onKeyDown={keys}>
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
}

/** Rename and Remove for outpost `o`, each opening its question in the row; one asked from this Mac's own row says its
 *  words there (`at`). */
function OutpostLinks({ o, p, at }: { o: ShopOutpost; p: ConnectionsProps; at?: "this_mac" }) {
  const { ui, dispatch } = p;
  const where = at ? { at } : {};
  return (
    <>
      <button
        type="button"
        className="lk"
        disabled={ui.busy || ui.ask !== null}
        onClick={() => dispatch({ type: "rename", outpost: o.id, name: o.name, ...where })}
        aria-label={`${t("outposts.rename")}: ${o.name}`}
        data-testid="outpost-rename"
      >
        {t("outposts.rename")}
      </button>
      <button
        type="button"
        className="lk"
        disabled={ui.busy || ui.ask !== null}
        onClick={() => dispatch({ type: "remove", outpost: o.id, ...where })}
        aria-label={`${t("outposts.remove")}: ${o.name}`}
        data-testid="outpost-remove"
      >
        {t("outposts.remove")}
      </button>
    </>
  );
}

function OutpostRow({ o, p }: { o: ShopOutpost; p: ConnectionsProps }) {
  if (askAbout(o, p)) return <OutpostQuestion o={o} p={p} testid="shop-outpost" />;
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
      <OutpostLinks o={o} p={p} />
    </div>
  );
}

/** This Mac's own record on the shop's list, folded into this Mac's row in the Outposts box (OutpostPane.tsx) once the shell
 *  says which outpost it is: the name the shop knows it by, with Rename and Remove, which ask in this row and say their
 *  words beside it. Where it stands, Online or Asleep and its steps, is the shell's, in the row above. */
export function ThisMacRecord({ o, p }: { o: ShopOutpost; p: ConnectionsProps }) {
  if (askAbout(o, p)) return <OutpostQuestion o={o} p={p} testid="this-mac-record" />;
  return (
    <div className="tr" data-testid="this-mac-record" data-outpost={o.id}>
      <span className="grow">
        <span className="conn-line" data-testid="this-mac-name">
          {t("outpost.named", { name: o.name })}
        </span>
      </span>
      <OutpostLinks o={o} p={p} at="this_mac" />
    </div>
  );
}

/** Every outpost the shop has, as the API lists it, each with Rename and Remove, but this Mac's own (`thisMac`, the id the
 *  shell gives), which is folded into this Mac's row above so it is not shown twice. Drawn once the vault was read: until
 *  then, or when it could not be, the Vault box says why. */
export function ShopOutpostsPane({ p, thisMac = null }: { p: ConnectionsProps; thisMac?: string | null }) {
  if (p.state.kind !== "ready") return null;
  const all = p.state.value.outposts;
  const outposts = all.filter((o) => o.id !== thisMac);
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
            {outposts.length < all.length ? t("outposts.noOther") : t("outposts.empty")}
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
    add: (shop, fields) => ask("connections.add", { shop, ...fields }),
    password: (shop, signIn, password) => ask("connections.password", { shop, signIn, password }),
    members: (shop, signIn, members) => ask("connections.members", { shop, signIn, members }),
    change: (shop, signIn, change) => ask("connections.change", { shop, signIn, ...change }),
    removeSignIn: (shop, signIn) => ask("connections.removeSignIn", { shop, signIn }),
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
      // A typed password is read once, here, and `begin` takes it out of the page's state before anything is sent. Change
      // sends a new password alone as one, and a new account or addresses as a change (`changeTodo`).
      if (open.kind === "change" && state.kind === "ready") {
        const now = state.value.signIns.find((s) => s.id === open.signIn);
        const todo = now ? changeTodo(now, open.draft) : null;
        if (todo) void run(todo);
      }
      if (open.kind === "add") {
        const fields = addFields(open.draft);
        if (fields) void run({ what: "add", fields });
      }
      if (open.kind === "members" && state.kind === "ready") {
        const current = state.value.signIns.find((s) => s.id === open.signIn)?.members ?? [];
        if (membersReady(open.members, current)) void run({ what: "members", signIn: open.signIn, members: open.members });
      }
      if (open.kind === "rename" && state.kind === "ready") {
        const current = state.value.outposts.find((o) => o.id === open.outpost)?.name ?? "";
        if (nameReady(open.draft, current)) void run({ what: "rename", outpost: open.outpost, name: open.draft.trim() });
      }
    },
    onRemove: () => {
      const open = ui.ask;
      if (!ui.busy && open?.kind === "remove") void run({ what: "remove", outpost: open.outpost });
      if (!ui.busy && open?.kind === "removeSignIn") void run({ what: "removeSignIn", signIn: open.signIn });
    },
  };
}
