import {
  ApiError,
  isLiveShop,
  isSending,
  REPLY_MAX_LENGTH,
  SIGN_IN_MEMBERS,
  type ApprovalState,
  type ApprovalView,
  type AuditActor,
  type AuditEntry,
  type AwaitingOwner,
  type AwayView,
  type CreatedInvite,
  type DeletedShop,
  type Deleting,
  type DeletionGoes,
  type DeletionRequest,
  type DeletionState,
  type DeletionView,
  type EmailCodeSent,
  type EmailSignIn,
  type Fact,
  type HelperRemoval,
  type Identity,
  type InboundMessage,
  type InviteView,
  type JoinAnswer,
  type LinkedOwner,
  type Outpost,
  type OutpostCredential,
  type OutpostRemoval,
  type Payment,
  type People,
  type PilotApi,
  type ReplyAction,
  type Shop,
  type SignIn,
  type SignInRemoval,
  type SubscriptionPayment,
  type UnlinkedOwner,
  type WebSession,
  type WorkerDraft,
  type WorkerJobEntry,
} from "./types";
import { pilotGate } from "./gate";
import { PRACTICE_SHOPS, practiceOwner, type PracticeOwner } from "./practiceOwner";
import { isCode, normalizeEmail } from "./email";
import { endOfShopDay, formatIsoDate } from "../format";
import * as peopleRules from "@manut/people-rules";
import type { Away, Invite, PeopleState } from "@manut/people-rules";
import * as shopMemory from "@manut/shop-memory";
import type { MemoryState, Refusal, Result } from "@manut/shop-memory";
import {
  alertsOf,
  capOf,
  ceilSatang,
  crossingsOf,
  gatewayDefaultCap,
  isCapValue,
  isMonth,
  monthOf,
  usageOf,
  validTenant,
  wipeMeter,
  writeCap,
  type FakeModel,
  type FakeModelGateway,
} from "./meter";
import type { ShopQuestion, ShopTemplate } from "./types";

/// An in-memory stand-in for apps/api that keeps the contract's rules: one decision per request, approving
/// needs the shop's consent, a send settles `confirmed`, `failed` or `unknown`, admin calls need a key, and
/// lists come back newest first. Deleting a live shop asks its owner through a link that settles once, as the
/// API does. A practice deletion wipes a shop in one step, so it never stops part way; a shop whose deletion started
/// and did not finish, in a world saved that way, is listed `deleting` and finished by the same request, as the API
/// lists and finishes one. The pilot gate is measured by the API's rules (gate.ts): a trial starts at the shop's first LINE
/// connection, and the owner's decisions are the times recorded on its replies. It lets every screen run and be
/// tested with no backend.
///
/// Sample world: Baan Mali (owner Fon) on LINE, on day 14 of its trial, with customers asking about late parcels
/// and a refund, and a second shop, Sabai Tea, with nothing connected yet. Demo links on the practice home page
/// open the owner's page in each state: /approve/demo, demo-failed, demo-unknown, demo-sent, demo-declined,
/// demo-old and demo-expired; any other token is an invalid link. Two more are about the words on the page, for the specs that
/// open it at phone sizes: demo-long-thai (a long Thai message from a customer and a long Thai reply, in a shop with a long
/// Thai name) and demo-long-link (a long order id and a long link that have no place to break, in a message, a reply and a
/// customer's name). Each belongs to a shop of its own that the console never lists (`demoShops`), as the deletion demos do.
/// demo-offline cannot be read at all, the way a link opened on a dead connection cannot. The deletion page's demo links
/// (DEMO_DELETION_TOKENS) are about Khao Soi Nimman, a shop that is not on the console's list, so practising them deletes
/// nothing there; one of them is about a shop with a long Thai name and counts in the millions, and one is unreadable too.
///
/// Each shop's audit log is kept as the API keeps it: the same actions and outcomes, metadata only, ids that sort by
/// time and page with the API's cursor, exported with the shop and deleted with it. Practice actions are an
/// operator's with no Access identity, as the API records a service token. Baan Mali's log starts with the history
/// of its sample world.
///
/// What the team knows about each shop is kept by `@manut/shop-memory`'s own rules, as the API keeps it: a refusal
/// answers the API's status and code, a change is recorded in the shop's audit log by the fact's id and never its
/// words, and the facts are exported with the shop and deleted with it. Baan Mali starts with five facts the team
/// learned and two a customer said, which wait for its owner; Sabai Tea has been told nothing.
///
/// The owner's people (docs/people.md) are kept by `@manut/people-rules`' own rules, as the API keeps them: an invite for
/// one LINE account or email, once, for 7 days; removal that ends cover and sessions in one step; cover until a date. A
/// refusal answers the API's status and code, a change is recorded in the shop's audit log by ids only, and the people are
/// exported with the shop and deleted with it. Baan Mali starts with Mint, who helps and covers while Fon is away, Beam
/// invited and not yet joined, and a note Mint passed on; Sabai Tea has only its owner.
///
/// The owner's linked account (docs/several-shops.md) is kept as the API keeps it: an operator links the account a one-use code
/// names, a shop has one at a time, and unlinking signs it out of the shop on every device. The codes are the ones an owner's
/// app might have shown (`PRACTICE_OWNER_CODES`): each works once, for the account that asked for it, and goes the first time it
/// is tried, whatever the answer. A waiting code does not run out by the clock, because practice has no owner's app to ask for a
/// new one; the one that ran out is the sample of that answer. A change is recorded by the link's id, never the account, and
/// the link is exported with the shop and deleted with it. Baan Mali starts linked to Fon's account on two devices; Sabai Tea
/// has no account linked.
///
/// Each shop's model spend (docs/model-gateway.md) is kept as the API's meter keeps it: one record per call, the
/// reservations still open, and an operator's cap override. Months and totals are read from the records, so a total can
/// never disagree with what it adds up. Baan Mali has ฿186 spent of an operator's ฿300 cap with one call in progress, and
/// Sabai Tea the default cap and no calls. A cap set in practice is kept with the rest of the world.
///
/// What Nam, Pim and Ton did for each shop (docs/pilot-api.md, "Workers' drafts") is kept as the API lists it back: one
/// entry per job, oldest first as the shop's task index keeps them, read newest first by a job's task id. Baan Mali has
/// seven jobs, one for each way a job can end here, and Sabai Tea none. Nothing in practice starts a job, so they are the
/// sample's own; they are deleted with the shop, and the practice export does not carry them.
///
/// A shop's vault (docs/pilot-api.md, "Vault sign-ins and outposts") is kept as the API's vault answers it: the sign-ins not
/// removed and the outposts, each as the operator lists them, and the four changes an operator may make, each recorded in the
/// shop's audit log by the record's id only. It holds no password, no credential and no digest of one, because nothing the
/// console can ask for answers one: a new credential is made, answered once and forgotten, so it is in no saved world. Baan Mali
/// starts with the two sign-ins and two outposts its audit log tells the story of: a Shopee sign-in that broke and was mended, a
/// carrier's portal that broke two days ago and still is, Fon's Mac, which beats while the page is open, and a cloud outpost that
/// never has. Sabai Tea has nothing in its vault. The vault is exported with the shop and deleted with it.
///
/// Joining a shop from an invite link (docs/people.md, "Invites") is answered as the API answers it: a code by email first,
/// with the API's limits (one a minute, ten a day, ten minutes, five wrong tries), then the accept. Practice sends no email,
/// so every code is `PRACTICE_SIGN_IN_CODE`, which the join page says aloud. The codes, the sign-ins and the helper sessions
/// they give are kept in memory only, never with the saved world, so a practice sign-in never reaches the browser's storage.
/// The demo links (`DEMO_JOIN_TOKENS`) answer as their names say, about Khao Soi Nimman, so they change nothing; a practice
/// invite's own link from a People page is answered by that shop's people, so joining with the address it names makes a
/// helper the People page then lists.

export type FakeApiOptions = {
  /// Read on every admin call, like the real client. Any non-empty key is accepted.
  operatorKey?: () => string | null;
  now?: () => number;
  /// Delay before each answer, so busy states show in the browser. 0 in tests.
  latencyMs?: number;
  /// How long a send stays `dispatching` before it settles on the next read.
  settleMs?: number;
  /// Where approval links point. Defaults to this page's origin.
  webOrigin?: string;
  /// Keeps the sample data across reloads and tabs, so an approval link opened in a new tab still works.
  storage?: Pick<Storage, "getItem" | "setItem" | "removeItem"> | undefined;
  /// What the model gateway reads from the Worker's settings, and whether its meter is up (meter.ts).
  modelGateway?: FakeModelGateway;
  /// The path of the page open now, read on each sign-in call: while the join page's sign-in-off demo link is open
  /// (`DEMO_JOIN_TOKENS.signInOff`), both sign-in routes answer `email_not_configured`, as every real environment does
  /// today. Defaults to this page's own path.
  pagePath?: () => string;
  /// The query of the page open now: the owner's app opened as `/app/?demo=sign-in-off` (`APP_SIGN_IN_OFF`) answers the
  /// same way. Defaults to this page's own query.
  pageSearch?: () => string;
};

type Outcome = "confirmed" | "failed" | "unknown";

/// The API keeps the trial start on its shop record but answers it only through the gate, never in the shop list. A shop
/// made from a template keeps its first-week questions here, where the API keeps them beside its routines; a question
/// holds only its answer's fact id, and the words are the fact's.
type FakeShop = Shop & { trialStartedAt?: string; questions?: FakeQuestion[]; addedToCohort?: true };
type FakeQuestion = { id: string; text: string; factId?: string; answeredAt?: string };
type FakeConnection = {
  connectionId: string;
  tenant: string;
  channelId: string;
  botUserId: string;
  channelSecret: string;
};
type FakeMessage = InboundMessage & { tenant: string; webhookEventId?: string };
type FakeAction = Omit<ReplyAction, "approvalUrl"> & {
  tenant: string;
  token: string;
  expiresAt: string;
  outcome: Outcome;
};
/// The API's deletion record: who asked and when (the practice key has no Access identity, so nobody), the owner
/// confirmation it names for a live shop, and when the wipe finished.
type FakeDeletionRecord = {
  tenant: string;
  name: string;
  requestedAt: string;
  deletedBy: string | null;
  confirmationId?: string;
  deletedAt?: string;
};
/// One owner confirmation of deleting a shop, with what the shop held when it opened. It leaves `pending` once,
/// into `decided` or `withdrawn` (expired and replaced by a newer request), as approval-core's records do.
type FakeConfirmation = {
  id: string;
  tenant: string;
  token: string;
  shopName: string;
  goes: DeletionGoes;
  expiresAt: string;
  status: "pending" | "decided" | "withdrawn";
  approved?: boolean;
  decidedAt?: string;
};
/// An audit entry with the shop it belongs to, which the API keeps by the shop's own object instead.
type FakeAuditEntry = AuditEntry & { tenant: string };
/// One shop's people as the API keeps them, without the sessions' hashes the fake has no use for: the rules' whole state,
/// and the name the owner gave each invite and helper (kept after a helper is removed, so the log can still name them).
type FakePeople = {
  state: PeopleState;
  names: Record<string, string>;
  /// The account the operator linked as the owner's, and how many of its sessions run now (the fake never lets one run out,
  /// as for a helper's devices). Absent until one is linked, and again once it is unlinked.
  ownerAccount?: FakeOwnerAccount;
  ownerDevices?: number;
};
/// The account linked as a shop's owner, as the API's people record keeps it: the link's id, which the log names; the verified
/// provider subject the account signs in as, which only the shop's own export carries out; and when it was linked.
type FakeOwnerAccount = { id: string; subject: string; linkedAt: number };
/// A code an owner's app showed, waiting for an operator: the account that asked for it, the code in its one form (the API
/// keeps only its SHA-256), and whether it had run out.
type FakeOwnerCode = { code: string; subject: string; ranOut?: boolean };
/// A job with the shop it belongs to, which the API finds through the shop's own task index.
type FakeWorkerJob = WorkerJobEntry & { tenant: string };
/// One shop's vault: its sign-ins, which are the operator's own view because the fake keeps no password to seal, and its outposts.
type FakeVault = { signIns: SignIn[]; outposts: FakeOutpost[] };
/// An outpost as the vault keeps it, without the credential's digest, which nothing here checks. `status` is read from the clock
/// as the API reads it, so it is not kept. `beats` is a machine that is awake and beats every 30 seconds, as the desktop app does
/// while it runs: its last heartbeat is read as the latest of those beats, so the sample Mac stays online while the page is
/// open, however long ago the world was made. A new credential ends it, as it does in the API: the outpost sleeps until the holder
/// of the new credential beats, and nobody holds one in practice.
type FakeOutpost = Omit<Outpost, "status"> & { beats?: true };
/// One address's sign-in codes, as the API's auth object keeps them: the live code's end and its wrong tries while there is
/// one, and when each code of the last 24 hours was sent, oldest first. Practice's code is always `PRACTICE_SIGN_IN_CODE`.
type FakeEmailCode = { live: { expiresAt: number; wrong: number } | null; sent: number[] };
/// A helper session a practice join gave, by its token: the shop whose people record it, or null for a demo link's, which
/// is recorded nowhere else.
type FakeHelperSession = { tenant: string | null; helperId: string; sessionId: string };
type FakeDb = {
  version: 12;
  seq: number;
  shops: FakeShop[];
  /// Shops that only the owner's page practises on (a long Thai name, a long link), so they answer `shopOf` and a reply link
  /// for one works as any does. Every list of shops, the pilot gate and every export read `shops` and never see them.
  demoShops: FakeShop[];
  connections: FakeConnection[];
  messages: FakeMessage[];
  actions: FakeAction[];
  payments: Payment[];
  subscriptionPayments: SubscriptionPayment[];
  deletions: FakeDeletionRecord[];
  confirmations: FakeConfirmation[];
  /// Tokens that answer 410, standing in for links whose signed expiry has passed.
  expiredTokens: string[];
  audit: FakeAuditEntry[];
  /// What the team knows, per shop, as `@manut/shop-memory` keeps it. A shop with no entry has been told nothing.
  memory: Record<string, MemoryState>;
  /// The owner's people, per shop. A shop with no entry has only its owner.
  people: Record<string, FakePeople>;
  /// The codes owners' apps showed that nobody has tried yet. A code leaves the list the first time it is tried.
  ownerCodes: FakeOwnerCode[];
  model: FakeModel;
  /// Every shop's worker jobs, oldest first, the order the API's task index keeps them in.
  workers: FakeWorkerJob[];
  /// Each shop's vault. A shop with no entry has no sign-in and no outpost.
  vault: Record<string, FakeVault>;
};

/// The saved world's `version` decides whether it is read: a world saved before deletions needed an owner's yes
/// (version 1), before trial starts and subscription payments were kept (version 2), before the audit log
/// (version 3), before what the team knows (version 4), before the model meter (version 5), before the workers' jobs
/// (version 6), before the owner's people (version 7), before the owner's linked account and its codes (version 8), before
/// the sample log of the owner's own changes, this Mac and browser writes (version 9), before the shops and links the owner's
/// page practises its long words on (version 10) or before the shops' vaults (version 11) is replaced by a fresh one rather
/// than read without them.
const STORAGE_KEY = "manut.pilot.fake.v1";
const FAKE_API_ORIGIN = "https://pilot-api.invalid";
const DAY_MS = 24 * 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;
/// The API's limits for signing in by email (apps/api/src/email-code.ts): a code works for ten minutes, an address gets
/// one a minute and ten in any 24 hours, and five wrong tries end a code.
const CODE_LIFE_MS = 10 * MINUTE_MS;
const RESEND_MS = MINUTE_MS;
const DAILY_CODES = 10;
const MAX_WRONG_TRIES = 5;
/// The longest device id an exchange takes.
const DEVICE_ID_MAX = 128;
/// A helper session lasts 30 days, with no refresh.
const HELPER_SESSION_MS = 30 * DAY_MS;
/// An outpost beats every 30 seconds while it is awake, and is online while its last beat is under 90 seconds old.
const HEARTBEAT_MS = 30 * 1000;
const ONLINE_MS = 90 * 1000;

export const PRACTICE_CHANNEL_SECRET = "practice-channel-secret";

/// The code every practice sign-in by email takes. Practice sends no email, so the join page says it aloud. It is the code
/// the desktop's Practice sign-in says (apps/desktop/src/settings/emailFlow.ts), so both apps' practice reads the same.
export const PRACTICE_SIGN_IN_CODE = "123456";

/// The join page's demo links (`/join/{token}`). Each is about Khao Soi Nimman, a shop that is not on the console's list,
/// and answers as its name says whoever signs in, so practising one changes nothing anywhere. `signInOff` stands for an
/// environment where signing in by email is off, which every real one is today. Any other token is an unknown invite, but
/// a practice invite's own link from a People page (`practice-<invite id>`), which that shop's people answer.
export const DEMO_JOIN_TOKENS = {
  joined: "demo-join",
  wrongEmail: "demo-join-wrong",
  wrongLine: "demo-join-line",
  expired: "demo-join-expired",
  used: "demo-join-used",
  revoked: "demo-join-revoked",
  signInOff: "demo-join-off",
} as const;

