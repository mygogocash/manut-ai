// Customize: memory and routines (the design canvas's Brain.dc.html), drawn with react-dom/server from what the demo runtime
// says of what the team knows and of its routines (started at 10:00 on Sunday 22 November, Bangkok time). The views are drawn
// from the data they are given, as the other menu pages are, so each state of the page can be seen: loading, unavailable,
// empty and full. A string render leaves the handlers out, so the keys of the forms are read from what the views draw: they use
// no hooks, so a test can call them as plain functions. The last tests run the page's own steps against the demo runtime and
// the connected one's refusals.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToString } from "react-dom/server";
import { LANGS, setLang, t } from "../i18n";
import type { MemoryFact } from "../runtime/memory";
import type { RoutineRow } from "../runtime/routines";
import { MockHost, MockRuntime } from "../runtime/mock";
import { CustomizeView, type MemoryPaneProps, type RoutinesPaneProps } from "./CustomizePage";
import { LOADING, type Load } from "./load";
import { createStore } from "../state/store";
import { MEMORY_START, memoryDo, memoryReduce, type MemoryUi } from "./memory";
import { FORM_START, formProblem, ROUTINES_START, routineDo, routinesReduce, type RoutineForm, type RoutinesUi } from "./routines";

const NOW = Date.UTC(2026, 10, 22, 3, 0);
const BOOT = NOW / 1000;

const words = (html: string) =>
  html
    .replace(/<[^>]*>/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&gt;/g, ">")
    .replace(/&lt;/g, "<")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");
/** What follows the opening tag that carries `testid`, up to the next one that carries `until` (or the end). */
const between = (html: string, testid: string, until?: string) => {
  const from = html.indexOf(`data-testid="${testid}"`);
  if (from < 0) return "";
  const rest = html.slice(from);
  const to = until ? rest.indexOf(`data-testid="${until}"`) : -1;
  return to < 0 ? rest : rest.slice(0, to);
};
const count = (html: string, needle: string) => html.split(needle).length - 1;
const noop = () => {};
const ready = <T,>(value: T): Load<T> => ({ kind: "ready", value });

async function demo() {
  const rt = new MockRuntime(new MockHost({ now: () => BOOT }));
  await rt.connect();
  return rt;
}
const factsOf = async (rt: MockRuntime) => (await rt.request("memory.list", {})).facts;
const routinesOf = async (rt: MockRuntime) => (await rt.request("routine.list", {})).routines;

const memoryPane = (state: Load<MemoryFact[]>, over: Partial<MemoryPaneProps> = {}, ui: Partial<MemoryUi> = {}): MemoryPaneProps => ({
  state,
  ui: { ...MEMORY_START, ...ui },
  nowMs: NOW,
  dispatch: noop,
  onRemember: noop,
  onConfirm: noop,
  onCorrect: noop,
  onForget: noop,
  ...over,
});
const routinesPane = (state: Load<RoutineRow[]>, over: Partial<RoutinesPaneProps> = {}, ui: Partial<RoutinesUi> = {}): RoutinesPaneProps => ({
  state,
  ui: { ...ROUTINES_START, ...ui },
  nowMs: NOW,
  dispatch: noop,
  onAdd: noop,
  onSwitch: noop,
  ...over,
});
const form = (over: Partial<RoutineForm> = {}): RoutineForm => ({ ...FORM_START, weekdays: [...FORM_START.weekdays], ...over });

function draw(memory: MemoryPaneProps, routines: RoutinesPaneProps, entries: { automations?: { count: number; open: () => void }; plugins?: { open: () => void } } = {}) {
  return renderToString(<CustomizeView memory={memory} routines={routines} {...entries} />);
}
async function drawDemo(memoryUi: Partial<MemoryUi> = {}, routinesUi: Partial<RoutinesUi> = {}, rt?: MockRuntime) {
  const r = rt ?? (await demo());
  return draw(memoryPane(ready(await factsOf(r)), {}, memoryUi), routinesPane(ready(await routinesOf(r)), {}, routinesUi));
}

beforeEach(() => setLang("en"));
afterEach(() => setLang("en"));

