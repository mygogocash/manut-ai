// Settings › People for the shop's owner: who can use Manut AI for the shop the switcher shows, an invite for a helper, cancelling
// an invite, removing a helper, what each role can do, and the cover while the owner is away. The words and the rows are people.ts's;
// the boards are People.dc.html and StatesPeople.dc.html.
//
// Manut AI sends nothing: an invite is a link the owner sends themselves, and the page says so beside the link. Removing a helper
// asks once more in the helper's row, because it signs them out of every device and nothing brings them back; there is no Undo,
// since the API has none, and the page says they can be invited again.
//
// The views use no hooks, so a test calls them as plain functions to read their handlers. `usePeople` feeds them through a client of
// the runtime of the tab's own, as Customize › Connections does (ConnectionsPane.tsx): the helpers' names, LINE IDs, emails and
// invite links pass through the page's own state only, never the store, which is partly saved for a restart.
import { useEffect, useReducer, useRef, useState } from "react";
import { createRuntime, runtimeKind, type RuntimeAdapter } from "../runtime";
import { t } from "../i18n";
import { useStore, viewedShopName } from "../state/store";
import type { Op, OpParams, OpResult, ShopRow } from "../lib/protocol";
import { MAX_HELPER_NAME, type ShopHelper, type ShopInvite, type ShopPeople } from "../runtime/people";
import { formKeys } from "./formKeys";
import { LOADING, load, type Load } from "./load";
import {
  canText,
  contactKind,
  countLine,
  coverLine,
  coverReady,
  endOfDay,
  helperLines,
  helperShopWords,
  inviteLines,
  inviteReady,
  nameOrHelper,
  nameTooLong,
  ownerLine,
  PEOPLE_START,
  peopleDo,
  peopleReduce,
  refusalText,
  roleRows,
  todayField,
  type PeopleAction,
  type PeopleCalls,
  type PeopleDo,
  type PeopleUi,
} from "./people";
import "./people.css";

/** What the page needs of what draws it: the runtime's word on the shop's people, the one form or question open, and what each
 *  button does. */
export interface PeopleProps {
  state: Load<ShopPeople>;
  ui: PeopleUi;
  nowMs: number;
  /** the shop's name as the app shows it ("" when none names it) */
  shop: string;
  /** Set when the shop shown is one the person helps at: what the page says in place of the list. Nothing is read for it. */
  only: string | null;
  dispatch: (a: PeopleAction) => void;
  /** Make invite link, in the open form */
  onInvite: () => void;
  /** Remove, in the open question */
  onRemove: () => void;
  onCancel: (invite: string) => void;
  onCopy: (invite: string, link: string) => void;
  onCover: () => void;
  onEndCover: () => void;
  onRetry: () => void;
}

/** The pastel behind a person's initial, as the board gives each person one of their own. */
const TONES = ["#EFD3CC", "#EDE1B6", "#CDDDEB", "#CEDFCE", "#DBD6EC"] as const;

/** A person's own pastel, from their id, so it stays theirs when the list around them changes (a removal or a cancelled invite
 *  must not recolour everyone below it). The owner is always the first, as the board has Fon. */
export const toneOf = (id: string): number => [...id].reduce((n, c) => (n * 31 + c.charCodeAt(0)) >>> 0, 7) % TONES.length;

function Avatar({ name, tone }: { name: string; tone: number }) {
  return (
    <span className="av lg" aria-hidden="true" style={{ background: TONES[tone % TONES.length] }}>
      {[...name.trim()][0]?.toUpperCase() ?? "?"}
    </span>
  );
}

const Check = () => (
  <svg className="ic" viewBox="0 0 16 16" aria-hidden="true">
    <path d="M3.5 8.5l3 3 6-7" />
  </svg>
);

