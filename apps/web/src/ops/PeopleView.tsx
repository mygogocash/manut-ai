import { APPROVAL_KINDS, mayDecide } from "@manut/approval-core";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { ApiError, useApi, type Identity, type InviteView, type People, type PeopleHelper, type Shop } from "../api";
import { endOfShopDay, langOf } from "../format";
import { CheckIcon } from "../ui/marks";
import { CopyButton } from "./CopyButton";
import { useLoad } from "./useLoad";
import { errorText, isAuthError, peopleErrorText, peopleWords as W } from "./words";

/// The People page: who can use Manut AI for one shop, as the API keeps it (`GET /v1/admin/people`), laid out from the
/// design canvas's "Settings: people" and "States: people and roles" boards. "Who can use Manut AI" lists the owner, each
/// helper with what they may approve, and each invite that waits or ran out; "What each role can approve" is read from
/// approval-core's rule; "While you are away" says who covers messages and until when; and the notes helpers passed on
/// come last, with the kind of request they were about.
///
/// The owner has no account in the pilot, so the operator relays the owner's word, and the page says so. An invite makes a
/// link for the operator to send, because Manut AI sends nothing (LINE and email sending are parked). Removing a helper asks
/// once more in its row, because it signs them out of every device. One change runs at a time: every button waits while one
/// is on its way, so a double press sends one request, and a refusal that says the list moved on (an invite already used,
/// a helper already gone) reads the list again. The shop is chosen on the page, starting from the one in the side menu, so
/// the page stays open while the operator looks through several shops.

type Notice = { place: "who" | "cover"; text: string };

/// The people refusals that mean the list this page shows is out of date.
const MOVED_ON = new Set(["unknown_invite", "not_pending", "not_a_helper"]);

/// The API answers 503 `people_unavailable` when the shop's people cannot be read: never an empty list instead.
function loadErrorText(error: unknown): string {
  if (error instanceof ApiError && error.code === "people_unavailable") return W.unavailable;
  return errorText(error);
}

/// What an operator typed as the account to invite. A LINE ID never holds an `@` and an email always does, so one box serves
/// both, as the board has it. Outer spaces are never part of either.
function identityOf(typed: string): Identity {
  const text = typed.trim();
  return text.includes("@") ? { kind: "email", address: text } : { kind: "line", id: text };
}

/// The longest name the API keeps, in characters (its own count: whole characters, not code units).
const MAX_NAME = 80;

const listStyle = { listStyle: "none", margin: 0, padding: 0 } as const;
const sectionStyle = { display: "flex", flexDirection: "column", gap: 10 } as const;
const rowStyle = { borderTop: "1px solid var(--line)", flexWrap: "wrap", alignItems: "flex-start" } as const;
const lines = { display: "flex", flexDirection: "column", gap: 2, minWidth: 0 } as const;
const quiet = { fontSize: 13, overflowWrap: "anywhere" } as const;
const columnStyle = { flex: "0 0 140px" } as const;

/// The pastel behind a person's initial, as the board gives each person one of their own.
const TONES = ["#EFD3CC", "#EDE1B6", "#CDDDEB", "#CEDFCE", "#DBD6EC"] as const;

function Avatar({ name, tone }: { name: string; tone: number }) {
  return (
    <span className="av lg" aria-hidden="true" style={{ background: TONES[tone % TONES.length]! }}>
      {[...name][0]?.toUpperCase() ?? "?"}
    </span>
  );
}

