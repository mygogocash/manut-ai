import { describe, expect, it, vi } from "vitest";
import { createHttpApi } from "../src/api/client";
import { createFakeApi } from "../src/api/fake";

// The console's side of shop templates (docs/pilot-api.md, "Shop templates"): the client's routes as the contract writes
// them, and the practice fake keeping the API's rules for them: the three templates in their own words, a shop made from
// one with its first-week questions, a template that is not one refused with no shop made, and an answer becoming the
// owner's own fact once, read back from what the team knows.

const NOW = Date.parse("2026-11-23T03:00:00Z");

type Call = { url: string; method: string; authorization: string | null; body: unknown };

function harness(answer: (url: string) => Response) {
  const calls: Call[] = [];
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({
      url: String(input),
      method: init?.method ?? "GET",
      authorization: new Headers(init?.headers).get("authorization"),
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    });
    return answer(String(input));
  });
  return { api: createHttpApi({ origin: "https://api.example.test", operatorKey: () => "op-key-123", fetch }), calls };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const QUESTION = { id: "q1", text: "What is your price list?", answer: null };

describe("the client's shop template routes", () => {
  it("lists the templates, makes a shop from one, reads its questions and relays an answer, with the operator key", async () => {
    const template = { id: "food", name: "Packaged food and drinks", fits: "Shops selling packaged food.", team: ["nam", "ton"],
      routines: [{ when: "Every day at 08:00", does: "Morning brief", asksFirst: false }], questions: ["Q1?", "Q2?"] };
    const answered = { ...QUESTION, answer: { factId: "f1", text: "Candles ฿290.", answeredAt: "2026-11-23T03:00:00.000Z" } };
    const { api, calls } = harness((url) => {
      const { pathname } = new URL(url);
      if (pathname === "/v1/admin/templates") return json({ templates: [template] });
      if (pathname === "/v1/admin/pilot/shops") return json({ tenant: "pilot:1", name: "Sabai", ownerName: "Dao", template: "food" });
      if (pathname === "/v1/admin/questions") return json({ tenant: "pilot:1", template: "food", questions: [QUESTION] });
      return json({ question: answered, fact: { id: "f1" } });
    });

    expect(await api.listTemplates()).toEqual([template]);
    expect(await api.createShop({ name: "Sabai", ownerName: "Dao", template: "food" }))
      .toEqual({ tenant: "pilot:1", name: "Sabai", ownerName: "Dao", template: "food" });
    expect(await api.getQuestions("pilot:1")).toEqual({ tenant: "pilot:1", template: "food", questions: [QUESTION] });
    expect(await api.answerQuestion({ tenant: "pilot:1", questionId: "q1", text: "Candles ฿290." })).toEqual(answered);

    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      "GET https://api.example.test/v1/admin/templates",
      "POST https://api.example.test/v1/admin/pilot/shops",
      "GET https://api.example.test/v1/admin/questions?tenant=pilot%3A1",
      "POST https://api.example.test/v1/admin/questions/answer",
    ]);
    expect(calls.every((call) => call.authorization === "Bearer op-key-123")).toBe(true);
    expect(calls[1]?.body).toEqual({ name: "Sabai", ownerName: "Dao", template: "food" });
    expect(calls[3]?.body).toEqual({ tenant: "pilot:1", questionId: "q1", text: "Candles ฿290." });
  });

  it("turns the routes' refusals into ApiError", async () => {
    const { api } = harness((url) => (url.includes("/questions/answer") ? json({ error: "already_answered" }, 409)
      : json({ error: "unknown_template" }, 400)));
    await expect(api.createShop({ name: "Sabai", ownerName: "Dao", template: "bakery" }))
      .rejects.toMatchObject({ status: 400, code: "unknown_template" });
    await expect(api.answerQuestion({ tenant: "pilot:1", questionId: "q1", text: "x" }))
      .rejects.toMatchObject({ status: 409, code: "already_answered" });
  });
});

