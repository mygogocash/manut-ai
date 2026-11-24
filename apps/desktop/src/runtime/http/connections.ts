// Customize › Connections on the connected runtime (docs/browser-control.md, "The owner's Connections"; the routes are
// docs/pilot-api.md, "The owner's vault and outposts"): the shop's sign-ins and outposts, read with the owner's session, a
// sign-in added, a new password sent to the vault, who may use a sign-in, and an outpost renamed or removed.
//
// Rules this module keeps:
// - The list is of the shop the switcher shows, read with that shop's own session (shops.ts), or with the sign-in while the
//   person is in no shops. A change goes to the shop its row was read for, never to the one the switcher shows now, as an
//   answer to an ask goes to the ask's own shop. A vault is a pilot shop's, so the API answers a person's own sign-in 404
//   `not_found` (24 Nov 2026), which is read here as `no_shop`: "No shop is linked to your account yet". A shop's own
//   signed-in session, whose tenant is the shop, is answered as before.
// - Only the owner sees or changes these. A shop the person helps at is refused here (`owner_only`) with nothing sent, as
//   the API would refuse it, so a helper's session never carries a password anywhere.
// - A password, a new sign-in's or a new one for a sign-in, is sent once, over the shell's request command, and kept
//   nowhere: not in this module, the host, the saved read of the shop or an error's words. What the vault would refuse is
//   refused here with nothing sent. Before it goes, the shop's session is read with, so it is one that works, and that read
//   must still list the sign-in a new password is for, and have room for a new sign-in. Then it crosses once, with no
//   second try after a 401 (`ApiSession.writeOnce`, or the held shop session as it is), so the owner types it again rather
//   than the app sending it twice.
// - While only a kept read of the shop is shown (the API cannot be reached), nothing here is sent: the kept read holds no
//   vault, and a change made blind could act on a list that moved on.
import { t } from "../../i18n";
import type { ShopRole } from "../../lib/protocol";
import {
  MAX_ORIGINS,
  MAX_OUTPOST_NAME,
  MAX_PASSWORD,
  MAX_SIGN_INS,
  MAX_SITE,
  MAX_USERNAME,
  membersOf,
  newSignInRefusal,
  siteOf,
  type ConnectionOps,
  type ShopOutpost,
  type VaultSignIn,
} from "../connections";
import { OpError } from "../mock/host";
import type { FetchLike } from "./shell";
import type { Departure, ShopAnswer } from "./shops";

/** The shop's sign-ins: `GET` lists them, `POST` adds one. */
export const SIGN_INS_PATH = "/v1/vault/sign-ins";
export const PASSWORD_PATH = "/v1/vault/sign-ins/password";
export const MEMBERS_PATH = "/v1/vault/sign-ins/members";
export const OUTPOSTS_PATH = "/v1/vault/outposts";
export const RENAME_PATH = "/v1/vault/outposts/rename";
export const REMOVE_PATH = "/v1/vault/outposts/remove";

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);
const text = (v: unknown, max: number): v is string => typeof v === "string" && v.length > 0 && v.length <= max;
/** An ISO time from the API in seconds, as the protocol counts; null for null, undefined for anything else. */
function seconds(v: unknown): number | null | undefined {
  if (v === null) return null;
  const ms = typeof v === "string" ? Date.parse(v) : NaN;
  return Number.isNaN(ms) ? undefined : ms / 1000;
}
const member = (v: unknown): v is string => text(v, 128);

/** One sign-in of the API's list (`SignIn` in docs/pilot-api.md), or null when this build cannot read it whole. The account's
 *  name and the sites' addresses are left behind: the tab does not show them. */
export function decodeSignIn(v: unknown): VaultSignIn | null {
  if (!isObj(v) || !text(v.id, 256) || typeof v.site !== "string" || !Array.isArray(v.members) || !v.members.every(member)) return null;
  if (v.state !== "working" && v.state !== "broken") return null;
  const passwordSetAt = seconds(v.passwordSetAt);
  const createdAt = seconds(v.createdAt);
  const brokenAt = seconds(v.brokenAt);
  const lastUsedAt = seconds(v.lastUsedAt);
  if (typeof passwordSetAt !== "number" || typeof createdAt !== "number" || brokenAt === undefined || lastUsedAt === undefined) return null;
  const who = (x: unknown) => (member(x) ? x : null);
  return { id: v.id, site: v.site, members: [...v.members], state: v.state, passwordSetAt, brokenAt, brokenBy: who(v.brokenBy), lastUsedAt, lastUsedBy: who(v.lastUsedBy), createdAt };
}

/** One outpost of the API's list (`Outpost` in docs/pilot-api.md), or null when this build cannot read it whole. */
export function decodeOutpost(v: unknown): ShopOutpost | null {
  if (!isObj(v) || !text(v.id, 256) || typeof v.name !== "string" || (v.kind !== "this_mac" && v.kind !== "cloud")) return null;
  const lastSeenAt = seconds(v.lastHeartbeatAt);
  const createdAt = seconds(v.createdAt);
  if (typeof createdAt !== "number" || lastSeenAt === undefined) return null;
  return { id: v.id, name: v.name, kind: v.kind, online: v.status === "online", lastSeenAt, createdAt };
}

