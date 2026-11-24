import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bangkokDate, booksPayloadOf, booksText, earlierText, type BooksDetail } from "../src/books-detail";
import { earlierOf } from "../src/books-sheet";
import { MAX_APPENDS, type SheetRef } from "../src/google-vault";
import {
  askBooks,
  auditOf,
  connect,
  decide,
  holdsNoToken,
  installGoogle,
  lastMonth,
  openApprovals,
  paidIn,
  readyShop,
  status,
  vaultPost,
  vaultRecords,
  world,
} from "./google-fixtures";
import { joinHelper, linkedOwner, setupShop, type Owner } from "./people-fixtures";

// A month already sent to the owner's Google Sheet is never asked for again silently (docs/pilot-api.md, "Google Sheets
// for Ton's books"; docs/decisions.md): the sheet's record in the vault keeps what was appended (the month, when, how many
// rows and how it ended, never the rows), the request says so first when the month went before, whether Google confirmed
// it or left it open, and the send checks the record once more so two requests for one month cannot both write it
// unannounced. End to end in real workerd against the real objects, with Google the fake in google-fake.ts.

beforeEach(() => installGoogle());

afterEach(() => {
  expect(world.google.elsewhere).toEqual([]);
  vi.restoreAllMocks();
});

const TWO_PAYMENTS = [{ orderRef: "SP-2291", amountSatang: 129033 }, { orderRef: "SP-2292", amountSatang: 75050 }];

/// The detail of the open request `requestId`, as the owner's app reads it.
async function detailOf(owner: Owner, requestId: string): Promise<BooksDetail> {
  const found = (await openApprovals(owner.headers)).find((entry) => entry.record.request.id === requestId);
  expect(found).toBeDefined();
  return found!.record.request.detail as unknown as BooksDetail;
}

/// The months the owner's app sees on the sheet.
async function appended(owner: Owner) {
  return (await status(owner)).connection?.sheet?.appended ?? [];
}

