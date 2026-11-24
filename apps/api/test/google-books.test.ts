import { runInDurableObject } from "cloudflare:test";
import { monthBooks } from "@manut/books";
import { appendRequest } from "@manut/sheets-rows";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/index";
import { bahtText, booksPayloadOf, booksText, booksTotals, type BooksDetail } from "../src/books-detail";
import { monthIsWhole, plainTitle, sheetTitle } from "../src/books-sheet";
import { dispatchAction } from "../src/broker-actions";
import { dispatchApproved } from "../src/job-flow";
import { bangkokMonth } from "../src/model-price";
import { sortableId, type Payment } from "../src/pilot-store";
import type { ActionProposalJSON } from "../src/task-object";
import { CLIENT_ID } from "./google-fake";
import {
  auditOf,
  connect,
  DAY_MS,
  enc,
  googleEnv,
  holdsNoToken,
  installGoogle,
  lastMonth,
  operator,
  send,
  sendJson,
  status,
  vault,
  vaultRecords,
  world,
} from "./google-fixtures";
import { tenantSession } from "./authenticated-fixtures";
import { bindings, joinHelper, linkedOwner, setupShop, shopConsents, type Owner, type Shop } from "./people-fixtures";

// Ton appends a month of the shop's books to the owner's Google Sheet (books-sheet.ts, books-detail.ts; docs/pilot-api.md,
// "Google Sheets for Ton's books"), end to end in real workerd against the real objects: asked through approval-core
// with the exact rows, owner-only, approved once and sent once through the broker's one-use begin gate. Google is the
// fake in google-fake.ts; every other outbound call answers 599, and a test fails if one was tried.

const BANGKOK_MS = 7 * 60 * 60 * 1000;
const on = async () => ({ officeCloud: true, officeExternalWrites: true });

beforeEach(() => installGoogle());

afterEach(() => {
  expect(world.google.elsewhere).toEqual([]);
  vi.restoreAllMocks();
});

/// Order payments confirmed on the 10th of `month`, an hour apart, kept in the shop's object as the operator's route keeps
/// them, so the month is over by the time Ton reads it.
async function paidIn(shop: Shop, month: string, payments: { orderRef: string; amountSatang: number }[]): Promise<void> {
  const [year, number] = month.split("-").map(Number) as [number, number];
  const start = Date.UTC(year, number - 1, 10, 12) - BANGKOK_MS;
  const object = bindings.TENANT.get(bindings.TENANT.idFromName(`t:${shop.tenant}`));
  await runInDurableObject(object, async (_instance, state) => {
    for (const [index, payment] of payments.entries()) {
      const at = start + index * 3600_000;
      const id = sortableId("pay", at, index);
      const record: Payment = { id, tenant: shop.tenant, orderRef: payment.orderRef, amountSatang: payment.amountSatang,
        promptPayId: "0812345678", confirmedAt: new Date(at).toISOString() };
      await state.storage.put(`pilot-pay:${enc(shop.tenant)}:${id}`, record);
    }
  });
}

/// The shop's Google connections were made four days ago, so their three days of practice are over.
async function pastPractice(shop: Shop): Promise<void> {
  await runInDurableObject(vault(shop), async (_instance, state) => {
    for (const [key, record] of await state.storage.list<Record<string, unknown>>({ prefix: "conn:" })) {
      if (record.provider !== "gsheets") continue;
      await state.storage.put(key, { ...record, createdAt: new Date(Date.now() - 4 * DAY_MS).toISOString() });
    }
  });
}

/// A pilot shop with consent to cloud work, its owner signed in with an owner session, and Google connected and past
/// practice.
async function readyShop(name = "Baan Mali"): Promise<{ shop: Shop; owner: Owner; connectionId: string }> {
  const shop = await setupShop(name);
  await shopConsents(shop.tenant);
  const owner = await linkedOwner(shop);
  const connectionId = await connect(owner);
  await pastPractice(shop);
  return { shop, owner, connectionId };
}

type Asked = { taskId: string; member: string; outcome: string; requestId?: string; kind?: string; reason?: string;
  draft?: { text: string; job: string; about?: Record<string, string>; send?: { answer: string; kind: string } };
  error?: string };