/** Each entry of a list that this build can read, in the API's order. One it cannot read is left out rather than guessed. */
function decodeList<T>(json: unknown, field: string, decode: (v: unknown) => T | null): T[] | null {
  const entries = isObj(json) ? json[field] : undefined;
  if (!Array.isArray(entries)) return null;
  return entries.map(decode).filter((x): x is T => x !== null);
}

/** What the page says when the API refused a change, by its code. Never a word of what was typed. */
const REFUSED: Record<string, () => string> = {
  owner_only: () => t("conn.err.ownerOnly"),
  invalid_password: () => t("conn.err.password", { max: MAX_PASSWORD }),
  sign_in_not_found: () => t("conn.err.signInGone"),
  invalid_name: () => t("conn.err.name", { max: MAX_OUTPOST_NAME }),
  outpost_not_found: () => t("conn.err.outpostGone"),
  invalid_site: () => t("conn.err.site", { max: MAX_SITE }),
  invalid_origins: () => t("conn.err.origins", { max: MAX_ORIGINS }),
  invalid_username: () => t("conn.err.username", { max: MAX_USERNAME }),
  invalid_members: () => t("conn.err.members"),
  too_many_sign_ins: () => t("conn.err.tooMany", { max: MAX_SIGN_INS }),
  vault_not_configured: () => t("conn.err.vaultKey"),
  not_found: () => t("rt.notFound"),
  no_shop: () => t("conn.err.noShop"),
};

export const refusal = (code: string): OpError => new OpError(code, (REFUSED[code] ?? (() => t("conn.err.failed")))());

/** What the Connections ops need of the host: which shop the switcher shows, the owner's session for a shop, and the host's
 *  word on a shop the person's place in ended. host.ts gives these. */
export interface OwnerLink {
  /** Throws `offline` while only a kept read of the shop is shown. */
  live(): void;
  /** The shop the switcher shows, with the person's role there; null while they are in no shops. */
  viewed(): Promise<{ shop: string; role: ShopRole } | null>;
  /** The person's role at `shop` now; undefined when it is not one of their shops. */
  roleAt(shop: string): ShopRole | undefined;
  /** Whether the person is in any shop: then the signed-in tenant is not one they act for here. */
  inShops(): boolean;
  /** A read or a write with `shop`'s own session (null: the sign-in), as every other request of that shop goes. */
  read(shop: string | null, path: string): Promise<ShopAnswer>;
  write(shop: string | null, path: string, body: unknown): Promise<ShopAnswer>;
  /** A write whose body crosses at most once: with `shop`'s session as it is held now, or the sign-in's without its second
   *  try after a 401. */
  writeOnce(shop: string | null, path: string, body: unknown): Promise<ShopAnswer>;
  /** `write`, sent through `through` rather than the page's request command: registering this Mac goes through the shell's
   *  own command, which keeps the credential its answer holds (outpost.ts). */
  writeVia(shop: string | null, path: string, body: unknown, through: FetchLike): Promise<ShopAnswer>;
  /** The person's place in `shop` ended: the host says so, and this is what the op is refused with. */
  departed(shop: string, departure: Departure): OpError;
}

type Handlers = { [K in keyof ConnectionOps]: (p: ConnectionOps[K]["params"]) => Promise<ConnectionOps[K]["result"]> };