describe("the board, as the canvas draws it, on the demo runtime", () => {
  it("is the Customize page, and says that the owner can read, correct and remove all of it", async () => {
    const html = await drawDemo();
    expect(html).toContain('data-testid="page-customize"');
    expect(words(html)).toContain("Customize");
    expect(words(html)).toContain("You can read, correct and remove all of it");
  });

  it("lists what the team knows with where each fact came from, each with Correct and Forget", async () => {
    const html = await drawDemo();
    const known = words(between(html, "memory-known", "memory-waiting"));
    expect(known).toContain("What your team knows");
    expect(known).toContain("Where it came from");
    expect(known).toContain("Free shipping on orders over ฿800 From your price list, 3 November");
    expect(known).toContain("Reply warmly and end with ค่ะ Learned from 12 of your edits");
    expect(known).toContain("Jasmine is the best seller From the last 90 days of orders");
    expect(known).toContain("A jasmine candle costs ฿118 to make From your cost sheet in Google Sheets");
    expect(count(between(html, "memory-known", "memory-waiting"), 'data-testid="fact"')).toBe(4);
    expect(count(between(html, "memory-known", "memory-waiting"), 'data-testid="fact-correct"')).toBe(4);
    expect(count(between(html, "memory-known", "memory-waiting"), 'data-testid="fact-forget"')).toBe(4);
  });

  it("keeps the order the runtime gave", async () => {
    const text = words(await drawDemo());
    const order = ["Free shipping", "Reply warmly", "Jasmine is the best", "A jasmine candle"].map((s) => text.indexOf(s));
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(order.every((i) => i >= 0)).toBe(true);
  });

  it("sets the Thai in a fact in its own language, so that it is drawn in a Thai font", async () => {
    const html = await drawDemo();
    expect(html).toContain('<span lang="th">ค่ะ</span>');
    expect(html).toMatch(/Reply warmly and end with <span lang="th">ค่ะ<\/span>/);
  });

  it("lists what waits for the owner's OK, not used until they confirm, with It's true and Forget", async () => {
    const html = await drawDemo();
    const waiting = words(between(html, "memory-waiting", "remember-form"));
    expect(waiting).toContain("Waiting for your OK");
    expect(waiting).toContain("Not used until you confirm");
    expect(waiting).toContain("Closed on Mondays");
    expect(waiting).toContain("A customer said this in chat.");
    expect(waiting).toContain("Not confirmed");
    expect(waiting).toContain("It's true");
    expect(count(between(html, "memory-waiting", "remember-form"), 'data-testid="fact-forget"')).toBe(1);
    expect(count(html, 'data-testid="fact-confirm"')).toBe(1);
  });

  it("has a box to tell Buddy something to remember, labelled, with a Remember button", async () => {
    const html = await drawDemo();
    expect(html).toMatch(/<label[^>]*for="remember"[^>]*>Tell Buddy something to remember<\/label>/);
    expect(html).toMatch(/<input[^>]*id="remember"[^>]*placeholder="Tell Buddy something to remember"/);
    expect(html).toMatch(/<button[^>]*type="submit"[^>]*data-testid="remember-submit"[^>]*>Remember<\/button>/);
  });

  it("lists the five routines, each as its timing and what it does, and which ask first", async () => {
    const html = await drawDemo();
    const side = words(between(html, "routines"));
    expect(side).toContain("Routines");
    expect(side).toContain("New routine");
    expect(side).toContain("What your team does on its own schedule.");
    expect(side).toContain("Every day at 08:00 Morning brief");
    expect(side).toContain("Every Monday at 08:00 Weekly growth brief");
    expect(side).toContain("When stock drops under 5 Tell me and draft a restock order");
    expect(side).toContain("On the last day of the month at 18:00 Send the books to FlowAccount. Asks first.");
    expect(side).toContain("Every night after 21:00 Answer order-status questions. Asks first.");
    expect(count(html, 'data-testid="routine"')).toBe(5);
    // only the two that send or reply say so
    expect(count(side, "Asks first.")).toBe(2);
  });

  it("says each routine's next run quietly, and none for the one that waits on stock", async () => {
    const side = words(between(await drawDemo(), "routines"));
    expect(side).toContain("Morning brief Next: Monday 08:00");
    expect(side).toContain("Weekly growth brief Next: Monday 08:00");
    expect(side).toContain("Send the books to FlowAccount. Asks first. Next: 30 November 18:00");
    expect(side).toContain("Answer order-status questions. Asks first. Next: Today 21:00");
    expect(side).not.toMatch(/draft a restock order Next:/);
    expect(count(side, "Next:")).toBe(4);
  });

  it("shows each routine's switch on, named for the routine", async () => {
    const html = await drawDemo();
    expect(count(html, 'role="switch"')).toBe(5);
    expect(count(html, 'aria-checked="true"')).toBe(5);
    expect(html).toMatch(/<button[^>]*role="switch"[^>]*aria-label="Morning brief"/);
    expect(html).toMatch(/aria-label="Answer order-status questions"/);
  });

  it("says a new routine in your own words needs a model, so it says not yet", async () => {
    const text = words(between(await drawDemo(), "routines-words"));
    expect(text).toContain("Say a new one in your own words, for example: every Friday, post where tomorrow's market stall will be.");
    expect(text).toContain("Not yet");
    expect(text).toContain("needs a model");
  });
});

describe("a waiting fact is never shown as used", () => {
  it("keeps what a customer said out of what the team knows, and in the part that waits", async () => {
    const html = await drawDemo();
    expect(words(between(html, "memory-known", "memory-waiting"))).not.toContain("Closed on Mondays");
    expect(words(between(html, "memory-waiting", "remember-form"))).toContain("Closed on Mondays");
  });

  it("says nothing that sounds like use beside it", async () => {
    const waiting = words(between(await drawDemo(), "memory-waiting", "remember-form"));
    expect(waiting).not.toMatch(/can use this now|is used|in use|the team uses/i);
    expect(waiting).toContain("Not used until you confirm");
  });

  it("keeps a fact whose status it does not know out of what the team knows too", async () => {
    const rt = await demo();
    const facts = await factsOf(rt);
    const strange = [...facts, { ...facts[0], id: "f9", text: "Something new", status: "archived" as MemoryFact["status"] }];
    const html = draw(memoryPane(ready(strange)), routinesPane(ready([])));
    expect(words(between(html, "memory-known", "memory-waiting"))).not.toContain("Something new");
    expect(words(between(html, "memory-waiting", "remember-form"))).toContain("Something new");
  });

  it("moves a fact into what the team knows once the owner says It's true, and drops the part that waited", async () => {
    const rt = await demo();
    const waiting = (await factsOf(rt)).find((f) => f.status === "waiting") as MemoryFact;
    await rt.request("memory.confirm", { fact: waiting.id });
    const html = await drawDemo({}, {}, rt);
    expect(words(between(html, "memory-known", "remember-form"))).toContain("Closed on Mondays");
    expect(html).not.toContain('data-testid="memory-waiting"');
    expect(html).not.toContain('data-testid="fact-confirm"');
    expect(words(html)).not.toContain("Not confirmed");
  });

  it("shows no part that waits when nothing waits", async () => {
    const rt = await demo();
    const confirmed = (await factsOf(rt)).filter((f) => f.status === "confirmed");
    const html = draw(memoryPane(ready(confirmed)), routinesPane(ready([])));
    expect(html).not.toContain('data-testid="memory-waiting"');
    expect(words(html)).not.toContain("Waiting for your OK");
  });
});

