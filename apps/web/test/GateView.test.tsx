import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ApiError, type GateShop, type PilotGate } from "../src/api";
import { createFakeApi } from "../src/api/fake";
import { GateView } from "../src/ops/GateView";
import { OpsConsole } from "../src/ops/OpsConsole";
import { readOperatorKey } from "../src/ops/operatorKey";
import { renderWithApi, stubApi } from "./helpers";

const RULES = { trialDays: 14, priceSatang: 49900, activeWindowDays: 7 };

function shop(overrides: Partial<GateShop> & Pick<GateShop, "tenant" | "name">): GateShop {
  return { trialStartedAt: null, day: null, trialEnded: false, paid: false, paidSatang: 0, activeOnDay14: "not_yet",
    ...overrides };
}

// Measured at 10:00 in Bangkok on 22 December 2026.
const BAAN_MALI = shop({ tenant: "t1", name: "Baan Mali", trialStartedAt: "2026-12-07T03:00:00.000Z", day: 16,
  trialEnded: true, paid: true, paidAt: "2026-12-21T05:00:00.000Z", paidSatang: 49900, activeOnDay14: "yes",
  lastDecisionAt: "2026-12-20T08:00:00.000Z" });
const SABAI_TEA = shop({ tenant: "t2", name: "Sabai Tea", trialStartedAt: "2026-12-06T03:00:00.000Z", day: 17,
  trialEnded: true, paidSatang: 25000, activeOnDay14: "no", lastDecisionAt: "2026-12-09T08:00:00.000Z" });
const SOM_TAM = shop({ tenant: "t3", name: "Som Tam Nua", trialStartedAt: "2026-12-14T03:00:00.000Z", day: 9,
  lastDecisionAt: "2026-12-22T02:00:00.000Z" });
const KANOM_JEEN = shop({ tenant: "t4", name: "Kanom Jeen" });

function gateOf(shops: GateShop[], cohort: PilotGate["cohort"]): PilotGate {
  return { asOf: "2026-12-22T03:00:00.000Z", rules: RULES, shops, cohort };
}

const measure = (count: number, percent: number | null, thresholdPercent: number, met: boolean) =>
  ({ count, percent, thresholdPercent, met });

function renderGate(gate: PilotGate | (() => Promise<PilotGate>), onForget = () => {}) {
  const getGate = vi.fn(typeof gate === "function" ? gate : () => Promise.resolve(gate));
  const api = stubApi({ getGate, listSubscriptionPayments: () => Promise.resolve([]) });
  renderWithApi(<GateView onForget={onForget} />, api);
  return { getGate };
}

/// Each body row of the cohort table: the shop, then its cells, as an operator reads them.
function tableRows(): string[][] {
  const table = screen.getByRole("table", { name: "Shops" });
  return within(table).getAllByRole("row").slice(1).map((row) => [
    within(row).getByRole("rowheader").textContent ?? "",
    ...within(row).getAllByRole("cell").map((cell) => cell.textContent ?? ""),
  ]);
}

