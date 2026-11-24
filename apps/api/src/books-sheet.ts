/// Ton appends a month of the shop's books to the owner's Google Sheet (docs/pilot-api.md, "Google Sheets for Ton's
/// books"; docs/connectors.md, 4b). This is the control plane's half; what a request names is books-detail.ts.
///
/// Asking, through Ton's port (job-flow.ts, `askBooks`), after the switches (with `officeExternalWrites`), consent and
/// the attempt's heartbeat, which gives the member:
///
/// 1. Google is configured, the month is written `YYYY-MM`, member-grants' `decide` answers for the member and the job
///    `append_books` through the shop's Google connection (a broken one is no connection), and the month has ended in
///    Bangkok. Practice mode keeps a draft of the append and asks for nothing.
/// 2. The rows come from `@manut/books`' `monthBooks` over the same entries Ton's daily summary counts: each confirmed
///    payment a sale on LINE at the moment it was confirmed (`entriesOf`). A month that the newest 500 payments do not
///    reach back past is refused rather than appended short, and so is a month with nothing in it.
/// 3. A fresh access token from the sealed refresh token, used for this ask and dropped. Google refusing the grant marks
///    the connection broken, in words the owner reads, and nothing is asked.
/// 4. The sheet: on first use a new spreadsheet is made in the owner's Drive, once, under a claim on the connection; a
///    sheet the connection names is checked to be still there for this account, with its tab, and its title is read as it
///    is now, so the request names it as the owner sees it. It holds no rows until an append is approved.
/// 5. The task object stores the month's exact rows as an immutable proposal and opens the owner-only request.
///
/// Sending, once the owner approved it, through the broker's one-use begin gate (broker-actions.ts): `sendBooks` takes a
/// new access token and sends the approved rows exactly as `@manut/sheets-rows` builds them from the proposal, once. A
/// Google answer that leaves it unknown whether the rows landed settles as unknown, never as done, and is never sent
/// again.
///
/// No token is stored, logged, or returned: the refresh token leaves the vault only for a call to Google's token
/// endpoint, and an access token lives for the calls of one ask or one send.

import { monthBooks, type Entry, type MonthBooks } from "@manut/books";
import { decide, newConnection, type Connection } from "@manut/member-grants";
import { appendRequest } from "@manut/sheets-rows";
import type { ApprovalKind } from "@manut/approval-core";
import { appendAudit } from "./audit-log";
import {
  BOOKS_JOB,
  BOOKS_KIND,
  BOOKS_TAB,
  booksPayloadOf,
  isBooksMonth,
  MAX_BOOK_LINES,
  type BooksPayload,
  type BooksSheet,
} from "./books-detail";
import { readConnectionSecret } from "./cred-broker";
import {
  appendRows,
  createSheet,
  googleConfig,
  readSheet,
  refreshAccess,
  type FetchImpl,
  type GoogleConfig,
  type GoogleEnv,
} from "./google";
import { googleConnectionOf, googleVaultCall, type GoogleConnection } from "./google-connection";
import { GOOGLE_PROVIDER } from "./google-vault";
import { bangkokMonth } from "./model-price";
import { MAX_LISTED_PAYMENTS, type Payment, type PilotShopRecord } from "./pilot-store";
import type { AttemptRef } from "./sign-in-vault";
import type { ActionProposalJSON } from "./task-object";
import { credStub, tenantCall, type TenantDataEnv } from "./tenant-data";

export type BooksEnv = Pick<TenantDataEnv, "TENANT" | "TASK" | "CRED"> & GoogleEnv;

const enc = encodeURIComponent;
const BANGKOK_OFFSET_MS = 7 * 60 * 60 * 1000;
/// The longest title a new sheet is given, in characters.
const MAX_SHEET_TITLE = 100;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// ---------------------------------------------------------------------------
// The shop's books
// ---------------------------------------------------------------------------