async function askBooks(owner: Owner, month: string, target?: Env) {
  return sendJson<Asked>("/v1/google/books", { method: "POST", headers: owner.headers, body: { month },
    ...(target ? { target } : {}) });
}

type Listed = { approvals: { taskId: string; record: { status: string; request: { id: string; kind: string;
  revision: number; detail: Record<string, unknown> } } }[] };

async function openApprovals(headers: { authorization?: string }): Promise<Listed["approvals"]> {
  const listed = await sendJson<Listed>("/v1/approvals?state=open", { headers });
  expect(listed.status).toBe(200);
  return listed.body.approvals;
}

async function decide(headers: { authorization?: string }, requestId: string, optionId = "approve") {
  return sendJson<{ result?: { ok: boolean; refused?: string }; action?: string; error?: string }>(
    `/v1/approvals/${enc(requestId)}/decision`, { method: "POST", headers, body: { optionId, seenRevision: 1 } });
}

/// What the task object holds for an action.
async function actionOf(shop: Shop, taskId: string, actionId: string): Promise<ActionProposalJSON> {
  const response = await bindings.TASK.get(bindings.TASK.idFromName(taskId)).fetch(new Request(
    `https://task/actions/${actionId}`, { headers: { "x-tenant": shop.tenant } }));
  expect(response.status).toBe(200);
  return (await response.json()) as ActionProposalJSON;
}

describe("off until the owner's OAuth client exists", () => {
  it("answers google_not_configured to the owner's ask, and fails Ton's append when an operator starts it", async () => {
    const shop = await setupShop();
    await shopConsents(shop.tenant);
    const owner = await linkedOwner(shop);
    for (const target of [bindings, { ...bindings, GOOGLE_CLIENT_ID: CLIENT_ID } as Env]) {
      expect(await askBooks(owner, lastMonth(), target)).toEqual({ status: 503, body: { error: "google_not_configured" } });
    }
    const run = await operator("POST", "/v1/admin/workers/run",
      { tenant: shop.tenant, member: "ton", job: { kind: "books_sheet", month: lastMonth() } });
    expect(run.status).toBe(200);
    expect(await run.json()).toMatchObject({ member: "ton", outcome: "failed", reason: "google_not_configured" });
    expect(world.google.calls).toEqual([]);
  });

  it("lets only the shop's owner ask for a month", async () => {
    const shop = await setupShop();
    const helper = await joinHelper(shop);
    expect(await sendJson("/v1/google/books", { method: "POST", headers: helper.headers, body: { month: lastMonth() } }))
      .toEqual({ status: 403, body: { error: "owner_only" } });
    expect((await sendJson("/v1/google/books", { method: "POST", body: { month: lastMonth() } })).status).toBe(401);
  });
});

