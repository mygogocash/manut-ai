// The memory half of Customize, as rules without a page: which facts are the team's and which wait, how a fact's source is
// said, how the in-place questions of Correct and Forget move, and how a refusal reaches the owner. The runtime's own rules
// (what makes a fact wait, what Forget keeps) are @manut/shop-memory's and are tested through the runtime; these are only
// what the page decides on top of them.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MAX_FACTS, MAX_TEXT } from "@manut/shop-memory";
import { LANGS, setLang, t } from "../i18n";
import type { MemoryFact, MemorySource } from "../runtime/memory";
import { MockHost, MockRuntime } from "../runtime/mock";
import {
  correctionReady,
  groupFacts,
  MEMORY_START,
  memoryDo,
  memoryReduce,
  memoryStep,
  refusalText,
  rememberReady,
  sourceLine,
  withFact,
  withoutFact,
  type MemoryCalls,
  type MemoryUi,
} from "./memory";

/** Monday 23 November 2026, 12:00 in Bangkok. */
const NOW = Date.UTC(2026, 10, 23, 5, 0);
/** A day given as noon UTC, so that it reads the same in every time zone from -12 to +11. */
const day = (y: number, m: number, d: number) => Date.UTC(y, m - 1, d, 12) / 1000;

const fact = (id: string, text: string, status: MemoryFact["status"] = "confirmed", source: MemorySource = { kind: "owner" }, over: Partial<MemoryFact> = {}): MemoryFact => ({
  id,
  text,
  status,
  source,
  at: day(2026, 11, 1),
  correctedAt: null,
  ...over,
});

beforeEach(() => setLang("en"));
afterEach(() => setLang("en"));

describe("which facts are the team's and which wait", () => {
  it("puts the confirmed facts in what the team knows and the waiting ones apart, each in the order given", () => {
    const facts = [fact("f1", "A", "confirmed"), fact("f2", "B", "waiting"), fact("f3", "C", "confirmed"), fact("f4", "D", "waiting")];
    const { known, waiting } = groupFacts(facts);
    expect(known.map((f) => f.id)).toEqual(["f1", "f3"]);
    expect(waiting.map((f) => f.id)).toEqual(["f2", "f4"]);
  });

  it("never lists a waiting fact among the facts the team uses", () => {
    const { known } = groupFacts([fact("f1", "Closed on Mondays", "waiting")]);
    expect(known).toEqual([]);
  });

  it("keeps a fact whose status it does not know out of the facts the team uses, and waits on it instead", () => {
    const strange = fact("f9", "Something new", "archived" as MemoryFact["status"]);
    const { known, waiting } = groupFacts([strange, fact("f1", "A")]);
    expect(known.map((f) => f.id)).toEqual(["f1"]);
    expect(waiting.map((f) => f.id)).toEqual(["f9"]);
  });

  it("leaves no fact out and lists none twice", () => {
    const facts = [fact("f1", "A"), fact("f2", "B", "waiting"), fact("f3", "C")];
    const { known, waiting } = groupFacts(facts);
    expect([...known, ...waiting].map((f) => f.id).sort()).toEqual(["f1", "f2", "f3"]);
  });
});