/// The shop the join page's demo links are about, its owner, and the name its owner gave the invite.
export const DEMO_JOIN_SHOP = {
  id: "pilot:practice-khao-soi-nimman",
  name: "Khao Soi Nimman",
  ownerName: "Lek",
  helperName: "Noi",
} as const;

/// The join page's sign-in-off demo link, wherever it is open.
const SIGN_IN_OFF_PATH = new RegExp(`^/join/${DEMO_JOIN_TOKENS.signInOff}/?$`);

/// The owner's app opened with this query stands for an environment where signing in by email is off, as every real one
/// is today: `/app/?demo=sign-in-off`.
export const APP_SIGN_IN_OFF = "demo=sign-in-off";

/// The link codes the practice world holds, as an owner's app shows them (`XXXX-XXXX`). Each works once, and a code goes the first
/// time it is tried, whatever the answer. The sample world's accounts are Fon's, whom Baan Mali already has, Dao's and a guest's.
export const PRACTICE_OWNER_CODES = {
  /// Dao's account: it links Sabai Tea, or any shop that has no account linked.
  dao: "7K0M-4X1R",
  /// Fon's account, the one Baan Mali already has: the link it has, and nothing written.
  fon: "2WNZ-5H8T",
  /// An account that is neither: it links a shop that has none, and is refused with 409 on one that has.
  guest: "5CPV-8EJ3",
  /// A code past its 15 minutes: 410.
  ranOut: "9BDF-3G6S",
} as const;

export const DEMO_TOKENS = {
  waiting: "demo",
  failed: "demo-failed",
  unknown: "demo-unknown",
  sent: "demo-sent",
  declined: "demo-declined",
  expiredRequest: "demo-old",
  expiredLink: "demo-expired",
  /// A long Thai message and a long Thai reply, in a shop with a long Thai name.
  longThai: "demo-long-thai",
  /// A long order id and link that have nowhere to break, in a message, a reply and a customer's name.
  longLink: "demo-long-link",
  /// A link that cannot be read, as on a phone with no connection.
  offline: "demo-offline",
} as const;

export const DEMO_DELETION_TOKENS = {
  waiting: "demo-delete",
  deleting: "demo-delete-deleting",
  deleted: "demo-delete-done",
  kept: "demo-delete-kept",
  unanswered: "demo-delete-old",
  expiredLink: "demo-delete-expired",
  /// A shop with a long Thai name, and counts in the millions.
  longName: "demo-delete-long",
  /// A link that cannot be read, as on a phone with no connection.
  offline: "demo-delete-offline",
} as const;

