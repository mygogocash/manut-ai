import { runInDurableObject } from "cloudflare:test";
import { createRoutine, nextRun, type Routine } from "@manut/routine-rules";
import type { Fact } from "@manut/shop-memory";
import { templates as builtIns } from "@manut/shop-templates";
import { describe, expect, it } from "vitest";
import type { RoutineRun, RoutinesView, RoutineView } from "../src/routines";
import type { ScheduleJSON, ScheduleObject } from "../src/schedule-object";
import { scheduleStub, tenantCall } from "../src/tenant-data";
import { admin, auditEntries, bindings, shopConsents } from "./people-fixtures";

// Applying a shop template when a shop is created (pilot.ts, routine-setup.ts), through the real Worker and objects in
// workerd: the three templates of @manut/shop-templates offered as they are written; a shop made from one has the
// template on its record, its members on, its routines made and paused until the owner turns each on, and its
// first-week questions for Buddy to ask; an owner's answer, relayed by an operator, becomes the owner's own fact through
// memory's `remember`; a template that is not one is refused and makes no shop; and the audit log names templates,
// routines, questions and facts by id only.

const enc = encodeURIComponent;
const MINUTE = 60_000;

type TemplateView = { id: string; name: string; fits: string; team: string[];
  routines: { when: string; does: string; asksFirst: boolean }[]; questions: string[] };
type QuestionView = { id: string; text: string; answer: { factId: string; text: string | null; answeredAt: string } | null };
type QuestionsView = { tenant: string; template: string | null; questions: QuestionView[] };
type Created = { tenant: string; name: string; ownerName: string; template?: string; error?: string };

const createShop = (body: Record<string, unknown>) => admin<Created>("POST", "/v1/admin/pilot/shops", body);
const routinesOf = (tenant: string) => admin<RoutinesView>("GET", `/v1/admin/routines?tenant=${enc(tenant)}`);
const questionsOf = (tenant: string) => admin<QuestionsView>("GET", `/v1/admin/questions?tenant=${enc(tenant)}`);
const answer = (tenant: string, questionId: string, text: unknown) =>
  admin<{ question: QuestionView; fact: Fact; error?: string }>("POST", "/v1/admin/questions/answer",
    { tenant, questionId, text });

async function shops(): Promise<{ tenant: string; name: string; template?: string }[]> {
  const listed = await admin<{ shops: { tenant: string; name: string; template?: string }[] }>("GET", "/v1/admin/pilot/shops");
  expect(listed.status).toBe(200);
  return listed.body.shops;
}

/// A shop made from a template, which must have been accepted.
async function shopFrom(template: string, name = `A ${template} shop`): Promise<string> {
  const created = await createShop({ name, ownerName: "Fon", template });
  expect(created.status, JSON.stringify(created.body)).toBe(200);
  return created.body.tenant;
}

function rulesOf(view: RoutineView): Routine {
  const built = createRoutine({ id: view.id, name: view.name, action: view.action, timeZone: view.timeZone,
    trigger: view.trigger, asksFirst: view.asksFirst });
  if (!built.ok) throw new Error(built.reason);
  return built.routine;
}

async function runsOf(tenant: string, routineId: string): Promise<RoutineRun[]> {
  const response = await tenantCall(bindings, tenant, `/routines/runs?tenant=${enc(tenant)}&routineId=${enc(routineId)}`);
  return ((await response.json()) as { runs: RoutineRun[] }).runs;
}

