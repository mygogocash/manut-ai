// What the team knows, on the in-process runtime (Practice). The rules are `@manut/shop-memory`'s and these tests only
// check that the runtime keeps to them through the operations the Customize page calls: each action, each refusal, the
// customer's fact that waits, and Forget, which must leave no word of the fact behind. The runtime counts seconds, as
// everywhere in the protocol, while the package counts milliseconds, so the times are checked at that seam too.
import { beforeEach, describe, expect, it } from "vitest";
import type { BridgeError } from "../../lib/protocol";
import type { MemoryFact } from "../memory";
import { MockHost, MockRuntime } from "./index";
import { MEMORY_SEED } from "./seed";
import { OWN_SHOP } from "./shops";

const T0 = 1_800_000_000;

async function open(now: () => number = () => T0) {
  const host = new MockHost({ now });
  const rt = new MockRuntime(host);
  await rt.connect();
  const facts = async () => (await rt.request("memory.list", {})).facts;
  return { rt, host, facts };
}

const refusal = (p: Promise<unknown>) => p.then(() => null, (e: BridgeError) => e);

describe("the staged memory", () => {
  it("lists what the team knows in the canvas's words, each with where it came from", async () => {
    const { facts } = await open();
    const all = await facts();
    expect(all.map((f) => [f.text, f.status])).toEqual([
      ["Free shipping on orders over ฿800", "confirmed"],
      ["Reply warmly and end with ค่ะ", "confirmed"],
      ["Jasmine is the best seller", "confirmed"],
      ["A jasmine candle costs ฿118 to make", "confirmed"],
      ["Closed on Mondays", "waiting"],
    ]);
    const bySource = Object.fromEntries(all.map((f) => [f.text, f.source]));
    expect(bySource["Free shipping on orders over ฿800"]).toMatchObject({ kind: "document", name: "price list" });
    expect(bySource["Reply warmly and end with ค่ะ"]).toEqual({ kind: "edits", count: 12 });
    expect(bySource["Jasmine is the best seller"]).toEqual({ kind: "orders", days: 90 });
    expect(bySource["A jasmine candle costs ฿118 to make"]).toEqual({ kind: "connection", name: "Google Sheets", detail: "cost sheet" });
    expect(bySource["Closed on Mondays"]).toMatchObject({ kind: "customer" });
  });

  it("counts its times in seconds, whole and in the past, and the document's date is 3 November", async () => {
    const { facts } = await open();
    for (const f of await facts()) {
      expect(Number.isInteger(f.at), f.id).toBe(true);
      expect(f.at, f.id).toBeLessThanOrEqual(T0);
      expect(f.at, f.id).toBeGreaterThan(T0 - 365 * 86_400);
      expect(f.correctedAt, f.id).toBeNull();
    }
    const doc = (await facts())[0].source;
    if (doc.kind !== "document") throw new Error("the first fact comes from a document");
    // Noon UTC on 3 November 2026, in seconds: a day that reads the same in every time zone from -12 to +11.
    expect(doc.date).toBe(Date.UTC(2026, 10, 3, 12) / 1000);
  });

  it("stages the customer's fact as waiting, so it is not one of the confirmed facts", async () => {
    const { facts } = await open();
    const waiting = (await facts()).filter((f) => f.status === "waiting");
    expect(waiting.map((f) => f.text)).toEqual(["Closed on Mondays"]);
    expect(MEMORY_SEED.filter((s) => s.source.kind === "customer")).toHaveLength(1);
  });

  it("gives every fact its own id and hands out copies, so a caller cannot change what the runtime keeps", async () => {
    const { rt, facts } = await open();
    const first = await facts();
    expect(new Set(first.map((f) => f.id)).size).toBe(first.length);
    first[0].text = "changed by the caller";
    first.pop();
    expect((await facts())[0].text).toBe("Free shipping on orders over ฿800");
    expect(await facts()).toHaveLength(5);
    const { fact } = await rt.request("memory.remember", { shop: OWN_SHOP, text: "We ship on weekdays" });
    fact.text = "changed too";
    expect((await facts()).find((f) => f.id === fact.id)?.text).toBe("We ship on weekdays");
  });
});