/** What the last change said, shown in the part of the page it was in. */
function Said({ ui, at }: { ui: PeopleUi; at: PeopleUi["at"] }) {
  if (ui.at !== at) return null;
  return (
    <>
      {ui.error && (
        <p className="msg err" role="alert" data-testid={`people-${at}-error`}>
          {ui.error}
        </p>
      )}
      {ui.notice && (
        <p className="msg ok" role="status" data-testid={`people-${at}-notice`}>
          {ui.notice}
        </p>
      )}
    </>
  );
}

// ---- who can use Manut AI ----------------------------------------------------------------------------------------------------------

/** Remove, asked in the helper's row: the canvas's question, with the safe answer holding the focus. Nothing is removed until the
 *  owner says so. */
function RemoveQuestion({ h, p }: { h: ShopHelper; p: PeopleProps }) {
  const name = nameOrHelper(h.name);
  const cancel = () => p.dispatch({ type: "cancel" });
  return (
    <div className="dialog" role="dialog" aria-labelledby="people-remove-title" onKeyDown={formKeys(cancel)} data-testid="people-remove-question" data-helper={h.id}>
      <h3 id="people-remove-title">{t("people.removeTitle", { name })}</h3>
      <p>{t("people.removeEffect", { name, shop: p.shop || t("people.thisShop") })}</p>
      <p className="mut">{t("people.removeKept", { name })}</p>
      <div className="chips">
        <button key="remove-yes" type="button" className="btn danger solid" disabled={p.ui.busy} onClick={p.onRemove} data-testid="people-remove-yes">
          {t("people.removeYes", { name })}
        </button>
        <button key="remove-keep" type="button" className="btn" autoFocus disabled={p.ui.busy} onClick={cancel} data-testid="people-remove-keep">
          {t("people.removeNo", { name })}
        </button>
      </div>
    </div>
  );
}

function HelperRow({ h, p }: { h: ShopHelper; p: PeopleProps }) {
  if (p.ui.ask?.kind === "remove" && p.ui.ask.helper === h.id) return <RemoveQuestion h={h} p={p} />;
  const name = nameOrHelper(h.name);
  const [since, account] = helperLines(h, p.nowMs);
  const away = p.state.kind === "ready" ? p.state.value.away : null;
  return (
    <div className="rowl" data-testid="people-helper" data-helper={h.id}>
      <Avatar name={name} tone={toneOf(h.id)} />
      <span className="grow">
        <span className="nm">{name}</span>
        <span className="mut sub" data-testid="people-helper-since">
          {since}
        </span>
        <span className="mut sub" data-testid="people-helper-account">
          {account}
        </span>
      </span>
      <span className="tag">{t("shops.helper")}</span>
      {away?.helperId === h.id && away.inForce && (
        <span className="tag run" data-testid="people-covering">
          {t("people.covering")}
        </span>
      )}
      <button
        type="button"
        className="btn ghost"
        disabled={p.ui.busy || p.ui.ask !== null}
        onClick={() => p.dispatch({ type: "askRemove", helper: h.id })}
        aria-label={`${t("people.remove")}: ${name}`}
        data-testid="people-remove"
      >
        {t("people.remove")}
      </button>
    </div>
  );
}

/** The link an invite was just made with, to copy and send: Manut AI does not send it. It is shown so it can be copied by hand
 *  where the clipboard is refused. */
function LinkBox({ i, p }: { i: ShopInvite; p: PeopleProps }) {
  const name = nameOrHelper(i.name);
  if (!i.link)
    return (
      <p className="msg err" role="alert" data-testid="people-no-link">
        {t("people.inv.noLink")}
      </p>
    );
  const copied = p.ui.copied === i.id;
  return (
    <div className="linkbox" data-testid="people-link-box">
      <p className="mut sub">{t("people.inv.send", { name })}</p>
      <div className="linkrow">
        <input className="input mono" type="text" readOnly value={i.link} aria-label={t("people.inv.linkLabel", { name })} onFocus={(e) => e.currentTarget.select()} data-testid="people-link" />
        <button type="button" className="btn" onClick={() => p.onCopy(i.id, i.link!)} data-testid="people-copy-big">
          {copied ? t("people.inv.copied") : t("people.inv.copy")}
        </button>
        <button type="button" className="lk" onClick={() => p.dispatch({ type: "dismiss" })} data-testid="people-link-done">
          {t("people.inv.done")}
        </button>
      </div>
    </div>
  );
}