export function createFakeApi(options: FakeApiOptions = {}): PilotApi & { reset(): void } {
  const now = options.now ?? (() => Date.now());
  const operatorKey = options.operatorKey ?? (() => "practice-key");
  const latencyMs = options.latencyMs ?? 0;
  const settleMs = options.settleMs ?? 3000;
  const storage = options.storage;
  const webOrigin =
    options.webOrigin ?? (typeof location !== "undefined" ? location.origin : "http://localhost:5173");
  const pagePath = options.pagePath ?? (() => (typeof location !== "undefined" ? location.pathname : "/"));
  const pageSearch = options.pageSearch ?? (() => (typeof location !== "undefined" ? location.search : ""));

  let db = load() ?? seed(now());

  // Signing in by email and joining. The codes, the sign-ins (access token to address) and the helper sessions a join gave
  // live in this closure and never in `db`, so nothing of a practice sign-in is ever saved to the browser's storage, and a
  // reload forgets it, as the join page forgets a real one.
  const emailCodes = new Map<string, FakeEmailCode>();
  const signIns = new Map<string, string>();
  const helperSessions = new Map<string, FakeHelperSession>();
  let tokenSeq = 0;
  // The owner's web app's sign-in (src/app): the address and the practice world made for it, in this closure only, as the
  // real one is in cookies the page cannot read. A reload forgets it.
  let webSession: { address: string; world: PracticeOwner } | null = null;

  function load(): FakeDb | null {
    if (!storage) return null;
    try {
      const raw = storage.getItem(STORAGE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw) as FakeDb;
      return parsed && parsed.version === 12 && Array.isArray(parsed.demoShops) && Array.isArray(parsed.actions) &&
        Array.isArray(parsed.confirmations) &&
        Array.isArray(parsed.subscriptionPayments) && Array.isArray(parsed.audit) &&
        typeof parsed.memory === "object" && parsed.memory !== null && Array.isArray(parsed.model?.calls) &&
        Array.isArray(parsed.model.overrides) && Array.isArray(parsed.model.holds) && Array.isArray(parsed.workers) &&
        typeof parsed.people === "object" && parsed.people !== null && Array.isArray(parsed.ownerCodes) &&
        typeof parsed.vault === "object" && parsed.vault !== null
        ? parsed
        : null;
    } catch {
      return null;
    }
  }

  function save(): void {
    if (!storage) return;
    try {
      storage.setItem(STORAGE_KEY, JSON.stringify(db));
    } catch {
      // A full or blocked store only loses the sample data on reload.
    }
  }

  /// Every call starts from what another tab may have saved and saves what it changed.
  async function run<T>(work: () => T): Promise<T> {
    if (latencyMs > 0) await new Promise((resolve) => setTimeout(resolve, latencyMs));
    else await Promise.resolve();
    db = load() ?? db;
    const result = work();
    save();
    return JSON.parse(JSON.stringify(result)) as T;
  }

  /// A call that reads and writes nothing of the saved world: the same wait as every answer, and nothing saved.
  async function quiet<T>(work: () => T): Promise<T> {
    if (latencyMs > 0) await new Promise((resolve) => setTimeout(resolve, latencyMs));
    else await Promise.resolve();
    return work();
  }

  /// Signing in by email is off while the sign-in-off demo link is open, or the owner's app with its sign-in-off demo
  /// query, as it is in every real environment today.
  function signInOff(): boolean {
    const path = pagePath();
    return SIGN_IN_OFF_PATH.test(path) ||
      (/^\/app(\/|$)/.test(path) && new URLSearchParams(pageSearch()).get("demo") === "sign-in-off");
  }

  /// Tries a code for an address, as the API's auth object does: no live code (never asked, used, or past its ten minutes)
  /// is `code_ended`; a wrong code takes a try and the fifth ends it; the right one is used up, so it signs in once.
  function useCode(address: string, code: string): void {
    const record = emailCodes.get(address);
    const live = record?.live;
    if (!record || !live || now() >= live.expiresAt) throw new ApiError(401, "code_ended");
    if (code !== PRACTICE_SIGN_IN_CODE) {
      const wrong = live.wrong + 1;
      const triesLeft = Math.max(0, MAX_WRONG_TRIES - wrong);
      emailCodes.set(address, { ...record, live: triesLeft > 0 ? { ...live, wrong } : null });
      throw new ApiError(401, "wrong_code", undefined, { triesLeft });
    }
    emailCodes.set(address, { ...record, live: null });
  }

  /// The API's 429 for an address that had a code in the last minute or ten in the last day: whole seconds, rounded up.
  function tooManyCodes(waitMs: number): ApiError {
    return new ApiError(429, "too_many_codes", undefined, { retryAfter: Math.max(1, Math.ceil(waitMs / 1000)) });
  }

  /// What a demo link answers (`DEMO_JOIN_TOKENS`), or null for a token that is not one. The joined demo gives a helper
  /// session as any join does, kept here only, so ending it works as ending a real one would.
  function demoJoin(token: string): JoinAnswer | null {
    const shop = { name: DEMO_JOIN_SHOP.name, ownerName: DEMO_JOIN_SHOP.ownerName };
    switch (token) {
      case DEMO_JOIN_TOKENS.joined: {
        tokenSeq += 1;
        const helperId = `helper-demo-${tokenSeq}`;
        const accessToken = `mhs1.practice-demo-${tokenSeq}`;
        helperSessions.set(accessToken, { tenant: null, helperId, sessionId: `hs-demo-${tokenSeq}` });
        return {
          answer: "joined",
          shop: { id: DEMO_JOIN_SHOP.id, ...shop },
          helper: { id: helperId, name: DEMO_JOIN_SHOP.helperName },
          session: { accessToken, expiresAt: iso(now() + HELPER_SESSION_MS) },
        };
      }
      case DEMO_JOIN_TOKENS.wrongEmail:
        return { answer: "wrong_account", shop, invitedOn: "email" };
      case DEMO_JOIN_TOKENS.wrongLine:
        return { answer: "wrong_account", shop, invitedOn: "line" };
      case DEMO_JOIN_TOKENS.expired:
        return { answer: "expired" };
      case DEMO_JOIN_TOKENS.used:
        return { answer: "already_used" };
      case DEMO_JOIN_TOKENS.revoked:
        return { answer: "revoked" };
      default:
        return null;
    }
  }

  /// A practice invite's own link (`practice-<invite id>`): the shop that holds the invite answers it by
  /// `@manut/people-rules`' `acceptInvite`, as the API's people record does, with the address the code went to as the
  /// account. Joining records the helper, the name the owner gave the invite and their first session, and the shop's log
  /// says `helper.joined` by the helper; every other answer writes nothing.
  function joinPractice(inviteId: string, address: string): JoinAnswer {
    const tenant = Object.keys(db.people).find((key) => db.people[key]!.state.invites.some((invite) => invite.id === inviteId));
    const shop = tenant === undefined ? undefined : db.shops.find((s) => s.tenant === tenant);
    if (tenant === undefined || !shop) return { answer: "unknown" };
    const record = peopleOf(tenant);
    const n = db.seq + 1;
    const helperId = `helper-${n}`;
    const sessionId = `hs-${n}`;
    const answered = peopleRules.acceptInvite(record.state, inviteId, { kind: "email", address }, helperId, sessionId, now());
    if (answered.answer === "wrong_account") {
      const invited = record.state.invites.find((invite) => invite.id === inviteId)!;
      return { answer: "wrong_account", shop: { name: shop.name, ownerName: shop.ownerName }, invitedOn: invited.identity.kind };
    }
    if (answered.answer !== "joined") return { answer: answered.answer };
    db.seq = n;
    const name = record.names[inviteId] ?? "";
    db.people[tenant] = { ...record, state: answered.state, names: { ...record.names, [helperId]: name } };
    audit(tenant, { kind: "helper", id: helperId }, "helper.joined", { inviteId, helperId });
    tokenSeq += 1;
    const accessToken = `mhs1.practice-${tokenSeq}`;
    helperSessions.set(accessToken, { tenant, helperId, sessionId });
    return {
      answer: "joined",
      shop: { id: tenant, name: shop.name, ownerName: shop.ownerName },
      helper: { id: helperId, name },
      session: { accessToken, expiresAt: iso(now() + HELPER_SESSION_MS) },
    };
  }

  function admin(): void {
    if (!operatorKey()) throw new ApiError(403, "forbidden");
  }

  function iso(ms: number): string {
    return new Date(ms).toISOString();
  }

  function nextId(prefix: string): string {
    db.seq += 1;
    return `${prefix}_${db.seq}`;
  }

  /// Appends to the shop's audit log, now, as the API would: ids only, and a code for what happened.
  function audit(
    tenant: string,
    actor: AuditActor,
    action: string,
    subject: Record<string, string>,
    outcome = "ok",
    extra: { amountSatang?: number } = {},
  ): void {
    db.seq += 1;
    const at = now();
    db.audit.push({ tenant, id: auditId(at, db.seq), at: iso(at), actor, action, subject, outcome, ...extra });
  }

  /// The API's answers for a shop that is not there: `tenant_deleted`, saying when and by whom, once it has been
  /// deleted, and `shop_not_found` for a tenant that was never a shop.
  function shopOf(tenant: string): FakeShop {
    const shop = db.shops.find((s) => s.tenant === tenant) ?? db.demoShops.find((s) => s.tenant === tenant);
    if (shop) return shop;
    const record = db.deletions.find((d) => d.tenant === tenant);
    if (record?.deletedAt) {
      throw new ApiError(404, "tenant_deleted", undefined, { deletedAt: record.deletedAt, deletedBy: record.deletedBy });
    }
    throw new ApiError(404, "shop_not_found");
  }

  /// The API's rule: the same name when it differs only in outer spaces or in how an accented letter was composed.
  function sameName(typed: string, stored: string): boolean {
    return typed.normalize("NFC").trim() === stored.normalize("NFC").trim();
  }

  /// What deleting the shop would take now, or null once it is gone.
  function goesOf(tenant: string): DeletionGoes | null {
    const shop = db.shops.find((s) => s.tenant === tenant);
    if (!shop) return null;
    const mine = <T extends { tenant: string }>(item: T) => item.tenant === tenant;
    return {
      messages: db.messages.filter(mine).length,
      replies: db.actions.filter(mine).length,
      // Both ledgers, as the API counts them: the deletion takes both.
      payments: db.payments.filter(mine).length + db.subscriptionPayments.filter(mine).length,
      lineConnected: Boolean(shop.lineConnectionId),
    };
  }

  function recordOf(tenant: string): FakeDeletionRecord | undefined {
    return db.deletions.find((d) => d.tenant === tenant);
  }

  function writeRecord(record: FakeDeletionRecord): FakeDeletionRecord {
    db.deletions = [...db.deletions.filter((d) => d.tenant !== record.tenant), record];
    return record;
  }

  function currentConfirmation(record: FakeDeletionRecord | undefined): FakeConfirmation | undefined {
    return record?.confirmationId ? db.confirmations.find((c) => c.id === record.confirmationId) : undefined;
  }

  /// Everything stored for the shop goes at once, and the record says when.
  function wipe(record: FakeDeletionRecord): DeletedShop {
    const mine = <T extends { tenant: string }>(item: T) => item.tenant === record.tenant;
    const deleted: DeletedShop = {
      tasksWiped: new Set(db.actions.filter(mine).map((a) => a.taskId)).size,
      connectionsWiped: db.connections.filter(mine).length,
      schedulesWiped: 0,
      occurrencesWiped: 0,
      sessionsWiped: 0,
      deletedAt: iso(now()),
    };
    db.shops = db.shops.filter((s) => !mine(s));
    db.connections = db.connections.filter((c) => !mine(c));
    db.messages = db.messages.filter((m) => !mine(m));
    db.actions = db.actions.filter((a) => !mine(a));
    db.payments = db.payments.filter((p) => !mine(p));
    db.subscriptionPayments = db.subscriptionPayments.filter((p) => !mine(p));
    // The log goes with the shop; the deletion record below keeps who asked and when.
    db.audit = db.audit.filter((e) => !mine(e));
    // What the team knew goes too, the fingerprints of what it forgot with it.
    delete db.memory[record.tenant];
    // The people go too, with the names the owner gave them.
    delete db.people[record.tenant];
    // The vault goes with its sign-ins and outposts.
    delete db.vault[record.tenant];
    wipeMeter(db.model, record.tenant);
    // The jobs of its team go with it, drafts included.
    db.workers = db.workers.filter((job) => !mine(job));
    writeRecord({ ...record, deletedAt: deleted.deletedAt });
    return deleted;
  }

  function deletionLinkOf(confirmation: FakeConfirmation): string {
    return `${webOrigin.replace(/\/+$/, "")}/delete/${encodeURIComponent(confirmation.token)}`;
  }

  function awaiting(confirmation: FakeConfirmation): AwaitingOwner {
    return { status: "awaiting_owner", confirmUrl: deletionLinkOf(confirmation), expiresAt: confirmation.expiresAt };
  }

  /// The confirmation already open, or a new one. One that expired unanswered is withdrawn as the new one opens.
  function askOwner(shop: FakeShop, record: FakeDeletionRecord | undefined): AwaitingOwner {
    const current = currentConfirmation(record);
    if (current?.status === "pending") {
      if (now() < Date.parse(current.expiresAt)) return awaiting(current);
      current.status = "withdrawn";
    }
    const at = now();
    const confirmation: FakeConfirmation = {
      id: nextId("del"),
      tenant: shop.tenant,
      token: randomToken(),
      shopName: shop.name,
      goes: goesOf(shop.tenant)!,
      expiresAt: iso(at + DAY_MS),
      status: "pending",
    };
    db.confirmations.push(confirmation);
    writeRecord({ tenant: shop.tenant, name: shop.name, requestedAt: iso(at), deletedBy: null, confirmationId: confirmation.id });
    audit(shop.tenant, PRACTICE_OPERATOR, "deletion.requested", { confirmationId: confirmation.id }, "awaiting_owner");
    return awaiting(confirmation);
  }

  function deletionStateOf(confirmation: FakeConfirmation): DeletionState {
    if (confirmation.status === "decided") {
      if (!confirmation.approved) return "declined";
      const record = recordOf(confirmation.tenant);
      return record?.confirmationId === confirmation.id && record.deletedAt ? "deleted" : "deleting";
    }
    if (confirmation.status === "withdrawn") return "expired";
    return now() < Date.parse(confirmation.expiresAt) ? "awaiting_owner" : "expired";
  }

  function deletionViewOf(confirmation: FakeConfirmation): DeletionView {
    const state = deletionStateOf(confirmation);
    const view: DeletionView = {
      shopName: confirmation.shopName,
      goes: state === "deleted" ? confirmation.goes : (goesOf(confirmation.tenant) ?? confirmation.goes),
      state,
      expiresAt: confirmation.expiresAt,
    };
    if (confirmation.decidedAt) view.decidedAt = confirmation.decidedAt;
    return view;
  }

  /// The API's rule for a deletion under way: one recorded for a shop that never went live, which starts as it is
  /// recorded, or one its owner said yes to, and not finished.
  function startedDeletionOf(tenant: string): FakeDeletionRecord | undefined {
    const record = recordOf(tenant);
    if (!record || record.deletedAt) return undefined;
    if (!record.confirmationId) return record;
    const confirmation = currentConfirmation(record);
    return confirmation?.status === "decided" && confirmation.approved ? record : undefined;
  }

  function deletionRequestOf(tenant: string): DeletionRequest | undefined {
    const confirmation = currentConfirmation(recordOf(tenant));
    if (!confirmation) return undefined;
    const request: DeletionRequest = {
      state: deletionStateOf(confirmation),
      confirmUrl: deletionLinkOf(confirmation),
      expiresAt: confirmation.expiresAt,
    };
    if (confirmation.decidedAt) request.decidedAt = confirmation.decidedAt;
    return request;
  }

  /// A deletion link's confirmation. Its link expires with it, as the API signs both with one expiry.
  function confirmationByToken(token: string): FakeConfirmation {
    // The sample of a phone with no connection: the page's own client answers this way when its request never arrives.
    if (token === DEMO_DELETION_TOKENS.offline) throw new ApiError(0, "network");
    if (db.expiredTokens.includes(token)) throw new ApiError(410, "link_expired");
    const confirmation = db.confirmations.find((c) => c.token === token);
    if (!confirmation) throw new ApiError(404, "link_invalid");
    if (now() >= Date.parse(confirmation.expiresAt)) throw new ApiError(410, "link_expired");
    return confirmation;
  }

  /// A send that has had `settleMs` to finish settles on whoever reads it next.
  function settle(action: FakeAction): void {
    if (!isSending(action.state) || !action.decidedAt) return;
    if (now() - Date.parse(action.decidedAt) < settleMs) return;
    action.state = action.outcome;
    if (action.outcome !== "failed") action.dispatchedAt = iso(now());
    audit(action.tenant, SYSTEM, "dispatch.settled", { taskId: action.taskId, actionId: action.actionId },
      action.outcome);
  }

  function byToken(token: string): FakeAction {
    // The sample of a phone with no connection: the page's own client answers this way when its request never arrives.
    if (token === DEMO_TOKENS.offline) throw new ApiError(0, "network");
    if (db.expiredTokens.includes(token)) throw new ApiError(410, "link_expired");
    const action = db.actions.find((a) => a.token === token);
    if (!action) throw new ApiError(404, "link_invalid");
    if (now() > Date.parse(action.expiresAt)) throw new ApiError(410, "link_expired");
    settle(action);
    return action;
  }

  function viewOf(action: FakeAction): ApprovalView {
    const shop = shopOf(action.tenant);
    const message = db.messages.find((m) => m.id === action.messageId);
    const view: ApprovalView = {
      shopName: shop.name,
      memberName: "Nam",
      memberRole: "sales chat",
      kind: "line.reply",
      customerName: message?.displayName ?? "a customer",
      customerMessage: message?.text ?? "",
      replyText: action.replyText,
      state: action.state,
      expiresAt: action.expiresAt,
      needsConsent: !shop.consent,
    };
    if (action.decidedAt) view.decidedAt = action.decidedAt;
    return view;
  }

  function linkOf(action: FakeAction): string {
    return `${webOrigin.replace(/\/+$/, "")}/approve/${encodeURIComponent(action.token)}`;
  }

  /// The shop's log, newest first, as the API answers it.
  function auditOf(tenant: string): AuditEntry[] {
    return db.audit
      .filter((entry) => entry.tenant === tenant)
      .sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0))
      .map(({ tenant: _tenant, ...entry }) => entry);
  }

  function newestFirst<T>(items: T[], at: (item: T) => string): T[] {
    return [...items].sort((a, b) => Date.parse(at(b)) - Date.parse(at(a)));
  }

  /// What the team knows about a shop: nothing for one it was never told about.
  function memoryOf(tenant: string): MemoryState {
    return db.memory[tenant] ?? shopMemory.emptyState();
  }

  /// The API's checks before a memory rule runs: a tenant of 1 to 256 characters, and a fact id of 1 to 64.
  function memoryTenant(tenant: unknown): string {
    if (typeof tenant !== "string" || tenant.length < 1 || tenant.length > 256) throw new ApiError(400, "tenant_required");
    return tenant;
  }

  function memoryFactId(id: unknown): string {
    if (typeof id !== "string" || id.length < 1 || id.length > 64) throw new ApiError(400, "invalid_request");
    return id;
  }

  /// One change to a shop's memory by the package's rule, as the API does it. A refusal answers the API's status and
  /// code and changes nothing. A change is kept and recorded in the shop's audit log by the fact's id, never its words;
  /// a confirm of a fact that is already confirmed hands back the very state it was given, so it records nothing.
  function changeFact(tenant: string, action: string, operate: (state: MemoryState) => Result): Fact {
    const before = memoryOf(tenant);
    const result = operate(before);
    if (!result.ok) throw new ApiError(MEMORY_STATUS[result.reason], result.reason);
    if (result.state !== before) {
      db.memory[tenant] = result.state;
      audit(tenant, PRACTICE_OPERATOR, action, { factId: result.fact.id });
    }
    return result.fact;
  }

  /// A shop's people: only its owner for a shop that was never given any.
  function peopleOf(tenant: string): FakePeople {
    return db.people[tenant] ?? { state: peopleRules.emptyPeople(tenant, OWNER_ID), names: {} };
  }

  /// The API's checks before any people route reads the shop: a tenant of 1 to 256 characters, then a pilot shop. The
  /// people routes say `shop_not_found` for anything that is not one, a deleted shop included.
  function peopleShop(tenant: unknown): FakeShop {
    if (!validTenant(tenant)) throw new ApiError(400, "tenant_required");
    const shop = db.shops.find((s) => s.tenant === tenant);
    if (!shop) throw new ApiError(404, "shop_not_found");
    return shop;
  }

  /// What the API's export carries of a shop's people: the rules' state, the names and the linked account with the subject it
  /// signs in as, or null.
  function exportedPeople(tenant: string) {
    const { state, names, ownerAccount } = peopleOf(tenant);
    return { state, names, ownerAccount: ownerAccount ?? null };
  }

  /// The id of an invite or a helper in a body: text of 1 to 256 characters, which is what the shop's record keeps.
  function peopleId(id: unknown): string {
    if (typeof id !== "string" || id.length < 1 || id.length > 256) throw new ApiError(400, "invalid_request");
    return id;
  }

  /// The link for an invite, the same each time it is shown while the invite waits. Nothing sends it. It has the shape of
  /// the API's `${WEB_ORIGIN}/join/{token}`, and in practice it opens the join page, where `acceptInvite` answers it from
  /// this shop's people.
  function inviteLink(invite: Invite): string {
    return `${webOrigin.replace(/\/+$/, "")}/join/practice-${invite.id}`;
  }

  /// An invite past its 7 days is never used, so it reads as expired whatever the record still says. The view has no link:
  /// the list adds one for an invite that waits, and creating one answers its link beside the invite.
  function inviteView(invite: Invite, name: string, nowMs: number): InviteView {
    return {
      id: invite.id,
      name,
      identity: invite.identity,
      status: invite.status === "pending" && nowMs >= invite.expiresAt ? "expired" : invite.status,
      createdAt: iso(invite.createdAt),
      expiresAt: iso(invite.expiresAt),
    };
  }

  function awayView(state: PeopleState, away: Away, names: Record<string, string>, nowMs: number): AwayView {
    return { helperId: away.helperId, name: names[away.helperId] ?? "", until: iso(away.until),
      inForce: peopleRules.coverAt(state, nowMs) !== null };
  }

  /// What the API's people list answers for the shop.
  function peopleList(shop: FakeShop): People {
    const { state, names, ownerAccount, ownerDevices } = peopleOf(shop.tenant);
    const nowMs = now();
    return {
      tenant: shop.tenant,
      // The account is shown by its link's id, never by the subject it signs in as; `devices` is its sessions open now.
      owner: {
        name: shop.ownerName,
        account: ownerAccount
          ? { id: ownerAccount.id, linkedAt: iso(ownerAccount.linkedAt), devices: ownerDevices ?? 0 }
          : null,
      },
      // `devices` is the sessions open now: the fake never lets one run out, so it is every session of the helper's.
      helpers: state.helpers.map((helper) => ({ id: helper.id, name: names[helper.id] ?? "", identity: helper.identity,
        joinedAt: iso(helper.joinedAt), devices: helper.sessions.length })),
      invites: state.invites.map((invite) => {
        const shown = inviteView(invite, names[invite.id] ?? "", nowMs);
        return shown.status === "pending" ? { ...shown, inviteUrl: inviteLink(invite) } : shown;
      }),
      away: state.away ? awayView(state, state.away, names, nowMs) : null,
      passedOn: state.passedOn.map((passed) => ({ requestId: passed.requestId, kind: passed.kind, by: passed.by,
        name: names[passed.by] ?? "", note: passed.note, at: iso(passed.at) })),
      removed: state.removed.map((id) => ({ id, name: names[id] ?? "" })),
    };
  }

  /// A shop's vault: nothing in it for one that was never given a sign-in or an outpost. The API's admin routes answer for any
  /// tenant that is one, as its vault object answers for any shop, so the practice world does too.
  function vaultOf(tenant: string): FakeVault {
    return db.vault[tenant] ?? { signIns: [], outposts: [] };
  }

  /// The API's check before any vault route reads the shop: a tenant of 1 to 256 characters, and no more than that.
  function vaultTenant(tenant: unknown): string {
    if (!validTenant(tenant)) throw new ApiError(400, "tenant_required");
    return tenant;
  }

  /// An outpost as the API lists it: `online` while its last heartbeat is under 90 seconds old, `asleep` otherwise, and before
  /// its first beat. A machine that beats is read at the latest of its beats, never more than 30 seconds old.
  function outpostView({ beats, ...outpost }: FakeOutpost): Outpost {
    const at = now();
    const lastHeartbeatAt = beats ? iso(at - (at % HEARTBEAT_MS)) : outpost.lastHeartbeatAt;
    const online = lastHeartbeatAt !== null && at - Date.parse(lastHeartbeatAt) < ONLINE_MS;
    return { ...outpost, status: online ? "online" : "asleep", lastHeartbeatAt };
  }

  return {
    reset() {
      db = seed(now());
      save();
      emailCodes.clear();
      signIns.clear();
      helperSessions.clear();
    },

    async deliverLineWebhook(connectionId, rawBody, signature) {
      if (latencyMs > 0) await new Promise((resolve) => setTimeout(resolve, latencyMs));
      db = load() ?? db;
      const connection = db.connections.find((c) => c.connectionId === connectionId);
      if (!connection) throw new ApiError(404, "http_404");
      const expected = await lineSignature(connection.channelSecret, rawBody);
      if (!signature || signature !== expected) throw new ApiError(401, "http_401");
      let events: unknown[] = [];
      try {
        const parsed = JSON.parse(rawBody) as { events?: unknown };
        events = Array.isArray(parsed.events) ? parsed.events : [];
      } catch {
        events = [];
      }
      for (const event of events) {
        const e = event as {
          type?: string;
          webhookEventId?: string;
          timestamp?: number;
          source?: { userId?: string };
          message?: { type?: string; text?: string };
        };
        if (e.type !== "message" || e.message?.type !== "text" || typeof e.message.text !== "string") continue;
        if (!e.webhookEventId || db.messages.some((m) => m.webhookEventId === e.webhookEventId)) continue;
        db.messages.push({
          id: nextId("msg"),
          tenant: connection.tenant,
          connectionId,
          lineUserId: e.source?.userId ?? "unknown",
          text: e.message.text,
          receivedAt: iso(typeof e.timestamp === "number" ? e.timestamp : now()),
          webhookEventId: e.webhookEventId,
        });
      }
      save();
    },

    getApproval: (token) => run(() => viewOf(byToken(token))),

    giveConsent: (token) =>
      run(() => {
        const action = byToken(token);
        shopOf(action.tenant).consent = true;
        audit(action.tenant, OWNER, "consent.given", {});
        return viewOf(action);
      }),

    decide: (token, approve) =>
      run(() => {
        const action = byToken(token);
        if (action.state !== "proposed") throw new ApiError(409, "already_decided", viewOf(action));
        const shop = shopOf(action.tenant);
        if (approve && !shop.consent) throw new ApiError(403, "consent_required");
        action.decidedAt = iso(now());
        action.state = approve ? "dispatching" : "rejected";
        const about = { taskId: action.taskId, actionId: action.actionId };
        audit(action.tenant, OWNER, "reply.decided", about, approve ? "approved" : "declined");
        if (approve) audit(action.tenant, SYSTEM, "dispatch.started", about);
        return viewOf(action);
      }),

    createShop: (input) =>
      run(() => {
        admin();
        const name = input.name.trim();
        const ownerName = input.ownerName.trim();
        if (!name || !ownerName) throw new ApiError(400, "invalid_body");
        // As the API: a template is checked before anything is made, and one that is not a template makes no shop.
        const template = input.template === undefined ? null : (SHOP_TEMPLATES.find((t) => t.id === input.template) ?? null);
        if (input.template !== undefined && !template) throw new ApiError(400, "unknown_template");
        const shop: FakeShop = { tenant: nextId("shop"), name, ownerName, consent: false,
          ...(template ? { template: template.id,
            questions: template.questions.map((text, index) => ({ id: `q${index + 1}`, text })) } : {}) };
        db.shops.push(shop);
        audit(shop.tenant, PRACTICE_OPERATOR, "shop.created", {});
        if (template) audit(shop.tenant, PRACTICE_OPERATOR, "template.applied", { templateId: template.id });
        return { tenant: shop.tenant, name: shop.name, ownerName: shop.ownerName,
          ...(template ? { template: template.id } : {}) };
      }),

    listShops: () =>
      run(() => {
        admin();
        return db.shops.map(({ trialStartedAt: _trial, questions: _questions, addedToCohort: _added, ...shop }): Shop => {
          const deletion = deletionRequestOf(shop.tenant);
          // A shop here still has its record: a practice wipe takes the record and the rest in one step.
          const deleting: Deleting | undefined = startedDeletionOf(shop.tenant) ? { shopRecord: true } : undefined;
          return { ...shop, ...(deletion ? { deletion } : {}), ...(deleting ? { deleting } : {}) };
        });
      }),

    listTemplates: () =>
      run(() => {
        admin();
        return SHOP_TEMPLATES;
      }),

    // As the API: the template the shop was made from, and each question with its answer read from what the team knows,
    // so an answer the owner had the team forget has no words.
    getQuestions: (tenant) =>
      run(() => {
        admin();
        const shop = shopOf(tenant);
        const facts = memoryOf(tenant).facts;
        return {
          tenant,
          template: shop.template ?? null,
          questions: (shop.questions ?? []).map((question) => questionView(question, facts)),
        };
      }),

    answerQuestion: (input) =>
      run(() => {
        admin();
        const shop = shopOf(input.tenant);
        const question = shop.questions?.find((candidate) => candidate.id === input.questionId);
        if (!question) throw new ApiError(404, "not_found");
        if (question.factId !== undefined) throw new ApiError(409, "already_answered");
        const fact = changeFact(input.tenant, "memory.remembered", (state) => shopMemory.remember(state, input.text, now()));
        question.factId = fact.id;
        question.answeredAt = iso(now());
        audit(input.tenant, PRACTICE_OPERATOR, "question.answered", { questionId: question.id, factId: fact.id });
        return questionView(question, memoryOf(input.tenant).facts);
      }),

    createLineConnection: (input) =>
      run(() => {
        admin();
        const shop = shopOf(input.tenant);
        if (!input.channelId || !input.botUserId || !input.channelSecret || !input.channelAccessToken) {
          throw new ApiError(400, "invalid_body");
        }
        const connectionId = nextId("line");
        // The access token goes to the vault in the real backend and is never returned; the fake drops it.
        db.connections.push({
          connectionId,
          tenant: shop.tenant,
          channelId: input.channelId,
          botUserId: input.botUserId,
          channelSecret: input.channelSecret,
        });
        // The first connection starts the shop's trial; a later one never moves it.
        if (!shop.trialStartedAt && !shop.lineConnectionId) shop.trialStartedAt = iso(now());
        const previous = shop.lineConnectionId;
        shop.lineConnectionId = connectionId;
        audit(shop.tenant, PRACTICE_OPERATOR, "line.connected",
          { connectionId, ...(previous && previous !== connectionId ? { previousConnectionId: previous } : {}) });
        return { connectionId, webhookUrl: `${FAKE_API_ORIGIN}/v1/inbound/line/${connectionId}` };
      }),

    listMessages: (tenant) =>
      run(() => {
        admin();
        shopOf(tenant);
        return newestFirst(
          db.messages.filter((m) => m.tenant === tenant),
          (m) => m.receivedAt,
        ).map(({ tenant: _tenant, webhookEventId: _event, ...message }) => message);
      }),

    proposeReply: (input) =>
      run(() => {
        admin();
        shopOf(input.tenant);
        const message = db.messages.find((m) => m.id === input.messageId && m.tenant === input.tenant);
        if (!message) throw new ApiError(404, "unknown_message");
        if (input.text.length < 1 || input.text.length > REPLY_MAX_LENGTH) throw new ApiError(400, "invalid_text");
        const proposedAt = now();
        const action: FakeAction = {
          tenant: input.tenant,
          taskId: `task_${input.tenant}`,
          actionId: nextId("act"),
          messageId: message.id,
          replyText: input.text,
          state: "proposed",
          proposedAt: iso(proposedAt),
          token: randomToken(),
          expiresAt: iso(proposedAt + DAY_MS),
          outcome: "confirmed",
        };
        db.actions.push(action);
        message.replyActionId = action.actionId;
        audit(input.tenant, PRACTICE_OPERATOR, "reply.proposed",
          { taskId: action.taskId, actionId: action.actionId, messageId: message.id });
        return {
          taskId: action.taskId,
          actionId: action.actionId,
          approvalUrl: linkOf(action),
          expiresAt: action.expiresAt,
        };
      }),

    listActions: (tenant) =>
      run(() => {
        admin();
        shopOf(tenant);
        const actions = db.actions.filter((a) => a.tenant === tenant);
        actions.forEach(settle);
        return newestFirst(actions, (a) => a.proposedAt).map((a) => {
          const action: ReplyAction = {
            taskId: a.taskId,
            actionId: a.actionId,
            messageId: a.messageId,
            replyText: a.replyText,
            state: a.state,
            proposedAt: a.proposedAt,
            approvalUrl: linkOf(a),
          };
          if (a.decidedAt) action.decidedAt = a.decidedAt;
          if (a.dispatchedAt) action.dispatchedAt = a.dispatchedAt;
          return action;
        });
      }),

    recordPayment: (input) =>
      run(() => {
        admin();
        shopOf(input.tenant);
        const orderRef = input.orderRef.trim();
        const promptPayId = input.promptPayId.trim();
        if (!orderRef || !promptPayId || !Number.isSafeInteger(input.amountSatang) || input.amountSatang <= 0) {
          throw new ApiError(400, "invalid_body");
        }
        const payment: Payment = {
          id: nextId("pay"),
          tenant: input.tenant,
          orderRef,
          amountSatang: input.amountSatang,
          promptPayId,
          confirmedAt: iso(now()),
        };
        const note = input.slipNote?.trim();
        if (note) payment.slipNote = note;
        db.payments.push(payment);
        audit(input.tenant, PRACTICE_OPERATOR, "payment.recorded", { paymentId: payment.id }, "ok",
          { amountSatang: payment.amountSatang });
        return payment;
      }),

    listPayments: (tenant) =>
      run(() => {
        admin();
        shopOf(tenant);
        return newestFirst(
          db.payments.filter((p) => p.tenant === tenant),
          (p) => p.confirmedAt,
        );
      }),

    // Like the backend's export: connection metadata without the channel secret, and replies without their
    // link tokens, which the backend never stores.
    exportShop: (tenant) =>
      run(() => {
        admin();
        const shop = shopOf(tenant);
        return {
          tenant,
          exportedAt: iso(now()),
          connections: db.connections
            .filter((c) => c.tenant === tenant)
            .map(({ channelSecret: _secret, ...connection }) => connection),
          pilot: {
            shop,
            messages: db.messages.filter((m) => m.tenant === tenant),
            replies: db.actions
              .filter((a) => a.tenant === tenant)
              .map(({ token: _token, outcome: _outcome, ...reply }) => reply),
            payments: db.payments.filter((p) => p.tenant === tenant),
            subscriptionPayments: db.subscriptionPayments.filter((p) => p.tenant === tenant),
          },
          // As the backend's export: every entry, oldest first, and what the log could not write.
          audit: { entries: auditOf(tenant).reverse(), missed: null },
          // What the team knows: every fact, waiting ones included, and only how many it was told to forget.
          memory: shopMemory.exportFacts(memoryOf(tenant)),
          // Who the people are, what they passed on and the owner's linked account, as the API's export carries them (it never
          // carries a session's hash, nor a count of sessions).
          people: exportedPeople(tenant),
          // The vault's sign-ins and outposts as the operator lists them: never a password, a credential or a digest of one.
          signIns: vaultOf(tenant).signIns,
          outposts: vaultOf(tenant).outposts.map(outpostView),
        };
      }),

    // As the API: the name first; then a deletion the owner already said yes to is finished without asking again;
    // a live shop's owner is asked; a stopped deletion of a shop that never went live is finished as it was asked
    // for, keeping who asked and when; any other shop that never went live is deleted at once.
    deleteShop: (input) =>
      run((): DeletedShop | AwaitingOwner => {
        admin();
        const shop = shopOf(input.tenant);
        if (!sameName(input.confirmName, shop.name)) throw new ApiError(409, "name_mismatch");
        const record = recordOf(shop.tenant);
        const current = currentConfirmation(record);
        if (record && current?.status === "decided" && current.approved) return wipe(record);
        if (isLiveShop(shop)) return askOwner(shop, record);
        const started = startedDeletionOf(shop.tenant);
        if (started) return wipe(started);
        // Recorded and then wiped with the rest of the shop, as the API does.
        audit(shop.tenant, PRACTICE_OPERATOR, "deletion.requested", {});
        return wipe(writeRecord({ tenant: shop.tenant, name: shop.name, requestedAt: iso(now()), deletedBy: null }));
      }),

    getDeletion: (token) => run(() => deletionViewOf(confirmationByToken(token))),

    decideDeletion: (token, approve) =>
      run(() => {
        const confirmation = confirmationByToken(token);
        if (confirmation.status === "decided") {
          throw new ApiError(409, "already_decided", undefined, { deletionView: deletionViewOf(confirmation) });
        }
        if (confirmation.status === "withdrawn") throw new ApiError(404, "link_invalid");
        confirmation.status = "decided";
        confirmation.approved = approve;
        confirmation.decidedAt = iso(now());
        audit(confirmation.tenant, OWNER, "deletion.decided", { confirmationId: confirmation.id },
          approve ? "approved" : "declined");
        const deletion = recordOf(confirmation.tenant);
        if (approve && deletion?.confirmationId === confirmation.id) wipe(deletion);
        return deletionViewOf(confirmation);
      }),

    // As the API: the shop first, then a positive whole number of satang, a slip reference of 1 to 128 characters
    // once trimmed, and a slip not yet recorded for the shop, compared without spaces or capitals.
    recordSubscriptionPayment: (input) =>
      run(() => {
        admin();
        shopOf(input.tenant);
        const slipRef = input.slipRef.trim();
        if (!Number.isSafeInteger(input.amountSatang) || input.amountSatang <= 0 || slipRef.length < 1 ||
            slipRef.length > 128 || (input.slipNote !== undefined && input.slipNote.length > 1000)) {
          throw new ApiError(400, "invalid_request");
        }
        const plain = (ref: string) => ref.replace(/\s+/g, "").toUpperCase();
        if (db.subscriptionPayments.some((p) => p.tenant === input.tenant && plain(p.slipRef) === plain(slipRef))) {
          throw new ApiError(409, "slip_already_recorded");
        }
        const payment: SubscriptionPayment = {
          id: nextId("sub"),
          tenant: input.tenant,
          amountSatang: input.amountSatang,
          slipRef,
          confirmedAt: iso(now()),
        };
        const note = input.slipNote?.trim();
        if (note) payment.slipNote = note;
        db.subscriptionPayments.push(payment);
        audit(input.tenant, PRACTICE_OPERATOR, "subscription_payment.recorded", { paymentId: payment.id }, "ok",
          { amountSatang: payment.amountSatang });
        return payment;
      }),

    listSubscriptionPayments: (tenant) =>
      run(() => {
        admin();
        shopOf(tenant);
        return newestFirst(
          db.subscriptionPayments.filter((p) => p.tenant === tenant),
          (p) => p.confirmedAt,
        );
      }),

    // As the API: only a shop its owner made is added or left out, and asking for what holds records nothing.
    setGateCohort: (tenant, counted) =>
      run(() => {
        admin();
        const shop = shopOf(tenant);
        if (!shop.selfServe) throw new ApiError(409, "not_self_serve");
        if (counted !== Boolean(shop.addedToCohort)) {
          if (counted) shop.addedToCohort = true;
          else delete shop.addedToCohort;
          audit(tenant, PRACTICE_OPERATOR, counted ? "cohort.added" : "cohort.removed", {});
        }
        return { tenant, counted };
      }),

    // Every shop, in the order they were created, with the owner's decisions as the times recorded on its replies,
    // approvals and declines alike, as the API reads them.
    getGate: () =>
      run(() => {
        admin();
        return pilotGate(
          db.shops.map((shop) => ({
            tenant: shop.tenant,
            name: shop.name,
            trialStartedAt: shop.trialStartedAt ?? null,
            decisions: db.actions.flatMap((a) => (a.tenant === shop.tenant && a.decidedAt ? [a.decidedAt] : [])),
            subscriptionPayments: db.subscriptionPayments.filter((p) => p.tenant === shop.tenant),
            ...(shop.selfServe ? { selfServe: true } : {}),
            ...(shop.addedToCohort ? { addedToCohort: true } : {}),
          })),
          now(),
        );
      }),

    // As the API: any tenant (one with no log, or a deleted shop, reads as an empty page), newest first, the page
    // before an entry's id, 50 at a time unless asked for 1 to 200.
    listAudit: (tenant, query = {}) =>
      run(() => {
        admin();
        if (!tenant) throw new ApiError(400, "tenant_required");
        const limit = query.limit ?? 50;
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new ApiError(400, "invalid_request");
        const before = query.before;
        if (before !== undefined && !AUDIT_ID.test(before)) throw new ApiError(400, "invalid_request");
        const older = auditOf(tenant).filter((entry) => before === undefined || entry.id < before);
        const entries = older.slice(0, limit);
        const last = entries[entries.length - 1];
        return { tenant, entries, next: older.length > limit && last ? last.id : null, missed: null };
      }),

    // As the API: any tenant, an empty memory for one the team was never told about, every fact (waiting ones
    // included) oldest first, and only the number of forgotten fingerprints.
    getMemory: (tenant) =>
      run(() => {
        admin();
        const shop = memoryTenant(tenant);
        return { tenant: shop, ...shopMemory.exportFacts(memoryOf(shop)) };
      }),

    rememberFact: (input) =>
      run(() => {
        admin();
        const tenant = memoryTenant(input.tenant);
        return changeFact(tenant, "memory.remembered", (state) => shopMemory.remember(state, input.text, now()));
      }),

    confirmFact: (input) =>
      run(() => {
        admin();
        const tenant = memoryTenant(input.tenant);
        const id = memoryFactId(input.id);
        return changeFact(tenant, "memory.confirmed", (state) => shopMemory.confirm(state, id, now()));
      }),

    correctFact: (input) =>
      run(() => {
        admin();
        const tenant = memoryTenant(input.tenant);
        const id = memoryFactId(input.id);
        return changeFact(tenant, "memory.corrected", (state) => shopMemory.correct(state, id, input.text, now()));
      }),

    forgetFact: (input) =>
      run(() => {
        admin();
        const tenant = memoryTenant(input.tenant);
        const id = memoryFactId(input.id);
        const result = shopMemory.forget(memoryOf(tenant), id);
        if (!result.ok) throw new ApiError(MEMORY_STATUS[result.reason], result.reason);
        db.memory[tenant] = result.state;
        audit(tenant, PRACTICE_OPERATOR, "memory.forgotten", { factId: id });
        return { id };
      }),

    // As the API's people routes: the admin key, the shop (400 `tenant_required`, 404 `shop_not_found`), the body's own
    // checks, and then `@manut/people-rules`' rule, whose refusals answer the API's statuses. A change is kept and recorded
    // in the shop's audit log by ids only, never a name or an account's value; a refusal writes nothing.
    getPeople: (tenant) =>
      run(() => {
        admin();
        return peopleList(peopleShop(tenant));
      }),

    createInvite: (input) =>
      run((): CreatedInvite => {
        admin();
        const shop = peopleShop(input.tenant);
        const name = keptName(input.name);
        const identity = keptIdentity(input.identity);
        if (!name || !identity) throw new ApiError(400, "invalid_request");
        const record = peopleOf(shop.tenant);
        db.seq += 1;
        const made = peopleRules.invite(record.state, `inv-${db.seq}`, identity, now());
        if (!made.ok) throw new ApiError(made.refused === "bad_identity" || made.refused === "bad_id" ? 400 : 409, made.refused);
        db.people[shop.tenant] = { ...record, state: made.state, names: { ...record.names, [made.invite.id]: name } };
        audit(shop.tenant, PRACTICE_OPERATOR, "invite.created", { inviteId: made.invite.id });
        return { invite: inviteView(made.invite, name, now()), inviteUrl: inviteLink(made.invite) };
      }),

    revokeInvite: (input) =>
      run(() => {
        admin();
        const shop = peopleShop(input.tenant);
        const inviteId = peopleId(input.inviteId);
        const record = peopleOf(shop.tenant);
        const revoked = peopleRules.revokeInvite(record.state, inviteId);
        if (!revoked.ok) throw new ApiError(revoked.refused === "unknown_invite" ? 404 : 409, revoked.refused);
        db.people[shop.tenant] = { ...record, state: revoked.state };
        audit(shop.tenant, PRACTICE_OPERATOR, "invite.revoked", { inviteId });
        const invite = revoked.state.invites.find((one) => one.id === inviteId)!;
        return { invite: inviteView(invite, record.names[inviteId] ?? "", now()) };
      }),

    removeHelper: (input) =>
      run((): HelperRemoval => {
        admin();
        const shop = peopleShop(input.tenant);
        const helperId = peopleId(input.helperId);
        const record = peopleOf(shop.tenant);
        const removed = peopleRules.removeHelper(record.state, helperId);
        if (!removed.ok) throw new ApiError(404, removed.refused);
        db.people[shop.tenant] = { ...record, state: removed.state };
        audit(shop.tenant, PRACTICE_OPERATOR, "helper.removed", { helperId });
        return { removed: helperId, sessionsEnded: removed.endSessions.length, invitesRevoked: [...removed.revokedInvites],
          coverEnded: removed.coverEnded };
      }),

    // A date the rules can compare, or `bad_date`, as the API answers one it cannot read; then the rule's own `bad_date`
    // for a time that is not in the future, and `not_a_helper` for someone who is not one.
    setAway: (input) =>
      run(() => {
        admin();
        const shop = peopleShop(input.tenant);
        const helperId = peopleId(input.helperId);
        const until = typeof input.until === "string" ? Date.parse(input.until) : Number.NaN;
        if (!Number.isFinite(until)) throw new ApiError(400, "bad_date");
        const record = peopleOf(shop.tenant);
        const set = peopleRules.setAway(record.state, helperId, until, now());
        if (!set.ok) throw new ApiError(set.refused === "not_a_helper" ? 404 : 400, set.refused);
        db.people[shop.tenant] = { ...record, state: set.state };
        audit(shop.tenant, PRACTICE_OPERATOR, "away.set", { helperId });
        return { away: awayView(set.state, set.state.away!, record.names, now()) };
      }),

    // Clearing when nobody covers changes and records nothing, as the API does.
    clearAway: (input) =>
      run((): { away: null } => {
        admin();
        const shop = peopleShop(input.tenant);
        const record = peopleOf(shop.tenant);
        if (record.state.away === null) return { away: null };
        const covering = record.state.away.helperId;
        db.people[shop.tenant] = { ...record, state: peopleRules.clearAway(record.state) };
        audit(shop.tenant, PRACTICE_OPERATOR, "away.cleared", { helperId: covering });
        return { away: null };
      }),

    // As the API's operator routes: the key, then the body's own checks (the shop before the code, so a shop that is not there
    // leaves a code unused), then the code's use, then the link. A code goes the first time it is tried, whatever the answer:
    // the refusal of a second account (409) and a code that ran out (410) use it up as well. Linking the account that is
    // already linked changes and records nothing. A change is recorded by the link's id, never the account.
    linkOwner: (input) =>
      run((): LinkedOwner => {
        admin();
        if (!validTenant(input.tenant)) throw new ApiError(400, "tenant_required");
        if (typeof input.code !== "string") throw new ApiError(400, "invalid_request");
        const shop = peopleShop(input.tenant);
        const typed = typedCode(input.code);
        const found = typed === null ? undefined : db.ownerCodes.find((one) => one.code === typed);
        if (!found) throw new ApiError(404, "unknown_code");
        db.ownerCodes = db.ownerCodes.filter((one) => one !== found);
        if (found.ranOut) throw new ApiError(410, "code_expired");
        const record = peopleOf(shop.tenant);
        const current = record.ownerAccount;
        if (current) {
          if (current.subject !== found.subject) throw new ApiError(409, "already_linked");
          return { tenant: shop.tenant, ownerAccount: { id: current.id, linkedAt: iso(current.linkedAt) } };
        }
        db.seq += 1;
        const ownerAccount: FakeOwnerAccount = { id: `owner-${db.seq}`, subject: found.subject, linkedAt: now() };
        // No app has opened the shop yet, so no device has it.
        db.people[shop.tenant] = { ...record, ownerAccount, ownerDevices: 0 };
        audit(shop.tenant, PRACTICE_OPERATOR, "owner.linked", { ownerAccountId: ownerAccount.id });
        return { tenant: shop.tenant, ownerAccount: { id: ownerAccount.id, linkedAt: iso(ownerAccount.linkedAt) } };
      }),

    // Every session of the account ends in the same step, and the answer says how many.
    unlinkOwner: (input) =>
      run((): UnlinkedOwner => {
        admin();
        const shop = peopleShop(input.tenant);
        const { ownerAccount, ownerDevices, ...rest } = peopleOf(shop.tenant);
        if (!ownerAccount) throw new ApiError(404, "not_linked");
        db.people[shop.tenant] = rest;
        audit(shop.tenant, PRACTICE_OPERATOR, "owner.unlinked", { ownerAccountId: ownerAccount.id });
        return { tenant: shop.tenant, unlinked: ownerAccount.id, sessionsEnded: ownerDevices ?? 0 };
      }),

    // As the API: the tenant, then the month (the current Bangkok month unless one is named), then the settings and the
    // meter. Any tenant reads, as in the API; a shop it never metered has an empty month on the default cap.
    getModelUsage: (tenant, month) =>
      run(() => {
        admin();
        if (!validTenant(tenant)) throw new ApiError(400, "tenant_required");
        if (month !== undefined && !isMonth(month)) throw new ApiError(400, "invalid_request");
        const defaultCapSatang = gatewayDefaultCap(options.modelGateway);
        return usageOf(db.model, tenant, month ?? monthOf(now()), defaultCapSatang);
      }),

    // As the API: the tenant, then a cap that is present and null or whole satang within the limit, then the settings
    // and the meter. The change and its audit entry are written together, and a refusal writes neither. A cap lowered
    // under this month's spend notes the threshold it passed, after the change's own entry, as the API's meter does.
    setModelCap: (input) =>
      run(() => {
        admin();
        const { tenant, capSatang } = input;
        if (!validTenant(tenant)) throw new ApiError(400, "tenant_required");
        if (!isCapValue(capSatang)) throw new ApiError(400, "invalid_request");
        const defaultCapSatang = gatewayDefaultCap(options.modelGateway);
        const month = monthOf(now());
        const crossed = (cap: number) => crossingsOf(db.model, tenant, month, cap).map((crossing) => crossing.percent);
        const before = crossed(capOf(db.model, tenant, defaultCapSatang).capSatang);
        writeCap(db.model, tenant, capSatang, iso(now()));
        if (capSatang === null) {
          audit(tenant, PRACTICE_OPERATOR, "model.cap_cleared", {});
        } else {
          audit(tenant, PRACTICE_OPERATOR, "model.cap_set", {}, "ok", { amountSatang: capSatang });
        }
        const cap = capOf(db.model, tenant, defaultCapSatang);
        for (const percent of crossed(cap.capSatang).filter((one) => !before.includes(one))) {
          audit(tenant, SYSTEM, percent === 100 ? "model.cap_reached" : "model.cap_near", { month }, "ok",
            { amountSatang: cap.capSatang });
        }
        return cap;
      }),

    // As the API: from the record of crossings alone, which no meter setting or meter failure stands in front of. Only
    // the console's shops are listed; a default cap the settings cannot give lists no shop that uses it.
    getModelAlerts: () =>
      run(() => {
        admin();
        let defaultCapSatang = 0;
        try {
          defaultCapSatang = gatewayDefaultCap({ ...options.modelGateway, meterUnavailable: false });
        } catch {
          // A default cap that cannot be read stops every call in the API, so no shop on it crosses anything.
        }
        return alertsOf(db.model, db.shops.map((shop) => shop.tenant), monthOf(now()), defaultCapSatang);
      }),

    // The shop's vault, as the API's admin routes answer it: the admin key, the tenant (400 `tenant_required`, and no check that it
    // is a shop, since the vault answers for any), the body's own checks, and then the vault's own. A change is kept and recorded
    // in the shop's audit log by the record's id only, as the API records it, and a refusal writes nothing. No password and no
    // credential is ever kept: the sample sign-ins have none to keep, and a new credential is made, answered and forgotten.
    listSignIns: (tenant) =>
      run(() => {
        admin();
        return vaultOf(vaultTenant(tenant)).signIns;
      }),

    // The members are checked before the sign-in is looked for, as the vault does, so a bad list is 400 even for a sign-in that
    // is not there. They are kept in the order they were sent, and nothing else about the sign-in changes.
    setSignInMembers: (input) =>
      run((): SignIn => {
        admin();
        const tenant = vaultTenant(input.tenant);
        const members = keptMembers(input.members);
        if (!members) throw new ApiError(400, "invalid_members");
        const signIn = vaultOf(tenant).signIns.find((one) => one.id === input.signInId);
        if (!signIn) throw new ApiError(404, "sign_in_not_found");
        signIn.members = members;
        audit(tenant, PRACTICE_OPERATOR, "signin.members_changed", { signInId: signIn.id });
        return signIn;
      }),

    // Removing a sign-in drops it, as the API's tombstone does for every reader: it is not listed again, and removing it twice
    // is 404.
    removeSignIn: (input) =>
      run((): SignInRemoval => {
        admin();
        const tenant = vaultTenant(input.tenant);
        const vault = db.vault[tenant];
        const signIn = vault?.signIns.find((one) => one.id === input.signInId);
        if (!vault || !signIn) throw new ApiError(404, "sign_in_not_found");
        vault.signIns = vault.signIns.filter((one) => one !== signIn);
        audit(tenant, PRACTICE_OPERATOR, "signin.removed", { signInId: signIn.id });
        return { removed: true, signInId: signIn.id };
      }),

    listOutposts: (tenant) =>
      run(() => {
        admin();
        return vaultOf(vaultTenant(tenant)).outposts.map(outpostView);
      }),

    removeOutpost: (input) =>
      run((): OutpostRemoval => {
        admin();
        const tenant = vaultTenant(input.tenant);
        const vault = db.vault[tenant];
        const outpost = vault?.outposts.find((one) => one.id === input.outpostId);
        if (!vault || !outpost) throw new ApiError(404, "outpost_not_found");
        vault.outposts = vault.outposts.filter((one) => one !== outpost);
        audit(tenant, PRACTICE_OPERATOR, "outpost.removed", { outpostId: outpost.id });
        // The practice world queues no browser step and issues no grant, so nothing was waiting for the outpost.
        return { removed: true, outpostId: outpost.id, stepsRefused: 0, grantsRefused: 0 };
      }),

    // As the API's vault does: the old credential stops working and the outpost sleeps until the holder of the new one beats. The
    // new credential is made here and only here: it goes into the answer and into nothing else, so no saved world, export or log
    // line can hold it.
    replaceOutpostCredential: (input) =>
      run((): OutpostCredential => {
        admin();
        const tenant = vaultTenant(input.tenant);
        const outpost = db.vault[tenant]?.outposts.find((one) => one.id === input.outpostId);
        if (!outpost) throw new ApiError(404, "outpost_not_found");
        outpost.lastHeartbeatAt = null;
        delete outpost.beats;
        audit(tenant, PRACTICE_OPERATOR, "outpost.credential_rotated", { outpostId: outpost.id });
        return { outpost: outpostView(outpost), credential: mintCredential() };
      }),

    // As the API: the tenant, then the page (a size of 1 to 25, ten when absent, and a cursor that is a job's task id), then
    // the shop, then that the cursor is one of its jobs. Newest first; the page after a job is the jobs older than it.
    listWorkerJobs: (tenant, query = {}) =>
      run(() => {
        admin();
        if (!validTenant(tenant)) throw new ApiError(400, "tenant_required");
        const limit = query.limit ?? 10;
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 25) throw new ApiError(400, "invalid_request");
        const { before } = query;
        if (before !== undefined && !WORKER_TASK.test(before)) throw new ApiError(400, "invalid_request");
        if (!db.shops.some((shop) => shop.tenant === tenant)) throw new ApiError(404, "shop_not_found");
        const newest = db.workers.filter((job) => job.tenant === tenant).reverse();
        let start = 0;
        if (before !== undefined) {
          const at = newest.findIndex((job) => job.taskId === before);
          if (at < 0) throw new ApiError(400, "invalid_request");
          start = at + 1;
        }
        const page = newest.slice(start, start + limit);
        const last = page[page.length - 1];
        const more = start + limit < newest.length;
        return {
          tenant,
          jobs: page.map(({ tenant: _tenant, ...job }) => job),
          next: more && last ? last.taskId : null,
        };
      }),

    // Signing in by email, as the API answers it, with practice's one code. The body is checked before the switch, as the
    // API's Worker checks it. A new code replaces the one before, and a wait is whole seconds, rounded up.
    requestEmailCode: (email) =>
      quiet((): EmailCodeSent => {
        const address = typeof email === "string" ? normalizeEmail(email) : null;
        if (!address) throw new ApiError(400, "invalid_request");
        if (signInOff()) throw new ApiError(400, "email_not_configured");
        const at = now();
        const sent = (emailCodes.get(address)?.sent ?? []).filter((time) => at - time < DAY_MS);
        const newest = sent[sent.length - 1];
        if (newest !== undefined && at - newest < RESEND_MS) throw tooManyCodes(newest + RESEND_MS - at);
        if (sent.length >= DAILY_CODES) throw tooManyCodes(sent[0]! + DAY_MS - at);
        emailCodes.set(address, { live: { expiresAt: at + CODE_LIFE_MS, wrong: 0 }, sent: [...sent, at] });
        return { sent: true, expiresIn: CODE_LIFE_MS / 1000, resendIn: RESEND_MS / 1000 };
      }),

    // A code that is not six digits is not a try at all; a wrong one takes a try, and the fifth ends the code; the right one
    // is used up as the session is made, so it signs in once.
    exchangeEmailCode: (input) =>
      quiet((): EmailSignIn => {
        const address = typeof input.email === "string" ? normalizeEmail(input.email) : null;
        const { code, deviceId } = input;
        if (!address || typeof code !== "string" || !isCode(code) || typeof deviceId !== "string" || deviceId.length < 1 ||
          deviceId.length > DEVICE_ID_MAX) {
          throw new ApiError(400, "invalid_request");
        }
        if (signInOff()) throw new ApiError(400, "email_not_configured");
        useCode(address, code);
        tokenSeq += 1;
        const accessToken = `practice-access-${tokenSeq}`;
        signIns.set(accessToken, address);
        return {
          accessToken,
          refreshToken: `practice-refresh-${tokenSeq}`,
          csrf: `practice-csrf-${tokenSeq}`,
          expiresIn: 3600,
          tenant: `email:practice-${tokenSeq}`,
        };
      }),

    // The session first (401 for none), then the body, then the invite: a demo link's answer, a practice invite's by its
    // shop's people, and `unknown` for anything else.
    acceptInvite: (input) =>
      run((): JoinAnswer => {
        const address = signIns.get(input.accessToken);
        if (!address) throw new ApiError(401, "unauthorized");
        if (typeof input.inviteToken !== "string") throw new ApiError(400, "invalid_request");
        const demo = demoJoin(input.inviteToken);
        if (demo) return demo;
        const practice = /^practice-(.+)$/.exec(input.inviteToken);
        return practice?.[1] ? joinPractice(practice[1], address) : { answer: "unknown" };
      }),

    // Ends exactly the one helper session, as the API's sign-out of a device does: it leaves the helper's open sessions and
    // the log says `helper.session_ended`; the helper stays a helper. A token no shop holds is 401.
    endShopSession: async (accessToken) => {
      await run(() => {
        const held = helperSessions.get(accessToken);
        if (!held) throw new ApiError(401, "unauthorized");
        helperSessions.delete(accessToken);
        const record = held.tenant === null ? undefined : db.people[held.tenant];
        if (held.tenant === null || !record) return true;
        const ended = peopleRules.endSession(record.state, held.helperId, held.sessionId);
        if (!ended.ok) return true;
        db.people[held.tenant] = { ...record, state: ended.state };
        audit(held.tenant, { kind: "helper", id: held.helperId }, "helper.session_ended", { helperId: held.helperId });
        return true;
      });
    },

    signOut: async (accessToken) => {
      await quiet(() => {
        if (!signIns.delete(accessToken)) throw new ApiError(401, "invalid_session");
      });
    },

    // The owner's web app (docs/pilot-api.md, "The web app's session"), on its practice world (practiceOwner.ts). The body
    // is read as the API reads it, the code as the join page's is, and a sign-in makes a new world, so practising changes
    // nothing anywhere else.
    webSignIn: async (input) => {
      await quiet(async () => {
        const address = typeof input.email === "string" ? normalizeEmail(input.email) : null;
        if (!address || typeof input.code !== "string" || !isCode(input.code)) throw new ApiError(400, "invalid_request");
        if (signInOff()) throw new ApiError(400, "email_not_configured");
        useCode(address, input.code);
        webSession = { address, world: await practiceOwner(now) };
      });
    },
    webShops: () =>
      quiet((): WebSession => (webSession
        ? { signedIn: true, shops: PRACTICE_SHOPS.map((shop) => ({ ...shop })) }
        : { signedIn: false, emailSignIn: !signInOff() })),
    webApprovals: async (shop, state) => {
      await quiet(() => undefined);
      return webSession ? webSession.world.approvals(shop, state) : { status: 401, body: { error: "session_ended", shop } };
    },
    webDecide: async (input) => {
      await quiet(() => undefined);
      return webSession ? webSession.world.decide(input) : { status: 401, body: { error: "session_ended", shop: input.shop } };
    },
    webSignOut: async () => {
      await quiet(() => {
        webSession = null;
      });
    },
  };

}