describe("Forget leaves none of the words", () => {
  it("draws no trace of a forgotten fact once the runtime has dropped it, in the text, a label or an open question", async () => {
    const rt = await demo();
    const target = (await factsOf(rt))[2];
    expect(target.text).toBe("Jasmine is the best seller");
    await rt.request("memory.forget", { fact: target.id });
    // The question about it was open; a page that kept it would draw the fact's words once more.
    const html = await drawDemo({ ask: null }, {}, rt);
    expect(html).not.toContain("Jasmine is the best seller");
    expect(html).not.toContain("best seller");
    expect(html).not.toContain(target.id === "f1" ? "never" : `data-fact="${target.id}"`);
    expect(count(html, 'data-testid="fact"')).toBe(3);
  });

  it("forgets a waiting fact as readily: nothing of it is drawn, and the part that waited goes", async () => {
    const rt = await demo();
    const waiting = (await factsOf(rt)).find((f) => f.status === "waiting") as MemoryFact;
    await rt.request("memory.forget", { fact: waiting.id });
    const html = await drawDemo({}, {}, rt);
    expect(html).not.toContain("Closed on Mondays");
    expect(html).not.toContain('data-testid="memory-waiting"');
  });

  it("draws no note of the forgetting either: no undo, no 'forgot ...' line with the words", async () => {
    const rt = await demo();
    await rt.request("memory.forget", { fact: (await factsOf(rt))[0].id });
    const text = words(await drawDemo({}, {}, rt));
    expect(text).not.toContain("Free shipping");
    expect(text).not.toMatch(/undo/i);
  });
});

describe("Correct and Forget ask once more, in place", () => {
  it("draws no question and no editor until the owner asks", async () => {
    const html = await drawDemo();
    for (const id of ["correct-input", "correct-save", "forget-question", "forget-yes"]) expect(html, id).not.toContain(`data-testid="${id}"`);
  });

  it("turns the row the owner chose into an editor with the fact's words in it, Save and Cancel, and leaves the others alone", async () => {
    const rt = await demo();
    const [first] = await factsOf(rt);
    const html = await drawDemo({ ask: { kind: "correct", fact: first.id, draft: first.text } }, {}, rt);
    expect(count(html, 'data-testid="correct-input"')).toBe(1);
    expect(html).toMatch(/<input[^>]*data-testid="correct-input"[^>]*value="Free shipping on orders over ฿800"|value="Free shipping on orders over ฿800"[^>]*data-testid="correct-input"/);
    expect(html).toMatch(/<label[^>]*>New words for this fact<\/label>/);
    expect(html).toMatch(/<button[^>]*data-testid="correct-save"[^>]*>Save<\/button>/);
    expect(html).toMatch(/<button[^>]*data-testid="correct-cancel"[^>]*>Cancel<\/button>/);
    // the other three known facts and the waiting one still show their own Correct and Forget
    expect(count(html, 'data-testid="fact-correct"')).toBe(3);
    expect(count(html, 'data-testid="fact-forget"')).toBe(4);
    expect(html).not.toContain('data-testid="forget-question"');
  });

  it("holds Save back until the words say something new", async () => {
    const rt = await demo();
    const [first] = await factsOf(rt);
    const same = await drawDemo({ ask: { kind: "correct", fact: first.id, draft: first.text } }, {}, rt);
    expect(same).toMatch(/<button[^>]*disabled=""[^>]*data-testid="correct-save"|<button[^>]*data-testid="correct-save"[^>]*disabled=""/);
    const changed = await drawDemo({ ask: { kind: "correct", fact: first.id, draft: "Free shipping on orders over ฿900" } }, {}, rt);
    expect(changed).not.toMatch(/disabled=""[^>]*data-testid="correct-save"|data-testid="correct-save"[^>]*disabled=""/);
  });

  it("asks Forget as a question in the row, naming what is at stake and who learns it again, with the safe answer first", async () => {
    const rt = await demo();
    const target = (await factsOf(rt))[1];
    const html = await drawDemo({ ask: { kind: "forget", fact: target.id } }, {}, rt);
    const q = words(between(html, "forget-question"));
    expect(q).toContain("Forget this?");
    expect(q).toContain("Your team stops using it and does not learn it again unless you tell it yourself.");
    expect(html).toMatch(/<button[^>]*data-testid="forget-yes"[^>]*>Forget it<\/button>/);
    expect(html).toMatch(/<button[^>]*data-testid="forget-keep"[^>]*>Keep it<\/button>/);
    // the fact is still there, with its words, until the owner answers
    expect(words(html)).toContain("Reply warmly and end with ค่ะ");
    expect(count(html, 'data-testid="forget-question"')).toBe(1);
    expect(count(html, 'data-testid="fact-forget"')).toBe(4);
  });

  it("asks it of a waiting fact too, in its own row", async () => {
    const rt = await demo();
    const waiting = (await factsOf(rt)).find((f) => f.status === "waiting") as MemoryFact;
    const html = await drawDemo({ ask: { kind: "forget", fact: waiting.id } }, {}, rt);
    expect(words(between(html, "memory-waiting", "remember-form"))).toContain("Forget this?");
    expect(count(html, 'data-testid="forget-question"')).toBe(1);
  });

  it("holds both answers while a request is on its way", async () => {
    const rt = await demo();
    const target = (await factsOf(rt))[1];
    const html = await drawDemo({ ask: { kind: "forget", fact: target.id }, busy: true }, {}, rt);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*data-testid="forget-yes"|<button[^>]*data-testid="forget-yes"[^>]*disabled=""/);
  });

  it("says why the last request did not go, and keeps the question open to try again", async () => {
    const rt = await demo();
    const target = (await factsOf(rt))[1];
    const html = await drawDemo({ ask: { kind: "forget", fact: target.id }, error: "Not yet: Connected mode only reads for now." }, {}, rt);
    expect(html).toMatch(/role="alert"[^>]*data-testid="memory-error"|data-testid="memory-error"[^>]*role="alert"/);
    expect(words(between(html, "memory-error"))).toContain("Not yet: Connected mode only reads for now.");
    expect(html).toContain('data-testid="forget-question"');
  });

  it("holds the Remember button while the box is empty or a request is on its way", async () => {
    const empty = await drawDemo();
    expect(empty).toMatch(/<button[^>]*disabled=""[^>]*data-testid="remember-submit"|<button[^>]*data-testid="remember-submit"[^>]*disabled=""/);
    const typed = await drawDemo({ add: "We ship on weekdays" });
    expect(typed).not.toMatch(/disabled=""[^>]*data-testid="remember-submit"|data-testid="remember-submit"[^>]*disabled=""/);
    expect(typed).toMatch(/value="We ship on weekdays"/);
    const busy = await drawDemo({ add: "We ship on weekdays", busy: true });
    expect(busy).toMatch(/disabled=""[^>]*data-testid="remember-submit"|data-testid="remember-submit"[^>]*disabled=""/);
  });
});

