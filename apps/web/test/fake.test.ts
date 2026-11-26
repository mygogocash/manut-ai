import { describe, expect, it } from "vitest";
import { checkRoutine, describeTrigger, nextRun } from "@manut/routine-rules";
import { isAwaitingOwner, MAX_ROUTINES, ROUTINE_WORK, type AuditEntry, type AwaitingOwner, type DeletedShop, type NewRoutine } from "../src/api";
import { auditReasonText, auditSentence } from "../src/ops/words";
// The API's own words for what a credential looks like, read as text: it cannot be imported (it runs in the Worker), and a
// credential the console's practice world makes must be one the API would accept.
import browserControlSource from "../../api/src/browser-control.ts?raw";
// The API's routines, read as text (they run in the Worker): the practice world's routine ids, and what each shop template's routines
// are made of, must be what the API makes. The templates themselves are the package's own, which this test can import.
import routineSetupSource from "../../api/src/routine-setup.ts?raw";
import routineStoreSource from "../../api/src/routine-store.ts?raw";
import routinesSource from "../../api/src/routines.ts?raw";
import { templates as packageTemplates } from "../../../packages/shop-templates/src/index";
import { apiList } from "./apiAuditLog";
import {
  createFakeApi, DEMO_DELETION_TOKENS, DEMO_TOKENS, lineSignature, PRACTICE_CHANNEL_SECRET, PRACTICE_OWNER_CODES,
} from "../src/api/fake";

function tokenOf(url: string): string {
  return decodeURIComponent(url.split("/approve/")[1] ?? "");
}

function deletionTokenOf(url: string): string {
  return decodeURIComponent(url.split("/delete/")[1] ?? "");
}

function asked(answer: DeletedShop | AwaitingOwner): AwaitingOwner {
  if (!isAwaitingOwner(answer)) throw new Error(`expected the owner to be asked, got ${JSON.stringify(answer)}`);
  return answer;
}

describe("the in-memory fake", () => {
  it("keeps the contract's rules from proposal to a settled send", async () => {
    let now = Date.parse("2026-11-23T03:00:00Z");
    const api = createFakeApi({ now: () => now, settleMs: 3000, webOrigin: "https://web.test" });

    const messages = await api.listMessages("shop_baanmali");
    expect(messages.map((m) => m.receivedAt)).toEqual([...messages.map((m) => m.receivedAt)].sort().reverse());
    const arthit = messages.find((m) => m.displayName === "Khun Arthit");
    expect(arthit?.replyActionId).toBeUndefined();

    const proposed = await api.proposeReply({ tenant: "shop_baanmali", messageId: arthit!.id, text: "ขออภัยค่ะ" });
    expect(proposed.approvalUrl.startsWith("https://web.test/approve/")).toBe(true);
    expect(Date.parse(proposed.expiresAt) - now).toBe(24 * 60 * 60 * 1000);
    const token = tokenOf(proposed.approvalUrl);

    const view = await api.getApproval(token);
    expect(view).toMatchObject({ shopName: "Baan Mali", customerName: "Khun Arthit", replyText: "ขออภัยค่ะ", state: "proposed", needsConsent: true });

    await expect(api.decide(token, true)).rejects.toMatchObject({ status: 403, code: "consent_required" });
    expect((await api.giveConsent(token)).needsConsent).toBe(false);
    expect((await api.decide(token, true)).state).toBe("dispatching");
    await expect(api.decide(token, false)).rejects.toMatchObject({ status: 409, code: "already_decided" });

    expect((await api.getApproval(token)).state).toBe("dispatching");
    now += 3000;
    expect((await api.getApproval(token)).state).toBe("confirmed");
    const action = (await api.listActions("shop_baanmali")).find((a) => a.actionId === proposed.actionId);
    expect(action).toMatchObject({ state: "confirmed", messageId: arthit!.id });
    expect(action?.dispatchedAt).toBeDefined();
  });

  it("answers the demo links in every state", async () => {
    const api = createFakeApi();
    await expect(api.getApproval(DEMO_TOKENS.expiredLink)).rejects.toMatchObject({ status: 410, code: "link_expired" });
    await expect(api.getApproval("nope")).rejects.toMatchObject({ status: 404, code: "link_invalid" });
    expect((await api.getApproval(DEMO_TOKENS.sent)).state).toBe("confirmed");
    expect((await api.getApproval(DEMO_TOKENS.declined)).state).toBe("rejected");
    expect((await api.getApproval(DEMO_TOKENS.expiredRequest)).state).toBe("expired");
  });

  it("exports a shop without secrets or link tokens, and deletes it only by its exact name once its owner says yes", async () => {
    const api = createFakeApi({ webOrigin: "https://web.test" });
    const [message] = await api.listMessages("shop_baanmali");
    const proposed = await api.proposeReply({ tenant: "shop_baanmali", messageId: message!.id, text: "ได้ค่ะ" });
    const token = tokenOf(proposed.approvalUrl);

    const exported = await api.exportShop("shop_baanmali");
    expect(exported.tenant).toBe("shop_baanmali");
    const saved = JSON.stringify(exported);
    expect(saved).toContain(message!.text);
    expect(saved).not.toContain(PRACTICE_CHANNEL_SECRET);
    expect(saved).not.toContain(token);

    await expect(api.deleteShop({ tenant: "shop_baanmali", confirmName: "Baan" })).rejects.toMatchObject({
      status: 409,
      code: "name_mismatch",
    });
    expect((await api.getApproval(token)).state).toBe("proposed");

    const link = asked(await api.deleteShop({ tenant: "shop_baanmali", confirmName: "Baan Mali" }));
    expect((await api.getApproval(token)).state).toBe("proposed");
    expect(await api.decideDeletion(deletionTokenOf(link.confirmUrl), true)).toMatchObject({ state: "deleted" });
    await expect(api.getApproval(token)).rejects.toMatchObject({ status: 404, code: "link_invalid" });
    expect((await api.listShops()).map((shop) => shop.tenant)).toEqual(["shop_sabaitea"]);
    await expect(api.exportShop("shop_baanmali")).rejects.toMatchObject({ status: 404, code: "tenant_deleted" });
  });

  it("refuses admin calls without an operator key", async () => {
    const api = createFakeApi({ operatorKey: () => null });
    await expect(api.listShops()).rejects.toMatchObject({ status: 403, code: "forbidden" });
  });
});

