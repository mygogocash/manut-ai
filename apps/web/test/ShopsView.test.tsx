import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ApiError, type AuditPage, type ModelUsage, type PilotGate, type Shop } from "../src/api";
import { createFakeApi } from "../src/api/fake";
import { OpsConsole } from "../src/ops/OpsConsole";
import { readOperatorKey } from "../src/ops/operatorKey";
import { ShopsView } from "../src/ops/ShopsView";
import { deferred, renderWithApi, stubApi } from "./helpers";

const NOW = Date.parse("2026-11-23T03:00:00Z");

const SHOPS: Shop[] = [
  { tenant: "t1", name: "Baan Mali", ownerName: "Fon", lineConnectionId: "line_1", consent: true },
  { tenant: "t2", name: "Sabai Tea", ownerName: "Dao", consent: false },
];

const GATE: PilotGate = {
  asOf: "2026-11-23T03:00:00.000Z",
  rules: { trialDays: 14, priceSatang: 49900, activeWindowDays: 7 },
  shops: [
    { tenant: "t1", name: "Baan Mali", trialStartedAt: "2026-11-10T03:00:00.000Z", day: 14, trialEnded: false, paid: true,
      paidAt: "2026-11-20T03:00:00.000Z", paidSatang: 49900, activeOnDay14: "yes", lastDecisionAt: "2026-11-23T02:00:00.000Z" },
    { tenant: "t2", name: "Sabai Tea", trialStartedAt: null, day: null, trialEnded: false, paid: false, paidSatang: 20000,
      activeOnDay14: "not_yet" },
  ],
  cohort: { counted: 0, paid: { count: 0, percent: null, thresholdPercent: 25, met: false },
    active: { count: 0, percent: null, thresholdPercent: 50, met: false }, status: "not_enough_data" },
};

function usage(tenant: string, spentSatang: number, capSatang: number): ModelUsage {
  return { tenant, month: "2026-11", capSatang, capSource: "default", capOverride: null, spentSatang,
    spentMillisatang: spentSatang * 1000, heldSatang: 0, heldMillisatang: 0, remainingSatang: capSatang - spentSatang,
    counts: { ok: spentSatang > 0 ? 1 : 0, failed: 0, unreadable: 0, abandoned: 0, refused: 0 },
    tokens: { input: 0, output: 0 }, calls: [], holds: [] };
}

function audit(tenant: string, at?: string): AuditPage {
  return { tenant, entries: at ? [{ id: "aud-mi8x2k4c0-001-0a1b2c3d", at, actor: { kind: "system" }, action: "shop.created",
    subject: {}, outcome: "ok" }] : [], next: null, missed: null };
}

/// The four reads of the overview answering as the sample shops would, each a mock so a test can read the calls.
function reads(overrides: Parameters<typeof stubApi>[0] = {}) {
  return stubApi({
    getGate: vi.fn(async () => GATE),
    getModelUsage: vi.fn(async (tenant: string) => tenant === "t1" ? usage(tenant, 18600, 30000) : usage(tenant, 0, 20000)),
    listAudit: vi.fn(async (tenant: string) => tenant === "t1" ? audit(tenant, "2026-11-23T02:50:00.000Z") : audit(tenant)),
    ...overrides,
  });
}

/// Each shop's row as an operator reads it: the shop first, then the cells in order.
function table(): string[][] {
  const rows = within(screen.getByRole("table", { name: "Every shop" })).getAllByRole("row").slice(1);
  return rows.map((row) => [...within(row).getAllByRole("rowheader"), ...within(row).getAllByRole("cell")]
    .map((cell) => cell.textContent ?? ""));
}

const noop = () => {};