function InviteRow({ i, p }: { i: ShopInvite; p: PeopleProps }) {
  const name = nameOrHelper(i.name);
  const open = p.ui.made === i.id;
  const waiting = i.state === "pending";
  return (
    <div className="inv" data-testid="people-invite-row" data-invite={i.id} data-state={i.state}>
      <div className="rowl">
        <Avatar name={name} tone={toneOf(i.id)} />
        <span className="grow">
          <span className="nm">{name}</span>
          {inviteLines(i, p.nowMs).map((line, n) => (
            <span key={n} className="mut sub" data-testid="people-invite-line">
              {line}
            </span>
          ))}
        </span>
        <span className={waiting ? "tag" : "tag warn"} data-testid="people-invite-tag">
          {waiting ? t("people.tag.invited") : t("people.tag.expired")}
        </span>
        {waiting && !open && i.link && (
          <button type="button" className="lk" onClick={() => p.onCopy(i.id, i.link!)} aria-label={`${t("people.inv.copy")}: ${name}`} data-testid="people-copy">
            {p.ui.copied === i.id ? t("people.inv.copied") : t("people.inv.copy")}
          </button>
        )}
        {waiting && (
          <button
            type="button"
            className="lk"
            disabled={p.ui.busy || p.ui.ask !== null}
            onClick={() => p.onCancel(i.id)}
            aria-label={`${t("people.inv.cancel")}: ${name}`}
            data-testid="people-cancel-invite"
          >
            {t("people.inv.cancel")}
          </button>
        )}
      </div>
      {waiting && !open && !i.link && (
        <p className="mut sub" data-testid="people-no-link">
          {t("people.inv.noLink")}
        </p>
      )}
      {waiting && open && <LinkBox i={i} p={p} />}
    </div>
  );
}

/** The canvas's form: a name, a LINE ID or an email, and what the invite lets them do. Nothing is made until Make invite link. A
 *  note says what the kind of account typed needs, because that is where it matters: a LINE ID cannot be opened yet. */
function InviteForm({ ask, p }: { ask: { name: string; contact: string }; p: PeopleProps }) {
  const { ui, dispatch } = p;
  const ready = inviteReady(ask.name, ask.contact);
  const cancel = () => dispatch({ type: "cancel" });
  const kind = contactKind(ask.contact);
  const long = nameTooLong(ask.name);
  return (
    <form
      className="box invform"
      data-testid="people-invite-form"
      onKeyDown={formKeys(cancel)}
      onSubmit={(e) => {
        e.preventDefault();
        if (ready && !ui.busy) p.onInvite();
      }}
    >
      <h2 className="h2">{t("people.form.title")}</h2>
      <div className="field">
        <label htmlFor="people-name">{t("people.form.name")}</label>
        <input
          id="people-name"
          className="input"
          type="text"
          value={ask.name}
          autoFocus
          autoComplete="off"
          disabled={ui.busy}
          aria-invalid={long || undefined}
          onChange={(e) => dispatch({ type: "name", text: e.target.value })}
          data-testid="people-name"
        />
        <span className="help" data-testid={long ? "people-name-long" : undefined}>
          {long ? t("people.err.name", { max: MAX_HELPER_NAME }) : t("people.form.nameHelp", { max: MAX_HELPER_NAME })}
        </span>
      </div>
      <div className="field">
        <label htmlFor="people-contact">{t("people.form.contact")}</label>
        <input
          id="people-contact"
          className="input"
          type="text"
          value={ask.contact}
          autoComplete="off"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          disabled={ui.busy}
          onChange={(e) => dispatch({ type: "contact", text: e.target.value })}
          data-testid="people-contact"
        />
        <span className="help">{t("people.form.contactHelp")}</span>
        {kind && (
          <span className="help note" data-testid="people-contact-note">
            {kind === "line" ? t("people.form.lineNote") : t("people.form.emailNote")}
          </span>
        )}
      </div>
      <p>{t("people.form.can", { name: ask.name.trim() || t("people.form.aHelper") })}</p>
      <div className="chips">
        <button type="submit" className="btn dark" disabled={ui.busy || !ready} data-testid="people-make">
          {ui.busy ? t("people.form.making") : t("people.form.make")}
        </button>
        <button type="button" className="btn ghost" disabled={ui.busy} onClick={cancel} data-testid="people-form-cancel">
          {t("people.form.cancel")}
        </button>
      </div>
    </form>
  );
}

