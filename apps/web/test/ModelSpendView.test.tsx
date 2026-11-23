import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ApiError, type ModelCall, type ModelCap, type ModelUsage, type NewModelCap, type Shop } from "../src/api";
import { createFakeApi } from "../src/api/fake";
import { ModelSpendView } from "../src/ops/ModelSpendView";
import { OpsConsole } from "../src/ops/OpsConsole";
import { readOperatorKey } from "../src/ops/operatorKey";
import { deferred, renderWithApi, stubApi } from "./helpers";

const NOW = Date.parse("2026-11-23T03:00:00Z");

const SHOPS: Shop[] = [
  { tenant: "t1", name: "Baan Mali", ownerName: "Fon", lineConnectionId: "line_1", consent: true },
  { tenant: "t2", name: "Sabai Tea", ownerName: "Dao", consent: false },
];

const NONE = { ok: 0, failed: 0, unreadable: 0, abandoned: 0, refused: 0 };
const OVERRIDE = { capSatang: 30000, setAt: "2026-11-18T03:00:00.000Z", setBy: "ops@manut.test" };

/// Baan Mali's month as the sample world has it: ฿186 spent and ฿0.59 held, for one call in progress, of an operator's
/// ฿300 cap.
function usage(overrides: Partial<ModelUsage> = {}): ModelUsage {
  return {
    tenant: "t1", month: "2026-11", capSatang: 30000, capSource: "override", capOverride: OVERRIDE,
    spentSatang: 18600, spentMillisatang: 18_599_456, heldSatang: 59, heldMillisatang: 58_800, remainingSatang: 11341,
    counts: { ok: 49, failed: 1, unreadable: 0, abandoned: 0, refused: 0 }, tokens: { input: 935_200, output: 89_780 },
    calls: [],
    holds: [{ callId: "call-held", model: "claude-sonnet-5-5", worstMillisatang: 58_800, at: "2026-11-23T02:59:00.000Z",
      expiresAt: "2026-11-23T03:14:00.000Z" }],
    ...overrides,
  };
}

/// A month with nothing in it, on the default cap.
function empty(overrides: Partial<ModelUsage> = {}): ModelUsage {
  return usage({ capSatang: 20000, capSource: "default", capOverride: null, spentSatang: 0, spentMillisatang: 0,
    heldSatang: 0, heldMillisatang: 0, remainingSatang: 20000, counts: NONE, tokens: { input: 0, output: 0 }, calls: [],
    holds: [], ...overrides });
}

function call(n: number, overrides: Partial<ModelCall> = {}): ModelCall {
  return { id: `call-${n}`, at: "2026-11-20T05:05:00.000Z", model: "claude-sonnet-5-5", inputTokens: 2800,
    outputTokens: 560, millisatang: 39_200, satang: 40, outcome: "ok", ...overrides };
}

type Options = {
  set?: (input: NewModelCap) => Promise<ModelCap>;
  onForget?: () => void;
  shops?: Shop[] | null;
  tenant?: string | null;
};

function renderPage(read: (tenant: string, month?: string) => Promise<ModelUsage>, options: Options = {}) {
  const getModelUsage = vi.fn(read);
  const setModelCap = vi.fn(options.set ?? (() => Promise.reject(new Error("unexpected call: setModelCap"))));
  renderWithApi(
    <ModelSpendView
      shops={options.shops === undefined ? SHOPS : options.shops}
      tenant={options.tenant === undefined ? "t1" : options.tenant}
      onForget={options.onForget ?? (() => {})}
    />,
    stubApi({ getModelUsage, setModelCap }),
  );
  return { getModelUsage, setModelCap };
}

const tile = (name: string) => screen.getByRole("region", { name });