/// The customers' order payments the shop has recorded, newest first, as many as the console lists (500). Null when they
/// cannot be read.
export async function readPayments(env: Pick<TenantDataEnv, "TENANT">, tenant: string): Promise<Payment[] | null> {
  try {
    const response = await tenantCall(env, tenant, `/pilot/payments?tenant=${enc(tenant)}`);
    if (!response.ok) {
      await response.body?.cancel();
      return null;
    }
    const { payments } = (await response.json()) as { payments?: unknown };
    return Array.isArray(payments) ? payments.filter(isRecord) as Payment[] : null;
  } catch {
    return null;
  }
}

/// The payments as Ton's books count them: each a sale on LINE, the pilot's one channel, at the moment the payment
/// was confirmed. A record that is not whole goes in as it is, and the books flag it rather than count it.
export function entriesOf(payments: readonly Payment[]): Entry[] {
  return payments.map((payment): Entry => ({
    kind: "sale",
    ref: payment.orderRef,
    channel: "line",
    amountSatang: payment.amountSatang,
    at: typeof payment.confirmedAt === "string" ? Date.parse(payment.confirmedAt) : Number.NaN,
  }));
}

/// The first moment of a month in Bangkok, in ms.
function monthStartMs(month: string): number {
  const [year, number] = month.split("-").map(Number);
  return Date.UTC(year ?? 0, (number ?? 1) - 1, 1) - BANGKOK_OFFSET_MS;
}

/// Whether the payments read hold every payment of the month. The shop lists only its newest 500, newest first, so a
/// full list whose oldest payment is not from before the month began may have left some of the month out.
export function monthIsWhole(payments: readonly Payment[], month: string): boolean {
  if (payments.length < MAX_LISTED_PAYMENTS) return true;
  const oldest = Math.min(...payments.map((payment) => Date.parse(payment.confirmedAt)).filter(Number.isFinite));
  return oldest < monthStartMs(month);
}

export type MonthRead = { ok: true; books: MonthBooks } | { ok: false; error: "payments_unavailable" | "month_incomplete" };

/// A month's books from the shop's payments, or why there are none to append. Days are Bangkok's, as the daily
/// summary's are, and no shop is VAT registered yet, so the rows carry no VAT figures (`monthBooks`' default).
export async function readMonth(env: Pick<TenantDataEnv, "TENANT">, tenant: string, month: string): Promise<MonthRead> {
  const payments = await readPayments(env, tenant);
  if (!payments) return { ok: false, error: "payments_unavailable" };
  if (!monthIsWhole(payments, month)) return { ok: false, error: "month_incomplete" };
  return { ok: true, books: monthBooks(entriesOf(payments), month) };
}