/** The owner first, marked "you", then each helper with when they joined, then the invites that wait or ran out. */
function WhoPane({ people, p }: { people: ShopPeople; p: PeopleProps }) {
  const { ui } = p;
  const youName = people.owner.name.trim();
  const line = ownerLine(people);
  const nobodyElse = people.helpers.length === 0 && people.invites.length === 0 && ui.ask?.kind !== "invite";
  return (
    <section className="part" aria-labelledby="people-who" data-testid="people-who">
      <div className="band">
        <h2 id="people-who" className="bh">
          {p.shop ? t("people.who", { shop: p.shop }) : t("people.whoYours")}
        </h2>
        <span data-testid="people-count">{countLine(people)}</span>
      </div>
      <Said ui={ui} at="who" />
      <div className="rowl" data-testid="people-owner">
        <Avatar name={youName || t("people.youOnly")} tone={0} />
        <span className="grow">
          <span className="nm">{youName ? t("people.you", { name: youName }) : t("people.youOnly")}</span>
          {line && (
            <span className="mut sub" data-testid="people-owner-line">
              {line}
            </span>
          )}
        </span>
        <span className="tag">{t("shops.owner")}</span>
      </div>
      {people.helpers.map((h) => (
        <HelperRow key={h.id} h={h} p={p} />
      ))}
      {people.invites.map((i) => (
        <InviteRow key={i.id} i={i} p={p} />
      ))}
      {nobodyElse && (
        <p className="none" data-testid="people-empty">
          {t("people.noHelpers")}
        </p>
      )}
      {ui.ask?.kind === "invite" && <InviteForm ask={ui.ask} p={p} />}
    </section>
  );
}

// ---- what each role can do ---------------------------------------------------------------------------------------------------------

