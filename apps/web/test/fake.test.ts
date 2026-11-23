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