describe("the fake's shop templates, kept as the API keeps them", () => {
  it("offers the three templates, and makes a shop from one with its questions on its record", async () => {
    const api = createFakeApi({ now: () => NOW, webOrigin: "https://web.test" });
    const templates = await api.listTemplates();
    expect(templates.map((t) => [t.id, t.name])).toEqual([
      ["handmade", "Handmade and gifts"], ["fashion", "Clothes and accessories"], ["food", "Packaged food and drinks"],
    ]);
    const food = templates.find((t) => t.id === "food")!;
    expect(food.team).toEqual(["nam", "ton"]);
    expect(food.routines).toHaveLength(4);

    const created = await api.createShop({ name: " Sabai Snacks ", ownerName: "Dao", template: "food" });
    expect(created).toMatchObject({ name: "Sabai Snacks", ownerName: "Dao", template: "food" });
    expect((await api.listShops()).find((shop) => shop.tenant === created.tenant)).toMatchObject({ template: "food" });
    expect(await api.getQuestions(created.tenant)).toEqual({ tenant: created.tenant, template: "food",
      questions: food.questions.map((text, index) => ({ id: `q${index + 1}`, text, answer: null })) });
    const logged = await api.listAudit(created.tenant);
    // Newest first: the template's four routines were made after it was applied, as the API logs them, one entry each.
    expect(logged.entries.map((entry) => entry.action)).toEqual([...Array(4).fill("routine.created"), "template.applied", "shop.created"]);
    expect(logged.entries[4]?.subject).toEqual({ templateId: "food" });
  });

  it("refuses a template that is not one and makes no shop; a shop with none has nothing to ask", async () => {
    const api = createFakeApi({ now: () => NOW, webOrigin: "https://web.test" });
    const before = (await api.listShops()).length;
    await expect(api.createShop({ name: "Nope", ownerName: "Fon", template: "bakery" }))
      .rejects.toMatchObject({ status: 400, code: "unknown_template" });
    expect(await api.listShops()).toHaveLength(before);
    const plain = await api.createShop({ name: "Plain", ownerName: "Fon" });
    expect(plain.template).toBeUndefined();
    expect(await api.getQuestions(plain.tenant)).toEqual({ tenant: plain.tenant, template: null, questions: [] });
  });

  it("turns the owner's answer into the owner's own fact once, and keeps Forget's promise", async () => {
    const api = createFakeApi({ now: () => NOW, webOrigin: "https://web.test" });
    const { tenant } = await api.createShop({ name: "Baan Mali Two", ownerName: "Fon", template: "handmade" });
    const text = "Candles are ฿290 and soap bars ฿120.";
    const answered = await api.answerQuestion({ tenant, questionId: "q1", text });
    expect(answered).toEqual({ id: "q1", text: "What is your price list?",
      answer: { factId: expect.any(String), text, answeredAt: new Date(NOW).toISOString() } });
    const factId = answered.answer!.factId;
    expect((await api.getMemory(tenant)).facts).toEqual([expect.objectContaining({ id: factId, text,
      status: "confirmed", source: { kind: "owner" } })]);

    await expect(api.answerQuestion({ tenant, questionId: "q1", text: "Else" }))
      .rejects.toMatchObject({ status: 409, code: "already_answered" });
    await expect(api.answerQuestion({ tenant, questionId: "q9", text: "Else" }))
      .rejects.toMatchObject({ status: 404, code: "not_found" });
    await expect(api.answerQuestion({ tenant, questionId: "q2", text: "   " }))
      .rejects.toMatchObject({ status: 400, code: "invalid_text" });
    await expect(api.answerQuestion({ tenant, questionId: "q2", text }))
      .rejects.toMatchObject({ status: 409, code: "already_known" });
    const actions = (await api.listAudit(tenant)).entries.map((entry) => entry.action);
    expect(actions.slice(0, 2)).toEqual(["question.answered", "memory.remembered"]);

    await api.forgetFact({ tenant, id: factId });
    expect((await api.getQuestions(tenant)).questions[0]?.answer).toEqual({ factId, text: null,
      answeredAt: new Date(NOW).toISOString() });
  });
});