describe("a month of the books, asked, approved once and sent once", () => {
  it("drafts in practice mode and reaches no Google, then asks with the sheet, the month, the rows and the totals", async () => {
    const shop = await setupShop();
    await shopConsents(shop.tenant);
    const owner = await linkedOwner(shop);
    await connect(owner);
    const month = lastMonth();
    await paidIn(shop, month, [{ orderRef: "SP-2291", amountSatang: 129033 }, { orderRef: "SP-2292", amountSatang: 75050 }]);
    const callsBefore = world.google.calls.length;

    // Practice: Ton drafts what it would append, asks for nothing, and no token is even refreshed.
    const practice = await askBooks(owner, month);
    expect(practice.status).toBe(200);
    expect(practice.body).toMatchObject({ member: "ton", outcome: "done", draft: { job: "books_sheet",
      send: { answer: "draft_only", kind: "command" }, about: { month } } });
    expect(practice.body.draft?.text).toContain(`Append the books for ${month}`);
    expect(practice.body.draft?.text).toContain("Sales ฿2,040.83 (2 entries)");
    expect(world.google.calls.length).toBe(callsBefore);
    expect(await openApprovals(owner.headers)).toEqual([]);

    await pastPractice(shop);
    const asked = await askBooks(owner, month);
    expect(asked.status).toBe(200);
    expect(asked.body).toMatchObject({ member: "ton", outcome: "asked", kind: "command", requestId: expect.any(String) });
    // The sheet was made, once, in the owner's Drive, with one tab and no rows.
    expect(world.google.creates()).toHaveLength(1);
    const [sheet] = [...world.google.sheets.values()];
    expect(sheet).toMatchObject({ title: "Manut AI books: Baan Mali", tabs: ["Books"], rows: [] });

    const [listed] = await openApprovals(owner.headers);
    expect(listed?.record.request).toMatchObject({ id: asked.body.requestId, kind: "command", revision: 1 });
    const detail = listed!.record.request.detail as unknown as BooksDetail;
    expect(detail).toMatchObject({ operationType: "google.sheets.append", month, rows: 2,
      sheet: { id: sheet!.id, title: "Manut AI books: Baan Mali", tab: "Books" },
      totals: { sales: "฿2,040.83", salesCount: 2, refunds: "฿0", refundsCount: 0, expenses: "฿0", expensesCount: 0,
        net: "฿2,040.83" }, flags: 0 });
    expect(detail.lines.map((line) => [line.ref, line.amountSatang])).toEqual([["SP-2291", 129033], ["SP-2292", 75050]]);
    expect(detail.text).toBe(`Append the books for ${month} to the Google Sheet "Manut AI books: Baan Mali", tab "Books": ` +
      "a header row, then 2 rows. Sales ฿2,040.83 (2 entries), refunds ฿0 (0), expenses ฿0 (0), net sales ฿2,040.83.");
    // The connection keeps the sheet's id, never its contents, as its one granted resource under a new revision.
    const now = await status(owner);
    expect(now.connection?.sheet).toEqual({ id: sheet!.id, title: "Manut AI books: Baan Mali", tab: "Books",
      url: `https://docs.google.com/spreadsheets/d/${sheet!.id}/edit` });
    expect((await vaultRecords(shop))[`conn:${now.connection!.id}`]).toMatchObject({ resourceIds: [sheet!.id],
      grantRevision: 2 });
    expect(world.google.appends()).toEqual([]);

    // The owner approves: the rows go to Google once, exactly as @manut/sheets-rows builds them, RAW.
    const approved = await decide(owner.headers, asked.body.requestId!);
    expect(approved).toMatchObject({ status: 200, body: { result: { ok: true }, action: "confirmed" } });
    expect(world.google.appends()).toHaveLength(1);
    const [append] = world.google.appends();
    expect(append!.url.searchParams.get("valueInputOption")).toBe("RAW");
    expect(append!.url.searchParams.get("insertDataOption")).toBe("INSERT_ROWS");
    const expected = appendRequest(monthBooks([{ kind: "sale", ref: "SP-2291", channel: "line", amountSatang: 129033,
      at: Date.parse(detail.lines[0]!.date) }, { kind: "sale", ref: "SP-2292", channel: "line", amountSatang: 75050,
      at: Date.parse(detail.lines[1]!.date) }], month), { spreadsheetId: sheet!.id, sheetName: "Books" });
    expect(expected.ok).toBe(true);
    if (!expected.ok) return;
    expect(append!.url.pathname).toBe(expected.request.path);
    expect(JSON.parse(append!.body)).toEqual(expected.request.body);
    expect(sheet!.rows).toEqual([["date", "ref", "kind", "channel_or_category", "amount", "before_vat", "vat"],
      [detail.lines[0]!.date, "SP-2291", "sale", "line", 1290.33, "", ""],
      [detail.lines[1]!.date, "SP-2292", "sale", "line", 750.5, "", ""]]);
    // It went with an access token from a refresh, never the refresh token.
    expect(world.google.refreshTokens.has(append!.authorization!.slice("Bearer ".length))).toBe(false);

    // Decided once: a second decision is refused, a later dispatch replays nothing, and Google saw one append.
    expect(await decide(owner.headers, asked.body.requestId!)).toMatchObject({ status: 409,
      body: { error: "already_decided" } });
    expect(await dispatchApproved(googleEnv, shop.tenant, asked.body.taskId, asked.body.requestId!, { flags: on }))
      .toBe("confirmed");
    expect(world.google.appends()).toHaveLength(1);
    expect((await actionOf(shop, asked.body.taskId, asked.body.requestId!)).dispatch).toMatchObject({
      providerOperationId: "Books!A1:G3", receipt: { updatedRange: "Books!A1:G3", updatedRows: 3 } });

    const entries = await auditOf(shop);
    expect(entries.find((entry) => entry.action === "google.appended")).toMatchObject({ actor: { kind: "system" },
      subject: { taskId: asked.body.taskId, actionId: asked.body.requestId, connectionId: now.connection!.id },
      outcome: "confirmed" });
    expect(entries.filter((entry) => entry.action === "google.sheet_created")).toHaveLength(1);
    holdsNoToken(JSON.stringify(entries));
    holdsNoToken(world.logged.join("\n"));
  });

  it("makes the sheet once, for two asks in a row and for two at once, and again only when it is gone", async () => {
    const { shop, owner } = await readyShop();
    const month = lastMonth();
    await paidIn(shop, month, [{ orderRef: "SP-1", amountSatang: 10_000 }]);
    const [first, second] = await Promise.all([askBooks(owner, month), askBooks(owner, month)]);
    expect(world.google.creates()).toHaveLength(1);
    // One made it; the other asked with that sheet, or was told the sheet was still being made.
    expect([first.body, second.body].some((run) => run.outcome === "asked")).toBe(true);
    for (const run of [first.body, second.body]) {
      if (run.outcome !== "asked") expect(run).toMatchObject({ outcome: "failed", reason: "sheet_in_progress" });
    }
    const third = await askBooks(owner, month);
    expect(third.body.outcome).toBe("asked");
    expect(world.google.creates()).toHaveLength(1);
    const [sheet] = [...world.google.sheets.values()];

    // The owner deletes the sheet: an older approval no longer reaches anything, and the next ask makes a new one.
    world.google.sheets.delete(sheet!.id);
    const fourth = await askBooks(owner, month);
    expect(fourth.body.outcome).toBe("asked");
    expect(world.google.creates()).toHaveLength(2);
    expect((await decide(owner.headers, third.body.requestId!)).body.action).toBe("failed");
    expect(world.google.appends()).toEqual([]);
    expect((await decide(owner.headers, fourth.body.requestId!)).body.action).toBe("confirmed");
    expect(world.google.appends()).toHaveLength(1);
  });

  it("names the sheet as the owner renamed it, as one line of plain text", async () => {
    const { shop, owner } = await readyShop();
    const month = lastMonth();
    await paidIn(shop, month, [{ orderRef: "SP-8", amountSatang: 800 }]);
    expect((await askBooks(owner, month)).body.outcome).toBe("asked");
    const [sheet] = [...world.google.sheets.values()];
    sheet!.title = `Fon's\nbooks\t2026 ${"x".repeat(300)}`;
    const renamed = await askBooks(owner, month);
    expect(renamed.body.outcome).toBe("asked");
    const named = (await openApprovals(owner.headers)).find((entry) => entry.record.request.id === renamed.body.requestId);
    const title = (named!.record.request.detail as unknown as BooksDetail).sheet.title;
    expect(title).toBe(`Fon's books 2026 ${"x".repeat(200 - "Fon's books 2026 ".length)}`);
    expect([...title]).toHaveLength(200);
    expect(sheetTitle("Baan\nMali  ")).toBe("Manut AI books: Baan Mali");
    expect(plainTitle(`\t${"ก".repeat(150)}`, 100)).toBe("ก".repeat(100));
  });

  it("sends once when two approvals race, and a send started beside them takes nothing", async () => {
    const { shop, owner } = await readyShop();
    const month = lastMonth();
    await paidIn(shop, month, [{ orderRef: "SP-7", amountSatang: 4_200 }]);
    const asked = await askBooks(owner, month);
    const [one, two] = await Promise.all([decide(owner.headers, asked.body.requestId!),
      decide(owner.headers, asked.body.requestId!),
      // A read of how the request stands may start the send of an approval whose own send has not begun; the begin gate
      // lets one through, whichever it is.
      dispatchApproved(googleEnv, shop.tenant, asked.body.taskId, asked.body.requestId!, { flags: on })]);
    expect([one.status, two.status].sort()).toEqual([200, 409]);
    expect(world.google.appends()).toHaveLength(1);
    expect((await actionOf(shop, asked.body.taskId, asked.body.requestId!)).state).toBe("confirmed");
  });

  it("settles as unknown when Google's answer leaves it unknown whether the rows landed, and never sends again", async () => {
    for (const answer of [503, "throw"] as const) {
      const { shop, owner } = await readyShop();
      const month = lastMonth();
      await paidIn(shop, month, [{ orderRef: "SP-9", amountSatang: 9_900 }]);
      const asked = await askBooks(owner, month);
      world.google.appendAnswer = answer;
      expect((await decide(owner.headers, asked.body.requestId!)).body.action).toBe("unknown");
      const appended = world.google.appends().length;
      world.google.appendAnswer = "ok";
      expect(await dispatchApproved(googleEnv, shop.tenant, asked.body.taskId, asked.body.requestId!, { flags: on }))
        .toBe("unknown");
      expect(world.google.appends().length).toBe(appended);
      expect((await auditOf(shop)).find((entry) => entry.action === "google.appended")).toMatchObject({
        outcome: "unknown", reason: answer === 503 ? "google_503" : "no_answer" });
    }
  });

  it("breaks the connection when Google refuses the grant, in words the owner reads, and stops sending", async () => {
    const { shop, owner, connectionId } = await readyShop();
    const month = lastMonth();
    await paidIn(shop, month, [{ orderRef: "SP-3", amountSatang: 1_000 }]);
    const asked = await askBooks(owner, month);
    const waiting = await askBooks(owner, month);
    // The owner removes Manut AI in their Google account before approving.
    world.google.revokeAll();
    expect((await decide(owner.headers, asked.body.requestId!)).body.action).toBe("failed");
    expect(world.google.appends()).toEqual([]);
    // A second approval waiting on the broken connection is refused before Google is asked anything.
    const refreshes = world.google.tokenCalls("refresh_token").length;
    expect((await decide(owner.headers, waiting.body.requestId!)).body.action).toBe("failed");
    expect(world.google.tokenCalls("refresh_token").length).toBe(refreshes);
    const now = await status(owner);
    expect(now.connection).toMatchObject({ id: connectionId, state: "broken", broken: { reason: "invalid_grant",
      words: expect.stringContaining("Connect Google again") } });
    expect((await auditOf(shop)).filter((entry) => entry.action === "google.broken")).toEqual([
      expect.objectContaining({ subject: { connectionId }, outcome: "refused", reason: "invalid_grant" })]);

    // Nothing more is asked, and no token is refreshed, until the owner connects again.
    expect((await askBooks(owner, month)).body).toMatchObject({ outcome: "failed", reason: "google_broken" });
    expect(world.google.tokenCalls("refresh_token").length).toBe(refreshes);
    const mended = await connect(owner);
    expect((await status(owner)).connection).toMatchObject({ id: mended, state: "working" });
    // Connecting again keeps the sheet, and the practice days that already ran.
    expect((await askBooks(owner, month)).body.outcome).toBe("asked");
    expect(world.google.creates()).toHaveLength(1);
  });

  it("refuses an ask when the grant is refused at the ask, and breaks the connection then", async () => {
    const { shop, owner } = await readyShop();
    const month = lastMonth();
    await paidIn(shop, month, [{ orderRef: "SP-4", amountSatang: 2_500 }]);
    world.google.revokeAll();
    expect((await askBooks(owner, month)).body).toMatchObject({ outcome: "failed", reason: "google_broken" });
    expect((await status(owner)).connection?.state).toBe("broken");
    expect(await openApprovals(owner.headers)).toEqual([]);
  });

  it("lets only the owner approve, and shows a helper none of the books", async () => {
    const { shop, owner } = await readyShop();
    const helper = await joinHelper(shop);
    const month = lastMonth();
    await paidIn(shop, month, [{ orderRef: "SP-5", amountSatang: 35_000 }]);
    const asked = await askBooks(owner, month);
    expect(await decide(helper.headers, asked.body.requestId!)).toMatchObject({ status: 403,
      body: { error: "not_permitted" } });
    expect(world.google.appends()).toEqual([]);
    const [seen] = await openApprovals(helper.headers);
    expect(seen?.record.request.detail).toEqual({ actionId: asked.body.requestId, operationType: "google.sheets.append",
      month, sheet: { title: "Manut AI books: Baan Mali" }, ownerOnly: true,
      text: `Ton asks to append the books for ${month} to the owner's Google Sheet. Only the owner sees the books and can ` +
        "approve it." });
    expect(JSON.stringify(seen)).not.toContain("฿");
    expect(JSON.stringify(seen)).not.toContain("SP-5");
    const [ownerSees] = await openApprovals(owner.headers);
    expect((ownerSees!.record.request.detail as unknown as BooksDetail).totals.sales).toBe("฿350");
    expect((await decide(owner.headers, asked.body.requestId!)).body.action).toBe("confirmed");
  });

  it("never sends the Google token anywhere but Google, whatever operation a proposal names", async () => {
    const { shop, owner, connectionId } = await readyShop();
    const month = lastMonth();
    await paidIn(shop, month, [{ orderRef: "SP-6", amountSatang: 600 }]);
    expect((await askBooks(owner, month)).body.outcome).toBe("asked");
    const sheetId = (await status(owner)).connection!.sheet!.id;
    // The shop's own session proposes a Linear issue through the Google connection, inside its granted sheet, and
    // approves it on the older decision route, which an action that no request decides still takes.
    const session = await tenantSession(shop.tenant);
    const taskId = `books-escape-${crypto.randomUUID()}`;
    const created = await send("/v1/tasks", { method: "POST", headers: { ...session, "idempotency-key": taskId },
      body: { id: taskId, title: "t", objective: "o", state: "draft", location: "cloud", funding: "cloudBYOK",
        criteria: [], updatedAt: new Date().toISOString(), tenantId: shop.tenant } });
    expect(created.status).toBe(200);
    const proposed = await sendJson<ActionProposalJSON>(`/v1/tasks/${taskId}/actions`, { method: "POST",
      headers: session, body: { connectionId, providerAccountId: "google", operationType: "linear.issue.create",
        targetResourceId: sheetId, resourceScope: [sheetId], payload: { title: "Not for Linear" }, grantRevision: 2,
        expiresAt: new Date(Date.now() + 3600_000).toISOString() } });
    expect(proposed.status).toBe(200);
    expect((await send(`/v1/tasks/${taskId}/actions/${proposed.body.id}/decision`, { method: "POST", headers: session,
      body: { approve: true, by: "founder" } })).status).toBe(200);
    let sent = 0;
    const settled = await dispatchAction(googleEnv, taskId, proposed.body.id, { tenant: shop.tenant, grantRevision: 2,
      fetchImpl: async () => {
        sent++;
        return Response.json({ data: { issueCreate: { success: true, issue: { id: "x", identifier: "X-1", title: "t",
          url: "https://linear.app/x" } } } });
      } });
    expect(((await settled.json()) as ActionProposalJSON).state).toBe("failed");
    expect(sent).toBe(0);
    expect(world.google.tokenCalls("refresh_token")).toHaveLength(1);
  });

  it("asks only for a month that has ended and has something in it", async () => {
    const { shop, owner } = await readyShop();
    expect(await askBooks(owner, bangkokMonth(Date.now()))).toMatchObject({ status: 200,
      body: { outcome: "failed", reason: "month_not_over" } });
    expect(await askBooks(owner, "2026-13")).toEqual({ status: 400, body: { error: "invalid_month" } });
    const empty = await askBooks(owner, lastMonth());
    expect(empty.body).toMatchObject({ outcome: "done",
      draft: { text: `No payments were recorded in ${lastMonth()}, so there is nothing to append.` } });
    expect(world.google.creates()).toEqual([]);
    expect(await openApprovals(owner.headers)).toEqual([]);
    // The newest 500 payments must reach back past the month's start, or the month would be appended short.
    const payment = (confirmedAt: string): Payment => ({ id: "p", tenant: shop.tenant, orderRef: "r", amountSatang: 1,
      promptPayId: "x", confirmedAt });
    expect(monthIsWhole([payment("2026-10-15T00:00:00Z")], "2026-10")).toBe(true);
    expect(monthIsWhole(Array.from({ length: 500 }, () => payment("2026-10-02T00:00:00Z")), "2026-10")).toBe(false);
    expect(monthIsWhole([...Array.from({ length: 499 }, () => payment("2026-11-02T00:00:00Z")),
      payment("2026-09-30T00:00:00Z")], "2026-10")).toBe(true);
  });
});

