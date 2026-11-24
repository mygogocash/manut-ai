// Customize › Connections' Google Sheets on the connected runtime (docs/connectors.md, 4b; the routes are docs/pilot-api.md,
// "Google Sheets for Ton's books"): whether the shop's Google is connected and the sheet Ton writes to, Google's consent page for the
// owner's browser, disconnecting, and asking Ton for a month, each read or sent with the owner's session of that shop.
//
// Rules this module keeps:
// - The status is of the shop the switcher shows, read with that shop's own session (shops.ts). A change goes to the shop its row
//   was read for (`p.shop`), never to the one the switcher shows now, and with that shop's session, as an answer to an ask goes to
//   the ask's own shop. A person who is in no shops has none to connect: the API answers a person's own sign-in 404 (Google is
//   connected for pilot shops), so nothing is sent for them (`no_shop`).
// - Only the owner sees or changes these. A shop the person helps at is refused here (`owner_only`) with nothing sent, as the API
//   would refuse a helper's session.
// - Google's consent address is a credential until it is used or ends. It is returned to the page that asked, to open in the system
//   browser, and kept nowhere else: not in this module, the host, the saved read of the shop or an error's words.
// - While the API answers `google_not_configured` (503, before it reads anything else: no environment has the owner's Google client
//   yet) the status is `off`, which is a state and no failure, and every change says so. That 503 is told from an outage by the
//   code the session now keeps on a 5xx (session.ts, `Answer`); any other 5xx reads as no answer.
// - What the API answers is read field by field. An entry this build cannot read is left out of a list, and an answer that is not
//   this route's reads as unavailable, so nothing is shown on a guess. No answer holds a token of Google's.
// - While only a kept read of the shop is shown (the API cannot be reached), nothing here is sent: a change made blind could act on
//   a state that moved on.
import { t } from "../../i18n";
import { MONTH, type BooksSheet, type GoogleBooks, type GoogleOps, type GoogleState, type SentMonth } from "../google";
import { OpError } from "../mock/host";
import type { OwnerLink } from "./connections";
import type { ShopAnswer } from "./shops";

export const GOOGLE_PATH = "/v1/google";
export const CONNECT_PATH = "/v1/google/connect";
export const DISCONNECT_PATH = "/v1/google/disconnect";
export const BOOKS_PATH = "/v1/google/books";

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);
const notNull = <T>(v: T | null): v is T => v !== null;

/** An ISO time from the API in seconds, as the protocol counts; undefined for anything that is not one. */
function seconds(v: unknown): number | undefined {
  const ms = typeof v === "string" ? Date.parse(v) : NaN;
  return Number.isNaN(ms) ? undefined : ms / 1000;
}

/** Whether `v` is an https address with no user name or password, the one kind the page opens in a browser. */
export function httpsUrl(v: unknown, max = 4096): v is string {
  if (typeof v !== "string" || v.length === 0 || v.length > max) return false;
  try {
    const url = new URL(v);
    return url.protocol === "https:" && url.hostname !== "" && url.username === "" && url.password === "";
  } catch {
    return false;
  }
}

/** One month of the sheet's `appended` list (`AppendedMonth` in docs/pilot-api.md), or null when this build cannot read it whole. */
export function decodeSent(v: unknown): SentMonth | null {
  if (!isObj(v) || typeof v.month !== "string" || !MONTH.test(v.month)) return null;
  const at = seconds(v.at);
  if (at === undefined || typeof v.rows !== "number" || !Number.isSafeInteger(v.rows) || v.rows < 0) return null;
  if (v.outcome !== "confirmed" && v.outcome !== "unknown") return null;
  return { month: v.month, at, rows: v.rows, outcome: v.outcome };
}

/** The sheet of the API's status, or null when this build cannot read it whole. What was sent to it leaves out an entry this
 *  build cannot read, and is empty from an API that does not list it. */
export function decodeSheet(v: unknown): BooksSheet | null {
  if (!isObj(v) || typeof v.title !== "string" || v.title.trim() === "" || v.title.length > 512) return null;
  const sent = Array.isArray(v.appended) ? v.appended.map(decodeSent).filter(notNull) : [];
  return { title: v.title, url: httpsUrl(v.url) ? v.url : null, sent };
}

/** Where Google Sheets stands, from `GET /v1/google` (`GoogleStatus`), or null when this build cannot read the answer whole. */
export function decodeGoogle(json: unknown): GoogleState | null {
  if (!isObj(json) || typeof json.connected !== "boolean") return null;
  if (!json.connected) return json.connection === null || json.connection === undefined ? { state: "none" } : null;
  const c = json.connection;
  if (!isObj(c)) return null;
  const connectedAt = seconds(c.connectedAt);
  if (connectedAt === undefined) return null;
  const sheet = c.sheet === null || c.sheet === undefined ? null : decodeSheet(c.sheet);
  if (sheet === null && c.sheet !== null && c.sheet !== undefined) return null;
  if (c.state === "working") return { state: "working", connectedAt, sheet };
  if (c.state === "broken") {
    const broken = isObj(c.broken) ? c.broken : {};
    return { state: "broken", since: seconds(broken.at) ?? connectedAt, reason: typeof broken.reason === "string" ? broken.reason : "refused", sheet };
  }
  return null;
}