describe("shop templates", () => {
  it("offers the three templates in their own words", async () => {
    const listed = await admin<{ templates: TemplateView[] }>("GET", "/v1/admin/templates");
    expect(listed.status).toBe(200);
    expect(listed.body.templates.map((t) => [t.id, t.name])).toEqual([
      ["handmade", "Handmade and gifts"], ["fashion", "Clothes and accessories"], ["food", "Packaged food and drinks"],
    ]);
    const food = listed.body.templates.find((t) => t.id === "food")!;
    expect(food.team).toEqual(["nam", "ton"]);
    expect(food.routines[0]).toEqual({ when: "Every day at 08:00", does: "Morning brief", asksFirst: false });
    expect(food.questions).toHaveLength(4);
  });

  for (const template of builtIns()) {
    it(`applies the ${template.id} template cleanly when a shop is made`, async () => {
      const created = await createShop({ name: `${template.name} shop`, ownerName: "Fon", template: template.id });
      expect(created.status).toBe(200);
      expect(created.body).toMatchObject({ name: `${template.name} shop`, ownerName: "Fon", template: template.id });
      const tenant = created.body.tenant;
      // On the shop's record, as the console's shop list shows it.
      expect((await shops()).find((s) => s.tenant === tenant)?.template).toBe(template.id);

      // Its members on, and its routines made in its own words, each paused until the owner turns it on.
      const read = await routinesOf(tenant);
      expect(read.status).toBe(200);
      expect(read.body.team).toEqual({ paused: false, since: null, members: [...template.team] });
      expect(read.body.routines.map((r) => r.name)).toEqual(template.routines.map((r) => r.does));
      template.routines.forEach((source, index) => {
        const routine = read.body.routines[index]!;
        expect(routine).toMatchObject({ paused: true, next: null, template: template.id, asksFirst: source.asksFirst,
          lastRun: null });
        // Until a stock feed exists a size is counted as stock, and the routine's name keeps what it is for.
        expect(routine.when).toBe(source.trigger.replace("When a size drops under", "When stock drops under"));
      });
      // Pim drafts the post; Ton the briefs, the reminder, the restock draft and the books.
      expect(read.body.routines.map((r) => r.member))
        .toEqual(template.routines.map((r) => (/\bpost\b/i.test(r.does) ? "pim" : "ton")));
      // The books go out only once the owner says so.
      expect(read.body.routines.find((r) => r.name === "Send the books to FlowAccount"))
        .toMatchObject({ action: "send", asksFirst: true });

      // Its questions for Buddy to ask the owner, none answered yet.
      expect((await questionsOf(tenant)).body).toEqual({ tenant, template: template.id,
        questions: template.questions.map((text, index) => ({ id: `q${index + 1}`, text, answer: null })) });

      // The log: the shop, the template and each routine, newest first.
      const actions = (await auditEntries(tenant)).map((entry) => entry.action);
      expect(actions).toEqual([...template.routines.map(() => "routine.created"), "template.applied", "shop.created"]);
    });
  }

  it("starts a template's routines paused, so nothing runs by surprise until the owner turns one on", async () => {
    const tenant = await shopFrom("food");
    await shopConsents(tenant);
    const routines = (await routinesOf(tenant)).body.routines;
    // The daily ones are schedules on the shop's schedule object; the month-end one is a timer beside them.
    let clocks: { schedules: string[]; timers: string[] } = { schedules: [], timers: [] };
    await runInDurableObject(scheduleStub(bindings, tenant), async (_instance, state) => {
      clocks = {
        schedules: [...(await state.storage.list<ScheduleJSON>({ prefix: "sched:" })).values()].map((s) => s.routineId!),
        timers: [...(await state.storage.list({ prefix: "rclock:" })).keys()].map((key) => key.slice("rclock:".length)),
      };
    });
    expect(clocks.schedules.sort()).toEqual(routines.filter((r) => r.trigger.kind === "daily").map((r) => r.id).sort());
    expect(clocks.timers).toEqual(routines.filter((r) => r.trigger.kind === "monthly").map((r) => r.id));

    const books = routines.find((r) => r.trigger.kind === "monthly")!;
    const first = nextRun(rulesOf(books), Date.now())!;
    const sweep = (at: number) => runInDurableObject(scheduleStub(bindings, tenant), async (instance: ScheduleObject) => {
      await instance.routineSweep(at);
    });
    await sweep(first + MINUTE);
    expect(await runsOf(tenant, books.id)).toEqual([
      expect.objectContaining({ status: "skipped", reason: "routine_paused" }),
    ]);
    const index = await tenantCall(bindings, tenant, `/index?tenant=${enc(tenant)}`);
    expect(((await index.json()) as { taskIds: string[] }).taskIds).toEqual([]);

    // Turned on, it runs at its next instant: Ton drafts, and nothing is sent.
    const resumed = await admin<{ routine: RoutineView }>("POST", "/v1/admin/routines/resume",
      { tenant, routineId: books.id });
    expect(resumed.body.routine).toMatchObject({ paused: false });
    const second = nextRun(rulesOf(books), first)!;
    expect(resumed.body.routine.next).toBe(new Date(nextRun(rulesOf(books), Date.now())!).toISOString());
    await sweep(second + MINUTE);
    expect((await runsOf(tenant, books.id)).map((run) => [run.status, run.member])).toEqual([["done", "ton"],
      ["skipped", "ton"]]);
  });

  it("refuses a template that is not one, and makes no shop", async () => {
    const before = (await shops()).length;
    for (const template of ["bakery", "", "FOOD", 42, true, { id: "food" }, ["food"]]) {
      const refused = await createShop({ name: "Not a template", ownerName: "Fon", template });
      expect(refused.status, JSON.stringify(template)).toBe(400);
      expect(refused.body).toEqual({ error: "unknown_template" });
    }
    expect((await shops()).length).toBe(before);
  });

  it("makes a shop with no template as before: every worker on, nothing scheduled and nothing to ask", async () => {
    for (const body of [{}, { template: null }]) {
      const created = await createShop({ name: "Plain shop", ownerName: "Fon", ...body });
      expect(created.status).toBe(200);
      expect(created.body.template).toBeUndefined();
      const tenant = created.body.tenant;
      expect((await shops()).find((s) => s.tenant === tenant)?.template).toBeUndefined();
      expect((await routinesOf(tenant)).body).toEqual({ tenant,
        team: { paused: false, since: null, members: ["nam", "pim", "ton"] }, routines: [] });
      expect((await questionsOf(tenant)).body).toEqual({ tenant, template: null, questions: [] });
    }
  });

  it("turns the owner's answer into the owner's own fact, and reads it back on the shop", async () => {
    const tenant = await shopFrom("handmade", "Baan Mali");
    const text = "Candles are ฿290, soap bars ฿120, and gift sets start at ฿650.";
    const answered = await answer(tenant, "q1", text);
    expect(answered.status).toBe(200);
    expect(answered.body.question).toMatchObject({ id: "q1", text: "What is your price list?", answer: { text } });
    const factId = answered.body.question.answer!.factId;
    expect(answered.body.fact).toMatchObject({ id: factId, text, status: "confirmed", source: { kind: "owner" } });

    // A fact the owner is the source of, confirmed at once, so the team may use it.
    const memory = await admin<{ facts: Fact[] }>("GET", `/v1/admin/memory?tenant=${enc(tenant)}`);
    expect(memory.body.facts).toEqual([expect.objectContaining({ id: factId, text, status: "confirmed",
      source: { kind: "owner" } })]);
    // The console reads it back on the shop, with the other questions still open.
    const questions = (await questionsOf(tenant)).body.questions;
    expect(questions[0]).toEqual({ id: "q1", text: "What is your price list?",
      answer: { factId, text, answeredAt: expect.any(String) } });
    expect(questions.slice(1).map((question) => question.answer)).toEqual([null, null, null]);

    // Once only: changing an answer is a correction of its fact, on the Memory page.
    expect(await answer(tenant, "q1", "Something else")).toEqual({ status: 409, body: { error: "already_answered" } });
    // Refusals answer memory's own codes and change nothing.
    expect(await answer(tenant, "q9", "Anything")).toEqual({ status: 404, body: { error: "not_found" } });
    expect(await answer(tenant, "q2", "   ")).toEqual({ status: 400, body: { error: "invalid_text" } });
    expect(await answer(tenant, "q2", "x".repeat(281))).toEqual({ status: 400, body: { error: "invalid_text" } });
    expect(await answer(tenant, "q2", text)).toEqual({ status: 409, body: { error: "already_known" } });
    expect((await admin("POST", "/v1/admin/questions/answer", { tenant: "pilot:not-a-shop", questionId: "q1",
      text })).body).toEqual({ error: "shop_not_found" });
    expect((await questionsOf(tenant)).body.questions.slice(1).every((question) => question.answer === null)).toBe(true);

    // A fact the owner had the team forget leaves its question answered, and its words gone.
    expect((await admin("POST", "/v1/admin/memory/forget", { tenant, id: factId })).status).toBe(200);
    expect((await questionsOf(tenant)).body.questions[0]!.answer).toEqual({ factId, text: null,
      answeredAt: expect.any(String) });
  });

  it("records the template, its routines and the answer by id, never by their words", async () => {
    const tenant = await shopFrom("fashion");
    const words = "Exchanges within 14 days, unworn and with the tag on, jasmine-7781.";
    const answered = await answer(tenant, "q2", words);
    expect(answered.status).toBe(200);
    const entries = await auditEntries(tenant);
    expect(entries.find((entry) => entry.action === "template.applied")?.subject).toEqual({ templateId: "fashion" });
    expect(entries.find((entry) => entry.action === "question.answered")).toMatchObject({
      actor: { kind: "operator", email: null }, subject: { questionId: "q2", factId: answered.body.fact.id }, outcome: "ok",
    });
    expect(entries.find((entry) => entry.action === "memory.remembered")?.subject).toEqual({ factId: answered.body.fact.id });
    const logged = JSON.stringify(entries);
    expect(logged).not.toContain("jasmine-7781");
    for (const template of builtIns().filter((t) => t.id === "fashion")) {
      for (const question of template.questions) expect(logged).not.toContain(question);
      for (const routine of template.routines) expect(logged).not.toContain(routine.does);
    }
  });
});