describe("the words and the money", () => {
  it("writes amounts from integer satang, never through a float", () => {
    expect(bahtText(129033)).toBe("฿1,290.33");
    expect(bahtText(129030)).toBe("฿1,290.30");
    expect(bahtText(50000)).toBe("฿500");
    expect(bahtText(1)).toBe("฿0.01");
    expect(bahtText(0)).toBe("฿0");
    expect(bahtText(123456789)).toBe("฿1,234,567.89");
    expect(bahtText(-2005)).toBe("-฿20.05");
    // Ten sales of 10 satang and one of 20 add up exactly: 0.1 + 0.2 would not.
    const lines = [...Array.from({ length: 10 }, (_, index) => ({ date: "2026-10-01", ref: `A${index}`, kind: "sale" as const,
      channelOrCategory: "line", amountSatang: 10, beforeVatSatang: null, vatSatang: null })),
    { date: "2026-10-02", ref: "B", kind: "sale" as const, channelOrCategory: "line", amountSatang: 20,
      beforeVatSatang: null, vatSatang: null },
    { date: "2026-10-03", ref: "B", kind: "refund" as const, channelOrCategory: "", amountSatang: 5,
      beforeVatSatang: null, vatSatang: null }];
    expect(booksTotals(lines, false)).toEqual({ sales: { count: 11, satang: 120 }, refunds: { count: 1, satang: 5 },
      expenses: { count: 0, satang: 0 }, netSatang: 115, vat: null });
    expect(booksText({ sheet: { title: "Books \"2026\"", tab: "Books" }, month: "2026-10", vatRegistered: false, lines,
      flags: 1 })).toBe("Append the books for 2026-10 to the Google Sheet \"Books \\\"2026\\\"\", tab \"Books\": a header " +
      "row, then 12 rows. Sales ฿1.20 (11 entries), refunds ฿0.05 (1), expenses ฿0 (0), net sales ฿1.15. Ton flagged " +
      "1 entry for you to check.");
    // A VAT-registered shop's request names net sales before VAT and the VAT, each from its rows' integer satang.
    const vatLines = [{ date: "2026-10-01", ref: "V1", kind: "sale" as const, channelOrCategory: "line",
      amountSatang: 10700, beforeVatSatang: 10000, vatSatang: 700 }];
    expect(booksText({ sheet: { title: "T", tab: "Books" }, month: "2026-10", vatRegistered: true, lines: vatLines,
      flags: 0 })).toContain("Net sales before VAT ฿100, VAT ฿7.");
  });

  it("takes only a whole, exact payload: rows in the month, positive integer satang, and no field more", () => {
    const line = { date: "2026-10-01", ref: "SP-1", kind: "sale", channelOrCategory: "line", amountSatang: 100,
      beforeVatSatang: null, vatSatang: null };
    const payload = { sheet: { id: "abc_DEF-123", title: "Books", tab: "Books" }, month: "2026-10", vatRegistered: false,
      lines: [line], flags: 0 };
    expect(booksPayloadOf(payload)).toEqual(payload);
    for (const bad of [
      { ...payload, extra: 1 },
      { ...payload, lines: [] },
      { ...payload, lines: [{ ...line, amountSatang: 1.5 }] },
      { ...payload, lines: [{ ...line, amountSatang: 0 }] },
      { ...payload, lines: [{ ...line, date: "2026-11-01" }] },
      { ...payload, lines: [{ ...line, vatSatang: 7 }] },
      { ...payload, lines: [{ ...line, note: "x" }] },
      { ...payload, vatRegistered: true },
      { ...payload, sheet: { ...payload.sheet, id: "../other" } },
      { ...payload, month: "2026-1" },
    ]) {
      expect(booksPayloadOf(bad)).toBeNull();
    }
  });
});