describe("where a fact came from, in the canvas's words", () => {
  const line = (source: MemorySource, correctedAt: number | null = null) => sourceLine({ source, correctedAt }, NOW);

  it("says a document and its day: From your price list, 3 November", () => {
    expect(line({ kind: "document", name: "price list", date: day(2026, 11, 3) })).toBe("From your price list, 3 November");
  });

  it("adds the year when the document is not from this year", () => {
    expect(line({ kind: "document", name: "price list", date: day(2025, 11, 3) })).toBe("From your price list, 3 November 2025");
  });

  it("says how many of the owner's edits it was learned from: Learned from 12 of your edits", () => {
    expect(line({ kind: "edits", count: 12 })).toBe("Learned from 12 of your edits");
    expect(line({ kind: "edits", count: 1 })).toBe("Learned from your edit");
  });

  it("says how many days of orders: From the last 90 days of orders", () => {
    expect(line({ kind: "orders", days: 90 })).toBe("From the last 90 days of orders");
    expect(line({ kind: "orders", days: 1 })).toBe("From the last day of orders");
  });

  it("says what a connection gave and where: From your cost sheet in Google Sheets", () => {
    expect(line({ kind: "connection", name: "Google Sheets", detail: "cost sheet" })).toBe("From your cost sheet in Google Sheets");
  });

  it("says a customer said it in chat, and which customer or chat it was stays out of the line", () => {
    expect(line({ kind: "customer", chat: "line-chat-3" })).toBe("A customer said this in chat.");
    expect(line({ kind: "customer", chat: "line-chat-3" })).not.toContain("line-chat-3");
  });

  it("says the owner told it", () => {
    expect(line({ kind: "owner" })).toBe("You told Buddy");
  });

  it("says a corrected fact was corrected by the owner, and when, instead of where it first came from", () => {
    const corrected = line({ kind: "document", name: "price list", date: day(2026, 11, 3) }, day(2026, 11, 20));
    expect(corrected).toBe("Corrected by you, 20 November");
    expect(corrected).not.toContain("price list");
  });

  it("says nothing for a source it does not know, rather than a guess", () => {
    expect(line({ kind: "satellite" } as unknown as MemorySource)).toBe("");
  });

  it("says each in every language it is shown in, with the facts it names", () => {
    const sources: [MemorySource, string[]][] = [
      [{ kind: "document", name: "price list", date: day(2026, 11, 3) }, ["price list", "3"]],
      [{ kind: "edits", count: 12 }, ["12"]],
      [{ kind: "orders", days: 90 }, ["90"]],
      [{ kind: "connection", name: "Google Sheets", detail: "cost sheet" }, ["Google Sheets", "cost sheet"]],
      [{ kind: "customer", chat: "c" }, []],
      [{ kind: "owner" }, []],
    ];
    for (const l of LANGS) {
      setLang(l);
      for (const [source, names] of sources) {
        const said = line(source);
        expect(said.trim(), `${l} ${source.kind}`).not.toBe("");
        for (const n of names) expect(said, `${l} ${source.kind}`).toContain(n);
      }
      expect(line({ kind: "owner" }, day(2026, 11, 20)).trim(), `${l} corrected`).not.toBe("");
    }
  });
});

describe("the facts after one changes", () => {
  const list = [fact("f1", "A"), fact("f2", "B", "waiting"), fact("f3", "C")];

  it("replaces a fact where it stands, or adds one it did not have at the end", () => {
    expect(withFact(list, fact("f2", "B", "confirmed")).map((f) => [f.id, f.status])).toEqual([["f1", "confirmed"], ["f2", "confirmed"], ["f3", "confirmed"]]);
    expect(withFact(list, fact("f4", "D")).map((f) => f.id)).toEqual(["f1", "f2", "f3", "f4"]);
  });

  it("takes a forgotten fact out, and does not touch the list it was given", () => {
    expect(withoutFact(list, "f2").map((f) => f.id)).toEqual(["f1", "f3"]);
    expect(withoutFact(list, "nope")).toHaveLength(3);
    expect(list).toHaveLength(3);
  });
});