describe("a corrected fact", () => {
  it("says it was corrected, and when, instead of where it first came from", async () => {
    const rt = await demo();
    const [first] = await factsOf(rt);
    await rt.request("memory.correct", { fact: first.id, text: "Free shipping on orders over ฿1,000" });
    const known = words(between(await drawDemo({}, {}, rt), "memory-known", "memory-waiting"));
    expect(known).toContain("Free shipping on orders over ฿1,000 Corrected by you, 22 November");
    expect(known).not.toContain("From your price list");
  });
});

describe("the memory when it cannot be shown as a list", () => {
  it("waits with the band drawn, its words quiet and the box to type in held back, while the facts are being read", () => {
    const html = draw(memoryPane(LOADING), routinesPane(ready([])));
    const memory = between(html, "memory-pane", "routines");
    expect(memory).toContain('aria-busy="true"');
    expect(words(memory)).toContain("What your team knows");
    expect(words(between(html, "memory-loading"))).toContain("Loading what your team knows…");
    expect(html).not.toContain('data-testid="remember-form"');
    expect(html).not.toContain('data-testid="fact"');
  });

  it("says in the runtime's own words that it is not available, as the connected runtime's not yet is, and offers no box", () => {
    const html = draw(memoryPane({ kind: "unavailable", code: "not_yet", message: "Not yet: Connected mode cannot show this for now. It comes in a later version." }), routinesPane(ready([])));
    expect(words(between(html, "memory-unavailable"))).toContain("Not yet: Connected mode cannot show this for now. It comes in a later version.");
    expect(html).toMatch(/role="status"[^>]*data-testid="memory-unavailable"|data-testid="memory-unavailable"[^>]*role="status"/);
    expect(html).not.toContain('data-testid="remember-form"');
    expect(html).not.toContain('data-testid="fact"');
    expect(words(html)).toContain("What your team knows");
  });

  it("says in the canvas's words that there is nothing remembered yet, and still offers the box", () => {
    const html = draw(memoryPane(ready([])), routinesPane(ready([])));
    expect(words(between(html, "customize-empty"))).toContain("Nothing remembered yet");
    expect(words(between(html, "customize-empty"))).toContain("What your team learns about your shop shows here.");
    expect(html).toContain('data-testid="remember-form"');
    expect(html).not.toContain('data-testid="fact"');
  });
});

describe("the routines when they cannot be shown as a list", () => {
  it("waits with its title and the button held back, while the routines are being read", () => {
    const html = draw(memoryPane(ready([])), routinesPane(LOADING));
    expect(between(html, "routines")).toContain('aria-busy="true"');
    expect(words(between(html, "routines-loading"))).toContain("Loading routines…");
    expect(words(between(html, "routines"))).toContain("Routines");
    expect(html).not.toContain('data-testid="routine"');
    expect(html).not.toContain('data-testid="routine-new"');
  });

  it("says in the runtime's own words that they are not available, and offers no New routine", () => {
    const html = draw(memoryPane(ready([])), routinesPane({ kind: "unavailable", code: "offline", message: "Offline: the Manut AI API cannot be reached." }));
    expect(words(between(html, "routines-unavailable"))).toContain("Offline: the Manut AI API cannot be reached.");
    expect(html).not.toContain('data-testid="routine-new"');
    expect(html).not.toContain('data-testid="routine"');
  });

  it("says there are no routines yet, and still offers New routine", () => {
    const html = draw(memoryPane(ready([])), routinesPane(ready([])));
    expect(words(between(html, "routines-empty"))).toContain("No routines yet. Add one with New routine.");
    expect(html).toContain('data-testid="routine-new"');
  });

  it("shows each half on its own, since the connected runtime shows routines but not memory", () => {
    const rows: RoutineRow[] = [{ id: "s1", name: "Morning brief", when: "Every Monday at 08:30", action: null, asksFirst: null, enabled: true, next: BOOT + 3600, timeZone: "Asia/Bangkok" }];
    const html = draw(memoryPane({ kind: "unavailable", code: "not_yet", message: "Not yet: nothing to show." }), routinesPane(ready(rows)));
    expect(html).toContain('data-testid="memory-unavailable"');
    expect(words(between(html, "routines"))).toContain("Every Monday at 08:30 Morning brief Next: Today 11:00");
  });
});