describe("the fake, deleting shops as the API does", () => {
  const NOW = Date.parse("2026-11-23T03:00:00Z");
  const fake = (now = () => NOW) => createFakeApi({ now, webOrigin: "https://web.test" });

  it("deletes a shop that never went live at once, and says when and by whom afterwards", async () => {
    const api = fake();
    const deleted = await api.deleteShop({ tenant: "shop_sabaitea", confirmName: "Sabai Tea" });
    expect(deleted).toEqual({ tasksWiped: 0, connectionsWiped: 0, schedulesWiped: 0, occurrencesWiped: 0,
      sessionsWiped: 0, deletedAt: "2026-11-23T03:00:00.000Z" });
    // Like the API: a deleted shop is tenant_deleted, with when and who (null for the practice key), and a tenant
    // that was never a shop is shop_not_found.
    for (const call of [() => api.listMessages("shop_sabaitea"), () => api.exportShop("shop_sabaitea"),
      () => api.deleteShop({ tenant: "shop_sabaitea", confirmName: "Sabai Tea" })]) {
      const gone = await call().catch((e: unknown) => e);
      expect(gone).toMatchObject({ status: 404, code: "tenant_deleted", deletedAt: "2026-11-23T03:00:00.000Z",
        deletedBy: null });
    }
    await expect(api.listMessages("shop_nobody")).rejects.toMatchObject({ status: 404, code: "shop_not_found" });
    await expect(api.recordPayment({ tenant: "shop_nobody", orderRef: "X", amountSatang: 100, promptPayId: "0812345678" }))
      .rejects.toMatchObject({ status: 404, code: "shop_not_found" });
  });

  it("matches the typed name however its outer spaces and accents were entered, as the API does", async () => {
    const api = fake();
    const created = await api.createShop({ name: "  Café Lek  ", ownerName: " Khun Lek " });
    expect(created.name).toBe("Café Lek");
    await expect(api.deleteShop({ tenant: created.tenant, confirmName: "Cafe Lek" })).rejects.toMatchObject({
      status: 409, code: "name_mismatch" });
    // An e followed by a combining acute accent, with stray outer spaces: the same name to anyone reading it.
    const decomposed = " Café Lek ";
    expect(await api.deleteShop({ tenant: created.tenant, confirmName: decomposed })).toMatchObject({ tasksWiped: 0 });
  });

  it("asks the owner of a live shop with one link, shows what goes, and deletes on their yes", async () => {
    const api = fake();
    const link = asked(await api.deleteShop({ tenant: "shop_baanmali", confirmName: "Baan Mali" }));
    expect(link).toEqual({ status: "awaiting_owner", confirmUrl: expect.stringMatching(/^https:\/\/web\.test\/delete\//),
      expiresAt: "2026-11-24T03:00:00.000Z" });
    expect(await api.deleteShop({ tenant: "shop_baanmali", confirmName: "Baan Mali" })).toEqual(link);
    expect((await api.listShops()).find((shop) => shop.tenant === "shop_baanmali")?.deletion).toEqual({
      state: "awaiting_owner", confirmUrl: link.confirmUrl, expiresAt: link.expiresAt });
    expect(await api.listMessages("shop_baanmali")).toHaveLength(7);

    const token = deletionTokenOf(link.confirmUrl);
    expect(await api.getDeletion(token)).toEqual({ shopName: "Baan Mali",
      goes: { messages: 7, replies: 6, payments: 2, lineConnected: true }, state: "awaiting_owner",
      expiresAt: link.expiresAt });
    const done = await api.decideDeletion(token, true);
    expect(done).toEqual({ shopName: "Baan Mali", goes: { messages: 7, replies: 6, payments: 2, lineConnected: true },
      state: "deleted", expiresAt: link.expiresAt, decidedAt: "2026-11-23T03:00:00.000Z" });
    expect(await api.getDeletion(token)).toEqual(done);
    const second = await api.decideDeletion(token, false).catch((e: unknown) => e);
    expect(second).toMatchObject({ status: 409, code: "already_decided", deletionView: done });
    await expect(api.listMessages("shop_baanmali")).rejects.toMatchObject({ code: "tenant_deleted" });
  });

  it("counts the owner's consent alone as live", async () => {
    const api = fake();
    const created = await api.createShop({ name: "Khao Man Gai", ownerName: "Lek" });
    expect(await api.deleteShop({ tenant: created.tenant, confirmName: "Khao Man Gai" })).toMatchObject({ tasksWiped: 0 });
    const message = (await api.listMessages("shop_baanmali"))[0]!;
    const reply = await api.proposeReply({ tenant: "shop_baanmali", messageId: message.id, text: "ได้ค่ะ" });
    await api.giveConsent(tokenOf(reply.approvalUrl));
    expect(isAwaitingOwner(await api.deleteShop({ tenant: "shop_baanmali", confirmName: "Baan Mali" }))).toBe(true);
  });

  it("keeps the data when the owner says no, and a new request asks again with a new link", async () => {
    const api = fake();
    const first = asked(await api.deleteShop({ tenant: "shop_baanmali", confirmName: "Baan Mali" }));
    const kept = await api.decideDeletion(deletionTokenOf(first.confirmUrl), false);
    expect(kept).toMatchObject({ state: "declined", decidedAt: "2026-11-23T03:00:00.000Z" });
    expect(await api.listMessages("shop_baanmali")).toHaveLength(7);
    expect((await api.listShops()).find((shop) => shop.tenant === "shop_baanmali")?.deletion).toEqual({
      state: "declined", confirmUrl: first.confirmUrl, expiresAt: first.expiresAt, decidedAt: kept.decidedAt });
    const again = asked(await api.deleteShop({ tenant: "shop_baanmali", confirmName: "Baan Mali" }));
    expect(again.confirmUrl).not.toBe(first.confirmUrl);
    expect((await api.getDeletion(deletionTokenOf(first.confirmUrl))).state).toBe("declined");
    expect((await api.getDeletion(deletionTokenOf(again.confirmUrl))).state).toBe("awaiting_owner");
  });

  it("lets a link expire with its confirmation, and then opens a new one", async () => {
    let now = NOW;
    const api = fake(() => now);
    const first = asked(await api.deleteShop({ tenant: "shop_baanmali", confirmName: "Baan Mali" }));
    now += 24 * 60 * 60 * 1000;
    await expect(api.getDeletion(deletionTokenOf(first.confirmUrl))).rejects.toMatchObject({ status: 410,
      code: "link_expired" });
    await expect(api.decideDeletion(deletionTokenOf(first.confirmUrl), true)).rejects.toMatchObject({ status: 410 });
    expect((await api.listShops()).find((shop) => shop.tenant === "shop_baanmali")?.deletion?.state).toBe("expired");
    const again = asked(await api.deleteShop({ tenant: "shop_baanmali", confirmName: "Baan Mali" }));
    expect(again.confirmUrl).not.toBe(first.confirmUrl);
    expect(await api.listMessages("shop_baanmali")).toHaveLength(7);
  });

  it("keeps reply links and deletion links apart", async () => {
    const api = fake();
    const link = asked(await api.deleteShop({ tenant: "shop_baanmali", confirmName: "Baan Mali" }));
    await expect(api.getDeletion(DEMO_TOKENS.waiting)).rejects.toMatchObject({ status: 404, code: "link_invalid" });
    await expect(api.decideDeletion(DEMO_TOKENS.waiting, true)).rejects.toMatchObject({ code: "link_invalid" });
    await expect(api.getApproval(deletionTokenOf(link.confirmUrl))).rejects.toMatchObject({ code: "link_invalid" });
    await expect(api.decide(deletionTokenOf(link.confirmUrl), true)).rejects.toMatchObject({ code: "link_invalid" });
    expect((await api.getDeletion(deletionTokenOf(link.confirmUrl))).state).toBe("awaiting_owner");
  });

  it("lists a deletion that stopped part way as deleting, as the API does, and the same request finishes it", async () => {
    const saved = new Map<string, string>();
    const storage = {
      getItem: (key: string) => saved.get(key) ?? null,
      setItem: (key: string, value: string) => void saved.set(key, value),
      removeItem: (key: string) => void saved.delete(key),
    };
    const api = createFakeApi({ now: () => NOW, webOrigin: "https://web.test", storage });
    const link = asked(await api.deleteShop({ tenant: "shop_baanmali", confirmName: "Baan Mali" }));
    expect((await api.listShops()).map((shop) => shop.deleting)).toEqual([undefined, undefined]);
    // A practice wipe never stops part way, so the saved world is changed to hold two that did, as the API can
    // leave them: Fon said yes to Baan Mali's, and Sabai Tea's was recorded by an operator and went no further.
    type SavedWorld = { confirmations: { status: string; approved?: boolean; decidedAt?: string }[];
      deletions: Record<string, unknown>[] };
    const world = JSON.parse(saved.get("manut.pilot.fake.v1")!) as SavedWorld;
    Object.assign(world.confirmations.at(-1)!, { status: "decided", approved: true, decidedAt: "2026-11-23T03:00:00.000Z" });
    world.deletions.push({ tenant: "shop_sabaitea", name: "Sabai Tea", requestedAt: "2026-11-23T02:00:00.000Z",
      deletedBy: "ops@manut.test" });
    saved.set("manut.pilot.fake.v1", JSON.stringify(world));

    const listed = await api.listShops();
    expect(listed.map((shop) => [shop.name, shop.deletion?.state, shop.deleting])).toEqual([
      ["Baan Mali", "deleting", { shopRecord: true }], ["Sabai Tea", undefined, { shopRecord: true }]]);
    expect(await api.getDeletion(deletionTokenOf(link.confirmUrl))).toMatchObject({ state: "deleting" });

    expect(await api.deleteShop({ tenant: "shop_sabaitea", confirmName: "Sabai Tea" })).toMatchObject({ tasksWiped: 0 });
    expect(await api.deleteShop({ tenant: "shop_baanmali", confirmName: "Baan Mali" })).toMatchObject({ tasksWiped: 1 });
    expect(await api.listShops()).toEqual([]);
    expect(await api.getDeletion(deletionTokenOf(link.confirmUrl))).toMatchObject({ state: "deleted" });
    // Sabai Tea's record keeps who asked and when, as the API's does.
    await expect(api.listMessages("shop_sabaitea")).rejects.toMatchObject({ code: "tenant_deleted",
      deletedBy: "ops@manut.test" });
  });

  it("answers the demo deletion links in every state", async () => {
    const api = fake();
    expect((await api.getDeletion(DEMO_DELETION_TOKENS.waiting)).state).toBe("awaiting_owner");
    expect((await api.getDeletion(DEMO_DELETION_TOKENS.deleting)).state).toBe("deleting");
    expect((await api.getDeletion(DEMO_DELETION_TOKENS.deleted)).state).toBe("deleted");
    expect((await api.getDeletion(DEMO_DELETION_TOKENS.kept)).state).toBe("declined");
    expect((await api.getDeletion(DEMO_DELETION_TOKENS.unanswered)).state).toBe("expired");
    await expect(api.getDeletion(DEMO_DELETION_TOKENS.expiredLink)).rejects.toMatchObject({ status: 410 });
    // None of them touches the console's shops.
    expect((await api.listShops()).map((shop) => [shop.name, shop.deletion])).toEqual([
      ["Baan Mali", undefined], ["Sabai Tea", undefined]]);
    expect(await api.decideDeletion(DEMO_DELETION_TOKENS.waiting, true)).toMatchObject({ state: "deleted" });
    expect((await api.listShops()).map((shop) => shop.name)).toEqual(["Baan Mali", "Sabai Tea"]);
  });
});

describe("the in-memory fake, for practising the owner's page on long words and a dead connection", () => {
  let now = Date.parse("2026-11-23T03:00:00Z");
  const fake = () => createFakeApi({ now: () => now, settleMs: 3000, webOrigin: "https://web.test" });
  const thai = /[฀-๿]/;
  // The longest stretch of a text with no space in it: the most a phone's line has to hold without a place to break.
  const longestRun = (text: string) => Math.max(...text.split(/\s+/).map((word) => word.length));

  it("answers a long Thai message and a long Thai reply, in a shop with a long Thai name", async () => {
    const view = await fake().getApproval(DEMO_TOKENS.longThai);
    expect(view).toMatchObject({ state: "proposed", needsConsent: true });
    expect(view.shopName).toMatch(thai);
    expect(view.shopName.length).toBeGreaterThan(40);
    expect(view.customerName).toMatch(thai);
    // A long message in two paragraphs, and a long reply to it.
    expect(view.customerMessage).toMatch(thai);
    expect(view.customerMessage.length).toBeGreaterThan(250);
    expect(view.customerMessage).toContain("\n\n");
    expect(view.replyText).toMatch(thai);
    expect(view.replyText.length).toBeGreaterThan(250);
  });

  it("answers a long order id and a long link that have nowhere to break, and a customer name with no space", async () => {
    const view = await fake().getApproval(DEMO_TOKENS.longLink);
    expect(view).toMatchObject({ state: "proposed", needsConsent: true });
    expect(longestRun(view.customerMessage)).toBeGreaterThan(60);
    expect(longestRun(view.replyText)).toBeGreaterThan(60);
    expect(view.replyText).toContain("https://");
    expect(view.customerName).not.toMatch(/\s/);
    expect(view.customerName.length).toBeGreaterThan(20);
  });

  it("keeps each practice shop to itself, and never shows them to the console", async () => {
    const api = fake();
    // Not in the console's lists, nor among Baan Mali's messages and replies.
    expect((await api.listShops()).map((shop) => shop.name)).toEqual(["Baan Mali", "Sabai Tea"]);
    expect((await api.listMessages("shop_baanmali")).map((message) => message.id)).not.toContain("demo_msg_long_thai");
    expect((await api.listActions("shop_baanmali")).map((action) => action.actionId)).not.toContain("act_demo_long_thai");

    // One shop's one-time permission is its own.
    await api.giveConsent(DEMO_TOKENS.longThai);
    expect((await api.getApproval(DEMO_TOKENS.longThai)).needsConsent).toBe(false);
    expect((await api.getApproval(DEMO_TOKENS.longLink)).needsConsent).toBe(true);
    expect((await api.getApproval(DEMO_TOKENS.waiting)).needsConsent).toBe(true);

    // And a reply link works as any other: the owner answers, the send settles.
    expect((await api.decide(DEMO_TOKENS.longThai, true)).state).toBe("dispatching");
    now += 3000;
    expect((await api.getApproval(DEMO_TOKENS.longThai)).state).toBe("confirmed");
    expect((await api.getApproval(DEMO_TOKENS.longLink)).state).toBe("proposed");
  });

  it("cannot be read on the dead-connection links, the way a request that never arrives fails", async () => {
    const api = fake();
    const calls = [
      () => api.getApproval(DEMO_TOKENS.offline),
      () => api.giveConsent(DEMO_TOKENS.offline),
      () => api.decide(DEMO_TOKENS.offline, true),
      () => api.getDeletion(DEMO_DELETION_TOKENS.offline),
      () => api.decideDeletion(DEMO_DELETION_TOKENS.offline, true),
    ];
    // The HTTP client throws status 0 with the code "network" for a fetch that rejects; the page treats it as "could not load".
    for (const call of calls) await expect(call()).rejects.toMatchObject({ status: 0, code: "network" });
  });

  it("answers a deletion about a shop with a long Thai name and counts in the millions, and deletes nothing real", async () => {
    const api = fake();
    const view = await api.getDeletion(DEMO_DELETION_TOKENS.longName);
    expect(view).toMatchObject({
      state: "awaiting_owner",
      goes: { messages: 1_234_567, replies: 98_765, payments: 4_321, lineConnected: true },
    });
    expect(view.shopName).toMatch(thai);
    expect(view.shopName.length).toBeGreaterThan(50);
    expect(await api.decideDeletion(DEMO_DELETION_TOKENS.longName, true)).toMatchObject({
      state: "deleted",
      goes: { messages: 1_234_567 },
    });
    // The other copy of the page and the console are as they were.
    expect((await api.getDeletion(DEMO_DELETION_TOKENS.waiting)).state).toBe("awaiting_owner");
    expect((await api.listShops()).map((shop) => shop.name)).toEqual(["Baan Mali", "Sabai Tea"]);
  });
});

describe("the in-memory fake's LINE webhook", () => {
  it("stores a signed LINE message once and refuses a bad signature", async () => {
    const api = createFakeApi();
    const body = JSON.stringify({
      destination: "Ubaanmalibot",
      events: [
        {
          type: "message",
          webhookEventId: "01HZZ",
          timestamp: Date.now(),
          source: { type: "user", userId: "Unew" },
          message: { type: "text", id: "1", text: "ยังไม่ได้ของเลยค่ะ" },
        },
      ],
    });
    const signature = await lineSignature(PRACTICE_CHANNEL_SECRET, body);

    await expect(api.deliverLineWebhook("line_baanmali", body, "bad")).rejects.toMatchObject({ status: 401 });
    await expect(api.deliverLineWebhook("line_nope", body, signature)).rejects.toMatchObject({ status: 404 });
    await api.deliverLineWebhook("line_baanmali", body, signature);
    await api.deliverLineWebhook("line_baanmali", body, signature);

    const stored = (await api.listMessages("shop_baanmali")).filter((m) => m.lineUserId === "Unew");
    expect(stored).toHaveLength(1);
    expect(stored[0]?.text).toBe("ยังไม่ได้ของเลยค่ะ");
  });
});

describe("the fake's pilot gate, measured as the API measures it", () => {
  const NOW = Date.parse("2026-11-23T03:00:00Z"); // 10:00 in Bangkok

  /// A new shop connected to LINE at `now`, whose customers can write through the fake's webhook.
  async function connectedShop(api: ReturnType<typeof createFakeApi>, name: string) {
    const { tenant } = await api.createShop({ name, ownerName: "Nok" });
    const secret = `${name}-secret`;
    const { connectionId } = await api.createLineConnection({ tenant, channelId: "c1", botUserId: `U${name}`,
      channelSecret: secret, channelAccessToken: "token" });
    return { tenant, connectionId, secret };
  }

  /// A customer writes and the owner declines Nam's reply through the link, both at `now`.
  async function ownerDeclines(api: ReturnType<typeof createFakeApi>, shop: Awaited<ReturnType<typeof connectedShop>>,
    text: string) {
    const body = JSON.stringify({ events: [{ type: "message", webhookEventId: `${shop.tenant}-${text}`,
      source: { userId: "Ucustomer" }, message: { type: "text", text } }] });
    await api.deliverLineWebhook(shop.connectionId, body, await lineSignature(shop.secret, body));
    const message = (await api.listMessages(shop.tenant)).find((m) => m.text === text)!;
    const reply = await api.proposeReply({ tenant: shop.tenant, messageId: message.id, text: "ok" });
    await api.decide(tokenOf(reply.approvalUrl), false);
  }

  it("puts Baan Mali on day 14 of its trial, active from today's decisions, and Sabai Tea not started", async () => {
    const api = createFakeApi({ now: () => NOW });
    const gate = await api.getGate();
    expect(gate.rules).toEqual({ trialDays: 14, priceSatang: 49900, activeWindowDays: 7 });
    expect(gate.asOf).toBe("2026-11-23T03:00:00.000Z");
    expect(gate.shops).toEqual([
      { tenant: "shop_baanmali", name: "Baan Mali", trialStartedAt: "2026-11-10T03:00:00.000Z", day: 14,
        trialEnded: false, paid: false, paidSatang: 0, activeOnDay14: "yes", lastDecisionAt: "2026-11-22T22:18:00.000Z",
        inCohort: true },
      { tenant: "shop_sabaitea", name: "Sabai Tea", trialStartedAt: null, day: null, trialEnded: false, paid: false,
        paidSatang: 0, activeOnDay14: "not_yet", inCohort: true },
    ]);
    expect(gate.cohort).toEqual({ counted: 0, paid: { count: 0, percent: null, thresholdPercent: 25, met: false },
      active: { count: 0, percent: null, thresholdPercent: 50, met: false }, status: "not_enough_data" });
    // The shop list stays the contract's Shop: the trial start is the gate's to answer.
    expect((await api.listShops()).every((shop) => !("trialStartedAt" in shop))).toBe(true);
  });

  it("counts Baan Mali once its day 14 has passed, and puts it on track once it pays ฿499", async () => {
    let now = NOW;
    const api = createFakeApi({ now: () => now });
    now = Date.parse("2026-11-23T16:59:59.999Z"); // the last moment of day 14 in Bangkok
    expect((await api.getGate()).cohort.status).toBe("not_enough_data");
    now += 1; // midnight in Bangkok: day 15 begins
    const ended = await api.getGate();
    expect(ended.shops[0]).toMatchObject({ day: 15, trialEnded: true, activeOnDay14: "yes", paid: false });
    expect(ended.cohort).toEqual({ counted: 1, paid: { count: 0, percent: 0, thresholdPercent: 25, met: false },
      active: { count: 1, percent: 100, thresholdPercent: 50, met: true }, status: "below_line" });

    const payment = await api.recordSubscriptionPayment({ tenant: "shop_baanmali", amountSatang: 49900,
      slipRef: "KB-1" });
    const paid = await api.getGate();
    expect(paid.shops[0]).toMatchObject({ paid: true, paidAt: payment.confirmedAt, paidSatang: 49900 });
    expect(paid.cohort.status).toBe("on_track");
  });

  it("starts a trial at the first LINE connection, turns its days at midnight in Bangkok, and keeps its start", async () => {
    let now = Date.parse("2026-12-07T16:59:59.999Z"); // 23:59:59.999 in Bangkok
    const api = createFakeApi({ now: () => now });
    const { tenant } = await api.createShop({ name: "Kanom Jeen", ownerName: "Lek" });
    const row = async () => (await api.getGate()).shops.find((shop) => shop.tenant === tenant)!;
    expect(await row()).toMatchObject({ trialStartedAt: null, day: null, activeOnDay14: "not_yet" });
    const connection = { tenant, channelId: "c1", botUserId: "Ukanom", channelSecret: "s", channelAccessToken: "t" };
    await api.createLineConnection(connection);
    expect(await row()).toMatchObject({ trialStartedAt: "2026-12-07T16:59:59.999Z", day: 1 });
    now += 1; // 00:00 in Bangkok
    expect((await row()).day).toBe(2);
    await api.createLineConnection({ ...connection, channelAccessToken: "rotated" });
    expect((await row()).trialStartedAt).toBe("2026-12-07T16:59:59.999Z");
  });

  it("counts a decision in the seven Bangkok days up to and including day 14, to the millisecond", async () => {
    let now = Date.parse("2026-12-07T03:00:00.000Z"); // day 1 is 7 December
    const api = createFakeApi({ now: () => now, webOrigin: "https://web.test" });
    const late = await connectedShop(api, "late");
    const early = await connectedShop(api, "early");
    now = Date.parse("2026-12-13T16:59:59.999Z"); // the last moment of day 7
    await ownerDeclines(api, late, "on day 7");
    now = Date.parse("2026-12-13T17:00:00.000Z"); // the first moment of day 8
    await ownerDeclines(api, early, "on day 8");
    now = Date.parse("2026-12-20T17:00:00.000Z"); // day 15
    const gate = await api.getGate();
    expect(gate.shops.find((shop) => shop.tenant === late.tenant)).toMatchObject({ day: 15, activeOnDay14: "no",
      lastDecisionAt: "2026-12-13T16:59:59.999Z" });
    expect(gate.shops.find((shop) => shop.tenant === early.tenant)).toMatchObject({ day: 15, activeOnDay14: "yes" });
  });

  it("records subscription payments in integer satang against a slip, once per slip, newest first", async () => {
    let now = NOW;
    const api = createFakeApi({ now: () => now });
    const first = await api.recordSubscriptionPayment({ tenant: "shop_baanmali", amountSatang: 24900,
      slipRef: "  KB-1 ", slipNote: "KBank 10:02" });
    expect(first).toEqual({ id: expect.any(String), tenant: "shop_baanmali", amountSatang: 24900, slipRef: "KB-1",
      slipNote: "KBank 10:02", confirmedAt: "2026-11-23T03:00:00.000Z" });
    now += 60_000;
    await api.recordSubscriptionPayment({ tenant: "shop_baanmali", amountSatang: 25000, slipRef: "SCB-7" });
    for (const bad of [{ amountSatang: 0 }, { amountSatang: -100 }, { amountSatang: 12.5 }, { amountSatang: Number.NaN },
      { slipRef: "  " }, { slipRef: "x".repeat(129) }, { slipNote: "x".repeat(1001) }]) {
      await expect(api.recordSubscriptionPayment({ tenant: "shop_baanmali", amountSatang: 100, slipRef: "KB-9", ...bad }))
        .rejects.toMatchObject({ status: 400, code: "invalid_request" });
    }
    await expect(api.recordSubscriptionPayment({ tenant: "shop_baanmali", amountSatang: 100, slipRef: " kb-1" }))
      .rejects.toMatchObject({ status: 409, code: "slip_already_recorded" });
    await expect(api.recordSubscriptionPayment({ tenant: "shop_nobody", amountSatang: 100, slipRef: "KB-2" }))
      .rejects.toMatchObject({ status: 404, code: "shop_not_found" });
    expect((await api.listSubscriptionPayments("shop_baanmali")).map((payment) => payment.slipRef))
      .toEqual(["SCB-7", "KB-1"]);
    // Customers' order payments are a different ledger.
    expect((await api.listPayments("shop_baanmali")).map((payment) => payment.orderRef)).toEqual(["SP-2301", "SP-2288"]);
    await expect(createFakeApi({ operatorKey: () => null }).getGate()).rejects.toMatchObject({ status: 403 });
  });

  it("exports subscription payments with the shop, counts them in what a deletion takes, and deletes them", async () => {
    const api = createFakeApi({ now: () => NOW, webOrigin: "https://web.test" });
    await api.recordSubscriptionPayment({ tenant: "shop_baanmali", amountSatang: 49900, slipRef: "KB-1" });
    const exported = await api.exportShop("shop_baanmali");
    expect(exported.pilot).toMatchObject({ shop: { trialStartedAt: "2026-11-10T03:00:00.000Z" },
      subscriptionPayments: [expect.objectContaining({ slipRef: "KB-1", amountSatang: 49900 })] });

    const link = asked(await api.deleteShop({ tenant: "shop_baanmali", confirmName: "Baan Mali" }));
    const token = deletionTokenOf(link.confirmUrl);
    expect((await api.getDeletion(token)).goes).toEqual({ messages: 7, replies: 6, payments: 3, lineConnected: true });
    await api.decideDeletion(token, true);
    await expect(api.listSubscriptionPayments("shop_baanmali")).rejects.toMatchObject({ code: "tenant_deleted" });
    expect((await api.getGate()).shops.map((shop) => shop.tenant)).toEqual(["shop_sabaitea"]);
  });

  it("replaces a practice world saved before the gate's records existed", async () => {
    const saved = new Map([["manut.pilot.fake.v1", JSON.stringify({ version: 2, seq: 100, shops: [], connections: [],
      messages: [], actions: [], payments: [], deletions: [], confirmations: [], expiredTokens: [] })]]);
    const storage = {
      getItem: (key: string) => saved.get(key) ?? null,
      setItem: (key: string, value: string) => void saved.set(key, value),
      removeItem: (key: string) => void saved.delete(key),
    };
    const api = createFakeApi({ now: () => NOW, storage });
    expect((await api.listShops()).map((shop) => shop.name)).toEqual(["Baan Mali", "Sabai Tea"]);
    expect(await api.listSubscriptionPayments("shop_baanmali")).toEqual([]);
    expect((await api.getGate()).shops).toHaveLength(2);
  });
});

describe("the fake's audit log, kept as the API keeps it", () => {
  const NOW = Date.parse("2026-11-23T03:00:00Z"); // 10:00 in Bangkok
  const ENTRY_ID = /^aud-[0-9a-z]{9}-[0-9a-z]{3}-[0-9a-f]{8}$/;
  const operator = { kind: "operator", email: null };

  /// The log oldest first, each entry as what it says, without its id and time.
  async function trail(api: ReturnType<typeof createFakeApi>, tenant: string) {
    const page = await api.listAudit(tenant, { limit: 200 });
    return page.entries.reverse().map(({ id: _id, at: _at, ...said }) => said);
  }

  it("records the operator's actions, the owner's consent and decisions, and each send as it settles", async () => {
    let now = NOW;
    const api = createFakeApi({ now: () => now, settleMs: 3000, webOrigin: "https://web.test" });
    const { tenant } = await api.createShop({ name: "Kanom Jeen", ownerName: "Nok" });
    const first = await api.createLineConnection({ tenant, channelId: "c1", botUserId: "Ukj", channelSecret: "s1",
      channelAccessToken: "t1" });
    const second = await api.createLineConnection({ tenant, channelId: "c1", botUserId: "Ukj", channelSecret: "s2",
      channelAccessToken: "t2" });
    const body = JSON.stringify({ events: [{ type: "message", webhookEventId: "kj-1", source: { userId: "Ucustomer" },
      message: { type: "text", text: "ส่งของวันไหนคะ" } }] });
    await api.deliverLineWebhook(second.connectionId, body, await lineSignature("s2", body));
    const message = (await api.listMessages(tenant))[0]!;
    const reply = await api.proposeReply({ tenant, messageId: message.id, text: "พรุ่งนี้ค่ะ" });
    const token = tokenOf(reply.approvalUrl);
    await api.giveConsent(token);
    await api.decide(token, true);
    now += 3000;
    expect((await api.getApproval(token)).state).toBe("confirmed");
    const payment = await api.recordPayment({ tenant, orderRef: "KJ-1", amountSatang: 12000, promptPayId: "0812345678" });
    const subscription = await api.recordSubscriptionPayment({ tenant, amountSatang: 49900, slipRef: "KB-9" });

    const about = { taskId: reply.taskId, actionId: reply.actionId };
    expect(await trail(api, tenant)).toEqual([
      { actor: operator, action: "shop.created", subject: {}, outcome: "ok" },
      { actor: operator, action: "line.connected", subject: { connectionId: first.connectionId }, outcome: "ok" },
      { actor: operator, action: "line.connected",
        subject: { connectionId: second.connectionId, previousConnectionId: first.connectionId }, outcome: "ok" },
      { actor: operator, action: "reply.proposed", subject: { ...about, messageId: message.id }, outcome: "ok" },
      { actor: { kind: "owner" }, action: "consent.given", subject: {}, outcome: "ok" },
      { actor: { kind: "owner" }, action: "reply.decided", subject: about, outcome: "approved" },
      { actor: { kind: "system" }, action: "dispatch.started", subject: about, outcome: "ok" },
      { actor: { kind: "system" }, action: "dispatch.settled", subject: about, outcome: "confirmed" },
      { actor: operator, action: "payment.recorded", subject: { paymentId: payment.id }, outcome: "ok",
        amountSatang: 12000 },
      { actor: operator, action: "subscription_payment.recorded", subject: { paymentId: subscription.id }, outcome: "ok",
        amountSatang: 49900 },
    ]);
    // Metadata only, as the API keeps it: no customer's words and no reply's text.
    const written = JSON.stringify(await api.listAudit(tenant));
    expect(written).not.toContain("ส่งของวันไหนคะ");
    expect(written).not.toContain("พรุ่งนี้ค่ะ");
  });

  it("pages newest first with the API's cursor, and refuses a page it cannot read", async () => {
    const api = createFakeApi({ now: () => NOW });
    const all = await api.listAudit("shop_baanmali");
    expect(all.tenant).toBe("shop_baanmali");
    expect(all.missed).toBeNull();
    expect(all.entries.length).toBeGreaterThan(4);
    expect(all.entries.every((entry) => ENTRY_ID.test(entry.id))).toBe(true);
    expect(all.entries.map((entry) => entry.id)).toEqual([...all.entries.map((entry) => entry.id)].sort().reverse());
    // The sample shop's history: the replies of its sample world, newest first.
    expect(all.entries[0]).toMatchObject({ action: "reply.proposed", subject: { actionId: "act_ploy" } });

    const one = await api.listAudit("shop_baanmali", { limit: 2 });
    expect(one.entries).toEqual(all.entries.slice(0, 2));
    expect(one.next).toBe(all.entries[1]!.id);
    const two = await api.listAudit("shop_baanmali", { before: one.next!, limit: 2 });
    expect(two.entries).toEqual(all.entries.slice(2, 4));

    for (const query of [{ limit: 0 }, { limit: 201 }, { limit: 1.5 }, { before: "pay_2301" }]) {
      await expect(api.listAudit("shop_baanmali", query)).rejects.toMatchObject({ status: 400, code: "invalid_request" });
    }
    await expect(api.listAudit("")).rejects.toMatchObject({ status: 400, code: "tenant_required" });
    expect(await api.listAudit("shop_nobody")).toEqual({ tenant: "shop_nobody", entries: [], next: null, missed: null });
  });

  it("records a deletion's request and its owner's answer, exports the log, and deletes it with the shop", async () => {
    const api = createFakeApi({ now: () => NOW, webOrigin: "https://web.test" });
    const kept = asked(await api.deleteShop({ tenant: "shop_baanmali", confirmName: "Baan Mali" }));
    await api.decideDeletion(deletionTokenOf(kept.confirmUrl), false);
    const deletions = (await trail(api, "shop_baanmali")).filter((entry) => entry.action.startsWith("deletion."));
    expect(deletions).toEqual([
      { actor: operator, action: "deletion.requested", subject: { confirmationId: expect.any(String) },
        outcome: "awaiting_owner" },
      { actor: { kind: "owner" }, action: "deletion.decided", subject: { confirmationId: expect.any(String) },
        outcome: "declined" },
    ]);
    const exported = await api.exportShop("shop_baanmali");
    expect(exported.audit).toEqual({ entries: (await api.listAudit("shop_baanmali", { limit: 200 })).entries.reverse(),
      missed: null });

    const again = asked(await api.deleteShop({ tenant: "shop_baanmali", confirmName: "Baan Mali" }));
    await api.decideDeletion(deletionTokenOf(again.confirmUrl), true);
    expect(await api.listAudit("shop_baanmali")).toEqual({ tenant: "shop_baanmali", entries: [], next: null,
      missed: null });
  });

  it("replaces a practice world saved before the audit log existed", async () => {
    const saved = new Map([["manut.pilot.fake.v1", JSON.stringify({ version: 3, seq: 100, shops: [], connections: [],
      messages: [], actions: [], payments: [], subscriptionPayments: [], deletions: [], confirmations: [],
      expiredTokens: [] })]]);
    const storage = {
      getItem: (key: string) => saved.get(key) ?? null,
      setItem: (key: string, value: string) => void saved.set(key, value),
      removeItem: (key: string) => void saved.delete(key),
    };
    const api = createFakeApi({ now: () => NOW, storage });
    expect((await api.listShops()).map((shop) => shop.name)).toEqual(["Baan Mali", "Sabai Tea"]);
    expect((await api.listAudit("shop_baanmali")).entries.length).toBeGreaterThan(0);
  });
});

describe("the fake's memory, kept as the API keeps it", () => {
  const NOW = Date.parse("2026-11-23T03:00:00Z");
  const fresh = () => createFakeApi({ now: () => NOW, webOrigin: "https://web.test" });
  const operator = { kind: "operator", email: null };

  /// The memory entries of a shop's log, oldest first, as what they say: no id, no time.
  async function memoryTrail(api: ReturnType<typeof createFakeApi>, tenant: string) {
    const page = await api.listAudit(tenant, { limit: 200 });
    return page.entries.reverse().filter((entry) => entry.action.startsWith("memory.")).map(({ id: _id, at: _at, ...said }) => said);
  }

  it("starts Baan Mali with what its sample world taught the team, a customer's two facts waiting, and Sabai Tea with nothing", async () => {
    const api = fresh();
    const memory = await api.getMemory("shop_baanmali");
    expect(memory.tenant).toBe("shop_baanmali");
    expect(memory.facts.map((fact) => [fact.id, fact.status, fact.source.kind])).toEqual([
      ["f1", "confirmed", "owner"], ["f2", "confirmed", "document"], ["f3", "confirmed", "edits"],
      ["f4", "confirmed", "orders"], ["f5", "confirmed", "connection"], ["f6", "waiting", "customer"],
      ["f7", "waiting", "customer"],
    ]);
    expect(memory.forgottenCount).toBe(0);
    expect(await api.getMemory("shop_sabaitea")).toEqual({ tenant: "shop_sabaitea", facts: [], forgottenCount: 0 });
    // Any tenant can be read, as in the API: one the team knows nothing about is an empty memory.
    expect(await api.getMemory("shop_nobody")).toEqual({ tenant: "shop_nobody", facts: [], forgottenCount: 0 });
  });

  it("remembers the owner's fact trimmed and confirmed, and refuses as the package and the API do", async () => {
    const api = fresh();
    const tenant = "shop_sabaitea";
    expect(await api.rememberFact({ tenant, text: "  We close on Mondays " })).toEqual({ id: "f1", text: "We close on Mondays",
      status: "confirmed", createdAt: NOW, updatedAt: NOW, source: { kind: "owner" } });
    await expect(api.rememberFact({ tenant, text: " we  close on MONDAYS" })).rejects.toMatchObject({ status: 409, code: "already_known" });
    for (const text of ["", "   ", "x".repeat(281), 5 as unknown as string]) {
      await expect(api.rememberFact({ tenant, text })).rejects.toMatchObject({ status: 400, code: "invalid_text" });
    }
    expect((await api.getMemory(tenant)).facts).toHaveLength(1);
    // A waiting fact is confirmed by saying it, not added twice.
    const waiting = (await api.getMemory("shop_baanmali")).facts.find((fact) => fact.status === "waiting")!;
    const confirmed = await api.rememberFact({ tenant: "shop_baanmali", text: waiting.text.toUpperCase() });
    expect(confirmed).toMatchObject({ id: waiting.id, status: "confirmed" });
    expect((await api.getMemory("shop_baanmali")).facts).toHaveLength(7);
  });

  it("holds at most 200 facts, and Forget makes room", async () => {
    const api = fresh();
    const tenant = "shop_sabaitea";
    for (let i = 0; i < 200; i++) await api.rememberFact({ tenant, text: `fact ${i}` });
    await expect(api.rememberFact({ tenant, text: "one more" })).rejects.toMatchObject({ status: 409, code: "full" });
    await api.forgetFact({ tenant, id: "f1" });
    expect(await api.rememberFact({ tenant, text: "one more" })).toMatchObject({ id: "f201" });
  });

  it("says 'It's true' to a waiting fact, and answering a confirmed fact changes nothing", async () => {
    const api = fresh();
    const tenant = "shop_baanmali";
    const first = await api.confirmFact({ tenant, id: "f6" });
    expect(first).toMatchObject({ id: "f6", status: "confirmed", updatedAt: NOW, source: { kind: "customer" } });
    expect(await api.confirmFact({ tenant, id: "f6" })).toEqual(first);
    await expect(api.confirmFact({ tenant, id: "f99" })).rejects.toMatchObject({ status: 404, code: "not_found" });
    for (const id of ["", "f".repeat(65), 7 as unknown as string]) {
      await expect(api.confirmFact({ tenant, id })).rejects.toMatchObject({ status: 400, code: "invalid_request" });
    }
    expect((await api.getMemory(tenant)).facts.filter((fact) => fact.status === "waiting").map((fact) => fact.id)).toEqual(["f7"]);
  });

  it("corrects a fact: new words, confirmed, marked as corrected, keeping where it came from", async () => {
    const api = fresh();
    const tenant = "shop_baanmali";
    const before = (await api.getMemory(tenant)).facts.find((fact) => fact.id === "f7")!;
    const corrected = await api.correctFact({ tenant, id: "f7", text: " Customers expect 15% off when they buy 5 sets " });
    expect(corrected).toEqual({ ...before, text: "Customers expect 15% off when they buy 5 sets", status: "confirmed", updatedAt: NOW, correctedAt: NOW });
    const other = (await api.getMemory(tenant)).facts.find((fact) => fact.id === "f1")!;
    await expect(api.correctFact({ tenant, id: "f7", text: other.text.toLowerCase() })).rejects.toMatchObject({ status: 409, code: "already_known" });
    await expect(api.correctFact({ tenant, id: "f7", text: "" })).rejects.toMatchObject({ status: 400, code: "invalid_text" });
    await expect(api.correctFact({ tenant, id: "f99", text: "anything" })).rejects.toMatchObject({ status: 404, code: "not_found" });
  });

  it("forgets by keeping only a fingerprint: gone from the memory, the export and the log, and not reused as an id", async () => {
    const api = fresh();
    const tenant = "shop_baanmali";
    const text = (await api.getMemory(tenant)).facts.find((fact) => fact.id === "f2")!.text;
    expect(await api.forgetFact({ tenant, id: "f2" })).toEqual({ id: "f2" });
    await expect(api.forgetFact({ tenant, id: "f2" })).rejects.toMatchObject({ status: 404, code: "not_found" });
    const after = await api.getMemory(tenant);
    expect(after.facts.map((fact) => fact.id)).not.toContain("f2");
    expect(after.forgottenCount).toBe(1);
    for (const kept of [JSON.stringify(after), JSON.stringify(await api.exportShop(tenant)), JSON.stringify(await api.listAudit(tenant, { limit: 200 }))]) {
      expect(kept).not.toContain(text);
    }
    // The owner saying it again lifts the Forget; the new fact has a new id.
    expect(await api.rememberFact({ tenant, text })).toMatchObject({ id: "f8", status: "confirmed" });
    expect((await api.getMemory(tenant)).forgottenCount).toBe(0);
  });

  it("writes an audit entry for each change, by the fact's id and never its words, and none for a refusal or a no-op", async () => {
    const api = fresh();
    const tenant = "shop_sabaitea";
    const made = await api.rememberFact({ tenant, text: "A secret supplier is Khun Somchai" });
    await api.correctFact({ tenant, id: made.id, text: "A secret supplier is Khun Somsri" });
    await api.confirmFact({ tenant, id: made.id }); // already confirmed: nothing changed
    await api.rememberFact({ tenant, text: "a secret supplier is khun somsri" }).catch(() => undefined); // refused
    await api.forgetFact({ tenant, id: made.id });
    expect(await memoryTrail(api, tenant)).toEqual([
      { actor: operator, action: "memory.remembered", subject: { factId: "f1" }, outcome: "ok" },
      { actor: operator, action: "memory.corrected", subject: { factId: "f1" }, outcome: "ok" },
      { actor: operator, action: "memory.forgotten", subject: { factId: "f1" }, outcome: "ok" },
    ]);
    expect(JSON.stringify(await api.listAudit(tenant))).not.toMatch(/Somchai|Somsri|supplier/);
  });

  it("gives each sample fact its entry, the waiting ones as waiting for the owner", async () => {
    const api = fresh();
    const trail = await memoryTrail(api, "shop_baanmali");
    expect(trail.map((entry) => [entry.action, entry.subject.factId, entry.outcome])).toEqual([
      ["memory.remembered", "f1", "ok"], ["memory.proposed", "f2", "ok"], ["memory.proposed", "f3", "ok"],
      ["memory.proposed", "f4", "ok"], ["memory.proposed", "f5", "ok"], ["memory.proposed", "f6", "awaiting_owner"],
      ["memory.proposed", "f7", "awaiting_owner"],
    ]);
    expect(trail.map((entry) => entry.actor.kind)).toEqual(["operator", "system", "system", "system", "system", "system", "system"]);
  });

  it("needs the operator key on every memory route, and a tenant", async () => {
    const api = createFakeApi({ operatorKey: () => null });
    const tenant = "shop_baanmali";
    await expect(api.getMemory(tenant)).rejects.toMatchObject({ status: 403, code: "forbidden" });
    await expect(api.rememberFact({ tenant, text: "x" })).rejects.toMatchObject({ status: 403, code: "forbidden" });
    await expect(api.confirmFact({ tenant, id: "f6" })).rejects.toMatchObject({ status: 403, code: "forbidden" });
    await expect(api.correctFact({ tenant, id: "f6", text: "x" })).rejects.toMatchObject({ status: 403, code: "forbidden" });
    await expect(api.forgetFact({ tenant, id: "f6" })).rejects.toMatchObject({ status: 403, code: "forbidden" });
    const keyed = fresh();
    await expect(keyed.getMemory("")).rejects.toMatchObject({ status: 400, code: "tenant_required" });
    await expect(keyed.rememberFact({ tenant: "", text: "x" })).rejects.toMatchObject({ status: 400, code: "tenant_required" });
  });

  it("keeps the memory across tabs that share the saved world", async () => {
    const saved = new Map<string, string>();
    const storage = { getItem: (key: string) => saved.get(key) ?? null, setItem: (key: string, value: string) => void saved.set(key, value),
      removeItem: (key: string) => void saved.delete(key) };
    const one = createFakeApi({ now: () => NOW, storage });
    const two = createFakeApi({ now: () => NOW, storage });
    await one.rememberFact({ tenant: "shop_sabaitea", text: "Saved in one tab" });
    expect((await two.getMemory("shop_sabaitea")).facts.map((fact) => fact.text)).toEqual(["Saved in one tab"]);
    await two.forgetFact({ tenant: "shop_sabaitea", id: "f1" });
    expect(await one.getMemory("shop_sabaitea")).toEqual({ tenant: "shop_sabaitea", facts: [], forgottenCount: 1 });
  });

  it("exports the memory with the shop, as the API's export does, and deletes it with the shop", async () => {
    const api = fresh();
    const tenant = "shop_baanmali";
    await api.forgetFact({ tenant, id: "f2" });
    const exported = (await api.exportShop(tenant)) as { memory?: unknown };
    expect(exported.memory).toEqual(await api.getMemory(tenant).then(({ facts, forgottenCount }) => ({ facts, forgottenCount })));
    const link = asked(await api.deleteShop({ tenant, confirmName: "Baan Mali" }));
    await api.decideDeletion(deletionTokenOf(link.confirmUrl), true);
    expect(await api.getMemory(tenant)).toEqual({ tenant, facts: [], forgottenCount: 0 });
  });

  it("replaces a practice world saved before the team's memory existed", async () => {
    const saved = new Map([["manut.pilot.fake.v1", JSON.stringify({ version: 4, seq: 100, shops: [], connections: [], messages: [],
      actions: [], payments: [], subscriptionPayments: [], deletions: [], confirmations: [], expiredTokens: [], audit: [] })]]);
    const storage = { getItem: (key: string) => saved.get(key) ?? null, setItem: (key: string, value: string) => void saved.set(key, value),
      removeItem: (key: string) => void saved.delete(key) };
    const api = createFakeApi({ now: () => NOW, storage });
    expect((await api.listShops()).map((shop) => shop.name)).toEqual(["Baan Mali", "Sabai Tea"]);
    expect((await api.getMemory("shop_baanmali")).facts).toHaveLength(7);
  });
});

describe("the fake's model spend, answered as docs/model-gateway.md says", () => {
  const NOW = Date.parse("2026-11-23T03:00:00Z"); // 10:00 on 23 November in Bangkok
  const BAAN_MALI = "shop_baanmali";
  const SABAI_TEA = "shop_sabaitea";
  const NO_CALLS = { ok: 0, failed: 0, unreadable: 0, abandoned: 0, refused: 0 };

  function memory() {
    const saved = new Map<string, string>();
    return {
      saved,
      storage: {
        getItem: (key: string) => saved.get(key) ?? null,
        setItem: (key: string, value: string) => void saved.set(key, value),
        removeItem: (key: string) => void saved.delete(key),
      },
    };
  }

  it("gives Baan Mali a believable month: ฿186 spent of its ฿300 cap, with one call in progress", async () => {
    const usage = await createFakeApi({ now: () => NOW }).getModelUsage(BAAN_MALI);
    expect(usage).toMatchObject({
      tenant: BAAN_MALI,
      month: "2026-11",
      capSatang: 30000,
      capSource: "override",
      capOverride: { capSatang: 30000, setBy: "ops@manut.test" },
      spentSatang: 18600,
      spentMillisatang: 18_599_456,
      heldSatang: 59,
      heldMillisatang: 58_800,
      // 30,000 satang less what is spent and held, 11,341.744 satang, rounded down.
      remainingSatang: 11341,
      counts: { ok: 49, failed: 1, unreadable: 0, abandoned: 0, refused: 0 },
      tokens: { input: 935_200, output: 89_780 },
    });
    expect(Date.parse(usage.capOverride!.setAt)).toBeLessThan(NOW);
    expect(usage.holds).toEqual([{ callId: expect.stringMatching(/^call-/), model: "claude-sonnet-5-5",
      worstMillisatang: 58_800, at: new Date(NOW - 60_000).toISOString(), expiresAt: new Date(NOW + 14 * 60_000).toISOString() }]);

    // The month's records agree with its totals, newest first, each in this Bangkok month.
    const calls = usage.calls!;
    expect(calls).toHaveLength(50);
    expect(new Set(calls.map((call) => call.id)).size).toBe(50);
    expect(calls.reduce((sum, call) => sum + call.millisatang, 0)).toBe(18_599_456);
    expect(calls.reduce((sum, call) => sum + call.inputTokens, 0)).toBe(935_200);
    expect(calls.reduce((sum, call) => sum + call.outputTokens, 0)).toBe(89_780);
    expect(calls.map((call) => call.at)).toEqual([...calls.map((call) => call.at)].sort().reverse());
    expect(calls.every((call) => call.at >= "2026-10-31T17:00:00.000Z" && call.at <= new Date(NOW).toISOString())).toBe(true);
    expect(new Set(calls.map((call) => call.model))).toEqual(
      new Set(["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"]));
    // `satang` is `millisatang` rounded up, and the one failed call cost nothing.
    for (const call of calls) {
      expect(call.satang * 1000).toBeGreaterThanOrEqual(call.millisatang);
      expect(call.satang * 1000 - call.millisatang).toBeLessThan(1000);
    }
    expect(calls.filter((call) => call.outcome === "failed")).toEqual([
      expect.objectContaining({ millisatang: 0, satang: 0, inputTokens: 0, outputTokens: 0 })]);
    expect(calls.filter((call) => call.outcome === "ok")).toHaveLength(49);
  });

  it("gives a shop with no calls the default cap and an empty month", async () => {
    expect(await createFakeApi({ now: () => NOW }).getModelUsage(SABAI_TEA)).toEqual({
      tenant: SABAI_TEA, month: "2026-11", capSatang: 20000, capSource: "default", capOverride: null,
      spentSatang: 0, spentMillisatang: 0, heldSatang: 0, heldMillisatang: 0, remainingSatang: 20000,
      counts: NO_CALLS, tokens: { input: 0, output: 0 }, crossings: [], calls: [], holds: [],
    });
  });

  it("reads the month's crossings from its calls against the cap as it now is: 80%, then all of it, none under zero", async () => {
    const api = createFakeApi({ now: () => NOW });
    // ฿186 of ฿300 is 62%.
    expect((await api.getModelUsage(BAAN_MALI)).crossings).toEqual([]);
    // Of ฿200 it is 93%: the call that first took the spend to ฿160 is when 80% was reached.
    await api.setModelCap({ tenant: BAAN_MALI, capSatang: 20000 });
    const [near] = (await api.getModelUsage(BAAN_MALI)).crossings!;
    expect(near).toMatchObject({ percent: 80, capSatang: 20000 });
    expect(near!.spentMillisatang).toBeGreaterThanOrEqual(16_000_000);
    expect(near!.spentSatang * 1000).toBeGreaterThanOrEqual(near!.spentMillisatang);
    const calls = (await api.getModelUsage(BAAN_MALI)).calls!;
    expect(calls.map((call) => call.at)).toContain(near!.at);
    const before = calls.filter((call) => call.at < near!.at).reduce((sum, call) => sum + call.millisatang, 0);
    expect(before).toBeLessThan(16_000_000);
    // Of ฿180 the spend is past it too, and a cap of zero, a stop, notes nothing.
    await api.setModelCap({ tenant: BAAN_MALI, capSatang: 18000 });
    expect((await api.getModelUsage(BAAN_MALI)).crossings!.map((crossing) => crossing.percent)).toEqual([80, 100]);
    await api.setModelCap({ tenant: BAAN_MALI, capSatang: 0 });
    expect((await api.getModelUsage(BAAN_MALI)).crossings).toEqual([]);
  });

  it("lists the shops near or at their caps, and writes the entries a lowered cap causes after the change's own", async () => {
    const api = createFakeApi({ now: () => NOW });
    expect(await api.getModelAlerts()).toEqual({ month: "2026-11", shops: [], truncated: false });

    await api.setModelCap({ tenant: BAAN_MALI, capSatang: 18000 });
    const listed = await api.getModelAlerts();
    expect(listed.shops.map((shop) => [shop.tenant, shop.percent])).toEqual([[BAAN_MALI, 100]]);
    expect(listed.shops[0]!.crossings.map((crossing) => crossing.percent)).toEqual([80, 100]);
    const log = (await api.listAudit(BAAN_MALI, { limit: 200 })).entries.reverse().map(({ id: _id, at: _at, ...said }) => said);
    expect(log.slice(-3)).toEqual([
      { actor: { kind: "operator", email: null }, action: "model.cap_set", subject: {}, outcome: "ok", amountSatang: 18000 },
      { actor: { kind: "system" }, action: "model.cap_near", subject: { month: "2026-11" }, outcome: "ok", amountSatang: 18000 },
      { actor: { kind: "system" }, action: "model.cap_reached", subject: { month: "2026-11" }, outcome: "ok",
        amountSatang: 18000 },
    ]);

    // Raised again, the shop is off the list, and a raise notes nothing.
    await api.setModelCap({ tenant: BAAN_MALI, capSatang: 30000 });
    expect((await api.getModelAlerts()).shops).toEqual([]);
    const after = (await api.listAudit(BAAN_MALI, { limit: 200 })).entries;
    expect(after[0]).toMatchObject({ action: "model.cap_set", amountSatang: 30000 });
  });

  it("answers the list whatever the meter or its settings say, as the API reads it from a record of its own", async () => {
    const down = createFakeApi({ now: () => NOW, modelGateway: { meterUnavailable: true } });
    expect(await down.getModelAlerts()).toEqual({ month: "2026-11", shops: [], truncated: false });
    const misread = createFakeApi({ now: () => NOW, modelGateway: { vars: { MODEL_DEFAULT_CAP_SATANG: "3,390" } } });
    expect((await misread.getModelAlerts()).shops).toEqual([]);
  });

  it("reads any Bangkok month, which turns at midnight there, and refuses what is not a month", async () => {
    const api = createFakeApi({ now: () => NOW });
    // The cap is the shop's, not the month's: an earlier month has no calls but the same cap.
    expect(await api.getModelUsage(BAAN_MALI, "2026-10")).toMatchObject({ month: "2026-10", capSatang: 30000,
      capSource: "override", spentSatang: 0, remainingSatang: 30000, counts: NO_CALLS, calls: [], holds: [] });
    expect((await api.getModelUsage(BAAN_MALI, "2026-11")).spentSatang).toBe(18600);

    for (const [at, month] of [["2026-11-30T16:59:59Z", "2026-11"], ["2026-11-30T17:00:00Z", "2026-12"],
      ["2026-12-31T17:00:00Z", "2027-01"]] as const) {
      expect((await createFakeApi({ now: () => Date.parse(at) }).getModelUsage(SABAI_TEA)).month).toBe(month);
    }
    for (const bad of ["2026-13", "2026-00", "2026-1", "26-11", "november", "2026-11-01", " 2026-11", ""]) {
      await expect(api.getModelUsage(BAAN_MALI, bad)).rejects.toMatchObject({ status: 400, code: "invalid_request" });
    }
    await expect(api.getModelUsage("")).rejects.toMatchObject({ status: 400, code: "tenant_required" });
  });

  it("puts Baan Mali's sample month inside whichever Bangkok month the practice world is made in", async () => {
    // Half an hour into December in Bangkok: the sample calls sit in December, not behind in November.
    const api = createFakeApi({ now: () => Date.parse("2026-11-30T17:30:00Z") });
    expect(await api.getModelUsage(BAAN_MALI)).toMatchObject({ month: "2026-12", spentSatang: 18600,
      counts: { ok: 49, failed: 1 } });
  });

  it("sets a shop's cap in whole satang, answers the cap as it now stands, and clears it with null", async () => {
    const api = createFakeApi({ now: () => NOW });
    expect(await api.setModelCap({ tenant: SABAI_TEA, capSatang: 15000 })).toEqual({
      tenant: SABAI_TEA, capSatang: 15000, capSource: "override",
      // The practice key has no Access identity, so nobody is named, as the API records a service token.
      capOverride: { capSatang: 15000, setAt: "2026-11-23T03:00:00.000Z", setBy: null },
    });
    expect(await api.getModelUsage(SABAI_TEA)).toMatchObject({ capSatang: 15000, capSource: "override",
      capOverride: { capSatang: 15000, setBy: null }, remainingSatang: 15000 });

    // A cap under what is already spent is allowed and leaves nothing; zero is a real cap that stops every call.
    await api.setModelCap({ tenant: BAAN_MALI, capSatang: 10000 });
    expect(await api.getModelUsage(BAAN_MALI)).toMatchObject({ capSatang: 10000, spentSatang: 18600, remainingSatang: 0 });
    expect(await api.setModelCap({ tenant: SABAI_TEA, capSatang: 0 })).toMatchObject({ capSatang: 0, capSource: "override" });
    expect(await api.setModelCap({ tenant: SABAI_TEA, capSatang: 1_000_000_000 })).toMatchObject({ capSatang: 1_000_000_000 });

    expect(await api.setModelCap({ tenant: SABAI_TEA, capSatang: null })).toEqual({
      tenant: SABAI_TEA, capSatang: 20000, capSource: "default", capOverride: null });
    expect(await api.getModelUsage(SABAI_TEA)).toMatchObject({ capSatang: 20000, capSource: "default", capOverride: null });
    // Clearing a shop that has no override is the same answer, not an error.
    expect(await api.setModelCap({ tenant: SABAI_TEA, capSatang: null })).toMatchObject({ capSource: "default" });
  });

  it("refuses a cap that is not 0 to 1,000,000,000 whole satang, or null, or that is missing, and changes nothing", async () => {
    const api = createFakeApi({ now: () => NOW });
    for (const capSatang of [-1, 1.5, 1_000_000_001, Number.NaN, Number.POSITIVE_INFINITY, "100", true, undefined]) {
      await expect(api.setModelCap({ tenant: SABAI_TEA, capSatang } as never)).rejects.toMatchObject({ status: 400,
        code: "invalid_request" });
    }
    // A body that forgot `capSatang` never clears a cap by accident.
    await expect(api.setModelCap({ tenant: BAAN_MALI } as never)).rejects.toMatchObject({ code: "invalid_request" });
    await expect(api.setModelCap({ tenant: "", capSatang: 100 })).rejects.toMatchObject({ status: 400, code: "tenant_required" });
    // The tenant is checked before the cap, as the API checks it.
    await expect(api.setModelCap({ tenant: "", capSatang: -1 })).rejects.toMatchObject({ code: "tenant_required" });

    expect(await api.getModelUsage(BAAN_MALI)).toMatchObject({ capSatang: 30000, capOverride: { setBy: "ops@manut.test" } });
    expect(await api.getModelUsage(SABAI_TEA)).toMatchObject({ capSatang: 20000, capSource: "default" });
    // Nothing was refused into the log either.
    const log = (await api.listAudit(SABAI_TEA, { limit: 200 })).entries;
    expect(log.some((entry) => entry.action.startsWith("model."))).toBe(false);
  });

  it("writes a cap's change to the shop's audit log, as the API does in the same write", async () => {
    const api = createFakeApi({ now: () => NOW });
    await api.setModelCap({ tenant: SABAI_TEA, capSatang: 15000 });
    await api.setModelCap({ tenant: SABAI_TEA, capSatang: null });
    const log = (await api.listAudit(SABAI_TEA, { limit: 200 })).entries.reverse().map(({ id: _id, at: _at, ...said }) => said);
    expect(log.slice(-2)).toEqual([
      { actor: { kind: "operator", email: null }, action: "model.cap_set", subject: {}, outcome: "ok", amountSatang: 15000 },
      { actor: { kind: "operator", email: null }, action: "model.cap_cleared", subject: {}, outcome: "ok" },
    ]);
    // Baan Mali's sample log already holds the entry for the cap its sample world was given.
    const sample = (await api.listAudit(BAAN_MALI, { limit: 200 })).entries.find((entry) => entry.action === "model.cap_set");
    expect(sample).toMatchObject({ actor: { kind: "operator", email: "ops@manut.test" }, outcome: "ok", amountSatang: 30000 });
  });

  it("answers 503 not_configured, naming the setting, when a Worker var cannot be read as the API reads it", async () => {
    const cases: [{ MODEL_SATANG_PER_USD?: string; MODEL_DEFAULT_CAP_SATANG?: string }, string][] = [
      [{ MODEL_DEFAULT_CAP_SATANG: "3,390" }, "MODEL_DEFAULT_CAP_SATANG"],
      [{ MODEL_DEFAULT_CAP_SATANG: "" }, "MODEL_DEFAULT_CAP_SATANG"],
      [{ MODEL_DEFAULT_CAP_SATANG: "1000000001" }, "MODEL_DEFAULT_CAP_SATANG"],
      [{ MODEL_SATANG_PER_USD: "33.90" }, "MODEL_SATANG_PER_USD"],
      [{ MODEL_SATANG_PER_USD: "0" }, "MODEL_SATANG_PER_USD"],
      [{ MODEL_SATANG_PER_USD: "1000001" }, "MODEL_SATANG_PER_USD"],
      // When both are wrong the rate is named, because the API reads it first.
      [{ MODEL_SATANG_PER_USD: "x", MODEL_DEFAULT_CAP_SATANG: "y" }, "MODEL_SATANG_PER_USD"],
    ];
    for (const [vars, setting] of cases) {
      const api = createFakeApi({ now: () => NOW, modelGateway: { vars } });
      await expect(api.getModelUsage(BAAN_MALI)).rejects.toMatchObject({ status: 503, code: "not_configured", setting });
      await expect(api.setModelCap({ tenant: BAAN_MALI, capSatang: 1000 })).rejects.toMatchObject({ status: 503,
        code: "not_configured", setting });
    }
    // The cap is checked before the settings are read, as in the API.
    const broken = createFakeApi({ now: () => NOW, modelGateway: { vars: { MODEL_SATANG_PER_USD: "x" } } });
    await expect(broken.setModelCap({ tenant: BAAN_MALI, capSatang: -1 })).rejects.toMatchObject({ code: "invalid_request" });
  });

  it("takes the default cap from MODEL_DEFAULT_CAP_SATANG, and answers 503 meter_unavailable when the meter is down", async () => {
    const api = createFakeApi({ now: () => NOW, modelGateway: { vars: { MODEL_DEFAULT_CAP_SATANG: "25000",
      MODEL_SATANG_PER_USD: "3390" } } });
    expect(await api.getModelUsage(SABAI_TEA)).toMatchObject({ capSatang: 25000, capSource: "default", remainingSatang: 25000 });
    expect(await api.setModelCap({ tenant: SABAI_TEA, capSatang: null })).toMatchObject({ capSatang: 25000, capSource: "default" });
    // Zero is a readable default: it stops every shop that has no override of its own.
    const stopped = createFakeApi({ now: () => NOW, modelGateway: { vars: { MODEL_DEFAULT_CAP_SATANG: "0" } } });
    expect(await stopped.getModelUsage(SABAI_TEA)).toMatchObject({ capSatang: 0, remainingSatang: 0 });

    const down = createFakeApi({ now: () => NOW, modelGateway: { meterUnavailable: true } });
    await expect(down.getModelUsage(BAAN_MALI)).rejects.toMatchObject({ status: 503, code: "meter_unavailable" });
    await expect(down.setModelCap({ tenant: BAAN_MALI, capSatang: 1000 })).rejects.toMatchObject({ status: 503,
      code: "meter_unavailable" });
    // Refusals that need no meter still come first.
    await expect(down.getModelUsage("")).rejects.toMatchObject({ code: "tenant_required" });
  });

  it("refuses both routes without an operator key", async () => {
    const api = createFakeApi({ operatorKey: () => null });
    await expect(api.getModelUsage(BAAN_MALI)).rejects.toMatchObject({ status: 403, code: "forbidden" });
    await expect(api.setModelCap({ tenant: BAAN_MALI, capSatang: 1000 })).rejects.toMatchObject({ status: 403, code: "forbidden" });
  });

  it("takes a shop's meter and its cap with it when the shop is deleted", async () => {
    const api = createFakeApi({ now: () => NOW, webOrigin: "https://web.test" });
    const link = asked(await api.deleteShop({ tenant: BAAN_MALI, confirmName: "Baan Mali" }));
    await api.decideDeletion(deletionTokenOf(link.confirmUrl), true);
    // As the API's meter, wiped with the rest of the shop's object: an empty month on the default cap.
    expect(await api.getModelUsage(BAAN_MALI)).toMatchObject({ capSatang: 20000, capSource: "default", capOverride: null,
      spentSatang: 0, heldSatang: 0, counts: NO_CALLS, calls: [], holds: [] });
  });

  it("keeps a cap changed in practice across a reload, and starts again on reset", async () => {
    const { storage } = memory();
    await createFakeApi({ now: () => NOW, storage }).setModelCap({ tenant: SABAI_TEA, capSatang: 12345 });
    const reloaded = createFakeApi({ now: () => NOW, storage });
    expect(await reloaded.getModelUsage(SABAI_TEA)).toMatchObject({ capSatang: 12345, capSource: "override" });
    reloaded.reset();
    expect(await reloaded.getModelUsage(SABAI_TEA)).toMatchObject({ capSatang: 20000, capSource: "default" });
  });

  it("replaces a practice world saved without the model meter, whether it is a version behind or only lacks it", async () => {
    const world = { seq: 100, shops: [], connections: [], messages: [], actions: [], payments: [], subscriptionPayments: [],
      deletions: [], confirmations: [], expiredTokens: [], audit: [], memory: {} };
    // Version 5 is a world saved when the team's memory was the newest state: it holds that, but no meter.
    for (const saved of [{ version: 5, ...world }, { version: 6, ...world }]) {
      const kept = memory();
      kept.saved.set("manut.pilot.fake.v1", JSON.stringify(saved));
      const api = createFakeApi({ now: () => NOW, storage: kept.storage });
      expect((await api.listShops()).map((shop) => shop.name)).toEqual(["Baan Mali", "Sabai Tea"]);
      expect((await api.getModelUsage(BAAN_MALI)).spentSatang).toBe(18600);
    }
  });
});

// The owner's people, kept by `@manut/people-rules`' own rules as the API keeps them (docs/people.md): the same statuses
// and codes, a change recorded in the shop's audit log by ids only, and the people exported with the shop and deleted with it.
describe("the fake's people, kept as the API keeps them", () => {
  const NOW = Date.parse("2026-11-23T03:00:00Z");
  const DAY = 24 * 60 * 60 * 1000;
  const BAAN_MALI = "shop_baanmali";
  const SABAI_TEA = "shop_sabaitea";
  const fresh = (now = () => NOW) => createFakeApi({ now, webOrigin: "https://web.test" });
  const operator = { kind: "operator", email: null };
  const named = { kind: "operator", email: "ops@manut.test" };
  const fonDid = { kind: "owner", id: "owner-fon" };
  const ownSession = { kind: "owner", id: "owner-session" };
  const mint = { kind: "email", address: "mint@baanmali.example" } as const;
  const beam = { kind: "line", id: "beam.baanmali" } as const;
  const kai = { kind: "email", address: "kai@sabai.example" } as const;
  // The sample's older people: Tum, whose invite Fon cancelled, and Ice, who joined and whom Fon removed.
  const tum = { kind: "line", id: "tum.baanmali" } as const;
  const ice = { kind: "email", address: "ice@baanmali.example" } as const;

  /// The people entries of a shop's log, oldest first, as what they say: no id and no time.
  async function peopleTrail(api: ReturnType<typeof createFakeApi>, tenant: string) {
    const page = await api.listAudit(tenant, { limit: 200 });
    return page.entries.reverse().filter((entry) => /^(invite|helper|away|request)\./.test(entry.action))
      .map(({ id: _id, at: _at, ...said }) => said);
  }

  /// A browser's storage for the saved world, with the saved text where a test can reach it.
  function kept() {
    const saved = new Map<string, string>();
    const storage = {
      getItem: (key: string) => saved.get(key) ?? null,
      setItem: (key: string, value: string) => void saved.set(key, value),
      removeItem: (key: string) => void saved.delete(key),
    };
    return { saved, storage };
  }

  it("starts Baan Mali with Fon, Mint covering for her, Beam invited and a note Mint passed on, and Sabai Tea with Dao alone", async () => {
    const api = fresh();
    expect(await api.getPeople(BAAN_MALI)).toEqual({
      tenant: BAAN_MALI,
      owner: { name: "Fon", account: { id: "owner-fon", linkedAt: "2026-11-12T03:00:00.000Z", devices: 2 } },
      helpers: [{ id: "helper-mint", name: "Mint", identity: mint, joinedAt: "2026-11-13T03:05:00.000Z", devices: 2 }],
      invites: [
        { id: "inv-tum", name: "Tum", identity: tum, status: "revoked", createdAt: "2026-11-14T03:00:00.000Z",
          expiresAt: "2026-11-21T03:00:00.000Z" },
        { id: "inv-ice", name: "Ice", identity: ice, status: "used", createdAt: "2026-11-15T03:00:00.000Z",
          expiresAt: "2026-11-22T03:00:00.000Z" },
        { id: "inv-mint", name: "Mint", identity: mint, status: "used", createdAt: "2026-11-13T03:00:00.000Z",
          expiresAt: "2026-11-20T03:00:00.000Z" },
        { id: "inv-beam", name: "Beam", identity: beam, status: "pending", createdAt: "2026-11-23T01:00:00.000Z",
          expiresAt: "2026-11-30T01:00:00.000Z", inviteUrl: "https://web.test/join/practice-inv-beam" },
      ],
      // Until the end of Friday 27 November, the shop's day: Mint covers messages while Fon is away.
      away: { helperId: "helper-mint", name: "Mint", until: "2026-11-27T16:59:59.000Z", inForce: true },
      passedOn: [{ requestId: "req_refund", kind: "money", by: "helper-mint", name: "Mint",
        note: "The customer sent a photo of the broken jar. It looks right to me.", at: "2026-11-23T00:00:00.000Z" }],
      // Ice joined and was removed by Fon; the people list keeps the name so the log can still say who it was.
      removed: [{ id: "helper-ice", name: "Ice" }],
    });
    expect(await api.getPeople(SABAI_TEA)).toEqual({ tenant: SABAI_TEA, owner: { name: "Dao", account: null }, helpers: [],
      invites: [], away: null, passedOn: [], removed: [] });
  });

  it("answers as the API does for no tenant, a tenant that is not a shop, and a shop that was deleted", async () => {
    const api = fresh();
    await expect(api.getPeople("")).rejects.toMatchObject({ status: 400, code: "tenant_required" });
    await expect(api.getPeople("shop_nobody")).rejects.toMatchObject({ status: 404, code: "shop_not_found" });
    await expect(api.createInvite({ tenant: "shop_nobody", name: "Beam", identity: beam })).rejects
      .toMatchObject({ status: 404, code: "shop_not_found" });
    await expect(api.createInvite({ tenant: "", name: "Beam", identity: beam })).rejects
      .toMatchObject({ status: 400, code: "tenant_required" });
    // The people routes only ever say shop_not_found, a deleted shop's included.
    await api.deleteShop({ tenant: SABAI_TEA, confirmName: "Sabai Tea" });
    await expect(api.getPeople(SABAI_TEA)).rejects.toMatchObject({ status: 404, code: "shop_not_found" });
    await expect(api.clearAway({ tenant: SABAI_TEA })).rejects.toMatchObject({ status: 404, code: "shop_not_found" });
  });

  it("makes an invite for 7 days with a link to copy, shows the same link again, and logs only its id", async () => {
    const api = fresh();
    const made = await api.createInvite({ tenant: SABAI_TEA, name: "  Café Kai ", identity: { kind: "email", address: " Kai@Sabai.example " } });
    expect(made.invite).toEqual({ id: expect.stringMatching(/^inv-/), name: "Café Kai",
      identity: { kind: "email", address: "Kai@Sabai.example" }, status: "pending", createdAt: "2026-11-23T03:00:00.000Z",
      expiresAt: "2026-11-30T03:00:00.000Z" });
    expect(made.inviteUrl).toMatch(/^https:\/\/web\.test\/join\/practice-inv-\d+$/);
    expect((await api.getPeople(SABAI_TEA)).invites).toEqual([{ ...made.invite, inviteUrl: made.inviteUrl }]);
    expect(await peopleTrail(api, SABAI_TEA)).toEqual([
      { actor: operator, action: "invite.created", subject: { inviteId: made.invite.id }, outcome: "ok" }]);
    // The log names ids only: never the name the owner gave, nor the account's value.
    const written = JSON.stringify(await api.listAudit(SABAI_TEA));
    expect(written).not.toContain("Kai");
    expect(written).not.toContain("sabai.example");
  });

  it("keeps a name of up to 80 characters, and refuses what the API refuses without writing anything", async () => {
    const api = fresh();
    const tenant = SABAI_TEA;
    expect((await api.createInvite({ tenant, name: "x".repeat(80), identity: kai })).invite.name).toBe("x".repeat(80));
    const refusals: [unknown, number, string][] = [
      [{ name: "", identity: beam }, 400, "invalid_request"],
      [{ name: "   ", identity: beam }, 400, "invalid_request"],
      [{ name: "x".repeat(81), identity: beam }, 400, "invalid_request"],
      [{ name: "Be\u0007am", identity: beam }, 400, "invalid_request"],
      [{ name: 5, identity: beam }, 400, "invalid_request"],
      [{ name: "Beam", identity: "beam" }, 400, "invalid_request"],
      [{ name: "Beam", identity: { kind: "phone", number: "0812345678" } }, 400, "invalid_request"],
      [{ name: "Beam" }, 400, "invalid_request"],
      [{ name: "Beam", identity: { kind: "line", id: "" } }, 400, "bad_identity"],
      [{ name: "Beam", identity: { kind: "email", address: "beam" } }, 400, "bad_identity"],
      [{ name: "Beam", identity: { kind: "email", address: "be am@x" } }, 400, "bad_identity"],
    ];
    for (const [input, status, code] of refusals) {
      await expect(api.createInvite({ tenant, ...(input as object) } as never)).rejects.toMatchObject({ status, code });
    }
    expect((await api.getPeople(tenant)).invites).toHaveLength(1);
    expect(await peopleTrail(api, tenant)).toHaveLength(1);
  });

  it("refuses a second open invite for the same account and an invite for a current helper, comparing emails without case", async () => {
    const api = fresh();
    await expect(api.createInvite({ tenant: BAAN_MALI, name: "Beam again", identity: beam })).rejects
      .toMatchObject({ status: 409, code: "already_invited" });
    // A LINE account id is compared exactly, so another capitalisation is another account.
    expect(await api.createInvite({ tenant: BAAN_MALI, name: "Beam B", identity: { kind: "line", id: "Beam.Baanmali" } }))
      .toMatchObject({ invite: { status: "pending" } });
    await expect(api.createInvite({ tenant: BAAN_MALI, name: "Mint again",
      identity: { kind: "email", address: " MINT@baanmali.EXAMPLE " } })).rejects.toMatchObject({ status: 409, code: "already_helper" });
    await api.createInvite({ tenant: SABAI_TEA, name: "Kai", identity: kai });
    await expect(api.createInvite({ tenant: SABAI_TEA, name: "Kai again",
      identity: { kind: "email", address: "KAI@SABAI.EXAMPLE" } })).rejects.toMatchObject({ status: 409, code: "already_invited" });
  });

  it("reads an invite as expired once its 7 days are over, with no link, and lets the same account be invited again", async () => {
    let now = NOW;
    const api = fresh(() => now);
    const first = await api.createInvite({ tenant: SABAI_TEA, name: "Kai", identity: kai });
    now += 7 * DAY - 1;
    expect((await api.getPeople(SABAI_TEA)).invites[0]).toMatchObject({ status: "pending", inviteUrl: first.inviteUrl });
    now += 1;
    const expired = (await api.getPeople(SABAI_TEA)).invites[0];
    expect(expired).toMatchObject({ id: first.invite.id, status: "expired" });
    expect(expired?.inviteUrl).toBeUndefined();
    const second = await api.createInvite({ tenant: SABAI_TEA, name: "Kai", identity: kai });
    expect(second.invite.id).not.toBe(first.invite.id);
  });

  it("cancels an invite that waits, once, and refuses what the API refuses", async () => {
    const api = fresh();
    const cancelled = await api.revokeInvite({ tenant: BAAN_MALI, inviteId: "inv-beam" });
    expect(cancelled).toEqual({ invite: { id: "inv-beam", name: "Beam", identity: beam, status: "revoked",
      createdAt: "2026-11-23T01:00:00.000Z", expiresAt: "2026-11-30T01:00:00.000Z" } });
    expect((await api.getPeople(BAAN_MALI)).invites.find((invite) => invite.id === "inv-beam")).toEqual(cancelled.invite);
    // Cancelled and used invites cannot be cancelled again; an id the shop does not hold is unknown.
    for (const inviteId of ["inv-beam", "inv-mint"]) {
      await expect(api.revokeInvite({ tenant: BAAN_MALI, inviteId })).rejects.toMatchObject({ status: 409, code: "not_pending" });
    }
    await expect(api.revokeInvite({ tenant: BAAN_MALI, inviteId: "inv-nobody" })).rejects
      .toMatchObject({ status: 404, code: "unknown_invite" });
    await expect(api.revokeInvite({ tenant: SABAI_TEA, inviteId: "inv-beam" })).rejects
      .toMatchObject({ status: 404, code: "unknown_invite" });
    await expect(api.revokeInvite({ tenant: BAAN_MALI, inviteId: 5 as never })).rejects
      .toMatchObject({ status: 400, code: "invalid_request" });
    expect((await peopleTrail(api, BAAN_MALI)).filter((entry) => entry.action === "invite.revoked")).toEqual([
      { actor: fonDid, action: "invite.revoked", subject: { inviteId: "inv-tum" }, outcome: "ok" },
      { actor: operator, action: "invite.revoked", subject: { inviteId: "inv-beam" }, outcome: "ok" }]);
  });

  it("removes a helper, ending their cover and sessions in the same step, and keeps their name for the log", async () => {
    const api = fresh();
    expect(await api.removeHelper({ tenant: BAAN_MALI, helperId: "helper-mint" })).toEqual({ removed: "helper-mint",
      sessionsEnded: 2, invitesRevoked: [], coverEnded: true });
    const people = await api.getPeople(BAAN_MALI);
    expect(people.helpers).toEqual([]);
    expect(people.away).toBeNull();
    expect(people.removed).toEqual([{ id: "helper-ice", name: "Ice" }, { id: "helper-mint", name: "Mint" }]);
    // What Mint passed on stays, with Mint's name.
    expect(people.passedOn).toEqual([expect.objectContaining({ by: "helper-mint", name: "Mint" })]);
    await expect(api.removeHelper({ tenant: BAAN_MALI, helperId: "helper-mint" })).rejects
      .toMatchObject({ status: 404, code: "not_a_helper" });
    await expect(api.removeHelper({ tenant: BAAN_MALI, helperId: 7 as never })).rejects
      .toMatchObject({ status: 400, code: "invalid_request" });
    expect((await peopleTrail(api, BAAN_MALI)).filter((entry) => entry.action === "helper.removed")).toEqual([
      { actor: fonDid, action: "helper.removed", subject: { helperId: "helper-ice" }, outcome: "ok" },
      { actor: operator, action: "helper.removed", subject: { helperId: "helper-mint" }, outcome: "ok" }]);
    // A removed helper can be invited again, as a new helper.
    expect(await api.createInvite({ tenant: BAAN_MALI, name: "Mint", identity: mint })).toMatchObject({ invite: { status: "pending" } });
  });

  it("sets cover until a date in the future, says when it is over, and clears it, recording only what changed", async () => {
    let now = NOW;
    const api = fresh(() => now);
    const until = "2026-11-30T16:59:59.000Z";
    expect(await api.setAway({ tenant: BAAN_MALI, helperId: "helper-mint", until })).toEqual({
      away: { helperId: "helper-mint", name: "Mint", until, inForce: true } });
    expect((await api.getPeople(BAAN_MALI)).away).toEqual({ helperId: "helper-mint", name: "Mint", until, inForce: true });

    const refusals: [object, number, string][] = [
      [{ helperId: "helper-mint", until: "2026-11-23T03:00:00.000Z" }, 400, "bad_date"],
      [{ helperId: "helper-mint", until: "2026-11-22T03:00:00.000Z" }, 400, "bad_date"],
      [{ helperId: "helper-mint", until: "next friday" }, 400, "bad_date"],
      [{ helperId: "helper-mint", until: 5 }, 400, "bad_date"],
      [{ helperId: "helper-nobody", until }, 404, "not_a_helper"],
      [{ helperId: 5, until }, 400, "invalid_request"],
    ];
    for (const [input, status, code] of refusals) {
      await expect(api.setAway({ tenant: BAAN_MALI, ...input } as never)).rejects.toMatchObject({ status, code });
    }
    expect((await api.getPeople(BAAN_MALI)).away).toMatchObject({ until });

    // Cover holds until its date exactly, and stays on record, no longer in force, until it is cleared.
    now = Date.parse(until);
    expect((await api.getPeople(BAAN_MALI)).away).toEqual({ helperId: "helper-mint", name: "Mint", until, inForce: false });
    expect(await api.clearAway({ tenant: BAAN_MALI })).toEqual({ away: null });
    expect((await api.getPeople(BAAN_MALI)).away).toBeNull();
    const written = (await api.listAudit(BAAN_MALI, { limit: 200 })).entries.length;
    expect(await api.clearAway({ tenant: BAAN_MALI })).toEqual({ away: null });
    expect((await api.listAudit(BAAN_MALI, { limit: 200 })).entries.length).toBe(written);
    expect((await peopleTrail(api, BAAN_MALI)).filter((entry) => entry.action.startsWith("away."))).toEqual([
      // Ice's cover, set from the shop's own session and ended by Fon before Ice was removed, then Mint's from the sample.
      { actor: ownSession, action: "away.set", subject: { helperId: "helper-ice" }, outcome: "ok" },
      { actor: fonDid, action: "away.cleared", subject: { helperId: "helper-ice" }, outcome: "ok" },
      { actor: operator, action: "away.set", subject: { helperId: "helper-mint" }, outcome: "ok" },
      { actor: operator, action: "away.set", subject: { helperId: "helper-mint" }, outcome: "ok" },
      { actor: operator, action: "away.cleared", subject: { helperId: "helper-mint" }, outcome: "ok" },
    ]);
  });

  it("starts the log with what the sample people did, by ids only", async () => {
    const api = fresh();
    const mintDid = { kind: "helper", id: "helper-mint" };
    expect(await peopleTrail(api, BAAN_MALI)).toEqual([
      { actor: operator, action: "invite.created", subject: { inviteId: "inv-mint" }, outcome: "ok" },
      { actor: mintDid, action: "helper.joined", subject: { inviteId: "inv-mint", helperId: "helper-mint" }, outcome: "ok" },
      // Fon cancelled Tum's invite; an operator invited Ice, who joined, was set to cover from the shop's own session, had the
      // cover ended by Fon, and was removed by Fon.
      { actor: fonDid, action: "invite.created", subject: { inviteId: "inv-tum" }, outcome: "ok" },
      { actor: fonDid, action: "invite.revoked", subject: { inviteId: "inv-tum" }, outcome: "ok" },
      { actor: named, action: "invite.created", subject: { inviteId: "inv-ice" }, outcome: "ok" },
      { actor: { kind: "helper", id: "helper-ice" }, action: "helper.joined", subject: { inviteId: "inv-ice", helperId: "helper-ice" },
        outcome: "ok" },
      { actor: ownSession, action: "away.set", subject: { helperId: "helper-ice" }, outcome: "ok" },
      { actor: fonDid, action: "away.cleared", subject: { helperId: "helper-ice" }, outcome: "ok" },
      { actor: fonDid, action: "helper.removed", subject: { helperId: "helper-ice" }, outcome: "ok" },
      // A device of Mint's signed in and out again, and the one still open signed in two days ago.
      { actor: mintDid, action: "helper.session_opened", subject: { helperId: "helper-mint" }, outcome: "ok" },
      { actor: mintDid, action: "helper.session_ended", subject: { helperId: "helper-mint" }, outcome: "ok" },
      { actor: mintDid, action: "helper.session_opened", subject: { helperId: "helper-mint" }, outcome: "ok" },
      { actor: operator, action: "away.set", subject: { helperId: "helper-mint" }, outcome: "ok" },
      { actor: mintDid, action: "request.passed_on", subject: { requestId: "req_refund", taskId: "task_shop_baanmali" },
        outcome: "ok" },
      { actor: operator, action: "invite.created", subject: { inviteId: "inv-beam" }, outcome: "ok" },
    ]);
    const written = JSON.stringify(await api.listAudit(BAAN_MALI, { limit: 200 }));
    for (const private_ of ["Mint", "mint@baanmali", "Beam", "beam.baanmali", "broken jar", "Tum", "tum.baanmali", "Ice",
      "ice@baanmali"]) expect(written).not.toContain(private_);
    // The newest entry is still the newest reply of the sample world.
    expect((await api.listAudit(BAAN_MALI)).entries[0]).toMatchObject({ action: "reply.proposed" });
  });

  it("exports the people with the shop, and deletes them with it", async () => {
    const api = fresh();
    const exported = await api.exportShop(BAAN_MALI);
    expect(exported.people).toMatchObject({ names: { "helper-mint": "Mint", "inv-beam": "Beam" },
      state: { shop: BAAN_MALI, ownerId: "owner", helpers: [expect.objectContaining({ id: "helper-mint" })] } });
    expect((await api.exportShop(SABAI_TEA)).people).toEqual({ names: {}, ownerAccount: null,
      state: { shop: SABAI_TEA, ownerId: "owner", helpers: [], invites: [], away: null, passedOn: [], removed: [] } });
    const link = asked(await api.deleteShop({ tenant: BAAN_MALI, confirmName: "Baan Mali" }));
    await api.decideDeletion(deletionTokenOf(link.confirmUrl), true);
    await expect(api.getPeople(BAAN_MALI)).rejects.toMatchObject({ status: 404, code: "shop_not_found" });
  });

  it("keeps people changed in practice across a reload, and starts again on reset", async () => {
    const { storage } = kept();
    await createFakeApi({ now: () => NOW, storage }).removeHelper({ tenant: BAAN_MALI, helperId: "helper-mint" });
    const reloaded = createFakeApi({ now: () => NOW, storage });
    expect((await reloaded.getPeople(BAAN_MALI)).helpers).toEqual([]);
    reloaded.reset();
    expect((await reloaded.getPeople(BAAN_MALI)).helpers).toHaveLength(1);
  });

  it("replaces a practice world saved before people existed, whether it is a version behind or only lacks them", async () => {
    // Version 7 is a world saved with the workers' jobs and no people; a world that says it is version 8 but lacks them is read as
    // the half it holds, so it is replaced too.
    for (const change of [{ version: 7, people: undefined }, { people: undefined }]) {
      const { saved, storage } = kept();
      const first = createFakeApi({ now: () => NOW, storage });
      await first.removeHelper({ tenant: BAAN_MALI, helperId: "helper-mint" });
      const world = JSON.parse(saved.get("manut.pilot.fake.v1")!) as Record<string, unknown>;
      saved.set("manut.pilot.fake.v1", JSON.stringify({ ...world, ...change }));
      const api = createFakeApi({ now: () => NOW, storage });
      // The world was read as a fresh one: Mint is back, and the shops are the sample's.
      expect((await api.listShops()).map((shop) => shop.name)).toEqual(["Baan Mali", "Sabai Tea"]);
      expect((await api.getPeople(BAAN_MALI)).helpers.map((helper) => helper.name)).toEqual(["Mint"]);
    }
  });

  it("refuses every people route without an operator key", async () => {
    const api = createFakeApi({ operatorKey: () => null });
    for (const call of [
      () => api.getPeople(BAAN_MALI),
      () => api.createInvite({ tenant: BAAN_MALI, name: "Beam", identity: beam }),
      () => api.revokeInvite({ tenant: BAAN_MALI, inviteId: "inv-beam" }),
      () => api.removeHelper({ tenant: BAAN_MALI, helperId: "helper-mint" }),
      () => api.setAway({ tenant: BAAN_MALI, helperId: "helper-mint", until: "2030-01-01T00:00:00.000Z" }),
      () => api.clearAway({ tenant: BAAN_MALI }),
    ]) await expect(call()).rejects.toMatchObject({ status: 403, code: "forbidden" });
  });
});

describe("the fake's worker jobs, read as GET /v1/admin/workers/drafts reads them", () => {
  const NOW = Date.parse("2026-11-23T03:00:00Z"); // 10:00 on 23 November in Bangkok
  const BAAN_MALI = "shop_baanmali";
  const SABAI_TEA = "shop_sabaitea";
  const JOB = /^worker-task-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

  function memory() {
    const saved = new Map<string, string>();
    return {
      saved,
      storage: {
        getItem: (key: string) => saved.get(key) ?? null,
        setItem: (key: string, value: string) => void saved.set(key, value),
        removeItem: (key: string) => void saved.delete(key),
      },
    };
  }

  it("gives Baan Mali a believable run of jobs, newest first, with each way a job can end that Nam, Pim and Ton reach", async () => {
    const { tenant, jobs, next } = await createFakeApi({ now: () => NOW }).listWorkerJobs(BAAN_MALI);
    expect(tenant).toBe(BAAN_MALI);
    expect(next).toBeNull();
    expect(jobs).toHaveLength(7);
    expect(jobs.every((job) => JOB.test(job.taskId))).toBe(true);
    expect(new Set(jobs.map((job) => job.taskId)).size).toBe(7);
    // Newest first, all of them already run.
    expect(jobs.map((job) => job.at)).toEqual([...jobs.map((job) => job.at)].sort().reverse());
    expect(jobs.every((job) => Date.parse(job.at) < NOW)).toBe(true);
    expect(new Set(jobs.map((job) => job.ending.state))).toEqual(new Set(["done", "failed", "awaiting_owner", "handed_over"]));
    expect(new Set(jobs.map((job) => job.member))).toEqual(new Set(["nam", "pim", "ton"]));
    expect(new Set(jobs.map((job) => job.job))).toEqual(new Set(["reply", "post", "daily_summary"]));

    // A job Nam passed to Ton, who did it; a job Pim passed to Nam, who has not taken it up; one that failed with its
    // reason and wrote nothing; one waiting for the owner, with the draft it wrote.
    expect(jobs.find((job) => job.passedFrom)).toMatchObject({ member: "ton", passedFrom: "nam", job: "daily_summary",
      ending: { state: "done" } });
    expect(jobs.find((job) => job.ending.state === "handed_over")).toMatchObject({ member: "pim", job: "reply",
      ending: { state: "handed_over", to: "nam" }, draft: null });
    expect(jobs.find((job) => job.ending.state === "failed")).toMatchObject({ member: "ton",
      ending: { state: "failed", reason: "payments_unavailable" }, draft: null });
    expect(jobs.find((job) => job.ending.state === "awaiting_owner")).toMatchObject({ member: "pim", job: "post",
      draft: { text: expect.any(String) } });

    // Money is whole satang, and a reply says what sending it would take and which message it answers.
    for (const job of jobs) {
      if (job.costSatang !== undefined) expect(Number.isSafeInteger(job.costSatang) && job.costSatang >= 0).toBe(true);
    }
    const replies = jobs.filter((job) => job.job === "reply" && job.draft);
    expect(replies.length).toBeGreaterThan(0);
    for (const reply of replies) {
      expect(reply.draft).toMatchObject({ about: { messageId: expect.stringMatching(/^msg_/) },
        send: { answer: "ask", kind: "reply" } });
    }
    // A summary names the day it covers.
    expect(jobs.find((job) => job.job === "daily_summary" && job.draft)?.draft?.about)
      .toEqual({ date: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) });
  });

  it("gives Sabai Tea no jobs yet, and answers a tenant that is no shop 404 shop_not_found, as the API does", async () => {
    const api = createFakeApi({ now: () => NOW });
    expect(await api.listWorkerJobs(SABAI_TEA)).toEqual({ tenant: SABAI_TEA, jobs: [], next: null });
    await expect(api.listWorkerJobs("shop_nobody")).rejects.toMatchObject({ status: 404, code: "shop_not_found" });
  });

  it("pages newest first by a job's task id, and refuses what the API refuses, in the API's order", async () => {
    const api = createFakeApi({ now: () => NOW });
    const everything = (await api.listWorkerJobs(BAAN_MALI)).jobs;
    const first = await api.listWorkerJobs(BAAN_MALI, { limit: 3 });
    expect(first.jobs).toEqual(everything.slice(0, 3));
    expect(first.next).toBe(everything[2]!.taskId);
    const second = await api.listWorkerJobs(BAAN_MALI, { limit: 3, before: first.next! });
    expect(second.jobs).toEqual(everything.slice(3, 6));
    expect(second.next).toBe(everything[5]!.taskId);
    const third = await api.listWorkerJobs(BAAN_MALI, { limit: 3, before: second.next! });
    expect(third).toEqual({ tenant: BAAN_MALI, jobs: everything.slice(6), next: null });

    await expect(api.listWorkerJobs("")).rejects.toMatchObject({ status: 400, code: "tenant_required" });
    for (const limit of [0, 26, 1.5, -1, Number.NaN]) {
      await expect(api.listWorkerJobs(BAAN_MALI, { limit })).rejects.toMatchObject({ status: 400, code: "invalid_request" });
    }
    for (const before of ["nope", "pilot-task-6a7c1f00-0000-4000-8000-000000000001", `${everything[0]!.taskId}\n`,
      // Well formed, but none of the shop's jobs.
      "worker-task-00000000-0000-4000-8000-000000000000"]) {
      await expect(api.listWorkerJobs(BAAN_MALI, { before })).rejects.toMatchObject({ status: 400, code: "invalid_request" });
    }
    // The page is checked before the shop is read, so a bad size for a tenant that is no shop is still a 400.
    await expect(api.listWorkerJobs("shop_nobody", { limit: 0 })).rejects.toMatchObject({ status: 400, code: "invalid_request" });
    await expect(api.listWorkerJobs("shop_nobody", { limit: 5 })).rejects.toMatchObject({ status: 404, code: "shop_not_found" });
  });

  it("refuses the route without an operator key", async () => {
    await expect(createFakeApi({ operatorKey: () => null }).listWorkerJobs(BAAN_MALI)).rejects.toMatchObject({ status: 403,
      code: "forbidden" });
  });

  it("takes a shop's jobs with it when the shop is deleted", async () => {
    const kept = memory();
    const api = createFakeApi({ now: () => NOW, storage: kept.storage, webOrigin: "https://web.test" });
    const link = asked(await api.deleteShop({ tenant: BAAN_MALI, confirmName: "Baan Mali" }));
    await api.decideDeletion(deletionTokenOf(link.confirmUrl), true);
    await expect(api.listWorkerJobs(BAAN_MALI)).rejects.toMatchObject({ status: 404, code: "shop_not_found" });
    // Gone from what is stored, not only hidden behind the missing shop.
    const world = JSON.parse(kept.saved.get("manut.pilot.fake.v1")!) as { workers: { tenant: string }[] };
    expect(world.workers.filter((job) => job.tenant === BAAN_MALI)).toEqual([]);
  });

  it("replaces a practice world saved before the workers' jobs were kept, whether it is a version behind or only lacks them", async () => {
    const world = { seq: 100, shops: [], connections: [], messages: [], actions: [], payments: [], subscriptionPayments: [],
      deletions: [], confirmations: [], expiredTokens: [], audit: [], memory: {}, model: { overrides: [], calls: [], holds: [] } };
    // Version 6 is a world saved when the model meter was the newest state: it holds that, but no jobs.
    for (const saved of [{ version: 6, ...world }, { version: 7, ...world }]) {
      const kept = memory();
      kept.saved.set("manut.pilot.fake.v1", JSON.stringify(saved));
      const api = createFakeApi({ now: () => NOW, storage: kept.storage });
      expect((await api.listShops()).map((shop) => shop.name)).toEqual(["Baan Mali", "Sabai Tea"]);
      expect((await api.listWorkerJobs(BAAN_MALI)).jobs).toHaveLength(7);
    }
  });
});

