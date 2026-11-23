import { describe, expect, it } from "vitest";
import { isAwaitingOwner, type AwaitingOwner, type DeletedShop } from "../src/api";
import { createFakeApi, DEMO_DELETION_TOKENS, DEMO_TOKENS, lineSignature, PRACTICE_CHANNEL_SECRET } from "../src/api/fake";

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
        trialEnded: false, paid: false, paidSatang: 0, activeOnDay14: "yes", lastDecisionAt: "2026-11-22T22:18:00.000Z" },
      { tenant: "shop_sabaitea", name: "Sabai Tea", trialStartedAt: null, day: null, trialEnded: false, paid: false,
        paidSatang: 0, activeOnDay14: "not_yet" },
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
