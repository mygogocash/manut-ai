import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ApiError } from "../src/api";
import { createFakeApi } from "../src/api/fake";
import { OpsConsole } from "../src/ops/OpsConsole";
import { readOperatorKey } from "../src/ops/operatorKey";
import { renderWithApi } from "./helpers";

// The console's new-shop form and a shop's first week, against the practice fake: the form offers the three shop
// templates and says what each sets up, a shop made from one opens on its first-week questions, and the operator relays
// the owner's answer, which becomes a fact the owner said.

const NOW = Date.parse("2026-11-23T03:00:00Z");

function fakeApi() {
  return createFakeApi({ operatorKey: readOperatorKey, now: () => NOW, webOrigin: "https://web.test" });
}

async function newShopForm() {
  fireEvent.click(await screen.findByRole("button", { name: "New shop" }));
  return screen.findByRole("form", { name: "New shop" });
}

describe("making a shop from a template", () => {
  it("offers the three templates, says what each sets up, and opens the new shop on its first week", async () => {
    sessionStorage.setItem("manut.pilot.operatorKey", "op-key-123");
    const api = fakeApi();
    const create = vi.spyOn(api, "createShop");
    renderWithApi(<OpsConsole />, api);

    const form = await newShopForm();
    const select = within(form).getByLabelText("Start from a template") as HTMLSelectElement;
    await waitFor(() => expect(select.options).toHaveLength(4));
    expect([...select.options].map((option) => option.text)).toEqual(["No template", "Handmade and gifts",
      "Clothes and accessories", "Packaged food and drinks"]);
    expect(within(form).getByText(/Every team member on, no routines/)).toBeTruthy();

    fireEvent.change(within(form).getByLabelText("Shop's name"), { target: { value: "  Sabai Snacks " } });
    fireEvent.change(within(form).getByLabelText("Owner's name"), { target: { value: "Dao" } });
    fireEvent.change(select, { target: { value: "food" } });
    const summary = within(form).getByRole("region", { name: "What Packaged food and drinks sets up" });
    expect(within(summary).getByText("Shops selling packaged food and drinks that keep for a limited time.")).toBeTruthy();
    expect(within(summary).getByText("Turns on Nam and Ton. Buddy is always on.")).toBeTruthy();
    expect(within(summary).getByText("On the last day of the month at 18:00: Send the books to FlowAccount. Asks first."))
      .toBeTruthy();
    expect(within(summary).getByText(/Each starts paused/)).toBeTruthy();
    expect(within(summary).getByText("4 questions for Buddy to ask Dao in the first week.")).toBeTruthy();

    fireEvent.click(within(form).getByRole("button", { name: "Create shop" }));
    await waitFor(() => expect(create).toHaveBeenCalledWith({ name: "Sabai Snacks", ownerName: "Dao", template: "food" }));

    // The new shop is chosen, on its first week, and the form is gone.
    const shopButton = await screen.findByRole("button", { name: "Sabai Snacks" });
    await waitFor(() => expect(shopButton.getAttribute("aria-current")).toBe("page"));
    expect(screen.queryByRole("form", { name: "New shop" })).toBeNull();
    expect(screen.getByRole("tab", { name: "First week" }).getAttribute("aria-selected")).toBe("true");
    const list = await screen.findByRole("list", { name: "First-week questions" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(4);
    expect(within(list).getByText("How long does each product keep?")).toBeTruthy();
    expect(screen.getByText(/Made from the Packaged food and drinks template/)).toBeTruthy();
  });

  it("makes a shop with no template, which has no first week, and can be put away", async () => {
    sessionStorage.setItem("manut.pilot.operatorKey", "op-key-123");
    const api = fakeApi();
    renderWithApi(<OpsConsole />, api);

    let form = await newShopForm();
    fireEvent.click(within(form).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("form", { name: "New shop" })).toBeNull();

    form = await newShopForm();
    const create = within(form).getByRole("button", { name: "Create shop" }) as HTMLButtonElement;
    expect(create.disabled).toBe(true);
    fireEvent.change(within(form).getByLabelText("Shop's name"), { target: { value: "Plain Shop" } });
    fireEvent.change(within(form).getByLabelText("Owner's name"), { target: { value: "Fon" } });
    fireEvent.click(create);
    const shopButton = await screen.findByRole("button", { name: "Plain Shop" });
    await waitFor(() => expect(shopButton.getAttribute("aria-current")).toBe("page"));
    expect(screen.getByRole("tab", { name: "Messages" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.queryByRole("tab", { name: "First week" })).toBeNull();
    // Baan Mali, from before templates, has none either.
    fireEvent.click(screen.getByRole("button", { name: "Baan Mali" }));
    expect(screen.queryByRole("tab", { name: "First week" })).toBeNull();
  });

  it("says why a shop was not made, and makes none", async () => {
    sessionStorage.setItem("manut.pilot.operatorKey", "op-key-123");
    const api = fakeApi();
    vi.spyOn(api, "createShop").mockRejectedValueOnce(new ApiError(400, "unknown_template"));
    renderWithApi(<OpsConsole />, api);
    const form = await newShopForm();
    fireEvent.change(within(form).getByLabelText("Shop's name"), { target: { value: "Sabai Snacks" } });
    fireEvent.change(within(form).getByLabelText("Owner's name"), { target: { value: "Dao" } });
    fireEvent.click(within(form).getByRole("button", { name: "Create shop" }));
    expect((await within(form).findByRole("alert")).textContent).toMatch(/does not know that template/);
    expect(screen.queryByRole("button", { name: "Sabai Snacks" })).toBeNull();
  });
});

describe("a shop's first week", () => {
  it("relays the owner's answer, which becomes a fact the owner said", async () => {
    sessionStorage.setItem("manut.pilot.operatorKey", "op-key-123");
    const api = fakeApi();
    const { tenant } = await api.createShop({ name: "Baan Mali Two", ownerName: "Fon", template: "handmade" });
    const answer = vi.spyOn(api, "answerQuestion");
    renderWithApi(<OpsConsole />, api);

    fireEvent.click(await screen.findByRole("button", { name: "Baan Mali Two" }));
    fireEvent.click(await screen.findByRole("tab", { name: "First week" }));
    const list = await screen.findByRole("list", { name: "First-week questions" });
    const first = within(list).getAllByRole("listitem")[0]!;
    expect(within(first).getByText("What is your price list?")).toBeTruthy();
    const box = within(first).getByLabelText("Fon's answer");
    const save = within(first).getByRole("button", { name: "Save answer" }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.change(box, { target: { value: "  Candles are ฿290 and soap bars ฿120.  " } });
    expect(within(first).getByText(/36 of 280 characters/)).toBeTruthy();
    fireEvent.click(save);

    await within(list).findByText("Candles are ฿290 and soap bars ฿120.");
    expect(answer).toHaveBeenCalledWith({ tenant, questionId: "q1", text: "Candles are ฿290 and soap bars ฿120." });
    // In what the team knows, as the owner's own.
    expect((await api.getMemory(tenant)).facts).toEqual([expect.objectContaining({
      text: "Candles are ฿290 and soap bars ฿120.", status: "confirmed", source: { kind: "owner" } })]);

    // The same words for another question: the team already knows them, and says so in that question's row.
    const second = within(list).getAllByRole("listitem")[1]!;
    fireEvent.change(within(second).getByLabelText("Fon's answer"), { target: { value: "Candles are ฿290 and soap bars ฿120." } });
    fireEvent.click(within(second).getByRole("button", { name: "Save answer" }));
    expect((await within(second).findByRole("alert")).textContent).toMatch(/already knows exactly this/);
  });
});