describe("Correct and Forget ask once more, in place, before anything is done", () => {
  const start = MEMORY_START;
  const act = (s: MemoryUi, ...as: Parameters<typeof memoryReduce>[1][]) => as.reduce(memoryReduce, s);

  it("starts with nothing asked, nothing typed and nothing on its way", () => {
    expect(start).toEqual({ ask: null, add: "", busy: false, error: null });
  });

  it("opens the editor for Correct with the fact's own words in it, and asks the runtime nothing yet", () => {
    const s = act(start, { type: "correct", fact: "f1", text: "Free shipping on orders over ฿800" });
    expect(s.ask).toEqual({ kind: "correct", fact: "f1", draft: "Free shipping on orders over ฿800" });
    expect(s.busy).toBe(false);
  });

  it("opens the question for Forget, and asks the runtime nothing yet", () => {
    const s = act(start, { type: "forget", fact: "f2" });
    expect(s.ask).toEqual({ kind: "forget", fact: "f2" });
    expect(s.busy).toBe(false);
  });

  it("asks about one fact at a time: opening another row's question closes the first", () => {
    const s = act(start, { type: "correct", fact: "f1", text: "A" }, { type: "forget", fact: "f2" });
    expect(s.ask).toEqual({ kind: "forget", fact: "f2" });
    expect(act(s, { type: "correct", fact: "f3", text: "C" }).ask).toEqual({ kind: "correct", fact: "f3", draft: "C" });
  });

  it("follows what is typed in the editor, and only in an editor that is open", () => {
    const editing = act(start, { type: "correct", fact: "f1", text: "A" }, { type: "draft", text: "A, corrected" });
    expect(editing.ask).toEqual({ kind: "correct", fact: "f1", draft: "A, corrected" });
    expect(act(start, { type: "draft", text: "stray" })).toEqual(start);
    expect(act(start, { type: "forget", fact: "f2" }, { type: "draft", text: "stray" }).ask).toEqual({ kind: "forget", fact: "f2" });
  });

  it("closes the question, and keeps the fact, when the owner says no", () => {
    expect(act(start, { type: "forget", fact: "f2" }, { type: "cancel" }).ask).toBeNull();
    expect(act(start, { type: "correct", fact: "f1", text: "A" }, { type: "cancel" }).ask).toBeNull();
  });

  it("holds the question while a request is on its way, so the owner cannot ask twice", () => {
    const busy = act(start, { type: "forget", fact: "f2" }, { type: "begin" });
    expect(busy.busy).toBe(true);
    expect(act(busy, { type: "cancel" })).toBe(busy);
    expect(act(busy, { type: "forget", fact: "f3" })).toBe(busy);
    expect(act(busy, { type: "correct", fact: "f3", text: "C" })).toBe(busy);
  });

  it("closes the question once the fact is forgotten or corrected, and says nothing of the words afterwards", () => {
    const forgot = act(start, { type: "forget", fact: "f2" }, { type: "begin" }, { type: "done", what: "forget" });
    const corrected = act(start, { type: "correct", fact: "f2", text: "B" }, { type: "begin" }, { type: "done", what: "correct" });
    for (const s of [forgot, corrected]) expect(s).toEqual({ ask: null, add: "", busy: false, error: null });
  });

  it("keeps the question open, and says why, when the runtime would not do it, so the owner can try again", () => {
    const s = act(start, { type: "forget", fact: "f2" }, { type: "begin" }, { type: "failed", message: "Not yet: Connected mode only reads for now." });
    expect(s).toEqual({ ask: { kind: "forget", fact: "f2" }, add: "", busy: false, error: "Not yet: Connected mode only reads for now." });
    expect(act(s, { type: "begin" }).error).toBeNull();
    expect(act(s, { type: "cancel" }).error).toBeNull();
  });

  it("leaves another row's open question alone when a fact is confirmed with It's true", () => {
    const s = act(start, { type: "forget", fact: "f1" }, { type: "begin" }, { type: "done", what: "confirm" });
    expect(s.ask).toEqual({ kind: "forget", fact: "f1" });
    expect(s.busy).toBe(false);
  });

  it("clears the Remember box once the fact is remembered, and keeps what was typed when it was refused", () => {
    const typed = act(start, { type: "add", text: "We ship on weekdays" });
    expect(typed.add).toBe("We ship on weekdays");
    expect(act(typed, { type: "begin" }, { type: "done", what: "remember" }).add).toBe("");
    expect(act(typed, { type: "begin" }, { type: "failed", message: "The team already knows this." }).add).toBe("We ship on weekdays");
  });

  it("forgets an old refusal as soon as the owner types again", () => {
    const failed = act(start, { type: "add", text: "x" }, { type: "begin" }, { type: "failed", message: "no" });
    expect(act(failed, { type: "add", text: "xy" }).error).toBeNull();
  });
});