/** What asking Ton for a month came to, from the worker run the route answers (`WorkerRun`), or null for an answer that is not one. */
export function decodeBooks(json: unknown): GoogleBooks | null {
  if (!isObj(json)) return null;
  if (json.outcome === "asked") return { outcome: "asked" };
  if (json.outcome === "done") {
    // In the practice days Ton keeps a draft of the append (`send.answer` is `draft_only`); a month with nothing in it ends done with
    // a draft that says so and has no `send`.
    if (!isObj(json.draft)) return null;
    return isObj(json.draft.send) ? { outcome: "drafted" } : { outcome: "empty" };
  }
  if (json.outcome === "failed") return { outcome: "failed", reason: typeof json.reason === "string" && /^[a-z][a-z0-9_]{0,63}$/.test(json.reason) ? json.reason : "unknown" };
  return null;
}

/** What the page says when the API refused, by code: the routes' own refusals in plain words, and the words of the page's own
 *  checks. Any other code reads as a failure with no more to say. */
const REFUSED: Record<string, () => string> = {
  owner_only: () => t("google.err.ownerOnly"),
  no_shop: () => t("google.err.noShop"),
  not_found: () => t("google.err.notFound"),
  google_not_configured: () => t("google.off"),
  not_connected: () => t("google.err.notConnected"),
  invalid_month: () => t("google.err.month"),
  team_paused: () => t("google.err.paused"),
  member_off: () => t("google.err.memberOff"),
  consent_required: () => t("google.err.consent"),
  feature_disabled: () => t("google.err.switchedOff"),
  shop_not_found: () => t("google.err.notFound"),
};

export const refusal = (code: string): OpError => new OpError(code, (REFUSED[code] ?? (() => t("google.err.failed")))());

type Handlers = { [K in keyof GoogleOps]: (p: GoogleOps[K]["params"]) => Promise<GoogleOps[K]["result"]> };

export interface GoogleHooks {
  /** Ton asked the owner: the host reads the shop again so the ask shows in Needs you at once, not at its next read. A failure
   *  here changes nothing the owner is told. */
  asked?: () => Promise<unknown>;
}

/** The four Google ops over `link`. */
export function googleHandlers(link: OwnerLink, hooks: GoogleHooks = {}): Handlers {
  /** The JSON of an answer that did what it said, or the refusal to throw. `changing`: the request made a change, so an API that
   *  does not answer leaves it unknown whether it was made, which the words say. */
  const ok = (answer: ShopAnswer, shop: string, changing = false): unknown => {
    if (answer.kind === "ok") return answer.json;
    if (answer.kind === "left") throw link.departed(shop, answer.departure);
    if (answer.kind === "refused") throw refusal(answer.code);
    if (answer.kind === "signed_out") throw new OpError("signed_out", t("rt.signedOut"));
    if (answer.kind === "offline") throw new OpError("offline", t("rt.offline"));
    // A 503 with Google's own code is the API saying Google is off, not an outage.
    if (answer.code === "google_not_configured") throw refusal("google_not_configured");
    throw new OpError("unavailable", changing ? t("rt.change.noReply") : t("google.err.unavailable"));
  };
  const unreadable = () => new OpError("unavailable", t("google.err.unreadable"));
  /** The shop a change names, checked here with nothing sent: one of the person's shops, which they own. */
  const target = (shop: unknown): string => {
    if (shop === null) throw refusal("no_shop");
    const role = typeof shop === "string" ? link.roleAt(shop) : undefined;
    if (!role) throw refusal("not_found");
    if (role !== "owner") throw refusal("owner_only");
    return shop as string;
  };

  return {
    "google.status": async () => {
      link.live();
      const viewed = await link.viewed();
      if (!viewed) throw refusal("no_shop");
      if (viewed.role !== "owner") throw refusal("owner_only");
      const answer = await link.read(viewed.shop, GOOGLE_PATH);
      if (answer.kind === "unavailable" && answer.code === "google_not_configured") return { shop: viewed.shop, state: "off" };
      const state = decodeGoogle(ok(answer, viewed.shop));
      if (!state) throw unreadable();
      return { shop: viewed.shop, ...state };
    },

    "google.connect": async (p) => {
      link.live();
      const shop = target(p.shop);
      // Exactly the fields the route reads: none. The address in the answer is a one-use consent link, so it is checked and handed
      // on, never kept.
      const json = ok(await link.write(shop, CONNECT_PATH, {}), shop, true);
      const url = isObj(json) ? json.url : undefined;
      const expiresAt = isObj(json) ? seconds(json.expiresAt) : undefined;
      if (!httpsUrl(url) || expiresAt === undefined) throw unreadable();
      return { url, expiresAt };
    },

    "google.disconnect": async (p) => {
      link.live();
      const shop = target(p.shop);
      const json = ok(await link.write(shop, DISCONNECT_PATH, {}), shop, true);
      if (!isObj(json) || json.disconnected !== true || typeof json.revoked !== "boolean") throw unreadable();
      return { revoked: json.revoked };
    },

    "google.books": async (p) => {
      link.live();
      const shop = target(p.shop);
      // The month's form is the API's (`YYYY-MM`); one it would refuse is refused here with nothing sent.
      if (typeof p.month !== "string" || !MONTH.test(p.month)) throw refusal("invalid_month");
      const json = ok(await link.write(shop, BOOKS_PATH, { month: p.month }), shop, true);
      const books = decodeBooks(json);
      if (!books) throw unreadable();
      if (books.outcome === "asked") await Promise.resolve(hooks.asked?.()).catch(() => undefined);
      return books;
    },
  };
}