describe("a month already sent", () => {
  it("is asked for again only with the earlier send said first, and goes again when the owner approves that", async () => {
    const { shop, owner } = await readyShop();
    const helper = await joinHelper(shop);
    const month = lastMonth();
    await paidIn(shop, month, TWO_PAYMENTS);

    const first = await askBooks(owner, month);
    expect(first.body.outcome).toBe("asked");
    const firstDetail = await detailOf(owner, first.body.requestId!);
    expect(firstDetail.earlier).toBeNull();
    expect(firstDetail.text).toMatch(/^Append the books for /);
    expect((await decide(owner.headers, first.body.requestId!)).body.action).toBe("confirmed");
    const [sent] = await appended(owner);
    expect(sent).toEqual({ month, at: expect.any(String), rows: 2, outcome: "confirmed" });

    // Asked for again, the request says first that it went, on which day, how many rows, and that approving adds them again.
    const second = await askBooks(owner, month);
    expect(second.body).toMatchObject({ outcome: "asked", kind: "command" });
    const detail = await detailOf(owner, second.body.requestId!);
    const day = bangkokDate(sent!.at);
    expect(detail.earlier).toEqual({ count: 1, at: sent!.at, rows: 2, outcome: "confirmed" });
    expect(detail.text).toBe(`Already sent: this month went to the sheet on ${day} (2 rows) and Google confirmed it. ` +
      `Approving adds its rows a second time. ${firstDetail.text}`);
    // It is part of what is approved, so a different history is a different request.
    expect(detail.payloadHash).not.toBe(firstDetail.payloadHash);

    // A helper is told what it always was: that the owner decides, for which month and sheet, and nothing of the books.
    const seen = (await openApprovals(helper.headers)).find((entry) => entry.record.request.id === second.body.requestId);
    expect(seen?.record.request.detail).toEqual({ actionId: second.body.requestId, operationType: "google.sheets.append",
      month, sheet: { title: "Manut AI books: Baan Mali" }, ownerOnly: true,
      text: `Ton asks to append the books for ${month} to the owner's Google Sheet. Only the owner sees the books and can ` +
        "approve it." });

    // The owner chose it: the rows go a second time, and the record now holds both, the newest first for the app.
    expect((await decide(owner.headers, second.body.requestId!)).body.action).toBe("confirmed");
    expect(world.google.appends()).toHaveLength(2);
    expect((await appended(owner)).map((entry) => [entry.month, entry.rows, entry.outcome])).toEqual([
      [month, 2, "confirmed"], [month, 2, "confirmed"]]);

    // A third ask counts both.
    const third = await askBooks(owner, month);
    const thirdDetail = await detailOf(owner, third.body.requestId!);
    expect(thirdDetail.earlier).toMatchObject({ count: 2, rows: 2, outcome: "confirmed" });
    expect(thirdDetail.text).toContain("this month went to the sheet 2 times, the last on ");
    expect(thirdDetail.text).toContain("Approving adds its rows again.");
  });

  it("is asked for again, after a send whose answer was lost, with the doubt said first", async () => {
    for (const answer of [503, "throw"] as const) {
      const { shop, owner } = await readyShop();
      const month = lastMonth();
      await paidIn(shop, month, [{ orderRef: "SP-9", amountSatang: 9_900 }]);
      const asked = await askBooks(owner, month);
      world.google.appendAnswer = answer;
      expect((await decide(owner.headers, asked.body.requestId!)).body.action).toBe("unknown");
      world.google.appendAnswer = "ok";
      const [sent] = await appended(owner);
      expect(sent).toEqual({ month, at: expect.any(String), rows: 1, outcome: "unknown" });

      const again = await askBooks(owner, month);
      expect(again.body.outcome).toBe("asked");
      const detail = await detailOf(owner, again.body.requestId!);
      expect(detail.earlier).toEqual({ count: 1, at: sent!.at, rows: 1, outcome: "unknown" });
      expect(detail.text).toMatch(new RegExp(`^Maybe already sent: this month went to the sheet on ${bangkokDate(sent!.at)} ` +
        "\\(1 row\\), but Google did not say whether the rows arrived\\. Look in the sheet first: approving adds its rows a " +
        "second time, so they would be there twice if they had arrived\\. Append the books"));

      // The owner looked: the rows are not in the sheet (Google never applied them), so they approve, and it goes.
      expect((await decide(owner.headers, again.body.requestId!)).body.action).toBe("confirmed");
      expect((await appended(owner)).map((entry) => entry.outcome)).toEqual(["confirmed", "unknown"]);
      expect([...world.google.sheets.values()][0]!.rows).toHaveLength(2);
    }
  });

  it("cannot be sent by a request asked before another send of it, and the owner is asked again with that said", async () => {
    const { shop, owner } = await readyShop();
    const month = lastMonth();
    await paidIn(shop, month, TWO_PAYMENTS);
    // Two requests for one month, both asked before either was sent: neither could tell of the other.
    const a = await askBooks(owner, month);
    const b = await askBooks(owner, month);
    expect([a.body.outcome, b.body.outcome]).toEqual(["asked", "asked"]);
    expect((await detailOf(owner, a.body.requestId!)).earlier).toBeNull();
    expect((await detailOf(owner, b.body.requestId!)).earlier).toBeNull();

    expect((await decide(owner.headers, a.body.requestId!)).body.action).toBe("confirmed");
    // The second owner decision was made on a request that did not say the month had gone: nothing is sent.
    expect((await decide(owner.headers, b.body.requestId!)).body.action).toBe("failed");
    expect(world.google.appends()).toHaveLength(1);
    expect((await appended(owner))).toHaveLength(1);
    expect((await auditOf(shop)).filter((entry) => entry.action === "google.appended")).toEqual([
      expect.objectContaining({ subject: expect.objectContaining({ actionId: b.body.requestId }), outcome: "failed",
        reason: "month_already_sent" }),
      expect.objectContaining({ subject: expect.objectContaining({ actionId: a.body.requestId }), outcome: "confirmed" })]);

    // Asked again, it names the send that happened, and the owner's yes then is a choice.
    const c = await askBooks(owner, month);
    expect((await detailOf(owner, c.body.requestId!)).earlier).toMatchObject({ count: 1, outcome: "confirmed" });
    expect((await decide(owner.headers, c.body.requestId!)).body.action).toBe("confirmed");
    expect(world.google.appends()).toHaveLength(2);
  });

  it("is not on record when Google refused the append before applying it, so nothing is said of it", async () => {
    const { shop, owner } = await readyShop();
    const month = lastMonth();
    await paidIn(shop, month, TWO_PAYMENTS);
    const asked = await askBooks(owner, month);
    world.google.appendAnswer = 400;
    expect((await decide(owner.headers, asked.body.requestId!)).body.action).toBe("failed");
    world.google.appendAnswer = "ok";
    expect(await appended(owner)).toEqual([]);
    const again = await askBooks(owner, month);
    expect((await detailOf(owner, again.body.requestId!)).earlier).toBeNull();
    expect((await decide(owner.headers, again.body.requestId!)).body.action).toBe("confirmed");
    expect(await appended(owner)).toHaveLength(1);
  });

  it("counts a send that never reported back as sent, with its answer unknown", async () => {
    const { shop, owner, connectionId } = await readyShop();
    const month = lastMonth();
    await paidIn(shop, month, TWO_PAYMENTS);
    const asked = await askBooks(owner, month);
    const sheetId = (await status(owner)).connection!.sheet!.id;
    // The Worker stopped after the append began and before its end was written: nobody ever says how it went.
    expect(await vaultPost(shop, "/google/append-begin", { id: connectionId, sheet: sheetId, month, rows: 2,
      actionId: "lost-send", known: 0 })).toEqual({ status: 200, body: { begun: true } });
    expect(await appended(owner)).toEqual([{ month, at: expect.any(String), rows: 2, outcome: "unknown" }]);
    // The request asked before it cannot send, and a new ask tells of it.
    expect((await decide(owner.headers, asked.body.requestId!)).body.action).toBe("failed");
    expect(world.google.appends()).toEqual([]);
    const again = await askBooks(owner, month);
    expect((await detailOf(owner, again.body.requestId!)).earlier).toMatchObject({ count: 1, rows: 2, outcome: "unknown" });
  });

  it("goes with the sheet: kept when the owner connects again, and a new sheet starts with none", async () => {
    const { shop, owner } = await readyShop();
    const month = lastMonth();
    await paidIn(shop, month, TWO_PAYMENTS);
    const asked = await askBooks(owner, month);
    expect((await decide(owner.headers, asked.body.requestId!)).body.action).toBe("confirmed");
    const sheetId = (await status(owner)).connection!.sheet!.id;

    // Connecting again carries the sheet over with what was sent to it.
    const mended = await connect(owner);
    expect((await status(owner)).connection).toMatchObject({ id: mended, sheet: { id: sheetId } });
    expect(await appended(owner)).toHaveLength(1);
    const again = await askBooks(owner, month);
    expect((await detailOf(owner, again.body.requestId!)).earlier).toMatchObject({ count: 1, outcome: "confirmed" });

    // The owner deletes the sheet in their Drive: the next ask makes a new one, which holds none of the rows, so it is
    // asked for as a month never sent.
    world.google.sheets.delete(sheetId);
    const fresh = await askBooks(owner, month);
    expect(fresh.body.outcome).toBe("asked");
    expect(world.google.creates()).toHaveLength(2);
    expect((await detailOf(owner, fresh.body.requestId!)).earlier).toBeNull();
    expect(await appended(owner)).toEqual([]);
  });

  it("keeps only what was appended, never the rows, and lists the newest months first", async () => {
    const { shop, owner } = await readyShop();
    const month = lastMonth();
    await paidIn(shop, month, TWO_PAYMENTS);
    const asked = await askBooks(owner, month);
    expect((await decide(owner.headers, asked.body.requestId!)).body.action).toBe("confirmed");
    const stored = JSON.stringify(await vaultRecords(shop));
    for (const row of ["SP-2291", "SP-2292", "129033", "75050", "1290.33", "฿"]) expect(stored).not.toContain(row);
    const record = Object.values(await vaultRecords(shop)).find((entry) => entry.provider === "gsheets" && !entry.revokedAt)!;
    expect((record.sheet as SheetRef).appends).toEqual([{ actionId: asked.body.requestId, month, at: expect.any(String),
      rows: 2, outcome: "confirmed" }]);
    holdsNoToken(stored);
  });
});