/// How each refusal of the package is answered: the API's statuses for the memory routes.
const MEMORY_STATUS: Record<Refusal, number> = {
  invalid_text: 400,
  invalid_source: 400,
  not_found: 404,
  already_known: 409,
  forgotten: 409,
  full: 409,
};

/// A link code as an operator typed it, in the one form it is kept in: capitals, with no spaces or dashes, and with the letters
/// people mistake for digits read as those digits, as Crockford's base 32 reads them. Null when it cannot be a code at all,
/// as the API's reading of it.
function typedCode(value: string): string | null {
  const code = value.toUpperCase().replace(/[\s-]/g, "").replace(/O/g, "0").replace(/[IL]/g, "1");
  return /^[0-9A-HJKMNP-TV-Z]{8}$/.test(code) ? code : null;
}

/// The id the API gives a shop's owner in the rules' state: in the pilot the owner has no account.
const OWNER_ID = "owner";

/// The longest name the owner may give a helper, in characters after outer spaces are trimmed, as the API keeps it.
const MAX_NAME = 80;
/// The longest id, name or account the API's record keeps.
const MAX_FIELD = 256;

/// A name as a person reads it, by the API's rule: no outer spaces, 1 to 80 characters, composed the same way whatever the
/// keyboard, and no control character, so a name can never break a line in the console or a log. Null for anything else.
function keptName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const name = value.normalize("NFC").trim();
  return name.length > 0 && [...name].length <= MAX_NAME && !/\p{Cc}/u.test(name) ? name : null;
}