describe("when Save and Remember are ready", () => {
  it("is ready to save a correction that says something new, and not before", () => {
    expect(correctionReady("  Free shipping over ฿900 ", "Free shipping on orders over ฿800")).toBe(true);
    expect(correctionReady("Free shipping on orders over ฿800", "Free shipping on orders over ฿800")).toBe(false);
    expect(correctionReady("  Free shipping on orders over ฿800  ", "Free shipping on orders over ฿800")).toBe(false);
    expect(correctionReady("   ", "Free shipping on orders over ฿800")).toBe(false);
    expect(correctionReady("", "x")).toBe(false);
  });

  it("lets a correction fix only the case or spacing of the words, which the runtime allows", () => {
    expect(correctionReady("JASMINE IS THE BEST SELLER", "Jasmine is the best seller")).toBe(true);
  });

  it("is ready to remember anything with a letter in it, and not an empty box", () => {
    expect(rememberReady("We ship on weekdays")).toBe(true);
    expect(rememberReady("   ")).toBe(false);
    expect(rememberReady("")).toBe(false);
  });
});

describe("how a refusal reaches the owner", () => {
  it("says each of the runtime's own reasons in the owner's words, with the limits from the package", () => {
    expect(refusalText("already_known", "The team already knows this.")).toBe("Your team already knows this.");
    expect(refusalText("invalid_text", "x")).toBe(`Say it in 1 to ${MAX_TEXT} characters.`);
    expect(refusalText("full", "x")).toBe(`Your team already holds ${MAX_FACTS} facts. Forget one first.`);
    expect(refusalText("not_found", "x")).toBe("That fact is gone already.");
  });

  it("shows the runtime's own words for any other refusal, such as the connected runtime's Not yet", () => {
    expect(refusalText("not_yet", "Not yet: Connected mode only reads for now.")).toBe("Not yet: Connected mode only reads for now.");
    expect(refusalText("internal", "boom")).toBe("boom");
  });

  it("says each of its own words in every language", () => {
    for (const l of LANGS) {
      setLang(l);
      for (const code of ["already_known", "invalid_text", "full", "not_found"]) expect(refusalText(code, "fallback").trim(), `${l} ${code}`).not.toBe("fallback");
    }
  });

  it("turns a call into its answer, or into words the page can show", async () => {
    expect(await memoryStep(async () => 7)).toEqual({ ok: true, value: 7 });
    const refused = await memoryStep(async () => {
      throw { code: "already_known", message: "The team already knows this." };
    });
    expect(refused).toEqual({ ok: false, code: "already_known", message: "Your team already knows this." });
    const notYet = await memoryStep(async () => {
      throw { code: "not_yet", message: "Not yet: Connected mode only reads for now." };
    });
    expect(notYet).toEqual({ ok: false, code: "not_yet", message: "Not yet: Connected mode only reads for now." });
    const broken = await memoryStep(async () => {
      throw new Error("the socket closed");
    });
    expect(broken).toEqual({ ok: false, code: "internal", message: "the socket closed" });
  });
});