// The owner's linked account, kept as the API keeps it (docs/several-shops.md; docs/pilot-api.md, "Several shops"): the same
// statuses and codes for both routes, a change recorded in the shop's audit log by the link's id only, and the link
// exported with the shop and deleted with it. The practice world holds the codes an owner's app might have shown.
describe("the fake's owner link, kept as the API keeps it", () => {
  const NOW = Date.parse("2026-11-23T03:00:00Z");
  const BAAN_MALI = "shop_baanmali";
  const SABAI_TEA = "shop_sabaitea";
  const fresh = (now = () => NOW) => createFakeApi({ now });
  const operator = { kind: "operator", email: null };
  const { dao, fon, guest, ranOut } = PRACTICE_OWNER_CODES;

  /// The owner entries of a shop's log, oldest first, as what they say: no id and no time.
  async function linkTrail(api: ReturnType<typeof createFakeApi>, tenant: string) {
    const page = await api.listAudit(tenant, { limit: 200 });
    return page.entries.reverse().filter((entry) => entry.action.startsWith("owner."))
      .map(({ id: _id, at: _at, ...said }) => said);
  }

  /// A browser's storage for the saved world, with the saved text where a test can reach it.
  function kept() {
    const saved = new Map<string, string>();
    const storage = {
      getItem: (key: string) => saved.get(key) ?? null,
      setItem: (key: string, value: string) => void saved.set(key, value),
      removeItem: (key: string) => void saved.delete(key),
    };
    return { saved, storage };
  }

  it("starts Baan Mali linked to Fon's account on two devices, and Sabai Tea with no account, by ids only in the log", async () => {
    const api = fresh();
    expect((await api.getPeople(BAAN_MALI)).owner).toEqual({ name: "Fon",
      account: { id: "owner-fon", linkedAt: "2026-11-12T03:00:00.000Z", devices: 2 } });
    expect((await api.getPeople(SABAI_TEA)).owner).toEqual({ name: "Dao", account: null });
    const fonDid = { kind: "owner", id: "owner-fon" };
    expect(await linkTrail(api, BAAN_MALI)).toEqual([
      { actor: operator, action: "owner.linked", subject: { ownerAccountId: "owner-fon" }, outcome: "ok" },
      { actor: fonDid, action: "owner.session_opened", subject: { ownerAccountId: "owner-fon" }, outcome: "ok" },
      // A device that signed in and out again; the two still open are the first and the one of three days ago.
      { actor: fonDid, action: "owner.session_opened", subject: { ownerAccountId: "owner-fon" }, outcome: "ok" },
      { actor: fonDid, action: "owner.session_ended", subject: { ownerAccountId: "owner-fon" }, outcome: "ok" },
      { actor: fonDid, action: "owner.session_opened", subject: { ownerAccountId: "owner-fon" }, outcome: "ok" },
    ]);
    // The newest entry is still the newest reply of the sample world, and the log never names the account itself.
    expect((await api.listAudit(BAAN_MALI)).entries[0]).toMatchObject({ action: "reply.proposed" });
    expect(JSON.stringify(await api.listAudit(BAAN_MALI, { limit: 200 }))).not.toContain("apple:");
  });

  it("links the account a code names, typed in any case with or without the dash, once, and logs only the link's id", async () => {
    const api = fresh();
    const made = await api.linkOwner({ tenant: SABAI_TEA, code: `  ${dao.toLowerCase().replace("-", "")} ` });
    expect(made).toEqual({ tenant: SABAI_TEA, ownerAccount: { id: expect.stringMatching(/^owner-/),
      linkedAt: "2026-11-23T03:00:00.000Z" } });
    // No app has opened the shop yet, so no device has it.
    expect((await api.getPeople(SABAI_TEA)).owner).toEqual({ name: "Dao",
      account: { id: made.ownerAccount.id, linkedAt: "2026-11-23T03:00:00.000Z", devices: 0 } });
    expect(await linkTrail(api, SABAI_TEA)).toEqual([
      { actor: operator, action: "owner.linked", subject: { ownerAccountId: made.ownerAccount.id }, outcome: "ok" }]);
    await expect(api.linkOwner({ tenant: SABAI_TEA, code: dao })).rejects.toMatchObject({ status: 404, code: "unknown_code" });
    expect(JSON.stringify(await api.listAudit(SABAI_TEA))).not.toContain("apple:");
  });

  it("reads O, I and L as 0, 1 and 1 and ignores spaces, as the API does", async () => {
    for (const typed of ["7KOM-4XIR", "7kom4xlr", " 7K0M 4X1R ", "7K0M-4X1R"]) {
      const made = await fresh().linkOwner({ tenant: SABAI_TEA, code: typed });
      expect(made.ownerAccount.id).toMatch(/^owner-/);
    }
  });

  it("answers as the API does for text that is no code, a code nobody made, a code that ran out and a shop that is not there", async () => {
    const api = fresh();
    for (const code of ["", "not a code", "7K0M-4X1", "7K0M-4X1RZ", "ZZZZ-ZZZZ", "7KUM-4X1R"]) {
      await expect(api.linkOwner({ tenant: SABAI_TEA, code })).rejects.toMatchObject({ status: 404, code: "unknown_code" });
    }
    await expect(api.linkOwner({ tenant: SABAI_TEA, code: ranOut })).rejects.toMatchObject({ status: 410, code: "code_expired" });
    // A code goes the first time it is tried, whatever the answer, so a late one cannot be tried again either.
    await expect(api.linkOwner({ tenant: SABAI_TEA, code: ranOut })).rejects.toMatchObject({ status: 404, code: "unknown_code" });
    await expect(api.linkOwner({ tenant: SABAI_TEA, code: 12345678 as never })).rejects
      .toMatchObject({ status: 400, code: "invalid_request" });
    await expect(api.linkOwner({ tenant: "", code: dao })).rejects.toMatchObject({ status: 400, code: "tenant_required" });
    // The shop is checked before a code is used, so a shop that is not there leaves the code for the one that is.
    await expect(api.linkOwner({ tenant: "shop_nobody", code: dao })).rejects.toMatchObject({ status: 404, code: "shop_not_found" });
    expect((await api.linkOwner({ tenant: SABAI_TEA, code: dao })).ownerAccount.id).toMatch(/^owner-/);
    // None of the refusals was recorded.
    expect(await linkTrail(api, SABAI_TEA)).toHaveLength(1);
  });

  it("keeps one account per shop: another's code is used up and refused, and the same account's changes and records nothing", async () => {
    const api = fresh();
    // Fon's account is already Baan Mali's: her new code answers the link it has, and writes nothing.
    expect(await api.linkOwner({ tenant: BAAN_MALI, code: fon })).toEqual({ tenant: BAAN_MALI,
      ownerAccount: { id: "owner-fon", linkedAt: "2026-11-12T03:00:00.000Z" } });
    expect((await linkTrail(api, BAAN_MALI)).filter((entry) => entry.action === "owner.linked")).toHaveLength(1);
    expect((await api.getPeople(BAAN_MALI)).owner.account?.devices).toBe(2);
    // Another account's code is refused, and used up all the same.
    await expect(api.linkOwner({ tenant: BAAN_MALI, code: guest })).rejects.toMatchObject({ status: 409, code: "already_linked" });
    await expect(api.linkOwner({ tenant: SABAI_TEA, code: guest })).rejects.toMatchObject({ status: 404, code: "unknown_code" });
    expect((await api.getPeople(BAAN_MALI)).owner.account?.id).toBe("owner-fon");
    expect((await linkTrail(api, BAAN_MALI)).filter((entry) => entry.action === "owner.linked")).toHaveLength(1);
  });

  it("unlinks the account, ending its sessions in the same step, and logs only the link's id", async () => {
    const api = fresh();
    expect(await api.unlinkOwner({ tenant: BAAN_MALI })).toEqual({ tenant: BAAN_MALI, unlinked: "owner-fon", sessionsEnded: 2 });
    expect((await api.getPeople(BAAN_MALI)).owner).toEqual({ name: "Fon", account: null });
    expect((await linkTrail(api, BAAN_MALI)).filter((entry) => entry.action === "owner.unlinked")).toEqual([
      { actor: operator, action: "owner.unlinked", subject: { ownerAccountId: "owner-fon" }, outcome: "ok" }]);
    // Unlinking again, or a shop never linked, finds nothing; the shop checks come first, as they do in the API.
    await expect(api.unlinkOwner({ tenant: BAAN_MALI })).rejects.toMatchObject({ status: 404, code: "not_linked" });
    await expect(api.unlinkOwner({ tenant: SABAI_TEA })).rejects.toMatchObject({ status: 404, code: "not_linked" });
    await expect(api.unlinkOwner({ tenant: "shop_nobody" })).rejects.toMatchObject({ status: 404, code: "shop_not_found" });
    await expect(api.unlinkOwner({ tenant: "" })).rejects.toMatchObject({ status: 400, code: "tenant_required" });
    // Linking again makes a new link, with no device on it yet; the old one's sessions stay ended.
    const again = await api.linkOwner({ tenant: BAAN_MALI, code: fon });
    expect(again.ownerAccount.id).not.toBe("owner-fon");
    expect((await api.getPeople(BAAN_MALI)).owner.account).toEqual({ id: again.ownerAccount.id,
      linkedAt: "2026-11-23T03:00:00.000Z", devices: 0 });
  });

  it("keeps the link when the people around it change: an invite, a removal, a cover", async () => {
    const api = fresh();
    const linked = (await api.linkOwner({ tenant: SABAI_TEA, code: dao })).ownerAccount;
    await api.createInvite({ tenant: SABAI_TEA, name: "Kai", identity: { kind: "email", address: "kai@sabai.example" } });
    expect((await api.getPeople(SABAI_TEA)).owner.account).toMatchObject({ id: linked.id, devices: 0 });
    await api.removeHelper({ tenant: BAAN_MALI, helperId: "helper-mint" });
    await api.clearAway({ tenant: BAAN_MALI });
    await api.revokeInvite({ tenant: BAAN_MALI, inviteId: "inv-beam" });
    expect((await api.getPeople(BAAN_MALI)).owner.account).toEqual({ id: "owner-fon", linkedAt: "2026-11-12T03:00:00.000Z", devices: 2 });
  });

  it("exports the link with the shop, with the account's subject as the API's export carries it, and deletes it with the shop", async () => {
    const api = createFakeApi({ now: () => NOW, webOrigin: "https://web.test" });
    expect((await api.exportShop(BAAN_MALI)).people).toMatchObject({ ownerAccount: { id: "owner-fon",
      subject: expect.stringMatching(/^apple:/), linkedAt: Date.parse("2026-11-12T03:00:00.000Z") } });
    expect((await api.exportShop(SABAI_TEA)).people).toMatchObject({ ownerAccount: null });
    // A count of devices is not part of the export, as the API never carries a session in it.
    expect(JSON.stringify((await api.exportShop(BAAN_MALI)).people)).not.toContain("devices");
    const link = asked(await api.deleteShop({ tenant: BAAN_MALI, confirmName: "Baan Mali" }));
    await api.decideDeletion(deletionTokenOf(link.confirmUrl), true);
    await expect(api.getPeople(BAAN_MALI)).rejects.toMatchObject({ status: 404, code: "shop_not_found" });
    await expect(api.unlinkOwner({ tenant: BAAN_MALI })).rejects.toMatchObject({ status: 404, code: "shop_not_found" });
  });

  it("keeps a link made in practice across a reload, and starts again on reset", async () => {
    const { storage } = kept();
    await createFakeApi({ now: () => NOW, storage }).linkOwner({ tenant: SABAI_TEA, code: dao });
    const reloaded = createFakeApi({ now: () => NOW, storage });
    expect((await reloaded.getPeople(SABAI_TEA)).owner.account).toMatchObject({ devices: 0 });
    // The code that made it is used up for good, not given back by a reload.
    await expect(reloaded.linkOwner({ tenant: BAAN_MALI, code: dao })).rejects.toMatchObject({ status: 404, code: "unknown_code" });
    reloaded.reset();
    expect((await reloaded.getPeople(SABAI_TEA)).owner.account).toBeNull();
    expect((await reloaded.linkOwner({ tenant: SABAI_TEA, code: dao })).ownerAccount.id).toMatch(/^owner-/);
  });

  it("replaces a practice world saved before the owner link, whether it is a version behind or only lacks the codes", async () => {
    for (const change of [{ version: 8 }, { ownerCodes: undefined }]) {
      const { saved, storage } = kept();
      const first = createFakeApi({ now: () => NOW, storage });
      await first.unlinkOwner({ tenant: BAAN_MALI });
      const world = JSON.parse(saved.get("manut.pilot.fake.v1")!) as Record<string, unknown>;
      saved.set("manut.pilot.fake.v1", JSON.stringify({ ...world, ...change }));
      const api = createFakeApi({ now: () => NOW, storage });
      // The world was read as a fresh one: Fon's account is linked again.
      expect((await api.getPeople(BAAN_MALI)).owner.account?.id).toBe("owner-fon");
    }
  });

  it("refuses both routes without an operator key", async () => {
    const api = createFakeApi({ operatorKey: () => null });
    for (const call of [
      () => api.linkOwner({ tenant: SABAI_TEA, code: dao }),
      () => api.unlinkOwner({ tenant: BAAN_MALI }),
    ]) await expect(call()).rejects.toMatchObject({ status: 403, code: "forbidden" });
  });
});