/** The canvas's table. Only rows that are true of the app as built (people.ts `roleRows` says which and why). */
export function RolesPane() {
  return (
    <section className="part" aria-labelledby="people-roles" data-testid="people-roles">
      <div className="band">
        <h2 id="people-roles" className="bh">
          {t("people.roles.title")}
        </h2>
      </div>
      <table className="roles">
        <thead>
          <tr>
            <th scope="col" className="mut">
              {t("people.roles.what")}
            </th>
            <th scope="col" className="mut">
              {t("shops.owner")}
            </th>
            <th scope="col" className="mut">
              {t("shops.helper")}
            </th>
          </tr>
        </thead>
        <tbody>
          {roleRows().map((r) => (
            <tr key={r.id} data-testid="people-role" data-role={r.id}>
              <th scope="row">{t(r.label)}</th>
              {([r.owner, r.helper] as const).map((can, n) => (
                <td key={n} className={can === "yes" ? "" : "mut"}>
                  {can === "yes" ? (
                    <span className="yes">
                      <Check />
                      <span>{canText(can)}</span>
                    </span>
                  ) : (
                    canText(can)
                  )}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      <p className="hint">{t("people.roles.hint")}</p>
    </section>
  );
}

// ---- while the owner is away -------------------------------------------------------------------------------------------------------

/** One helper covers messages until a day, and the cover ends when the owner says or the day ends. Cover adds no power: money,
 *  public posts and settings still wait for the owner, which the line under the heading says. */
function CoverPane({ people, p }: { people: ShopPeople; p: PeopleProps }) {
  const { ui, dispatch } = p;
  const line = coverLine(people.away, p.nowMs);
  const inForce = people.away?.inForce === true;
  const ready = coverReady(ui.cover.helper, ui.cover.day, p.nowMs) && !ui.busy;
  return (
    <section className="part" aria-labelledby="people-away" data-testid="people-away">
      <div className="band">
        <h2 id="people-away" className="bh">
          {t("people.away.title")}
        </h2>
      </div>
      <Said ui={ui} at="cover" />
      <p className="hint">{t("people.away.note")}</p>
      {line && (
        <div className="rowl" data-testid="people-cover-line">
          <span className="grow">{line}</span>
          {inForce && (
            <button type="button" className="btn" disabled={ui.busy} onClick={p.onEndCover} data-testid="people-cover-end">
              {ui.busy && ui.at === "cover" ? t("people.away.ending") : t("people.away.end")}
            </button>
          )}
        </div>
      )}
      {!inForce && people.helpers.length === 0 && (
        <p className="none" data-testid="people-cover-need">
          {t("people.away.needHelper")}
        </p>
      )}
      {!inForce && people.helpers.length > 0 && (
        <form
          className="coverform"
          data-testid="people-cover-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (ready) p.onCover();
          }}
        >
          <div className="field">
            <label htmlFor="people-cover-helper">{t("people.away.helper")}</label>
            <select id="people-cover-helper" className="input" value={ui.cover.helper} disabled={ui.busy} onChange={(e) => dispatch({ type: "coverHelper", helper: e.target.value })} data-testid="people-cover-helper">
              <option value="">{t("people.away.pick")}</option>
              {people.helpers.map((h) => (
                <option key={h.id} value={h.id}>
                  {nameOrHelper(h.name)}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="people-cover-day">{t("people.away.until")}</label>
            <input
              id="people-cover-day"
              className="input"
              type="date"
              min={todayField(p.nowMs)}
              value={ui.cover.day}
              disabled={ui.busy}
              aria-invalid={ui.cover.day !== "" && endOfDay(ui.cover.day) === null ? true : undefined}
              onChange={(e) => dispatch({ type: "coverDay", day: e.target.value })}
              data-testid="people-cover-day"
            />
            <span className="help">{t("people.away.untilHelp")}</span>
          </div>
          <div className="chips">
            <button type="submit" className="btn dark" disabled={!ready} data-testid="people-cover-set">
              {ui.busy && ui.at === "cover" ? t("people.away.setting") : t("people.away.set")}
            </button>
          </div>
        </form>
      )}
    </section>
  );
}

// ---- sign-in and safety ------------------------------------------------------------------------------------------------------------

/** The canvas's two true rows: how everyone signs in (with Apple, which is what the app has; LINE is parked), and that every
 *  approval is recorded with who made it. Its "A helper's devices are listed in Security" is gone: there is no Security page, and
 *  each helper's row says on how many devices they are signed in. */
export function SafetyPane() {
  return (
    <section className="part" aria-labelledby="people-safety" data-testid="people-safety">
      <div className="band">
        <h2 id="people-safety" className="bh">
          {t("people.safety.title")}
        </h2>
      </div>
      <p className="row">{t("people.safety.apple")}</p>
      <p className="row">{t("people.safety.log")}</p>
    </section>
  );
}

// ---- the page ----------------------------------------------------------------------------------------------------------------------

/** The page with its head: the title, and Invite a helper when the list was read and no form is open. The sections follow in the
 *  canvas's order. A shop the person only helps at says so and shows nothing else, and a list that could not be read says why. */
export function PeopleView({ p }: { p: PeopleProps }) {
  const { state, ui } = p;
  const ready = state.kind === "ready";
  return (
    <div className="st-page st-wide people" data-testid="people" aria-busy={(state.kind === "loading" && !p.only) || undefined}>
      <div className="phead">
        <h1 className="ph1">{t("set.people")}</h1>
        {ready && !p.only && ui.ask?.kind !== "invite" && (
          <button type="button" className="btn dark" disabled={ui.busy || ui.ask !== null} onClick={() => p.dispatch({ type: "openInvite" })} data-testid="people-invite">
            {t("people.invite")}
          </button>
        )}
      </div>
      {p.only && (
        <p className="msg" role="status" data-testid="people-only">
          {p.only}
        </p>
      )}
      {!p.only && state.kind === "loading" && (
        <p className="none" data-testid="people-loading">
          {t("people.loading")}
        </p>
      )}
      {!p.only && state.kind === "unavailable" && (
        <div data-testid="people-unavailable">
          <p className="msg err" role="status" data-code={state.code}>
            {refusalText(state.code, state.message)}
          </p>
          {state.code !== "owner_only" && state.code !== "no_shop" && state.code !== "not_found" && (
            <button type="button" className="btn" onClick={p.onRetry} data-testid="people-retry">
              {t("people.retry")}
            </button>
          )}
        </div>
      )}
      {!p.only && state.kind === "ready" && (
        <>
          <WhoPane people={state.value} p={p} />
          <RolesPane />
          <CoverPane people={state.value} p={p} />
          <SafetyPane />
        </>
      )}
    </div>
  );
}

// ---- the page's own client of the runtime -------------------------------------------------------------------------------------------

/** Waits for a client that is opening, a moment at most: one the runtime cannot open now (signed out, offline) is asked anyway, and
 *  its refusal says why, as the store's own client says it. */
async function opened(client: RuntimeAdapter): Promise<void> {
  if (client.status === "open") return;
  await Promise.race([client.connect().catch(() => undefined), new Promise((resolve) => setTimeout(resolve, 0))]);
}

/** Whether this runtime has the people of a shop: the app's own (Practice) and the API's (Connected), not the loopback bridge of the
 *  Playwright suite, which logs what it is sent and has none. Settings lists People only where it is. */
export const peopleOffered = (): boolean => runtimeKind() !== "websocket";

/** How long "Copied" stays on a button. */
const COPIED_MS = 1400;

/** The page's state and handlers, read when the page is shown and again when the switcher shows another shop. `shop` is the shop the
 *  switcher shows (null while the person is in none) and `row` its entry in their list. Null on a runtime that is not this
 *  computer's own or the API (the loopback bridge of the Playwright suite): a helper's name or LINE ID is never sent there. */
export function usePeople(shop: string | null, row: ShopRow | null, shopName: string): PeopleProps | null {
  const offered = peopleOffered();
  const client = useRef<RuntimeAdapter | null>(null);
  const viewing = useRef<string | null>(shop);
  viewing.current = shop;
  /** Counts the changes made, so a read that was on its way when one began is not put over what the change left. */
  const changes = useRef(0);
  const again = useRef<() => void>(() => undefined);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [state, setState] = useState<Load<ShopPeople>>(LOADING);
  const [ui, dispatch] = useReducer(peopleReduce, PEOPLE_START);
  const only = row && row.role === "helper" ? helperShopWords(row) : null;

  useEffect(() => {
    if (!offered) return;
    const own = createRuntime();
    client.current = own;
    return () => {
      client.current = null;
      own.close();
    };
  }, [offered]);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  // The list is read again when the window comes back to the front: a helper may have joined through the link while the owner was
  // away (Mint opens the invite on their phone), and the page must not go on saying Invited. It is read quietly, as after a
  // refusal that says the list moved on, and never over a change that began meanwhile.
  useEffect(() => {
    if (!offered || only) return;
    const onFocus = () => again.current();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [offered, shop, only === null]);

  const ask = async <K extends Op>(op: K, params: OpParams<K>): Promise<OpResult<K>> => {
    const own = client.current;
    if (!own) throw { code: "disconnected", message: t("bot.offline") };
    await opened(own);
    return own.request(op, params);
  };

  useEffect(() => {
    if (!offered) return;
    setState(LOADING);
    dispatch({ type: "reset" });
    // The shop a person only helps at is not read at all: it is its owner's, and the page says so.
    if (only) return;
    let live = true;
    void load(() => ask("people.list", {})).then((r) => live && setState(r));
    return () => {
      live = false;
    };
    // `ask` reads the client from its ref, so it is the same whenever it is called; `only` follows the shop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [offered, shop, only === null]);

  if (!offered) return null;

  const calls: PeopleCalls = {
    invite: (at, name, identity) => ask("people.invite", { shop: at, name, identity }),
    cancelInvite: (at, invite) => ask("people.cancelInvite", { shop: at, invite }),
    remove: (at, helper) => ask("people.remove", { shop: at, helper }),
    setAway: (at, helper, until) => ask("people.setAway", { shop: at, helper, until }),
    clearAway: (at) => ask("people.clearAway", { shop: at }),
  };

  /** Reads the list again without blanking it, so the owner sees how things stand after a refusal that says the list moved on. A
   *  read that did not work leaves what is shown, and the refusal's words stay. */
  const refresh = async () => {
    const was = viewing.current;
    const made = changes.current;
    const r = await load(() => ask("people.list", {}));
    // not after the owner switched shops, and not if a change began while this was on its way: its answer is newer
    if (r.kind === "ready" && viewing.current === was && changes.current === made) setState(r);
  };
  again.current = () => {
    if (state.kind === "ready" && !ui.busy && !only) void refresh();
  };

  const run = async (todo: PeopleDo, at: "who" | "cover") => {
    if (state.kind !== "ready") return;
    const data = state.value;
    changes.current += 1;
    dispatch({ type: "begin", at });
    const step = await peopleDo(calls, data, todo);
    // The owner switched shops while the change was on its way: what it did belongs to the shop it was sent for, not the one shown
    // now (the change itself went with that shop's session), so it is not put on this page.
    if (viewing.current !== data.shop) return;
    setState({ kind: "ready", value: step.data });
    dispatch(step.action);
    if (step.reread) void refresh();
  };

  return {
    state,
    ui,
    nowMs: Date.now(),
    shop: shopName,
    only,
    dispatch,
    onInvite: () => {
      const open = ui.ask;
      if (ui.busy || open?.kind !== "invite" || !open.name || !open.contact) return;
      void run({ what: "invite", name: open.name, contact: open.contact }, "who");
    },
    onRemove: () => {
      const open = ui.ask;
      if (!ui.busy && open?.kind === "remove") void run({ what: "remove", helper: open.helper }, "who");
    },
    onCancel: (invite) => {
      if (!ui.busy && ui.ask === null) void run({ what: "cancel", invite }, "who");
    },
    onCopy: (invite, link) => {
      void navigator.clipboard?.writeText(link).then(
        () => {
          dispatch({ type: "copied", invite });
          if (timer.current) clearTimeout(timer.current);
          timer.current = setTimeout(() => dispatch({ type: "uncopy" }), COPIED_MS);
        },
        () => undefined,
      );
    },
    onCover: () => {
      const until = endOfDay(ui.cover.day);
      if (ui.busy || !ui.cover.helper || until === null) return;
      void run({ what: "away", helper: ui.cover.helper, until }, "cover");
    },
    onEndCover: () => {
      if (!ui.busy) void run({ what: "back" }, "cover");
    },
    onRetry: () => {
      setState(LOADING);
      void load(() => ask("people.list", {})).then((r) => viewing.current === shop && setState(r));
    },
  };
}

/** Settings › People: the hook and the view together, for the shop the switcher shows. Nothing on a runtime that is not offered one. */
export function PeoplePage() {
  const s = useStore();
  const row = s.shops.list.find((r) => r.id === s.shops.current) ?? null;
  const p = usePeople(s.shops.current, row, viewedShopName(s));
  return p ? <PeopleView p={p} /> : null;
}