describe("an action the owner takes, applied to the list the page shows", () => {
  /** The demo runtime, as the store's own actions reach it. */
  async function demo(): Promise<{ calls: MemoryCalls; facts: MemoryFact[] }> {
    const rt = new MockRuntime(new MockHost({ now: () => 1_800_000_000 }));
    await rt.connect();
    const calls: MemoryCalls = {
      memoryRemember: (text) => rt.request("memory.remember", { text }),
      memoryConfirm: (fact) => rt.request("memory.confirm", { fact }),
      memoryCorrect: (fact, text) => rt.request("memory.correct", { fact, text }),
      memoryForget: (fact) => rt.request("memory.forget", { fact }),
    };
    return { calls, facts: (await rt.request("memory.list", {})).facts };
  }
  const refuses = (code: string, message: string): MemoryCalls => {
    const no = async (): Promise<never> => {
      throw { code, message };
    };
    return { memoryRemember: no, memoryConfirm: no, memoryCorrect: no, memoryForget: no };
  };

  it("adds a fact the owner remembered at the end of the list, and ends the question", async () => {
    const { calls, facts } = await demo();
    const step = await memoryDo(calls, facts, { what: "remember", text: "We ship on weekdays" });
    expect(step.facts.map((f) => f.text)).toEqual([...facts.map((f) => f.text), "We ship on weekdays"]);
    expect(step.facts.at(-1)).toMatchObject({ status: "confirmed", source: { kind: "owner" } });
    expect(step.action).toEqual({ type: "done", what: "remember" });
  });

  it("keeps the list and says why when the runtime already knows it", async () => {
    const { calls, facts } = await demo();
    const step = await memoryDo(calls, facts, { what: "remember", text: "jasmine is the best seller" });
    expect(step.facts).toEqual(facts);
    expect(step.action).toEqual({ type: "failed", message: "Your team already knows this." });
  });

  it("confirms a waiting fact where it stands, so it joins what the team knows", async () => {
    const { calls, facts } = await demo();
    const waiting = facts.find((f) => f.status === "waiting") as MemoryFact;
    const step = await memoryDo(calls, facts, { what: "confirm", fact: waiting.id });
    expect(step.facts.map((f) => f.id)).toEqual(facts.map((f) => f.id));
    expect(step.facts.find((f) => f.id === waiting.id)?.status).toBe("confirmed");
    expect(groupFacts(step.facts).waiting).toEqual([]);
    expect(step.action).toEqual({ type: "done", what: "confirm" });
  });

  it("replaces a corrected fact's words where it stands, and marks it corrected", async () => {
    const { calls, facts } = await demo();
    const step = await memoryDo(calls, facts, { what: "correct", fact: facts[0].id, text: "Free shipping on orders over ฿900" });
    expect(step.facts.map((f) => f.id)).toEqual(facts.map((f) => f.id));
    expect(step.facts[0]).toMatchObject({ text: "Free shipping on orders over ฿900", status: "confirmed" });
    expect(step.facts[0].correctedAt).not.toBeNull();
    expect(step.action).toEqual({ type: "done", what: "correct" });
  });

  it("takes a forgotten fact out of the list, and leaves none of its words anywhere in what comes back", async () => {
    const { calls, facts } = await demo();
    const step = await memoryDo(calls, facts, { what: "forget", fact: facts[2].id });
    expect(step.facts.map((f) => f.id)).not.toContain(facts[2].id);
    expect(step.facts).toHaveLength(facts.length - 1);
    expect(JSON.stringify(step)).not.toContain("best seller");
    expect(step.action).toEqual({ type: "done", what: "forget" });
  });

  it("drops a fact the runtime says is gone, since the owner is looking at a list that has gone out of date", async () => {
    const { calls, facts } = await demo();
    for (const todo of [
      { what: "forget", fact: "f999" },
      { what: "confirm", fact: "f999" },
      { what: "correct", fact: "f999", text: "Anything" },
    ] as const) {
      const ghost = [...facts, { ...facts[0], id: "f999", text: "A fact that is already gone" }];
      const step = await memoryDo(calls, ghost, todo);
      expect(step.facts.map((f) => f.id), todo.what).toEqual(facts.map((f) => f.id));
      expect(JSON.stringify(step), todo.what).not.toContain("already gone");
      expect(step.action, todo.what).toEqual({ type: "failed", message: "That fact is gone already." });
    }
  });

  it("keeps the whole list, and says the runtime's own words, when the runtime says not yet", async () => {
    const { facts } = await demo();
    const calls = refuses("not_yet", "Not yet: Connected mode only reads for now.");
    for (const todo of [
      { what: "remember", text: "We ship on weekdays" },
      { what: "confirm", fact: facts[4].id },
      { what: "correct", fact: facts[0].id, text: "Other words" },
      { what: "forget", fact: facts[0].id },
    ] as const) {
      const step = await memoryDo(calls, facts, todo);
      expect(step.facts, todo.what).toEqual(facts);
      expect(step.action, todo.what).toEqual({ type: "failed", message: "Not yet: Connected mode only reads for now." });
    }
  });

  it("does not change the list it was given", async () => {
    const { calls, facts } = await demo();
    const before = JSON.stringify(facts);
    await memoryDo(calls, facts, { what: "forget", fact: facts[0].id });
    await memoryDo(calls, facts, { what: "remember", text: "One more" });
    expect(JSON.stringify(facts)).toBe(before);
  });
});