// Practice mode must show every word the console has, without an API. This week's API added the owner's own changes (from their
// linked account and from the shop's own session), a helper's device signing out, this Mac registering as an outpost, and browser
// writes asked for and submitted, so Baan Mali's sample log holds an entry for each, in the shapes the API writes them
// (docs/pilot-api.md, "Audit log"), and the sample people hold the history those entries are about.
describe("the fake's sample audit log, for what the API added this week", () => {
  const NOW = Date.parse("2026-11-24T03:00:00Z");
  const BAAN_MALI = "shop_baanmali";
  const SABAI_TEA = "shop_sabaitea";
  const everything = async (tenant = BAAN_MALI) => {
    const api = createFakeApi({ now: () => NOW });
    return { api, log: (await api.listAudit(tenant, { limit: 200 })).entries };
  };
  const has = (log: AuditEntry[], action: string, test: (entry: AuditEntry) => boolean = () => true) =>
    log.some((entry) => entry.action === action && test(entry));
  const by = (kind: string, id?: string) => (entry: AuditEntry) =>
    entry.actor.kind === kind && (id === undefined || ("id" in entry.actor && entry.actor.id === id));

  it("keeps every sample entry within the API's own rules for an entry", async () => {
    const actions = new Set(apiList("AUDIT_ACTIONS"));
    const outcomes = new Set(apiList("AUDIT_OUTCOMES"));
    const keys = new Set(apiList("AUDIT_SUBJECT_KEYS"));
    const ID = /^[A-Za-z0-9._:-]{1,256}$/;
    const CODE = /^[a-z][a-z0-9_]{0,63}$/;
    for (const tenant of [BAAN_MALI, SABAI_TEA]) {
      const { log } = await everything(tenant);
      expect(log.length).toBeGreaterThan(0);
      for (const entry of log) {
        const says = `${entry.action} ${entry.id}`;
        expect(actions.has(entry.action), says).toBe(true);
        expect(outcomes.has(entry.outcome), says).toBe(true);
        for (const [key, id] of Object.entries(entry.subject)) {
          expect(keys.has(key), `${says}: ${key}`).toBe(true);
          expect(ID.test(id), `${says}: ${key} ${id}`).toBe(true);
        }
        if (entry.reason !== undefined) expect(CODE.test(entry.reason), `${says}: ${entry.reason}`).toBe(true);
        // Each kind of actor carries exactly the fields the API's `isAuditActor` allows.
        const actor = entry.actor as Record<string, unknown>;
        const fields = Object.keys(actor).sort().join(",");
        switch (actor.kind) {
          case "operator": expect(fields, says).toBe("email,kind"); break;
          case "owner": expect(["kind", "id,kind"], says).toContain(fields); break;
          case "helper": case "outpost": expect(fields, says).toBe("id,kind"); break;
          case "worker": expect(fields, says).toBe("attemptId,kind"); break;
          case "system": expect(fields, says).toBe("kind"); break;
          default: throw new Error(`${says}: an actor kind the API does not have`);
        }
        for (const text of Object.values(actor)) if (typeof text === "string") expect(ID.test(text) || text.includes("@"), says).toBe(true);
      }
    }
  });

  it("says every sample entry in words: none by its raw name, no reason by its code", async () => {
    const { log } = await everything();
    const names = { "helper-mint": "Mint", "helper-ice": "Ice", "inv-beam": "Beam", "inv-mint": "Mint", "inv-tum": "Tum", "inv-ice": "Ice" };
    for (const entry of log) {
      const sentence = auditSentence(entry, "Fon", names);
      expect(sentence, entry.action).not.toContain(entry.action);
      expect(sentence, entry.action).not.toMatch(/\bdid\b/);
      if (entry.reason !== undefined) expect(auditReasonText(entry.reason, entry), `${entry.action} ${entry.reason}`).not.toMatch(/^Reason:/);
    }
  });

  it("holds the owner's own changes, by their linked account and by the shop's own session, beside an operator's", async () => {
    const { log } = await everything();
    for (const action of ["invite.created", "invite.revoked", "helper.removed", "away.set", "away.cleared", "consent.given",
      "consent.withdrawn"]) {
      expect(has(log, action, by("owner")), `${action} by the owner`).toBe(true);
    }
    expect(log.some(by("owner", "owner-fon")), "from the linked account").toBe(true);
    expect(log.some(by("owner", "owner-session")), "from the shop's own session").toBe(true);
    expect(has(log, "invite.created", by("operator"))).toBe(true);
    expect(has(log, "away.set", by("operator"))).toBe(true);
  });

  it("holds a helper's device signing in and out, and the owner's own devices", async () => {
    const { log } = await everything();
    expect(has(log, "helper.session_opened", by("helper", "helper-mint"))).toBe(true);
    expect(has(log, "helper.session_ended", by("helper", "helper-mint"))).toBe(true);
    expect(has(log, "owner.session_opened", by("owner", "owner-fon"))).toBe(true);
    expect(has(log, "owner.session_ended", by("owner", "owner-fon"))).toBe(true);
  });

  it("holds the owner registering their Mac as an outpost, beside an operator's cloud outpost, and a vault sealed again", async () => {
    const { log } = await everything();
    expect(has(log, "outpost.registered", by("owner", "owner-fon"))).toBe(true);
    expect(has(log, "outpost.registered", by("operator"))).toBe(true);
    // The owner's own Connections: a rename from the linked account, and a removal from the shop's own session.
    expect(has(log, "outpost.renamed", by("owner", "owner-fon"))).toBe(true);
    expect(has(log, "outpost.removed", by("owner", "owner-session"))).toBe(true);
    expect(has(log, "signin.created", by("operator"))).toBe(true);
    expect(has(log, "vault.resealed", (entry) => by("operator")(entry) && Object.keys(entry.subject).length === 0)).toBe(true);
  });

  it("tells a sign-in's story, from the grant to the password mended", async () => {
    const { log } = await everything();
    const grant = log.find((entry) => entry.action === "signin.requested")?.subject.grantId;
    expect(grant).toBeTruthy();
    const told = log.filter((entry) => entry.subject.grantId === grant).reverse().map((entry) => `${entry.actor.kind} ${entry.action} ${entry.outcome}${entry.reason ? ` ${entry.reason}` : ""}`);
    expect(told).toEqual([
      "worker signin.requested ok",
      "worker browser_step.queued ok",
      "outpost browser_step.fetched ok",
      "outpost signin.redeemed ok",
      "outpost browser_step.reported failed sign_in_refused",
    ]);
    expect(has(log, "signin.broken", by("worker"))).toBe(true);
    // The owner typed the new password herself, from her own Connections.
    expect(has(log, "signin.password_replaced", by("owner", "owner-fon"))).toBe(true);
  });

  it("tells each browser write's story in order, from the ask to how it settled, each ending its own way", async () => {
    const { log } = await everything();
    const story = (requestId: string) => log
      .filter((entry) => entry.subject.requestId === requestId || entry.subject.actionId === requestId)
      .reverse()
      .map((entry) => `${entry.actor.kind} ${entry.action} ${entry.outcome}${entry.reason ? ` ${entry.reason}` : ""}`);
    const requestOf = (reason: string) => log.find((entry) => entry.action === "browser_step.reported" && entry.reason === reason
      && entry.subject.requestId)?.subject.requestId ?? "";
    const through = (settled: string, report: string) => [
      "worker approval.requested ok",
      "owner approval.decided approved",
      "worker browser_step.queued ok",
      "system dispatch.started ok",
      "outpost browser_step.fetched ok",
      `outpost browser_step.reported failed ${report}`,
      `system dispatch.settled ${settled}`,
    ];
    // The site refused the form: nothing changed, so the write failed.
    expect(story(requestOf("submit_refused"))).toEqual(through("failed", "submit_refused"));
    // A helper approved this one (a reply may be decided by a helper); the outpost did not run the step.
    expect(story(requestOf("not_run"))).toEqual(through("failed", "not_run").map((line) => line.replace("owner approval", "helper approval")));
    // The step took too long, so nobody can say the site did not take it.
    expect(story(requestOf("timed_out"))).toEqual(through("unknown", "timed_out"));
    // The outpost was refused the step: the approved write no longer matched what would be submitted.
    const refused = log.find((entry) => entry.action === "browser_step.fetched" && entry.reason === "payload_changed");
    expect(refused?.subject.requestId).toBeTruthy();
    expect(story(refused!.subject.requestId!)).toEqual([
      "worker approval.requested ok",
      "owner approval.decided approved",
      "worker browser_step.queued ok",
      "system dispatch.started ok",
      "system dispatch.settled failed",
      "outpost browser_step.fetched refused payload_changed",
    ]);
  });

  it("holds the asks that were refused or kept as drafts, which open no request", async () => {
    const { log } = await everything();
    const ask = (outcome: string, reason: string) => log.find((entry) => entry.action === "approval.requested"
      && entry.outcome === outcome && entry.reason === reason);
    for (const [outcome, reason] of [["refused", "not_my_job"], ["skipped", "draft_only"]] as const) {
      const one = ask(outcome, reason);
      expect(one, `${outcome} ${reason}`).toBeTruthy();
      // A write's ask names its sign-in, and opens no request, so it has none.
      expect(one!.subject.signInId).toBeTruthy();
      expect(one!.subject.requestId).toBeUndefined();
    }
  });

  it("keeps the people the sample entries are about: a cancelled invite and a removed helper still have their names", async () => {
    const { api, log } = await everything();
    const people = await api.getPeople(BAAN_MALI);
    expect(people.removed).toEqual([{ id: "helper-ice", name: "Ice" }]);
    expect(people.invites.find((invite) => invite.id === "inv-tum")).toMatchObject({ name: "Tum", status: "revoked" });
    expect(people.invites.find((invite) => invite.id === "inv-ice")).toMatchObject({ name: "Ice", status: "used" });
    // The page still lists the owner, Mint and Beam's open invite, and nobody else.
    expect(people.helpers.map((helper) => helper.id)).toEqual(["helper-mint"]);
    expect(people.invites.filter((invite) => invite.status === "pending").map((invite) => invite.id)).toEqual(["inv-beam"]);
    // Every person a sample entry names is one the people list knows by name.
    const known = new Set([...people.invites.map((one) => one.id), ...people.helpers.map((one) => one.id), ...people.removed.map((one) => one.id)]);
    for (const entry of log) {
      for (const key of ["inviteId", "helperId"] as const) {
        const id = entry.subject[key];
        if (id !== undefined) expect(known.has(id), `${entry.action} ${key} ${id}`).toBe(true);
      }
    }
  });

  it("replaces a practice world saved before these samples, whether it is a version behind or only lacks them", async () => {
    const saved = new Map<string, string>();
    const storage = {
      getItem: (key: string) => saved.get(key) ?? null,
      setItem: (key: string, value: string) => void saved.set(key, value),
      removeItem: (key: string) => void saved.delete(key),
    };
    const first = createFakeApi({ now: () => NOW, storage });
    await first.listShops();
    const world = JSON.parse(saved.get("manut.pilot.fake.v1")!) as Record<string, unknown>;
    expect(world.version).toBe(14);
    saved.set("manut.pilot.fake.v1", JSON.stringify({ ...world, version: 9, audit: [] }));
    const api = createFakeApi({ now: () => NOW, storage });
    const log = (await api.listAudit(BAAN_MALI, { limit: 200 })).entries;
    expect(has(log, "vault.resealed")).toBe(true);
  });

  it("replaces a world saved before the practice shops for the owner's page, so its new demo links work", async () => {
    const saved = new Map<string, string>();
    const storage = {
      getItem: (key: string) => saved.get(key) ?? null,
      setItem: (key: string, value: string) => void saved.set(key, value),
      removeItem: (key: string) => void saved.delete(key),
    };
    await createFakeApi({ now: () => NOW, storage }).listShops();
    const world = JSON.parse(saved.get("manut.pilot.fake.v1")!) as Record<string, unknown>;
    // The last world before them: version 10, which has no demoShops.
    const { demoShops: _gone, ...before } = world;
    saved.set("manut.pilot.fake.v1", JSON.stringify({ ...before, version: 10 }));
    const api = createFakeApi({ now: () => NOW, storage });
    expect(await api.getApproval(DEMO_TOKENS.longThai)).toMatchObject({ state: "proposed" });
    expect(await api.getDeletion(DEMO_DELETION_TOKENS.longName)).toMatchObject({ state: "awaiting_owner" });
  });
});

