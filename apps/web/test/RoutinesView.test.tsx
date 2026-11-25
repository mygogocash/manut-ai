import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ApiError,
  type PilotApi,
  type Routine,
  type RoutineRemoval,
  type RoutineRun,
  type RoutinesView as RoutinesRead,
  type Shop,
  type ShopTemplate,
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

const LIST = "Baan Mali's routines";
const TEAM_ON: Team = { paused: false, since: null, members: ["nam", "pim", "ton"] };
const TEAM_PAUSED: Team = { paused: true, since: "2026-11-23T01:30:00.000Z", members: ["nam", "pim", "ton"] };

function run(overrides: Partial<RoutineRun> = {}): RoutineRun {
  return { routineId: "rt-morning", instant: "2026-11-23T01:00:00.000Z", status: "done", member: "ton", taskId: "worker-task-1",
    at: "2026-11-23T01:02:00.000Z", ...overrides };
}

function routine(overrides: Partial<Routine> = {}): Routine {
  return {
    id: "rt-morning", name: "Morning brief", action: "brief", trigger: { kind: "daily", at: "08:00" }, timeZone: "Asia/Bangkok",
    asksFirst: false, member: "ton", when: "Every day at 08:00", paused: false, next: "2026-11-24T01:00:00.000Z",
    createdAt: "2026-11-10T03:00:00.000Z", lastRun: run(), ...overrides,
  };
}

const MORNING = routine();
const REPLIES = routine({
  id: "rt-replies", name: "Answer new customer messages", action: "reply", trigger: { kind: "daily", at: "12:00" }, asksFirst: true,
  member: "nam", when: "Every day at 12:00", next: "2026-11-23T05:00:00.000Z",
  lastRun: run({ routineId: "rt-replies", instant: "2026-11-22T05:00:00.000Z", status: "skipped", reason: "nothing_to_answer", member: "nam" }),
});
const POST = routine({
  id: "rt-post", name: "Draft the Friday post", action: "draft", trigger: { kind: "weekly", weekdays: [5], at: "10:00" }, asksFirst: true,
  member: "pim", when: "Every Friday at 10:00", paused: true, next: null,
  lastRun: run({ routineId: "rt-post", instant: "2026-11-20T03:00:00.000Z", status: "skipped", reason: "routine_paused", member: "pim" }),
});
const STOCK = routine({
  id: "rt-stock", name: "Tell me when candles run low", action: "draft", trigger: { kind: "stockBelow", threshold: 5 }, when: "When stock drops under 5",
  next: null, waitsFor: "stock_feed", lastRun: null,
});

/// What the API answers: while everyone is paused no routine has a next run, whatever the routine's own setting.
function view(routines: Routine[], team: Team = TEAM_ON, tenant = "t1"): RoutinesRead {
  return { tenant, team, routines: team.paused ? routines.map((one) => ({ ...one, next: null })) : routines };
}

const HANDMADE: ShopTemplate = { id: "handmade", name: "Handmade and gifts", fits: "Candles, soap and crafts.", team: ["nam", "pim", "ton"],
  routines: [], questions: [] };

const unexpected = (name: string) => () => Promise.reject(new Error(`unexpected call: ${name}`));

type Routes = Partial<Pick<PilotApi, "getRoutines" | "pauseRoutine" | "resumeRoutine" | "removeRoutine" | "pauseTeam" | "resumeTeam"
  | "listTemplates">>;
type Options = { shops?: Shop[] | null; tenant?: string | null; onForget?: () => void };