/// The identity as the API keeps it: only the fields its kind has, an email without outer spaces (its case kept, and
/// compared without it) and a LINE account id exactly. Null for what is not an identity at all; one of the right shape with
/// a value the rules refuse (an empty id, an address with no `@`) is left for them to refuse.
function keptIdentity(value: unknown): Identity | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const identity = value as Record<string, unknown>;
  if (identity.kind === "line" && typeof identity.id === "string" && identity.id.length <= MAX_FIELD) {
    return { kind: "line", id: identity.id };
  }
  if (identity.kind === "email" && typeof identity.address === "string" && identity.address.length <= MAX_FIELD) {
    return { kind: "email", address: identity.address.trim() };
  }
  return null;
}

/// Who the fake's log names. Practice actions come from the practice key, which has no Access identity: the API
/// records such an operator as `email: null`, as it records a service token.
const PRACTICE_OPERATOR: AuditActor = { kind: "operator", email: null };
const OWNER: AuditActor = { kind: "owner" };
const SYSTEM: AuditActor = { kind: "system" };

/// The API's entry ids: a base-36 millisecond clock, a sequence and a random tail, so ids sort by time and page with
/// the same cursor the API takes.
const AUDIT_ID = /^aud-[0-9a-z]{9}-[0-9a-z]{3}-[0-9a-f]{8}$/;