describe("a routine as the runtime says it", () => {
  const base: RoutineRow = { id: "r1", name: "Morning brief", when: "Every day at 08:00", action: "brief", asksFirst: false, enabled: true, next: BOOT + 86_400 - 7200, timeZone: "Asia/Bangkok" };
  const one = (over: Partial<RoutineRow>) => draw(memoryPane(ready([])), routinesPane(ready([{ ...base, ...over }])));

  it("shows a paused routine as paused, with its switch off and no next run", () => {
    const html = one({ enabled: false, next: null });
    expect(html).toMatch(/role="switch"[^>]*aria-checked="false"/);
    const text = words(between(html, "routine"));
    expect(text).toContain("Paused");
    expect(text).not.toContain("Next:");
  });

  it("shows no Asks first when the runtime cannot say whether a routine asks, and no claim that it does not", () => {
    const text = words(between(one({ asksFirst: null, action: null }), "routine"));
    expect(text).toContain("Morning brief");
    expect(text).not.toMatch(/ask/i);
  });

  it("holds the switches while a request is on its way", () => {
    const html = draw(memoryPane(ready([])), routinesPane(ready([base]), {}, { switching: "r1" }));
    expect(html).toMatch(/<button[^>]*role="switch"[^>]*disabled=""|<button[^>]*disabled=""[^>]*role="switch"/);
  });

  it("says why the last switch did not go, in the runtime's own words", () => {
    const html = draw(memoryPane(ready([])), routinesPane(ready([base]), {}, { error: "Not yet: Connected mode only reads for now." }));
    expect(html).toMatch(/role="alert"[^>]*data-testid="routines-error"|data-testid="routines-error"[^>]*role="alert"/);
    expect(words(between(html, "routines-error"))).toContain("Not yet: Connected mode only reads for now.");
  });

  it("is not tied to the one time zone: the next run is said in the routine's own", () => {
    const html = one({ timeZone: "UTC", next: Date.UTC(2026, 10, 22, 23, 0) / 1000 });
    expect(words(html)).toContain("Next: Today 23:00");
  });
});

describe("New routine opens a short form", () => {
  const open = (f: Partial<RoutineForm> = {}, ui: Partial<RoutinesUi> = {}) =>
    draw(memoryPane(ready([])), routinesPane(ready([]), {}, { form: form(f), ...ui }));

  it("is closed until the owner asks, and opens in the routines column", () => {
    expect(draw(memoryPane(ready([])), routinesPane(ready([])))).not.toContain('data-testid="routine-form"');
    const html = open();
    expect(between(html, "routines")).toContain('data-testid="routine-form"');
  });

  it("asks what it does, what kind of work, when and at what time, each field labelled", () => {
    const html = open();
    for (const label of ["What it does", "What kind of work", "When", "At what time"]) expect(html, label).toMatch(new RegExp(`<label[^>]*>${label}</label>|<legend[^>]*>${label}</legend>`));
    expect(html).toMatch(/<input[^>]*id="routine-name"[^>]*placeholder="For example: Tell me when a parcel is late"/);
    expect(html).toMatch(/<input[^>]*type="time"[^>]*id="routine-at"[^>]*value="08:00"|<input[^>]*id="routine-at"[^>]*type="time"[^>]*value="08:00"/);
  });

  it("offers the four kinds of work and nothing about payment, refunds or deletion", () => {
    const html = open();
    const kinds = between(html, "routine-kind", "routine-when");
    expect([...kinds.matchAll(/<option[^>]*value="(\w+)"/g)].map((m) => m[1])).toEqual(["brief", "draft", "reply", "send"]);
    expect(words(kinds)).toContain("Brief me");
    expect(words(kinds)).toContain("Reply to customers");
    expect(html).not.toMatch(/value="(pay|delete|refund)"/);
    expect(words(html)).not.toMatch(/refund|payment|\bpay\b|delete/i);
  });

  it("offers the five times of the canvas", () => {
    const whens = between(open(), "routine-when", "routine-at");
    expect([...whens.matchAll(/<option[^>]*value="(\w+)"/g)].map((m) => m[1])).toEqual(["daily", "weekly", "monthly", "window", "stock"]);
    expect(words(whens)).toContain("When stock drops under a number");
  });

  it("shows Asks first for a kind that replies or sends, and not for a brief or a draft", () => {
    for (const action of ["reply", "send"] as const) {
      const html = open({ action });
      expect(words(between(html, "routine-asks")), action).toContain("This one always asks you first.");
      expect(words(between(html, "routine-asks")), action).toContain("Asks first.");
    }
    for (const action of ["brief", "draft"] as const) expect(open({ action }), action).not.toContain('data-testid="routine-asks"');
  });

  it("asks for the days of the week, Monday first, with the chosen ones checked", () => {
    const html = open({ when: "weekly", weekdays: [1, 4] });
    const days = between(html, "routine-days");
    expect(count(days, 'type="checkbox"')).toBe(7);
    expect(count(days, 'checked=""')).toBe(2);
    expect(words(days)).toMatch(/Mon .*Tue .*Wed .*Thu .*Fri .*Sat .*Sun/);
    expect(html).toMatch(/<input[^>]*type="checkbox"[^>]*value="1"[^>]*checked=""|<input[^>]*checked=""[^>]*value="1"/);
  });

  it("asks for a day of the month, 1 to 28 or the last day", () => {
    const day = between(open({ when: "monthly", day: "last" }), "routine-day", "routine-at");
    expect([...day.matchAll(/<option[^>]*value="(\w+)"/g)].map((m) => m[1])).toEqual([...Array.from({ length: 28 }, (_, i) => String(i + 1)), "last"]);
    expect(day).toMatch(/<option[^>]*value="last"[^>]*selected=""|<option[^>]*selected=""[^>]*value="last"/);
    expect(words(day)).toContain("The last day of the month");
  });

  it("asks for the two times of a window, and for a stock number from 1, and not for a time of day then", () => {
    const window = open({ when: "window", from: "21:00", to: "08:00" });
    expect(window).toMatch(/id="routine-from"[^>]*value="21:00"|value="21:00"[^>]*id="routine-from"/);
    expect(window).toMatch(/id="routine-to"[^>]*value="08:00"|value="08:00"[^>]*id="routine-to"/);
    expect(window).not.toContain('id="routine-at"');
    const stock = open({ when: "stock", threshold: "5" });
    expect(stock).toMatch(/<input[^>]*type="number"[^>]*min="1"|<input[^>]*min="1"[^>]*type="number"/);
    expect(stock).toMatch(/id="routine-threshold"[^>]*value="5"|value="5"[^>]*id="routine-threshold"/);
    expect(stock).not.toContain('id="routine-at"');
  });

  it("says what is wrong with the form, in words, when the owner tries to add it", () => {
    const html = open({ name: "" }, { problem: "invalid_name" });
    expect(html).toMatch(/role="alert"[^>]*data-testid="routine-problem"|data-testid="routine-problem"[^>]*role="alert"/);
    expect(words(between(html, "routine-problem"))).toContain("Say what it does in a short sentence.");
    expect(open()).not.toContain('data-testid="routine-problem"');
  });

  it("holds the Add button while a routine is being saved, and says why a routine was not added", () => {
    const saving = open({ name: "Remind me" }, { saving: true });
    expect(saving).toMatch(/<button[^>]*disabled=""[^>]*data-testid="routine-add"|<button[^>]*data-testid="routine-add"[^>]*disabled=""/);
    const refused = open({ name: "Remind me" }, { error: "Not yet: Connected mode only reads for now." });
    expect(words(between(refused, "routines-error"))).toContain("Not yet: Connected mode only reads for now.");
    expect(refused).toContain('data-testid="routine-form"');
  });

  it("has Add routine and Cancel, and Cancel closes it without adding", () => {
    const html = open();
    expect(html).toMatch(/<button[^>]*type="submit"[^>]*data-testid="routine-add"[^>]*>Add routine<\/button>/);
    expect(html).toMatch(/<button[^>]*type="button"[^>]*data-testid="routine-cancel"[^>]*>Cancel<\/button>/);
  });
});