describe("the Model spend page", () => {
  it("shows a skeleton while the month loads, then the figures, and asks for the current month by not naming one", async () => {
    const month = deferred<ModelUsage>();
    const { getModelUsage } = renderPage(() => month.promise);

    expect(screen.getByRole("heading", { name: "Model spend" })).toBeTruthy();
    expect(screen.getByLabelText("Loading model spend")).toBeTruthy();
    expect(screen.queryByRole("region", { name: "Spent" })).toBeNull();
    month.resolve(usage());
    await screen.findByRole("region", { name: "Spent" });
    expect(screen.queryByLabelText("Loading model spend")).toBeNull();
    expect(getModelUsage).toHaveBeenCalledTimes(1);
    expect(getModelUsage).toHaveBeenCalledWith("t1", undefined);
  });

  it("shows what was spent, what is held, what is left and the cap, and warns when more than half is used", async () => {
    renderPage(async () => usage());

    const month = await screen.findByRole("region", { name: "November 2026" });
    expect(within(month).getByText("Over half of the cap")).toBeTruthy();
    expect(within(month).getByText("62% of the cap is used")).toBeTruthy();
    const bar = within(month).getByRole("progressbar", { name: "62% of the cap is used" });
    expect(bar.getAttribute("aria-valuenow")).toBe("62");
    expect(bar.getAttribute("aria-valuemin")).toBe("0");
    expect(bar.getAttribute("aria-valuemax")).toBe("100");

    expect(within(tile("Spent")).getByText("฿186")).toBeTruthy();
    expect(within(tile("Spent")).getByText("935,200 tokens in, 89,780 out.")).toBeTruthy();
    expect(within(tile("Held for calls in progress")).getByText("฿0.59")).toBeTruthy();
    expect(within(tile("Held for calls in progress")).getByText("1 call in progress, counted at its worst case.")).toBeTruthy();
    expect(within(tile("Left")).getByText("฿113.41")).toBeTruthy();
    expect(within(tile("Monthly cap")).getByText("฿300")).toBeTruthy();
    expect(within(tile("Monthly cap")).getByText("Set by ops@manut.test on 18 November at 10:00.")).toBeTruthy();
    expect(within(month).getByText("50 calls made, 0 refused at the cap.")).toBeTruthy();
    expect(within(month).getByText("Of these, 1 failed (not charged).")).toBeTruthy();
  });

  it("writes every amount with thousands grouped and satang to two places, whole baht plain", async () => {
    renderPage(async () => usage({ capSatang: 1_000_000_000, capOverride: { ...OVERRIDE, capSatang: 1_000_000_000 },
      spentSatang: 123_456, heldSatang: 5, heldMillisatang: 4_100, remainingSatang: 999_876_539 }));

    await screen.findByRole("region", { name: "Spent" });
    expect(within(tile("Spent")).getByText("฿1,234.56")).toBeTruthy();
    expect(within(tile("Held for calls in progress")).getByText("฿0.05")).toBeTruthy();
    expect(within(tile("Left")).getByText("฿9,998,765.39")).toBeTruthy();
    expect(within(tile("Monthly cap")).getByText("฿10,000,000")).toBeTruthy();
  });

  it.each([
    ["under half", usage({ spentSatang: 5000, spentMillisatang: 5_000_000, heldSatang: 0, heldMillisatang: 0, holds: [],
      remainingSatang: 25000 }), "Under half of the cap", "16% of the cap is used", "No calls in progress."],
    ["over half", usage(), "Over half of the cap", "62% of the cap is used", "1 call in progress, counted at its worst case."],
  ])("tags a month that is %s, with the share of the cap it has used", async (_name, month, tag, used, held) => {
    renderPage(async () => month);
    const panel = await screen.findByRole("region", { name: "November 2026" });
    expect(within(panel).getByText(tag)).toBeTruthy();
    expect(within(panel).getByText(used)).toBeTruthy();
    expect(within(tile("Held for calls in progress")).getByText(held)).toBeTruthy();
  });

  it("says there is no spend yet, and still shows the cap and the form", async () => {
    renderPage(async () => empty());

    const month = await screen.findByRole("region", { name: "November 2026" });
    expect(within(month).getByText("No spend yet")).toBeTruthy();
    expect(within(month).getByText("No model calls yet this month.")).toBeTruthy();
    expect(within(month).getByText("0 calls made, 0 refused at the cap.")).toBeTruthy();
    expect(within(month).getByRole("progressbar").getAttribute("aria-valuenow")).toBe("0");
    expect(within(tile("Spent")).getByText("฿0")).toBeTruthy();
    expect(within(tile("Left")).getByText("฿200")).toBeTruthy();
    expect(within(tile("Monthly cap")).getByText("฿200")).toBeTruthy();
    expect(within(tile("Monthly cap")).getByText("The default. No operator has set one for this shop.")).toBeTruthy();
    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.getByLabelText("New monthly cap in baht")).toBeTruthy();
  });

  it("says the cap is reached, however that came about, and what it means for the next call", async () => {
    renderPage(async () => usage({ spentSatang: 29900, spentMillisatang: 29_899_100, heldSatang: 100, heldMillisatang: 99_000,
      remainingSatang: 0 }));
    let month = await screen.findByRole("region", { name: "November 2026" });
    expect(within(month).getByText("At the cap")).toBeTruthy();
    expect(within(month).getByText("New calls are refused until the cap is raised or the month turns.")).toBeTruthy();
    expect(within(month).getByRole("progressbar").getAttribute("aria-valuenow")).toBe("100");
    expect(within(tile("Left")).getByText("฿0")).toBeTruthy();
  });

  it("reads a cap lowered under the spend as at the cap, with the bar full and nothing left", async () => {
    renderPage(async () => usage({ capSatang: 10000, capOverride: { ...OVERRIDE, capSatang: 10000 }, remainingSatang: 0 }));
    const month = await screen.findByRole("region", { name: "November 2026" });
    expect(within(month).getByText("At the cap")).toBeTruthy();
    expect(within(month).getByRole("progressbar").getAttribute("aria-valuenow")).toBe("100");
    expect(within(tile("Monthly cap")).getByText("฿100")).toBeTruthy();
    expect(within(tile("Spent")).getByText("฿186")).toBeTruthy();
    expect(within(tile("Left")).getByText("฿0")).toBeTruthy();
  });

  it("says a zero cap refuses every call, before anything is spent", async () => {
    renderPage(async () => empty({ capSatang: 0, capSource: "override", capOverride: { ...OVERRIDE, capSatang: 0 },
      remainingSatang: 0 }));
    const month = await screen.findByRole("region", { name: "November 2026" });
    expect(within(month).getByText("At the cap")).toBeTruthy();
    expect(within(month).getByText("The cap is ฿0, so every call is refused.")).toBeTruthy();
    expect(within(tile("Monthly cap")).getByText("฿0")).toBeTruthy();
  });

  it("names the setting when the gateway is not set up, shows no figures, and reads again on request", async () => {
    let answer: ModelUsage | ApiError = new ApiError(503, "not_configured", undefined, { setting: "MODEL_DEFAULT_CAP_SATANG" });
    const { getModelUsage } = renderPage(async () => {
      if (answer instanceof ApiError) throw answer;
      return answer;
    });

    expect((await screen.findByRole("alert")).textContent).toContain(
      "The model gateway is not set up: the API setting MODEL_DEFAULT_CAP_SATANG is missing or cannot be read. Ask whoever deploys the API to fix it, then try again.");
    expect(screen.queryByRole("region", { name: "Spent" })).toBeNull();
    expect(screen.queryByLabelText("New monthly cap in baht")).toBeNull();
    expect(screen.queryByLabelText("Loading model spend")).toBeNull();

    answer = usage();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await screen.findByRole("region", { name: "Spent" });
    expect(screen.queryByRole("alert")).toBeNull();
    expect(getModelUsage).toHaveBeenCalledTimes(2);
  });

  it("says when the meter cannot be read, and reads again from Refresh as well as Try again", async () => {
    let answer: ModelUsage | ApiError = new ApiError(503, "meter_unavailable");
    const { getModelUsage } = renderPage(async () => {
      if (answer instanceof ApiError) throw answer;
      return answer;
    });

    expect((await screen.findByRole("alert")).textContent)
      .toContain("The API could not read this shop's model meter, so no spend is shown. Try again.");
    answer = usage();
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await screen.findByRole("region", { name: "Spent" });
    expect(screen.queryByRole("alert")).toBeNull();
    expect(getModelUsage).toHaveBeenCalledTimes(2);
  });

  it("offers another key when the API refuses this one, and the console's words for any other answer", async () => {
    let answer = new ApiError(403, "forbidden");
    const onForget = vi.fn();
    renderPage(async () => {
      throw answer;
    }, { onForget });

    expect((await screen.findByRole("alert")).textContent).toContain("The API refused the operator key");
    fireEvent.click(screen.getByRole("button", { name: "Enter another key" }));
    expect(onForget).toHaveBeenCalledTimes(1);

    answer = new ApiError(0, "network");
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await screen.findByText("Could not reach the API. Check the connection and try again.");
  });

  it("says there are no shops when there are none, and waits while the shops themselves load", async () => {
    const { getModelUsage } = renderPage(async () => usage(), { shops: [], tenant: null });
    expect(await screen.findByText("No shops yet.")).toBeTruthy();
    expect(screen.queryByLabelText("Shop")).toBeNull();
    expect(getModelUsage).not.toHaveBeenCalled();
  });

  it("waits with a skeleton while the shop list loads, and reads nothing until it has a shop", async () => {
    const { getModelUsage } = renderPage(async () => usage(), { shops: null, tenant: null });
    expect(screen.getByLabelText("Loading model spend")).toBeTruthy();
    expect(getModelUsage).not.toHaveBeenCalled();
  });

  it("reads another shop or another month, keeps the month when the shop changes, and goes back to this month", async () => {
    const { getModelUsage } = renderPage(async (tenant, month) =>
      tenant === "t2" ? empty({ tenant: "t2", month: month ?? "2026-11" }) : usage({ month: month ?? "2026-11" }));

    await screen.findByRole("region", { name: "November 2026" });
    const months = screen.getByLabelText("Month") as HTMLSelectElement;
    // This month, then the eleven before it, counted from the month the API answered for.
    expect([...months.options].map((option) => option.textContent)).toEqual(["This month", "October 2026",
      "September 2026", "August 2026", "July 2026", "June 2026", "May 2026", "April 2026", "March 2026", "February 2026",
      "January 2026", "December 2025"]);
    expect(months.value).toBe("");

    fireEvent.change(months, { target: { value: "2026-10" } });
    await screen.findByRole("region", { name: "October 2026" });
    expect(getModelUsage).toHaveBeenLastCalledWith("t1", "2026-10");

    fireEvent.change(screen.getByLabelText("Shop"), { target: { value: "t2" } });
    await waitFor(() => expect(getModelUsage).toHaveBeenLastCalledWith("t2", "2026-10"));
    await screen.findByText("No model calls in October 2026.");

    fireEvent.change(months, { target: { value: "" } });
    await waitFor(() => expect(getModelUsage).toHaveBeenLastCalledWith("t2", undefined));
    await screen.findByText("No model calls yet this month.");
    expect((screen.getByLabelText("Shop") as HTMLSelectElement).value).toBe("t2");
  });

  it("speaks of a month that is over in the past tense, and says its cap is today's, since the API keeps no history", async () => {
    const PAST_NOTE = "The cap and what is left use the shop's cap as it is now. The API does not keep what the cap was in an earlier month.";
    renderPage(async (_tenant, month) => usage({ month: month ?? "2026-11", remainingSatang: 0 }));
    await screen.findByRole("region", { name: "November 2026" });
    expect(screen.getByText("New calls are refused until the cap is raised or the month turns.")).toBeTruthy();
    expect(screen.queryByText(PAST_NOTE)).toBeNull();
    fireEvent.change(screen.getByLabelText("Month"), { target: { value: "2026-10" } });
    await screen.findByRole("region", { name: "October 2026" });
    expect(screen.getByText("That month's spend and holds reached the cap.")).toBeTruthy();
    expect(screen.getByText(PAST_NOTE)).toBeTruthy();
    expect(screen.queryByText("New calls are refused until the cap is raised or the month turns.")).toBeNull();
    // Back on this month the note goes again.
    fireEvent.change(screen.getByLabelText("Month"), { target: { value: "" } });
    await screen.findByRole("region", { name: "November 2026" });
    expect(screen.queryByText(PAST_NOTE)).toBeNull();
  });

  it("starts on the shop chosen in the side menu", async () => {
    const { getModelUsage } = renderPage(async (tenant) => usage({ tenant }), { tenant: "t2" });
    await screen.findByRole("region", { name: "Spent" });
    expect(getModelUsage).toHaveBeenCalledWith("t2", undefined);
    expect((screen.getByLabelText("Shop") as HTMLSelectElement).value).toBe("t2");
  });

  it("lists the month's calls as the API sent them, with tokens, cost and how each ended", async () => {
    renderPage(async () => usage({ calls: [
      call(4, { at: "2026-11-20T05:05:00.000Z", model: "claude-opus-5-5", inputTokens: 52_000, outputTokens: 5_200,
        millisatang: 1_092_000, satang: 1092 }),
      call(3, { at: "2026-11-20T04:00:00.000Z", model: "claude-haiku-5-5", inputTokens: 0, outputTokens: 0, millisatang: 0,
        satang: 0, outcome: "failed" }),
      call(2, { at: "2026-11-20T03:00:00.000Z", inputTokens: 0, outputTokens: 0, millisatang: 58_800, satang: 59,
        outcome: "unreadable" }),
      call(1, { at: "2026-11-19T03:00:00.000Z", outcome: "brand_new" }),
    ] }));

    const table = await screen.findByRole("table", { name: "Baan Mali's model calls in November 2026" });
    expect(within(table).getAllByRole("columnheader").map((cell) => cell.textContent))
      .toEqual(["When", "Model", "Tokens", "Cost", "How it ended"]);
    const rows = within(table).getAllByRole("row").slice(1)
      .map((row) => within(row).getAllByRole("cell").map((cell) => cell.textContent));
    expect(rows).toEqual([
      ["20 November 12:05", "claude-opus-5-5", "52,000 in, 5,200 out", "฿10.92", "Done"],
      ["20 November 11:00", "claude-haiku-5-5", "0 in, 0 out", "฿0", "Failed, not charged"],
      ["20 November 10:00", "claude-sonnet-5-5", "0 in, 0 out", "฿0.59", "Worst case charged"],
      ["19 November 10:00", "claude-sonnet-5-5", "2,800 in, 560 out", "฿0.40", "brand_new"],
    ]);
    expect(screen.getByText("Each cost is rounded up to a whole satang, so the rows can add up to a little more than the month's spend.")).toBeTruthy();
    // 4 of the 50 calls: the API lists only the newest 200, so the page says when the list is not the whole month.
    expect(screen.getByText("Showing the newest 4 of 50 calls.")).toBeTruthy();
  });

  it("does not say the list is partial when it holds every call of the month", async () => {
    renderPage(async () => usage({ counts: { ...NONE, ok: 2, failed: 1 }, calls: [call(3), call(2), call(1, { outcome: "failed" })] }));
    await screen.findByRole("table");
    expect(screen.queryByText(/Showing the newest/)).toBeNull();
  });

  it("copes with an answer that leaves out the calls and the holds, saying only what it knows", async () => {
    const { calls: _calls, holds: _holds, ...bare } = usage();
    renderPage(async () => bare);

    await screen.findByRole("region", { name: "Spent" });
    expect(screen.queryByRole("table")).toBeNull();
    expect(within(tile("Held for calls in progress")).getByText("฿0.59")).toBeTruthy();
    expect(within(tile("Held for calls in progress")).getByText("Calls in progress, counted at their worst case.")).toBeTruthy();
  });
});

