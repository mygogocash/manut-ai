import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { describeTrigger, nextRun } from "@manut/routine-rules";
import {
  ApiError,
  MAX_ROUTINES,
  type NewRoutine,
  type PilotApi,
  type Routine,
  type RoutinesView as RoutinesRead,
  type Shop,
  type Team,
} from "../src/api";
import { createFakeApi } from "../src/api/fake";
import { OpsConsole } from "../src/ops/OpsConsole";
import { readOperatorKey } from "../src/ops/operatorKey";
import { RoutinesView } from "../src/ops/RoutinesView";
import { deferred, renderWithApi, stubApi } from "./helpers";

// 10:00 on Monday 23 November in Bangkok. The page words a time as "at 10:00" on the day the browser's clock says it is and as "on 24
// November at 08:00" on any other, so the clock is held here to keep every sentence below the same on every day the tests run.
const NOW = Date.parse("2026-11-23T03:00:00Z");

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});

const SHOPS: Shop[] = [
  { tenant: "t1", name: "Baan Mali", ownerName: "Fon", lineConnectionId: "line_1", consent: true },
  { tenant: "t2", name: "Sabai Tea", ownerName: "Dao", consent: false },
];

const TEAM_ON: Team = { paused: false, since: null, members: ["nam", "pim", "ton"] };
const TEAM_PAUSED: Team = { paused: true, since: "2026-11-23T01:30:00.000Z", members: ["nam", "pim", "ton"] };

function routine(overrides: Partial<Routine> = {}): Routine {
  return {
    id: "rt-morning", name: "Morning brief", action: "brief", trigger: { kind: "daily", at: "08:00" }, timeZone: "Asia/Bangkok",
    asksFirst: false, member: "ton", when: "Every day at 08:00", paused: false, next: "2026-11-24T01:00:00.000Z",
    createdAt: "2026-11-10T03:00:00.000Z", lastRun: null, ...overrides,
  };
}

const MORNING = routine();

function view(routines: Routine[], team: Team = TEAM_ON, tenant = "t1"): RoutinesRead {
  return { tenant, team, routines };
}

/// What the API answers to a body: the routine it made, with its words and its next run from routine-rules, as the API works them out.
function made(body: NewRoutine, overrides: Partial<Routine> = {}): Routine {
  const rules = { id: "rt-new", name: body.name, action: body.action, timeZone: body.timeZone!, trigger: body.trigger, asksFirst: body.asksFirst! };
  const next = body.trigger.kind === "stockBelow" ? null : nextRun(rules, NOW);
  return {
    id: "rt-new", name: body.name, action: body.action, trigger: body.trigger, timeZone: body.timeZone!, asksFirst: body.asksFirst!,
    member: body.member!, when: describeTrigger(rules), paused: false, next: next === null ? null : new Date(next).toISOString(),
    ...(body.trigger.kind === "stockBelow" ? { waitsFor: "stock_feed" as const } : {}),
    createdAt: new Date(NOW).toISOString(), lastRun: null, ...overrides,
  };
}

const unexpected = (name: string) => () => Promise.reject(new Error(`unexpected call: ${name}`));

type Routes = Partial<Pick<PilotApi, "getRoutines" | "createRoutine" | "pauseRoutine" | "removeRoutine" | "pauseTeam" | "resumeTeam" | "listTemplates">>;
type Options = { shops?: Shop[] | null; tenant?: string | null; onForget?: () => void };

/// The page over an API whose every route is the test's own, so a route the test did not mean to reach fails it by name.
function renderPage(routes: Routes = {}, options: Options = {}) {
  const calls = {
    getRoutines: vi.fn(routes.getRoutines ?? (async () => view([MORNING]))),
    createRoutine: vi.fn(routes.createRoutine ?? (async (body: NewRoutine) => made(body))),
    pauseRoutine: vi.fn(routes.pauseRoutine ?? unexpected("pauseRoutine")),
    removeRoutine: vi.fn(routes.removeRoutine ?? unexpected("removeRoutine")),
    pauseTeam: vi.fn(routes.pauseTeam ?? unexpected("pauseTeam")),
    resumeTeam: vi.fn(routes.resumeTeam ?? unexpected("resumeTeam")),
    listTemplates: vi.fn(routes.listTemplates ?? (async () => [])),
  };
  const rendered = renderWithApi(
    <RoutinesView
      shops={options.shops === undefined ? SHOPS : options.shops}
      tenant={options.tenant === undefined ? "t1" : options.tenant}
      onForget={options.onForget ?? (() => {})}
    />,
    stubApi(calls),
  );
  return { calls, ...rendered };
}

const LIST = "Baan Mali's routines";
const FORM = "Make a routine for Baan Mali";
const ready = () => screen.findByRole("region", { name: FORM });
const rowsOf = () => within(screen.getByRole("list", { name: LIST })).getAllByRole("listitem");

const select = (label: string) => screen.getByLabelText(label) as HTMLSelectElement;
const text = (label: string) => screen.getByLabelText(label) as HTMLInputElement;
const radio = (name: string) => screen.getByRole("radio", { name }) as HTMLInputElement;
const box = (name: string) => screen.getByRole("checkbox", { name }) as HTMLInputElement;
const typeInto = (label: string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });
const press = (name: string) => fireEvent.click(screen.getByRole("button", { name }));
const optionsOf = (label: string) => within(select(label)).getAllByRole("option").map((option) => option.textContent);
const valuesOf = (label: string) => within(select(label)).getAllByRole("option").map((option) => (option as HTMLOptionElement).value);
/// What is written under a field, found as a reader of the page finds it: by the field's own `aria-describedby`.
const helpOf = (element: HTMLElement) => document.getElementById(element.getAttribute("aria-describedby") ?? "")?.textContent ?? null;
const linesOf = (dialog: HTMLElement) => [...dialog.querySelectorAll("p")].map((paragraph) => paragraph.textContent);
const group = (name: string) => screen.getByRole("group", { name });

const MAKE_BUTTON = "Make routine";
const asksBox = () => box("Ask the owner first");

function fillDaily(name = "Morning brief", at = "08:00") {
  typeInto("Name", name);
  typeInto("Time of day", at);
}

function openQuestion(name = "Morning brief") {
  press(MAKE_BUTTON);
  return screen.getByRole("dialog", { name: `Make ${name} for Baan Mali?` });
}

const saysYes = (dialog: HTMLElement, name = "Morning brief") => fireEvent.click(within(dialog).getByRole("button", { name: `Make ${name}` }));

const STARTS_ON = "It starts switched on. Each run still reads the switches and the owner's consent first, and only makes a draft for the owner to read.";
const STOCK_WAITS = "It waits until stock levels are connected: Manut AI has no stock feed yet, so it does not run before then.";

