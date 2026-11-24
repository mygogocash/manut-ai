import { useEffect, useRef, useState, type ReactNode } from "react";
import { ApiError, SIGN_IN_MEMBERS, useApi, type Outpost, type Shop, type SignIn } from "../api";
import { CopyButton } from "./CopyButton";
import { useLoad, type Loaded } from "./useLoad";
import {
  CONNECTIONS_MOVED_ON,
  connectionMemberName,
  connectionsErrorText,
  connectionsWords as W,
  errorText,
  isAuthError,
  outpostTag,
  signInTag,
} from "./words";

/// The Connections page: one shop's site sign-ins and its outposts as the vault lists them to an operator (`GET
/// /v1/admin/vault/sign-ins`, `GET /v1/admin/outposts`; docs/pilot-api.md, "Vault sign-ins and outposts"), so that a sign-in the
/// site refused, or an outpost that has gone to sleep, is seen here and not found out when a job fails. The shop is chosen on the
/// page, starting from the one in the side menu, as on the People and Model spend pages.
///
/// No password is ever shown, because the API never answers one, and the page offers no way to type one: adding a sign-in and
/// giving it a new password are the owner's, from their own app, which the page says in one line. The operator may do four things,
/// and each one asks first, in its row, in words that name exactly what will happen, and sends nothing until it is answered yes:
/// remove a sign-in, change who may use it, remove an outpost, and give an outpost a new credential. One change runs at a time,
/// so a double press sends one request, and a refusal that says the list moved on (the sign-in or outpost is already gone) reads it
/// again. The two lists are read by their own routes and say their own failures, so one that cannot be read never hides the other.
///
/// A new credential is in the one answer that holds it and in nothing else. The board holds it in its own state, shows it once, with
/// a Copy button, in a box that says so, and lets it go when the box is closed or the page is left: it is never put in storage, a
/// list, a notice or the address, so there is nothing to find after that.

/// The one question open in the board, and the row it is about. Asking another closes this one, so two are never open at once.
type Asking =
  | { kind: "members"; id: string }
  | { kind: "remove-sign-in"; id: string }
  | { kind: "credential"; id: string }
  | { kind: "remove-outpost"; id: string };

/// A new credential for the box that shows it. This is the only place the page ever holds one.
type Issued = { outpostId: string; name: string; credential: string };

/// Which list a change, its notice or its refusal belongs to.
type Place = "sign-ins" | "outposts";
type Notice = { place: Place; text: string };
/// Why a change was not made, in words, and whether the API refused the operator key, which is the one refusal with a way out.
type Problem = { text: string; refused: boolean };

const listStyle = { listStyle: "none", margin: 0, padding: 0 } as const;
const sectionStyle = { display: "flex", flexDirection: "column", gap: 10 } as const;
const rowStyle = { borderTop: "1px solid var(--line)", flexWrap: "wrap", alignItems: "flex-start" } as const;
const lines = { display: "flex", flexDirection: "column", gap: 2, minWidth: 0 } as const;
const quiet = { fontSize: 13, overflowWrap: "anywhere" } as const;