describe("Automations and Plugins, when the runtime has them", () => {
  it("offers neither when the runtime has neither", async () => {
    const html = await drawDemo();
    expect(html).not.toContain('data-testid="nav-automations"');
    expect(html).not.toContain('data-testid="nav-plugins"');
  });

  it("offers each as an entry, with how many jobs there are, under the routines", async () => {
    const rt = await demo();
    const html = draw(memoryPane(ready(await factsOf(rt))), routinesPane(ready(await routinesOf(rt))), { automations: { count: 3, open: noop }, plugins: { open: noop } });
    const text = words(html);
    expect(html).toContain('data-testid="nav-automations"');
    expect(html).toContain('data-testid="nav-plugins"');
    expect(text).toContain("Jobs the team runs on a schedule");
    expect(text).toContain("Skills and tools a team member can use");
    expect(text).toMatch(/Automations .*3/);
    expect(html.indexOf('data-testid="routines"')).toBeLessThan(html.indexOf('data-testid="nav-automations"'));
  });
});

/** Every element a page draws, with its own components expanded. The page's views use no hooks, so they can be called as plain
 *  functions, which lets a test read the handlers that a render to a string leaves out. */
function drawn(node: ReactNode): ReactElement<Record<string, unknown>>[] {
  if (Array.isArray(node)) return node.flatMap(drawn);
  if (!isValidElement(node)) return [];
  const el = node as ReactElement<Record<string, unknown>>;
  if (typeof el.type === "function") return drawn((el.type as (props: unknown) => ReactNode)(el.props));
  return [...(typeof el.type === "string" ? [el] : []), ...drawn(el.props.children as ReactNode)];
}

describe("the keys of the forms, for an input method that composes", () => {
  // Japanese, Korean and Chinese input methods use Enter to commit what is being composed and Escape to cancel it. Neither is for
  // the form: a half-written fact must not be saved, a half-written routine added, or a question closed by it.
  type Key = { key: string; isComposing?: boolean; keyCode?: number; preventDefault(): void };
  type Handler = (e: Key) => void;
  const key = (k: string, over: { isComposing?: boolean; keyCode?: number } = {}): Key => ({ key: k, preventDefault: vi.fn(), ...over });
  const handler = (html: ReactElement<Record<string, unknown>>) => html.props.onKeyDown as Handler;
  /** The one element with this test id (and, for a row, this fact), which must be there exactly once. */
  const byId = (view: ReactElement, id: string, fact?: string) => {
    const found = drawn(view).filter((e) => e.props["data-testid"] === id && (fact === undefined || e.props["data-fact"] === fact));
    expect(found, id).toHaveLength(1);
    return found[0];
  };

  async function view(memoryUi: Partial<MemoryUi>, routinesUi: Partial<RoutinesUi>) {
    const rt = await demo();
    const memoryDispatch = vi.fn();
    const routinesDispatch = vi.fn();
    const element = (
      <CustomizeView
        memory={memoryPane(ready(await factsOf(rt)), { dispatch: memoryDispatch }, memoryUi)}
        routines={routinesPane(ready(await routinesOf(rt)), { dispatch: routinesDispatch }, routinesUi)}
      />
    );
    return { element, memoryDispatch, routinesDispatch, first: (await factsOf(rt))[0] };
  }

  it("holds back an Enter that only commits a composition on the Remember box, the Correct editor and the New routine form", async () => {
    const { element, first } = await view({}, { form: form() });
    const withEditor = (await view({ ask: { kind: "correct", fact: first.id, draft: first.text } }, {})).element;
    const surfaces = [byId(element, "remember-form"), byId(withEditor, "fact", first.id), byId(element, "routine-form")];
    expect(surfaces.map((e) => e.type)).toEqual(["form", "form", "form"]);
    for (const surface of surfaces) {
      for (const composing of [{ isComposing: true }, { keyCode: 229 }]) {
        const e = key("Enter", composing);
        handler(surface)(e);
        expect(e.preventDefault, `${surface.props["data-testid"]} ${JSON.stringify(composing)}`).toHaveBeenCalledTimes(1);
      }
      const plain = key("Enter");
      handler(surface)(plain);
      expect(plain.preventDefault, `${surface.props["data-testid"]} plain`).not.toHaveBeenCalled();
    }
  });

  it("lets Escape close the Correct editor, and the Forget question, unless it only cancels a composition", async () => {
    const { first } = await view({}, {});
    for (const ask of [{ kind: "correct", fact: first.id, draft: first.text }, { kind: "forget", fact: first.id }] as const) {
      const { element, memoryDispatch } = await view({ ask }, {});
      const row = byId(element, "fact", first.id);
      handler(row)(key("Escape", { isComposing: true }));
      handler(row)(key("Escape", { keyCode: 229 }));
      expect(memoryDispatch, ask.kind).not.toHaveBeenCalled();
      handler(row)(key("Escape"));
      expect(memoryDispatch, ask.kind).toHaveBeenCalledTimes(1);
      expect(memoryDispatch, ask.kind).toHaveBeenCalledWith({ type: "cancel" });
    }
  });

  it("lets Escape close the New routine form unless it only cancels a composition", async () => {
    const { element, routinesDispatch } = await view({}, { form: form() });
    const f = byId(element, "routine-form");
    handler(f)(key("Escape", { isComposing: true }));
    expect(routinesDispatch).not.toHaveBeenCalled();
    handler(f)(key("Escape"));
    expect(routinesDispatch).toHaveBeenCalledTimes(1);
    expect(routinesDispatch).toHaveBeenCalledWith({ type: "close" });
  });
});