/// The page over an API whose every route is the test's own, so a route the test did not mean to reach fails it by name.
function renderPage(routes: Routes = {}, options: Options = {}) {
  const calls = {
    getRoutines: vi.fn(routes.getRoutines ?? (async () => view([MORNING, REPLIES, POST, STOCK]))),
    pauseRoutine: vi.fn(routes.pauseRoutine ?? unexpected("pauseRoutine")),
    resumeRoutine: vi.fn(routes.resumeRoutine ?? unexpected("resumeRoutine")),
    removeRoutine: vi.fn(routes.removeRoutine ?? unexpected("removeRoutine")),
    pauseTeam: vi.fn(routes.pauseTeam ?? unexpected("pauseTeam")),
    resumeTeam: vi.fn(routes.resumeTeam ?? unexpected("resumeTeam")),
    listTemplates: vi.fn(routes.listTemplates ?? (async () => [HANDMADE])),
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

const section = (name: string) => screen.getByRole("region", { name });
const rowsOf = (list: string) => within(screen.getByRole("list", { name: list })).getAllByRole("listitem");
const rowWith = (text: string, list = LIST) => {
  const row = rowsOf(list).find((item) => (item.textContent ?? "").includes(text));
  if (!row) throw new Error(`no row of "${list}" holds "${text}"`);
  return row;
};
const click = (name: string) => fireEvent.click(screen.getByRole("button", { name }));

/// Opens the question of a button, and answers the dialog it opens.
function ask(button: string, dialog: string) {
  click(button);
  return screen.getByRole("dialog", { name: dialog });
}

const PAUSE_MORNING = "Pause the routine Morning brief";
const RESUME_POST = "Resume the routine Draft the Friday post";
const REMOVE_MORNING = "Remove the routine Morning brief";
const PAUSE_TEAM = "Pause everyone for Baan Mali";
const RESUME_TEAM = "Resume the team for Baan Mali";

describe("the Routines page, reading a shop's routines", () => {
  it("shows a skeleton while it reads, and then the team and the routines of the chosen shop", async () => {
    const answer = deferred<RoutinesRead>();
    const { calls } = renderPage({ getRoutines: () => answer.promise });
    expect(screen.getByRole("heading", { level: 1, name: "Routines" })).toBeTruthy();
    expect(screen.getByLabelText("Loading the shop's team")).toBeTruthy();
    expect(screen.getByLabelText("Loading the shop's routines")).toBeTruthy();
    expect(calls.getRoutines).toHaveBeenCalledWith("t1");
    // Nothing is offered that could change a team or a routine nobody has read yet.
    expect(screen.queryByRole("button", { name: /Pause|Resume|Remove/ })).toBeNull();

    answer.resolve(view([MORNING, STOCK]));
    await screen.findByRole("list", { name: LIST });
    expect(screen.queryByLabelText(/^Loading the shop's/)).toBeNull();
    expect(rowsOf(LIST)).toHaveLength(2);
    expect(calls.getRoutines).toHaveBeenCalledTimes(1);
  });

  it("says that nothing it does is sent, and that an operator makes a routine, in two lines; it has no field and makes none", async () => {
    const { container } = renderPage();
    await screen.findByRole("list", { name: LIST });
    expect(screen.getByText("What Buddy's team does for this shop on its own schedule, with each routine's next run in Bangkok time. A routine only makes a draft for the owner to read: nothing it does is sent, posted or paid without the owner's yes."))
      .toBeTruthy();
    expect(screen.getByText("This console does not make routines yet. An operator makes one with POST /v1/admin/routines, and a shop made from a template starts with the template's."))
      .toBeTruthy();
    // No way to make one: the one control that is not a button is the shop picker.
    expect(container.querySelector("input, textarea")).toBeNull();
    expect(container.querySelectorAll("select")).toHaveLength(1);
    expect(screen.queryByRole("button", { name: /^(add|new|make|create)\b/i })).toBeNull();
    expect(screen.getAllByRole("button").map((button) => button.getAttribute("aria-label") ?? button.textContent)).toEqual([
      "Refresh",
      PAUSE_TEAM,
      PAUSE_MORNING, REMOVE_MORNING,
      "Pause the routine Answer new customer messages", "Remove the routine Answer new customer messages",
      RESUME_POST, "Remove the routine Draft the Friday post",
      "Pause the routine Tell me when candles run low", "Remove the routine Tell me when candles run low",
    ]);
  });

  it("lists a routine that is on: its name, whose job it is, when, its next run, that it asks no one, and how its last run ended", async () => {
    renderPage();
    await screen.findByRole("list", { name: LIST });
    const row = rowWith("Morning brief");
    expect(within(row).getByText("Morning brief")).toBeTruthy();
    expect(within(row).getByText("Ton's job.")).toBeTruthy();
    expect(within(row).getByText("Every day at 08:00")).toBeTruthy();
    expect(within(row).getByText("Next run on 24 November at 08:00.")).toBeTruthy();
    expect(within(row).getByText("Does not ask first: it only makes a draft for the owner to read.")).toBeTruthy();
    expect(within(row).getByText("Last run was meant for 08:00 today.")).toBeTruthy();
    expect(within(row).getByText("Done")).toBeTruthy();
    expect(within(row).getByText("It made a draft for the owner to read, on the Drafts page.")).toBeTruthy();
    expect(within(row).getByText("On")).toBeTruthy();
    expect(within(row).queryByText(/Made from/)).toBeNull();
    expect(within(section("Routines for Baan Mali")).getByText("4 routines, 1 paused")).toBeTruthy();
  });

  it("says a next run later today as a time alone, and one on another day with its date, in Bangkok time", async () => {
    renderPage();
    await screen.findByRole("list", { name: LIST });
    expect(within(rowWith("Answer new customer messages")).getByText("Next run at 12:00.")).toBeTruthy();
    expect(within(rowWith("Morning brief")).getByText("Next run on 24 November at 08:00.")).toBeTruthy();
  });

  it("says a routine asks the owner first, and which zone a routine that runs in another zone keeps its times in", async () => {
    renderPage({ getRoutines: async () => view([REPLIES, routine({ id: "rt-tokyo", name: "Tokyo brief", timeZone: "Asia/Tokyo",
      when: "Every day at 08:00", next: "2026-11-23T23:00:00.000Z", lastRun: null })]) });
    await screen.findByRole("list", { name: LIST });
    expect(within(rowWith("Answer new customer messages")).getByText("Asks the owner first.")).toBeTruthy();
    // Its times are Tokyo's, which the line says; the next run is the instant, in Bangkok time (06:00 on Tuesday there is 21:00 here).
    const tokyo = rowWith("Tokyo brief");
    expect(within(tokyo).getByText("Every day at 08:00 (Asia/Tokyo)")).toBeTruthy();
    expect(within(tokyo).getByText("Next run on 24 November at 06:00.")).toBeTruthy();
    expect(within(rowWith("Answer new customer messages")).getByText("Every day at 12:00")).toBeTruthy();
  });

  it("says a paused routine is paused, with no next run and why, and offers Resume in place of Pause", async () => {
    renderPage();
    await screen.findByRole("list", { name: LIST });
    const row = rowWith("Draft the Friday post");
    expect(within(row).getByText("Paused")).toBeTruthy();
    expect(within(row).getByText("No next run: this routine is paused.")).toBeTruthy();
    expect(within(row).getByText("Pim's job.")).toBeTruthy();
    expect(within(row).queryByRole("button", { name: /^Pause the routine/ })).toBeNull();
    expect(within(row).getByRole("button", { name: RESUME_POST })).toBeTruthy();
    expect(within(rowWith("Morning brief")).queryByRole("button", { name: /^Resume/ })).toBeNull();
  });

  it("says a stock routine waits for a stock feed, which does not exist yet, and that it has not run", async () => {
    renderPage();
    await screen.findByRole("list", { name: LIST });
    const row = rowWith("Tell me when candles run low");
    expect(within(row).getByText("When stock drops under 5")).toBeTruthy();
    expect(within(row).getByText("No next run: it waits for a stock feed, which Manut AI does not have yet.")).toBeTruthy();
    expect(within(row).getByText("Has not run yet.")).toBeTruthy();
    expect(within(row).queryByText(/Last run/)).toBeNull();
  });

  it("says every reason a routine has no next run when more than one holds, in the order the API decides them", async () => {
    renderPage({ getRoutines: async () => view([
      routine({ id: "rt-a", name: "All at once", paused: true, next: null, waitsFor: "stock_feed", member: "pim", lastRun: null }),
      routine({ id: "rt-b", name: "Team only", next: null, lastRun: null }),
      routine({ id: "rt-c", name: "Member only", member: "pim", next: null, lastRun: null }),
    ], { paused: true, since: "2026-11-23T01:30:00.000Z", members: ["nam", "ton"] }) });
    await screen.findByRole("list", { name: LIST });
    expect(within(rowWith("All at once")).getByText(
      "No next run: this routine is paused, everyone is paused, Pim is not on this shop's team and it waits for a stock feed, which Manut AI does not have yet."))
      .toBeTruthy();
    expect(within(rowWith("Team only")).getByText("No next run: everyone is paused.")).toBeTruthy();
    expect(within(rowWith("Member only")).getByText("No next run: everyone is paused and Pim is not on this shop's team.")).toBeTruthy();
  });

  it("says a routine with no next run and no reason that none is set, never a blank", async () => {
    renderPage({ getRoutines: async () => view([routine({ next: null, lastRun: null })]) });
    await screen.findByRole("list", { name: LIST });
    expect(within(rowWith("Morning brief")).getByText("No next run is set.")).toBeTruthy();
  });

  it("says the shop template a routine came from by its name, and by its id when the console cannot read the name", async () => {
    const fromTemplate = routine({ id: "rt-t", name: "Weekly growth brief", template: "handmade", lastRun: null, paused: true, next: null });
    const first = renderPage({ getRoutines: async () => view([fromTemplate, routine({ id: "rt-u", name: "Other", template: "bakery", lastRun: null })]) });
    await screen.findByRole("list", { name: LIST });
    await waitFor(() => expect(within(rowWith("Weekly growth brief")).getByText("Made from the Handmade and gifts template.")).toBeTruthy());
    // A template this console has no name for is shown as the API sent it, and the routine that came from none says nothing of one.
    expect(within(rowWith("Other")).getByText("Made from the bakery template.")).toBeTruthy();
    expect(first.calls.listTemplates).toHaveBeenCalledTimes(1);
    first.unmount();

    renderPage({
      getRoutines: async () => view([fromTemplate]),
      listTemplates: async () => { throw new ApiError(503, "http_503"); },
    });
    await screen.findByRole("list", { name: LIST });
    await waitFor(() => expect(within(rowWith("Weekly growth brief")).getByText("Made from the handmade template.")).toBeTruthy());
    // The names failing to read is no failure of the page.
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("reads the templates only when a routine names one", async () => {
    const { calls } = renderPage();
    await screen.findByRole("list", { name: LIST });
    expect(calls.listTemplates).not.toHaveBeenCalled();
  });

  it("says how each kind of last run ended, and why, in plain words, with the time it was meant for", async () => {
    const last = (overrides: Partial<RoutineRun>) => run({ routineId: "x", ...overrides });
    renderPage({ getRoutines: async () => view([
      routine({ id: "rt-1", name: "Failed one", lastRun: last({ status: "failed", reason: "payments_unavailable", instant: "2026-11-16T01:00:00.000Z" }) }),
      routine({ id: "rt-2", name: "Failed unsaid", lastRun: last({ status: "failed" }) }),
      routine({ id: "rt-3", name: "Switches off", lastRun: last({ status: "skipped", reason: "routines_off" }) }),
      routine({ id: "rt-4", name: "No consent", lastRun: last({ status: "skipped", reason: "consent_required" }) }),
      routine({ id: "rt-5", name: "Cloud off", lastRun: last({ status: "skipped", reason: "cloud_off" }) }),
      routine({ id: "rt-6", name: "Team held", lastRun: last({ status: "skipped", reason: "team_paused" }) }),
      routine({ id: "rt-7", name: "Late one", lastRun: last({ status: "missed", instant: "2026-10-31T11:00:00.000Z" }) }),
      routine({ id: "rt-8", name: "Still going", lastRun: last({ status: "running" }) }),
      routine({ id: "rt-9", name: "Job broke", lastRun: last({ status: "failed", reason: "job_error" }) }),
      routine({ id: "rt-10", name: "No messages read", lastRun: last({ status: "failed", reason: "messages_unavailable" }) }),
      routine({ id: "rt-11", name: "Odd code", lastRun: last({ status: "failed", reason: "something_new" }) }),
    ]) });
    await screen.findByRole("list", { name: LIST });
    const said = (name: string) => rowWith(name);
    expect(within(said("Failed one")).getByText("Failed")).toBeTruthy();
    expect(within(said("Failed one")).getByText("The shop's recorded payments could not be read.")).toBeTruthy();
    expect(within(said("Failed one")).getByText("Last run was meant for 16 November at 08:00.")).toBeTruthy();
    expect(within(said("Failed unsaid")).getByText("It ended without saying why.")).toBeTruthy();
    expect(within(said("Switches off")).getByText("Skipped")).toBeTruthy();
    expect(within(said("Switches off")).getByText("Routines were switched off.")).toBeTruthy();
    expect(within(said("No consent")).getByText("The owner had not allowed it, or had withdrawn permission.")).toBeTruthy();
    expect(within(said("Cloud off")).getByText("Cloud work was switched off.")).toBeTruthy();
    expect(within(said("Team held")).getByText("Everyone was paused.")).toBeTruthy();
    expect(within(said("Late one")).getByText("Missed")).toBeTruthy();
    expect(within(said("Late one")).getByText("Its alarm came more than 15 minutes late, so it was not run.")).toBeTruthy();
    expect(within(said("Late one")).getByText("Last run was meant for 31 October at 18:00.")).toBeTruthy();
    expect(within(said("Still going")).getByText("Running")).toBeTruthy();
    expect(within(said("Still going")).getByText("It started and has not said how it ended.")).toBeTruthy();
    expect(within(said("Job broke")).getByText("The job stopped part way.")).toBeTruthy();
    expect(within(said("No messages read")).getByText("The shop's customer messages could not be read.")).toBeTruthy();
    // A code this console does not know yet is shown as it is, and never dropped.
    expect(within(said("Odd code")).getByText("Reason: something_new.")).toBeTruthy();
  });

  it("shows a status, a member and a reason this console does not know yet as the API sent them", async () => {
    renderPage({ getRoutines: async () => view([routine({ member: "kit" as never, lastRun: run({ status: "paused" as never, reason: "novel", member: "kit" as never }) })],
      { paused: false, since: null, members: ["kit" as never] }) });
    await screen.findByRole("list", { name: LIST });
    const row = rowWith("Morning brief");
    expect(within(row).getByText("kit's job.")).toBeTruthy();
    expect(within(row).getByText("paused")).toBeTruthy();
    expect(within(row).getByText("Reason: novel.")).toBeTruthy();
    expect(screen.getByText(/^kit is on\./)).toBeTruthy();
  });

  it("does not break on a time the API sent that is not one: the run is said without it, and the next run as none", async () => {
    renderPage({ getRoutines: async () => view([routine({ next: "soon", lastRun: run({ instant: "yesterday" }) })], { paused: true, since: "recently", members: ["nam", "pim", "ton"] }) });
    await screen.findByRole("list", { name: LIST });
    const row = rowWith("Morning brief");
    expect(within(row).getByText("Last run.")).toBeTruthy();
    expect(within(row).getByText("No next run: everyone is paused.")).toBeTruthy();
    expect(screen.getByText("Everyone is paused.")).toBeTruthy();
  });

  it("says a shop has no routines, and where they come from, never an empty box", async () => {
    renderPage({ getRoutines: async () => view([]) });
    expect(await screen.findByText("No routines yet. A shop made from a template starts with the template's routines, each paused. Any other is made by an operator with POST /v1/admin/routines."))
      .toBeTruthy();
    expect(screen.queryByRole("list", { name: LIST })).toBeNull();
    expect(within(section("Routines for Baan Mali")).getByText("0 routines")).toBeTruthy();
    // The team is still there to see, and to pause.
    expect(screen.getByText("Everyone is on.")).toBeTruthy();
    expect(screen.getByRole("button", { name: PAUSE_TEAM })).toBeTruthy();
  });

  it("says there are no shops when there are none, and that it is loading while the shops are", () => {
    const first = renderPage({}, { shops: [] });
    expect(screen.getByText("No shops yet.")).toBeTruthy();
    expect(first.calls.getRoutines).not.toHaveBeenCalled();
    first.unmount();
    const second = renderPage({}, { shops: null });
    expect(screen.getByLabelText("Loading routines")).toBeTruthy();
    expect(second.calls.getRoutines).not.toHaveBeenCalled();
  });

  it("reads the other shop's routines when the shop is changed, and the first shop's are never shown under its name", async () => {
    const { calls } = renderPage({ getRoutines: async (tenant) => (tenant === "t1" ? view([MORNING]) : view([], TEAM_ON, "t2")) });
    await screen.findByRole("list", { name: LIST });
    fireEvent.change(screen.getByLabelText("Shop"), { target: { value: "t2" } });
    expect(await screen.findByText(/^No routines yet\./)).toBeTruthy();
    expect(calls.getRoutines.mock.calls).toEqual([["t1"], ["t2"]]);
    expect(screen.getByRole("heading", { level: 2, name: "Routines for Sabai Tea" })).toBeTruthy();
    expect(screen.queryByText("Morning brief")).toBeNull();
  });

  it("starts on the shop chosen in the side menu, or the first when none is", async () => {
    const first = renderPage({}, { tenant: "t2" });
    await waitFor(() => expect(first.calls.getRoutines).toHaveBeenCalledWith("t2"));
    expect((screen.getByLabelText("Shop") as HTMLSelectElement).value).toBe("t2");
    first.unmount();
    const second = renderPage({}, { tenant: null });
    await waitFor(() => expect(second.calls.getRoutines).toHaveBeenCalledWith("t1"));
  });
});

describe("the team on the Routines page", () => {
  it("says everyone is on, and who is", async () => {
    renderPage();
    await screen.findByRole("list", { name: LIST });
    const team = section("Team for Baan Mali");
    expect(within(team).getByText("Everyone is on.")).toBeTruthy();
    expect(within(team).getByText("Nam, Pim and Ton are on.")).toBeTruthy();
    expect(within(team).getByText("On")).toBeTruthy();
    expect(within(team).getByRole("button", { name: PAUSE_TEAM }).textContent).toBe("Pause everyone");
    expect(within(team).queryByRole("button", { name: RESUME_TEAM })).toBeNull();
  });

  it("says everyone is paused and since when, what that stops, and offers Resume in place of Pause everyone", async () => {
    renderPage({ getRoutines: async () => view([MORNING], TEAM_PAUSED) });
    await screen.findByRole("list", { name: LIST });
    const team = section("Team for Baan Mali");
    expect(within(team).getByText("Everyone is paused since 08:30 today.")).toBeTruthy();
    expect(within(team).getByText("Nothing new starts for this shop: no routine runs, and a job an operator starts, or the owner's ask for a month of the books, is refused."))
      .toBeTruthy();
    expect(within(team).getByText("Paused")).toBeTruthy();
    expect(within(team).getByRole("button", { name: RESUME_TEAM }).textContent).toBe("Resume");
    expect(within(team).queryByRole("button", { name: PAUSE_TEAM })).toBeNull();
    // Every routine says why it will not run, though none of them is paused itself.
    expect(within(rowWith("Morning brief")).getByText("No next run: everyone is paused.")).toBeTruthy();
  });

  it("says since which day when everyone was paused on an earlier one", async () => {
    renderPage({ getRoutines: async () => view([MORNING], { ...TEAM_PAUSED, since: "2026-11-21T10:15:00.000Z" }) });
    await screen.findByRole("list", { name: LIST });
    expect(screen.getByText("Everyone is paused since 21 November at 17:15.")).toBeTruthy();
  });

  it("says who is off when the shop's template turned on fewer members, and that their routines do not run", async () => {
    renderPage({ getRoutines: async () => view([routine({ member: "pim", next: null })], { ...TEAM_ON, members: ["nam", "ton"] }) });
    await screen.findByRole("list", { name: LIST });
    expect(screen.getByText("Nam and Ton are on. Pim is off, because the shop's template turned on fewer members, so a routine that is their job does not run."))
      .toBeTruthy();
    expect(within(rowWith("Morning brief")).getByText("No next run: Pim is not on this shop's team.")).toBeTruthy();
  });
});

describe("what the Routines page says when it cannot read a shop's routines", () => {
  it("says so where the routines would be, offers to try again, draws no team, and reads again on Try again", async () => {
    let answer: RoutinesRead | ApiError = new ApiError(503, "routines_unavailable");
    const getRoutines = vi.fn(async () => {
      if (answer instanceof ApiError) throw answer;
      return answer;
    });
    renderPage({ getRoutines });
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("The API could not read this shop's routines, so they are not shown. Try again.");
    expect(within(section("Routines for Baan Mali")).getByRole("alert")).toBe(alert);
    // The team comes in the same answer, so nothing of it is drawn from an answer that was not got; no skeleton is left spinning.
    expect(screen.queryByRole("region", { name: "Team for Baan Mali" })).toBeNull();
    expect(screen.queryByLabelText(/^Loading the shop's/)).toBeNull();
    expect(screen.queryByRole("list", { name: LIST })).toBeNull();
    expect(screen.getAllByRole("alert")).toHaveLength(1);

    answer = view([MORNING]);
    fireEvent.click(within(alert).getByRole("button", { name: "Try again" }));
    await screen.findByRole("list", { name: LIST });
    expect(getRoutines).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByRole("region", { name: "Team for Baan Mali" })).toBeTruthy();
  });

  it("says when the API cannot be reached, in the console's usual words", async () => {
    renderPage({ getRoutines: async () => { throw new ApiError(0, "network"); } });
    expect((await screen.findByRole("alert")).textContent).toContain("Could not reach the API. Check the connection and try again.");
  });

  it("says plainly that a shop that is not a pilot shop has no routines", async () => {
    renderPage({ getRoutines: async () => { throw new ApiError(404, "shop_not_found"); } });
    expect((await screen.findByRole("alert")).textContent)
      .toContain("This is not one of the pilot's shops, so it has no routines. It may have been deleted.");
  });

  it("says once, at the top, that the API refused the key, and offers another, with nothing else saying it again", async () => {
    const onForget = vi.fn();
    renderPage({ getRoutines: async () => { throw new ApiError(403, "forbidden"); } }, { onForget });
    await screen.findByText(/The API refused the operator key/);
    expect(screen.getAllByRole("alert")).toHaveLength(1);
    expect(screen.queryByLabelText(/^Loading the shop's/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Enter another key" }));
    expect(onForget).toHaveBeenCalledTimes(1);
  });

  it("reads again on Refresh, and the key's refusal clears once the API takes it", async () => {
    let refused = true;
    const { calls } = renderPage({ getRoutines: async () => {
      if (refused) throw new ApiError(401, "unauthorized");
      return view([MORNING]);
    } });
    await screen.findByText(/The API refused the operator key/);
    refused = false;
    click("Refresh");
    await screen.findByRole("list", { name: LIST });
    expect(screen.queryByRole("alert")).toBeNull();
    expect(calls.getRoutines).toHaveBeenCalledTimes(2);
  });

  it("keeps the routines it had while a later read fails, and says the failure in their place", async () => {
    let fail = false;
    const { calls } = renderPage({ getRoutines: async () => {
      if (fail) throw new ApiError(503, "routines_unavailable");
      return view([MORNING]);
    } });
    await screen.findByRole("list", { name: LIST });
    fail = true;
    click("Refresh");
    expect((await screen.findByRole("alert")).textContent).toContain("could not read this shop's routines");
    expect(calls.getRoutines).toHaveBeenCalledTimes(2);
    expect(rowsOf(LIST)).toHaveLength(1);
  });
});

describe("pausing a routine", () => {
  it("asks in the routine's own row, in words that name what happens, and sends nothing until the operator says yes", async () => {
    const { calls } = renderPage();
    await screen.findByRole("list", { name: LIST });
    const dialog = ask(PAUSE_MORNING, "Pause Morning brief?");
    expect(rowWith("Morning brief").contains(dialog)).toBe(true);
    expect(within(dialog).getByText("Morning brief stops running at once, and nothing else about it changes. Each time it would have run, a skipped run is written down, saying the routine was paused."))
      .toBeTruthy();
    expect(calls.pauseRoutine).not.toHaveBeenCalled();
    // The other routines' rows have no question.
    expect(within(rowWith("Answer new customer messages")).queryByRole("dialog")).toBeNull();
  });

  it("says nothing of skipped runs for a stock routine, which has no clock to skip", async () => {
    renderPage();
    await screen.findByRole("list", { name: LIST });
    const dialog = ask("Pause the routine Tell me when candles run low", "Pause Tell me when candles run low?");
    expect(within(dialog).getByText("Tell me when candles run low stops running at once, and nothing else about it changes.")).toBeTruthy();
  });

  it("sends nothing when the operator keeps it, closes the question, and leaves the list as it was", async () => {
    const { calls } = renderPage();
    await screen.findByRole("list", { name: LIST });
    const dialog = ask(PAUSE_MORNING, "Pause Morning brief?");
    fireEvent.click(within(dialog).getByRole("button", { name: "Keep it on" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(calls.pauseRoutine).not.toHaveBeenCalled();
    expect(calls.getRoutines).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("pauses it on yes with exactly the tenant and the routine's id, says what happened, and reads the routines again", async () => {
    let list = [MORNING, REPLIES];
    const pauseRoutine = vi.fn(async ({ routineId }: { routineId: string }) => {
      list = list.map((one) => (one.id === routineId ? { ...one, paused: true, next: null } : one));
      return list[0]!;
    });
    const { calls } = renderPage({ getRoutines: async () => view(list), pauseRoutine });
    await screen.findByRole("list", { name: LIST });
    const dialog = ask(PAUSE_MORNING, "Pause Morning brief?");
    fireEvent.click(within(dialog).getByRole("button", { name: "Pause Morning brief" }));

    const said = await within(section("Routines for Baan Mali")).findByRole("status");
    expect(said.textContent).toBe("Paused Morning brief. It will not run until it is resumed.");
    expect(pauseRoutine).toHaveBeenCalledWith({ tenant: "t1", routineId: "rt-morning" });
    expect(Object.keys(pauseRoutine.mock.calls[0]![0]).sort()).toEqual(["routineId", "tenant"]);
    expect(screen.queryByRole("dialog")).toBeNull();
    await waitFor(() => expect(within(rowWith("Morning brief")).getByText("Paused")).toBeTruthy());
    expect(within(rowWith("Morning brief")).getByText("No next run: this routine is paused.")).toBeTruthy();
    expect(within(rowWith("Morning brief")).getByRole("button", { name: "Resume the routine Morning brief" })).toBeTruthy();
    expect(calls.getRoutines).toHaveBeenCalledTimes(2);
  });

  it("keeps the question open when the API did not answer, saying a change may or may not have been made, so it can be tried again", async () => {
    let answer: ApiError | null = new ApiError(503, "routines_unavailable");
    const pauseRoutine = vi.fn(async () => {
      if (answer) throw answer;
      return { ...MORNING, paused: true, next: null };
    });
    const { calls } = renderPage({ pauseRoutine });
    await screen.findByRole("list", { name: LIST });
    const dialog = ask(PAUSE_MORNING, "Pause Morning brief?");
    fireEvent.click(within(dialog).getByRole("button", { name: "Pause Morning brief" }));
    expect((await screen.findByRole("alert")).textContent)
      .toBe("The API could not reach this shop's routines, so nothing may have changed. Press Refresh to check, then try again.");
    // Not read again: the list the page shows is the last it knew, and the operator decides.
    expect(calls.getRoutines).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("dialog", { name: "Pause Morning brief?" })).toBeTruthy();
    expect((within(dialog).getByRole("button", { name: "Pause Morning brief" }) as HTMLButtonElement).disabled).toBe(false);

    answer = null;
    fireEvent.click(within(dialog).getByRole("button", { name: "Pause Morning brief" }));
    expect((await screen.findByRole("status")).textContent).toContain("Paused Morning brief.");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(pauseRoutine).toHaveBeenCalledTimes(2);
  });
});

describe("resuming a routine", () => {
  const RESUME_DIALOG = "Turn Draft the Friday post back on?";

  it("asks first, saying the next run is worked out from now and a skipped run is not made up, and sends nothing until yes", async () => {
    const { calls } = renderPage();
    await screen.findByRole("list", { name: LIST });
    const dialog = ask(RESUME_POST, RESUME_DIALOG);
    expect(rowWith("Draft the Friday post").contains(dialog)).toBe(true);
    expect(within(dialog).getByText("Draft the Friday post runs again from its next time, which is worked out from now. A run it skipped while it was paused is not made up."))
      .toBeTruthy();
    expect(within(dialog).getByText("Each run still reads the switches and the owner's consent first.")).toBeTruthy();
    expect(calls.resumeRoutine).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "Keep it paused" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(calls.resumeRoutine).not.toHaveBeenCalled();
  });

  it("says before anything is sent what will still keep it from running: everyone paused, its member off, a stock feed", async () => {
    renderPage({ getRoutines: async () => view([
      routine({ id: "rt-1", name: "Paused and held", paused: true, next: null, member: "pim", waitsFor: "stock_feed" }),
    ], { paused: true, since: "2026-11-23T01:30:00.000Z", members: ["nam", "ton"] }) });
    await screen.findByRole("list", { name: LIST });
    const dialog = ask("Resume the routine Paused and held", "Turn Paused and held back on?");
    expect(within(dialog).getByText(
      "Paused and held runs again from its next time, which is worked out from now. A run it skipped while it was paused is not made up. It will still not run: everyone is paused, Pim is not on this shop's team and it waits for a stock feed, which Manut AI does not have yet."))
      .toBeTruthy();
  });

  it("resumes it on yes with exactly the tenant and the routine's id, and says the next run the API worked out", async () => {
    let list = [MORNING, POST];
    const resumeRoutine = vi.fn(async ({ routineId }: { routineId: string }) => {
      const resumed = { ...POST, paused: false, next: "2026-11-27T03:00:00.000Z" };
      list = list.map((one) => (one.id === routineId ? resumed : one));
      return resumed;
    });
    const { calls } = renderPage({ getRoutines: async () => view(list), resumeRoutine });
    await screen.findByRole("list", { name: LIST });
    fireEvent.click(within(ask(RESUME_POST, RESUME_DIALOG)).getByRole("button", { name: "Resume Draft the Friday post" }));

    const said = await within(section("Routines for Baan Mali")).findByRole("status");
    expect(said.textContent).toBe("Resumed Draft the Friday post. Next run on 27 November at 10:00.");
    expect(resumeRoutine).toHaveBeenCalledWith({ tenant: "t1", routineId: "rt-post" });
    expect(Object.keys(resumeRoutine.mock.calls[0]![0]).sort()).toEqual(["routineId", "tenant"]);
    await waitFor(() => expect(within(rowWith("Draft the Friday post")).getByText("On")).toBeTruthy());
    expect(within(rowWith("Draft the Friday post")).getByText("Next run on 27 November at 10:00.")).toBeTruthy();
    expect(calls.getRoutines).toHaveBeenCalledTimes(2);
  });

  it("says why a resumed routine still has no next run, when the API worked none out", async () => {
    const { calls } = renderPage({
      getRoutines: async () => view([POST], TEAM_PAUSED),
      resumeRoutine: async () => ({ ...POST, paused: false, next: null }),
    });
    await screen.findByRole("list", { name: LIST });
    fireEvent.click(within(ask(RESUME_POST, RESUME_DIALOG)).getByRole("button", { name: "Resume Draft the Friday post" }));
    expect((await screen.findByRole("status")).textContent).toBe("Resumed Draft the Friday post. No next run: everyone is paused.");
    expect(calls.resumeRoutine).toHaveBeenCalledTimes(1);
  });
});

describe("removing a routine", () => {
  const REMOVE_DIALOG = "Remove Morning brief?";

  it("asks in the routine's own row, saying the routine, its runs and its clock go, and sends nothing until the operator says yes", async () => {
    const { calls } = renderPage();
    await screen.findByRole("list", { name: LIST });
    const dialog = ask(REMOVE_MORNING, REMOVE_DIALOG);
    expect(rowWith("Morning brief").contains(dialog)).toBe(true);
    expect(within(dialog).getByText("Morning brief, its runs and its clock go at once, and it will not run again. The audit log keeps how each of its runs ended."))
      .toBeTruthy();
    expect(within(dialog).getByText("This cannot be undone. To have it again, an operator makes it again with POST /v1/admin/routines.")).toBeTruthy();
    expect(calls.removeRoutine).not.toHaveBeenCalled();

    fireEvent.click(within(dialog).getByRole("button", { name: "Keep it" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(calls.removeRoutine).not.toHaveBeenCalled();
    expect(rowsOf(LIST)).toHaveLength(4);
    expect(calls.getRoutines).toHaveBeenCalledTimes(1);
  });

  it("removes it on yes with exactly the tenant and the routine's id, says what happened, and reads the routines again", async () => {
    let list = [MORNING, REPLIES];
    const removeRoutine = vi.fn(async ({ routineId }: { routineId: string }): Promise<RoutineRemoval> => {
      list = list.filter((one) => one.id !== routineId);
      return { removed: routineId };
    });
    const { calls } = renderPage({ getRoutines: async () => view(list), removeRoutine });
    await screen.findByRole("list", { name: LIST });
    fireEvent.click(within(ask(REMOVE_MORNING, REMOVE_DIALOG)).getByRole("button", { name: "Remove Morning brief" }));

    const said = await within(section("Routines for Baan Mali")).findByRole("status");
    expect(said.textContent).toBe("Removed Morning brief. Its runs and its clock are gone.");
    expect(removeRoutine).toHaveBeenCalledWith({ tenant: "t1", routineId: "rt-morning" });
    expect(Object.keys(removeRoutine.mock.calls[0]![0]).sort()).toEqual(["routineId", "tenant"]);
    await waitFor(() => expect(rowsOf(LIST)).toHaveLength(1));
    expect(screen.queryByText("Morning brief")).toBeNull();
    expect(within(section("Routines for Baan Mali")).getByText("1 routine")).toBeTruthy();
    expect(calls.getRoutines).toHaveBeenCalledTimes(2);
  });

  it("says the routine is already gone when another operator removed it, closes the question, and reads the list again", async () => {
    const lists = [[MORNING, REPLIES], [REPLIES]];
    const { calls } = renderPage({
      getRoutines: async () => view(lists.shift() ?? [REPLIES]),
      removeRoutine: async () => { throw new ApiError(404, "not_found"); },
    });
    await screen.findByRole("list", { name: LIST });
    fireEvent.click(within(ask(REMOVE_MORNING, REMOVE_DIALOG)).getByRole("button", { name: "Remove Morning brief" }));
    await waitFor(() => expect(calls.getRoutines).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(rowsOf(LIST)).toHaveLength(1));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByRole("alert").textContent).toBe("That routine is already gone. The list was refreshed.");
  });

  it("closes the question on a routine that is gone even when the list read again still holds it", async () => {
    // A read that lags behind the removal still lists the routine, so the row staying is no reason to leave the question open on it.
    const { calls } = renderPage({ removeRoutine: async () => { throw new ApiError(404, "not_found"); } });
    await screen.findByRole("list", { name: LIST });
    fireEvent.click(within(ask(REMOVE_MORNING, REMOVE_DIALOG)).getByRole("button", { name: "Remove Morning brief" }));
    await waitFor(() => expect(calls.getRoutines).toHaveBeenCalledTimes(2));
    expect((await screen.findByRole("alert")).textContent).toBe("That routine is already gone. The list was refreshed.");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(rowsOf(LIST)).toHaveLength(4);
  });

  it("also reads the list again when a pause or a resume finds the routine gone", async () => {
    const lists = [[MORNING, POST], [MORNING]];
    const { calls } = renderPage({
      getRoutines: async () => view(lists.shift() ?? [MORNING]),
      resumeRoutine: async () => { throw new ApiError(404, "not_found"); },
    });
    await screen.findByRole("list", { name: LIST });
    fireEvent.click(within(ask(RESUME_POST, "Turn Draft the Friday post back on?")).getByRole("button", { name: "Resume Draft the Friday post" }));
    await waitFor(() => expect(calls.getRoutines).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(rowsOf(LIST)).toHaveLength(1));
    expect(screen.getByRole("alert").textContent).toBe("That routine is already gone. The list was refreshed.");
  });

  it("says plainly that the shop is not a pilot shop when a change is refused for it, and leaves the question open without reading again", async () => {
    const { calls } = renderPage({ removeRoutine: async () => { throw new ApiError(404, "shop_not_found"); } });
    await screen.findByRole("list", { name: LIST });
    fireEvent.click(within(ask(REMOVE_MORNING, REMOVE_DIALOG)).getByRole("button", { name: "Remove Morning brief" }));
    expect((await screen.findByRole("alert")).textContent)
      .toBe("This is not one of the pilot's shops, so it has no routines. It may have been deleted.");
    expect(screen.getByRole("dialog", { name: REMOVE_DIALOG })).toBeTruthy();
    expect(calls.getRoutines).toHaveBeenCalledTimes(1);
  });

  it("says a shop's record could not be read, and that nothing was changed, when the API could not tell if it is a pilot shop", async () => {
    renderPage({ pauseRoutine: async () => { throw new ApiError(503, "shop_unavailable"); } });
    await screen.findByRole("list", { name: LIST });
    fireEvent.click(within(ask(PAUSE_MORNING, "Pause Morning brief?")).getByRole("button", { name: "Pause Morning brief" }));
    expect((await screen.findByRole("alert")).textContent)
      .toBe("The API could not read this shop's record, so it cannot say whether it is a pilot shop. Nothing was changed. Try again.");
  });

  it("says a refusal this console has no words for in the console's usual words, and keeps the question open", async () => {
    renderPage({ removeRoutine: async () => { throw new ApiError(400, "invalid_request"); } });
    await screen.findByRole("list", { name: LIST });
    fireEvent.click(within(ask(REMOVE_MORNING, REMOVE_DIALOG)).getByRole("button", { name: "Remove Morning brief" }));
    expect((await screen.findByRole("alert")).textContent).toBe("The API did not accept this (invalid_request).");
    expect(screen.getByRole("dialog", { name: REMOVE_DIALOG })).toBeTruthy();
  });

  it("offers another key when the API refuses the key on a change, and leaves the question open", async () => {
    const onForget = vi.fn();
    renderPage({ removeRoutine: async () => { throw new ApiError(403, "forbidden"); } }, { onForget });
    await screen.findByRole("list", { name: LIST });
    fireEvent.click(within(ask(REMOVE_MORNING, REMOVE_DIALOG)).getByRole("button", { name: "Remove Morning brief" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("The API refused the operator key");
    expect(screen.getByRole("dialog", { name: REMOVE_DIALOG })).toBeTruthy();
    fireEvent.click(within(alert).getByRole("button", { name: "Enter another key" }));
    expect(onForget).toHaveBeenCalledTimes(1);
  });
});

describe("pausing everyone and resuming the team", () => {
  it("asks first for the shop's team, saying what stops and that each routine keeps its own setting, and sends nothing until yes", async () => {
    const { calls } = renderPage();
    await screen.findByRole("list", { name: LIST });
    const dialog = ask(PAUSE_TEAM, "Pause everyone for Baan Mali?");
    expect(section("Team for Baan Mali").contains(dialog)).toBe(true);
    expect(within(dialog).getByText("Nothing new starts for this shop while everyone is paused: no routine runs, and a job an operator starts, or the owner's ask for a month of the books, is refused. A job already started is not stopped."))
      .toBeTruthy();
    expect(within(dialog).getByText("Each routine keeps its own setting, so Resume puts everything back as it was. A run that would have started is written down as skipped."))
      .toBeTruthy();
    expect(calls.pauseTeam).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "Keep everyone on" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(calls.pauseTeam).not.toHaveBeenCalled();
    expect(calls.getRoutines).toHaveBeenCalledTimes(1);
  });

  it("pauses everyone on yes with exactly the tenant, says so in the team's part, and reads the team and routines again", async () => {
    let team = TEAM_ON;
    const pauseTeam = vi.fn(async (_input: { tenant: string }) => (team = TEAM_PAUSED));
    const { calls } = renderPage({ getRoutines: async () => view([MORNING], team), pauseTeam });
    await screen.findByRole("list", { name: LIST });
    fireEvent.click(within(ask(PAUSE_TEAM, "Pause everyone for Baan Mali?")).getByRole("button", { name: "Pause everyone" }));

    const said = await within(section("Team for Baan Mali")).findByRole("status");
    expect(said.textContent).toBe("Paused everyone for Baan Mali. Nothing new starts until the team is resumed.");
    expect(pauseTeam).toHaveBeenCalledWith({ tenant: "t1" });
    expect(Object.keys(pauseTeam.mock.calls[0]![0])).toEqual(["tenant"]);
    await waitFor(() => expect(within(section("Team for Baan Mali")).getByText("Everyone is paused since 08:30 today.")).toBeTruthy());
    expect(within(rowWith("Morning brief")).getByText("No next run: everyone is paused.")).toBeTruthy();
    expect(calls.getRoutines).toHaveBeenCalledTimes(2);
    // The notice belongs to the team's part: the routines' part says nothing of it.
    expect(within(section("Routines for Baan Mali")).queryByRole("status")).toBeNull();
  });

  it("asks first before resuming, saying a paused routine stays paused and a skipped run is not made up, and resumes on yes", async () => {
    let team = TEAM_PAUSED;
    const resumeTeam = vi.fn(async (_input: { tenant: string }) => (team = TEAM_ON));
    const { calls } = renderPage({ getRoutines: async () => view([MORNING], team), resumeTeam });
    await screen.findByRole("list", { name: LIST });
    const dialog = ask(RESUME_TEAM, "Resume the team for Baan Mali?");
    expect(within(dialog).getByText("Routines that are on run again from their next time, and a job can be started again. A run that was skipped while everyone was paused is not made up."))
      .toBeTruthy();
    expect(within(dialog).getByText("A routine that is paused itself stays paused.")).toBeTruthy();
    expect(calls.resumeTeam).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "Resume everyone" }));

    expect((await within(section("Team for Baan Mali")).findByRole("status")).textContent)
      .toBe("Resumed the team for Baan Mali. Routines that are on run again from their next time.");
    expect(resumeTeam).toHaveBeenCalledWith({ tenant: "t1" });
    await waitFor(() => expect(within(section("Team for Baan Mali")).getByText("Everyone is on.")).toBeTruthy());
    expect(within(rowWith("Morning brief")).getByText("Next run on 24 November at 08:00.")).toBeTruthy();
  });

  it("says a team change that was refused in the team's part, and keeps the question open", async () => {
    renderPage({ pauseTeam: async () => { throw new ApiError(503, "routines_unavailable"); } });
    await screen.findByRole("list", { name: LIST });
    fireEvent.click(within(ask(PAUSE_TEAM, "Pause everyone for Baan Mali?")).getByRole("button", { name: "Pause everyone" }));
    const alert = await within(section("Team for Baan Mali")).findByRole("alert");
    expect(alert.textContent).toBe("The API could not reach this shop's routines, so nothing may have changed. Press Refresh to check, then try again.");
    expect(screen.getByRole("dialog", { name: "Pause everyone for Baan Mali?" })).toBeTruthy();
  });

  it("says plainly that the shop is not a pilot shop when the team change is refused for it", async () => {
    renderPage({ pauseTeam: async () => { throw new ApiError(404, "shop_not_found"); } });
    await screen.findByRole("list", { name: LIST });
    fireEvent.click(within(ask(PAUSE_TEAM, "Pause everyone for Baan Mali?")).getByRole("button", { name: "Pause everyone" }));
    expect((await screen.findByRole("alert")).textContent)
      .toBe("This is not one of the pilot's shops, so it has no routines. It may have been deleted.");
  });
});

describe("one change at a time", () => {
  it("sends one request however often the button is pressed before the page has drawn the first answer", async () => {
    const pending = deferred<Routine>();
    const { calls } = renderPage({ pauseRoutine: () => pending.promise });
    await screen.findByRole("list", { name: LIST });
    const dialog = ask(PAUSE_MORNING, "Pause Morning brief?");
    const yes = within(dialog).getByRole("button", { name: "Pause Morning brief" }) as HTMLButtonElement;
    // Two presses in one step, before React has drawn the first one's busy state: the page's own guard has to hold.
    act(() => {
      yes.click();
      yes.click();
    });
    await waitFor(() => expect(yes.disabled).toBe(true));
    expect(calls.pauseRoutine).toHaveBeenCalledTimes(1);
    pending.resolve({ ...MORNING, paused: true, next: null });
    await screen.findByRole("status");
    expect(calls.pauseRoutine).toHaveBeenCalledTimes(1);
  });

  it("says it is working in the button, and locks every other button on the page while it waits, the team's included", async () => {
    const pending = deferred<RoutineRemoval>();
    const { calls } = renderPage({ removeRoutine: () => pending.promise });
    await screen.findByRole("list", { name: LIST });
    const dialog = ask(REMOVE_MORNING, "Remove Morning brief?");
    fireEvent.click(within(dialog).getByRole("button", { name: "Remove Morning brief" }));
    const working = await within(dialog).findByRole("button", { name: "Removing" }) as HTMLButtonElement;
    expect(working.disabled).toBe(true);
    expect(working.getAttribute("aria-busy")).toBe("true");
    expect((within(dialog).getByRole("button", { name: "Keep it" }) as HTMLButtonElement).disabled).toBe(true);
    for (const button of screen.getAllByRole("button")) {
      if (button.getAttribute("aria-label") !== null || button.textContent === "Keep it") {
        expect((button as HTMLButtonElement).disabled, button.getAttribute("aria-label") ?? "Keep it").toBe(true);
      }
    }
    expect((screen.getByRole("button", { name: PAUSE_TEAM }) as HTMLButtonElement).disabled).toBe(true);
    expect(calls.removeRoutine).toHaveBeenCalledTimes(1);
    pending.resolve({ removed: "rt-morning" });
    await screen.findByRole("status");
    await waitFor(() => expect((screen.getByRole("button", { name: PAUSE_TEAM }) as HTMLButtonElement).disabled).toBe(false));
  });

  it("has only one question open at a time: asking another closes the first, and nothing is sent by either", async () => {
    const { calls } = renderPage();
    await screen.findByRole("list", { name: LIST });
    ask(PAUSE_MORNING, "Pause Morning brief?");
    ask(REMOVE_MORNING, "Remove Morning brief?");
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    expect(screen.queryByRole("dialog", { name: "Pause Morning brief?" })).toBeNull();
    ask(PAUSE_TEAM, "Pause everyone for Baan Mali?");
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    ask(RESUME_POST, "Turn Draft the Friday post back on?");
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    for (const call of [calls.pauseRoutine, calls.resumeRoutine, calls.removeRoutine, calls.pauseTeam, calls.resumeTeam]) {
      expect(call).not.toHaveBeenCalled();
    }
  });
});

// Through the console, the way an operator reaches it, with the practice world's own routines behind it: what the side menu offers, what
// the Shops page links to, what a change does to the list and to the audit log, and what a shop made from a template starts with.
describe("the Routines page in the console, over the practice world", () => {
  function practice() {
    sessionStorage.setItem("manut.pilot.operatorKey", "op-key-123");
    return createFakeApi({ operatorKey: readOperatorKey, now: () => NOW, webOrigin: "https://web.test", storage: localStorage });
  }

  const openRoutines = async () => fireEvent.click(await screen.findByRole("button", { name: "Routines" }));

  it("opens from the side menu beside Connections, for the shop chosen there, and going back to a shop leaves it", async () => {
    renderWithApi(<OpsConsole />, practice());
    const nav = await screen.findByRole("button", { name: "Routines" });
    const names = screen.getAllByRole("navigation", { name: "Console" })[0]!.querySelectorAll("button.nav");
    expect([...names].map((button) => button.textContent).slice(0, 9)).toEqual([
      "Shops", "Pilot gate", "Audit", "Memory", "Drafts", "People", "Model spend", "Connections", "Routines"]);
    await screen.findByRole("button", { name: "Baan Mali" });
    fireEvent.click(screen.getByRole("button", { name: "Sabai Tea" }));
    fireEvent.click(nav);
    expect(await screen.findByRole("heading", { level: 1, name: "Routines" })).toBeTruthy();
    expect(nav.getAttribute("aria-current")).toBe("page");
    expect((screen.getByLabelText("Shop") as HTMLSelectElement).value).toBe("shop_sabaitea");
    // Sabai Tea has no routines, and its team is on.
    expect(await screen.findByText(/^No routines yet\./)).toBeTruthy();
    expect(screen.getByText("Nam, Pim and Ton are on.")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Baan Mali" }));
    expect(await screen.findByRole("heading", { level: 1, name: "Baan Mali" })).toBeTruthy();
    expect(nav.getAttribute("aria-current")).toBeNull();
  });

  it("shows Baan Mali's sample routines as the practice world keeps them: every way a run can stand, a routine paused and a stock feed awaited", async () => {
    renderWithApi(<OpsConsole />, practice());
    await openRoutines();
    await screen.findByRole("list", { name: LIST });
    expect(rowsOf(LIST).map((row) => within(row).getAllByText(/^(On|Paused)$/)[0]!.textContent)).toEqual(
      ["On", "On", "On", "Paused", "On", "On"]);
    expect(within(section("Routines for Baan Mali")).getByText("6 routines, 1 paused")).toBeTruthy();
    const morning = rowWith("Morning brief");
    expect(within(morning).getByText("Every day at 08:00")).toBeTruthy();
    expect(within(morning).getByText("Next run on 24 November at 08:00.")).toBeTruthy();
    expect(within(morning).getByText("Done")).toBeTruthy();
    expect(within(rowWith("Weekly growth brief")).getByText("Failed")).toBeTruthy();
    expect(within(rowWith("Weekly growth brief")).getByText("The shop's recorded payments could not be read.")).toBeTruthy();
    expect(within(rowWith("Answer new customer messages")).getByText("No customer message was waiting.")).toBeTruthy();
    expect(within(rowWith("Answer new customer messages")).getByText("Asks the owner first.")).toBeTruthy();
    expect(within(rowWith("Draft the Friday post")).getByText("The routine was paused.")).toBeTruthy();
    expect(within(rowWith("Draft the Friday post")).getByText("No next run: this routine is paused.")).toBeTruthy();
    expect(within(rowWith("Month-end books")).getByText("Missed")).toBeTruthy();
    expect(within(rowWith("Month-end books")).getByText("Next run on 30 November at 18:00.")).toBeTruthy();
    expect(within(rowWith("Tell me when candles run low")).getByText("Has not run yet.")).toBeTruthy();
    expect(screen.getByText("Everyone is on.")).toBeTruthy();
  });

  it("pauses a routine in practice, and the list and the audit log say so, with the routine's id and not its name", async () => {
    const api = practice();
    renderWithApi(<OpsConsole />, api);
    await openRoutines();
    await screen.findByRole("list", { name: LIST });
    fireEvent.click(within(ask(PAUSE_MORNING, "Pause Morning brief?")).getByRole("button", { name: "Pause Morning brief" }));
    expect((await within(section("Routines for Baan Mali")).findByRole("status")).textContent)
      .toBe("Paused Morning brief. It will not run until it is resumed.");
    await waitFor(() => expect(within(rowWith("Morning brief")).getByText("Paused")).toBeTruthy());
    expect(within(section("Routines for Baan Mali")).getByText("6 routines, 2 paused")).toBeTruthy();
    expect((await api.listAudit("shop_baanmali", { limit: 1 })).entries[0]).toMatchObject({ action: "routine.paused", actor: { kind: "operator" },
      subject: { routineId: "rt-sample-morning-brief" } });
  });

  it("pauses everyone in practice and resumes, each row saying why it does not run while everyone is paused", async () => {
    renderWithApi(<OpsConsole />, practice());
    await openRoutines();
    await screen.findByRole("list", { name: LIST });
    fireEvent.click(within(ask(PAUSE_TEAM, "Pause everyone for Baan Mali?")).getByRole("button", { name: "Pause everyone" }));
    await waitFor(() => expect(screen.getByText("Everyone is paused since 10:00 today.")).toBeTruthy());
    for (const row of rowsOf(LIST)) expect(within(row).getByText(/^No next run: .*everyone is paused/)).toBeTruthy();
    fireEvent.click(within(ask(RESUME_TEAM, "Resume the team for Baan Mali?")).getByRole("button", { name: "Resume everyone" }));
    await waitFor(() => expect(screen.getByText("Everyone is on.")).toBeTruthy());
    expect(within(rowWith("Morning brief")).getByText("Next run on 24 November at 08:00.")).toBeTruthy();
  });

  it("removes a routine in practice, so it is not listed again, and says it is already gone when it is removed meanwhile elsewhere", async () => {
    const api = practice();
    renderWithApi(<OpsConsole />, api);
    await openRoutines();
    await screen.findByRole("list", { name: LIST });
    // Another operator removes it after this page has read the list: the page's own removal is refused as not found, then the list is read again.
    const dialog = ask(REMOVE_MORNING, "Remove Morning brief?");
    await api.removeRoutine({ tenant: "shop_baanmali", routineId: "rt-sample-morning-brief" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Remove Morning brief" }));
    expect((await screen.findByRole("alert")).textContent).toBe("That routine is already gone. The list was refreshed.");
    await waitFor(() => expect(rowsOf(LIST)).toHaveLength(5));
    expect(screen.queryByText("Morning brief")).toBeNull();
  });

  it("shows a shop made from a template with the template's routines, each paused and named for it, and its smaller team", async () => {
    const api = practice();
    await api.createShop({ name: "Sabai Snacks", ownerName: "Dao", template: "food" });
    renderWithApi(<OpsConsole />, api);
    await screen.findByRole("button", { name: "Baan Mali" });
    fireEvent.click(await screen.findByRole("button", { name: "Sabai Snacks" }));
    fireEvent.click(screen.getByRole("button", { name: "Routines" }));
    await screen.findByRole("list", { name: "Sabai Snacks's routines" });
    const rows = rowsOf("Sabai Snacks's routines");
    expect(rows).toHaveLength(4);
    await waitFor(() => expect(within(rows[0]!).getByText("Made from the Packaged food and drinks template.")).toBeTruthy());
    for (const row of rows) {
      expect(within(row).getByText("Paused")).toBeTruthy();
      expect(within(row).getByText("Has not run yet.")).toBeTruthy();
      expect(within(row).getByText("No next run: this routine is paused.")).toBeTruthy();
    }
    expect(within(rows[3]!).getByText("On the last day of the month at 18:00")).toBeTruthy();
    expect(within(rows[3]!).getByText("Asks the owner first.")).toBeTruthy();
    expect(screen.getByText("Nam and Ton are on. Pim is off, because the shop's template turned on fewer members, so a routine that is their job does not run."))
      .toBeTruthy();
  });
});