describe("the vault's record of what was appended", () => {
  async function sheetShop() {
    const shop = await setupShop();
    const owner = await linkedOwner(shop);
    const id = await connect(owner);
    const claimed = await vaultPost(shop, "/google/sheet-claim", { id, replacing: null });
    const sheet = { id: "sheet_1", title: "Manut AI books: Baan Mali", tab: "Books", url: null };
    expect((await vaultPost(shop, "/google/sheet", { id, claim: claimed.body.claim, sheet })).status).toBe(200);
    return { shop, owner, id };
  }

  it("begins an append once, only when the month was sent as often as the request said, and ends it once", async () => {
    const { shop, owner, id } = await sheetShop();
    const begin = (over: Record<string, unknown> = {}) => vaultPost(shop, "/google/append-begin",
      { id, sheet: "sheet_1", month: "2026-10", rows: 3, actionId: "a-1", known: 0, ...over });

    expect(await begin()).toEqual({ status: 200, body: { begun: true } });
    // The same action never begins twice, and a request that knew of no earlier send cannot send after one began.
    expect(await begin()).toEqual({ status: 409, body: { error: "already_begun" } });
    expect(await begin({ actionId: "a-2" })).toEqual({ status: 409, body: { error: "month_changed", sent: 1 } });
    // One that was told of exactly the one send may go, and a request told of more than there were may not.
    expect(await begin({ actionId: "a-2", known: 2 })).toEqual({ status: 409, body: { error: "month_changed", sent: 1 } });
    expect(await begin({ actionId: "a-2", known: 1 })).toEqual({ status: 200, body: { begun: true } });
    // Another month has its own count.
    expect(await begin({ actionId: "b-1", month: "2026-09", rows: 1 })).toEqual({ status: 200, body: { begun: true } });
    expect(await begin({ sheet: "sheet_2", actionId: "c-1" })).toEqual({ status: 409, body: { error: "sheet_changed" } });

    // Sending shows as unknown to the app until it ends; a refusal before Google applied it takes the entry out.
    expect((await appended(owner)).map((entry) => [entry.month, entry.outcome])).toEqual([
      ["2026-09", "unknown"], ["2026-10", "unknown"], ["2026-10", "unknown"]]);
    const end = (actionId: string, outcome: string) => vaultPost(shop, "/google/append-end", { id, actionId, outcome });
    expect(await end("a-1", "confirmed")).toEqual({ status: 200, body: { ended: true } });
    expect(await end("a-1", "unknown")).toEqual({ status: 200, body: { ended: false } });
    expect(await end("a-2", "failed")).toEqual({ status: 200, body: { ended: true } });
    expect(await end("a-2", "failed")).toEqual({ status: 404, body: { error: "not_found" } });
    expect((await appended(owner)).map((entry) => [entry.month, entry.rows, entry.outcome])).toEqual([
      ["2026-09", 1, "unknown"], ["2026-10", 3, "confirmed"]]);

    // Nothing begins once the connection broke.
    expect(await vaultPost(shop, "/google/broken", { id, reason: "invalid_grant" })).toMatchObject({ status: 200 });
    expect(await begin({ actionId: "d-1", month: "2026-08", known: 0 })).toEqual({ status: 409,
      body: { error: "connection_broken" } });
  });

  it("answers only the Worker's own calls, and only well-formed ones", async () => {
    const { shop, id } = await sheetShop();
    const good = { id, sheet: "sheet_1", month: "2026-10", rows: 3, actionId: "a-1", known: 0 };
    expect((await vaultPost(shop, "/google/append-begin", good, {})).status).toBe(403);
    expect((await vaultPost(shop, "/google/append-end", { id, actionId: "a-1", outcome: "confirmed" }, {})).status).toBe(403);
    for (const bad of [{ ...good, extra: 1 }, { ...good, sheet: "../x" }, { ...good, month: "2026-13" }, { ...good, rows: 0 },
      { ...good, rows: 1001 }, { ...good, rows: 1.5 }, { ...good, actionId: "" }, { ...good, known: -1 },
      { ...good, known: MAX_APPENDS + 1 }, { id, sheet: "sheet_1" }]) {
      expect(await vaultPost(shop, "/google/append-begin", bad), JSON.stringify(bad)).toEqual({ status: 400,
        body: { error: "invalid_request" } });
    }
    for (const bad of [{ id, actionId: "a-1", outcome: "sending" }, { id, actionId: "a-1", outcome: "done" },
      { id, actionId: "", outcome: "confirmed" }, { id, actionId: "a-1" }]) {
      expect(await vaultPost(shop, "/google/append-end", bad), JSON.stringify(bad)).toEqual({ status: 400,
        body: { error: "invalid_request" } });
    }
    // A connection that is not this shop's live Google connection reads as missing.
    expect((await vaultPost(shop, "/google/append-begin", { ...good, id: "nope" })).status).toBe(404);
    expect((await vaultPost(shop, "/google/append-end", { id: "nope", actionId: "a-1", outcome: "confirmed" })).status).toBe(404);
    const other = await setupShop("Another");
    expect((await vaultPost(other, "/google/append-begin", good)).status).toBe(404);
  });

  it("keeps the newest appends, and lists the newest two years to the app", async () => {
    const { shop, owner, id } = await sheetShop();
    const months = Array.from({ length: MAX_APPENDS + 5 }, (_, index) =>
      `${2000 + Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, "0")}`);
    for (const [index, month] of months.entries()) {
      expect((await vaultPost(shop, "/google/append-begin", { id, sheet: "sheet_1", month, rows: 1, actionId: `m-${index}`,
        known: 0 })).status).toBe(200);
    }
    const record = Object.values(await vaultRecords(shop)).find((entry) => entry.provider === "gsheets" && !entry.revokedAt)!;
    const kept = (record.sheet as SheetRef).appends!;
    expect(kept).toHaveLength(MAX_APPENDS);
    expect(kept[0]!.month).toBe(months[5]);
    expect(kept[kept.length - 1]!.month).toBe(months[months.length - 1]);
    const listed = await appended(owner);
    expect(listed).toHaveLength(24);
    expect(listed[0]!.month).toBe(months[months.length - 1]);
  });
});