/// The ids the API gives a worker job's task, which are also all a page's cursor may be.
const WORKER_TASK = /^worker-task-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function auditId(ms: number, seq: number): string {
  return sortableId("aud", ms, seq);
}

/// A prefix, a base-36 millisecond clock, a sequence and a random tail, so ids sort by time. The meter's call ids
/// (`call-…`) are made the same way.
function sortableId(prefix: string, ms: number, seq: number): string {
  const tail = new Uint8Array(4);
  crypto.getRandomValues(tail);
  const hex = [...tail].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${prefix}-${ms.toString(36).padStart(9, "0")}-${(seq % 46656).toString(36).padStart(3, "0")}-${hex}`;
}

/// LINE's `x-line-signature`: base64 HMAC-SHA256 of the raw body under the channel secret.
export async function lineSignature(channelSecret: string, rawBody: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(channelSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(rawBody)));
  let binary = "";
  for (const byte of mac) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function randomToken(size = 24): string {
  const bytes = new Uint8Array(size);
  crypto.getRandomValues(bytes);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/// A credential as the API's vault mints one for an outpost: `mo1_` and 32 random bytes in base64url, which is 43 characters.
function mintCredential(): string {
  return `mo1_${randomToken(32)}`;
}

/// Who may use a sign-in, by the vault's rule: one or more of `SIGN_IN_MEMBERS`, none twice. Null for anything else, a list of the
/// wrong kind included. The members are kept in the order they were sent.
function keptMembers(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > SIGN_IN_MEMBERS.length) return null;
  if (!value.every((member): member is string => typeof member === "string" && SIGN_IN_MEMBERS.includes(member))) return null;
  return new Set(value).size === value.length ? [...value] : null;
}

function seed(at: number): FakeDb {
  const ago = (minutes: number) => new Date(at - minutes * MINUTE_MS).toISOString();
  const later = (minutes: number) => new Date(at + minutes * MINUTE_MS).toISOString();
  const tenant = "shop_baanmali";
  const connectionId = "line_baanmali";
  const message = (
    id: string,
    minutesAgo: number,
    lineUserId: string,
    text: string,
    displayName?: string,
  ): FakeMessage => {
    const m: FakeMessage = { id, tenant, connectionId, lineUserId, text, receivedAt: ago(minutesAgo) };
    if (displayName) m.displayName = displayName;
    return m;
  };
  const action = (
    id: string,
    messageId: string,
    token: string,
    replyText: string,
    proposedMinutesAgo: number,
    state: ApprovalState,
    outcome: Outcome,
    decidedMinutesAgo?: number,
    shop: string = tenant,
  ): FakeAction => {
    const a: FakeAction = {
      tenant: shop,
      taskId: `task_${shop}`,
      actionId: id,
      messageId,
      replyText,
      state,
      proposedAt: ago(proposedMinutesAgo),
      token,
      // The seeded links stay open for a day from now, so the demo links keep working.
      expiresAt: later(24 * 60),
      outcome,
    };
    if (decidedMinutesAgo !== undefined) {
      a.decidedAt = ago(decidedMinutesAgo);
      if (state === "confirmed") a.dispatchedAt = ago(decidedMinutesAgo);
    }
    return a;
  };

  const messages: FakeMessage[] = [
    message("msg_ploy", 12, "Uploy", "สวัสดีค่ะ สั่งเทียนหอมไปตั้งแต่วันพุธ ยังไม่ได้รับของเลยค่ะ", "Khun Ploy"),
    message("msg_arthit", 25, "Uarthit", "เทียนที่ได้รับมาแตกครับ ขอคืนเงินได้ไหมครับ ออเดอร์ SP-2291", "Khun Arthit"),
    message("msg_nok", 48, "Unok", "Hi, my order SP-2296 still says preparing. Will it ship this week?", "Khun Nok"),
    message("msg_tracking", 75, "Uanon", "ขอเลขพัสดุหน่อยค่ะ สั่งเซ็ตของขวัญไป 3 วันแล้ว"),
    message("msg_mai", 300, "Umai", "ได้รับของแล้วค่ะ หอมมาก ขอบคุณค่ะ", "Khun Mai"),
    message("msg_fah", 420, "Ufah", "ถ้าซื้อ 5 เซ็ต ลด 20% ได้ไหมคะ", "Khun Fah"),
    message("msg_joy", 1330, "Ujoy", "ร้านเปิดกี่โมงคะ", "Khun Joy"),
  ];
  const actions: FakeAction[] = [
    action(
      "act_ploy",
      "msg_ploy",
      DEMO_TOKENS.waiting,
      "ขออภัยที่พัสดุล่าช้านะคะ ตอนนี้ของออกจากคลังแล้ว คาดว่าจะถึงภายในวันอังคารค่ะ",
      10,
      "proposed",
      "confirmed",
    ),
    action(
      "act_nok",
      "msg_nok",
      DEMO_TOKENS.failed,
      "Sorry for the wait, Khun Nok. Your order ships tomorrow morning and should reach you by Tuesday.",
      40,
      "proposed",
      "failed",
    ),
    action(
      "act_tracking",
      "msg_tracking",
      DEMO_TOKENS.unknown,
      "ขออภัยที่รอนานนะคะ ของออกจากคลังเมื่อเช้านี้ค่ะ จะส่งเลขพัสดุให้ภายในวันนี้นะคะ",
      70,
      "proposed",
      "unknown",
    ),
    action("act_mai", "msg_mai", DEMO_TOKENS.sent, "ขอบคุณมากนะคะ ดีใจที่ชอบกลิ่นนี้ค่ะ", 290, "confirmed", "confirmed", 282),
    action("act_fah", "msg_fah", DEMO_TOKENS.declined, "ได้เลยค่ะ ลด 20% ให้นะคะ", 410, "rejected", "confirmed", 395),
    action("act_joy", "msg_joy", DEMO_TOKENS.expiredRequest, "ร้านเปิดทุกวัน 10:00 ถึง 19:00 ค่ะ", 1320, "expired", "confirmed"),
  ];

  // The words the owner's page has to hold on a small screen, each in a shop of its own that the console never lists, so
  // the console's counts (seven messages for Baan Mali) and what a link does for one shop never touch the others. Each is
  // a reply that waits for the owner, as /approve/demo does, and each shop has not given its one-time permission yet.
  // A long Thai message and reply: Thai has no spaces between words, so the page must break it where a reader would.
  const thaiShop = "shop_demo_long_thai";
  const thaiMessage = "demo_msg_long_thai";
  // A long order id and a long link: strings with no place to break, in the customer's message, in the reply and in the
  // customer's name, as LINE names and tracking links often are.
  const linkShop = "shop_demo_long_link";
  const linkMessage = "demo_msg_long_link";
  const orderId = "SP-2291-WEB-20261124-0042-BKK-TH-PRIORITY-EXPRESS-000000123456789";
  const trackingLink =
    "https://tracking.example.com/track?number=TH0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ&lang=th&ref=baan-mali-order-confirmation-2026-11-24";
  const demoShops: FakeShop[] = [
    {
      tenant: thaiShop,
      name: "ร้านเทียนหอมและน้ำมันหอมระเหยบ้านสวนมะลิ สาขาเชียงใหม่ ถนนนิมมานเหมินท์",
      ownerName: "Fon",
      consent: false,
    },
    { tenant: linkShop, name: "Baan Suan Mali Natural Candles and Essential Oils, Chiang Mai", ownerName: "Fon", consent: false },
  ];
  messages.push(
    {
      id: thaiMessage,
      tenant: thaiShop,
      connectionId: "line_demo",
      lineUserId: "Udemothai",
      displayName: "ศิริพรรณเจริญสุขสวัสดิ์",
      receivedAt: ago(15),
      text:
        "สวัสดีค่ะ ขอโทษที่รบกวนนะคะ ดิฉันสั่งเทียนหอมกลิ่นลาเวนเดอร์กับกลิ่นมะลิเป็นชุดของขวัญไว้ 3 ชุดตั้งแต่วันพุธที่ผ่านมา " +
        "(ออเดอร์ SP-2291) ตอนนี้ผ่านมา 5 วันแล้วแต่ยังไม่ได้รับของเลยค่ะ ในแอปขึ้นว่ากำลังเตรียมจัดส่ง " +
        "แต่ต้องใช้ของขวัญนี้ในงานแต่งงานของเพื่อนวันเสาร์นี้ ไม่ทราบว่าจะทันไหมคะ\n\n" +
        "รบกวนช่วยตรวจสอบและแจ้งเลขพัสดุให้ด้วยนะคะ ถ้าไม่ทันดิฉันขอยกเลิกและขอเงินคืนทั้งหมดค่ะ เบอร์ติดต่อ 081-234-5678 ขอบคุณมากค่ะ",
    },
    {
      id: linkMessage,
      tenant: linkShop,
      connectionId: "line_demo",
      lineUserId: "Udemolink",
      displayName: "Khun_Wichai_Chaiyaphum_01",
      receivedAt: ago(20),
      text:
        `ออเดอร์ ${orderId} ยังไม่ได้รับของเลยค่ะ ลองเช็คตามลิงก์นี้แล้วขึ้นว่าไม่พบข้อมูล ${trackingLink.replace("number=", "order=")}`,
    },
  );
  actions.push(
    action(
      "act_demo_long_thai",
      thaiMessage,
      DEMO_TOKENS.longThai,
      "สวัสดีค่ะ คุณศิริพรรณ ขออภัยอย่างยิ่งที่ทำให้ต้องรอนานนะคะ ทางร้านตรวจสอบออเดอร์ SP-2291 แล้ว " +
        "พัสดุออกจากคลังเมื่อเช้านี้และอยู่ระหว่างการขนส่ง คาดว่าจะถึงมือคุณภายในวันศุกร์ ก่อนงานวันเสาร์แน่นอนค่ะ\n\n" +
        "ทางร้านจะส่งเลขพัสดุให้ทาง LINE ภายในวันนี้ และถ้าถึงเช้าวันเสาร์แล้วยังไม่ได้รับของ รบกวนแจ้งทางร้านได้ทันที " +
        "ทางร้านจะส่งชุดใหม่ด่วนให้ฟรีค่ะ ขอบคุณที่รอและขออภัยอีกครั้งนะคะ",
      14,
      "proposed",
      "confirmed",
      undefined,
      thaiShop,
    ),
    action(
      "act_demo_long_link",
      linkMessage,
      DEMO_TOKENS.longLink,
      `ขอบคุณที่แจ้งค่ะ ลองติดตามพัสดุของออเดอร์ ${orderId} ได้ที่ลิงก์นี้นะคะ ${trackingLink} ` +
        "ถ้ายังไม่พบข้อมูล ทางร้านจะตรวจสอบกับขนส่งให้อีกครั้งค่ะ",
      19,
      "proposed",
      "confirmed",
      undefined,
      linkShop,
    ),
  );
  for (const a of actions) {
    const m = messages.find((x) => x.id === a.messageId);
    if (m) m.replyActionId = a.actionId;
  }

  // The deletion page's demo links, each about its own copy of Khao Soi Nimman, a shop that is not on the console's
  // list. Each copy has the deletion record its state needs, so answering one never changes another. One is about a shop
  // with a long Thai name and counts in the millions, which the page has to fit on a small screen at a larger text size.
  const goes: DeletionGoes = { messages: 12, replies: 9, payments: 3, lineConnected: true };
  const longName = "ร้านขนมไทยโบราณและเครื่องแกงสดบ้านคุณยายสมศรี สาขาเชียงใหม่ ถนนนิมมานเหมินท์ ซอย 9";
  const bigGoes: DeletionGoes = { messages: 1_234_567, replies: 98_765, payments: 4_321, lineConnected: true };
  const demo = (
    key: keyof typeof DEMO_DELETION_TOKENS,
    state: Pick<FakeConfirmation, "status" | "approved" | "decidedAt">,
    deletedAt?: string,
    shop: { name: string; goes: DeletionGoes } = { name: "Khao Soi Nimman", goes },
  ) => {
    const tenant = `shop_khaosoi_${key}`;
    const confirmation: FakeConfirmation = {
      id: `del_${key}`,
      tenant,
      token: DEMO_DELETION_TOKENS[key],
      shopName: shop.name,
      goes: shop.goes,
      expiresAt: later(24 * 60),
      ...state,
    };
    const record: FakeDeletionRecord = {
      tenant,
      name: shop.name,
      requestedAt: ago(30),
      deletedBy: null,
      confirmationId: confirmation.id,
      ...(deletedAt ? { deletedAt } : {}),
    };
    return { confirmation, record };
  };
  const demos = [
    demo("waiting", { status: "pending" }),
    demo("deleting", { status: "decided", approved: true, decidedAt: ago(20) }),
    demo("deleted", { status: "decided", approved: true, decidedAt: ago(20) }, ago(20)),
    demo("kept", { status: "decided", approved: false, decidedAt: ago(20) }),
    demo("unanswered", { status: "withdrawn" }),
    demo("longName", { status: "pending" }, undefined, { name: longName, goes: bigGoes }),
  ];

  return {
    version: 12,
    seq: 100,
    demoShops,
    shops: [
      // Connected 13 days ago, so today is day 14 of its trial, and Fon's answers this morning make it active.
      {
        tenant,
        name: "Baan Mali",
        ownerName: "Fon",
        lineConnectionId: connectionId,
        consent: false,
        trialStartedAt: ago(13 * 24 * 60),
      },
      { tenant: "shop_sabaitea", name: "Sabai Tea", ownerName: "Dao", consent: false },
    ],
    connections: [
      {
        connectionId,
        tenant,
        channelId: "2001234567",
        botUserId: "Ubaanmalibot",
        channelSecret: PRACTICE_CHANNEL_SECRET,
      },
    ],
    messages,
    actions,
    payments: [
      {
        id: "pay_2288",
        tenant,
        orderRef: "SP-2288",
        amountSatang: 45000,
        promptPayId: "0812345678",
        confirmedAt: ago(1500),
      },
      {
        id: "pay_2301",
        tenant,
        orderRef: "SP-2301",
        amountSatang: 129000,
        promptPayId: "0812345678",
        slipNote: "Slip time 14:02, seen in the shop's bank app",
        confirmedAt: ago(120),
      },
    ],
    subscriptionPayments: [],
    deletions: demos.map((entry) => entry.record),
    confirmations: demos.map((entry) => entry.confirmation),
    expiredTokens: [DEMO_TOKENS.expiredLink, DEMO_DELETION_TOKENS.expiredLink],
    audit: sampleAudit(at, tenant, connectionId),
    memory: { [tenant]: sampleMemory(at) },
    people: { [tenant]: samplePeople(at, tenant) },
    ownerCodes: sampleOwnerCodes(),
    model: seedModel(at, tenant),
    workers: sampleWorkers(at, tenant),
    vault: { [tenant]: sampleVault(at) },
  };
}

/// Baan Mali's model spend as the meter would have kept it: 50 calls spread across the Bangkok month `at` falls in, ฿186.00
/// in all, against the ฿300 cap an operator set five days ago, and one more call still in progress. Each kind of call is
/// priced at ฿35 a dollar by docs/model-gateway.md's table and rounded up once per call: a Sonnet 5.5 reply of 2,800
/// tokens in and 560 out is 39,200 millisatang. Spreading the calls from the month's first moment to `at` keeps them in
/// the current month whatever day the practice world is made.
function seedModel(at: number, tenant: string): FakeModel {
  const monthStart = Date.parse(`${monthOf(at)}-01T00:00:00+07:00`);
  // Per kind: model, tokens in, tokens out, millisatang each, how many, and how it ended.
  const kinds: [string, number, number, number, number, string][] = [
    ["claude-opus-5-5", 52_000, 5_200, 1_092_000, 6, "ok"], // the week's plan
    ["claude-opus-5-5", 31_000, 2_900, 637_000, 12, "ok"], // the research behind a reply
    ["claude-opus-5-5", 18_000, 1_200, 336_000, 11, "ok"], // an order looked up
    ["claude-sonnet-5-5", 2_800, 560, 39_200, 18, "ok"], // a reply drafted
    ["claude-haiku-5-5", 1_400, 250, 928, 2, "ok"], // a message sorted
    ["claude-haiku-5-5", 0, 0, 0, 1, "failed"], // the provider failed, so nothing was charged
  ];
  const rows = kinds.flatMap(([model, inputTokens, outputTokens, millisatang, count, outcome]) =>
    Array.from({ length: count }, () => ({ model, inputTokens, outputTokens, millisatang, outcome })));
  // A fixed shuffle mixes the kinds without a random number: 31 and 50 share no factor, so it visits every row once.
  const calls = rows.map((_, i) => {
    const row = rows[(i * 31) % rows.length]!;
    const when = monthStart + Math.floor(((at - monthStart) * (i + 1)) / (rows.length + 1));
    return {
      tenant,
      id: sortableId("call", when, i),
      at: new Date(when).toISOString(),
      model: row.model,
      inputTokens: row.inputTokens,
      outputTokens: row.outputTokens,
      millisatang: row.millisatang,
      satang: ceilSatang(row.millisatang),
      outcome: row.outcome,
    };
  });
  // A Sonnet reply asked for a minute ago: its worst case is held, 3,400 tokens in and 1,000 out at the table's price.
  const heldAt = at - MINUTE_MS;
  return {
    overrides: [{ tenant, capSatang: 30_000, setAt: new Date(at - 5 * DAY_MS).toISOString(), setBy: "ops@manut.test" }],
    calls,
    holds: [{
      tenant,
      callId: sortableId("call", heldAt, rows.length),
      model: "claude-sonnet-5-5",
      worstMillisatang: 58_800,
      at: new Date(heldAt).toISOString(),
      expiresAt: new Date(heldAt + 15 * MINUTE_MS).toISOString(),
    }],
  };
}

/// Baan Mali's audit log as its sample world would have written it, oldest first, and Sabai Tea's one entry. The
/// times match the sample's own: the shop and its LINE account 13 days ago, then each payment, reply and decision.
function sampleAudit(at: number, tenant: string, connectionId: string): FakeAuditEntry[] {
  const operator: AuditActor = { kind: "operator", email: null };
  // The operator who set Baan Mali's cap was signed in through Access, so the log names them.
  const named: AuditActor = { kind: "operator", email: "ops@manut.test" };
  const owner: AuditActor = { kind: "owner" };
  const system: AuditActor = { kind: "system" };
  const taskId = `task_${tenant}`;
  let seq = 0;
  const entry = (shop: string, minutesAgo: number, actor: AuditActor, action: string, subject: Record<string, string>,
    outcome = "ok", amountSatang?: number, reason?: string): FakeAuditEntry => {
    const ms = at - minutesAgo * MINUTE_MS;
    seq += 1;
    return { tenant: shop, id: auditId(ms, seq), at: new Date(ms).toISOString(), actor, action, subject, outcome,
      ...(reason !== undefined ? { reason } : {}), ...(amountSatang !== undefined ? { amountSatang } : {}) };
  };
  const helper: AuditActor = { kind: "helper", id: "helper-mint" };
  const fon: AuditActor = { kind: "owner", id: SAMPLE_OWNER_ACCOUNT };
  const reply = (actionId: string, messageId: string) => ({ taskId, actionId, messageId });
  const decided = (actionId: string) => ({ taskId, actionId });
  const earlier = [
    entry(tenant, 13 * 24 * 60 + 30, operator, "shop.created", {}),
    entry(tenant, 13 * 24 * 60, operator, "line.connected", { connectionId }),
    entry(tenant, 5 * 24 * 60, named, "model.cap_set", {}, "ok", 30000),
    entry("shop_sabaitea", 2 * 24 * 60, operator, "shop.created", {}),
    // What the team learned about the shop, by the ids of the facts in `sampleMemory`.
    entry(tenant, 12 * 24 * 60, operator, "memory.remembered", { factId: "f1" }),
    entry(tenant, 11 * 24 * 60, system, "memory.proposed", { factId: "f2" }),
    entry(tenant, 6 * 24 * 60, system, "memory.proposed", { factId: "f3" }),
    entry(tenant, 3 * 24 * 60, system, "memory.proposed", { factId: "f4" }),
    entry(tenant, 2 * 24 * 60, system, "memory.proposed", { factId: "f5" }),
    entry(tenant, 1500, operator, "payment.recorded", { paymentId: "pay_2288" }, "ok", 45000),
    entry(tenant, 1320, operator, "reply.proposed", reply("act_joy", "msg_joy")),
    entry(tenant, 410, operator, "reply.proposed", reply("act_fah", "msg_fah")),
    entry(tenant, 395, owner, "reply.decided", decided("act_fah"), "declined"),
    entry(tenant, 290, operator, "reply.proposed", reply("act_mai", "msg_mai")),
    entry(tenant, 282, owner, "reply.decided", decided("act_mai"), "approved"),
    entry(tenant, 282, system, "dispatch.started", decided("act_mai")),
    entry(tenant, 282, system, "dispatch.settled", decided("act_mai"), "confirmed"),
    entry(tenant, 120, operator, "payment.recorded", { paymentId: "pay_2301" }, "ok", 129000),
    entry(tenant, 90, system, "memory.proposed", { factId: "f6" }, "awaiting_owner"),
    entry(tenant, 50, system, "memory.proposed", { factId: "f7" }, "awaiting_owner"),
    // What the people of `samplePeople` did, by ids only: Mint invited and joined ten days ago, opened the shop on a second
    // device, was set to cover yesterday, passed a note on this morning, and Beam was invited two hours ago.
    entry(tenant, 10 * 24 * 60, operator, "invite.created", { inviteId: "inv-mint" }),
    entry(tenant, 10 * 24 * 60 - 5, helper, "helper.joined", { inviteId: "inv-mint", helperId: "helper-mint" }),
    entry(tenant, 2 * 24 * 60, helper, "helper.session_opened", { helperId: "helper-mint" }),
    entry(tenant, 24 * 60, operator, "away.set", { helperId: "helper-mint" }),
    entry(tenant, 180, helper, "request.passed_on", { requestId: "req_refund", taskId }),
    entry(tenant, 120, operator, "invite.created", { inviteId: "inv-beam" }),
    // What the owner's account of `samplePeople` did, by the link's id only: the operator linked it eleven days ago, and the
    // owner's app opened the shop on two devices.
    entry(tenant, 11 * 24 * 60, operator, "owner.linked", { ownerAccountId: SAMPLE_OWNER_ACCOUNT }),
    entry(tenant, 11 * 24 * 60 - 4, fon, "owner.session_opened", { ownerAccountId: SAMPLE_OWNER_ACCOUNT }),
    entry(tenant, 3 * 24 * 60, fon, "owner.session_opened", { ownerAccountId: SAMPLE_OWNER_ACCOUNT }),
    entry(tenant, 70, operator, "reply.proposed", reply("act_tracking", "msg_tracking")),
    entry(tenant, 40, operator, "reply.proposed", reply("act_nok", "msg_nok")),
    entry(tenant, 10, operator, "reply.proposed", reply("act_ploy", "msg_ploy")),
  ];

  // What this week's API added, so every word for it can be seen without an API. Who acts in it: Fon from her linked account and,
  // for two changes, from the shop's own session; Mint on devices that came and went; Ice, a helper Fon has since removed; an
  // outpost on each machine; and a worker's attempt for each job. The ids are the ones `samplePeople` and the sample vault name.
  const ownSession: AuditActor = { kind: "owner", id: "owner-session" };
  const ice: AuditActor = { kind: "helper", id: "helper-ice" };
  const mac: AuditActor = { kind: "outpost", id: SAMPLE_MAC_OUTPOST };
  const worker = (n: number): AuditActor => ({ kind: "worker", attemptId: sampleUuid(n) });
  const said = (minutesAgo: number, actor: AuditActor, action: string, subject: Record<string, string>, outcome = "ok",
    reason?: string) => entry(tenant, minutesAgo, actor, action, subject, outcome, undefined, reason);
  const day = 24 * 60;

  // The owner's own changes (docs/several-shops.md, slice 4), beside an operator's, and the devices they sign in on.
  const ownerChanges = [
    // Fon invited Tum from her own app and cancelled the invite three minutes later.
    said(9 * day, fon, "invite.created", { inviteId: "inv-tum" }),
    said(9 * day - 3, fon, "invite.revoked", { inviteId: "inv-tum" }),
    // An operator invited Ice on Fon's word. Ice joined half an hour later and was set to cover from the shop's own session six
    // days ago; Fon ended that cover and then removed Ice five days ago.
    said(8 * day, named, "invite.created", { inviteId: "inv-ice" }),
    said(8 * day - 30, ice, "helper.joined", { inviteId: "inv-ice", helperId: "helper-ice" }),
    said(6 * day, ownSession, "away.set", { helperId: "helper-ice" }),
    said(5 * day + 60, fon, "away.cleared", { helperId: "helper-ice" }),
    said(5 * day, fon, "helper.removed", { helperId: "helper-ice" }),
    // Fon allowed cloud work from her app twelve days ago and the shop's own session withdrew it two days ago: it is off now.
    said(12 * day - 20, fon, "consent.given", {}),
    said(2 * day + 30, ownSession, "consent.withdrawn", {}),
    // A device of Mint's and one of Fon's each signed in and out again; the devices still open are the ones `samplePeople` counts.
    said(4 * day, helper, "helper.session_opened", { helperId: "helper-mint" }),
    said(4 * day - 20, helper, "helper.session_ended", { helperId: "helper-mint" }),
    said(6 * day + 90, fon, "owner.session_opened", { ownerAccountId: SAMPLE_OWNER_ACCOUNT }),
    said(6 * day, fon, "owner.session_ended", { ownerAccountId: SAMPLE_OWNER_ACCOUNT }),
  ];

  // Browser control: the vault's sign-in, an operator's cloud outpost, Fon registering her own Mac and then renaming it, an old Mac
  // removed, the vault sealed again after a key rotation, and one sign-in's story: the site refused the saved password, the worker
  // said so, and Fon typed a new one.
  const signIn = SAMPLE_SIGN_IN;
  const grant = { taskId: "task_signin", attemptId: sampleUuid(7), signInId: signIn, grantId: "grant_1" };
  const signInStep = { stepId: "step_signin", outpostId: SAMPLE_MAC_OUTPOST, ...grant };
  const browserControl = [
    said(9 * day - 10, named, "signin.created", { signInId: signIn }),
    said(9 * day - 20, named, "outpost.registered", { outpostId: SAMPLE_CLOUD_OUTPOST }),
    said(2 * day - 40, fon, "outpost.registered", { outpostId: SAMPLE_MAC_OUTPOST }),
    // From Customize > Connections, Fon renamed her Mac's outpost; the log keeps its id, never the name she typed. An old Mac the
    // shop's own session registered eight days ago was removed from there yesterday.
    said(2 * day - 45, fon, "outpost.renamed", { outpostId: SAMPLE_MAC_OUTPOST }),
    said(8 * day, ownSession, "outpost.registered", { outpostId: SAMPLE_OLD_OUTPOST }),
    said(day + 50, ownSession, "outpost.removed", { outpostId: SAMPLE_OLD_OUTPOST }),
    said(day + 40, named, "vault.resealed", {}),
    said(1100, worker(7), "signin.requested", { ...grant, outpostId: SAMPLE_MAC_OUTPOST }),
    said(1099.5, worker(7), "browser_step.queued", signInStep),
    said(1099, mac, "browser_step.fetched", signInStep),
    said(1098.8, mac, "signin.redeemed", { ...grant, outpostId: SAMPLE_MAC_OUTPOST }),
    said(1098.5, mac, "browser_step.reported", signInStep, "failed", "sign_in_refused"),
    said(1098, worker(7), "signin.broken", { taskId: grant.taskId, attemptId: grant.attemptId, signInId: signIn }),
    // Fon typed the new password herself, from Customize > Connections.
    said(1050, fon, "signin.password_replaced", { signInId: signIn }),
  ];

  // The second sign-in of `sampleVault`, a carrier's portal Fon added from her Connections three days ago. Two days ago a worker asked
  // to sign in, the older Mac (since removed, and so not in the vault) typed the saved password, the site refused it, and the worker
  // said so. Nobody has typed a new one, so the sign-in is still broken. It is older than the first sign-in's story, so that one is
  // still the newest in the log.
  const oldMac: AuditActor = { kind: "outpost", id: SAMPLE_OLD_OUTPOST };
  const carrier = SAMPLE_CARRIER_SIGN_IN;
  const carrierGrant = { taskId: "task_carrier", attemptId: sampleUuid(8), signInId: carrier, grantId: "grant_2" };
  const carrierStep = { stepId: "step_carrier", outpostId: SAMPLE_OLD_OUTPOST, ...carrierGrant };
  const carrierStory = [
    said(3 * day, fon, "signin.created", { signInId: carrier }),
    said(2 * day, worker(8), "signin.requested", { ...carrierGrant, outpostId: SAMPLE_OLD_OUTPOST }),
    said(2 * day - 0.5, worker(8), "browser_step.queued", carrierStep),
    said(2 * day - 1, oldMac, "browser_step.fetched", carrierStep),
    said(2 * day - 1.2, oldMac, "signin.redeemed", { ...carrierGrant, outpostId: SAMPLE_OLD_OUTPOST }),
    said(2 * day - 1.5, oldMac, "browser_step.reported", carrierStep, "failed", "sign_in_refused"),
    said(2 * day - 2, worker(8), "signin.broken", { taskId: carrierGrant.taskId, attemptId: carrierGrant.attemptId, signInId: carrier }),
  ];

  // Browser writes (docs/pilot-api.md, "Submitting through a browser"), each told as the API writes it: the worker's ask, the
  // decision, the step queued, the write begun as the outpost takes it, and how it settled. Each ends its own way.
  const writeStory = (n: number, minutesAgo: number, decider: AuditActor,
    ending: { fetched: "ok" | "payload_changed"; report?: string; settled?: string }) => {
    const ids = { taskId: `task_write_${n}`, attemptId: sampleUuid(n), signInId: signIn };
    const request = { requestId: `req_form_${n}`, actionId: `req_form_${n}` };
    const step = { stepId: `step_form_${n}`, outpostId: SAMPLE_MAC_OUTPOST, ...ids, ...request };
    const write = { taskId: ids.taskId, actionId: request.actionId };
    const told = [
      said(minutesAgo, worker(n), "approval.requested", { ...ids, ...request }),
      said(minutesAgo - 2, decider, "approval.decided", { taskId: ids.taskId, attemptId: ids.attemptId, ...request }, "approved"),
      said(minutesAgo - 2.5, worker(n), "browser_step.queued", step),
      said(minutesAgo - 3, system, "dispatch.started", write),
    ];
    if (ending.fetched === "ok") {
      told.push(said(minutesAgo - 3.1, mac, "browser_step.fetched", step),
        said(minutesAgo - 3.5, mac, "browser_step.reported", step, "failed", ending.report),
        said(minutesAgo - 3.6, system, "dispatch.settled", write, ending.settled));
    } else {
      // The begin gate found the approved write no longer matched what would be submitted: the write failed, and the outpost
      // was refused the step.
      told.push(said(minutesAgo - 3.05, system, "dispatch.settled", write, "failed"),
        said(minutesAgo - 3.1, mac, "browser_step.fetched", step, "refused", "payload_changed"));
    }
    return told;
  };
  const writes = [
    // The site refused the form and kept it, so nothing changed.
    ...writeStory(1, 400, fon, { fetched: "ok", report: "submit_refused", settled: "failed" }),
    // A reply may be approved by a helper; the outpost did not run the step at all.
    ...writeStory(2, 330, helper, { fetched: "ok", report: "not_run", settled: "failed" }),
    // The step took too long, so nobody can say the site did not take it.
    ...writeStory(3, 200, fon, { fetched: "ok", report: "timed_out", settled: "unknown" }),
    // What was approved no longer matched what would have been submitted.
    ...writeStory(4, 150, fon, { fetched: "payload_changed" }),
    // Asks that opened no request: it was another member's job, and a job in practice mode keeps a draft.
    said(180, worker(5), "approval.requested", { taskId: "task_write_5", attemptId: sampleUuid(5), signInId: signIn }, "refused",
      "not_my_job"),
    said(100, worker(6), "approval.requested", { taskId: "task_write_6", attemptId: sampleUuid(6), signInId: signIn }, "skipped",
      "draft_only"),
  ];

  return [...earlier, ...ownerChanges, ...browserControl, ...carrierStory, ...writes];
}

/// Ids the API makes as UUIDs, written so that their first eight characters, which the console shows, tell one from another.
const sampleUuid = (n: number) => `${(0x6f9d1f00 + n).toString(16)}-9a7e-4a53-9a0b-2f5c1d1f7c11`;
/// The outposts of Baan Mali's sample vault: Fon's own Mac, registered from her desktop app, and a cloud outpost an operator made.
const SAMPLE_MAC_OUTPOST = "b4c8d1e2-5f60-4a71-8b92-0c3d4e5f6a7b";
const SAMPLE_CLOUD_OUTPOST = "c0a1d2e3-7a81-4b92-9c03-1d2e3f4a5b6c";
/// An older Mac of Fon's, registered from the shop's own session and since removed.
const SAMPLE_OLD_OUTPOST = "d3e4f5a6-8b92-4c03-8d14-2e3f4a5b6c7d";
/// The first site sign-in in the sample vault, whose members' forms the sample writes submit.
const SAMPLE_SIGN_IN = "5d0e7c3a-2b41-4f6e-9a1d-7e8f9a0b1c2d";
/// The second: a carrier's portal Fon added, whose password the site refused and which nobody has mended.
const SAMPLE_CARRIER_SIGN_IN = "8a1b4c6d-3e52-4f70-b8c9-0d1e2f3a4b5c";

/// Baan Mali's vault as its sample world would have kept it, by the ids `sampleAudit` tells the story of. Shopee Seller Centre broke
/// about eighteen hours ago, the worker said so, and Fon typed a new password, so it works again. A carrier's portal Fon added three days ago
/// broke two days ago, and nobody has typed it a new password, so it is still broken. Fon's Mac is awake and beats, so it reads
/// online; the cloud outpost an operator made has never beaten. An older Mac of Fon's was removed, so it is no longer here. The
/// sample's sign-ins are oldest first, as the API lists them, and say no more of a password than that it is set, and when.
function sampleVault(at: number): FakeVault {
  const ago = (minutes: number) => new Date(at - minutes * MINUTE_MS).toISOString();
  const day = 24 * 60;
  return {
    signIns: [
      {
        id: SAMPLE_SIGN_IN,
        site: "Shopee Seller Centre",
        origins: ["https://seller.shopee.co.th"],
        username: "baanmali",
        members: ["nam", "pim"],
        state: "working",
        passwordSet: true,
        passwordSetAt: ago(1050),
        brokenAt: null,
        brokenBy: null,
        lastUsedAt: ago(1098.8),
        lastUsedBy: "nam",
        createdAt: ago(9 * day - 10),
      },
      {
        id: SAMPLE_CARRIER_SIGN_IN,
        site: "Carrier portal",
        origins: ["https://portal.carrier.example"],
        username: "baanmali",
        members: ["nam"],
        state: "broken",
        passwordSet: true,
        passwordSetAt: ago(3 * day),
        brokenAt: ago(2 * day - 2),
        brokenBy: "nam",
        lastUsedAt: ago(2 * day - 1.2),
        lastUsedBy: "nam",
        createdAt: ago(3 * day),
      },
    ],
    outposts: [
      { id: SAMPLE_CLOUD_OUTPOST, name: "Cloud outpost", kind: "cloud", lastHeartbeatAt: null, createdAt: ago(9 * day - 20) },
      // Registered by Fon's desktop app as "This Mac" and renamed by her, which `sampleAudit` says. It beats while the page is open.
      { id: SAMPLE_MAC_OUTPOST, name: "Fon's MacBook", kind: "this_mac", lastHeartbeatAt: ago(0), createdAt: ago(2 * day - 40),
        beats: true },
    ],
  };
}

/// Baan Mali's people as its sample world would have made them, by the package's own rules, as the design canvas's People
/// board draws them: Mint, a helper for ten days with two devices, who covers messages until the end of the fourth day from
/// now while Fon is away and passed on a note about a refund this morning; and Beam, invited on LINE two hours ago, whose
/// link still waits. The ids are the ones `sampleAudit` names.
function samplePeople(at: number, tenant: string): FakePeople {
  const mint: Identity = { kind: "email", address: "mint@baanmali.example" };
  const beam: Identity = { kind: "line", id: "beam.baanmali" };
  const joinedAt = at - 10 * DAY_MS + 5 * MINUTE_MS;
  const refused = (what: string, why: string) => new Error(`the sample ${what} was refused: ${why}`);
  let state = peopleRules.emptyPeople(tenant, OWNER_ID);

  // Older history, by the ids `sampleAudit` names. Fon invited Tum and cancelled it three minutes later. An operator invited Ice, who
  // joined and was removed by Fon five days ago. Neither is on the list now, but each keeps a name, so the log can still say them.
  const tum: Identity = { kind: "line", id: "tum.baanmali" };
  const ice: Identity = { kind: "email", address: "ice@baanmali.example" };
  const invitedTum = peopleRules.invite(state, "inv-tum", tum, at - 9 * DAY_MS);
  if (!invitedTum.ok) throw refused("invite for Tum", invitedTum.refused);
  const cancelledTum = peopleRules.revokeInvite(invitedTum.state, "inv-tum");
  if (!cancelledTum.ok) throw refused("cancelling of Tum's invite", cancelledTum.refused);
  const invitedIce = peopleRules.invite(cancelledTum.state, "inv-ice", ice, at - 8 * DAY_MS);
  if (!invitedIce.ok) throw refused("invite for Ice", invitedIce.refused);
  const joinedIce = peopleRules.acceptInvite(invitedIce.state, "inv-ice", ice, "helper-ice", "hs-ice-1", at - 8 * DAY_MS + 30 * MINUTE_MS);
  if (joinedIce.answer !== "joined") throw refused("joining of Ice", joinedIce.answer);
  const removedIce = peopleRules.removeHelper(joinedIce.state, "helper-ice");
  if (!removedIce.ok) throw refused("removal of Ice", removedIce.refused);
  state = removedIce.state;

  const invitedMint = peopleRules.invite(state, "inv-mint", mint, at - 10 * DAY_MS);
  if (!invitedMint.ok) throw refused("invite for Mint", invitedMint.refused);
  const joined = peopleRules.acceptInvite(invitedMint.state, "inv-mint", mint, "helper-mint", "hs-mint-1", joinedAt);
  if (joined.answer !== "joined") throw refused("joining of Mint", joined.answer);
  const second = peopleRules.addSession(joined.state, "helper-mint", "hs-mint-2");
  if (!second.ok) throw refused("second device of Mint", second.refused);
  // "Until Friday" is the end of that day on the shop's calendar, the moment a date field's day ends at.
  const until = Date.parse(endOfShopDay(formatIsoDate(new Date(at + 4 * DAY_MS).toISOString()))!);
  const covering = peopleRules.setAway(second.state, "helper-mint", until, at - DAY_MS);
  if (!covering.ok) throw refused("cover", covering.refused);
  const note = peopleRules.passOn(covering.state, "helper-mint", { id: "req_refund", kind: "money", decided: null },
    "The customer sent a photo of the broken jar. It looks right to me.", at - 3 * 60 * MINUTE_MS);
  if (!note.ok) throw refused("note", note.refused);
  const invitedBeam = peopleRules.invite(note.state, "inv-beam", beam, at - 2 * 60 * MINUTE_MS);
  if (!invitedBeam.ok) throw refused("invite for Beam", invitedBeam.refused);
  state = invitedBeam.state;

  // Fon's account was linked eleven days ago, and her app has the shop open on two devices.
  return {
    state,
    names: { "inv-mint": "Mint", "helper-mint": "Mint", "inv-beam": "Beam", "inv-tum": "Tum", "inv-ice": "Ice", "helper-ice": "Ice" },
    ownerAccount: { id: SAMPLE_OWNER_ACCOUNT, subject: "apple:practice-fon", linkedAt: at - 11 * DAY_MS },
    ownerDevices: 2,
  };
}

/// The id of the link `samplePeople` makes for Fon's account, which `sampleAudit` names.
const SAMPLE_OWNER_ACCOUNT = "owner-fon";

/// The codes `PRACTICE_OWNER_CODES` names, each for the account that asked for it, as the API keeps a code: in its one form.
function sampleOwnerCodes(): FakeOwnerCode[] {
  const bare = (code: string) => code.replace("-", "");
  return [
    { code: bare(PRACTICE_OWNER_CODES.dao), subject: "apple:practice-dao" },
    { code: bare(PRACTICE_OWNER_CODES.fon), subject: "apple:practice-fon" },
    { code: bare(PRACTICE_OWNER_CODES.guest), subject: "apple:practice-guest" },
    { code: bare(PRACTICE_OWNER_CODES.ranOut), subject: "apple:practice-dao", ranOut: true },
  ];
}

/// What Nam, Pim and Ton did for Baan Mali, oldest first, as the API's task index would list it: one job for each way a job
/// can end, and the two ways a handover shows. The jobs answer the messages of the sample world above, every draft is a draft
/// nobody has sent, and the money is whole satang as the gateway prices a small model call. Its LINE account is past its
/// three days of practice, so a reply says it needs Fon's approval to be sent. Ids look like the API's: `worker-task-` and a UUID.
function sampleWorkers(at: number, tenant: string): FakeWorkerJob[] {
  const ago = (minutes: number) => new Date(at - minutes * MINUTE_MS).toISOString();
  // A summary covers the day before the job ran, on the shop's calendar.
  const dayBefore = (minutes: number) => formatIsoDate(ago(minutes + 24 * 60));
  let count = 0;
  const job = (minutesAgo: number, entry: Omit<WorkerJobEntry, "taskId" | "at">): FakeWorkerJob => {
    count += 1;
    return { tenant, taskId: `worker-task-6a7c1f00-0000-4000-8000-${String(count).padStart(12, "0")}`, at: ago(minutesAgo),
      ...entry };
  };
  const draft = (minutesAgo: number, text: string, extra: Pick<WorkerDraft, "about" | "send"> = {}): WorkerDraft =>
    ({ text, at: ago(minutesAgo), ...extra });
  const send = { answer: "ask", kind: "reply" } as const;
  const day = 24 * 60;
  return [
    // Nam was asked for yesterday's numbers, which are Ton's job, and passed it on.
    job(day + 120, { member: "ton", passedFrom: "nam", job: "daily_summary", ending: { state: "done" },
      draft: draft(day + 119, "Yesterday: 3 paid orders, ฿2,370 in sales. Nothing needs checking.",
        { about: { date: dayBefore(day + 120) } }), costSatang: 2 }),
    job(20 * 60, { member: "pim", job: "post", ending: { state: "done" },
      draft: draft(20 * 60 - 1, "เซ็ตของขวัญเทียนหอม 3 กลิ่น ห่อฟรีตลอดเดือนธันวาคม สั่งได้ทาง LINE ร้านค่ะ"), costSatang: 3 }),
    job(5 * 60, { member: "nam", job: "reply", ending: { state: "done" },
      draft: draft(5 * 60 - 1, "Hi Khun Nok, thank you for waiting. Order SP-2296 is being packed and ships tomorrow morning, so it should reach you by Tuesday.",
        { about: { messageId: "msg_nok" }, send }), costSatang: 2 }),
    job(3 * 60, { member: "ton", job: "daily_summary", ending: { state: "failed", reason: "payments_unavailable" },
      draft: null }),
    job(90, { member: "pim", job: "post", ending: { state: "awaiting_owner" },
      draft: draft(88, "Free gift wrapping all December. Order by 15 December and it reaches you before Christmas."),
      costSatang: 3 }),
    // Pim was asked for a reply, which is Nam's job, and passed it on; Nam has not taken it up.
    job(40, { member: "pim", job: "reply", ending: { state: "handed_over", to: "nam" }, draft: null }),
    job(8, { member: "nam", job: "reply", ending: { state: "done" },
      draft: draft(7, "ขออภัยที่พัสดุล่าช้านะคะ ตอนนี้ของออกจากคลังแล้ว คาดว่าจะถึงภายในวันอังคารค่ะ",
        { about: { messageId: "msg_ploy" }, send }), costSatang: 2 }),
  ];
}

/// What Baan Mali's team knows, as its sample world would have taught it, and the design canvas's own sample facts: what Fon
/// said herself, what a price list, twelve of her edits, ninety days of orders and a cost sheet taught it, and two things
/// customers said, which wait for Fon. Built by the package's own rules, so the practice world holds exactly what the API
/// would. Ids are f1 to f7 and the next is f8.
function sampleMemory(at: number): MemoryState {
  const ago = (minutes: number) => at - minutes * MINUTE_MS;
  const day = 24 * 60;
  let state = shopMemory.emptyState();
  const keep = (result: Result) => {
    if (!result.ok) throw new Error(`the sample fact was refused: ${result.reason}`);
    state = result.state;
  };
  keep(shopMemory.remember(state, "Gift wrapping is free in December.", ago(12 * day)));
  keep(shopMemory.propose(state, "Free shipping on orders over ฿800",
    { kind: "document", name: "your price list", date: ago(20 * day) }, ago(11 * day)));
  keep(shopMemory.propose(state, "Reply warmly and end with ค่ะ", { kind: "edits", count: 12 }, ago(6 * day)));
  keep(shopMemory.propose(state, "Jasmine is the best seller", { kind: "orders", days: 90 }, ago(3 * day)));
  keep(shopMemory.propose(state, "A jasmine candle costs ฿118 to make",
    { kind: "connection", name: "Google Sheets", detail: "cost sheet" }, ago(2 * day)));
  keep(shopMemory.propose(state, "Closed on Mondays", { kind: "customer", chat: "line:Ujoy" }, ago(90)));
  keep(shopMemory.propose(state, "Customers expect 20% off when they buy 5 sets", { kind: "customer", chat: "line:Ufah" }, ago(50)));
  return state;
}

/// One first-week question as the API answers it: its answer's words read from what the team knows, null once the owner
/// had the team forget them.
function questionView(question: FakeQuestion, facts: readonly Fact[]): ShopQuestion {
  if (question.factId === undefined) return { id: question.id, text: question.text, answer: null };
  const fact = facts.find((candidate) => candidate.id === question.factId);
  return { id: question.id, text: question.text,
    answer: { factId: question.factId, text: fact?.text ?? null, answeredAt: question.answeredAt ?? "" } };
}

/// The three shop templates as the API serves them from `@manut/shop-templates` (`GET /v1/admin/templates`), copied for
/// practice mode because the web app does not depend on that package: the same ids, words and order.
const SHOP_TEMPLATES: ShopTemplate[] = [
  {
    id: "handmade",
    name: "Handmade and gifts",
    fits: "Candles, soap, crafts and gift sets, like Baan Mali.",
    team: ["nam", "pim", "ton"],
    routines: [
      { when: "Every day at 08:00", does: "Morning brief", asksFirst: false },
      { when: "Every Monday at 08:00", does: "Weekly growth brief", asksFirst: false },
      { when: "When stock drops under 5", does: "Tell me and draft a restock order", asksFirst: false },
      { when: "On the last day of the month at 18:00", does: "Send the books to FlowAccount", asksFirst: true },
    ],
    questions: [
      "What is your price list?",
      "What order total gets free shipping?",
      "How long do pre-orders take?",
      "Do you gift-wrap, and what does it cost?",
    ],
  },
  {
    id: "fashion",
    name: "Clothes and accessories",
    fits: "Shops selling clothes, bags and accessories in sizes.",
    team: ["nam", "pim", "ton"],
    routines: [
      { when: "Every day at 08:00", does: "Morning brief", asksFirst: false },
      { when: "Every Friday at 10:00", does: "Draft a new-arrivals post", asksFirst: true },
      { when: "When a size drops under 3", does: "Tell me and draft a restock order", asksFirst: false },
      { when: "On the last day of the month at 18:00", does: "Send the books to FlowAccount", asksFirst: true },
    ],
    questions: [
      "What is your size chart?",
      "Do you take exchanges, and for how long?",
      "How do pre-orders work?",
      "Which items are never discounted?",
    ],
  },
  {
    id: "food",
    name: "Packaged food and drinks",
    fits: "Shops selling packaged food and drinks that keep for a limited time.",
    team: ["nam", "ton"],
    routines: [
      { when: "Every day at 08:00", does: "Morning brief", asksFirst: false },
      { when: "Every day at 09:00", does: "List what expires within 7 days", asksFirst: false },
      { when: "Every day at 15:00", does: "Remind me of today's delivery cut-off", asksFirst: false },
      { when: "On the last day of the month at 18:00", does: "Send the books to FlowAccount", asksFirst: true },
    ],
    questions: [
      "How long does each product keep?",
      "Where do you deliver, and what is the day's cut-off time?",
      "Which products must stay cold?",
      "What should Buddy say when a customer asks about allergies? (Buddy never answers allergy questions from guesswork.)",
    ],
  },
];