/** The six Connections ops over `link`. */
export function connectionHandlers(link: OwnerLink): Handlers {
  /** The JSON of an answer that did what it said, or the refusal to throw. The sign-in's 404 `not_found` (`shop` null) is a
   *  person in no shops, whose own tenant has no vault. */
  const ok = (answer: ShopAnswer, shop: string | null): unknown => {
    if (answer.kind === "ok") return answer.json;
    if (answer.kind === "left") throw shop !== null ? link.departed(shop, answer.departure) : refusal("not_found");
    if (answer.kind === "refused" && shop === null && answer.status === 404 && answer.code === "not_found") {
      throw refusal("no_shop");
    }
    if (answer.kind === "refused") throw refusal(answer.code);
    if (answer.kind === "signed_out") throw new OpError("signed_out", t("rt.signedOut"));
    if (answer.kind === "offline") throw new OpError("offline", t("rt.offline"));
    throw new OpError("unavailable", t("conn.err.unavailable"));
  };
  /** The shop a change names, checked here with nothing sent: one of the person's shops, which they own, or null while they
   *  are in none. */
  const target = (shop: unknown): string | null => {
    if (shop === null && !link.inShops()) return null;
    const role = typeof shop === "string" ? link.roleAt(shop) : undefined;
    if (!role) throw refusal("not_found");
    if (role !== "owner") throw refusal("owner_only");
    return shop as string;
  };
  const id = (v: unknown, code: string): string => {
    if (!text(v, 256)) throw refusal(code);
    return v;
  };

  return {
    "connections.list": async () => {
      link.live();
      const viewed = await link.viewed();
      if (viewed && viewed.role !== "owner") throw refusal("owner_only");
      const shop = viewed?.shop ?? null;
      const [signIns, outposts] = await Promise.all([link.read(shop, SIGN_INS_PATH), link.read(shop, OUTPOSTS_PATH)]);
      const s = decodeList(ok(signIns, shop), "signIns", decodeSignIn);
      const o = decodeList(ok(outposts, shop), "outposts", decodeOutpost);
      if (!s || !o) throw new OpError("unavailable", t("conn.err.unavailable"));
      return { shop, signIns: s, outposts: o };
    },

    "connections.add": async (p) => {
      link.live();
      const shop = target(p.shop);
      // The vault's own rules, so a sign-in it would refuse is refused here and its password is never sent.
      const refused = newSignInRefusal(p);
      if (refused) throw refusal(refused);
      // Exactly the five fields, as the vault keeps them: the name trimmed, the rest as given.
      const body = { site: siteOf(p.site), origins: [...p.origins], username: p.username, password: p.password, members: [...p.members] };
      // A read first, with the same session: it opens or renews the session, so the one send below goes with one that works,
      // and it says whether the vault has room for one more.
      const listed = decodeList(ok(await link.read(shop, SIGN_INS_PATH), shop), "signIns", decodeSignIn);
      if (!listed) throw new OpError("unavailable", t("conn.err.unavailable"));
      if (listed.length >= MAX_SIGN_INS) throw refusal("too_many_sign_ins");
      const answer = await link.writeOnce(shop, SIGN_INS_PATH, body);
      // A 401 here is a session that ended between the read and the send: nothing was taken, and nothing is sent again.
      if (answer.kind === "refused" && answer.status === 401) throw new OpError("not_saved", t("conn.err.again"));
      const json = ok(answer, shop);
      const signIn = decodeSignIn(isObj(json) ? json.signIn : null);
      if (!signIn) throw new OpError("unavailable", t("conn.err.unavailable"));
      return { signIn };
    },

    "connections.password": async (p) => {
      link.live();
      const shop = target(p.shop);
      const signInId = id(p.signIn, "sign_in_not_found");
      const password = p.password;
      if (typeof password !== "string" || password.length === 0 || password.length > MAX_PASSWORD) throw refusal("invalid_password");
      // A read first, with the same session: it opens or renews the session, so the one send below goes with one that works,
      // and it says whether the shop still has the sign-in.
      const listed = decodeList(ok(await link.read(shop, SIGN_INS_PATH), shop), "signIns", decodeSignIn);
      if (!listed) throw new OpError("unavailable", t("conn.err.unavailable"));
      if (!listed.some((s) => s.id === signInId)) throw refusal("sign_in_not_found");
      const answer = await link.writeOnce(shop, PASSWORD_PATH, { signInId, password });
      // A 401 here is a session that ended between the read and the send: nothing was taken, and nothing is sent again.
      if (answer.kind === "refused" && answer.status === 401) throw new OpError("not_saved", t("conn.err.again"));
      const json = ok(answer, shop);
      const signIn = decodeSignIn(isObj(json) ? json.signIn : null);
      if (!signIn) throw new OpError("unavailable", t("conn.err.unavailable"));
      return { signIn };
    },

    // Who may use a sign-in carries no secret, so it goes as every other change does, again after a 401 if it must.
    "connections.members": async (p) => {
      link.live();
      const shop = target(p.shop);
      const signInId = id(p.signIn, "sign_in_not_found");
      const members = membersOf(p.members);
      if (!members) throw refusal("invalid_members");
      const json = ok(await link.write(shop, MEMBERS_PATH, { signInId, members }), shop);
      const signIn = decodeSignIn(isObj(json) ? json.signIn : null);
      if (!signIn) throw new OpError("unavailable", t("conn.err.unavailable"));
      return { signIn };
    },

    "connections.rename": async (p) => {
      link.live();
      const shop = target(p.shop);
      const outpostId = id(p.outpost, "outpost_not_found");
      // The vault's own rule for a name, so a name it would refuse is refused here with nothing sent.
      const name = typeof p.name === "string" ? p.name.trim() : "";
      if (!name || [...name].length > MAX_OUTPOST_NAME || /[\u0000-\u001f\u007f]/.test(name)) throw refusal("invalid_name");
      const json = ok(await link.write(shop, RENAME_PATH, { outpostId, name }), shop);
      const outpost = decodeOutpost(isObj(json) ? json.outpost : null);
      if (!outpost) throw new OpError("unavailable", t("conn.err.unavailable"));
      return { outpost };
    },

    "connections.remove": async (p) => {
      link.live();
      const shop = target(p.shop);
      const outpostId = id(p.outpost, "outpost_not_found");
      const json = ok(await link.write(shop, REMOVE_PATH, { outpostId }), shop);
      if (!isObj(json) || json.removed !== true || json.outpostId !== outpostId) throw new OpError("unavailable", t("conn.err.unavailable"));
      return { outpost: outpostId };
    },
  };
}