// An operator counting a shop its owner made in the pilot gate, in practice as on the API (docs/pilot-api.md, "The pilot gate").
describe("the fake's pilot gate cohort", () => {
  it("refuses a shop an operator made, which is always counted", async () => {
    const api = createFakeApi({ now: () => Date.parse("2026-11-24T03:00:00Z") });
    await expect(api.setGateCohort("shop_baanmali", true)).rejects.toMatchObject({ status: 409, code: "not_self_serve" });
    await expect(api.setGateCohort("shop_nobody", true)).rejects.toMatchObject({ status: 404 });
  });
});

// The shop's vault in practice (docs/pilot-api.md, "Vault sign-ins and outposts"): what the operator reads, and the four things the
// operator may do, answered as the API answers them.
describe("the fake's vault, kept as the API keeps it", () => {
  const NOW = Date.parse("2026-11-23T03:00:00Z"); // 10:00 in Bangkok, and a whole number of 30-second beats
  const BAAN_MALI = "shop_baanmali";
  const SABAI_TEA = "shop_sabaitea";
  const SHOPEE = "5d0e7c3a-2b41-4f6e-9a1d-7e8f9a0b1c2d";
  const CARRIER = "8a1b4c6d-3e52-4f70-b8c9-0d1e2f3a4b5c";
  const MAC = "b4c8d1e2-5f60-4a71-8b92-0c3d4e5f6a7b";
  const CLOUD = "c0a1d2e3-7a81-4b92-9c03-1d2e3f4a5b6c";
  const OLD_MAC = "d3e4f5a6-8b92-4c03-8d14-2e3f4a5b6c7d";
  const CREDENTIAL = /^mo1_[A-Za-z0-9_-]{43}$/;
  const operator = { kind: "operator", email: null };
  const fresh = (now = () => NOW) => createFakeApi({ now, webOrigin: "https://web.test" });
  const minutesAgo = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();

  /// A browser's storage for the saved world, with the saved text where a test can reach it.
  function kept() {
    const saved = new Map<string, string>();
    const storage = {
      getItem: (key: string) => saved.get(key) ?? null,
      setItem: (key: string, value: string) => void saved.set(key, value),
      removeItem: (key: string) => void saved.delete(key),
    };
    return { saved, storage };
  }

  /// The newest entry of a shop's log, as what it says: no id and no time.
  async function newest(api: ReturnType<typeof createFakeApi>, tenant: string) {
    const { id: _id, at: _at, ...said } = (await api.listAudit(tenant, { limit: 1 })).entries[0]!;
    return said;
  }
  const logLength = async (api: ReturnType<typeof createFakeApi>, tenant: string) =>
    (await api.listAudit(tenant, { limit: 200 })).entries.length;

  it("starts Baan Mali with the two sign-ins its log tells the story of, oldest first, and Sabai Tea with none", async () => {
    const api = fresh();
    expect(await api.listSignIns(BAAN_MALI)).toEqual([
      {
        id: SHOPEE, site: "Shopee Seller Centre", origins: ["https://seller.shopee.co.th"], username: "baanmali",
        members: ["nam", "pim"], state: "working", passwordSet: true, passwordSetAt: minutesAgo(1050), brokenAt: null,
        brokenBy: null, lastUsedAt: minutesAgo(1098.8), lastUsedBy: "nam", createdAt: minutesAgo(9 * 1440 - 10),
      },
      {
        id: CARRIER, site: "Carrier portal", origins: ["https://portal.carrier.example"], username: "baanmali",
        members: ["nam"], state: "broken", passwordSet: true, passwordSetAt: minutesAgo(3 * 1440), brokenAt: minutesAgo(2 * 1440 - 2),
        brokenBy: "nam", lastUsedAt: minutesAgo(2 * 1440 - 1.2), lastUsedBy: "nam", createdAt: minutesAgo(3 * 1440),
      },
    ]);
    expect(await api.listSignIns(SABAI_TEA)).toEqual([]);
    // As the API's vault, which answers for any tenant that is one: a shop it was never given anything for has an empty list.
    expect(await api.listSignIns("shop_nobody")).toEqual([]);
  });

  it("starts Baan Mali with a cloud outpost that never beat and Fon's Mac, which beats, and Sabai Tea with none", async () => {
    const api = fresh();
    expect(await api.listOutposts(BAAN_MALI)).toEqual([
      { id: CLOUD, name: "Cloud outpost", kind: "cloud", status: "asleep", lastHeartbeatAt: null, createdAt: minutesAgo(9 * 1440 - 20) },
      { id: MAC, name: "Fon's MacBook", kind: "this_mac", status: "online", lastHeartbeatAt: new Date(NOW).toISOString(),
        createdAt: minutesAgo(2 * 1440 - 40) },
    ]);
    expect(await api.listOutposts(SABAI_TEA)).toEqual([]);
    expect(await api.listOutposts("shop_nobody")).toEqual([]);
  });

  it("reads a beating Mac at its latest beat, never more than 30 seconds old, so it stays online while the page is open", async () => {
    let now = NOW;
    const api = fresh(() => now);
    now = NOW + 17_000;
    expect((await api.listOutposts(BAAN_MALI)).find((outpost) => outpost.id === MAC)).toMatchObject({
      status: "online", lastHeartbeatAt: new Date(NOW).toISOString() });
    // An hour later it is still beating: the sample world was made an hour ago, and its Mac does not read as gone.
    now = NOW + 3_600_000 + 29_000;
    expect((await api.listOutposts(BAAN_MALI)).find((outpost) => outpost.id === MAC)).toMatchObject({
      status: "online", lastHeartbeatAt: new Date(NOW + 3_600_000).toISOString() });
    // The cloud outpost never beat, so it is asleep however late it is.
    expect((await api.listOutposts(BAAN_MALI)).find((outpost) => outpost.id === CLOUD)).toMatchObject({
      status: "asleep", lastHeartbeatAt: null });
  });

  it("keeps the sample vault and the sample log telling one story, to the minute", async () => {
    const api = fresh();
    const log = (await api.listAudit(BAAN_MALI, { limit: 200 })).entries;
    const when = (action: string, signInId: string) => log.find((entry) => entry.action === action && entry.subject.signInId === signInId)?.at;
    const [shopee, carrier] = await api.listSignIns(BAAN_MALI);
    // Shopee broke, and Fon typed a new password: it works, and its password is as old as her change. It was last used by the redeem.
    expect(when("signin.created", SHOPEE)).toBe(shopee!.createdAt);
    expect(when("signin.password_replaced", SHOPEE)).toBe(shopee!.passwordSetAt);
    expect(when("signin.redeemed", SHOPEE)).toBe(shopee!.lastUsedAt);
    expect(shopee).toMatchObject({ state: "working", brokenAt: null, brokenBy: null });
    // The carrier's portal broke when the worker said so, and nobody has typed a new password since.
    expect(when("signin.created", CARRIER)).toBe(carrier!.createdAt);
    expect(when("signin.broken", CARRIER)).toBe(carrier!.brokenAt);
    expect(log.find((entry) => entry.action === "signin.redeemed" && entry.subject.signInId === CARRIER)?.at).toBe(carrier!.lastUsedAt);
    expect(log.some((entry) => entry.action === "signin.password_replaced" && entry.subject.signInId === CARRIER)).toBe(false);
    expect(carrier).toMatchObject({ state: "broken", brokenBy: "nam" });
    // Every sign-in and outpost the log names is in the vault, or is the one older Mac that was removed.
    const signIns = new Set((await api.listSignIns(BAAN_MALI)).map((one) => one.id));
    const outposts = new Set((await api.listOutposts(BAAN_MALI)).map((one) => one.id));
    for (const entry of log) {
      if (entry.subject.signInId !== undefined) expect(signIns.has(entry.subject.signInId), `${entry.action} ${entry.subject.signInId}`).toBe(true);
      const outpostId = entry.subject.outpostId;
      if (outpostId !== undefined) expect(outposts.has(outpostId) || outpostId === OLD_MAC, `${entry.action} ${outpostId}`).toBe(true);
    }
  });

  it("changes who may use a sign-in, in the order sent, changing nothing else about it, and records only its id", async () => {
    const api = fresh();
    const before = await logLength(api, BAAN_MALI);
    const [, carrier] = await api.listSignIns(BAAN_MALI);
    const answer = await api.setSignInMembers({ tenant: BAAN_MALI, signInId: CARRIER, members: ["ton", "nam", "kit"] });
    // Still broken, with when it broke and was last used: who may use it is all that changed.
    expect(answer).toEqual({ ...carrier, members: ["ton", "nam", "kit"] });
    expect((await api.listSignIns(BAAN_MALI))[1]).toEqual(answer);
    expect(await logLength(api, BAAN_MALI)).toBe(before + 1);
    expect(await newest(api, BAAN_MALI)).toEqual({ actor: operator, action: "signin.members_changed", subject: { signInId: CARRIER },
      outcome: "ok" });
    // The other sign-in is not touched.
    expect((await api.listSignIns(BAAN_MALI))[0]!.members).toEqual(["nam", "pim"]);
  });

  it("refuses the members the vault refuses before it looks for the sign-in, and a sign-in that is not there after", async () => {
    const api = fresh();
    const before = await logLength(api, BAAN_MALI);
    const bad: unknown[] = [[], ["nam", "nam"], ["buddy"], ["Nam"], ["nam", "pim", "ton", "kit", "nam"], "nam", null, [7], [["nam"]]];
    for (const members of bad) {
      for (const signInId of [SHOPEE, "no-such-sign-in"]) {
        await expect(api.setSignInMembers({ tenant: BAAN_MALI, signInId, members: members as never }), JSON.stringify(members))
          .rejects.toMatchObject({ status: 400, code: "invalid_members" });
      }
    }
    await expect(api.setSignInMembers({ tenant: BAAN_MALI, signInId: "no-such-sign-in", members: ["nam"] })).rejects
      .toMatchObject({ status: 404, code: "sign_in_not_found" });
    // Another shop's sign-in is not this shop's.
    await expect(api.setSignInMembers({ tenant: SABAI_TEA, signInId: SHOPEE, members: ["nam"] })).rejects
      .toMatchObject({ status: 404, code: "sign_in_not_found" });
    expect(await logLength(api, BAAN_MALI)).toBe(before);
    expect((await api.listSignIns(BAAN_MALI)).map((one) => one.members)).toEqual([["nam", "pim"], ["nam"]]);
  });

  it("removes a sign-in, so it is not listed again, and says 404 when it is removed twice", async () => {
    const api = fresh();
    expect(await api.removeSignIn({ tenant: BAAN_MALI, signInId: CARRIER })).toEqual({ removed: true, signInId: CARRIER });
    expect((await api.listSignIns(BAAN_MALI)).map((one) => one.id)).toEqual([SHOPEE]);
    expect(await newest(api, BAAN_MALI)).toEqual({ actor: operator, action: "signin.removed", subject: { signInId: CARRIER }, outcome: "ok" });
    const after = await logLength(api, BAAN_MALI);
    await expect(api.removeSignIn({ tenant: BAAN_MALI, signInId: CARRIER })).rejects.toMatchObject({ status: 404, code: "sign_in_not_found" });
    await expect(api.setSignInMembers({ tenant: BAAN_MALI, signInId: CARRIER, members: ["nam"] })).rejects
      .toMatchObject({ status: 404, code: "sign_in_not_found" });
    await expect(api.removeSignIn({ tenant: SABAI_TEA, signInId: SHOPEE })).rejects.toMatchObject({ status: 404, code: "sign_in_not_found" });
    expect(await logLength(api, BAAN_MALI)).toBe(after);
  });

  it("removes an outpost, so it is not listed again; the practice world queues no work, so it refuses none", async () => {
    const api = fresh();
    expect(await api.removeOutpost({ tenant: BAAN_MALI, outpostId: CLOUD })).toEqual({ removed: true, outpostId: CLOUD, stepsRefused: 0,
      grantsRefused: 0 });
    expect((await api.listOutposts(BAAN_MALI)).map((one) => one.id)).toEqual([MAC]);
    expect(await newest(api, BAAN_MALI)).toEqual({ actor: operator, action: "outpost.removed", subject: { outpostId: CLOUD }, outcome: "ok" });
    const after = await logLength(api, BAAN_MALI);
    await expect(api.removeOutpost({ tenant: BAAN_MALI, outpostId: CLOUD })).rejects.toMatchObject({ status: 404, code: "outpost_not_found" });
    // An outpost that was removed earlier, in the sample's own story, and another shop's, are not there either.
    await expect(api.removeOutpost({ tenant: BAAN_MALI, outpostId: OLD_MAC })).rejects.toMatchObject({ status: 404, code: "outpost_not_found" });
    await expect(api.removeOutpost({ tenant: SABAI_TEA, outpostId: MAC })).rejects.toMatchObject({ status: 404, code: "outpost_not_found" });
    expect(await logLength(api, BAAN_MALI)).toBe(after);
  });

  it("gives an outpost a new credential the API would accept, and puts it to sleep until its holder beats", async () => {
    const api = fresh();
    const answer = await api.replaceOutpostCredential({ tenant: BAAN_MALI, outpostId: MAC });
    expect(answer.credential).toMatch(CREDENTIAL);
    expect(answer.outpost).toEqual({ id: MAC, name: "Fon's MacBook", kind: "this_mac", status: "asleep", lastHeartbeatAt: null,
      createdAt: minutesAgo(2 * 1440 - 40) });
    // The Mac no longer beats: nobody in practice holds the new credential, so it stays asleep, now and later.
    expect((await api.listOutposts(BAAN_MALI)).find((outpost) => outpost.id === MAC)).toEqual(answer.outpost);
    expect(await newest(api, BAAN_MALI)).toEqual({ actor: operator, action: "outpost.credential_rotated", subject: { outpostId: MAC },
      outcome: "ok" });
    // Each is a new one, and the same outpost can be given another, which is also asleep.
    const again = await api.replaceOutpostCredential({ tenant: BAAN_MALI, outpostId: MAC });
    expect(again.credential).toMatch(CREDENTIAL);
    expect(again.credential).not.toBe(answer.credential);
    await expect(api.replaceOutpostCredential({ tenant: BAAN_MALI, outpostId: "no-such-outpost" })).rejects
      .toMatchObject({ status: 404, code: "outpost_not_found" });
    await expect(api.replaceOutpostCredential({ tenant: SABAI_TEA, outpostId: MAC })).rejects
      .toMatchObject({ status: 404, code: "outpost_not_found" });
  });

  it("makes a credential of the shape the API checks one for, read from the API's own source", () => {
    // If the API changes what an outpost's credential looks like, the practice world's must follow, and this says so.
    expect(browserControlSource).toContain("const OUTPOST_CREDENTIAL = /^mo1_[A-Za-z0-9_-]{43}$/;");
  });

  it("never keeps a credential: not in the saved world, the export, the log, a later answer or what a reload reads", async () => {
    const { saved, storage } = kept();
    const api = createFakeApi({ now: () => NOW, storage });
    const { credential } = await api.replaceOutpostCredential({ tenant: BAAN_MALI, outpostId: MAC });
    expect(credential).toMatch(CREDENTIAL);
    const everywhere = [
      [...saved.values()].join("\n"),
      JSON.stringify(await api.exportShop(BAAN_MALI)),
      JSON.stringify(await api.listAudit(BAAN_MALI, { limit: 200 })),
      JSON.stringify(await api.listOutposts(BAAN_MALI)),
      JSON.stringify(await api.listSignIns(BAAN_MALI)),
      JSON.stringify(await createFakeApi({ now: () => NOW, storage }).listOutposts(BAAN_MALI)),
    ];
    // Anything of the credential at all: the whole, and the part after its prefix, which is what a sloppy copy would keep.
    for (const text of everywhere) {
      expect(text).not.toContain(credential);
      expect(text).not.toContain(credential.slice(4));
      expect(text).not.toContain("mo1_");
    }
  });

  it("carries the vault in the shop's export, with no password, credential or digest, and deletes it with the shop", async () => {
    const api = fresh();
    const exported = await api.exportShop(BAAN_MALI);
    expect(exported.signIns).toEqual(await api.listSignIns(BAAN_MALI));
    expect(exported.outposts).toEqual(await api.listOutposts(BAAN_MALI));
    expect((await api.exportShop(SABAI_TEA)).signIns).toEqual([]);
    expect((await api.exportShop(SABAI_TEA)).outposts).toEqual([]);
    expect(JSON.stringify([exported.signIns, exported.outposts])).not.toMatch(/password"|credential|sealed|hash|digest|secret/i);
    // Every key a sign-in has says nothing of the password but that it is set, and when.
    for (const signIn of exported.signIns as object[]) {
      expect(Object.keys(signIn).sort()).toEqual(["brokenAt", "brokenBy", "createdAt", "id", "lastUsedAt", "lastUsedBy", "members", "origins",
        "passwordSet", "passwordSetAt", "site", "state", "username"]);
    }
    const link = asked(await api.deleteShop({ tenant: BAAN_MALI, confirmName: "Baan Mali" }));
    await api.decideDeletion(deletionTokenOf(link.confirmUrl), true);
    expect(await api.listSignIns(BAAN_MALI)).toEqual([]);
    expect(await api.listOutposts(BAAN_MALI)).toEqual([]);
  });

  it("keeps a change across a reload, starts again on reset, and replaces a world saved before shops had a vault", async () => {
    const { saved, storage } = kept();
    const first = createFakeApi({ now: () => NOW, storage });
    await first.removeSignIn({ tenant: BAAN_MALI, signInId: CARRIER });
    await first.removeOutpost({ tenant: BAAN_MALI, outpostId: CLOUD });
    const reloaded = createFakeApi({ now: () => NOW, storage });
    expect((await reloaded.listSignIns(BAAN_MALI)).map((one) => one.id)).toEqual([SHOPEE]);
    expect((await reloaded.listOutposts(BAAN_MALI)).map((one) => one.id)).toEqual([MAC]);
    reloaded.reset();
    expect((await reloaded.listSignIns(BAAN_MALI)).map((one) => one.id)).toEqual([SHOPEE, CARRIER]);
    // Version 11 is a world saved with no vault; one that says it is version 14 but lacks the vault is read as the half it holds.
    for (const change of [{ version: 11, vault: undefined }, { vault: undefined }]) {
      const world = JSON.parse(saved.get("manut.pilot.fake.v1")!) as Record<string, unknown>;
      saved.set("manut.pilot.fake.v1", JSON.stringify({ ...world, ...change }));
      const api = createFakeApi({ now: () => NOW, storage });
      expect((await api.listSignIns(BAAN_MALI)).map((one) => one.id)).toEqual([SHOPEE, CARRIER]);
      expect((await api.listShops()).map((shop) => shop.name)).toEqual(["Baan Mali", "Sabai Tea"]);
    }
  });

  it("refuses every vault route without an operator key, and without a tenant, as the API's admin gate and routes do", async () => {
    const locked = createFakeApi({ operatorKey: () => null });
    const calls: [string, (api: ReturnType<typeof createFakeApi>) => Promise<unknown>][] = [
      ["listSignIns", (api) => api.listSignIns(BAAN_MALI)],
      ["setSignInMembers", (api) => api.setSignInMembers({ tenant: BAAN_MALI, signInId: SHOPEE, members: ["nam"] })],
      ["removeSignIn", (api) => api.removeSignIn({ tenant: BAAN_MALI, signInId: SHOPEE })],
      ["listOutposts", (api) => api.listOutposts(BAAN_MALI)],
      ["removeOutpost", (api) => api.removeOutpost({ tenant: BAAN_MALI, outpostId: MAC })],
      ["replaceOutpostCredential", (api) => api.replaceOutpostCredential({ tenant: BAAN_MALI, outpostId: MAC })],
    ];
    for (const [name, call] of calls) await expect(call(locked), name).rejects.toMatchObject({ status: 403, code: "forbidden" });
    const api = fresh();
    const nobody = [
      () => api.listSignIns(""), () => api.listOutposts(""), () => api.listSignIns("x".repeat(257)),
      () => api.setSignInMembers({ tenant: "", signInId: SHOPEE, members: ["nam"] }),
      () => api.removeSignIn({ tenant: "", signInId: SHOPEE }),
      () => api.removeOutpost({ tenant: "", outpostId: MAC }),
      () => api.replaceOutpostCredential({ tenant: "", outpostId: MAC }),
      () => api.removeSignIn({ tenant: 7 as never, signInId: SHOPEE }),
    ];
    for (const call of nobody) await expect(call()).rejects.toMatchObject({ status: 400, code: "tenant_required" });
  });
});

describe("the fake's routines, kept as the API keeps them", () => {
  const NOW = Date.parse("2026-11-23T03:00:00Z"); // 10:00 on Monday 23 November in Bangkok
  const BAAN_MALI = "shop_baanmali";
  const SABAI_TEA = "shop_sabaitea";
  const MORNING = "rt-sample-morning-brief";
  const GROWTH = "rt-sample-growth-brief";
  const REPLIES = "rt-sample-answer-messages";
  const POST = "rt-sample-friday-post";
  const BOOKS = "rt-sample-month-books";
  const STOCK = "rt-sample-low-stock";
  const operator = { kind: "operator", email: null };
  type Api = ReturnType<typeof createFakeApi>;
  const fresh = (now = () => NOW) => createFakeApi({ now, webOrigin: "https://web.test" });

  /// A browser's storage for the saved world, with the saved text where a test can reach it.
  function kept() {
    const saved = new Map<string, string>();
    const storage = {
      getItem: (key: string) => saved.get(key) ?? null,
      setItem: (key: string, value: string) => void saved.set(key, value),
      removeItem: (key: string) => void saved.delete(key),
    };
    return { saved, storage };
  }

  async function newest(api: Api, tenant: string) {
    const { id: _id, at: _at, ...said } = (await api.listAudit(tenant, { limit: 1 })).entries[0]!;
    return said;
  }
  const logLength = async (api: Api, tenant: string) => (await api.listAudit(tenant, { limit: 200 })).entries.length;
  const routineOf = async (api: Api, id: string, tenant = BAAN_MALI) => (await api.getRoutines(tenant)).routines.find((one) => one.id === id)!;

  it("starts Baan Mali with six routines in the order they were made, and Sabai Tea with none and its team on", async () => {
    const api = fresh();
    const view = await api.getRoutines(BAAN_MALI);
    expect(view.tenant).toBe(BAAN_MALI);
    expect(view.team).toEqual({ paused: false, since: null, members: ["nam", "pim", "ton"] });
    expect(view.routines.map((routine) => [routine.id, routine.name, routine.member, routine.asksFirst, routine.paused])).toEqual([
      [MORNING, "Morning brief", "ton", false, false],
      [GROWTH, "Weekly growth brief", "ton", false, false],
      [REPLIES, "Answer new customer messages", "nam", true, false],
      [POST, "Draft the Friday post", "pim", true, true],
      [BOOKS, "Month-end books", "ton", true, false],
      [STOCK, "Tell me when candles run low", "ton", false, false],
    ]);
    expect(await api.getRoutines(SABAI_TEA)).toEqual({ tenant: SABAI_TEA,
      team: { paused: false, since: null, members: ["nam", "pim", "ton"] }, routines: [] });
  });

  it("answers a read for any tenant that is one, as the API's read does, and a change only for a pilot shop", async () => {
    const api = fresh();
    // The API's list does not look for the shop: its object answers the empty state for a tenant it has nothing for.
    expect(await api.getRoutines("shop_nobody")).toEqual({ tenant: "shop_nobody",
      team: { paused: false, since: null, members: ["nam", "pim", "ton"] }, routines: [] });
    const before = await logLength(api, BAAN_MALI);
    for (const call of [
      () => api.pauseRoutine({ tenant: "shop_nobody", routineId: MORNING }),
      () => api.resumeRoutine({ tenant: "shop_nobody", routineId: MORNING }),
      () => api.removeRoutine({ tenant: "shop_nobody", routineId: MORNING }),
      () => api.pauseTeam({ tenant: "shop_nobody" }),
      () => api.resumeTeam({ tenant: "shop_nobody" }),
      // The shop is looked for before the id's form, so a bad id for a shop that is not one is the shop's refusal.
      () => api.pauseRoutine({ tenant: "shop_nobody", routineId: "nope" }),
    ]) await expect(call()).rejects.toMatchObject({ status: 404, code: "shop_not_found" });
    expect(await logLength(api, BAAN_MALI)).toBe(before);
    expect((await api.getRoutines("shop_nobody")).team.paused).toBe(false);
  });

  it("says each routine's trigger and next run as @manut/routine-rules does, from the clock, in Bangkok's zone", async () => {
    const api = fresh();
    const [morning, growth, replies, post, books, stock] = (await api.getRoutines(BAAN_MALI)).routines;
    expect([morning, growth, replies, post, books, stock].map((routine) => [routine!.when, routine!.next])).toEqual([
      ["Every day at 08:00", "2026-11-24T01:00:00.000Z"],
      ["Every Monday at 08:00", "2026-11-30T01:00:00.000Z"],
      ["Every day at 12:00", "2026-11-23T05:00:00.000Z"],
      // Paused, so it has no next run, whatever its trigger.
      ["Every Friday at 10:00", null],
      ["On the last day of the month at 18:00", "2026-11-30T11:00:00.000Z"],
      // A stock routine has no clock: it waits for a stock feed, which does not exist yet.
      ["When stock drops under 5", null],
    ]);
    expect(stock!.waitsFor).toBe("stock_feed");
    expect(morning).not.toHaveProperty("waitsFor");
    // The words and the times are the package's, not the fake's own.
    for (const routine of (await api.getRoutines(BAAN_MALI)).routines) {
      const rules = { id: routine.id, name: routine.name, action: routine.action, timeZone: routine.timeZone, trigger: routine.trigger,
        asksFirst: routine.asksFirst };
      expect(routine.when).toBe(describeTrigger(rules));
      if (!routine.paused && routine.trigger.kind !== "stockBelow") expect(routine.next).toBe(new Date(nextRun(rules, NOW)!).toISOString());
      expect(checkRoutine(rules), routine.name).toBeNull();
    }
    // The clock moves the next run on: at 09:00 on Tuesday the morning brief is due the next morning, not that one.
    const later = fresh(() => Date.parse("2026-11-24T02:00:00Z"));
    expect((await later.getRoutines(BAAN_MALI)).routines[0]!.next).toBe("2026-11-25T01:00:00.000Z");
  });

  it("keeps each routine's newest run, placed at the latest start of its clock, with the reason the API would give", async () => {
    const api = fresh();
    const runs = Object.fromEntries((await api.getRoutines(BAAN_MALI)).routines.map((routine) => [routine.id, routine.lastRun]));
    expect(runs[MORNING]).toEqual({ routineId: MORNING, instant: "2026-11-23T01:00:00.000Z", status: "done", member: "ton",
      taskId: "worker-task-6a7c1f00-0000-4000-8000-000000000001", at: "2026-11-23T01:02:00.000Z" });
    expect(runs[GROWTH]).toMatchObject({ instant: "2026-11-23T01:00:00.000Z", status: "failed", reason: "payments_unavailable",
      taskId: "worker-task-6a7c1f00-0000-4000-8000-000000000004", member: "ton" });
    expect(runs[REPLIES]).toMatchObject({ instant: "2026-11-22T05:00:00.000Z", status: "skipped", reason: "nothing_to_answer", member: "nam" });
    expect(runs[POST]).toMatchObject({ instant: "2026-11-20T03:00:00.000Z", status: "skipped", reason: "routine_paused", member: "pim" });
    // A run that came too late has no reason: it was not held, it was late.
    expect(runs[BOOKS]).toEqual({ routineId: BOOKS, instant: "2026-10-31T11:00:00.000Z", status: "missed", member: "ton",
      at: "2026-10-31T11:02:00.000Z" });
    expect(runs[STOCK]).toBeNull();
    // Only a run that started a job names its task.
    expect(runs[REPLIES]).not.toHaveProperty("taskId");
    // The runs are placed the same whatever hour the world is made at: the latest start is always at or before now.
    const early = fresh(() => Date.parse("2026-11-23T00:30:00Z")); // 07:30, before the morning brief's start
    expect((await early.getRoutines(BAAN_MALI)).routines[0]!.lastRun!.instant).toBe("2026-11-22T01:00:00.000Z");
  });

  it("reads a routine's newest run by the instant it was meant for, whatever order the runs are kept in", async () => {
    const { saved, storage } = kept();
    await createFakeApi({ now: () => NOW, storage }).listShops();
    const world = JSON.parse(saved.get("manut.pilot.fake.v1")!) as { routines: Record<string, { runs: unknown[] }> };
    const run = (instant: string, status: string) => ({ routineId: MORNING, instant, status, member: "ton", at: instant });
    // The sample's own run for the routine is at 23 November; one is kept after it that is newer and one that is older still.
    world.routines[BAAN_MALI]!.runs.push(run("2026-11-24T01:00:00.000Z", "failed"), run("2026-11-21T01:00:00.000Z", "missed"));
    saved.set("manut.pilot.fake.v1", JSON.stringify(world));
    const api = createFakeApi({ now: () => NOW, storage });
    expect((await routineOf(api, MORNING)).lastRun).toMatchObject({ instant: "2026-11-24T01:00:00.000Z", status: "failed" });
    // Another routine's runs are not its own.
    expect((await routineOf(api, GROWTH)).lastRun).toMatchObject({ routineId: GROWTH, status: "failed", instant: "2026-11-23T01:00:00.000Z" });
  });

  it("pauses a routine: it has no next run, its other routines are untouched, and only its id is logged, once", async () => {
    const api = fresh();
    const before = await logLength(api, BAAN_MALI);
    const answer = await api.pauseRoutine({ tenant: BAAN_MALI, routineId: MORNING });
    expect(answer).toMatchObject({ id: MORNING, paused: true, next: null, when: "Every day at 08:00" });
    expect(await routineOf(api, MORNING)).toEqual(answer);
    expect(await logLength(api, BAAN_MALI)).toBe(before + 1);
    expect(await newest(api, BAAN_MALI)).toEqual({ actor: operator, action: "routine.paused", subject: { routineId: MORNING }, outcome: "ok" });
    expect((await routineOf(api, GROWTH)).paused).toBe(false);
    // Pausing a paused routine changes nothing and logs nothing; so does pausing the sample's own paused one.
    expect(await api.pauseRoutine({ tenant: BAAN_MALI, routineId: MORNING })).toEqual(answer);
    await api.pauseRoutine({ tenant: BAAN_MALI, routineId: POST });
    expect(await logLength(api, BAAN_MALI)).toBe(before + 1);
  });

  it("resumes a routine: its next run is worked out from now, and resuming one that is on changes nothing and logs nothing", async () => {
    const api = fresh();
    const before = await logLength(api, BAAN_MALI);
    const answer = await api.resumeRoutine({ tenant: BAAN_MALI, routineId: POST });
    expect(answer).toMatchObject({ id: POST, paused: false, next: "2026-11-27T03:00:00.000Z", when: "Every Friday at 10:00" });
    // Its newest run is still the one it skipped while it was paused: nothing is made up.
    expect(answer.lastRun).toMatchObject({ status: "skipped", reason: "routine_paused" });
    expect(await newest(api, BAAN_MALI)).toEqual({ actor: operator, action: "routine.resumed", subject: { routineId: POST }, outcome: "ok" });
    expect(await logLength(api, BAAN_MALI)).toBe(before + 1);
    expect(await api.resumeRoutine({ tenant: BAAN_MALI, routineId: POST })).toEqual(answer);
    await api.resumeRoutine({ tenant: BAAN_MALI, routineId: MORNING });
    expect(await logLength(api, BAAN_MALI)).toBe(before + 1);
  });

  it("removes a routine with its runs, logs only its id, and says not_found when it is removed twice or belongs to another shop", async () => {
    const api = fresh();
    expect(await api.removeRoutine({ tenant: BAAN_MALI, routineId: GROWTH })).toEqual({ removed: GROWTH });
    expect((await api.getRoutines(BAAN_MALI)).routines.map((routine) => routine.id)).toEqual([MORNING, REPLIES, POST, BOOKS, STOCK]);
    expect(await newest(api, BAAN_MALI)).toEqual({ actor: operator, action: "routine.removed", subject: { routineId: GROWTH }, outcome: "ok" });
    const after = await logLength(api, BAAN_MALI);
    for (const call of [
      () => api.removeRoutine({ tenant: BAAN_MALI, routineId: GROWTH }),
      () => api.pauseRoutine({ tenant: BAAN_MALI, routineId: GROWTH }),
      () => api.resumeRoutine({ tenant: BAAN_MALI, routineId: GROWTH }),
      // Another shop's routine is not this shop's, even for a shop that has none at all.
      () => api.removeRoutine({ tenant: SABAI_TEA, routineId: MORNING }),
      () => api.pauseRoutine({ tenant: SABAI_TEA, routineId: MORNING }),
    ]) await expect(call()).rejects.toMatchObject({ status: 404, code: "not_found" });
    expect(await logLength(api, BAAN_MALI)).toBe(after);
    // Its runs went with it: the export holds none of them.
    const exported = (await api.exportShop(BAAN_MALI)) as unknown as { routines: { runs: { routineId: string }[] } };
    expect(exported.routines.runs.map((run) => run.routineId).sort()).toEqual([BOOKS, MORNING, POST, REPLIES].sort());
  });

  it("pauses everyone since now and keeps when it began, and resuming puts the team back; each change is logged once, with no id", async () => {
    let now = NOW;
    const api = fresh(() => now);
    const before = await logLength(api, BAAN_MALI);
    expect(await api.pauseTeam({ tenant: BAAN_MALI })).toEqual({ paused: true, since: "2026-11-23T03:00:00.000Z",
      members: ["nam", "pim", "ton"] });
    expect(await newest(api, BAAN_MALI)).toEqual({ actor: operator, action: "team.paused", subject: {}, outcome: "ok" });
    // While everyone is paused no routine has a next run, and the team's own routine settings are as they were.
    const paused = (await api.getRoutines(BAAN_MALI)).routines;
    expect(paused.map((routine) => routine.next)).toEqual([null, null, null, null, null, null]);
    expect(paused.map((routine) => routine.paused)).toEqual([false, false, false, true, false, false]);
    // Pausing a paused team changes nothing, logs nothing, and keeps when it began.
    now += 3_600_000;
    expect(await api.pauseTeam({ tenant: BAAN_MALI })).toMatchObject({ paused: true, since: "2026-11-23T03:00:00.000Z" });
    expect(await logLength(api, BAAN_MALI)).toBe(before + 1);

    expect(await api.resumeTeam({ tenant: BAAN_MALI })).toEqual({ paused: false, since: null, members: ["nam", "pim", "ton"] });
    expect(await newest(api, BAAN_MALI)).toEqual({ actor: operator, action: "team.resumed", subject: {}, outcome: "ok" });
    expect((await routineOf(api, MORNING)).next).toBe("2026-11-24T01:00:00.000Z");
    await api.resumeTeam({ tenant: BAAN_MALI });
    expect(await logLength(api, BAAN_MALI)).toBe(before + 2);
  });

  it("makes a team on the first change for a shop that has no routines, and a member who is off leaves that member's routines with no next run", async () => {
    const api = fresh();
    expect(await api.pauseTeam({ tenant: SABAI_TEA })).toMatchObject({ paused: true });
    expect((await api.getRoutines(SABAI_TEA)).team.paused).toBe(true);
    expect(await newest(api, SABAI_TEA)).toEqual({ actor: operator, action: "team.paused", subject: {}, outcome: "ok" });

    // A shop whose template turned on fewer members: only Nam is on here, so Ton's and Pim's routines wait, and Nam's runs.
    const { saved, storage } = kept();
    await createFakeApi({ now: () => NOW, storage }).listShops();
    const world = JSON.parse(saved.get("manut.pilot.fake.v1")!) as { routines: Record<string, { team: { members: string[] | null } }> };
    world.routines[BAAN_MALI]!.team.members = ["nam"];
    saved.set("manut.pilot.fake.v1", JSON.stringify(world));
    const fewer = await createFakeApi({ now: () => NOW, storage }).getRoutines(BAAN_MALI);
    expect(fewer.team.members).toEqual(["nam"]);
    expect(fewer.routines.map((routine) => [routine.member, routine.next !== null])).toEqual([
      ["ton", false], ["ton", false], ["nam", true], ["pim", false], ["ton", false], ["ton", false]]);
  });

  it("refuses every routine route without an operator key, and without a tenant, and an id that is not a routine's, as the API does", async () => {
    const locked = createFakeApi({ operatorKey: () => null });
    const calls: [string, (api: Api) => Promise<unknown>][] = [
      ["getRoutines", (api) => api.getRoutines(BAAN_MALI)],
      ["pauseRoutine", (api) => api.pauseRoutine({ tenant: BAAN_MALI, routineId: MORNING })],
      ["resumeRoutine", (api) => api.resumeRoutine({ tenant: BAAN_MALI, routineId: MORNING })],
      ["removeRoutine", (api) => api.removeRoutine({ tenant: BAAN_MALI, routineId: MORNING })],
      ["pauseTeam", (api) => api.pauseTeam({ tenant: BAAN_MALI })],
      ["resumeTeam", (api) => api.resumeTeam({ tenant: BAAN_MALI })],
    ];
    for (const [name, call] of calls) await expect(call(locked), name).rejects.toMatchObject({ status: 403, code: "forbidden" });
    const api = fresh();
    for (const call of [
      () => api.getRoutines(""), () => api.getRoutines("x".repeat(257)),
      () => api.pauseRoutine({ tenant: "", routineId: MORNING }), () => api.resumeRoutine({ tenant: "", routineId: MORNING }),
      () => api.removeRoutine({ tenant: "", routineId: MORNING }), () => api.pauseTeam({ tenant: "" }),
      () => api.resumeTeam({ tenant: 7 as never }),
    ]) await expect(call()).rejects.toMatchObject({ status: 400, code: "tenant_required" });
    const before = await logLength(api, BAAN_MALI);
    for (const routineId of ["", "nope", "rt-", "RT-upper", "rt-has space", "rt-colon:1", `rt-${"a".repeat(65)}`, 7, null, ["rt-1"]]) {
      const input = { tenant: BAAN_MALI, routineId: routineId as never };
      for (const call of [() => api.pauseRoutine(input), () => api.resumeRoutine(input), () => api.removeRoutine(input)]) {
        await expect(call(), String(routineId)).rejects.toMatchObject({ status: 400, code: "invalid_request" });
      }
    }
    expect(await logLength(api, BAAN_MALI)).toBe(before);
    expect((await api.getRoutines(BAAN_MALI)).routines).toHaveLength(6);
  });

  it("makes a shop from a template with the template's routines, each paused, its members on, and logs each one made", async () => {
    const api = fresh();
    for (const template of packageTemplates()) {
      const { tenant } = await api.createShop({ name: `Shop ${template.id}`, ownerName: "Owner", template: template.id });
      const view = await api.getRoutines(tenant);
      expect(view.team).toEqual({ paused: false, since: null, members: [...template.team] });
      expect(view.routines).toHaveLength(template.routines.length);
      view.routines.forEach((routine, index) => {
        const words = template.routines[index]!;
        // The name, whether it asks first and its template are the template's; every routine starts paused with nothing run. Its timing is
        // said as routine-rules says it, which is the template's own words but for one: the API reads "When a size drops under 3" as stock
        // below 3, as it reads "When stock drops under 5" (`triggerOf`), and says it "When stock drops under 3". The name keeps what it is for.
        expect(routine, `${template.id} ${routine.name}`).toMatchObject({ name: words.does,
          when: words.trigger.replace("When a size drops under", "When stock drops under"), asksFirst: words.asksFirst, paused: true,
          next: null, template: template.id, timeZone: "Asia/Bangkok", lastRun: null });
        expect(routine.id).toMatch(/^rt-[0-9a-z-]{1,64}$/);
        expect(checkRoutine({ ...routine }), routine.name).toBeNull();
      });
      // Made in the template's order, with ids that sort in it, so the list reads in the order they were made.
      expect(view.routines.map((routine) => routine.id)).toEqual([...view.routines.map((routine) => routine.id)].sort());
      const log = (await api.listAudit(tenant, { limit: 200 })).entries;
      expect(log.map((entry) => entry.action)).toEqual([...Array(template.routines.length).fill("routine.created"), "template.applied", "shop.created"]);
      expect(log.slice(0, template.routines.length).map((entry) => entry.subject.routineId).reverse()).toEqual(view.routines.map((routine) => routine.id));
    }
    // A shop made with no template has none.
    const plain = await api.createShop({ name: "Plain", ownerName: "Owner" });
    expect((await api.getRoutines(plain.tenant)).routines).toEqual([]);
  });

  it("works out a template's routines as the API does: the kind of work and the member whose job it is", async () => {
    // The API turns a template's kinds into routine-rules' (`ACTION_OF`) and picks the member (`memberOf`); the practice world writes the
    // result down, so this reads the API's own text for both and works them out here for every template.
    expect(routineSetupSource).toContain(`brief: "brief", draft: "draft", remind: "brief", reply: "reply", send: "send", post: "send", pay: "pay",`);
    expect(routineSetupSource).toContain(`return kind === "post" || /\\bpost\\b/i.test(does) ? "pim" : "ton";`);
    const action = { brief: "brief", draft: "draft", remind: "brief", reply: "reply", send: "send", post: "send", pay: "pay", delete: "delete" } as const;
    const api = fresh();
    for (const template of packageTemplates()) {
      const { tenant } = await api.createShop({ name: `Shop ${template.id}`, ownerName: "Owner", template: template.id });
      const made = (await api.getRoutines(tenant)).routines;
      template.routines.forEach((words, index) => {
        const member = words.kind === "reply" ? "nam" : words.kind === "post" || /\bpost\b/i.test(words.does) ? "pim" : "ton";
        expect([made[index]!.action, made[index]!.member], `${template.id}: ${words.does}`).toEqual([action[words.kind], member]);
      });
    }
  });

  it("keeps the practice templates' words the package's, so the routines made from them say what the API's would", async () => {
    const offered = await fresh().listTemplates();
    expect(offered.map((template) => template.id)).toEqual(packageTemplates().map((template) => template.id));
    for (const template of packageTemplates()) {
      const copy = offered.find((candidate) => candidate.id === template.id)!;
      expect(copy.team).toEqual([...template.team]);
      expect(copy.routines).toEqual(template.routines.map((words) => ({ when: words.trigger, does: words.does, asksFirst: words.asksFirst })));
    }
  });

  it("makes ids of the shape the API's store checks a routine's id against, read from the API's own source", async () => {
    expect(routineStoreSource).toContain("export const ROUTINE_ID = /^rt-[0-9a-z-]{1,64}$/;");
    const api = fresh();
    for (const routine of (await api.getRoutines(BAAN_MALI)).routines) expect(routine.id).toMatch(/^rt-[0-9a-z-]{1,64}$/);
  });

  it("carries the team, the routines, the questions and the runs in the shop's export, and deletes them with the shop", async () => {
    const api = fresh();
    const exported = (await api.exportShop(BAAN_MALI)) as unknown as {
      routines: { team: unknown; routines: { id: string }[]; questions: unknown[]; runs: unknown[] } };
    expect(exported.routines.team).toEqual({ paused: false, since: null, members: null });
    expect(exported.routines.routines.map((routine) => routine.id)).toEqual([MORNING, GROWTH, REPLIES, POST, BOOKS, STOCK]);
    expect(exported.routines.questions).toEqual([]);
    expect(exported.routines.runs).toHaveLength(5);
    // What the API stores for a routine has no words, no next run and no latest run: those are worked out when it is listed.
    expect(Object.keys(exported.routines.routines[0]!).sort()).toEqual(
      ["action", "asksFirst", "createdAt", "id", "member", "name", "paused", "timeZone", "trigger"]);
    expect((await api.exportShop(SABAI_TEA)).routines).toEqual({ team: { paused: false, since: null, members: null }, routines: [], questions: [], runs: [] });
    const link = asked(await api.deleteShop({ tenant: BAAN_MALI, confirmName: "Baan Mali" }));
    await api.decideDeletion(deletionTokenOf(link.confirmUrl), true);
    expect((await api.getRoutines(BAAN_MALI)).routines).toEqual([]);
  });

  it("keeps a change across a reload, starts again on reset, and replaces a world saved before shops had routines", async () => {
    const { saved, storage } = kept();
    const first = createFakeApi({ now: () => NOW, storage });
    await first.pauseRoutine({ tenant: BAAN_MALI, routineId: MORNING });
    await first.removeRoutine({ tenant: BAAN_MALI, routineId: STOCK });
    await first.pauseTeam({ tenant: BAAN_MALI });
    const reloaded = createFakeApi({ now: () => NOW, storage });
    const view = await reloaded.getRoutines(BAAN_MALI);
    expect(view.team.paused).toBe(true);
    expect(view.routines.map((routine) => routine.id)).toEqual([MORNING, GROWTH, REPLIES, POST, BOOKS]);
    expect(view.routines[0]!.paused).toBe(true);
    reloaded.reset();
    expect((await reloaded.getRoutines(BAAN_MALI)).routines).toHaveLength(6);
    expect((await reloaded.getRoutines(BAAN_MALI)).team.paused).toBe(false);
    // Version 12 is a world saved with no routines; one that says it is version 14 but lacks them is read as the half it holds.
    for (const change of [{ version: 12, routines: undefined }, { routines: undefined }]) {
      const world = JSON.parse(saved.get("manut.pilot.fake.v1")!) as Record<string, unknown>;
      saved.set("manut.pilot.fake.v1", JSON.stringify({ ...world, ...change }));
      const api = createFakeApi({ now: () => NOW, storage });
      expect((await api.getRoutines(BAAN_MALI)).routines.map((routine) => routine.id)).toEqual([MORNING, GROWTH, REPLIES, POST, BOOKS, STOCK]);
      expect((await api.listShops()).map((shop) => shop.name)).toEqual(["Baan Mali", "Sabai Tea"]);
    }
  });

  // ---- making a routine ----------------------------------------------------------------------------------------------------------

  /// The routine the form hands over, every field given, for a test to change one field of.
  const NEW: NewRoutine = { tenant: BAAN_MALI, name: "Evening stock check", action: "draft", member: "pim",
    trigger: { kind: "weekly", weekdays: [5, 1], at: "17:30" }, timeZone: "Asia/Bangkok", asksFirst: true };
  const ROUTINE_ID = /^rt-[0-9a-z]{9}-[0-9a-z]{3}-[0-9a-f]{8}$/;

  it("makes a routine switched on, answers it as a list shows it, trimmed and as the API keeps it, and the list ends with it", async () => {
    const api = fresh();
    const made = await api.createRoutine({ ...NEW, name: "  Evening stock check  " });
    expect(made).toEqual({
      id: made.id, name: "Evening stock check", action: "draft", member: "pim", trigger: { kind: "weekly", weekdays: [5, 1], at: "17:30" },
      timeZone: "Asia/Bangkok", asksFirst: true, when: "Every Monday and Friday at 17:30", paused: false, next: "2026-11-23T10:30:00.000Z",
      createdAt: "2026-11-23T03:00:00.000Z", lastRun: null,
    });
    // The id is the API's kind: `rt-` and an id that sorts by when it was made, which any later change to it is checked against.
    expect(made.id).toMatch(ROUTINE_ID);
    expect(made).not.toHaveProperty("waitsFor");
    expect(made).not.toHaveProperty("template");
    const list = (await api.getRoutines(BAAN_MALI)).routines;
    expect(list.map((routine) => routine.id)).toEqual([MORNING, GROWTH, REPLIES, POST, BOOKS, STOCK, made.id]);
    expect(list[6]).toEqual(made);
    // Another shop's list is its own.
    expect((await api.getRoutines(SABAI_TEA)).routines).toEqual([]);
    // It can be paused, resumed and removed like any other: its id is the API's kind.
    expect((await api.pauseRoutine({ tenant: BAAN_MALI, routineId: made.id })).paused).toBe(true);
    expect(await api.removeRoutine({ tenant: BAAN_MALI, routineId: made.id })).toEqual({ removed: made.id });
  });

  it("starts a shop's first routine from nothing, for a shop that has none", async () => {
    const api = fresh();
    const made = await api.createRoutine({ ...NEW, tenant: SABAI_TEA, name: "First", action: "reply", member: "nam", asksFirst: true,
      trigger: { kind: "daily", at: "12:00" } });
    expect((await api.getRoutines(SABAI_TEA)).routines).toEqual([made]);
    expect((await api.getRoutines(SABAI_TEA)).team).toEqual({ paused: false, since: null, members: ["nam", "pim", "ton"] });
    expect(made.next).toBe("2026-11-23T05:00:00.000Z");
  });

  it("says each kind of trigger and its next run as @manut/routine-rules does, and a stock routine as one that waits for a feed", async () => {
    const api = fresh();
    const kinds: [NewRoutine["trigger"], string, string | null][] = [
      [{ kind: "daily", at: "08:00" }, "Every day at 08:00", "2026-11-24T01:00:00.000Z"],
      [{ kind: "weekly", weekdays: [1, 3, 5], at: "09:30" }, "Every Monday, Wednesday and Friday at 09:30", "2026-11-25T02:30:00.000Z"],
      [{ kind: "monthly", day: 1, at: "08:00" }, "On the 1st of each month at 08:00", "2026-12-01T01:00:00.000Z"],
      [{ kind: "monthly", day: 28, at: "08:00" }, "On the 28th of each month at 08:00", "2026-11-28T01:00:00.000Z"],
      [{ kind: "monthly", day: "last", at: "18:00" }, "On the last day of the month at 18:00", "2026-11-30T11:00:00.000Z"],
      [{ kind: "window", from: "21:00", to: "08:00" }, "Every night after 21:00", "2026-11-23T14:00:00.000Z"],
      [{ kind: "window", from: "09:00", to: "17:00" }, "Every day from 09:00 to 17:00", "2026-11-24T02:00:00.000Z"],
      [{ kind: "stockBelow", threshold: 5 }, "When stock drops under 5", null],
    ];
    for (const [trigger, when, next] of kinds) {
      const made = await api.createRoutine({ ...NEW, action: "draft", member: "ton", trigger });
      expect([made.when, made.next], when).toEqual([when, next]);
      // The words and the instant are the package's own, worked out from the routine as it was kept.
      const rules = { id: made.id, name: made.name, action: made.action, timeZone: made.timeZone, trigger: made.trigger, asksFirst: made.asksFirst };
      expect(made.when).toBe(describeTrigger(rules));
      expect(made.next).toBe(trigger.kind === "stockBelow" ? null : new Date(nextRun(rules, NOW)!).toISOString());
      expect(made.waitsFor).toBe(trigger.kind === "stockBelow" ? "stock_feed" : undefined);
      expect(made.trigger).toEqual(trigger);
    }
  });

  it("works a routine in another zone out in that zone, and says the instant it is", async () => {
    const api = fresh();
    const made = await api.createRoutine({ ...NEW, action: "brief", member: "ton", asksFirst: false, timeZone: "Asia/Tokyo",
      trigger: { kind: "daily", at: "08:00" } });
    // 08:00 in Tokyo is 06:00 in Bangkok, and 23:00 the evening before in UTC.
    expect(made).toMatchObject({ timeZone: "Asia/Tokyo", when: "Every day at 08:00", next: "2026-11-23T23:00:00.000Z" });
  });

  it("decides what the body leaves out as the API does: Asia/Bangkok, asking for a reply and the rest not, Nam for a reply and Ton for the rest", async () => {
    const api = fresh();
    const bare = (action: NewRoutine["action"]): NewRoutine => ({ tenant: BAAN_MALI, name: `A ${action}`, action, trigger: { kind: "daily", at: "08:00" } });
    const made = Object.fromEntries(await Promise.all((["brief", "draft", "reply", "send", "pay", "delete"] as const)
      .map(async (action) => [action, await api.createRoutine(bare(action))] as const)));
    expect(Object.entries(made).map(([action, routine]) => [action, routine.member, routine.asksFirst, routine.timeZone])).toEqual([
      ["brief", "ton", false, "Asia/Bangkok"],
      ["draft", "ton", false, "Asia/Bangkok"],
      ["reply", "nam", true, "Asia/Bangkok"],
      ["send", "ton", true, "Asia/Bangkok"],
      ["pay", "ton", true, "Asia/Bangkok"],
      ["delete", "ton", true, "Asia/Bangkok"],
    ]);
  });

  it("lets a brief or a draft ask, and refuses a reply, a send, a payment or a deletion that says it does not, rather than quietly changing it", async () => {
    const api = fresh();
    expect((await api.createRoutine({ ...NEW, action: "brief", member: "ton", asksFirst: true })).asksFirst).toBe(true);
    expect((await api.createRoutine({ ...NEW, action: "draft", member: "pim", asksFirst: false })).asksFirst).toBe(false);
    const before = (await api.getRoutines(BAAN_MALI)).routines.length;
    for (const [action, member] of [["reply", "nam"], ["send", "pim"], ["send", "ton"], ["pay", "ton"], ["delete", "ton"]] as const) {
      await expect(api.createRoutine({ ...NEW, action, member, asksFirst: false }), action)
        .rejects.toMatchObject({ status: 400, code: "must_ask_first" });
    }
    expect((await api.getRoutines(BAAN_MALI)).routines).toHaveLength(before);
  });

  it("offers each member only the work the API gives them, and refuses another pair as wrong_member after refusing a stranger as unknown_member", async () => {
    const api = fresh();
    const kinds = ["brief", "draft", "reply", "send", "pay", "delete"] as const;
    for (const member of ["nam", "pim", "ton"] as const) {
      for (const action of kinds) {
        const trigger = { kind: "daily", at: "08:00" } as const;
        const attempt = api.createRoutine({ ...NEW, name: `${member} ${action}`, action, member, asksFirst: true, trigger });
        if (ROUTINE_WORK[member].includes(action)) expect((await attempt).member, `${member} ${action}`).toBe(member);
        else await expect(attempt, `${member} ${action}`).rejects.toMatchObject({ status: 400, code: "wrong_member" });
      }
    }
    for (const stranger of ["kit", "", "Ton", 7, null]) {
      await expect(api.createRoutine({ ...NEW, member: stranger as never }), String(stranger)).rejects.toMatchObject({ status: 400, code: "unknown_member" });
    }
  });

  it("refuses each fault with the API's status and code, makes nothing and logs nothing", async () => {
    const api = fresh();
    const eighty = "x".repeat(80);
    const faults: [string, Partial<NewRoutine> | Record<string, unknown>, number, string][] = [
      ["no name", { name: "" }, 400, "invalid_name"],
      ["a name of spaces", { name: "   " }, 400, "invalid_name"],
      ["a name of 81 characters", { name: `${eighty}y` }, 400, "invalid_name"],
      ["a name that is no text", { name: 7 as never }, 400, "invalid_name"],
      ["an action that is none", { action: "buy" as never }, 400, "invalid_action"],
      ["no action", { action: undefined as never }, 400, "invalid_action"],
      ["a zone that is none", { timeZone: "Mars/Olympus" }, 400, "invalid_time_zone"],
      ["an empty zone", { timeZone: "" }, 400, "invalid_time_zone"],
      ["no trigger", { trigger: undefined as never }, 400, "invalid_trigger"],
      ["a kind of trigger that is none", { trigger: { kind: "hourly" } as never }, 400, "invalid_trigger"],
      ["a time without its zero", { trigger: { kind: "daily", at: "8:00" } }, 400, "invalid_time"],
      ["a time past midnight", { trigger: { kind: "daily", at: "24:00" } }, 400, "invalid_time"],
      ["a minute past 59", { trigger: { kind: "weekly", weekdays: [1], at: "08:60" } }, 400, "invalid_time"],
      ["a time that is blank", { trigger: { kind: "monthly", day: 1, at: "" } }, 400, "invalid_time"],
      ["a window from a time that is none", { trigger: { kind: "window", from: "9am", to: "17:00" } }, 400, "invalid_time"],
      ["no weekday", { trigger: { kind: "weekly", weekdays: [], at: "08:00" } }, 400, "invalid_weekdays"],
      ["a weekday past Saturday", { trigger: { kind: "weekly", weekdays: [1, 7], at: "08:00" } }, 400, "invalid_weekdays"],
      ["a weekday that is not whole", { trigger: { kind: "weekly", weekdays: [1.5], at: "08:00" } }, 400, "invalid_weekdays"],
      ["weekdays that are no list", { trigger: { kind: "weekly", weekdays: 1 as never, at: "08:00" } }, 400, "invalid_weekdays"],
      ["day 0", { trigger: { kind: "monthly", day: 0, at: "08:00" } }, 400, "invalid_day"],
      ["day 29", { trigger: { kind: "monthly", day: 29, at: "08:00" } }, 400, "invalid_day"],
      ["a day that is a word but not the last", { trigger: { kind: "monthly", day: "first" as never, at: "08:00" } }, 400, "invalid_day"],
      ["a window that starts where it ends", { trigger: { kind: "window", from: "21:00", to: "21:00" } }, 400, "invalid_window"],
      ["a threshold of 0", { trigger: { kind: "stockBelow", threshold: 0 } }, 400, "invalid_threshold"],
      ["a threshold that is not whole", { trigger: { kind: "stockBelow", threshold: 2.5 } }, 400, "invalid_threshold"],
      ["a threshold that is text", { trigger: { kind: "stockBelow", threshold: "5" as never } }, 400, "invalid_threshold"],
      ["a threshold too big to count", { trigger: { kind: "stockBelow", threshold: Number.MAX_SAFE_INTEGER + 1 } }, 400, "invalid_threshold"],
      ["a payment that does not ask", { action: "pay", member: "ton", asksFirst: false }, 400, "must_ask_first"],
      ["a member nobody is", { member: "kit" as never }, 400, "unknown_member"],
      ["a member whose work it is not", { member: "nam" }, 400, "wrong_member"],
      ["a field the route does not take", { paused: true }, 400, "invalid_request"],
      ["an id of its own choosing", { id: "rt-mine" }, 400, "invalid_request"],
      ["asksFirst that is no boolean", { asksFirst: "yes" as never }, 400, "invalid_request"],
      ["asksFirst that is a number", { asksFirst: 1 as never }, 400, "invalid_request"],
    ];
    const before = await logLength(api, BAAN_MALI);
    for (const [fault, change, status, code] of faults) {
      await expect(api.createRoutine({ ...NEW, ...change } as NewRoutine), fault).rejects.toMatchObject({ status, code });
    }
    expect((await api.getRoutines(BAAN_MALI)).routines).toHaveLength(6);
    expect(await logLength(api, BAAN_MALI)).toBe(before);
    // 80 characters is allowed, and so are 80 characters that are each two code units long: the API counts what a person would.
    expect((await api.createRoutine({ ...NEW, name: eighty })).name).toBe(eighty);
    expect((await api.createRoutine({ ...NEW, name: "🌸".repeat(80) })).name).toBe("🌸".repeat(80));
    await expect(api.createRoutine({ ...NEW, name: "🌸".repeat(81) })).rejects.toMatchObject({ code: "invalid_name" });
  });

  it("refuses in the API's order: the shop before the body, and the body's fields in routine-rules' order, the member last", async () => {
    const api = fresh();
    const order: [string, Record<string, unknown>, string][] = [
      ["the shop's name before anything of the body", { tenant: "", name: "" }, "tenant_required"],
      ["a shop that is not one before any fault of the body", { tenant: "shop_nobody", name: "", action: "buy" }, "shop_not_found"],
      ["a field the route does not take before the name", { name: "", paused: true }, "invalid_request"],
      ["asksFirst's type before the name", { name: "", asksFirst: "yes" }, "invalid_request"],
      ["the name before the action", { name: "", action: "buy" }, "invalid_name"],
      ["the action before the zone", { action: "buy", timeZone: "Mars/Olympus" }, "invalid_action"],
      ["the zone before the trigger", { timeZone: "Mars/Olympus", trigger: { kind: "hourly" } }, "invalid_time_zone"],
      ["the time before the weekdays", { trigger: { kind: "weekly", weekdays: [], at: "8:00" } }, "invalid_time"],
      ["the trigger before the rule that asks first", { trigger: { kind: "hourly" }, action: "pay", member: "ton", asksFirst: false }, "invalid_trigger"],
      ["the rule that asks first before the member", { action: "pay", asksFirst: false, member: "kit" }, "must_ask_first"],
      ["the member who is nobody before the work", { member: "kit", action: "pay" }, "unknown_member"],
    ];
    for (const [what, change, code] of order) {
      await expect(api.createRoutine({ ...NEW, ...change } as NewRoutine), what).rejects.toMatchObject({ code });
    }
    expect((await api.getRoutines(BAAN_MALI)).routines).toHaveLength(6);
  });

  it("refuses without an operator key, as every admin route does, and for a tenant that is none", async () => {
    await expect(createFakeApi({ operatorKey: () => null }).createRoutine(NEW)).rejects.toMatchObject({ status: 403, code: "forbidden" });
    const api = fresh();
    for (const tenant of ["", "x".repeat(257), 7 as never, undefined as never]) {
      await expect(api.createRoutine({ ...NEW, tenant }), String(tenant)).rejects.toMatchObject({ status: 400, code: "tenant_required" });
    }
    await expect(api.createRoutine({ ...NEW, tenant: "shop_nobody" })).rejects.toMatchObject({ status: 404, code: "shop_not_found" });
    expect(await logLength(api, BAAN_MALI)).toBe(await logLength(fresh(), BAAN_MALI));
  });

  it("refuses the routine after a shop's 50th as full, makes nothing, and makes room again when one is removed", async () => {
    const api = fresh();
    for (let n = 7; n <= MAX_ROUTINES; n++) await api.createRoutine({ ...NEW, name: `Routine ${n}` });
    expect((await api.getRoutines(BAAN_MALI)).routines).toHaveLength(50);
    const before = await logLength(api, BAAN_MALI);
    await expect(api.createRoutine({ ...NEW, name: "One too many" })).rejects.toMatchObject({ status: 409, code: "full" });
    expect((await api.getRoutines(BAAN_MALI)).routines).toHaveLength(50);
    expect(await logLength(api, BAAN_MALI)).toBe(before);
    // The limit is the shop's own, and a routine removed makes room for one.
    expect((await api.createRoutine({ ...NEW, tenant: SABAI_TEA, name: "Sabai's own" })).name).toBe("Sabai's own");
    await api.removeRoutine({ tenant: BAAN_MALI, routineId: MORNING });
    expect((await api.createRoutine({ ...NEW, name: "Room again" })).name).toBe("Room again");
    await expect(api.createRoutine({ ...NEW, name: "Full again" })).rejects.toMatchObject({ code: "full" });
  });

  it("looks at the body before the limit, so a shop that is full still says what is wrong with the routine", async () => {
    const api = fresh();
    for (let n = 7; n <= MAX_ROUTINES; n++) await api.createRoutine({ ...NEW, name: `Routine ${n}` });
    await expect(api.createRoutine({ ...NEW, name: "" })).rejects.toMatchObject({ code: "invalid_name" });
    await expect(api.createRoutine({ ...NEW, member: "nam" })).rejects.toMatchObject({ code: "wrong_member" });
  });

  it("logs routine.created by the operator with the routine's id, and never its name, once", async () => {
    const api = fresh();
    const before = await logLength(api, BAAN_MALI);
    const made = await api.createRoutine({ ...NEW, name: "Secret supplier chase" });
    expect(await logLength(api, BAAN_MALI)).toBe(before + 1);
    expect(await newest(api, BAAN_MALI)).toEqual({ actor: operator, action: "routine.created", subject: { routineId: made.id }, outcome: "ok" });
    const entries = (await api.listAudit(BAAN_MALI, { limit: 200 })).entries;
    expect(JSON.stringify(entries)).not.toContain("Secret supplier chase");
    // The shop's words for the entry are the console's own: it names the routine by its id, as every routine entry does.
    expect(entries[0]!.action).toBe("routine.created");
    // Another shop's log is untouched.
    expect(await logLength(api, SABAI_TEA)).toBe(await logLength(fresh(), SABAI_TEA));
  });

  it("keeps a routine that was made with the saved world, across a reload, and a reset puts the sample back", async () => {
    const { saved, storage } = kept();
    const first = createFakeApi({ now: () => NOW, storage });
    const made = await first.createRoutine(NEW);
    const reloaded = createFakeApi({ now: () => NOW, storage });
    expect((await reloaded.getRoutines(BAAN_MALI)).routines.map((routine) => routine.id)).toEqual([MORNING, GROWTH, REPLIES, POST, BOOKS, STOCK, made.id]);
    expect(await reloaded.removeRoutine({ tenant: BAAN_MALI, routineId: made.id })).toEqual({ removed: made.id });
    reloaded.reset();
    expect((await reloaded.getRoutines(BAAN_MALI)).routines).toHaveLength(6);
    // The saved world holds the routine as the API's shop object does: the stored fields, not its words or its next run.
    await first.createRoutine({ ...NEW, name: "Saved" });
    const world = JSON.parse(saved.get("manut.pilot.fake.v1")!) as { routines: Record<string, { routines: Record<string, unknown>[] }> };
    const stored = world.routines[BAAN_MALI]!.routines.at(-1)!;
    expect(Object.keys(stored).sort()).toEqual(["action", "asksFirst", "createdAt", "id", "member", "name", "paused", "timeZone", "trigger"]);
  });

  it("is saved as version 14, and a world saved before it, at version 13, is replaced by the sample", async () => {
    const { saved, storage } = kept();
    const first = createFakeApi({ now: () => NOW, storage });
    await first.createRoutine(NEW);
    expect((JSON.parse(saved.get("manut.pilot.fake.v1")!) as { version: number }).version).toBe(14);
    const world = JSON.parse(saved.get("manut.pilot.fake.v1")!) as Record<string, unknown>;
    saved.set("manut.pilot.fake.v1", JSON.stringify({ ...world, version: 13 }));
    const replaced = createFakeApi({ now: () => NOW, storage });
    expect((await replaced.getRoutines(BAAN_MALI)).routines.map((routine) => routine.id)).toEqual([MORNING, GROWTH, REPLIES, POST, BOOKS, STOCK]);
    expect((JSON.parse(saved.get("manut.pilot.fake.v1")!) as { version: number }).version).toBe(14);
  });

  it("copies the trigger it is given, so changing what the caller holds changes nothing kept", async () => {
    const api = fresh();
    const input: NewRoutine = { ...NEW, trigger: { kind: "weekly", weekdays: [1], at: "08:00" } };
    const made = await api.createRoutine(input);
    (input.trigger as { weekdays: number[] }).weekdays.push(2, 3);
    expect((await routineOf(api, made.id)).trigger).toEqual({ kind: "weekly", weekdays: [1], at: "08:00" });
    expect((await routineOf(api, made.id)).when).toBe("Every Monday at 08:00");
  });

  it("makes a routine for a member the shop's template turned off, which the API allows, and says it has no next run", async () => {
    const api = fresh();
    const shop = await api.createShop({ name: "Sabai Snacks", ownerName: "Dao", template: "food" });
    // The food template turns Nam and Ton on and Pim off. A post is Pim's job: made, switched on, and never run while Pim is off.
    const made = await api.createRoutine({ ...NEW, tenant: shop.tenant, member: "pim" });
    expect(made).toMatchObject({ member: "pim", paused: false, next: null });
    const list = (await api.getRoutines(shop.tenant)).routines;
    expect(list).toHaveLength(5);
    expect(list.at(-1)).toEqual(made);
    // The four of the template come first, each still paused and naming it.
    expect(list.slice(0, 4).every((routine) => routine.paused && routine.template === "food")).toBe(true);
  });

  it("answers no next run for a routine made while everyone is paused, as the list does", async () => {
    const api = fresh();
    await api.pauseTeam({ tenant: BAAN_MALI });
    const made = await api.createRoutine(NEW);
    expect(made).toMatchObject({ paused: false, next: null });
    await api.resumeTeam({ tenant: BAAN_MALI });
    expect((await routineOf(api, made.id)).next).toBe("2026-11-23T10:30:00.000Z");
  });

  it("holds its limits to the API's own text: the fields a body may hold, the work of each member, the most a shop may have, whose job by default", () => {
    const fieldList = /const NEW_ROUTINE_FIELDS = \[([^\]]*)\]/.exec(routinesSource)?.[1];
    expect(fieldList, "NEW_ROUTINE_FIELDS in apps/api/src/routines.ts").toBeDefined();
    expect([...fieldList!.matchAll(/"([^"]+)"/g)].map((match) => match[1])).toEqual(["name", "action", "trigger", "timeZone", "asksFirst", "member"]);
    expect(routinesSource).toContain('Object.keys(body).every((key) => NEW_ROUTINE_FIELDS.includes(key))');

    const work = /const WORK[^=]*=\s*\{([^}]*)\}/.exec(routineSetupSource)?.[1];
    expect(work, "WORK in apps/api/src/routine-setup.ts").toBeDefined();
    const apiWork = Object.fromEntries([...work!.matchAll(/(\w+):\s*\[([^\]]*)\]/g)]
      .map((match) => [match[1], [...match[2]!.matchAll(/"([^"]+)"/g)].map((word) => word[1])]));
    expect(apiWork).toEqual(Object.fromEntries(Object.entries(ROUTINE_WORK).map(([member, actions]) => [member, [...actions]])));
    expect(routineSetupSource).toContain('return action === "reply" ? "nam" : "ton";');

    expect(/export const MAX_ROUTINES = (\d+);/.exec(routineStoreSource)?.[1]).toBe(String(MAX_ROUTINES));
    expect(routineStoreSource).toContain('if (state.routines.length >= MAX_ROUTINES) return refuse(409, "full");');
  });
});