describe("the Pilot gate view", () => {
  it("shows the two shares against their lines and every shop's trial, payment and activity", async () => {
    renderGate(gateOf([BAAN_MALI, SABAI_TEA, SOM_TAM, KANOM_JEEN], { counted: 2, paid: measure(1, 50, 25, true),
      active: measure(1, 50, 50, true), status: "on_track" }));

    expect(await screen.findByText("On track")).toBeTruthy();
    expect(screen.getByText("Both shares are at or above their lines, counting 2 shops.")).toBeTruthy();
    expect(screen.getByText(/Phase 1 passes when at least 25% of shops pay ฿499 after their 14 free days, and at least 50% are still active on day 14\./)).toBeTruthy();

    const paid = screen.getByRole("region", { name: "Paid ฿499" });
    expect(within(paid).getByText("50%")).toBeTruthy();
    expect(within(paid).getByText("1 of 2 shops.")).toBeTruthy();
    expect(within(paid).getByText("At or above 25%")).toBeTruthy();
    const active = screen.getByRole("region", { name: "Active on day 14" });
    expect(within(active).getByText("50%")).toBeTruthy();
    expect(within(active).getByText("At or above 50%")).toBeTruthy();
    expect(within(active).getByText("The owner decided a reply in the 7 days up to and including day 14.")).toBeTruthy();

    expect(screen.getByText("2 of 4 counted")).toBeTruthy();
    const table = screen.getByRole("table", { name: "Shops" });
    expect(within(table).getAllByRole("columnheader").map((cell) => cell.textContent)).toEqual(["Shop", "Trial started",
      "Today", "Paid", "Active on day 14", "Owner's last decision"]);
    expect(tableRows()).toEqual([
      ["Baan Mali", "7 December", "Day 16 Trial ended", "Paid 21 December", "Yes", "20 December 15:00"],
      ["Sabai Tea", "6 December", "Day 17 Trial ended", "฿250 of ฿499", "No", "9 December 15:00"],
      ["Som Tam Nua", "14 December", "Day 9 of 14", "Not yet", "Not yet", "09:00"],
      ["Kanom Jeen", "Not started", "Starts when LINE is connected", "Not yet", "Not yet", "None yet"],
    ]);
  });

  it("lists a shop its owner made in the app as not counted, past its day 14 and paid, and says when an operator added one", async () => {
    const own = shop({ tenant: "t5", name: "Khao Hom", trialStartedAt: "2026-12-07T03:00:00.000Z", day: 16, trialEnded: true,
      paid: true, paidAt: "2026-12-21T05:00:00.000Z", paidSatang: 49900, activeOnDay14: "yes", selfServe: true, inCohort: false });
    const added = shop({ tenant: "t6", name: "Baan Fon", selfServe: true, inCohort: true });
    renderGate(gateOf([BAAN_MALI, own, added], { counted: 1, paid: measure(1, 100, 25, true), active: measure(1, 100, 50, true),
      status: "on_track" }));
    expect(await screen.findByText("1 of 3 counted")).toBeTruthy();
    const rows = tableRows();
    expect(rows[0]![0]).toBe("Baan Mali");
    expect(rows[1]![0]).toBe("Khao HomMade by its ownerNot counted: its owner made it in the app, and no operator has added it. Its team waits until one doesCount it");
    expect(rows[2]![0]).toBe("Baan FonMade by its ownerCounted: an operator added itLeave it out");
    // A shop an operator made has nothing to add or leave out.
    expect(screen.queryByRole("button", { name: "Count Baan Mali in the pilot gate" })).toBeNull();
  });

  it("counts a shop its owner made when the operator adds it, reads the gate again, and says so when the change fails", async () => {
    const own = shop({ tenant: "t5", name: "Khao Hom", selfServe: true, inCohort: false });
    const left = gateOf([own], { counted: 0, paid: measure(0, null, 25, false), active: measure(0, null, 50, false),
      status: "not_enough_data" });
    const added = gateOf([{ ...own, inCohort: true }], left.cohort);
    const getGate = vi.fn().mockResolvedValueOnce(left).mockResolvedValue(added);
    const setGateCohort = vi.fn().mockRejectedValueOnce(new ApiError(503, "shop_unavailable")).mockResolvedValue({ tenant: "t5", counted: true });
    renderWithApi(<GateView onForget={() => {}} />, stubApi({ getGate, setGateCohort, listSubscriptionPayments: () => Promise.resolve([]) }));
    fireEvent.click(await screen.findByRole("button", { name: "Count Khao Hom in the pilot gate" }));
    expect(await screen.findByText("Khao Hom could not be changed. Try again.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Count Khao Hom in the pilot gate" }));
    expect(await screen.findByRole("button", { name: "Leave Khao Hom out of the pilot gate" })).toBeTruthy();
    expect(setGateCohort.mock.calls).toEqual([["t5", true], ["t5", true]]);
    expect(getGate).toHaveBeenCalledTimes(2);
    expect(screen.getByText("Counted: an operator added it")).toBeTruthy();
  });

  it("counts a shop its owner made only once an operator adds it, in practice as on the API", async () => {
    const { pilotGate } = await import("../src/api/gate");
    const ended = { name: "Khao Hom", trialStartedAt: "2026-12-07T03:00:00.000Z", decisions: ["2026-12-18T05:00:00.000Z"],
      subscriptionPayments: [] };
    const now = Date.parse("2027-01-10T03:00:00.000Z");
    const left = pilotGate([{ tenant: "t1", ...ended }, { tenant: "t2", ...ended, selfServe: true }], now);
    expect(left.shops.map((one) => [one.selfServe, one.inCohort])).toEqual([[undefined, true], [true, false]]);
    expect(left.cohort.counted).toBe(1);
    expect(pilotGate([{ tenant: "t2", ...ended, selfServe: true, addedToCohort: true }], now).cohort.counted).toBe(1);
  });

  it("says which share is under its line when the pilot is below the line", async () => {
    renderGate(gateOf([SABAI_TEA], { counted: 1, paid: measure(0, 0, 25, false), active: measure(0, 0, 50, false),
      status: "below_line" }));
    expect(await screen.findByText("Below the line")).toBeTruthy();
    expect(screen.getByText("Paying shops are under 25% and shops active on day 14 under 50%, counting 1 shop."))
      .toBeTruthy();
    const paid = screen.getByRole("region", { name: "Paid ฿499" });
    expect(within(paid).getByText("0%")).toBeTruthy();
    expect(within(paid).getByText("0 of 1 shop.")).toBeTruthy();
    expect(within(paid).getByText("Under 25%")).toBeTruthy();
    expect(within(screen.getByRole("region", { name: "Active on day 14" })).getByText("Under 50%")).toBeTruthy();
  });

  it("counts nothing until some shop's day 14 has passed, and shows no share before then", async () => {
    const none = measure(0, null, 25, false);
    renderGate(gateOf([SOM_TAM, KANOM_JEEN], { counted: 0, paid: none, active: { ...none, thresholdPercent: 50 },
      status: "not_enough_data" }));
    expect(await screen.findByText("Not enough data yet")).toBeTruthy();
    expect(screen.getByText("No shop has reached the end of day 14 yet, so nothing is counted.")).toBeTruthy();
    for (const name of ["Paid ฿499", "Active on day 14"]) {
      const tile = screen.getByRole("region", { name });
      expect(within(tile).getByText("No shops yet")).toBeTruthy();
      expect(within(tile).getByText("No shop has finished its free days.")).toBeTruthy();
      expect(within(tile).queryByText(/^(Under|At or above) /)).toBeNull();
    }
    expect(screen.getByText("0 of 2 counted")).toBeTruthy();
  });

  it("says the gate was not measured rather than show a cohort with a shop left out, and tries again", async () => {
    let calls = 0;
    const { getGate } = renderGate(() => {
      calls += 1;
      return calls === 1 ? Promise.reject(new ApiError(503, "gate_unavailable")) : Promise.resolve(gateOf([KANOM_JEEN],
        { counted: 0, paid: measure(0, null, 25, false), active: measure(0, null, 50, false), status: "not_enough_data" }));
    });
    expect((await screen.findByRole("alert")).textContent).toMatch(
      /The API could not read every shop's records, so it did not measure the gate rather than leave a shop out\./);
    expect(screen.queryByRole("table")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("Not enough data yet")).toBeTruthy();
    expect(getGate).toHaveBeenCalledTimes(2);
  });

  it("offers another key when the API refuses this one", async () => {
    const onForget = vi.fn();
    renderGate(() => Promise.reject(new ApiError(403, "forbidden")), onForget);
    expect((await screen.findByRole("alert")).textContent).toMatch(/The API refused the operator key/);
    fireEvent.click(screen.getByRole("button", { name: "Enter another key" }));
    expect(onForget).toHaveBeenCalled();
  });
});

