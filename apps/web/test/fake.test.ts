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
      counts: NO_CALLS, tokens: { input: 0, output: 0 }, calls: [], holds: [],
    });
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