describe("Remember: the owner's own fact", () => {
  it("adds it confirmed at once, from the owner, with the time it was said", async () => {
    const { rt, facts } = await open();
    const { fact } = await rt.request("memory.remember", { shop: OWN_SHOP, text: "  We ship on weekdays  " });
    expect(fact).toMatchObject({ text: "We ship on weekdays", status: "confirmed", source: { kind: "owner" }, at: T0, correctedAt: null });
    const all = await facts();
    expect(all).toHaveLength(6);
    expect(all.at(-1)).toEqual(fact);
  });

  it("never reuses an id, even after a Forget", async () => {
    const { rt } = await open();
    const a = (await rt.request("memory.remember", { shop: OWN_SHOP, text: "One" })).fact;
    await rt.request("memory.forget", { shop: OWN_SHOP, fact: a.id });
    const b = (await rt.request("memory.remember", { shop: OWN_SHOP, text: "Two" })).fact;
    expect(b.id).not.toBe(a.id);
  });

  it("refuses an empty text and one over 280 characters, and accepts exactly 280", async () => {
    const { rt, facts } = await open();
    for (const text of ["", "   ", "x".repeat(281)]) expect(await refusal(rt.request("memory.remember", { shop: OWN_SHOP, text })), JSON.stringify(text.slice(0, 5))).toMatchObject({ code: "invalid_text" });
    expect(await refusal(rt.request("memory.remember", { shop: OWN_SHOP, text: 42 as unknown as string }))).toMatchObject({ code: "invalid_text" });
    expect(await facts()).toHaveLength(5);
    await rt.request("memory.remember", { shop: OWN_SHOP, text: "x".repeat(280) });
    expect(await facts()).toHaveLength(6);
  });

  it("counts characters, not bytes: 280 Thai letters fit and 281 do not", async () => {
    const { rt } = await open();
    await rt.request("memory.remember", { shop: OWN_SHOP, text: "ก".repeat(280) });
    expect(await refusal(rt.request("memory.remember", { shop: OWN_SHOP, text: "ข".repeat(281) }))).toMatchObject({ code: "invalid_text" });
  });

  it("answers already_known for a fact it already has, however it is spaced or cased", async () => {
    const { rt, facts } = await open();
    const err = await refusal(rt.request("memory.remember", { shop: OWN_SHOP, text: "  free shipping on  orders OVER ฿800 " }));
    expect(err).toMatchObject({ code: "already_known" });
    expect(err?.message.trim()).not.toBe("");
    expect(await facts()).toHaveLength(5);
  });

  it("confirms a waiting fact instead of adding it twice when the owner says it themselves", async () => {
    const { rt, facts } = await open();
    const { fact } = await rt.request("memory.remember", { shop: OWN_SHOP, text: "closed on mondays" });
    expect(fact).toMatchObject({ id: (await facts()).find((f) => f.text === "Closed on Mondays")?.id, status: "confirmed" });
    const all = await facts();
    expect(all).toHaveLength(5);
    expect(all.filter((f) => f.status === "waiting")).toEqual([]);
    // The words stay as the customer's chat first made them: the owner confirmed them, they did not retype them.
    expect(fact.text).toBe("Closed on Mondays");
  });

  it("answers full at 200 facts, and says what to do", async () => {
    const { rt, facts } = await open();
    for (let i = (await facts()).length; i < 200; i++) await rt.request("memory.remember", { shop: OWN_SHOP, text: `Fact number ${i}` });
    expect(await facts()).toHaveLength(200);
    const err = await refusal(rt.request("memory.remember", { shop: OWN_SHOP, text: "One too many" }));
    expect(err).toMatchObject({ code: "full" });
    expect(await facts()).toHaveLength(200);
    // Forgetting one makes room again.
    await rt.request("memory.forget", { shop: OWN_SHOP, fact: (await facts())[0].id });
    await rt.request("memory.remember", { shop: OWN_SHOP, text: "One too many" });
    expect(await facts()).toHaveLength(200);
  });
});