export function PeopleView({ shops, tenant: chosen, onForget }: {
  shops: Shop[] | null;
  tenant: string | null;
  onForget: () => void;
}) {
  const api = useApi();
  const [tenant, setTenant] = useState(() => chosen ?? shops?.[0]?.tenant ?? "");
  const shop = shops?.find((s) => s.tenant === tenant) ?? null;
  const people = useLoad(shop ? () => api.getPeople(shop.tenant) : null, `people:${shop?.tenant ?? ""}`);

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
            <label htmlFor="people-shop" className="mut" style={{ fontSize: 13 }}>
              {W.shopLabel}
            </label>
            <select id="people-shop" className="input" value={tenant} onChange={(event) => setTenant(event.target.value)}>
              {shops.map((s) => (
                <option key={s.tenant} value={s.tenant}>
                  {s.name}
                </option>
              ))}
            </select>
          </span>
        )}
        <div className="acts">
          <button type="button" className="btn ghost" onClick={people.reload}>
            {W.refresh}
          </button>
        </div>
      </div>
      {people.error ? (
        <div style={{ padding: "16px 16px 0" }}>
          <div className="banner err" role="alert">
            <span className="grow">{loadErrorText(people.error)}</span>
            {isAuthError(people.error) ? (
              <button type="button" className="btn" style={{ color: "var(--ink)" }} onClick={onForget}>
                {W.anotherKey}
              </button>
            ) : (
              <button type="button" className="btn" style={{ color: "var(--ink)" }} onClick={people.reload}>
                {W.tryAgain}
              </button>
            )}
          </div>
        </div>
      ) : null}
      <div style={{ padding: 16, display: "flex", flexDirection: "column", gap: 20, maxWidth: 880 }}>
        {shop && (
          <p className="hint" style={{ margin: 0 }}>
            {W.intro(shop.ownerName)}
          </p>
        )}
        {shops && shops.length === 0 ? (
          <p className="hint" style={{ margin: 0 }}>
            {W.noShops}
          </p>
        ) : !shop || (!people.data && !people.error) ? (
          <div className="skel" style={{ height: 120 }} aria-label={W.loading} />
        ) : people.data ? (
          // Keyed by the shop, so what one shop's page was doing is never carried over to another's.
          <PeopleBoard key={shop.tenant} shop={shop} people={people.data} reload={people.reload} />
        ) : null}
      </div>
    </>
  );
}