describe("the Model spend page's cap form", () => {
  /// Set at 10:00 on 18 November, a day this suite never runs on, so the page words the time the same way every day.
  const SET: ModelCap = { tenant: "t1", capSatang: 25050, capSource: "override",
    capOverride: { capSatang: 25050, setAt: "2026-11-18T03:00:00.000Z", setBy: "ops@manut.test" } };
  const DEFAULT_CAP: ModelCap = { tenant: "t1", capSatang: 20000, capSource: "default", capOverride: null };

  const field = () => screen.getByLabelText("New monthly cap in baht") as HTMLInputElement;
  const typeCap = (text: string) => fireEvent.change(field(), { target: { value: text } });
  const setCap = () => fireEvent.click(screen.getByRole("button", { name: "Set cap" }));

  async function open(options: Options = {}, read: () => Promise<ModelUsage> = async () => usage()) {
    const page = renderPage(read, { set: async () => SET, ...options });
    await screen.findByRole("region", { name: "Spent" });
    return page;
  }

  it("sets a cap typed in baht, confirms what the API answered, clears the field and reads the month again", async () => {
    const { getModelUsage, setModelCap } = await open();

    typeCap("250.50");
    setCap();
    expect((await screen.findByRole("status")).textContent).toBe(
      "The cap for Baan Mali is now ฿250.50, set by ops@manut.test on 18 November at 10:00. It applies from the next call; calls already in progress keep the budget they hold.");
    expect(setModelCap).toHaveBeenCalledTimes(1);
    expect(setModelCap).toHaveBeenCalledWith({ tenant: "t1", capSatang: 25050 });
    await waitFor(() => expect(getModelUsage).toHaveBeenCalledTimes(2));
    expect(field().value).toBe("");
  });

  it("confirms the cap the API says it wrote, not the one that was typed", async () => {
    await open({ set: async () => ({ ...SET, capSatang: 999, capOverride: { ...SET.capOverride!, capSatang: 999 } }) });
    typeCap("250");
    setCap();
    expect((await screen.findByRole("status")).textContent).toContain("The cap for Baan Mali is now ฿9.99, set by");
  });

  it.each([
    ["300", 30000],
    ["300.5", 30050],
    ["300.50", 30050],
    ["0.01", 1],
    ["฿1,250", 125000],
    ["  250  ", 25000],
    ["10000000", 1_000_000_000],
    ["10,000,000.00", 1_000_000_000],
  ])("reads %j as %i satang, from the digits as text and never through a float", async (typed, satang) => {
    const { setModelCap } = await open();
    typeCap(typed);
    setCap();
    await waitFor(() => expect(setModelCap).toHaveBeenCalledWith({ tenant: "t1", capSatang: satang }));
  });

  it("refuses what it cannot read as a cap, before anything is sent, and says how to write one", async () => {
    const { setModelCap } = await open();
    for (const bad of ["", "   ", "abc", "0", "0.00", "-5", "1.234", "1,00", "3 00", "1e3", "300 baht", "99999999999999999999"]) {
      typeCap(bad);
      setCap();
      expect(screen.getByText("Write the cap in baht, like 300 or 300.50. It must be more than ฿0.")).toBeTruthy();
      expect(field().getAttribute("aria-invalid")).toBe("true");
    }
    expect(setModelCap).not.toHaveBeenCalled();

    // A cap the API would refuse as too large is refused here first, naming the limit.
    for (const big of ["10000000.01", "10000001"]) {
      typeCap(big);
      setCap();
      expect(screen.getByText("The cap can be at most ฿10,000,000.")).toBeTruthy();
    }
    expect(setModelCap).not.toHaveBeenCalled();

    // The refusal goes when a cap that can be read is sent.
    typeCap("250");
    setCap();
    await screen.findByRole("status");
    expect(screen.queryByText("The cap can be at most ฿10,000,000.")).toBeNull();
    expect(field().getAttribute("aria-invalid")).toBeNull();
    expect(setModelCap).toHaveBeenCalledTimes(1);
  });

  it("clears an operator's override so the default applies again, and confirms from the API's answer", async () => {
    const { getModelUsage, setModelCap } = await open({ set: async () => DEFAULT_CAP });

    expect(screen.getByText("Removes this shop's own cap, so the default applies again.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Use the default cap" }));
    expect((await screen.findByRole("status")).textContent)
      .toBe("The cap for Baan Mali is now ฿200, the default. The override is cleared.");
    expect(setModelCap).toHaveBeenCalledWith({ tenant: "t1", capSatang: null });
    await waitFor(() => expect(getModelUsage).toHaveBeenCalledTimes(2));
  });

  it("has nothing to clear on a shop that already uses the default cap", async () => {
    const { setModelCap } = await open({}, async () => empty());
    const clear = screen.getByRole("button", { name: "Use the default cap" }) as HTMLButtonElement;
    expect(clear.disabled).toBe(true);
    expect(screen.getByText("This shop already uses the default cap.")).toBeTruthy();
    fireEvent.click(clear);
    expect(setModelCap).not.toHaveBeenCalled();
  });

  it("says what the API refused, keeps what was typed, and lets the operator try again", async () => {
    let refusal: ApiError | null = new ApiError(400, "invalid_request");
    const { setModelCap } = await open({
      set: async () => {
        if (refusal) throw refusal;
        return SET;
      },
    });

    typeCap("250.50");
    setCap();
    expect((await screen.findByRole("alert")).textContent).toContain("The API did not accept this (invalid_request).");
    expect(screen.queryByRole("status")).toBeNull();
    expect(field().value).toBe("250.50");
    expect((screen.getByRole("button", { name: "Set cap" }) as HTMLButtonElement).disabled).toBe(false);

    refusal = new ApiError(503, "not_configured", undefined, { setting: "MODEL_SATANG_PER_USD" });
    setCap();
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("the API setting MODEL_SATANG_PER_USD is missing or cannot be read"));

    refusal = new ApiError(503, "meter_unavailable");
    setCap();
    await waitFor(() => expect(screen.getByRole("alert").textContent)
      .toContain("The API could not confirm the cap, so it may not have changed. Check the cap shown, then try again."));

    refusal = null;
    setCap();
    await screen.findByRole("status");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(setModelCap).toHaveBeenCalledTimes(4);
  });

  it("offers another key when the API refuses the key while a cap is being set", async () => {
    const onForget = vi.fn();
    await open({ onForget, set: async () => { throw new ApiError(403, "forbidden"); } });
    typeCap("250");
    setCap();
    expect((await screen.findByRole("alert")).textContent).toContain("The API refused the operator key");
    fireEvent.click(screen.getByRole("button", { name: "Enter another key" }));
    expect(onForget).toHaveBeenCalledTimes(1);
  });

  it("sends one request at a time, and says it is working", async () => {
    const pending = deferred<ModelCap>();
    const { setModelCap } = await open({ set: () => pending.promise });

    typeCap("250");
    setCap();
    const working = await screen.findByRole("button", { name: "Setting" });
    expect(working.getAttribute("aria-busy")).toBe("true");
    expect((working as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Use the default cap" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(working);
    fireEvent.submit(field().form!);
    expect(setModelCap).toHaveBeenCalledTimes(1);

    pending.resolve(SET);
    await screen.findByRole("status");
    expect(screen.getByRole("button", { name: "Set cap" })).toBeTruthy();
    expect(setModelCap).toHaveBeenCalledTimes(1);
  });

  it("starts each shop's form afresh, with neither the typed text nor the confirmation of another shop", async () => {
    await open({}, async () => usage());
    typeCap("250");
    setCap();
    await screen.findByRole("status");
    typeCap("123");

    fireEvent.change(screen.getByLabelText("Shop"), { target: { value: "t2" } });
    await screen.findByRole("region", { name: "Spent" });
    expect(screen.queryByRole("status")).toBeNull();
    expect(field().value).toBe("");
  });
});