describe("It's true: confirming a waiting fact", () => {
  it("makes it confirmed, keeps its id and where it came from, and moves its time", async () => {
    let now = T0;
    const { rt, facts } = await open(() => now);
    const waiting = (await facts()).find((f) => f.status === "waiting") as MemoryFact;
    now = T0 + 60;
    const { fact } = await rt.request("memory.confirm", { shop: OWN_SHOP, fact: waiting.id });
    expect(fact).toMatchObject({ id: waiting.id, text: waiting.text, status: "confirmed", source: waiting.source, at: T0 + 60, correctedAt: null });
    expect((await facts()).filter((f) => f.status === "waiting")).toEqual([]);
  });

  it("changes nothing for a fact that is already confirmed", async () => {
    let now = T0;
    const { rt, facts } = await open(() => now);
    const before = (await facts())[0];
    now = T0 + 60;
    const { fact } = await rt.request("memory.confirm", { shop: OWN_SHOP, fact: before.id });
    expect(fact).toEqual(before);
    expect(await facts()).toHaveLength(5);
  });

  it("refuses a fact it does not have, and a request that names none", async () => {
    const { rt } = await open();
    expect(await refusal(rt.request("memory.confirm", { shop: OWN_SHOP, fact: "f999" }))).toMatchObject({ code: "not_found" });
    expect(await refusal(rt.request("memory.confirm", { shop: OWN_SHOP } as { shop: string; fact: string }))).toMatchObject({ code: "bad_request" });
  });
});

describe("Correct: the owner's new words for a fact", () => {
  it("replaces the words, confirms the fact and marks it corrected, and the fact keeps its source", async () => {
    let now = T0;
    const { rt, facts } = await open(() => now);
    const before = (await facts())[0];
    now = T0 + 120;
    const { fact } = await rt.request("memory.correct", { shop: OWN_SHOP, fact: before.id, text: " Free shipping on orders over ฿1,000 " });
    expect(fact).toMatchObject({ id: before.id, text: "Free shipping on orders over ฿1,000", status: "confirmed", source: before.source, at: T0 + 120, correctedAt: T0 + 120 });
    expect((await facts()).find((f) => f.id === before.id)).toEqual(fact);
    expect(await facts()).toHaveLength(5);
  });

  it("confirms a waiting fact the owner corrects, since the words are now theirs", async () => {
    const { rt, facts } = await open();
    const waiting = (await facts()).find((f) => f.status === "waiting") as MemoryFact;
    const { fact } = await rt.request("memory.correct", { shop: OWN_SHOP, fact: waiting.id, text: "Closed on Mondays and public holidays" });
    expect(fact).toMatchObject({ status: "confirmed", correctedAt: T0, source: waiting.source });
  });

  it("lets the owner fix the case or spacing of a fact's own words", async () => {
    const { rt, facts } = await open();
    const f = (await facts())[2];
    const { fact } = await rt.request("memory.correct", { shop: OWN_SHOP, fact: f.id, text: "JASMINE IS THE BEST SELLER" });
    expect(fact.text).toBe("JASMINE IS THE BEST SELLER");
  });

  it("refuses words another fact already has, empty words, too-long words and a fact it does not have", async () => {
    const { rt, facts } = await open();
    const [a, b] = await facts();
    expect(await refusal(rt.request("memory.correct", { shop: OWN_SHOP, fact: a.id, text: ` ${b.text.toUpperCase()} ` }))).toMatchObject({ code: "already_known" });
    expect(await refusal(rt.request("memory.correct", { shop: OWN_SHOP, fact: a.id, text: "   " }))).toMatchObject({ code: "invalid_text" });
    expect(await refusal(rt.request("memory.correct", { shop: OWN_SHOP, fact: a.id, text: "x".repeat(281) }))).toMatchObject({ code: "invalid_text" });
    expect(await refusal(rt.request("memory.correct", { shop: OWN_SHOP, fact: "f999", text: "Anything" }))).toMatchObject({ code: "not_found" });
    expect(await refusal(rt.request("memory.correct", { shop: OWN_SHOP, text: "Anything" } as { shop: string; fact: string; text: string }))).toMatchObject({ code: "bad_request" });
    expect((await facts())[0].text).toBe(a.text);
  });
});