describe("the Shops overview", () => {
  it("opens first in the side menu and lists every shop with its trial, payment, activity, month's spend and last audit change", async () => {
    sessionStorage.setItem("manut.pilot.operatorKey", "op-key-123");
    renderWithApi(<OpsConsole />,
      createFakeApi({ operatorKey: readOperatorKey, now: () => NOW, webOrigin: "https://web.test" }));

    await screen.findByRole("button", { name: "Baan Mali" });
    const menu = within(screen.getByRole("navigation", { name: "Console" })).getAllByRole("button");
    expect(menu.slice(0, 2).map((button) => button.textContent)).toEqual(["Shops", "Pilot gate"]);
    fireEvent.click(menu[0]!);
    expect(await screen.findByRole("heading", { name: "Shops" })).toBeTruthy();
    expect(menu[0]!.getAttribute("aria-current")).toBe("page");
    await screen.findByRole("table", { name: "Every shop" });
    await waitFor(() => expect(table()[0]![4]).toContain("฿186 of ฿300"));

    const [baanMali, sabaiTea] = table();
    expect(baanMali![0]).toContain("Baan Mali");
    expect(baanMali![0]).toContain("Fon");
    expect(baanMali![1]).toBe("Day 14 of 14");
    expect(baanMali![2]).toBe("Not yet");
    expect(baanMali![3]).toBe("Yes");
    expect(baanMali![4]).toContain("฿186 of ฿300");
    expect(baanMali![4]).toContain("Over half of the cap");
    // The newest entry of the log is Fon's reply proposal, ten minutes before the practice clock.
    expect(baanMali![5]).toContain("09:50");
    expect(sabaiTea![0]).toContain("Sabai Tea");
    expect(sabaiTea![1]).toBe("Starts when LINE is connected");
    expect(sabaiTea![2]).toBe("Not yet");
    expect(sabaiTea![3]).toBe("Not yet");
    expect(sabaiTea![4]).toContain("฿0 of ฿200");
    expect(sabaiTea![4]).toContain("No spend yet");
    expect(sabaiTea![5]).toContain("10:00");
    // The gate's own words head the column, naming the trial's length.
    expect(screen.getByRole("columnheader", { name: "Active on day 14" })).toBeTruthy();
  });

  it("links each shop to its other pages, and each page opens on that shop", async () => {
    sessionStorage.setItem("manut.pilot.operatorKey", "op-key-123");
    renderWithApi(<OpsConsole />,
      createFakeApi({ operatorKey: readOperatorKey, now: () => NOW, webOrigin: "https://web.test" }));
    await screen.findByRole("button", { name: "Baan Mali" });
    const openOverview = async () => {
      fireEvent.click(screen.getByRole("button", { name: "Shops" }));
      await screen.findByRole("table", { name: "Every shop" });
    };

    await openOverview();
    fireEvent.click(screen.getByRole("button", { name: "Audit for Sabai Tea" }));
    expect(await screen.findByRole("heading", { name: "Audit" })).toBeTruthy();
    expect((screen.getByLabelText("Shop") as HTMLSelectElement).value).toBe("shop_sabaitea");

    await openOverview();
    fireEvent.click(screen.getByRole("button", { name: "Drafts for Baan Mali" }));
    expect(await screen.findByRole("heading", { name: "Drafts" })).toBeTruthy();
    expect((screen.getByLabelText("Shop") as HTMLSelectElement).value).toBe("shop_baanmali");
    await screen.findByRole("list", { name: "Baan Mali's worker jobs" });

    await openOverview();
    fireEvent.click(screen.getByRole("button", { name: "Memory for Sabai Tea" }));
    expect(await screen.findByRole("heading", { name: "Memory" })).toBeTruthy();
    expect((screen.getByLabelText("Shop") as HTMLSelectElement).value).toBe("shop_sabaitea");

    await openOverview();
    fireEvent.click(screen.getByRole("button", { name: "People for Baan Mali" }));
    expect(await screen.findByRole("heading", { name: "People" })).toBeTruthy();
    expect((screen.getByLabelText("Shop") as HTMLSelectElement).value).toBe("shop_baanmali");
    await screen.findByRole("list", { name: "Baan Mali's people" });

    await openOverview();
    fireEvent.click(screen.getByRole("button", { name: "Model spend for Baan Mali" }));
    expect(await screen.findByRole("heading", { name: "Model spend" })).toBeTruthy();
    expect((screen.getByLabelText("Shop") as HTMLSelectElement).value).toBe("shop_baanmali");

    await openOverview();
    fireEvent.click(screen.getByRole("button", { name: "Messages for Sabai Tea" }));
    expect(await screen.findByRole("heading", { name: "Sabai Tea" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Messages" }).getAttribute("aria-selected")).toBe("true");
  });

  it("reads the gate and every shop's spend and audit at once, one request each, and again on Refresh", async () => {
    const gate = deferred<PilotGate>();
    const spend = [deferred<ModelUsage>(), deferred<ModelUsage>()];
    const logs = [deferred<AuditPage>(), deferred<AuditPage>()];
    const getGate = vi.fn(() => gate.promise);
    const getModelUsage = vi.fn((tenant: string) => spend[tenant === "t1" ? 0 : 1]!.promise);
    const listAudit = vi.fn((tenant: string) => logs[tenant === "t1" ? 0 : 1]!.promise);
    renderWithApi(<ShopsView shops={SHOPS} onOpen={noop} onForget={noop} />,
      stubApi({ getGate, getModelUsage, listAudit }));

    // Nothing has answered, and every read is already on its way.
    expect(getGate).toHaveBeenCalledTimes(1);
    expect(getModelUsage.mock.calls).toEqual([["t1"], ["t2"]]);
    expect(listAudit.mock.calls).toEqual([["t1", { limit: 1 }], ["t2", { limit: 1 }]]);
    expect(screen.getByLabelText("Loading the shops overview")).toBeTruthy();

    gate.resolve(GATE);
    spend[0]!.resolve(usage("t1", 18600, 30000));
    spend[1]!.resolve(usage("t2", 0, 20000));
    logs[0]!.resolve(audit("t1", "2026-11-23T02:50:00.000Z"));
    logs[1]!.resolve(audit("t2"));
    await screen.findByRole("table", { name: "Every shop" });
    expect(screen.queryByLabelText("Loading the shops overview")).toBeNull();
    expect(table()).toHaveLength(2);

    getGate.mockImplementation(() => Promise.resolve(GATE));
    getModelUsage.mockImplementation((tenant: string) => Promise.resolve(usage(tenant, 100, 20000)));
    listAudit.mockImplementation((tenant: string) => Promise.resolve(audit(tenant)));
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(table()[0]![4]).toContain("฿1 of ฿200"));
    expect(getGate).toHaveBeenCalledTimes(2);
    expect(getModelUsage).toHaveBeenCalledTimes(4);
    expect(listAudit).toHaveBeenCalledTimes(4);
  });

  it("marks a shop its owner made in the app, so an operator sees where it came from, and no other", async () => {
    const own: Shop = { tenant: "t3", name: "Khao Hom", ownerName: "Dao", template: "food", selfServe: true, consent: false };
    const gate: PilotGate = { ...GATE, shops: [...GATE.shops, { tenant: "t3", name: "Khao Hom", trialStartedAt: null, day: null,
      trialEnded: false, paid: false, paidSatang: 0, activeOnDay14: "not_yet", selfServe: true, inCohort: false }] };
    renderWithApi(<ShopsView shops={[...SHOPS, own]} onOpen={noop} onForget={noop} />, reads({ getGate: vi.fn(async () => gate) }));
    await screen.findByRole("table", { name: "Every shop" });
    const rows = table();
    expect(rows[2]![0]).toBe("Khao HomDaoMade by its owner");
    expect(rows[0]![0]).toBe("Baan MaliFon");
    expect(rows[1]![0]).toBe("Sabai TeaDao");
    const tag = within(screen.getByRole("rowheader", { name: /Khao Hom/ })).getByText("Made by its owner");
    expect(tag.getAttribute("title")).toBe(
      "Its owner made it in the app, signed in, with no operator. The pilot gate leaves it out unless an operator adds it.");
  });

  it("says which shop could not be read, and in what, and still shows every part that was", async () => {
    const api = reads({
      getModelUsage: vi.fn(async (tenant: string) => {
        if (tenant === "t2") throw new ApiError(503, "meter_unavailable");
        return usage(tenant, 18600, 30000);
      }),
      listAudit: vi.fn(async (tenant: string) => {
        if (tenant === "t1") throw new ApiError(503, "audit_unavailable");
        return audit(tenant, "2026-11-23T02:50:00.000Z");
      }),
    });
    renderWithApi(<ShopsView shops={SHOPS} onOpen={noop} onForget={noop} />, api);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain(
      "Some shops could not be read in full: Baan Mali (audit log) and Sabai Tea (model spend). Try again.");

    const [baanMali, sabaiTea] = table();
    // Each shop shows what was read, and says what was not, in the cell it belongs to.
    expect(baanMali![4]).toContain("฿186 of ฿300");
    expect(baanMali![5]).toBe("Could not be read");
    expect(sabaiTea![4]).toBe("Could not be read");
    expect(sabaiTea![5]).toContain("09:50");
    // The gate was read, so the trial, payment and activity are still there.
    expect(baanMali![1]).toBe("Day 14 of 14");
    expect(baanMali![2]).toContain("Paid");
    expect(sabaiTea![2]).toBe("฿200 of ฿499");
    // Try again reads everything once more.
    fireEvent.click(within(alert).getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(api.getGate).toHaveBeenCalledTimes(2));
  });

  it("says when the gate could not be read, and still shows each shop's spend and audit", async () => {
    renderWithApi(<ShopsView shops={SHOPS} onOpen={noop} onForget={noop} />,
      reads({ getGate: vi.fn(async () => { throw new ApiError(503, "gate_unavailable"); }) }));
    expect((await screen.findByRole("alert")).textContent).toContain(
      "The pilot gate could not be read, so trials, payments and activity are not shown.");
    const [baanMali, sabaiTea] = table();
    expect(baanMali!.slice(1, 4)).toEqual(["Could not be read", "Could not be read", "Could not be read"]);
    expect(sabaiTea!.slice(1, 4)).toEqual(["Could not be read", "Could not be read", "Could not be read"]);
    expect(baanMali![4]).toContain("฿186 of ฿300");
    expect(baanMali![5]).toContain("09:50");
    // Without the gate the column cannot name the trial's length.
    expect(screen.getByRole("columnheader", { name: "Active" })).toBeTruthy();
    // No shop could not be read in full: only the gate failed, so only the gate is said.
    expect(screen.queryByText(/Some shops could not be read in full/)).toBeNull();
  });

  it("offers another key when the API refuses this one, instead of a table of shops that could not be read", async () => {
    const onForget = vi.fn();
    renderWithApi(<ShopsView shops={SHOPS} onOpen={noop} onForget={onForget} />,
      reads({ getGate: vi.fn(async () => { throw new ApiError(403, "forbidden"); }) }));
    await screen.findByText(/The API refused the operator key/);
    fireEvent.click(screen.getByRole("button", { name: "Enter another key" }));
    expect(onForget).toHaveBeenCalledTimes(1);
  });

  it("says there are no shops, reading nothing, and shows a busy state while the shop list itself is loading", async () => {
    // Every route fails loudly if it is reached, so reading for no shops would fail this test.
    const first = renderWithApi(<ShopsView shops={[]} onOpen={noop} onForget={noop} />, stubApi({}));
    expect(await screen.findByText("No shops yet.")).toBeTruthy();
    expect(screen.getByText(/Add a shop with POST \/v1\/admin\/pilot\/shops/)).toBeTruthy();
    expect(screen.queryByRole("table")).toBeNull();
    first.unmount();
    renderWithApi(<ShopsView shops={null} onOpen={noop} onForget={noop} />, stubApi({}));
    expect(screen.getByLabelText("Loading the shops overview")).toBeTruthy();
  });

  it("says so when the shop list itself cannot be read, and offers to try again or to enter another key", async () => {
    const onRetry = vi.fn();
    const onForget = vi.fn();
    const first = renderWithApi(
      <ShopsView shops={null} listError={new ApiError(503, "http_503")} onRetry={onRetry} onOpen={noop} onForget={onForget} />,
      stubApi({}));
    expect((await screen.findByRole("alert")).textContent).toContain("The API answered with an error (http_503).");
    expect(screen.queryByLabelText("Loading the shops overview")).toBeNull();
    expect(screen.queryByRole("table")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
    first.unmount();
    renderWithApi(
      <ShopsView shops={null} listError={new ApiError(403, "forbidden")} onRetry={onRetry} onOpen={noop} onForget={onForget} />,
      stubApi({}));
    await screen.findByText(/The API refused the operator key/);
    fireEvent.click(screen.getByRole("button", { name: "Enter another key" }));
    expect(onForget).toHaveBeenCalledTimes(1);
  });

  it("shows the shop list's failure on the overview inside the console, and reads the list again on Try again", async () => {
    sessionStorage.setItem("manut.pilot.operatorKey", "op-key-123");
    const api = createFakeApi({ operatorKey: readOperatorKey, now: () => NOW, webOrigin: "https://web.test" });
    const real = api.listShops.bind(api);
    const listShops = vi.spyOn(api, "listShops").mockRejectedValueOnce(new ApiError(503, "http_503"));
    renderWithApi(<OpsConsole />, api);
    fireEvent.click(await screen.findByRole("button", { name: "Shops" }));
    expect((await screen.findByRole("alert")).textContent).toContain("The API answered with an error (http_503).");
    listShops.mockImplementation(real);
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await screen.findByRole("table", { name: "Every shop" });
    expect(listShops).toHaveBeenCalledTimes(2);
    expect(table()).toHaveLength(2);
  });

  it("offers nothing that sends: the controls are Refresh and one link to each page of each shop", async () => {
    const { container } = renderWithApi(<ShopsView shops={SHOPS} onOpen={noop} onForget={noop} />, reads());
    await screen.findByRole("table", { name: "Every shop" });
    const pages = ["Messages", "Drafts", "Audit", "Memory", "People", "Model spend"];
    expect(screen.getAllByRole("button").map((button) => button.textContent)).toEqual(["Refresh", ...pages, ...pages]);
    expect(screen.queryByRole("button", { name: /send|post|publish|approve|propose|reply/i })).toBeNull();
    expect(container.querySelector("form, textarea, input, select")).toBeNull();
  });

  it("opens a shop's page with the shop's tenant, whichever shop's link was used", async () => {
    const onOpen = vi.fn();
    renderWithApi(<ShopsView shops={SHOPS} onOpen={onOpen} onForget={noop} />, reads());
    await screen.findByRole("table", { name: "Every shop" });
    fireEvent.click(screen.getByRole("button", { name: "Audit for Sabai Tea" }));
    fireEvent.click(screen.getByRole("button", { name: "Messages for Baan Mali" }));
    fireEvent.click(screen.getByRole("button", { name: "Drafts for Baan Mali" }));
    fireEvent.click(screen.getByRole("button", { name: "Memory for Sabai Tea" }));
    fireEvent.click(screen.getByRole("button", { name: "People for Sabai Tea" }));
    fireEvent.click(screen.getByRole("button", { name: "Model spend for Sabai Tea" }));
    expect(onOpen.mock.calls).toEqual([["t2", "audit"], ["t1", "shop"], ["t1", "drafts"], ["t2", "memory"], ["t2", "people"],
      ["t2", "model"]]);
  });
});