describe("the Pilot gate in the console", () => {
  // Practice mode's world is made at 10:00 in Bangkok on 23 November, Baan Mali's day 14. A day later its day 14
  // has passed: Fon was active on it but has not paid.
  const MADE = Date.parse("2026-11-23T03:00:00Z");
  const NEXT_DAY = Date.parse("2026-11-24T03:00:00Z");

  /// The console on the Pilot gate, a day after practice mode's world was made.
  async function openGate() {
    sessionStorage.setItem("manut.pilot.operatorKey", "op-key-123");
    let now = MADE;
    const api = createFakeApi({ operatorKey: readOperatorKey, now: () => now, webOrigin: "https://web.test" });
    now = NEXT_DAY;
    const record = vi.spyOn(api, "recordSubscriptionPayment");
    renderWithApi(<OpsConsole />, api);
    const nav = await screen.findByRole("button", { name: "Pilot gate" });
    fireEvent.click(nav);
    expect(await screen.findByText("Below the line")).toBeTruthy();
    const form = screen.getByRole("form", { name: "Record a subscription payment" });
    return { api, record, nav, form };
  }

  it("opens from the side menu on Baan Mali past its day 14: active, not yet paid, below the line", async () => {
    const { nav, form } = await openGate();
    expect(nav.getAttribute("aria-current")).toBe("page");
    expect(screen.getByRole("heading", { level: 1, name: "Pilot gate" })).toBeTruthy();
    expect(screen.getByText("Paying shops are under 25%, counting 1 shop.")).toBeTruthy();
    expect(tableRows()[0]).toEqual(["Baan Mali", "10 November", "Day 15 Trial ended", "Not yet", "Yes", "23 November 05:18"]);
    // Customers' order payments stay in each shop's PromptPay tab: this form is the shop paying Manut AI.
    expect(screen.queryByRole("tab", { name: "PromptPay" })).toBeNull();
    expect((within(form).getByLabelText("Shop") as HTMLSelectElement).value).toBe("shop_baanmali");
    expect((within(form).getByLabelText("Amount in baht") as HTMLInputElement).value).toBe("499");
    const list = within(form.parentElement!).getByRole("region", { name: "Baan Mali's payments to Manut AI" });
    expect(await within(list).findByText("None recorded yet.")).toBeTruthy();
  });

  it("records Baan Mali's payment against a slip, counts it, and refuses the same slip again", async () => {
    const { api, record, form } = await openGate();
    // Nothing leaves without a slip reference and an amount in baht.
    fireEvent.change(within(form).getByLabelText("Amount in baht"), { target: { value: "4.995" } });
    fireEvent.click(within(form).getByRole("button", { name: "Record payment" }));
    expect(within(form).getByText("Write the amount in baht, like 499 or 499.50.")).toBeTruthy();
    expect(within(form).getByText("Write the reference printed on the slip.")).toBeTruthy();
    expect(record).not.toHaveBeenCalled();

    fireEvent.change(within(form).getByLabelText("Amount in baht"), { target: { value: "499" } });
    fireEvent.change(within(form).getByLabelText("Slip reference"), { target: { value: " KB-20261124-0001 " } });
    fireEvent.change(within(form).getByLabelText("Note (optional)"), { target: { value: "KBank 09:41" } });
    fireEvent.click(within(form).getByRole("button", { name: "Record payment" }));
    expect((await within(form).findByRole("status")).textContent).toBe(
      "Recorded ฿499 from Baan Mali, slip KB-20261124-0001.");
    expect(record).toHaveBeenCalledWith({ tenant: "shop_baanmali", amountSatang: 49900, slipRef: "KB-20261124-0001",
      slipNote: "KBank 09:41" });
    const list = within(form.parentElement!).getByRole("region", { name: "Baan Mali's payments to Manut AI" });
    expect(await within(list).findByText("฿499, slip KB-20261124-0001")).toBeTruthy();
    // The gate measures again: Baan Mali has paid, and both shares meet their lines.
    expect(await screen.findByText("On track")).toBeTruthy();
    expect(tableRows()[0]?.[3]).toBe("Paid 24 November");

    fireEvent.change(within(form).getByLabelText("Slip reference"), { target: { value: "kb-20261124-0001" } });
    fireEvent.click(within(form).getByRole("button", { name: "Record payment" }));
    expect((await within(form).findByRole("alert")).textContent).toBe(
      "This slip is already recorded for Baan Mali. Nothing was recorded again.");
    expect(await api.listSubscriptionPayments("shop_baanmali")).toHaveLength(1);
  });

  it("shows each shop's own payments, and a shop in the side menu goes back to its messages", async () => {
    const { nav, form } = await openGate();
    fireEvent.change(within(form).getByLabelText("Shop"), { target: { value: "shop_sabaitea" } });
    const other = within(form.parentElement!).getByRole("region", { name: "Sabai Tea's payments to Manut AI" });
    expect(await within(other).findByText("None recorded yet.")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Baan Mali" }));
    expect(await screen.findByRole("region", { name: "Customer messages" })).toBeTruthy();
    expect(nav.getAttribute("aria-current")).toBeNull();
    await waitFor(() => expect(screen.getByRole("button", { name: "Baan Mali" }).getAttribute("aria-current")).toBe("page"));
  });
});