describe("the Make a routine form, and what it offers", () => {
  it("is offered under the list once the routines are read, for the shop chosen, and not before them or when they could not be read", async () => {
    const answer = deferred<RoutinesRead>();
    const first = renderPage({ getRoutines: () => answer.promise });
    expect(screen.queryByRole("region", { name: /^Make a routine/ })).toBeNull();
    expect(screen.queryByRole("button", { name: MAKE_BUTTON })).toBeNull();
    answer.resolve(view([MORNING]));
    await ready();
    expect(screen.getByRole("heading", { level: 2, name: FORM })).toBeTruthy();
    expect(screen.getByText(/^A routine does its work on its own schedule\. Each run only makes a draft for the owner to read/)).toBeTruthy();
    first.unmount();

    renderPage({ getRoutines: async () => { throw new ApiError(503, "routines_unavailable"); } });
    await screen.findByRole("alert");
    expect(screen.queryByRole("region", { name: /^Make a routine/ })).toBeNull();
    expect(screen.queryByRole("button", { name: MAKE_BUTTON })).toBeNull();
  });

  it("starts as Ton's brief, every day, in Asia/Bangkok, with nothing typed and nothing asked, and says what each field is for", async () => {
    renderPage();
    await ready();
    expect(text("Name").value).toBe("");
    expect(radio("Ton, books").checked).toBe(true);
    expect(radio("Nam, sales chat").checked).toBe(false);
    expect(radio("Pim, content").checked).toBe(false);
    expect(select("What it does").value).toBe("brief");
    expect(select("When it runs").value).toBe("daily");
    expect(text("Time of day").value).toBe("");
    expect(text("Time zone").value).toBe("Asia/Bangkok");
    expect(asksBox().checked).toBe(false);
    expect(asksBox().disabled).toBe(false);

    expect(helpOf(text("Name"))).toBe("What the owner sees it called, from 1 to 80 characters.");
    expect(helpOf(group("Whose job is it?")))
      .toBe("Each member does only some kinds of work: Nam replies to customers, Pim drafts and sends posts, and Ton briefs the owner, drafts, sends, pays and deletes.");
    expect(helpOf(select("What it does"))).toBe("A summary for the owner to read. It only reaches the owner, so asking first is your choice.");
    expect(helpOf(text("Time of day"))).toBe("On a 24-hour clock, like 08:00 or 21:30, in the time zone below.");
    expect(helpOf(text("Time zone"))).toBe("Every time above is in this zone. Asia/Bangkok, unless the shop runs on another.");
    expect(helpOf(asksBox())).toBe("A brief or a draft only reaches the owner, so asking first is your choice.");
    // Nothing is sent, and nothing is asked, until the operator makes the routine.
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("offers only the kinds of work each member may run, as the API's \"Who runs it\" says", async () => {
    renderPage();
    await ready();
    expect(optionsOf("What it does")).toEqual(["Brief the owner", "Draft something", "Send something out", "Pay something", "Delete something"]);
    expect(valuesOf("What it does")).toEqual(["brief", "draft", "send", "pay", "delete"]);
    fireEvent.click(radio("Nam, sales chat"));
    expect(valuesOf("What it does")).toEqual(["reply"]);
    expect(optionsOf("What it does")).toEqual(["Reply to a customer"]);
    expect(select("What it does").value).toBe("reply");
    fireEvent.click(radio("Pim, content"));
    expect(valuesOf("What it does")).toEqual(["draft", "send"]);
    expect(optionsOf("What it does")).toEqual(["Draft something", "Send something out"]);
    expect(select("What it does").value).toBe("draft");
    fireEvent.click(radio("Ton, books"));
    expect(valuesOf("What it does")).toEqual(["brief", "draft", "send", "pay", "delete"]);
  });

  it("keeps the kind of work when the member chosen does it too, and takes that member's first otherwise, so no pair the API would refuse is made", async () => {
    renderPage();
    await ready();
    fireEvent.change(select("What it does"), { target: { value: "send" } });
    fireEvent.click(radio("Pim, content"));
    expect(select("What it does").value).toBe("send");
    fireEvent.click(radio("Ton, books"));
    expect(select("What it does").value).toBe("send");
    fireEvent.change(select("What it does"), { target: { value: "pay" } });
    fireEvent.click(radio("Pim, content"));
    expect(select("What it does").value).toBe("draft");
    fireEvent.click(radio("Nam, sales chat"));
    expect(select("What it does").value).toBe("reply");
    // A reply is Nam's alone, so Ton starts again from the first of theirs.
    fireEvent.click(radio("Ton, books"));
    expect(select("What it does").value).toBe("brief");
  });

  it("says what each kind of work is, under the choice, and that a reply, a send, a payment and a deletion always ask", async () => {
    renderPage();
    await ready();
    const helps: Record<string, string> = {
      brief: "A summary for the owner to read. It only reaches the owner, so asking first is your choice.",
      draft: "Something written for the owner to read. It only reaches the owner, so asking first is your choice.",
      send: "A post or a message that goes out. It always asks the owner first.",
      pay: "A payment. It always asks the owner first.",
      delete: "A deletion. It always asks the owner first.",
    };
    for (const [action, help] of Object.entries(helps)) {
      fireEvent.change(select("What it does"), { target: { value: action } });
      expect(helpOf(select("What it does")), action).toBe(help);
    }
    fireEvent.click(radio("Nam, sales chat"));
    expect(helpOf(select("What it does"))).toBe("An answer to a customer's message. It always asks the owner first.");
  });

  it("shows asking first as on and locked for a reply, a send, a payment and a deletion, and offers it for a brief and a draft, keeping the choice", async () => {
    renderPage();
    await ready();
    // A brief: offered, and off.
    expect(asksBox().checked).toBe(false);
    expect(asksBox().disabled).toBe(false);
    fireEvent.click(asksBox());
    expect(asksBox().checked).toBe(true);
    const locked = "Always on for a reply, a send, a payment and a deletion, so it cannot be turned off.";
    for (const action of ["pay", "send", "delete"]) {
      fireEvent.change(select("What it does"), { target: { value: action } });
      expect(asksBox().checked, action).toBe(true);
      expect(asksBox().disabled, action).toBe(true);
      expect(helpOf(asksBox()), action).toBe(locked);
    }
    // Back to a draft: the box is offered again, with what the operator chose, and can be turned off.
    fireEvent.change(select("What it does"), { target: { value: "draft" } });
    expect(asksBox().disabled).toBe(false);
    expect(asksBox().checked).toBe(true);
    expect(helpOf(asksBox())).toBe("A brief or a draft only reaches the owner, so asking first is your choice.");
    fireEvent.click(asksBox());
    expect(asksBox().checked).toBe(false);
    // A reply is locked on whatever the box held.
    fireEvent.click(radio("Nam, sales chat"));
    expect(asksBox().checked).toBe(true);
    expect(asksBox().disabled).toBe(true);
    fireEvent.click(asksBox());
    expect(asksBox().checked).toBe(true);
    fireEvent.click(radio("Ton, books"));
    expect(asksBox().checked).toBe(false);
    expect(asksBox().disabled).toBe(false);
  });

  it("gives each kind of trigger its own fields: a time, the weekdays, a day of the month, a window, or a number", async () => {
    renderPage();
    await ready();
    const present = () => ({
      time: screen.queryByLabelText("Time of day") !== null,
      days: screen.queryByRole("group", { name: "On these days" }) !== null,
      day: screen.queryByLabelText("Day of the month") !== null,
      window: screen.queryByLabelText("From") !== null && screen.queryByLabelText("To") !== null,
      stock: screen.queryByLabelText("Stock drops under") !== null,
    });
    expect(optionsOf("When it runs")).toEqual([
      "Every day at a time", "On chosen weekdays at a time", "On a day of the month at a time", "In a window of the day", "When stock drops under a number"]);
    expect(valuesOf("When it runs")).toEqual(["daily", "weekly", "monthly", "window", "stockBelow"]);
    expect(present()).toEqual({ time: true, days: false, day: false, window: false, stock: false });

    fireEvent.change(select("When it runs"), { target: { value: "weekly" } });
    expect(present()).toEqual({ time: true, days: true, day: false, window: false, stock: false });
    // The week as a shop's calendar starts it, Monday first.
    expect(within(group("On these days")).getAllByRole("checkbox").map((one) => (one as HTMLInputElement).labels?.[0]?.textContent)).toEqual(
      ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]);
    expect(helpOf(group("On these days"))).toBe("Choose at least one.");

    fireEvent.change(select("When it runs"), { target: { value: "monthly" } });
    expect(present()).toEqual({ time: true, days: false, day: true, window: false, stock: false });
    expect(optionsOf("Day of the month")).toEqual([
      "Choose a day", ...Array.from({ length: 28 }, (_, index) => String(index + 1)), "The last day of the month"]);
    expect(helpOf(select("Day of the month")))
      .toBe("Days after the 28th are left out because not every month has them: choose the last day for those.");

    fireEvent.change(select("When it runs"), { target: { value: "window" } });
    expect(present()).toEqual({ time: false, days: false, day: false, window: true, stock: false });
    expect(helpOf(text("From"))).toBe(
      "A window runs once a day, at its start. It may cross midnight, like 21:00 to 08:00. Times are on a 24-hour clock, in the time zone below.");
    expect(helpOf(text("To"))).toBe(helpOf(text("From")));

    fireEvent.change(select("When it runs"), { target: { value: "stockBelow" } });
    expect(present()).toEqual({ time: false, days: false, day: false, window: false, stock: true });
    expect(helpOf(text("Stock drops under"))).toBe("A whole number from 1 up. Stock levels are not connected yet, so this routine waits until they are.");
  });

  it("keeps what was typed for one kind of trigger while another is chosen, and brings it back", async () => {
    renderPage();
    await ready();
    typeInto("Time of day", "09:30");
    fireEvent.change(select("When it runs"), { target: { value: "window" } });
    typeInto("From", "21:00");
    typeInto("To", "08:00");
    fireEvent.change(select("When it runs"), { target: { value: "weekly" } });
    fireEvent.click(box("Monday"));
    fireEvent.click(box("Friday"));
    fireEvent.change(select("When it runs"), { target: { value: "monthly" } });
    fireEvent.change(select("Day of the month"), { target: { value: "last" } });
    fireEvent.change(select("When it runs"), { target: { value: "stockBelow" } });
    typeInto("Stock drops under", "5");

    fireEvent.change(select("When it runs"), { target: { value: "daily" } });
    expect(text("Time of day").value).toBe("09:30");
    fireEvent.change(select("When it runs"), { target: { value: "window" } });
    expect([text("From").value, text("To").value]).toEqual(["21:00", "08:00"]);
    fireEvent.change(select("When it runs"), { target: { value: "weekly" } });
    expect([box("Monday").checked, box("Tuesday").checked, box("Friday").checked]).toEqual([true, false, true]);
    expect(text("Time of day").value).toBe("09:30");
    fireEvent.change(select("When it runs"), { target: { value: "monthly" } });
    expect(select("Day of the month").value).toBe("last");
    fireEvent.change(select("When it runs"), { target: { value: "stockBelow" } });
    expect(text("Stock drops under").value).toBe("5");
  });
});

describe("the Make a routine form, asking before it sends", () => {
  it("says every day in the API's own words, with its next run, whose job it is, and that it starts on, and sends nothing until yes", async () => {
    const { calls } = renderPage();
    await ready();
    fillDaily();
    const dialog = openQuestion();
    expect(linesOf(dialog)).toEqual([
      "Morning brief",
      "Ton's job.",
      "What it does: Brief the owner.",
      "Every day at 08:00",
      "Next run on 24 November at 08:00.",
      "Does not ask first: it only makes a draft for the owner to read.",
      STARTS_ON,
    ]);
    expect(within(dialog).getByRole("button", { name: "Make Morning brief" })).toBeTruthy();
    expect(within(dialog).getByRole("button", { name: "Keep editing" })).toBeTruthy();
    // It is asked in the form's own place, under the fields.
    expect(screen.getByRole("region", { name: FORM }).contains(dialog)).toBe(true);
    expect(calls.createRoutine).not.toHaveBeenCalled();
  });

  const cases: [string, () => void, string, string[]][] = [
    ["chosen weekdays, Pim's post that sending asks about", () => {
      typeInto("Name", "Friday post");
      fireEvent.click(radio("Pim, content"));
      fireEvent.change(select("What it does"), { target: { value: "send" } });
      fireEvent.change(select("When it runs"), { target: { value: "weekly" } });
      fireEvent.click(box("Friday"));
      fireEvent.click(box("Monday"));
      typeInto("Time of day", "17:30");
    }, "Friday post", ["Friday post", "Pim's job.", "What it does: Send something out.", "Every Monday and Friday at 17:30", "Next run at 17:30.",
      "Asks the owner first.", STARTS_ON]],
    ["a day of the month, Nam's reply", () => {
      typeInto("Name", "Monthly reply");
      fireEvent.click(radio("Nam, sales chat"));
      fireEvent.change(select("When it runs"), { target: { value: "monthly" } });
      fireEvent.change(select("Day of the month"), { target: { value: "5" } });
      typeInto("Time of day", "09:00");
    }, "Monthly reply", ["Monthly reply", "Nam's job.", "What it does: Reply to a customer.", "On the 5th of each month at 09:00",
      "Next run on 5 December at 09:00.", "Asks the owner first.", STARTS_ON]],
    ["the last day of the month, Ton's payment", () => {
      typeInto("Name", "Pay the supplier");
      fireEvent.change(select("What it does"), { target: { value: "pay" } });
      fireEvent.change(select("When it runs"), { target: { value: "monthly" } });
      fireEvent.change(select("Day of the month"), { target: { value: "last" } });
      typeInto("Time of day", "18:00");
    }, "Pay the supplier", ["Pay the supplier", "Ton's job.", "What it does: Pay something.", "On the last day of the month at 18:00",
      "Next run on 30 November at 18:00.", "Asks the owner first.", STARTS_ON]],
    ["a window that crosses midnight", () => {
      typeInto("Name", "Night watch");
      fireEvent.change(select("What it does"), { target: { value: "draft" } });
      fireEvent.change(select("When it runs"), { target: { value: "window" } });
      typeInto("From", "21:00");
      typeInto("To", "08:00");
    }, "Night watch", ["Night watch", "Ton's job.", "What it does: Draft something.", "Every night after 21:00", "Next run at 21:00.",
      "Does not ask first: it only makes a draft for the owner to read.", STARTS_ON]],
    ["a window inside a day, whose start has gone for today", () => {
      typeInto("Name", "Day watch");
      fireEvent.change(select("When it runs"), { target: { value: "window" } });
      typeInto("From", "09:00");
      typeInto("To", "17:00");
    }, "Day watch", ["Day watch", "Ton's job.", "What it does: Brief the owner.", "Every day from 09:00 to 17:00", "Next run on 24 November at 09:00.",
      "Does not ask first: it only makes a draft for the owner to read.", STARTS_ON]],
    ["a brief made to ask first", () => {
      fillDaily("Careful brief", "07:15");
      fireEvent.click(asksBox());
    }, "Careful brief", ["Careful brief", "Ton's job.", "What it does: Brief the owner.", "Every day at 07:15", "Next run on 24 November at 07:15.",
      "Asks the owner first.", STARTS_ON]],
    ["another zone, whose times are that zone's", () => {
      fillDaily("Tokyo brief", "08:00");
      typeInto("Time zone", "Asia/Tokyo");
    }, "Tokyo brief", ["Tokyo brief", "Ton's job.", "What it does: Brief the owner.", "Every day at 08:00 (Asia/Tokyo)",
      "Next run on 24 November at 06:00.", "Does not ask first: it only makes a draft for the owner to read.", STARTS_ON]],
    ["a stock routine, which waits until stock levels are connected and has no next run", () => {
      typeInto("Name", "Candles low");
      fireEvent.change(select("What it does"), { target: { value: "draft" } });
      fireEvent.change(select("When it runs"), { target: { value: "stockBelow" } });
      typeInto("Stock drops under", "5");
    }, "Candles low", ["Candles low", "Ton's job.", "What it does: Draft something.", "When stock drops under 5", STOCK_WAITS,
      "Does not ask first: it only makes a draft for the owner to read.", STARTS_ON]],
  ];
  for (const [what, fill, name, lines] of cases) {
    it(`says ${what}, in the API's own words and its next run, in the question before anything is sent`, async () => {
      const { calls } = renderPage();
      await ready();
      fill();
      const dialog = openQuestion(name);
      expect(linesOf(dialog)).toEqual(lines);
      expect(calls.createRoutine).not.toHaveBeenCalled();
    });
  }

  it("says the words and the time the way routine-rules does, whatever the trigger, never its own", async () => {
    renderPage();
    await ready();
    typeInto("Name", "Check");
    typeInto("Time of day", "06:05");
    fireEvent.change(select("When it runs"), { target: { value: "weekly" } });
    for (const day of ["Sunday", "Wednesday", "Saturday"]) fireEvent.click(box(day));
    const dialog = openQuestion("Check");
    const rules = { id: "rt-x", name: "Check", action: "brief" as const, timeZone: "Asia/Bangkok",
      trigger: { kind: "weekly" as const, weekdays: [0, 3, 6], at: "06:05" }, asksFirst: false };
    expect(within(dialog).getByText(describeTrigger(rules))).toBeTruthy();
    expect(describeTrigger(rules)).toBe("Every Sunday, Wednesday and Saturday at 06:05");
    // Wednesday 25 November is the first of them after Monday 10:00.
    expect(nextRun(rules, NOW)).toBe(Date.parse("2026-11-24T23:05:00Z"));
    expect(within(dialog).getByText("Next run on 25 November at 06:05.")).toBeTruthy();
  });

  it("says there is no next run while everyone is paused, or while the member is off the team, as the shop's list will", async () => {
    const paused = renderPage({ getRoutines: async () => view([MORNING], TEAM_PAUSED) });
    await ready();
    fillDaily();
    expect(within(openQuestion()).getByText("No next run: everyone is paused.")).toBeTruthy();
    paused.unmount();

    const off = renderPage({ getRoutines: async () => view([MORNING], { ...TEAM_ON, members: ["nam", "ton"] }) });
    await ready();
    fillDaily("Post", "10:00");
    fireEvent.click(radio("Pim, content"));
    expect(within(openQuestion("Post")).getByText("No next run: Pim is not on this shop's team.")).toBeTruthy();
    off.unmount();

    renderPage({ getRoutines: async () => view([MORNING], { paused: true, since: null, members: ["nam", "ton"] }) });
    await ready();
    fillDaily("Post", "10:00");
    fireEvent.click(radio("Pim, content"));
    expect(within(openQuestion("Post")).getByText("No next run: everyone is paused and Pim is not on this shop's team.")).toBeTruthy();
  });

  it("says a stock routine waits for stock levels, and still says what else would keep it from running", async () => {
    renderPage({ getRoutines: async () => view([MORNING], TEAM_PAUSED) });
    await ready();
    typeInto("Name", "Candles low");
    fireEvent.change(select("When it runs"), { target: { value: "stockBelow" } });
    typeInto("Stock drops under", "3");
    const dialog = openQuestion("Candles low");
    expect(within(dialog).getByText(`${STOCK_WAITS} It will also not run: everyone is paused.`)).toBeTruthy();
    expect(within(dialog).queryByText(/^Next run/)).toBeNull();
  });

  it("locks every field while the question is open, so what was read is what is sent, and Keep editing unlocks them with all that was typed", async () => {
    const { calls } = renderPage();
    await ready();
    fillDaily();
    fireEvent.click(asksBox());
    const dialog = openQuestion();
    for (const control of [text("Name"), radio("Nam, sales chat"), radio("Ton, books"), select("What it does"), select("When it runs"),
      text("Time of day"), text("Time zone"), asksBox(), screen.getByRole("button", { name: MAKE_BUTTON })]) {
      expect((control as HTMLInputElement).disabled, control.outerHTML.slice(0, 60)).toBe(true);
    }
    // A press on the form's own button while the question is open asks nothing more.
    fireEvent.click(screen.getByRole("button", { name: MAKE_BUTTON }));
    expect(screen.getAllByRole("dialog")).toHaveLength(1);

    fireEvent.click(within(dialog).getByRole("button", { name: "Keep editing" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(calls.createRoutine).not.toHaveBeenCalled();
    expect(text("Name").disabled).toBe(false);
    expect([text("Name").value, text("Time of day").value, asksBox().checked]).toEqual(["Morning brief", "08:00", true]);
    // Changing one thing and asking again says the changed routine.
    typeInto("Time of day", "09:00");
    expect(within(openQuestion()).getByText("Every day at 09:00")).toBeTruthy();
  });

  it("works the question out when it opens, so it says what it said then, and sends that", async () => {
    const { calls } = renderPage();
    await ready();
    fillDaily();
    const dialog = openQuestion();
    expect(within(dialog).getByText("Next run on 24 November at 08:00.")).toBeTruthy();
    // The clock moves on past the next run while the question is open: what is read stays what was read.
    vi.setSystemTime(Date.parse("2026-11-24T02:00:00Z"));
    fireEvent.click(within(dialog).getByRole("button", { name: "Make Morning brief" }));
    await screen.findByRole("status");
    expect(calls.createRoutine).toHaveBeenCalledTimes(1);
  });

  it("closes the question when another is asked, and asks the form's again from the row's: two are never open at once", async () => {
    const { calls } = renderPage();
    await ready();
    fillDaily();
    openQuestion();
    press("Pause the routine Morning brief");
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    expect(screen.queryByRole("dialog", { name: "Make Morning brief for Baan Mali?" })).toBeNull();
    expect(screen.getByRole("dialog", { name: "Pause Morning brief?" })).toBeTruthy();
    // The form is unlocked again, with what was typed.
    expect(text("Name").disabled).toBe(false);
    expect(text("Name").value).toBe("Morning brief");
    openQuestion();
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    expect(screen.queryByRole("dialog", { name: "Pause Morning brief?" })).toBeNull();
    expect(calls.createRoutine).not.toHaveBeenCalled();
    expect(calls.pauseRoutine).not.toHaveBeenCalled();
  });
});

describe("the Make a routine form, sending exactly the route's body", () => {
  const sent = (calls: ReturnType<typeof renderPage>["calls"], at = 0) => calls.createRoutine.mock.calls[at]![0];

  it("sends every field the route takes, in the route's order, as the operator read them, and nothing else", async () => {
    const { calls } = renderPage();
    await ready();
    fillDaily("Morning brief", "08:00");
    saysYes(openQuestion());
    await screen.findByRole("status");
    expect(calls.createRoutine).toHaveBeenCalledTimes(1);
    expect(sent(calls)).toEqual({
      tenant: "t1", name: "Morning brief", action: "brief", trigger: { kind: "daily", at: "08:00" }, timeZone: "Asia/Bangkok", asksFirst: false,
      member: "ton",
    });
    expect(Object.keys(sent(calls))).toEqual(["tenant", "name", "action", "trigger", "timeZone", "asksFirst", "member"]);
    expect(Object.keys(sent(calls).trigger)).toEqual(["kind", "at"]);
  });

  it("sends the name and the times without the spaces round them, the weekdays once each and in order, and the zone as written", async () => {
    const { calls } = renderPage();
    await ready();
    typeInto("Name", "   Friday post  ");
    fireEvent.click(radio("Pim, content"));
    fireEvent.change(select("When it runs"), { target: { value: "weekly" } });
    for (const day of ["Friday", "Sunday", "Monday"]) fireEvent.click(box(day));
    typeInto("Time of day", " 10:00 ");
    typeInto("Time zone", " Asia/Bangkok ");
    saysYes(openQuestion("Friday post"), "Friday post");
    await screen.findByRole("status");
    expect(sent(calls)).toEqual({ tenant: "t1", name: "Friday post", action: "draft", trigger: { kind: "weekly", weekdays: [0, 1, 5], at: "10:00" },
      timeZone: "Asia/Bangkok", asksFirst: false, member: "pim" });
  });

  it("sends a trigger from its own kind's fields alone, though the form holds the other kinds' as well", async () => {
    const { calls } = renderPage();
    await ready();
    /// Every kind's fields are filled in, one kind after another, so that the form holds them all when the last kind is chosen.
    function fillEveryKind() {
      typeInto("Name", "One of each");
      fireEvent.change(select("When it runs"), { target: { value: "daily" } });
      typeInto("Time of day", "09:30");
      fireEvent.change(select("When it runs"), { target: { value: "window" } });
      typeInto("From", "21:00");
      typeInto("To", "08:00");
      fireEvent.change(select("When it runs"), { target: { value: "weekly" } });
      fireEvent.click(box("Tuesday"));
      fireEvent.change(select("When it runs"), { target: { value: "monthly" } });
      fireEvent.change(select("Day of the month"), { target: { value: "last" } });
      fireEvent.change(select("When it runs"), { target: { value: "stockBelow" } });
      typeInto("Stock drops under", "7");
    }

    const triggers: [string, unknown][] = [
      ["daily", { kind: "daily", at: "09:30" }],
      ["weekly", { kind: "weekly", weekdays: [2], at: "09:30" }],
      ["monthly", { kind: "monthly", day: "last", at: "09:30" }],
      ["window", { kind: "window", from: "21:00", to: "08:00" }],
      ["stockBelow", { kind: "stockBelow", threshold: 7 }],
    ];
    for (const [kind, trigger] of triggers) {
      // Making a routine clears the form, so each kind is made from a form filled in afresh.
      fillEveryKind();
      fireEvent.change(select("When it runs"), { target: { value: kind } });
      saysYes(openQuestion("One of each"), "One of each");
      await waitFor(() => expect(calls.createRoutine).toHaveBeenCalledTimes(triggers.findIndex(([one]) => one === kind) + 1));
      expect(sent(calls, calls.createRoutine.mock.calls.length - 1).trigger, kind).toEqual(trigger);
      await waitFor(() => expect(text("Name").value).toBe(""));
    }
  });

  it("sends a day of the month as a number, and the last day as the word the API takes", async () => {
    const { calls } = renderPage();
    await ready();
    typeInto("Name", "Monthly");
    fireEvent.change(select("When it runs"), { target: { value: "monthly" } });
    fireEvent.change(select("Day of the month"), { target: { value: "28" } });
    typeInto("Time of day", "08:00");
    saysYes(openQuestion("Monthly"), "Monthly");
    await screen.findByRole("status");
    expect(sent(calls).trigger).toEqual({ kind: "monthly", day: 28, at: "08:00" });
    expect(typeof (sent(calls).trigger as { day: unknown }).day).toBe("number");
  });

  it("sends asking first as true for a reply, a send, a payment and a deletion whatever the box held, and as chosen for a brief and a draft", async () => {
    const { calls } = renderPage();
    await ready();
    const asked: [string, string, boolean][] = [];
    // The box is left as it is (off) for the work that always asks, and both ways for the work that may.
    for (const [member, action] of [["Ton, books", "pay"], ["Ton, books", "send"], ["Ton, books", "delete"], ["Nam, sales chat", "reply"],
      ["Pim, content", "send"]] as const) {
      fireEvent.click(radio(member));
      fireEvent.change(select("What it does"), { target: { value: action } });
      fillDaily(`A ${action}`);
      saysYes(openQuestion(`A ${action}`), `A ${action}`);
      await screen.findByRole("status");
      const body = sent(calls, calls.createRoutine.mock.calls.length - 1);
      asked.push([body.member!, body.action, body.asksFirst!]);
    }
    expect(asked).toEqual([["ton", "pay", true], ["ton", "send", true], ["ton", "delete", true], ["nam", "reply", true], ["pim", "send", true]]);

    fireEvent.click(radio("Ton, books"));
    fireEvent.change(select("What it does"), { target: { value: "brief" } });
    fillDaily("Quiet brief");
    saysYes(openQuestion("Quiet brief"), "Quiet brief");
    await waitFor(() => expect(calls.createRoutine).toHaveBeenCalledTimes(6));
    expect(sent(calls, 5).asksFirst).toBe(false);
    await screen.findByRole("status");
    fillDaily("Asking brief");
    fireEvent.click(asksBox());
    saysYes(openQuestion("Asking brief"), "Asking brief");
    await waitFor(() => expect(calls.createRoutine).toHaveBeenCalledTimes(7));
    expect(sent(calls, 6).asksFirst).toBe(true);
  });

  it("makes the routine for the shop chosen, so another shop's tenant goes with another shop's form", async () => {
    const { calls } = renderPage({ getRoutines: async (tenant) => view([], TEAM_ON, tenant) }, { tenant: "t2" });
    await screen.findByRole("region", { name: "Make a routine for Sabai Tea" });
    fillDaily();
    press(MAKE_BUTTON);
    fireEvent.click(within(screen.getByRole("dialog", { name: "Make Morning brief for Sabai Tea?" })).getByRole("button", { name: "Make Morning brief" }));
    await screen.findByRole("status");
    expect(sent(calls).tenant).toBe("t2");
  });
});

describe("the Make a routine form, once the routine is made", () => {
  it("says what the API answered in the list's own words, puts the routine in the list as it was answered, and clears the form", async () => {
    const lists = [[MORNING]];
    const createRoutine = vi.fn(async (body: NewRoutine) => {
      const answer = made(body, { id: "rt-answered", when: "Every day at 08:00", next: "2026-11-24T01:00:00.000Z" });
      lists.push([MORNING, answer]);
      return answer;
    });
    const { calls } = renderPage({ getRoutines: async () => view(lists.at(-1)!), createRoutine });
    await ready();
    fillDaily("Evening brief", "08:00");
    fireEvent.click(asksBox());
    saysYes(openQuestion("Evening brief"), "Evening brief");

    const said = await within(screen.getByRole("region", { name: FORM })).findByRole("status");
    expect(said.textContent).toBe("Made Evening brief. Every day at 08:00. Next run on 24 November at 08:00.");
    expect(screen.queryByRole("dialog")).toBeNull();
    // The form is blank again, as it starts.
    expect([text("Name").value, text("Time of day").value, text("Time zone").value, select("What it does").value, asksBox().checked])
      .toEqual(["", "", "Asia/Bangkok", "brief", false]);
    expect(radio("Ton, books").checked).toBe(true);
    // The list is read again, and the routine is in it, as the API listed it.
    await waitFor(() => expect(calls.getRoutines).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(rowsOf()).toHaveLength(2));
    const row = rowsOf()[1]!;
    expect(within(row).getByText("Evening brief")).toBeTruthy();
    expect(within(row).getByText("Ton's job.")).toBeTruthy();
    expect(within(row).getByText("Every day at 08:00")).toBeTruthy();
    expect(within(row).getByText("Next run on 24 November at 08:00.")).toBeTruthy();
    expect(within(row).getByText("Has not run yet.")).toBeTruthy();
    expect(within(screen.getByRole("region", { name: "Routines for Baan Mali" })).getByText("2 routines")).toBeTruthy();
  });

  it("lists the routine as the API answered it, not as the form said it, while the list is read again, and never twice once it is read", async () => {
    const second = deferred<RoutinesRead>();
    let reads = 0;
    const getRoutines = vi.fn(() => (++reads === 1 ? Promise.resolve(view([MORNING])) : second.promise));
    const answer = routine({ id: "rt-answered", name: "Evening brief", when: "Every evening, in the API's words", next: "2026-11-23T10:00:00.000Z",
      createdAt: "2026-11-23T03:00:00.000Z" });
    renderPage({ getRoutines, createRoutine: async () => answer });
    await ready();
    fillDaily("Evening brief", "17:00");
    saysYes(openQuestion("Evening brief"), "Evening brief");
    await screen.findByRole("status");
    // The second read has not answered: the routine is already listed, with the API's own words.
    await waitFor(() => expect(getRoutines).toHaveBeenCalledTimes(2));
    expect(rowsOf()).toHaveLength(2);
    expect(within(rowsOf()[1]!).getByText("Every evening, in the API's words")).toBeTruthy();
    expect(within(rowsOf()[1]!).getByText("Next run at 17:00.")).toBeTruthy();
    expect(within(screen.getByRole("region", { name: "Routines for Baan Mali" })).getByText("2 routines")).toBeTruthy();

    // The read that comes lists it too: it is listed once, from the read.
    second.resolve(view([MORNING, { ...answer, when: "Every day at 17:00" }]));
    await waitFor(() => expect(within(rowsOf()[1]!).getByText("Every day at 17:00")).toBeTruthy());
    expect(rowsOf()).toHaveLength(2);
  });

  it("keeps the routine in the list when the read after it fails, and says that the read failed", async () => {
    let reads = 0;
    const getRoutines = vi.fn(async () => {
      if (++reads > 1) throw new ApiError(503, "routines_unavailable");
      return view([MORNING]);
    });
    renderPage({ getRoutines });
    await ready();
    fillDaily("Evening brief", "17:00");
    saysYes(openQuestion("Evening brief"), "Evening brief");
    await screen.findByText(/could not read this shop's routines/);
    expect(rowsOf().map((row) => within(row).getAllByText(/Morning brief|Evening brief/)[0]!.textContent)).toEqual(["Morning brief", "Evening brief"]);
    // The notice says it was made: the failed read says nothing of that.
    expect(screen.getByText(/^Made Evening brief\./)).toBeTruthy();
  });

  it("lets the next read say what the API keeps: a routine another operator removed meanwhile is not listed by this page's memory of it", async () => {
    const lists: Routine[][] = [[MORNING], [MORNING], [MORNING]];
    const { calls } = renderPage({ getRoutines: async () => view(lists.shift() ?? [MORNING]) });
    await ready();
    fillDaily("Evening brief", "17:00");
    saysYes(openQuestion("Evening brief"), "Evening brief");
    await screen.findByRole("status");
    // The read after the make lists only the first routine, as if another operator had removed the new one at once.
    await waitFor(() => expect(calls.getRoutines).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(rowsOf()).toHaveLength(1));
    press("Refresh");
    await waitFor(() => expect(calls.getRoutines).toHaveBeenCalledTimes(3));
    expect(rowsOf()).toHaveLength(1);
  });

  it("can make another straight after, from the blank form, and each is sent once", async () => {
    const { calls } = renderPage();
    await ready();
    fillDaily("First", "08:00");
    saysYes(openQuestion("First"), "First");
    await waitFor(() => expect(text("Name").value).toBe(""));
    fillDaily("Second", "09:00");
    saysYes(openQuestion("Second"), "Second");
    await waitFor(() => expect(calls.createRoutine).toHaveBeenCalledTimes(2));
    expect(calls.createRoutine.mock.calls.map(([body]) => body.name)).toEqual(["First", "Second"]);
  });
});

/// Each way the API refuses a field, said beside it. The form is filled in as the case needs, made, and the refusal is the API's: the
/// question closes, the words are under the field (found by its `aria-describedby`, and it is marked invalid), nothing typed is lost, and
/// nothing else says it again.
describe("the Make a routine form, when the API refuses a field", () => {
  type Case = {
    code: string;
    /// Which form it is about, when the same code is said of more than one.
    about?: string;
    fill: () => void;
    fields: () => HTMLElement[];
    words: string;
  };
  const cases: Case[] = [
    { code: "invalid_name", fill: () => fillDaily(), fields: () => [text("Name")],
      words: "A name takes 1 to 80 characters, not counting spaces at either end." },
    { code: "invalid_action", fill: () => fillDaily(), fields: () => [select("What it does")], words: "Choose what it does from the list." },
    { code: "invalid_time_zone", fill: () => fillDaily(), fields: () => [text("Time zone")],
      words: "That is not a time zone the API knows. Write one like Asia/Bangkok or Asia/Tokyo." },
    { code: "invalid_trigger", fill: () => fillDaily(), fields: () => [select("When it runs")], words: "Choose when it runs." },
    { code: "invalid_time", about: "of a time of day", fill: () => fillDaily(), fields: () => [text("Time of day")],
      words: "Write the time as two digits, a colon and two digits on a 24-hour clock, like 08:00 or 21:30." },
    { code: "invalid_time", about: "of a window", fill: () => {
      typeInto("Name", "Morning brief");
      fireEvent.change(select("When it runs"), { target: { value: "window" } });
      typeInto("From", "21:00");
      typeInto("To", "08:00");
    }, fields: () => [text("From"), text("To")],
    words: "Write the time as two digits, a colon and two digits on a 24-hour clock, like 08:00 or 21:30." },
    { code: "invalid_weekdays", fill: () => {
      typeInto("Name", "Morning brief");
      fireEvent.change(select("When it runs"), { target: { value: "weekly" } });
      fireEvent.click(box("Monday"));
      typeInto("Time of day", "08:00");
    }, fields: () => [group("On these days")], words: "Choose at least one day of the week." },
    { code: "invalid_day", fill: () => {
      typeInto("Name", "Morning brief");
      fireEvent.change(select("When it runs"), { target: { value: "monthly" } });
      fireEvent.change(select("Day of the month"), { target: { value: "3" } });
      typeInto("Time of day", "08:00");
    }, fields: () => [select("Day of the month")], words: "Choose a day from the 1st to the 28th, or the last day of the month." },
    { code: "invalid_window", fill: () => {
      typeInto("Name", "Morning brief");
      fireEvent.change(select("When it runs"), { target: { value: "window" } });
      typeInto("From", "21:00");
      typeInto("To", "08:00");
    }, fields: () => [text("From"), text("To")],
    words: "A window must start and end at different times. It may cross midnight, like 21:00 to 08:00." },
    { code: "invalid_threshold", fill: () => {
      typeInto("Name", "Morning brief");
      fireEvent.change(select("When it runs"), { target: { value: "stockBelow" } });
      typeInto("Stock drops under", "5");
    }, fields: () => [text("Stock drops under")], words: "Write a whole number from 1 up, like 5." },
    { code: "must_ask_first", fill: () => {
      fillDaily();
      fireEvent.change(select("What it does"), { target: { value: "pay" } });
    }, fields: () => [asksBox()], words: "A reply, a send, a payment and a deletion always ask the owner first, so this cannot be turned off." },
    { code: "unknown_member", fill: () => fillDaily(), fields: () => [group("Whose job is it?")], words: "Choose Nam, Pim or Ton." },
    { code: "wrong_member", fill: () => {
      fillDaily();
      fireEvent.click(radio("Pim, content"));
      fireEvent.change(select("What it does"), { target: { value: "send" } });
    }, fields: () => [select("What it does")], words: "Pim does not do that kind of work. Pim can: draft something and send something out." },
  ];

  for (const { code, about, fill, fields, words } of cases) {
    it(`says ${code}${about ? ` ${about}` : ""} beside its field in plain words, keeps everything typed, and closes the question`, async () => {
      const createRoutine = vi.fn(async () => { throw new ApiError(400, code); });
      const { calls } = renderPage({ createRoutine });
      await ready();
      fill();
      const beforeTyped = { name: text("Name").value, kind: select("When it runs").value, zone: text("Time zone").value };
      press(MAKE_BUTTON);
      const dialog = screen.getByRole("dialog");
      fireEvent.click(within(dialog).getAllByRole("button")[0]!);
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      expect(calls.createRoutine).toHaveBeenCalledTimes(1);
      // The words are under the field, found as a reader of the page finds them, and the field says it is wrong.
      for (const field of fields()) {
        expect(helpOf(field), `${code} beside ${field.id || field.tagName}`).toBe(words);
        if (field.tagName !== "FIELDSET") expect(field.getAttribute("aria-invalid")).toBe("true");
      }
      // Said once, beside the field: nothing else on the page says it.
      expect(screen.queryByRole("alert")).toBeNull();
      expect(screen.queryByRole("status")).toBeNull();
      expect(screen.getAllByText(words)).toHaveLength(1);
      // Nothing typed is lost, and the form is open for the mending.
      expect({ name: text("Name").value, kind: select("When it runs").value, zone: text("Time zone").value }).toEqual(beforeTyped);
      expect(text("Name").disabled).toBe(false);
      expect(screen.getByRole("button", { name: MAKE_BUTTON })).toBeTruthy();
      // The list was not read again: nothing was made.
      expect(calls.getRoutines).toHaveBeenCalledTimes(1);
    });
  }

  it("says what the member does when the work is not theirs, for each member, naming the member and not another", async () => {
    const { calls } = renderPage({ createRoutine: async () => { throw new ApiError(400, "wrong_member"); } });
    await ready();
    fillDaily();
    fireEvent.click(radio("Nam, sales chat"));
    fireEvent.change(select("When it runs"), { target: { value: "daily" } });
    saysYes(openQuestion(), "Morning brief");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(helpOf(select("What it does"))).toBe("Nam does not do that kind of work. Nam can: reply to a customer.");
    expect(calls.createRoutine).toHaveBeenCalledTimes(1);
  });

  it("mends it where it is said: changing the field takes the words away, leaves the other fields' words, and asks again", async () => {
    let refusals = 2;
    const createRoutine = vi.fn(async (body: NewRoutine) => {
      if (refusals-- > 0) throw new ApiError(400, "invalid_name");
      return made(body);
    });
    const { calls } = renderPage({ createRoutine });
    await ready();
    fillDaily("A name the API refuses");
    saysYes(openQuestion("A name the API refuses"), "A name the API refuses");
    await waitFor(() => expect(helpOf(text("Name"))).toBe("A name takes 1 to 80 characters, not counting spaces at either end."));
    // Another field, changed, does not take the name's words away.
    typeInto("Time of day", "09:00");
    expect(helpOf(text("Name"))).toBe("A name takes 1 to 80 characters, not counting spaces at either end.");
    expect(text("Name").getAttribute("aria-invalid")).toBe("true");
    // Making it again asks again, and the refusal is said again, from the API's own answer.
    saysYes(openQuestion("A name the API refuses"), "A name the API refuses");
    await waitFor(() => expect(calls.createRoutine).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(helpOf(text("Name"))).toBe("A name takes 1 to 80 characters, not counting spaces at either end.");
    // The field itself is changed: its words go, and its help is back.
    typeInto("Name", "Evening brief");
    expect(helpOf(text("Name"))).toBe("What the owner sees it called, from 1 to 80 characters.");
    expect(text("Name").getAttribute("aria-invalid")).toBeNull();
    saysYes(openQuestion("Evening brief"), "Evening brief");
    expect((await screen.findByRole("status")).textContent).toContain("Made Evening brief.");
    expect(calls.createRoutine).toHaveBeenCalledTimes(3);
  });

  it("says the shop's limit once, above the form, in plain words, keeps the question open and everything typed, and says nothing beside a field", async () => {
    const { calls } = renderPage({ createRoutine: async () => { throw new ApiError(409, "full"); } });
    await ready();
    fillDaily();
    saysYes(openQuestion());
    const alert = await within(screen.getByRole("region", { name: FORM })).findByRole("alert");
    expect(alert.textContent).toBe("Baan Mali already has 50 routines, which is the most a shop may have. Remove one, then make this one. What you typed is kept.");
    expect(MAX_ROUTINES).toBe(50);
    expect(screen.getAllByRole("alert")).toHaveLength(1);
    // It is no field's: none is marked, and the question is still open to be tried again or kept.
    expect(screen.queryByRole("dialog", { name: "Make Morning brief for Baan Mali?" })).toBeTruthy();
    for (const field of [text("Name"), text("Time of day"), text("Time zone"), select("What it does")]) expect(field.getAttribute("aria-invalid")).toBeNull();
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Keep editing" }));
    expect([text("Name").value, text("Time of day").value]).toEqual(["Morning brief", "08:00"]);
    expect(calls.createRoutine).toHaveBeenCalledTimes(1);
    expect(calls.getRoutines).toHaveBeenCalledTimes(1);
  });

  it("says when it may or may not have been made, so that it is not made twice by a press that did not need to be, and keeps the question open", async () => {
    let answer: ApiError | null = new ApiError(503, "routines_unavailable");
    const createRoutine = vi.fn(async (body: NewRoutine) => {
      if (answer) throw answer;
      return made(body);
    });
    const { calls } = renderPage({ createRoutine });
    await ready();
    fillDaily();
    const dialog = openQuestion();
    saysYes(dialog);
    expect((await screen.findByRole("alert")).textContent)
      .toBe("The API could not reach this shop's routines, so this routine may or may not have been made. Press Refresh and look at the list before making it again.");
    expect(screen.getByRole("dialog", { name: "Make Morning brief for Baan Mali?" })).toBeTruthy();
    // The list is not read again by itself: the operator looks, and decides.
    expect(calls.getRoutines).toHaveBeenCalledTimes(1);
    expect((within(dialog).getByRole("button", { name: "Make Morning brief" }) as HTMLButtonElement).disabled).toBe(false);

    answer = null;
    saysYes(dialog);
    expect((await screen.findByRole("status")).textContent).toContain("Made Morning brief.");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(calls.createRoutine).toHaveBeenCalledTimes(2);
  });

  it("says nothing was made when the API could not set the clock, and when it could not be reached at all it says it may or may not have been", async () => {
    let failure: ApiError = new ApiError(503, "clock_unavailable");
    const { calls } = renderPage({ createRoutine: async () => { throw failure; } });
    await ready();
    fillDaily();
    const dialog = openQuestion();
    saysYes(dialog);
    expect((await screen.findByRole("alert")).textContent).toBe("The API could not set this routine's clock, so nothing was made. What you typed is kept. Try again.");
    failure = new ApiError(0, "network");
    saysYes(dialog);
    await waitFor(() => expect(screen.getByRole("alert").textContent)
      .toBe("Could not reach the API. This routine may or may not have been made: press Refresh and look at the list before making it again."));
    expect(calls.createRoutine).toHaveBeenCalledTimes(2);
    expect(screen.getAllByRole("alert")).toHaveLength(1);
  });

  it("says a shop that is not a pilot shop, and a shop record that could not be read, in the page's own words", async () => {
    let failure: ApiError = new ApiError(404, "shop_not_found");
    renderPage({ createRoutine: async () => { throw failure; } });
    await ready();
    fillDaily();
    const dialog = openQuestion();
    saysYes(dialog);
    expect((await screen.findByRole("alert")).textContent)
      .toBe("This is not one of the pilot's shops, so it has no routines. It may have been deleted.");
    failure = new ApiError(503, "shop_unavailable");
    saysYes(dialog);
    await waitFor(() => expect(screen.getByRole("alert").textContent)
      .toBe("The API could not read this shop's record, so it cannot say whether it is a pilot shop. Nothing was changed. Try again."));
  });

  it("says a refusal it has no words for in the console's usual words, above the form, and not beside a field", async () => {
    let failure: ApiError = new ApiError(400, "invalid_request");
    renderPage({ createRoutine: async () => { throw failure; } });
    await ready();
    fillDaily();
    const dialog = openQuestion();
    saysYes(dialog);
    expect((await screen.findByRole("alert")).textContent).toBe("The API did not accept this (invalid_request).");
    failure = new ApiError(400, "something_new");
    saysYes(dialog);
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("The API did not accept this (something_new)."));
    // A code that names a field only in a 400 is no field's in any other: a server error with the code is the page's usual words.
    failure = new ApiError(500, "invalid_name");
    saysYes(dialog);
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("The API answered with an error (invalid_name)."));
    expect(helpOf(text("Name"))).toBe("What the owner sees it called, from 1 to 80 characters.");
  });

  it("offers another key when the API refuses the key, leaves the question open, and says nothing beside a field", async () => {
    const onForget = vi.fn();
    renderPage({ createRoutine: async () => { throw new ApiError(403, "forbidden"); } }, { onForget });
    await ready();
    fillDaily();
    saysYes(openQuestion());
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("The API refused the operator key");
    expect(screen.getByRole("dialog", { name: "Make Morning brief for Baan Mali?" })).toBeTruthy();
    fireEvent.click(within(alert).getByRole("button", { name: "Enter another key" }));
    expect(onForget).toHaveBeenCalledTimes(1);
  });
});

/// What the form refuses before it sends anything: the same rules, by `@manut/routine-rules`, in the same words, beside the same fields.
describe("the Make a routine form, when it refuses before it asks", () => {
  const NAME_WORDS = "A name takes 1 to 80 characters, not counting spaces at either end.";
  const TIME_WORDS = "Write the time as two digits, a colon and two digits on a 24-hour clock, like 08:00 or 21:30.";

  it("says everything that is wrong at once, beside each field, asks nothing and sends nothing", async () => {
    const { calls } = renderPage();
    await ready();
    press(MAKE_BUTTON);
    expect(helpOf(text("Name"))).toBe(NAME_WORDS);
    expect(helpOf(text("Time of day"))).toBe(TIME_WORDS);
    for (const field of [text("Name"), text("Time of day")]) expect(field.getAttribute("aria-invalid")).toBe("true");
    // What is right says nothing is wrong with it.
    for (const field of [text("Time zone"), select("What it does"), select("When it runs")]) expect(field.getAttribute("aria-invalid")).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(calls.createRoutine).not.toHaveBeenCalled();
  });

  it("takes each problem away when its field is changed, and only its own", async () => {
    renderPage();
    await ready();
    press(MAKE_BUTTON);
    typeInto("Name", "Morning brief");
    expect(helpOf(text("Name"))).toBe("What the owner sees it called, from 1 to 80 characters.");
    expect(helpOf(text("Time of day"))).toBe(TIME_WORDS);
    typeInto("Time of day", "08:00");
    expect(helpOf(text("Time of day"))).toBe("On a 24-hour clock, like 08:00 or 21:30, in the time zone below.");
    expect(text("Time of day").getAttribute("aria-invalid")).toBeNull();
    press(MAKE_BUTTON);
    expect(screen.getByRole("dialog", { name: "Make Morning brief for Baan Mali?" })).toBeTruthy();
  });

  it("counts a name as a person does: 80 characters are allowed, even when each is two code units long, and 81 are not, nor spaces alone", async () => {
    const { calls } = renderPage();
    await ready();
    typeInto("Time of day", "08:00");
    for (const refused of ["", "    ", "x".repeat(81), "🌸".repeat(81)]) {
      typeInto("Name", refused);
      press(MAKE_BUTTON);
      expect(helpOf(text("Name")), JSON.stringify(refused).slice(0, 12)).toBe(NAME_WORDS);
      expect(screen.queryByRole("dialog")).toBeNull();
    }
    for (const allowed of ["x".repeat(80), "🌸".repeat(80), "  Morning brief  "]) {
      typeInto("Name", allowed);
      const dialog = openQuestion(allowed.trim());
      fireEvent.click(within(dialog).getByRole("button", { name: "Keep editing" }));
      expect(helpOf(text("Name"))).toBe("What the owner sees it called, from 1 to 80 characters.");
    }
    expect(calls.createRoutine).not.toHaveBeenCalled();
  });

  it("refuses a time that is not two digits, a colon and two digits on a 24-hour clock, and takes the spaces round one", async () => {
    renderPage();
    await ready();
    typeInto("Name", "Morning brief");
    for (const refused of ["", "8:00", "800", "24:00", "08:60", "8am", "08.00", "08:00:00", "ab:cd"]) {
      typeInto("Time of day", refused);
      press(MAKE_BUTTON);
      expect(helpOf(text("Time of day")), refused).toBe(TIME_WORDS);
      expect(screen.queryByRole("dialog"), refused).toBeNull();
    }
    for (const allowed of ["00:00", "08:00", "23:59", " 12:30 "]) {
      typeInto("Time of day", allowed);
      const dialog = openQuestion();
      expect(within(dialog).getByText(new RegExp(`^Every day at ${allowed.trim()}$`)), allowed).toBeTruthy();
      fireEvent.click(within(dialog).getByRole("button", { name: "Keep editing" }));
    }
  });

  it("refuses a weekly routine with no day chosen, a monthly one with no day chosen, and a window that ends where it starts", async () => {
    renderPage();
    await ready();
    typeInto("Name", "Morning brief");
    typeInto("Time of day", "08:00");
    fireEvent.change(select("When it runs"), { target: { value: "weekly" } });
    press(MAKE_BUTTON);
    expect(helpOf(group("On these days"))).toBe("Choose at least one day of the week.");
    fireEvent.click(box("Monday"));
    expect(helpOf(group("On these days"))).toBe("Choose at least one.");
    fireEvent.click(box("Monday"));
    expect(screen.queryByRole("dialog")).toBeNull();
    press(MAKE_BUTTON);
    expect(helpOf(group("On these days"))).toBe("Choose at least one day of the week.");

    fireEvent.change(select("When it runs"), { target: { value: "monthly" } });
    press(MAKE_BUTTON);
    expect(helpOf(select("Day of the month"))).toBe("Choose a day from the 1st to the 28th, or the last day of the month.");
    expect(select("Day of the month").getAttribute("aria-invalid")).toBe("true");
    fireEvent.change(select("Day of the month"), { target: { value: "15" } });
    expect(select("Day of the month").getAttribute("aria-invalid")).toBeNull();

    fireEvent.change(select("When it runs"), { target: { value: "window" } });
    typeInto("From", "21:00");
    typeInto("To", "21:00");
    press(MAKE_BUTTON);
    expect(helpOf(text("From"))).toBe("A window must start and end at different times. It may cross midnight, like 21:00 to 08:00.");
    expect(helpOf(text("To"))).toBe(helpOf(text("From")));
    typeInto("To", "9pm");
    press(MAKE_BUTTON);
    expect(helpOf(text("From"))).toBe(TIME_WORDS);
    typeInto("To", "08:00");
    expect(screen.queryByRole("dialog")).toBeNull();
    press(MAKE_BUTTON);
    expect(screen.getByRole("dialog", { name: "Make Morning brief for Baan Mali?" })).toBeTruthy();
  });

  it("refuses a stock number that is not a whole number from 1 up, read from its digits and nothing else", async () => {
    renderPage();
    await ready();
    typeInto("Name", "Candles low");
    fireEvent.change(select("When it runs"), { target: { value: "stockBelow" } });
    for (const refused of ["", "0", "-3", "5.5", "abc", "1e3", "0x10", "5 pieces", "99999999999999999999"]) {
      typeInto("Stock drops under", refused);
      press(MAKE_BUTTON);
      expect(helpOf(text("Stock drops under")), refused).toBe("Write a whole number from 1 up, like 5.");
      expect(screen.queryByRole("dialog"), refused).toBeNull();
    }
    for (const [typed, said] of [["5", "When stock drops under 5"], [" 12 ", "When stock drops under 12"], ["007", "When stock drops under 7"]]) {
      typeInto("Stock drops under", typed!);
      const dialog = openQuestion("Candles low");
      expect(within(dialog).getByText(said!), typed).toBeTruthy();
      fireEvent.click(within(dialog).getByRole("button", { name: "Keep editing" }));
    }
  });

  it("refuses a time zone the browser does not know, and an empty one, and accepts any it does", async () => {
    renderPage();
    await ready();
    fillDaily();
    for (const refused of ["", "   ", "Mars/Olympus", "Bangkok", "UTC+7"]) {
      typeInto("Time zone", refused);
      press(MAKE_BUTTON);
      expect(helpOf(text("Time zone")), refused).toBe("That is not a time zone the API knows. Write one like Asia/Bangkok or Asia/Tokyo.");
      expect(screen.queryByRole("dialog"), refused).toBeNull();
    }
    for (const allowed of ["Asia/Tokyo", "UTC", "Europe/London"]) {
      typeInto("Time zone", allowed);
      const dialog = openQuestion();
      expect(within(dialog).getByText(`Every day at 08:00 (${allowed})`), allowed).toBeTruthy();
      fireEvent.click(within(dialog).getByRole("button", { name: "Keep editing" }));
    }
  });

  it("suggests the zones the browser knows as the operator types, Asia/Bangkok among them", async () => {
    const { container } = renderPage();
    await ready();
    const listed = [...container.querySelectorAll("#make-zones option")].map((option) => (option as HTMLOptionElement).value);
    expect(listed).toContain("Asia/Bangkok");
    expect(listed).toContain("Asia/Tokyo");
    expect(text("Time zone").getAttribute("list")).toBe("make-zones");
  });
});

describe("the Make a routine form, one change at a time", () => {
  it("sends one request however often yes is pressed before the page has drawn the first answer", async () => {
    const pending = deferred<Routine>();
    const { calls } = renderPage({ createRoutine: () => pending.promise });
    await ready();
    fillDaily();
    const dialog = openQuestion();
    const yes = within(dialog).getByRole("button", { name: "Make Morning brief" }) as HTMLButtonElement;
    // Two presses in one step, before React has drawn the first one's busy state: the page's own guard has to hold.
    act(() => {
      yes.click();
      yes.click();
    });
    await waitFor(() => expect(yes.disabled).toBe(true));
    expect(calls.createRoutine).toHaveBeenCalledTimes(1);
    pending.resolve(made({ tenant: "t1", name: "Morning brief", action: "brief", trigger: { kind: "daily", at: "08:00" }, timeZone: "Asia/Bangkok",
      asksFirst: false, member: "ton" }));
    await screen.findByRole("status");
    expect(calls.createRoutine).toHaveBeenCalledTimes(1);
  });

  it("asks one question when the form is made twice in one step", async () => {
    const { calls } = renderPage();
    await ready();
    fillDaily();
    const button = screen.getByRole("button", { name: MAKE_BUTTON });
    act(() => {
      button.click();
      button.click();
    });
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    expect(calls.createRoutine).not.toHaveBeenCalled();
  });

  it("says it is working in the button, and locks the whole page while it waits: the form, the rows and the team", async () => {
    const pending = deferred<Routine>();
    const { calls } = renderPage({ createRoutine: () => pending.promise });
    await ready();
    fillDaily();
    const dialog = openQuestion();
    saysYes(dialog);
    const working = await within(dialog).findByRole("button", { name: "Making" }) as HTMLButtonElement;
    expect(working.disabled).toBe(true);
    expect(working.getAttribute("aria-busy")).toBe("true");
    expect((within(dialog).getByRole("button", { name: "Keep editing" }) as HTMLButtonElement).disabled).toBe(true);
    for (const control of [text("Name"), text("Time of day"), text("Time zone"), select("What it does"), select("When it runs"), asksBox(),
      radio("Nam, sales chat"), screen.getByRole("button", { name: MAKE_BUTTON })]) {
      expect((control as HTMLInputElement).disabled, control.outerHTML.slice(0, 50)).toBe(true);
    }
    for (const name of ["Pause the routine Morning brief", "Remove the routine Morning brief", "Pause everyone for Baan Mali"]) {
      expect((screen.getByRole("button", { name }) as HTMLButtonElement).disabled, name).toBe(true);
    }
    expect(calls.createRoutine).toHaveBeenCalledTimes(1);
    pending.resolve(made({ tenant: "t1", name: "Morning brief", action: "brief", trigger: { kind: "daily", at: "08:00" }, timeZone: "Asia/Bangkok",
      asksFirst: false, member: "ton" }));
    await screen.findByRole("status");
    await waitFor(() => expect((screen.getByRole("button", { name: "Pause everyone for Baan Mali" }) as HTMLButtonElement).disabled).toBe(false));
    expect(text("Name").disabled).toBe(false);
  });

  it("asks nothing when the form is submitted by other means while a change is on its way, or while its own question is open", async () => {
    const pending = deferred<Routine>();
    renderPage({ pauseRoutine: () => pending.promise });
    await ready();
    fillDaily();
    const form = screen.getByRole("form", { name: FORM });
    press("Pause the routine Morning brief");
    fireEvent.click(within(screen.getByRole("dialog", { name: "Pause Morning brief?" })).getByRole("button", { name: "Pause Morning brief" }));
    await waitFor(() => expect(text("Name").disabled).toBe(true));
    // Enter in a field, or a script, submits a form without its button: the form is locked, so nothing is asked.
    fireEvent.submit(form);
    expect(screen.queryByRole("dialog", { name: /^Make / })).toBeNull();
    pending.resolve({ ...MORNING, paused: true, next: null });
    await screen.findByRole("status");

    // With its own question open, a submit asks nothing again: the question says what it said when it was read, not what is true now.
    const dialog = openQuestion();
    expect(within(dialog).getByText("Next run on 24 November at 08:00.")).toBeTruthy();
    vi.setSystemTime(Date.parse("2026-11-23T20:00:00Z"));
    fireEvent.submit(form);
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    expect(within(screen.getByRole("dialog")).getByText("Next run on 24 November at 08:00.")).toBeTruthy();
  });

  it("locks the form while a row's change is on its way, and nothing the form does reaches a row's question", async () => {
    const pending = deferred<Routine>();
    renderPage({ pauseRoutine: () => pending.promise });
    await ready();
    fillDaily();
    press("Pause the routine Morning brief");
    fireEvent.click(within(screen.getByRole("dialog", { name: "Pause Morning brief?" })).getByRole("button", { name: "Pause Morning brief" }));
    await waitFor(() => expect(text("Name").disabled).toBe(true));
    expect((screen.getByRole("button", { name: MAKE_BUTTON }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: MAKE_BUTTON }));
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    pending.resolve({ ...MORNING, paused: true, next: null });
    await screen.findByRole("status");
    // What was typed is still there when the change is done.
    expect([text("Name").value, text("Time of day").value]).toEqual(["Morning brief", "08:00"]);
    expect(text("Name").disabled).toBe(false);
  });
});

describe("the Make a routine form, for the shop chosen", () => {
  it("is the shop's own: what is typed for one shop is not carried to another, and the heading and the question name the shop", async () => {
    const { calls } = renderPage({ getRoutines: async (tenant) => view([], TEAM_ON, tenant) });
    await ready();
    typeInto("Name", "Typed for Baan Mali");
    fireEvent.change(screen.getByLabelText("Shop"), { target: { value: "t2" } });
    await screen.findByRole("region", { name: "Make a routine for Sabai Tea" });
    expect(text("Name").value).toBe("");
    fillDaily("Tea brief");
    press(MAKE_BUTTON);
    expect(screen.getByRole("dialog", { name: "Make Tea brief for Sabai Tea?" })).toBeTruthy();
    expect(calls.createRoutine).not.toHaveBeenCalled();
  });
});

// Through the console, the way an operator reaches it, with the practice world's own rules behind the form: what a made routine does to the
// list and to the audit log, and what the practice world refuses.
describe("the Make a routine form in the console, over the practice world", () => {
  function practice() {
    sessionStorage.setItem("manut.pilot.operatorKey", "op-key-123");
    return createFakeApi({ operatorKey: readOperatorKey, now: () => NOW, webOrigin: "https://web.test", storage: localStorage });
  }

  const openRoutines = async () => fireEvent.click(await screen.findByRole("button", { name: "Routines" }));

  it("makes a routine in practice: the list has it as the practice world answered, the audit log says routine.created by its id, and the form is blank", async () => {
    const api = practice();
    renderWithApi(<OpsConsole />, api);
    await openRoutines();
    await ready();
    await screen.findByRole("list", { name: LIST });
    expect(rowsOf()).toHaveLength(6);
    typeInto("Name", "Friday restock check");
    fireEvent.click(radio("Pim, content"));
    fireEvent.change(select("What it does"), { target: { value: "send" } });
    fireEvent.change(select("When it runs"), { target: { value: "weekly" } });
    fireEvent.click(box("Friday"));
    typeInto("Time of day", "10:00");
    const dialog = openQuestion("Friday restock check");
    expect(linesOf(dialog)).toEqual(["Friday restock check", "Pim's job.", "What it does: Send something out.", "Every Friday at 10:00",
      "Next run on 27 November at 10:00.", "Asks the owner first.", STARTS_ON]);
    saysYes(dialog, "Friday restock check");

    expect((await within(screen.getByRole("region", { name: FORM })).findByRole("status")).textContent)
      .toBe("Made Friday restock check. Every Friday at 10:00. Next run on 27 November at 10:00.");
    await waitFor(() => expect(rowsOf()).toHaveLength(7));
    const row = rowsOf()[6]!;
    expect(within(row).getByText("Friday restock check")).toBeTruthy();
    expect(within(row).getByText("Pim's job.")).toBeTruthy();
    expect(within(row).getByText("Every Friday at 10:00")).toBeTruthy();
    expect(within(row).getByText("Asks the owner first.")).toBeTruthy();
    expect(within(row).getByText("On")).toBeTruthy();
    expect(within(screen.getByRole("region", { name: "Routines for Baan Mali" })).getByText("7 routines, 1 paused")).toBeTruthy();
    expect(text("Name").value).toBe("");

    const entry = (await api.listAudit("shop_baanmali", { limit: 1 })).entries[0]!;
    expect(entry).toMatchObject({ action: "routine.created", actor: { kind: "operator" }, subject: { routineId: (await api.getRoutines("shop_baanmali")).routines[6]!.id } });
    expect(JSON.stringify(entry)).not.toContain("Friday restock check");
  });

  it("makes a stock routine in practice, which waits for stock levels and has no next run, as the list says it", async () => {
    renderWithApi(<OpsConsole />, practice());
    await openRoutines();
    await ready();
    typeInto("Name", "Tea running low");
    fireEvent.change(select("What it does"), { target: { value: "draft" } });
    fireEvent.change(select("When it runs"), { target: { value: "stockBelow" } });
    typeInto("Stock drops under", "4");
    saysYes(openQuestion("Tea running low"), "Tea running low");
    await screen.findByText(/^Made Tea running low\./);
    await waitFor(() => expect(rowsOf()).toHaveLength(7));
    const row = rowsOf()[6]!;
    expect(within(row).getByText("When stock drops under 4")).toBeTruthy();
    expect(within(row).getByText("No next run: it waits for a stock feed, which Manut AI does not have yet.")).toBeTruthy();
  });

  it("refuses the 51st routine in practice as the API does, in plain words, and keeps what was typed", async () => {
    const api = practice();
    for (let n = 7; n <= MAX_ROUTINES; n++) {
      await api.createRoutine({ tenant: "shop_baanmali", name: `Routine ${n}`, action: "brief", trigger: { kind: "daily", at: "08:00" } });
    }
    renderWithApi(<OpsConsole />, api);
    await openRoutines();
    await ready();
    await screen.findByRole("list", { name: LIST });
    expect(within(screen.getByRole("region", { name: "Routines for Baan Mali" })).getByText("50 routines, 1 paused")).toBeTruthy();
    fillDaily("One too many", "08:00");
    saysYes(openQuestion("One too many"), "One too many");
    expect((await screen.findByRole("alert")).textContent)
      .toBe("Baan Mali already has 50 routines, which is the most a shop may have. Remove one, then make this one. What you typed is kept.");
    expect(rowsOf()).toHaveLength(50);
    expect(text("Name").value).toBe("One too many");
    // Removing one makes room, and the same question, asked again, makes it.
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Keep editing" }));
    press("Remove the routine Morning brief");
    fireEvent.click(within(screen.getByRole("dialog", { name: "Remove Morning brief?" })).getByRole("button", { name: "Remove Morning brief" }));
    await screen.findByText("Removed Morning brief. Its runs and its clock are gone.");
    saysYes(openQuestion("One too many"), "One too many");
    await screen.findByText(/^Made One too many\./);
    await waitFor(() => expect(rowsOf()).toHaveLength(50));
  });

  it("makes a routine for a shop made from a template, after the template's own, and says no next run for a member the template turned off", async () => {
    const api = practice();
    await api.createShop({ name: "Sabai Snacks", ownerName: "Dao", template: "food" });
    renderWithApi(<OpsConsole />, api);
    await screen.findByRole("button", { name: "Baan Mali" });
    fireEvent.click(await screen.findByRole("button", { name: "Sabai Snacks" }));
    fireEvent.click(screen.getByRole("button", { name: "Routines" }));
    await screen.findByRole("region", { name: "Make a routine for Sabai Snacks" });
    typeInto("Name", "Snack post");
    fireEvent.click(radio("Pim, content"));
    typeInto("Time of day", "10:00");
    const dialog = screen.getByRole("form", { name: "Make a routine for Sabai Snacks" }).querySelector("button[type=submit]") as HTMLButtonElement;
    fireEvent.click(dialog);
    expect(within(screen.getByRole("dialog", { name: "Make Snack post for Sabai Snacks?" })).getByText("No next run: Pim is not on this shop's team."))
      .toBeTruthy();
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Make Snack post" }));
    await screen.findByText(/^Made Snack post\./);
    await waitFor(() => expect(within(screen.getByRole("list", { name: "Sabai Snacks's routines" })).getAllByRole("listitem")).toHaveLength(5));
  });
});