export function ConnectionsView({ shops, tenant: chosen, onForget }: {
  shops: Shop[] | null;
  tenant: string | null;
  onForget: () => void;
}) {
  const api = useApi();
  const [tenant, setTenant] = useState(() => chosen ?? shops?.[0]?.tenant ?? "");
  const shop = shops?.find((s) => s.tenant === tenant) ?? null;
  const signIns = useLoad(shop ? () => api.listSignIns(shop.tenant) : null, `sign-ins:${shop?.tenant ?? ""}`);
  const outposts = useLoad(shop ? () => api.listOutposts(shop.tenant) : null, `outposts:${shop?.tenant ?? ""}`);
  // A key the API refused stops both reads at once, so it is said once, at the top, with the way out, and neither list says it again.
  const refused = [signIns.error, outposts.error].find((error) => isAuthError(error));

  // Keeps the chosen shop while the list still has it; one deleted meanwhile gives way to the first.
  useEffect(() => {
    if (!shops) return;
    setTenant((current) => (shops.some((s) => s.tenant === current) ? current : (shops[0]?.tenant ?? "")));
  }, [shops]);

  return (
    <>
      <div className="top">
        <h1>{W.title}</h1>
        {shops && shops.length > 0 && (
          <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <label htmlFor="connections-shop" className="mut" style={{ fontSize: 13 }}>
              {W.shopLabel}
            </label>
            <select id="connections-shop" className="input" value={tenant} onChange={(event) => setTenant(event.target.value)}>
              {shops.map((s) => (
                <option key={s.tenant} value={s.tenant}>
                  {s.name}
                </option>
              ))}
            </select>
          </span>
        )}
        <div className="acts">
          <button type="button" className="btn ghost" onClick={() => {
            signIns.reload();
            outposts.reload();
          }}>
            {W.refresh}
          </button>
        </div>
      </div>
      {refused ? (
        <div style={{ padding: "16px 16px 0" }}>
          <div className="banner err" role="alert">
            <span className="grow">{errorText(refused)}</span>
            <button type="button" className="btn" style={{ color: "var(--ink)" }} onClick={onForget}>
              {W.anotherKey}
            </button>
          </div>
        </div>
      ) : null}
      <div style={{ padding: 16, display: "flex", flexDirection: "column", gap: 20, maxWidth: 880 }}>
        <p className="hint" style={{ margin: 0 }}>
          {W.intro}
        </p>
        <p className="hint" style={{ margin: 0 }}>
          {W.passwordNote}
        </p>
        {shops && shops.length === 0 ? (
          <p className="hint" style={{ margin: 0 }}>
            {W.noShops}
          </p>
        ) : !shop ? (
          <div className="skel" style={{ height: 120 }} aria-label={W.loading} />
        ) : (
          // Keyed by the shop, so what one shop's page was doing, a credential just made for it above all, is never carried over to
          // another's, and is let go when the page is left.
          <ConnectionsBoard key={shop.tenant} shop={shop} signIns={signIns} outposts={outposts} onForget={onForget} />
        )}
      </div>
    </>
  );
}