describe("every language", () => {
  it("draws the same page in Korean, Japanese and Chinese, with the facts and routines the runtime gave", async () => {
    const rt = await demo();
    const memory = memoryPane(ready(await factsOf(rt)));
    const routines = routinesPane(ready(await routinesOf(rt)));
    const english = draw(memory, routines);
    for (const l of LANGS) {
      setLang(l);
      const html = draw(memory, routines);
      expect(count(html, 'data-testid="fact"'), l).toBe(4);
      expect(count(html, 'data-testid="fact-waiting"'), l).toBe(1);
      expect(count(html, 'data-testid="routine"'), l).toBe(5);
      expect(words(html), l).toContain("Free shipping on orders over ฿800");
      expect(words(html), l).toContain(t("memory.lead"));
      expect(words(html), l).toContain(t("routines.title"));
      expect(words(html), l).toContain(t("routines.hint"));
      if (l !== "en") expect(words(html), l).not.toContain("You can read, correct and remove all of it");
      // no key left showing: nothing in the page reads like an i18n key
      expect(words(html), l).not.toMatch(/\b(memory|routines|customize)\.[a-zA-Z.]+/);
    }
    expect(english).toContain('data-testid="page-customize"');
  });

  it("says its own words in every language, none empty", () => {
    for (const l of LANGS) {
      setLang(l);
      for (const k of [
        "memory.lead", "memory.known", "memory.from", "memory.waiting", "memory.waitingNote", "memory.correct", "memory.forget", "memory.itsTrue",
        "memory.remember", "memory.rememberLabel", "memory.notConfirmed", "memory.correctLabel", "memory.save", "memory.cancel", "memory.forgetAsk",
        "memory.forgetYes", "memory.keep", "memory.loading", "routines.title", "routines.new", "routines.hint", "routines.loading", "routines.empty",
        "routines.words", "routines.wordsNotYet", "routines.form.title", "routines.form.does", "routines.form.at", "routines.form.add", "routines.form.cancel",
      ] as const)
        expect(t(k).trim(), `${l} ${k}`).not.toBe("");
    }
  });
});