describe("Forget: nothing of the fact stays", () => {
  it("removes the fact and answers with only its id", async () => {
    const { rt, facts } = await open();
    const target = (await facts())[1];
    const answer = await rt.request("memory.forget", { shop: OWN_SHOP, fact: target.id });
    expect(answer).toEqual({ fact: target.id });
    expect(JSON.stringify(answer)).not.toContain("warmly");
    expect((await facts()).map((f) => f.id)).not.toContain(target.id);
    expect(await facts()).toHaveLength(4);
  });

  it("leaves no word of it in any later answer, whatever is asked next", async () => {
    const { rt, facts } = await open();
    const target = (await facts())[3];
    await rt.request("memory.forget", { shop: OWN_SHOP, fact: target.id });
    await rt.request("memory.remember", { shop: OWN_SHOP, text: "We ship on weekdays" });
    const waiting = (await facts()).find((f) => f.status === "waiting") as MemoryFact;
    await rt.request("memory.confirm", { shop: OWN_SHOP, fact: waiting.id });
    await rt.request("memory.correct", { shop: OWN_SHOP, fact: (await facts())[0].id, text: "Free shipping on orders over ฿900" });
    expect(JSON.stringify(await facts())).not.toContain("jasmine candle");
    const err = await refusal(rt.request("memory.confirm", { shop: OWN_SHOP, fact: target.id }));
    expect(err).toMatchObject({ code: "not_found" });
    expect(JSON.stringify(err)).not.toContain("jasmine");
  });

  it("forgets a waiting fact as readily as a confirmed one", async () => {
    const { rt, facts } = await open();
    const waiting = (await facts()).find((f) => f.status === "waiting") as MemoryFact;
    await rt.request("memory.forget", { shop: OWN_SHOP, fact: waiting.id });
    expect((await facts()).some((f) => f.status === "waiting")).toBe(false);
  });

  it("lets the owner say it again later, and that lifts the Forget", async () => {
    const { rt, facts } = await open();
    const target = (await facts())[2];
    await rt.request("memory.forget", { shop: OWN_SHOP, fact: target.id });
    const { fact } = await rt.request("memory.remember", { shop: OWN_SHOP, text: target.text });
    expect(fact).toMatchObject({ text: target.text, status: "confirmed", source: { kind: "owner" } });
    expect(fact.id).not.toBe(target.id);
  });

  it("refuses a fact it does not have, a fact already forgotten, and a request that names none", async () => {
    const { rt, facts } = await open();
    const target = (await facts())[0];
    await rt.request("memory.forget", { shop: OWN_SHOP, fact: target.id });
    expect(await refusal(rt.request("memory.forget", { shop: OWN_SHOP, fact: target.id }))).toMatchObject({ code: "not_found" });
    expect(await refusal(rt.request("memory.forget", { shop: OWN_SHOP, fact: "f999" }))).toMatchObject({ code: "not_found" });
    expect(await refusal(rt.request("memory.forget", { shop: OWN_SHOP } as { shop: string; fact: string }))).toMatchObject({ code: "bad_request" });
  });
});

describe("the memory of a runtime that starts again", () => {
  let host: MockHost;
  beforeEach(() => {
    host = new MockHost({ now: () => T0 });
  });

  it("goes back to the staged start, forgetting what the owner said and bringing back what they forgot", async () => {
    const rt = new MockRuntime(host);
    await rt.connect();
    await rt.request("memory.remember", { shop: OWN_SHOP, text: "We ship on weekdays" });
    await rt.request("memory.forget", { shop: OWN_SHOP, fact: "f1" });
    host.reset();
    const { facts } = await rt.request("memory.list", {});
    expect(facts.map((f) => f.text)).toEqual(MEMORY_SEED.map((s) => s.text));
    expect(facts.map((f) => f.id)).toEqual(["f1", "f2", "f3", "f4", "f5"]);
  });

  it("is shared by every client of the host, as the shop's memory is", async () => {
    const one = new MockRuntime(host);
    const two = new MockRuntime(host);
    await one.connect();
    await two.connect();
    await one.request("memory.remember", { shop: OWN_SHOP, text: "We ship on weekdays" });
    expect((await two.request("memory.list", {})).facts.map((f) => f.text)).toContain("We ship on weekdays");
  });
});