describe("the words and the payload", () => {
  const line = { date: "2026-10-01", ref: "SP-1", kind: "sale" as const, channelOrCategory: "line", amountSatang: 100,
    beforeVatSatang: null, vatSatang: null };
  const sheet = { id: "abc_DEF-123", title: "Books", tab: "Books" };
  const payload = { sheet, month: "2026-10", vatRegistered: false, lines: [line], flags: 0, earlier: null };
  const at = "2026-11-03T05:30:00.000Z";

  it("says the day as the shop's calendar does, in Bangkok", () => {
    expect(bangkokDate("2026-11-03T05:30:00.000Z")).toBe("2026-11-03");
    // 20:00 UTC is already the next day in Bangkok.
    expect(bangkokDate("2026-11-03T20:00:00.000Z")).toBe("2026-11-04");
    expect(bangkokDate("2026-12-31T17:00:00.000Z")).toBe("2027-01-01");
  });

  it("words an earlier send by how many times, how it ended and what approving does", () => {
    expect(earlierText({ count: 1, at, rows: 41, outcome: "confirmed" })).toBe(
      "Already sent: this month went to the sheet on 2026-11-03 (41 rows) and Google confirmed it. Approving adds its rows a second time.");
    expect(earlierText({ count: 1, at, rows: 1, outcome: "unknown" })).toBe(
      "Maybe already sent: this month went to the sheet on 2026-11-03 (1 row), but Google did not say whether the rows " +
      "arrived. Look in the sheet first: approving adds its rows a second time, so they would be there twice if they had arrived.");
    expect(earlierText({ count: 3, at, rows: 41, outcome: "confirmed" })).toBe(
      "Already sent: this month went to the sheet 3 times, the last on 2026-11-03 (41 rows) and Google confirmed it. Approving adds its rows again.");
    // Said first, before the books it is about; a month never sent says nothing of it.
    expect(booksText({ ...payload, earlier: { count: 1, at, rows: 1, outcome: "confirmed" } })).toMatch(
      /^Already sent: .* Approving adds its rows a second time\. Append the books for 2026-10 /);
    expect(booksText(payload)).toMatch(/^Append the books for 2026-10 /);
    expect(booksText(payload)).not.toContain("sent");
  });

  it("takes an `earlier` only whole, with the other fields exactly as before", () => {
    expect(booksPayloadOf(payload)).toEqual(payload);
    const earlier = { count: 2, at, rows: 3, outcome: "unknown" };
    expect(booksPayloadOf({ ...payload, earlier })).toEqual({ ...payload, earlier });
    for (const bad of [
      { ...payload, earlier: undefined },
      { ...payload, earlier: { ...earlier, extra: 1 } },
      { ...payload, earlier: { ...earlier, count: 0 } },
      { ...payload, earlier: { ...earlier, count: 1.5 } },
      { ...payload, earlier: { ...earlier, rows: 0 } },
      { ...payload, earlier: { ...earlier, rows: 1001 } },
      { ...payload, earlier: { ...earlier, at: "yesterday" } },
      { ...payload, earlier: { ...earlier, at: "2026-11-03T05:30:00+07:00" } },
      { ...payload, earlier: { ...earlier, outcome: "sending" } },
      { ...payload, earlier: { ...earlier, outcome: "failed" } },
      { ...payload, earlier: { count: 1, at, rows: 1 } },
      { ...payload, earlier: "once" },
    ]) {
      expect(booksPayloadOf(bad), JSON.stringify(bad)).toBeNull();
    }
    const { earlier: _left, ...without } = payload;
    expect(booksPayloadOf(without)).toBeNull();
  });

  it("reads what the sheet's record says of a month, and only for the sheet the request names", () => {
    const sheetRef = (appends: SheetRef["appends"]): SheetRef => ({ id: "s1", title: "t", tab: "Books", url: null,
      madeAt: at, ...(appends ? { appends } : {}) });
    const entry = (month: string, outcome: "sending" | "confirmed" | "unknown", when = at, rows = 2) =>
      ({ actionId: `${month}-${when}`, month, at: when, rows, outcome });
    expect(earlierOf(null, "s1", "2026-10")).toBeNull();
    expect(earlierOf(sheetRef(undefined), "s1", "2026-10")).toBeNull();
    expect(earlierOf(sheetRef([entry("2026-09", "confirmed")]), "s1", "2026-10")).toBeNull();
    const sent = sheetRef([entry("2026-10", "unknown", "2026-11-01T00:00:00.000Z", 4), entry("2026-09", "confirmed"),
      entry("2026-10", "confirmed", "2026-11-03T05:30:00.000Z", 5)]);
    expect(earlierOf(sent, "s1", "2026-10")).toEqual({ count: 2, at: "2026-11-03T05:30:00.000Z", rows: 5,
      outcome: "confirmed" });
    // A send still on its way, or never answered, reads as unknown.
    expect(earlierOf(sheetRef([entry("2026-10", "sending")]), "s1", "2026-10")).toMatchObject({ outcome: "unknown" });
    // A request that names another sheet (a new one was made) has no earlier send to tell of.
    expect(earlierOf(sent, "s2", "2026-10")).toBeNull();
  });
});