/// The shop's record, null when the tenant is not a pilot shop, undefined when it cannot be read.
async function readShop(env: Pick<TenantDataEnv, "TENANT">, tenant: string): Promise<PilotShopRecord | null | undefined> {
  try {
    const response = await tenantCall(env, tenant, `/pilot/shop?tenant=${enc(tenant)}`);
    if (response.status === 404) {
      await response.body?.cancel();
      return null;
    }
    if (!response.ok) {
      await response.body?.cancel();
      return undefined;
    }
    const { shop } = (await response.json()) as { shop?: PilotShopRecord };
    return shop && typeof shop.name === "string" ? shop : undefined;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// The Google connection: its practice clock, a broken grant, and access tokens
// ---------------------------------------------------------------------------

/// When the shop first connected Google, revoked connections included, in ms: the practice clock starts there, so
/// connecting again (after a broken token, say) does not start practice over. Null when the vault has no record of it,
/// undefined when it cannot be read.
async function firstConnectedMs(env: Pick<TenantDataEnv, "CRED">, tenant: string): Promise<number | null | undefined> {
  try {
    const response = await credStub(env, tenant).fetch(new Request(
      `https://cred/first-connection?tenant=${enc(tenant)}&provider=${GOOGLE_PROVIDER}`, { headers: { "x-tenant": tenant } }));
    if (!response.ok) {
      await response.body?.cancel();
      return undefined;
    }
    const { createdAt } = (await response.json()) as { createdAt?: unknown };
    const ms = typeof createdAt === "string" ? Date.parse(createdAt) : Number.NaN;
    return Number.isFinite(ms) ? ms : null;
  } catch {
    return undefined;
  }
}

/// Marks the connection broken after Google refused its grant, and writes `google.broken` once, for the call that broke
/// it. Best effort: the refusal already stops this send or ask, and the next one is refused by Google again.
export async function markBroken(env: Pick<TenantDataEnv, "CRED" | "TENANT">, tenant: string, connectionId: string,
  reason: string): Promise<void> {
  const answer = await googleVaultCall(env, tenant, "/google/broken", { id: connectionId, reason });
  if (answer?.status === 200 && answer.body.newly === true) {
    await appendAudit(env, tenant, { actor: { kind: "system" }, action: "google.broken", subject: { connectionId },
      outcome: "refused", reason });
  }
}

/// A fresh access token for one ask or one send, from the sealed refresh token. Google refusing the grant breaks the
/// connection (`google_broken`); no answer, or any other refusal, is `google_unavailable` and changes nothing.
export async function accessFor(env: Pick<TenantDataEnv, "CRED" | "TENANT">, tenant: string, connectionId: string,
  config: GoogleConfig, fetchImpl: FetchImpl): Promise<{ ok: true; accessToken: string } |
  { ok: false; error: "google_broken" | "google_unavailable" }> {
  let refreshToken: string;
  try {
    refreshToken = await readConnectionSecret(env, connectionId, tenant);
  } catch {
    return { ok: false, error: "google_unavailable" };
  }
  const refreshed = await refreshAccess(fetchImpl, config, refreshToken);
  if (refreshed.ok) return refreshed;
  if (refreshed.error === "invalid_grant") {
    await markBroken(env, tenant, connectionId, "invalid_grant");
    return { ok: false, error: "google_broken" };
  }
  return { ok: false, error: "google_unavailable" };
}

// ---------------------------------------------------------------------------
// Asking
// ---------------------------------------------------------------------------

/// The month's books ready to ask about, without the sheet yet.
export type BooksToAsk = Omit<BooksPayload, "sheet">;

/// What asking may come to before Google or the task object is asked anything.
export type PreparedBooks =
  | { ok: true; answer: "ask" | "draft_only"; kind: ApprovalKind; books: BooksToAsk; connection: GoogleConnection;
    shopName: string }
  | { ok: false; error: string; member?: string };

/// Everything an ask checks before it calls Google, in order: Google configured, the month's form, the connection and
/// member-grants' `decide` for the attempt's member, the month over, then the books themselves.
export async function prepareBooks(env: BooksEnv, attempt: AttemptRef, month: unknown, nowMs: number):
  Promise<PreparedBooks> {
  if (!googleConfig(env)) return { ok: false, error: "google_not_configured" };
  if (!isBooksMonth(month)) return { ok: false, error: "invalid_month" };
  const found = await googleConnectionOf(env, attempt.tenant);
  if (found === undefined) return { ok: false, error: "vault_unavailable" };
  let connection: Connection | null = null;
  if (found) {
    const first = await firstConnectedMs(env, attempt.tenant);
    if (first === undefined) return { ok: false, error: "vault_unavailable" };
    const since = first ?? Date.parse(found.createdAt);
    connection = found.brokenAt ? { ...newConnection(since), connected: false } : newConnection(since);
  }
  const decided = decide(attempt.member, BOOKS_JOB, connection, nowMs);
  switch (decided.answer) {
    case "not_my_job":
      return { ok: false, error: "not_my_job", member: decided.member };
    case "not_connected":
      return { ok: false, error: found?.brokenAt ? "google_broken" : "not_connected" };
    case "refused":
      return { ok: false, error: decided.reason };
    case "allowed":
      // An append is a write and never answers allowed; a roster that calls it a read does not describe it.
      return { ok: false, error: "kind_mismatch" };
    case "ask":
    case "draft_only":
      break;
  }
  if (decided.kind !== BOOKS_KIND || !found) return { ok: false, error: "kind_mismatch" };
  if (!(month < bangkokMonth(nowMs))) return { ok: false, error: "month_not_over" };
  const shop = await readShop(env, attempt.tenant);
  if (shop === undefined) return { ok: false, error: "shop_unavailable" };
  if (shop === null) return { ok: false, error: "shop_not_found" };
  const read = await readMonth(env, attempt.tenant, month);
  if (!read.ok) return read;
  if (read.books.lines.length === 0) return { ok: false, error: "nothing_to_append" };
  if (read.books.lines.length > MAX_BOOK_LINES) return { ok: false, error: "month_too_long" };
  return {
    ok: true,
    answer: decided.answer,
    kind: decided.kind,
    books: { month, vatRegistered: read.books.vatRegistered, lines: read.books.lines, flags: read.books.flags.length },
    connection: found,
    shopName: shop.name,
  };
}

/// The title a new sheet is given: the app's name and the shop's, so an owner with several shops tells them apart.
export function sheetTitle(shopName: string): string {
  return [...`Manut AI books: ${shopName.trim()}`].slice(0, MAX_SHEET_TITLE).join("");
}

/// The sheet the books go to, for a draft: the connection's, or the one that would be made.
export function draftSheet(prepared: Extract<PreparedBooks, { ok: true }>): Pick<BooksSheet, "title" | "tab"> {
  return prepared.connection.sheet ?? { title: sheetTitle(prepared.shopName), tab: BOOKS_TAB };
}

type SheetReady = { ok: true; sheet: BooksSheet; grantRevision: number } | { ok: false; error: string };

/// The sheet an ask names. A sheet the connection already has is read (its title as it is now, and that its tab is still
/// there); one that is gone for this account, or none at all, is made, once: the vault lets one claim make it at a time,
/// and binds only the sheet that claim made, under a new grant revision. A second ask while one is being made is
/// refused (`sheet_in_progress`) rather than making another.
async function sheetFor(env: BooksEnv, tenant: string, connection: GoogleConnection, shopName: string,
  config: GoogleConfig, accessToken: string, fetchImpl: FetchImpl): Promise<SheetReady> {
  if (connection.sheet) {
    const read = await readSheet(fetchImpl, config, accessToken, connection.sheet.id);
    if (read.state === "unreachable") return { ok: false, error: "google_unavailable" };
    if (read.state === "found") {
      if (!read.tabs.includes(connection.sheet.tab)) return { ok: false, error: "sheet_tab_missing" };
      return { ok: true, sheet: { id: connection.sheet.id, title: read.title || connection.sheet.title,
        tab: connection.sheet.tab }, grantRevision: connection.grantRevision };
    }
  }
  const claimed = await googleVaultCall(env, tenant, "/google/sheet-claim",
    { id: connection.id, replacing: connection.sheet?.id ?? null });
  if (!claimed) return { ok: false, error: "vault_unavailable" };
  if (claimed.status === 404) return { ok: false, error: "not_connected" };
  if (claimed.status === 409) {
    return { ok: false, error: claimed.body.error === "connection_broken" ? "google_broken" : "sheet_in_progress" };
  }
  const claim = claimed.body.claim;
  if (claimed.status !== 200 || typeof claim !== "string") return { ok: false, error: "vault_unavailable" };
  const title = sheetTitle(shopName);
  const made = await createSheet(fetchImpl, config, accessToken, title, BOOKS_TAB);
  if (!made) {
    await googleVaultCall(env, tenant, "/google/sheet-release", { id: connection.id, claim });
    return { ok: false, error: "sheet_not_made" };
  }
  const bound = await googleVaultCall(env, tenant, "/google/sheet", { id: connection.id, claim,
    sheet: { id: made.id, title: made.title, tab: made.tab, url: made.url } });
  if (!bound || bound.status !== 200 || typeof bound.body.grantRevision !== "number") {
    return { ok: false, error: "sheet_in_progress" };
  }
  await appendAudit(env, tenant, { actor: { kind: "system" }, action: "google.sheet_created",
    subject: { connectionId: connection.id }, outcome: "ok" });
  return { ok: true, sheet: { id: made.id, title: made.title, tab: made.tab }, grantRevision: bound.body.grantRevision };
}

/// What the task object needs to ask: the month's exact rows with the sheet they go to, and the connection and grant
/// revision the proposal is bound to.
export type BooksAsk = { books: BooksPayload; connection: { id: string; accountId: string; grantRevision: number } };

/// After `prepareBooks` answered `ask`: a fresh access token, then the sheet, made on first use. Answers what the task
/// object's ask takes, or why the ask cannot be made now.
export async function readyBooks(env: BooksEnv, tenant: string, prepared: Extract<PreparedBooks, { ok: true }>,
  fetchImpl: FetchImpl): Promise<{ ok: true; ask: BooksAsk } | { ok: false; error: string }> {
  const config = googleConfig(env);
  if (!config) return { ok: false, error: "google_not_configured" };
  const access = await accessFor(env, tenant, prepared.connection.id, config, fetchImpl);
  if (!access.ok) return access;
  const ready = await sheetFor(env, tenant, prepared.connection, prepared.shopName, config, access.accessToken, fetchImpl);
  if (!ready.ok) return ready;
  return { ok: true, ask: {
    books: { sheet: ready.sheet, ...prepared.books },
    connection: { id: prepared.connection.id, accountId: prepared.connection.accountId,
      grantRevision: ready.grantRevision },
  } };
}

// ---------------------------------------------------------------------------
// Sending, once approved
// ---------------------------------------------------------------------------

export type BooksSent =
  | { outcome: "confirmed"; providerOperationId: string; receipt: { updatedRange: string | null; updatedRows: number | null } }
  | { outcome: "failed" | "unknown"; reason: string };

/// Sends one approved append, after the begin gate moved it to dispatching and the broker checked the live grant. The
/// rows are the approved payload's, built into the request by `@manut/sheets-rows` exactly as it builds any month's.
/// Everything that fails before the request goes out is `failed`, since nothing was sent; how Google's answer to the
/// request settles is google.ts's `appendRows`.
export async function sendBooks(env: BooksEnv, proposal: ActionProposalJSON, fetchImpl: FetchImpl): Promise<BooksSent> {
  const config = googleConfig(env);
  if (!config) return { outcome: "failed", reason: "google_not_configured" };
  const payload = booksPayloadOf(proposal.payload);
  if (!payload || payload.sheet.id !== proposal.targetResourceId) return { outcome: "failed", reason: "invalid_payload" };
  const access = await accessFor(env, proposal.tenant, proposal.connectionId, config, fetchImpl);
  if (!access.ok) return { outcome: "failed", reason: access.error };
  // `appendRequest` reads only the month's lines, so the approved lines go into an otherwise empty month of the same name.
  const built = appendRequest({ ...monthBooks([], payload.month, { vatRegistered: payload.vatRegistered }),
    lines: payload.lines }, { spreadsheetId: payload.sheet.id, sheetName: payload.sheet.tab });
  if (!built.ok) return { outcome: "failed", reason: built.reason };
  const appended = await appendRows(fetchImpl, config, access.accessToken, built.request);
  if (appended.outcome === "confirmed") {
    return { outcome: "confirmed", providerOperationId: appended.updatedRange ?? `append:${proposal.id}`,
      receipt: { updatedRange: appended.updatedRange, updatedRows: appended.updatedRows } };
  }
  return { outcome: appended.outcome, reason: appended.code };
}