function ConnectionsBoard({ shop, signIns, outposts, onForget }: {
  shop: Shop;
  signIns: Loaded<SignIn[]>;
  outposts: Loaded<Outpost[]>;
  onForget: () => void;
}) {
  const api = useApi();
  const [asking, setAsking] = useState<Asking | null>(null);
  // The change on its way, by what it is for, and a guard that holds even between two presses that arrive before the page has drawn
  // the first one's answer.
  const [busy, setBusy] = useState<string | null>(null);
  const running = useRef(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [errors, setErrors] = useState<Record<Place, Problem | null>>({ "sign-ins": null, outposts: null });
  const [issued, setIssued] = useState<Issued | null>(null);
  const locked = busy !== null;
  const now = Date.now();
  const signInList = signIns.data;
  const outpostList = outposts.data;

  /// One change. `work` makes the call and answers what to say when it is done. A refusal is said in the section the change belongs
  /// to and leaves the question open, so it can be tried again or kept; one that means the list moved on closes it and reads the
  /// list again.
  async function change(place: Place, key: string, work: () => Promise<string>): Promise<void> {
    if (running.current) return;
    running.current = true;
    const list = place === "sign-ins" ? signIns : outposts;
    setBusy(key);
    setNotice(null);
    setErrors((current) => ({ ...current, [place]: null }));
    try {
      const text = await work();
      setAsking(null);
      setNotice({ place, text });
      list.reload();
    } catch (error) {
      setErrors((current) => ({
        ...current,
        [place]: { text: connectionsErrorText(error, "change"), refused: isAuthError(error) },
      }));
      if (error instanceof ApiError && CONNECTIONS_MOVED_ON.has(error.code)) {
        setAsking(null);
        list.reload();
      }
    } finally {
      running.current = false;
      setBusy(null);
    }
  }

  const saveMembers = (signIn: SignIn, members: string[]) =>
    change("sign-ins", `members:${signIn.id}`, async () => {
      const done = await api.setSignInMembers({ tenant: shop.tenant, signInId: signIn.id, members });
      // What the API answers, which is what was written, not what was ticked.
      return W.whoSaved(signIn.site, done.members);
    });
  const removeSignIn = (signIn: SignIn) =>
    change("sign-ins", `remove-sign-in:${signIn.id}`, async () => {
      await api.removeSignIn({ tenant: shop.tenant, signInId: signIn.id });
      return W.signInRemoved(signIn.site);
    });
  const giveCredential = (outpost: Outpost) =>
    change("outposts", `credential:${outpost.id}`, async () => {
      const made = await api.replaceOutpostCredential({ tenant: shop.tenant, outpostId: outpost.id });
      // Held for the box that shows it and said nowhere else: the notice says that one was made, never what it is.
      setIssued({ outpostId: outpost.id, name: outpost.name, credential: made.credential });
      return W.credentialMade(outpost.name);
    });
  const removeOutpost = (outpost: Outpost) =>
    change("outposts", `remove-outpost:${outpost.id}`, async () => {
      const done = await api.removeOutpost({ tenant: shop.tenant, outpostId: outpost.id });
      // A credential for an outpost that is gone is of no use to anyone, so the box that shows it goes too.
      setIssued((current) => (current?.outpostId === outpost.id ? null : current));
      return W.outpostRemoved(outpost.name, shop.name, done);
    });

  return (
    <>
      <section aria-labelledby="connections-sign-ins" style={sectionStyle}>
        <div className="band">
          <h2 id="connections-sign-ins" className="h2" style={{ fontSize: 13, color: "inherit" }}>
            {W.signInsTitle(shop.name)}
          </h2>
          {signInList && <span>{W.signInsCount(signInList.length, signInList.filter((one) => one.state === "broken").length)}</span>}
        </div>
        {notice?.place === "sign-ins" && <Said text={notice.text} />}
        {errors["sign-ins"] && <Failed problem={errors["sign-ins"]} onForget={onForget} />}
        {signIns.error != null && !isAuthError(signIns.error) && (
          <ReadFailed text={connectionsErrorText(signIns.error, "sign-ins")} onRetry={signIns.reload} />
        )}
        {!signInList ? (
          signIns.error ? null : <div className="skel" style={{ height: 72 }} aria-label={W.signInsLoading} />
        ) : signInList.length === 0 ? (
          <p className="hint" style={{ margin: 0, padding: "0 10px" }}>
            {W.signInsEmpty}
          </p>
        ) : (
          <ul aria-label={W.signInsLabel(shop.name)} style={listStyle}>
            {signInList.map((signIn) => (
              <SignInRow
                key={signIn.id}
                signIn={signIn}
                now={now}
                asking={asking}
                locked={locked}
                busy={busy}
                onAsk={(kind) => setAsking({ kind, id: signIn.id })}
                onKeep={() => setAsking(null)}
                onSaveMembers={(members) => void saveMembers(signIn, members)}
                onRemove={() => void removeSignIn(signIn)}
              />
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="connections-outposts" style={sectionStyle}>
        <div className="band">
          <h2 id="connections-outposts" className="h2" style={{ fontSize: 13, color: "inherit" }}>
            {W.outpostsTitle(shop.name)}
          </h2>
          {outpostList && <span>{W.outpostsCount(outpostList.length, outpostList.filter((one) => one.status === "online").length)}</span>}
        </div>
        {issued && <CredentialBox issued={issued} onDone={() => setIssued(null)} />}
        {notice?.place === "outposts" && <Said text={notice.text} />}
        {errors.outposts && <Failed problem={errors.outposts} onForget={onForget} />}
        {outposts.error != null && !isAuthError(outposts.error) && (
          <ReadFailed text={connectionsErrorText(outposts.error, "outposts")} onRetry={outposts.reload} />
        )}
        {!outpostList ? (
          outposts.error ? null : <div className="skel" style={{ height: 72 }} aria-label={W.outpostsLoading} />
        ) : outpostList.length === 0 ? (
          <p className="hint" style={{ margin: 0, padding: "0 10px" }}>
            {W.outpostsEmpty}
          </p>
        ) : (
          <ul aria-label={W.outpostsLabel(shop.name)} style={listStyle}>
            {outpostList.map((outpost) => (
              <OutpostRow
                key={outpost.id}
                outpost={outpost}
                now={now}
                asking={asking}
                locked={locked}
                busy={busy}
                onAsk={(kind) => setAsking({ kind, id: outpost.id })}
                onKeep={() => setAsking(null)}
                onGiveCredential={() => void giveCredential(outpost)}
                onRemove={() => void removeOutpost(outpost)}
              />
            ))}
          </ul>
        )}
      </section>
    </>
  );
}

function Said({ text }: { text: string }) {
  return (
    <div className="banner ok" role="status">
      <span className="grow">{text}</span>
    </div>
  );
}

/// A change that was not made. A key the API refused comes with the way to enter another.
function Failed({ problem, onForget }: { problem: Problem; onForget: () => void }) {
  return (
    <div className="banner err" role="alert">
      <span className="grow">{problem.text}</span>
      {problem.refused && (
        <button type="button" className="btn" style={{ color: "var(--ink)" }} onClick={onForget}>
          {W.anotherKey}
        </button>
      )}
    </div>
  );
}

/// A list that could not be read, in its own section, with its own way to try again.
function ReadFailed({ text, onRetry }: { text: string; onRetry: () => void }) {
  return (
    <div className="banner err" role="alert">
      <span className="grow">{text}</span>
      <button type="button" className="btn" style={{ color: "var(--ink)" }} onClick={onRetry}>
        {W.tryAgain}
      </button>
    </div>
  );
}

/// A question in a row: what will happen, in words that name it exactly, and two buttons, the one that does it first. Nothing is sent
/// until the first is pressed, and the second sends nothing. While a change is on its way every button waits.
function Question({ id, title, yes, no, busyLabel, busy, locked, blocked = false, danger = false, onYes, onNo, children }: {
  id: string;
  title: string;
  yes: string;
  no: string;
  busyLabel: string;
  busy: boolean;
  locked: boolean;
  blocked?: boolean;
  danger?: boolean;
  onYes: () => void;
  onNo: () => void;
  children: ReactNode;
}) {
  return (
    <div className="dialog" role="dialog" aria-labelledby={id} style={{ flexBasis: "100%", maxWidth: 560 }}>
      <h3 id={id}>{title}</h3>
      {children}
      <div className="chips">
        <button type="button" className={danger ? "btn danger solid" : "btn dark"} disabled={locked || blocked}
          aria-busy={busy ? true : undefined} onClick={onYes}>
          {busy ? busyLabel : yes}
        </button>
        <button type="button" className="btn" disabled={locked} onClick={onNo}>
          {no}
        </button>
      </div>
    </div>
  );
}

/// A sign-in: the site, its account and addresses, who may use it, whether it works (and if not, who said so and when), when it was
/// last used and when its password was set, which is all the API says of a password. "Who may use it" and "Remove" each open a
/// question in the row.
function SignInRow({ signIn, now, asking, locked, busy, onAsk, onKeep, onSaveMembers, onRemove }: {
  signIn: SignIn;
  now: number;
  asking: Asking | null;
  locked: boolean;
  busy: string | null;
  onAsk: (kind: "members" | "remove-sign-in") => void;
  onKeep: () => void;
  onSaveMembers: (members: string[]) => void;
  onRemove: () => void;
}) {
  const tag = signInTag(signIn.state);
  const open = asking?.id === signIn.id ? asking.kind : null;
  return (
    <li className="rowl" style={rowStyle}>
      <span className="grow" style={lines}>
        <span style={{ fontWeight: 500 }}>{signIn.site}</span>
        <span className="mut" style={quiet}>{W.account(signIn.username)}</span>
        <span className="mut" style={quiet}>{W.addresses(signIn.origins)}</span>
        <span className="mut" style={quiet}>{W.members(signIn.members)}</span>
        {signIn.state === "broken" && <span style={quiet}>{W.brokenText(signIn.brokenBy, signIn.brokenAt, now)}</span>}
        <span className="mut" style={quiet}>{W.lastUsed(signIn.lastUsedAt, signIn.lastUsedBy, now)}</span>
        <span className="mut" style={quiet}>{W.passwordSet(signIn.passwordSetAt, now)}</span>
      </span>
      <span className={tag.className}>{tag.label}</span>
      <button type="button" className="btn ghost" disabled={locked} aria-label={W.whoLabel(signIn.site)} onClick={() => onAsk("members")}>
        {W.whoButton}
      </button>
      <button type="button" className="btn ghost" disabled={locked} aria-label={W.removeSignInLabel(signIn.site)}
        onClick={() => onAsk("remove-sign-in")}>
        {W.removeButton}
      </button>
      {open === "members" && (
        <MembersQuestion signIn={signIn} busy={busy === `members:${signIn.id}`} locked={locked} onSave={onSaveMembers} onKeep={onKeep} />
      )}
      {open === "remove-sign-in" && (
        <Question id={`remove-sign-in-${signIn.id}`} title={W.removeSignInTitle(signIn.site, signIn.username)}
          yes={W.removeSignInYes(signIn.site)} no={W.removeSignInNo} busyLabel={W.removing} busy={busy === `remove-sign-in:${signIn.id}`}
          locked={locked} danger onYes={onRemove} onNo={onKeep}>
          <p style={{ margin: 0 }}>{W.removeSignInEffect(signIn.site)}</p>
          <p className="mut" style={{ margin: 0 }}>{W.removeSignInNote}</p>
        </Question>
      )}
    </li>
  );
}

/// Who may use a sign-in, as the question: a box for each member the vault may be told, ticked for those who may now, and under them
/// what saving would do, said before anything is sent. A member this console does not know yet that the sign-in already has is shown
/// too, so saving never takes one off unseen. Saving waits for at least one member (the vault refuses none) and for a change. The
/// members are sent in the order the API lists them, whatever order they were ticked in.
function MembersQuestion({ signIn, busy, locked, onSave, onKeep }: {
  signIn: SignIn;
  busy: boolean;
  locked: boolean;
  onSave: (members: string[]) => void;
  onKeep: () => void;
}) {
  const [ticked, setTicked] = useState<readonly string[]>(signIn.members);
  const options = [...SIGN_IN_MEMBERS, ...signIn.members.filter((member) => !SIGN_IN_MEMBERS.includes(member))];
  const chosen = options.filter((member) => ticked.includes(member));
  const unchanged = chosen.length === signIn.members.length && chosen.every((member) => signIn.members.includes(member));
  const blocked = chosen.length === 0 || unchanged;
  return (
    <Question id={`members-${signIn.id}`} title={W.whoTitle(signIn.site)} yes={blocked ? W.whoSave : W.whoYes(chosen)} no={W.whoNo}
      busyLabel={W.whoSaving} busy={busy} locked={locked} blocked={blocked} onYes={() => onSave(chosen)} onNo={onKeep}>
      <fieldset style={{ border: 0, margin: 0, padding: 0 }}>
        <legend className="mut" style={{ fontSize: 13, padding: 0, marginBottom: 6 }}>{W.whoLegend}</legend>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 14 }}>
          {options.map((member) => (
            <label key={member} style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
              <input type="checkbox" checked={ticked.includes(member)} disabled={locked} style={{ accentColor: "var(--pri)" }}
                onChange={(event) => {
                  const on = event.target.checked;
                  setTicked((current) => (on ? [...current, member] : current.filter((one) => one !== member)));
                }} />
              {connectionMemberName(member)}
            </label>
          ))}
        </div>
      </fieldset>
      <p style={{ margin: 0 }} aria-live="polite">{W.whoEffect(signIn.site, signIn.members, chosen)}</p>
    </Question>
  );
}

/// An outpost: its name and kind, whether it is online and when it last beat, and when it was registered. "New credential" and
/// "Remove" each open a question in the row.
function OutpostRow({ outpost, now, asking, locked, busy, onAsk, onKeep, onGiveCredential, onRemove }: {
  outpost: Outpost;
  now: number;
  asking: Asking | null;
  locked: boolean;
  busy: string | null;
  onAsk: (kind: "credential" | "remove-outpost") => void;
  onKeep: () => void;
  onGiveCredential: () => void;
  onRemove: () => void;
}) {
  const tag = outpostTag(outpost.status);
  const open = asking?.id === outpost.id ? asking.kind : null;
  return (
    <li className="rowl" style={rowStyle}>
      <span className="grow" style={lines}>
        <span style={{ fontWeight: 500 }}>{outpost.name}</span>
        <span className="mut" style={quiet}>{W.kindOf(outpost.kind)}</span>
        <span className="mut" style={quiet}>{W.heartbeat(outpost.lastHeartbeatAt, now)}</span>
        {outpost.status === "asleep" && <span style={quiet}>{W.asleepNote}</span>}
        <span className="mut" style={quiet}>{W.registered(outpost.createdAt, now)}</span>
      </span>
      <span className={tag.className}>{tag.label}</span>
      <button type="button" className="btn ghost" disabled={locked} aria-label={W.credentialLabel(outpost.name)}
        onClick={() => onAsk("credential")}>
        {W.credentialButton}
      </button>
      <button type="button" className="btn ghost" disabled={locked} aria-label={W.removeOutpostLabel(outpost.name)}
        onClick={() => onAsk("remove-outpost")}>
        {W.removeButton}
      </button>
      {open === "credential" && (
        <Question id={`credential-${outpost.id}`} title={W.credentialTitle(outpost.name)} yes={W.credentialYes(outpost.name)}
          no={W.credentialNo} busyLabel={W.credentialMaking} busy={busy === `credential:${outpost.id}`} locked={locked} danger
          onYes={onGiveCredential} onNo={onKeep}>
          <p style={{ margin: 0 }}>{W.credentialEffect(outpost.name)}</p>
          <p className="mut" style={{ margin: 0 }}>{W.credentialNote}</p>
        </Question>
      )}
      {open === "remove-outpost" && (
        <Question id={`remove-outpost-${outpost.id}`} title={W.removeOutpostTitle(outpost.name)} yes={W.removeOutpostYes(outpost.name)}
          no={W.removeOutpostNo} busyLabel={W.removing} busy={busy === `remove-outpost:${outpost.id}`} locked={locked} danger
          onYes={onRemove} onNo={onKeep}>
          <p style={{ margin: 0 }}>{W.removeOutpostEffect(outpost.name)}</p>
          <p className="mut" style={{ margin: 0 }}>{W.removeOutpostNote}</p>
        </Question>
      )}
    </li>
  );
}

/// The new credential, shown once. It is in a read-only field that selects itself on focus and beside a Copy button, and the box says
/// that nothing keeps it. Done, or leaving the page, lets it go: it is state of the board and of nothing else.
function CredentialBox({ issued, onDone }: { issued: Issued; onDone: () => void }) {
  return (
    <div className="box" role="region" aria-label={W.credentialReady(issued.name)}
      style={{ padding: 16, display: "flex", flexDirection: "column", gap: 10 }}>
      <p style={{ margin: 0, fontWeight: 500 }}>{W.credentialReady(issued.name)}</p>
      <div className="field">
        <label htmlFor="outpost-credential">{W.credentialField}</label>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
          <input id="outpost-credential" className="input" type="text" readOnly autoComplete="off" spellCheck={false}
            value={issued.credential} onFocus={(event) => event.currentTarget.select()} style={{ flex: "1 1 280px", width: "auto" }} />
          <CopyButton text={issued.credential} label={W.credentialCopy} what={W.credentialCopyWhat} thing="credential" />
        </div>
      </div>
      <p className="mut" style={{ margin: 0 }}>{W.credentialOnce}</p>
      <div>
        <button type="button" className="btn ghost" onClick={onDone}>
          {W.credentialDone}
        </button>
      </div>
    </div>
  );
}