describe("the Model spend page in the console", () => {
  function openConsole(options: Parameters<typeof createFakeApi>[0] = {}) {
    sessionStorage.setItem("manut.pilot.operatorKey", "op-key-123");
    const api = createFakeApi({ operatorKey: readOperatorKey, now: () => NOW, webOrigin: "https://web.test", ...options });
    return renderWithApi(<OpsConsole />, api);
  }

  it("opens from the side menu and reads the chosen shop's month from the practice API", async () => {
    openConsole();

    const nav = await screen.findByRole("button", { name: "Model spend" });
    await screen.findByRole("button", { name: "Baan Mali" });
    fireEvent.click(nav);
    expect(await screen.findByRole("heading", { name: "Model spend" })).toBeTruthy();
    expect(nav.getAttribute("aria-current")).toBe("page");

    const month = await screen.findByRole("region", { name: "November 2026" });
    expect(within(month).getByText("Over half of the cap")).toBeTruthy();
    expect(within(tile("Spent")).getByText("฿186")).toBeTruthy();
    expect(within(tile("Held for calls in progress")).getByText("฿0.59")).toBeTruthy();
    expect(within(tile("Left")).getByText("฿113.41")).toBeTruthy();
    expect(within(tile("Monthly cap")).getByText("฿300")).toBeTruthy();
    expect(within(tile("Monthly cap")).getByText("Set by ops@manut.test on 18 November at 10:00.")).toBeTruthy();
    expect(within(month).getByText("50 calls made, 0 refused at the cap.")).toBeTruthy();

    const table = screen.getByRole("table", { name: "Baan Mali's model calls in November 2026" });
    expect(within(table).getAllByRole("row")).toHaveLength(51);

    // Going back to a shop leaves the page.
    fireEvent.click(screen.getByRole("button", { name: "Sabai Tea" }));
    expect(await screen.findByRole("heading", { name: "Sabai Tea" })).toBeTruthy();
    expect(nav.getAttribute("aria-current")).toBeNull();
  });

  it("shows a shop with no calls on the default cap", async () => {
    openConsole();
    fireEvent.click(await screen.findByRole("button", { name: "Model spend" }));
    await screen.findByRole("region", { name: "Spent" });

    fireEvent.change(screen.getByLabelText("Shop"), { target: { value: "shop_sabaitea" } });
    await screen.findByText("No spend yet");
    expect(screen.getByText("No model calls yet this month.")).toBeTruthy();
    expect(within(tile("Monthly cap")).getByText("฿200")).toBeTruthy();
    expect(within(tile("Monthly cap")).getByText("The default. No operator has set one for this shop.")).toBeTruthy();
  });

  it("changes a cap through the practice API, shows the new figures, and the Audit page records who did it", async () => {
    openConsole();
    fireEvent.click(await screen.findByRole("button", { name: "Model spend" }));
    await screen.findByRole("region", { name: "Spent" });

    fireEvent.change(screen.getByLabelText("New monthly cap in baht"), { target: { value: "250" } });
    fireEvent.click(screen.getByRole("button", { name: "Set cap" }));
    // The practice key has no Access identity, so the answer names nobody.
    expect((await screen.findByRole("status")).textContent)
      .toMatch(/^The cap for Baan Mali is now ฿250, set by an operator \(no Access identity\)/);
    await waitFor(() => expect(within(tile("Left")).getByText("฿63.41")).toBeTruthy());
    expect(within(tile("Monthly cap")).getByText("฿250")).toBeTruthy();
    expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("74");
    expect(within(tile("Monthly cap")).getByText(/^Set by an operator \(no Access identity\)/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Audit" }));
    const log = await screen.findByRole("list", { name: "Baan Mali's audit log" });
    expect(within(log).getByText("An operator (no Access identity) set the monthly model cap to ฿250.")).toBeTruthy();
  });

  it("clears the override it was given, which puts the shop back on the default cap", async () => {
    openConsole();
    fireEvent.click(await screen.findByRole("button", { name: "Model spend" }));
    await screen.findByRole("region", { name: "Spent" });

    fireEvent.click(screen.getByRole("button", { name: "Use the default cap" }));
    expect((await screen.findByRole("status")).textContent)
      .toBe("The cap for Baan Mali is now ฿200, the default. The override is cleared.");
    await waitFor(() => expect(within(tile("Monthly cap")).getByText("The default. No operator has set one for this shop.")).toBeTruthy());
    expect(within(tile("Left")).getByText("฿13.41")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Use the default cap" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("names the setting when the practice API's gateway settings cannot be read", async () => {
    openConsole({ modelGateway: { vars: { MODEL_DEFAULT_CAP_SATANG: "3,390" } } });
    fireEvent.click(await screen.findByRole("button", { name: "Model spend" }));
    expect((await screen.findByRole("alert")).textContent).toContain("the API setting MODEL_DEFAULT_CAP_SATANG is missing or cannot be read");
    expect(screen.queryByRole("region", { name: "Spent" })).toBeNull();
  });

  it("says the meter is unavailable when the practice API's meter is down", async () => {
    openConsole({ modelGateway: { meterUnavailable: true } });
    fireEvent.click(await screen.findByRole("button", { name: "Model spend" }));
    expect((await screen.findByRole("alert")).textContent).toContain("The API could not read this shop's model meter");
  });
});