function PeopleBoard({ shop, people, reload }: { shop: Shop; people: People; reload: () => void }) {
  const api = useApi();
  // The change on its way, by what it is for, and a guard that holds even between two presses that arrive before the page
  // has drawn the first one's answer.
  const [busy, setBusy] = useState<string | null>(null);
  const running = useRef(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [inviting, setInviting] = useState(false);
  const [created, setCreated] = useState<{ name: string; url: string } | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);

  const owner = people.owner.name;
  const pending = people.invites.filter((invite) => invite.status === "pending");
  const expired = people.invites.filter((invite) => invite.status === "expired");
  const covering = people.away?.inForce ? people.away.helperId : null;
  const removedNames = people.removed.map((one) => one.name).filter((name) => name !== "");
  const locked = busy !== null;

  /// One change. `work` makes the call and answers what to say where the operator is looking. When it did not happen, why is
  /// said where the change was asked for, and a refusal that means the list moved on also reads the list again.
  async function change(key: string, work: () => Promise<Notice | null>): Promise<boolean> {
    if (running.current) return false;
    running.current = true;
    setBusy(key);
    setNotice(null);
    setErrors(({ [key]: _cleared, ...rest }) => rest);
    try {
      setNotice(await work());
      reload();
      return true;
    } catch (error) {
      setErrors((current) => ({ ...current, [key]: peopleErrorText(error) }));
      if (error instanceof ApiError && MOVED_ON.has(error.code)) reload();
      return false;
    } finally {
      running.current = false;
      setBusy(null);
    }
  }

  const invite = (name: string, identity: Identity) =>
    change("invite", async () => {
      const made = await api.createInvite({ tenant: shop.tenant, name, identity });
      setCreated({ name, url: made.inviteUrl });
      setInviting(false);
      return null;
    });
  const revoke = (one: InviteView) =>
    change(`invite:${one.id}`, async () => {
      await api.revokeInvite({ tenant: shop.tenant, inviteId: one.id });
      return { place: "who", text: W.inviteCancelled(one.name) };
    });
  const remove = (helper: PeopleHelper, name: string) =>
    change(`helper:${helper.id}`, async () => {
      const done = await api.removeHelper({ tenant: shop.tenant, helperId: helper.id });
      setRemoving(null);
      return { place: "who", text: W.removed(name, done) };
    });
  const setCover = (helper: PeopleHelper, until: string) =>
    change("cover", async () => {
      const done = await api.setAway({ tenant: shop.tenant, helperId: helper.id, until });
      return { place: "cover", text: W.coverSet(helper.name, done.away.until) };
    });
  const endCover = () =>
    change("clear", async () => {
      await api.clearAway({ tenant: shop.tenant });
      return { place: "cover", text: W.coverEnded };
    });

  return (
    <>
      <section aria-labelledby="people-who" style={sectionStyle}>
        <div className="band">
          <h2 id="people-who" className="h2" style={{ fontSize: 13, color: "inherit" }}>
            {W.whoTitle(shop.name)}
          </h2>
          <span>{W.count(1 + people.helpers.length, pending.length)}</span>
        </div>
        {notice?.place === "who" && <Said text={notice.text} />}
        <ul aria-label={W.listLabel(shop.name)} style={listStyle}>
          <li className="rowl" style={rowStyle}>
            <Avatar name={owner} tone={0} />
            <span className="grow" style={lines}>
              <span style={{ fontWeight: 500 }}>{owner}</span>
              <span className="mut" style={quiet}>{W.ownerCan}</span>
            </span>
            <span className="tag">{W.ownerRole}</span>
          </li>
          {people.helpers.map((helper, index) => (
            <HelperRow
              key={helper.id}
              helper={helper}
              tone={index + 1}
              owner={owner}
              shopName={shop.name}
              covering={covering === helper.id}
              locked={locked}
              busy={busy === `helper:${helper.id}`}
              asking={removing === helper.id}
              error={errors[`helper:${helper.id}`]}
              onAsk={() => setRemoving(helper.id)}
              onKeep={() => setRemoving(null)}
              onRemove={(name) => void remove(helper, name)}
            />
          ))}
          {pending.map((one, index) => (
            <li key={one.id} className="rowl" style={rowStyle}>
              <Avatar name={one.name} tone={people.helpers.length + 1 + index} />
              <span className="grow" style={lines}>
                <span style={{ fontWeight: 500 }}>{one.name}</span>
                <span className="mut" style={quiet}>{W.identityText(one.identity)}</span>
                <span className="mut" style={quiet}>{W.inviteMade(one.createdAt, one.expiresAt)}</span>
                {!one.inviteUrl && <span className="mut" style={quiet}>{W.noLink}</span>}
              </span>
              <span className="tag">{W.invitedTag}</span>
              {one.inviteUrl && <CopyButton text={one.inviteUrl} label={W.copyLink} what={`for ${one.name}'s invite`} />}
              <button type="button" className="lk" style={{ opacity: locked ? 0.5 : undefined }} disabled={locked}
                aria-busy={busy === `invite:${one.id}` ? true : undefined} onClick={() => void revoke(one)}>
                {W.cancelInvite}
              </button>
              {errors[`invite:${one.id}`] && <RowError text={errors[`invite:${one.id}`]!} />}
            </li>
          ))}
          {expired.map((one, index) => (
            <li key={one.id} className="rowl" style={rowStyle}>
              <Avatar name={one.name} tone={people.helpers.length + 1 + pending.length + index} />
              <span className="grow" style={lines}>
                <span style={{ fontWeight: 500 }}>{one.name}</span>
                <span className="mut" style={quiet}>{W.identityText(one.identity)}</span>
                <span className="mut" style={quiet}>{W.inviteRanOut(one.expiresAt)}</span>
              </span>
              <span className="tag">{W.expiredTag}</span>
            </li>
          ))}
        </ul>
        {people.helpers.length === 0 && pending.length === 0 && (
          <p className="hint" style={{ margin: 0, padding: "0 10px" }}>
            {W.noHelpers(owner, shop.name)}
          </p>
        )}
        {removedNames.length > 0 && (
          <p className="hint" style={{ margin: 0, padding: "0 10px" }}>
            {W.removedNote(removedNames)}
          </p>
        )}
        {pending.length > 0 && !created && (
          <p className="hint" style={{ margin: 0, padding: "0 10px" }}>
            {W.sendYourself}
          </p>
        )}
        {created && <CreatedInviteBox created={created} onDone={() => setCreated(null)} />}
        {inviting ? (
          <InviteForm
            owner={owner}
            busy={busy === "invite"}
            locked={locked}
            error={errors.invite}
            onInvite={invite}
            onCancel={() => setInviting(false)}
          />
        ) : (
          <div>
            <button type="button" className="btn dark" disabled={locked} onClick={() => {
              setCreated(null);
              setInviting(true);
            }}>
              {W.formTitle}
            </button>
          </div>
        )}
      </section>

      <section aria-labelledby="people-roles" style={sectionStyle}>
        <div className="band">
          <h2 id="people-roles" className="h2" style={{ fontSize: 13, color: "inherit" }}>
            {W.rolesTitle}
          </h2>
        </div>
        <div role="table" aria-labelledby="people-roles">
          <div className="tr" role="row" style={{ padding: "8px 10px", alignItems: "center" }}>
            <span className="grow mut" role="columnheader">{W.columns.what}</span>
            <span className="mut" role="columnheader" style={columnStyle}>{W.columns.owner}</span>
            <span className="mut" role="columnheader" style={columnStyle}>{W.columns.helper}</span>
          </div>
          {APPROVAL_KINDS.map((kind) => (
            <div key={kind} className="tr" role="row" style={{ padding: "8px 10px", alignItems: "center" }}>
              <span className="grow" role="cell">{W.kindRow[kind]}</span>
              <Allowed role="cell" yes={mayDecide("owner", kind)} no={W.no} />
              <Allowed role="cell" yes={mayDecide("helper", kind)} no={W.noAsks(owner)} />
            </div>
          ))}
        </div>
        <p className="hint" style={{ margin: 0, padding: "0 10px" }}>
          {W.rolesNote(owner)}
        </p>
      </section>

      <section aria-labelledby="people-cover" style={sectionStyle}>
        <div className="band">
          <h2 id="people-cover" className="h2" style={{ fontSize: 13, color: "inherit" }}>
            {W.coverTitle}
          </h2>
          <span>{W.coverNote(owner)}</span>
        </div>
        {notice?.place === "cover" && <Said text={notice.text} />}
        <CoverBoard
          people={people}
          owner={owner}
          busy={busy}
          locked={locked}
          errors={errors}
          onSet={(helper, until) => setCover(helper, until)}
          onEnd={() => void endCover()}
        />
      </section>

      <section aria-labelledby="people-notes" style={sectionStyle}>
        <div className="band">
          <h2 id="people-notes" className="h2" style={{ fontSize: 13, color: "inherit" }}>
            {W.notesTitle}
          </h2>
          <span>{W.notesNote(owner)}</span>
        </div>
        {people.passedOn.length === 0 ? (
          <p className="hint" style={{ margin: 0, padding: "0 10px" }}>
            {W.noNotes(owner)}
          </p>
        ) : (
          <ul aria-label={W.notesLabel(shop.name)} style={listStyle}>
            {[...people.passedOn].sort((a, b) => Date.parse(b.at) - Date.parse(a.at)).map((note) => {
              const by = note.name || note.by;
              return (
                <li key={note.requestId} className="rowl" style={rowStyle}>
                  <Avatar name={by} tone={1} />
                  <span className="grow" style={lines}>
                    <span style={{ fontWeight: 500 }}>{W.notePassedBy(by)}</span>
                    <span lang={langOf(note.note)} style={{ overflowWrap: "anywhere" }}>{note.note}</span>
                    <span className="mut" style={{ fontSize: 12.5 }}>{W.noteWhen(note.at)}</span>
                    <span className="mut" style={{ fontSize: 12.5, overflowWrap: "anywhere" }}>{W.noteRequest(note.requestId)}</span>
                  </span>
                  <span className="tag">{W.kindOf(note.kind)}</span>
                </li>
              );
            })}
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

function RowError({ text }: { text: string }) {
  return (
    <div className="banner err" role="alert" style={{ flexBasis: "100%" }}>
      <span className="grow">{text}</span>
    </div>
  );
}

/// One cell of the role table: a check and "Yes", or what a person who may not approve is told.
function Allowed({ role, yes, no }: { role: "cell"; yes: boolean; no: string }) {
  return (
    <span role={role} style={columnStyle} className={yes ? undefined : "mut"}>
      {yes ? (
        <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
          <CheckIcon />
          <span>{W.yes}</span>
        </span>
      ) : (
        no
      )}
    </span>
  );
}

/// A helper, as the board draws one: their account, since when and on how many devices, and what they may approve, with
/// "Remove" at the right. Remove opens the board's dialog in the row and does nothing until it is answered yes.
function HelperRow({ helper, tone, owner, shopName, covering, locked, busy, asking, error, onAsk, onKeep, onRemove }: {
  helper: PeopleHelper;
  tone: number;
  owner: string;
  shopName: string;
  covering: boolean;
  locked: boolean;
  busy: boolean;
  asking: boolean;
  error: string | undefined;
  onAsk: () => void;
  onKeep: () => void;
  onRemove: (name: string) => void;
}) {
  // A name is always kept with a helper; the account stands in for one the API could not find.
  const name = helper.name || W.identityText(helper.identity);
  const nameId = `helper-${helper.id}`;
  const titleId = `remove-${helper.id}`;
  return (
    <li className="rowl" style={rowStyle}>
      <Avatar name={name} tone={tone} />
      <span className="grow" style={lines}>
        <span id={nameId} style={{ fontWeight: 500 }}>{name}</span>
        <span className="mut" style={quiet}>{W.identityText(helper.identity)}</span>
        <span className="mut" style={quiet}>{`${W.helperSince(helper.joinedAt)} ${W.devices(helper.devices)}`}</span>
        <span className="mut" style={quiet}>{W.helperCan(owner)}</span>
      </span>
      <span className="tag">{W.helperRole}</span>
      {covering && <span className="tag ok">{W.coveringTag}</span>}
      <button type="button" className="btn ghost" disabled={locked} aria-describedby={nameId} onClick={onAsk}>
        {W.remove}
      </button>
      {asking && (
        <div className="dialog" role="dialog" aria-labelledby={titleId} style={{ flexBasis: "100%", maxWidth: 560 }}>
          <h3 id={titleId}>{W.removeTitle(name)}</h3>
          <p style={{ margin: 0 }}>{W.removeEffect(name, shopName)}</p>
          <p className="mut" style={{ margin: 0 }}>{W.removeKept(name)}</p>
          <div className="chips">
            <button type="button" className="btn danger solid" disabled={locked} aria-busy={busy ? true : undefined}
              onClick={() => onRemove(name)}>
              {busy ? W.removing : W.removeYes(name)}
            </button>
            <button type="button" className="btn" disabled={locked} onClick={onKeep}>
              {W.removeNo(name)}
            </button>
          </div>
        </div>
      )}
      {error && <RowError text={error} />}
    </li>
  );
}

/// "Invite a helper": a name and the one account the invite is for. What was typed stays when the API refuses it, so it can
/// be fixed rather than typed again. Nothing is sent: the answer is a link, which the box after it shows.
function InviteForm({ owner, busy, locked, error, onInvite, onCancel }: {
  owner: string;
  busy: boolean;
  locked: boolean;
  error: string | undefined;
  onInvite: (name: string, identity: Identity) => Promise<boolean>;
  onCancel: () => void;
}) {
  const [name, setName] = useState("");
  const [contact, setContact] = useState("");
  const trimmed = name.trim();
  const length = [...trimmed].length;
  const tooLong = length > MAX_NAME;
  const blocked = length < 1 || tooLong || contact.trim() === "" || locked;

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (blocked) return;
    await onInvite(trimmed, identityOf(contact));
  }

  return (
    <form className="box" aria-label={W.formTitle} onSubmit={(event) => void submit(event)}
      style={{ padding: 16, display: "flex", flexDirection: "column", gap: 12 }}>
      <h3 className="h2">{W.formTitle}</h3>
      <div className="field">
        <label htmlFor="people-name">{W.nameLabel}</label>
        <input id="people-name" className="input" type="text" autoComplete="off" value={name}
          aria-invalid={tooLong ? true : undefined} aria-describedby="people-name-help"
          onChange={(event) => setName(event.target.value)} />
        <div id="people-name-help" className={tooLong ? "help err" : "help"}>
          {tooLong ? W.badName : W.nameHelp}
        </div>
      </div>
      <div className="field">
        <label htmlFor="people-contact">{W.contactLabel}</label>
        <input id="people-contact" className="input" type="text" autoComplete="off" spellCheck={false} value={contact}
          aria-describedby="people-contact-help people-contact-note" onChange={(event) => setContact(event.target.value)} />
        <div id="people-contact-help" className="help">{W.identityHelp}</div>
        <div id="people-contact-note" className="help">{W.signInNote}</div>
      </div>
      <p style={{ margin: 0 }}>{W.inviteCan(trimmed, owner)}</p>
      {error && (
        <div className="banner err" role="alert">
          <span className="grow">{error}</span>
        </div>
      )}
      <div className="chips">
        <button type="submit" className="btn dark" disabled={blocked} aria-busy={busy ? true : undefined}>
          {busy ? W.makingLink : W.makeLink}
        </button>
        <button type="button" className="btn ghost" disabled={locked} onClick={onCancel}>
          {W.cancel}
        </button>
      </div>
    </form>
  );
}

/// What making an invite answered: its link, to copy and send by hand.
function CreatedInviteBox({ created, onDone }: { created: { name: string; url: string }; onDone: () => void }) {
  return (
    <div className="box" role="region" aria-label={W.inviteReady(created.name)}
      style={{ padding: 16, display: "flex", flexDirection: "column", gap: 10 }}>
      <p style={{ margin: 0, fontWeight: 500 }}>{W.inviteReady(created.name)}</p>
      <div className="field">
        <label htmlFor="people-link">{W.linkLabel}</label>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
          <input id="people-link" className="input" type="text" readOnly value={created.url} spellCheck={false}
            onFocus={(event) => event.currentTarget.select()} style={{ flex: "1 1 280px", width: "auto" }} />
          <CopyButton text={created.url} label={W.copyLink} what="for the new invite" />
        </div>
      </div>
      <p className="mut" style={{ margin: 0 }}>{W.sendYourself}</p>
      <div>
        <button type="button" className="btn ghost" onClick={onDone}>
          {W.done}
        </button>
      </div>
    </div>
  );
}

/// Who covers while the owner is away, in the board's words, and the form to change it: a helper and the day the cover ends.
/// The day is the shop's own, and cover lasts to the end of it. Whether it has passed is the API's to say, from its own clock.
function CoverBoard({ people, owner, busy, locked, errors, onSet, onEnd }: {
  people: People;
  owner: string;
  busy: string | null;
  locked: boolean;
  errors: Record<string, string>;
  onSet: (helper: PeopleHelper, until: string) => Promise<boolean>;
  onEnd: () => void;
}) {
  const { helpers, away } = people;
  const [picked, setPicked] = useState<string | null>(null);
  const [day, setDay] = useState("");
  // The helper covering now, or the first, until the operator chooses another; one who was removed gives way.
  const helper = helpers.find((one) => one.id === picked) ?? helpers.find((one) => one.id === away?.helperId) ?? helpers[0];
  const until = endOfShopDay(day);
  const blocked = !helper || until === null || locked;

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (blocked) return;
    if (await onSet(helper, until)) setDay("");
  }

  return (
    <>
      {away?.inForce ? (
        <div className="banner info">
          <span className="grow" role="status">{W.coverInForce(away.name, away.until)}</span>
          <button type="button" className="btn" disabled={locked} aria-busy={busy === "clear" ? true : undefined} onClick={onEnd}>
            {busy === "clear" ? W.endingCover : W.endCover}
          </button>
        </div>
      ) : away ? (
        <p className="hint" style={{ margin: 0, padding: "0 10px" }}>{W.coverOver(away.name, away.until)}</p>
      ) : (
        <p className="hint" style={{ margin: 0, padding: "0 10px" }}>
          {helpers.length > 0 ? W.noCover(owner) : W.needHelper(owner)}
        </p>
      )}
      {errors.clear && <RowError text={errors.clear} />}
      {helper && (
        <form aria-label={W.setCover} onSubmit={(event) => void submit(event)}
          style={{ display: "flex", flexWrap: "wrap", alignItems: "flex-end", gap: 12, padding: "0 10px" }}>
          <div className="field" style={{ flex: "1 1 180px" }}>
            <label htmlFor="cover-helper">{W.helperLabel}</label>
            <select id="cover-helper" className="input" value={helper.id} onChange={(event) => setPicked(event.target.value)}>
              {helpers.map((one) => (
                <option key={one.id} value={one.id}>
                  {one.name || W.identityText(one.identity)}
                </option>
              ))}
            </select>
          </div>
          <div className="field" style={{ flex: "1 1 180px" }}>
            <label htmlFor="cover-until">{W.untilLabel}</label>
            <input id="cover-until" className="input" type="date" value={day} aria-describedby="cover-until-help"
              onChange={(event) => setDay(event.target.value)} />
          </div>
          <button type="submit" className="btn dark" disabled={blocked} aria-busy={busy === "cover" ? true : undefined}>
            {busy === "cover" ? W.settingCover : W.setCover}
          </button>
          <div id="cover-until-help" className="help" style={{ flexBasis: "100%" }}>{W.untilHelp}</div>
          {errors.cover && <RowError text={errors.cover} />}
        </form>
      )}
    </>
  );
}