describe("the owner's journey, through the page's own steps on the demo runtime", () => {
  async function demoStore() {
    const store = createStore(new MockRuntime(new MockHost({ now: () => BOOT })), { firstRoster: "all", hiddenBots: () => [], resume: () => null });
    await store.actions.init();
    store.actions.firstRunEnd();
    return store.actions;
  }

  it("forgets a fact: the question comes first, and once they say yes no word of it is drawn anywhere", async () => {
    const actions = await demoStore();
    let facts = (await actions.memoryList()).facts;
    const target = facts.find((f) => f.text.startsWith("Jasmine")) as MemoryFact;
    let ui = memoryReduce(MEMORY_START, { type: "forget", fact: target.id });
    const asked = draw(memoryPane(ready(facts), {}, ui), routinesPane(ready([])));
    expect(words(asked)).toContain("Forget this?");
    expect(words(asked)).toContain("Jasmine is the best seller");
    ui = memoryReduce(ui, { type: "begin" });
    const step = await memoryDo(actions, facts, { what: "forget", fact: target.id });
    facts = step.facts;
    ui = memoryReduce(ui, step.action);
    expect(ui).toEqual(MEMORY_START);
    const after = draw(memoryPane(ready(facts), {}, ui), routinesPane(ready([])));
    expect(after).not.toContain("Jasmine");
    expect(after).not.toContain('data-testid="forget-question"');
    expect(JSON.stringify(await actions.memoryList())).not.toContain("Jasmine is the best seller");
  });

  it("corrects a fact: the editor comes first, and the fact then says it was corrected", async () => {
    const actions = await demoStore();
    let facts = (await actions.memoryList()).facts;
    const first = facts[0];
    let ui = memoryReduce(MEMORY_START, { type: "correct", fact: first.id, text: first.text });
    ui = memoryReduce(ui, { type: "draft", text: "Free shipping on orders over ฿900" });
    expect(draw(memoryPane(ready(facts), {}, ui), routinesPane(ready([])))).toMatch(/value="Free shipping on orders over ฿900"/);
    ui = memoryReduce(ui, { type: "begin" });
    const step = await memoryDo(actions, facts, { what: "correct", fact: first.id, text: "Free shipping on orders over ฿900" });
    facts = step.facts;
    ui = memoryReduce(ui, step.action);
    const known = words(between(draw(memoryPane(ready(facts), {}, ui), routinesPane(ready([]))), "memory-known", "memory-waiting"));
    expect(known).toContain("Free shipping on orders over ฿900 Corrected by you");
    expect(known).not.toContain("over ฿800");
  });

  it("confirms what a customer said with It's true, and remembers something new, and both join what the team knows", async () => {
    const actions = await demoStore();
    let facts = (await actions.memoryList()).facts;
    const waiting = facts.find((f) => f.status === "waiting") as MemoryFact;
    facts = (await memoryDo(actions, facts, { what: "confirm", fact: waiting.id })).facts;
    facts = (await memoryDo(actions, facts, { what: "remember", text: "We ship on weekdays" })).facts;
    const html = draw(memoryPane(ready(facts)), routinesPane(ready([])));
    const known = words(between(html, "memory-known", "remember-form"));
    expect(known).toContain("Closed on Mondays");
    expect(known).toContain("We ship on weekdays You told Buddy");
    expect(html).not.toContain('data-testid="memory-waiting"');
  });

  it("says why a fact was not remembered, and keeps what was typed", async () => {
    const actions = await demoStore();
    const facts = (await actions.memoryList()).facts;
    let ui = memoryReduce(MEMORY_START, { type: "add", text: "jasmine is the best seller" });
    ui = memoryReduce(ui, { type: "begin" });
    const step = await memoryDo(actions, facts, { what: "remember", text: ui.add });
    ui = memoryReduce(ui, step.action);
    const html = draw(memoryPane(ready(step.facts), {}, ui), routinesPane(ready([])));
    expect(words(between(html, "memory-error"))).toContain("Your team already knows this.");
    expect(html).toMatch(/value="jasmine is the best seller"/);
    expect(count(html, 'data-testid="fact"')).toBe(4);
  });

  it("adds a routine that replies: the form shows Asks first as the kind is chosen, and the new routine shows it too", async () => {
    const actions = await demoStore();
    let rows = (await actions.routineList()).routines;
    let ui = routinesReduce(ROUTINES_START, { type: "open" });
    ui = routinesReduce(ui, { type: "set", patch: { name: "Answer parcel questions", action: "reply", when: "weekly", at: "09:30" } });
    ui = routinesReduce(ui, { type: "weekday", day: 4 });
    expect(words(between(draw(memoryPane(ready([])), routinesPane(ready(rows), {}, ui)), "routine-asks"))).toContain("This one always asks you first.");
    const form = ui.form as RoutineForm;
    expect(formProblem(form)).toBeNull();
    ui = routinesReduce(ui, { type: "begin", what: "save" });
    const step = await routineDo(actions, rows, { what: "save", form });
    rows = step.rows;
    ui = routinesReduce(ui, step.action);
    expect(ui).toEqual(ROUTINES_START);
    const html = draw(memoryPane(ready([])), routinesPane(ready(rows), {}, ui));
    expect(html).not.toContain('data-testid="routine-form"');
    expect(words(between(html, "routines"))).toContain("Every Monday and Thursday at 09:30 Answer parcel questions. Asks first.");
    expect(count(html, 'data-testid="routine"')).toBe(6);
  });

  it("will not add a routine with nothing said, and shows why, before anything is sent", async () => {
    let ui = routinesReduce(ROUTINES_START, { type: "open" });
    const problem = formProblem(ui.form as RoutineForm);
    expect(problem).toBe("invalid_name");
    ui = routinesReduce(ui, { type: "problem", reason: problem as NonNullable<typeof problem> });
    const html = draw(memoryPane(ready([])), routinesPane(ready([]), {}, ui));
    expect(words(between(html, "routine-problem"))).toContain("Say what it does in a short sentence.");
  });

  it("pauses a routine, which then says Paused with no next run, and resumes it", async () => {
    const actions = await demoStore();
    let rows = (await actions.routineList()).routines;
    let ui = routinesReduce(ROUTINES_START, { type: "begin", what: "switch", routine: rows[0].id });
    const paused = await routineDo(actions, rows, { what: "switch", row: rows[0] });
    rows = paused.rows;
    ui = routinesReduce(ui, paused.action);
    const first = words(between(draw(memoryPane(ready([])), routinesPane(ready(rows), {}, ui)), "routine", "routine-switch"));
    expect(first).toContain("Every day at 08:00 Morning brief Paused");
    expect(first).not.toContain("Next:");
    const resumed = await routineDo(actions, rows, { what: "switch", row: rows[0] });
    expect(words(between(draw(memoryPane(ready([])), routinesPane(ready(resumed.rows))), "routine", "routine-switch"))).toContain("Morning brief Next: Monday 08:00");
  });
});

describe("the connected runtime's page", () => {
  it("shows memory as not yet and the shop's schedules as routines, and a switch says not yet in the runtime's words", async () => {
    const memoryNotYet = { kind: "unavailable", code: "not_yet", message: t("rt.notYetShow") } as const;
    const rows: RoutineRow[] = [{ id: "sched-1", name: "Morning brief", when: "Every Monday at 08:30", action: null, asksFirst: null, enabled: true, next: BOOT + 3600, timeZone: "Asia/Bangkok" }];
    const calls = {
      routineCreate: async (): Promise<never> => {
        throw { code: "not_yet", message: t("rt.notYet") };
      },
      routinePause: async (): Promise<never> => {
        throw { code: "not_yet", message: t("rt.notYet") };
      },
      routineResume: async (): Promise<never> => {
        throw { code: "not_yet", message: t("rt.notYet") };
      },
    };
    let ui = routinesReduce(ROUTINES_START, { type: "begin", what: "switch", routine: "sched-1" });
    const step = await routineDo(calls, rows, { what: "switch", row: rows[0] });
    ui = routinesReduce(ui, step.action);
    const html = draw(memoryPane(memoryNotYet), routinesPane(ready(step.rows), {}, ui));
    expect(words(between(html, "memory-unavailable"))).toContain(t("rt.notYetShow"));
    expect(words(between(html, "routines-error"))).toContain(t("rt.notYet"));
    expect(words(between(html, "routines"))).toContain("Every Monday at 08:30 Morning brief");
    // the schedule is still on: nothing was changed, and nothing is said about whether it asks first
    expect(html).toMatch(/role="switch"[^>]*aria-checked="true"/);
    expect(words(between(html, "routine", "routine-switch"))).not.toMatch(/ask/i);
  });
});
