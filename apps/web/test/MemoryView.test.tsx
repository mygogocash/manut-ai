import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ApiError, type Fact, type Memory, type PilotApi, type Shop } from "../src/api";
import { createFakeApi } from "../src/api/fake";
import { MemoryView } from "../src/ops/MemoryView";
import { OpsConsole } from "../src/ops/OpsConsole";
import { readOperatorKey } from "../src/ops/operatorKey";
import { deferred, renderWithApi, stubApi } from "./helpers";

// The Memory page: what Buddy's team knows about one shop, laid out as the design canvas's "Customize: memory and
// routines" board. Most tests run against the practice-mode fake, which keeps the API's rules, so each screen is
// exercised the way the real backend would answer it; a stub stands in where a test needs an answer the fake never gives.

const NOW = Date.parse("2026-11-23T03:00:00Z");

const SHOPS: Shop[] = [
  { tenant: "shop_baanmali", name: "Baan Mali", ownerName: "Fon", lineConnectionId: "line_baanmali", consent: false },
  { tenant: "shop_sabaitea", name: "Sabai Tea", ownerName: "Dao", consent: false },
];

const KNOWN = "What your team knows";
// The waiting group's name for assistive technology and its list; the band shows the board's two parts, "Waiting for your
// OK" and "Not used until you confirm".
const WAITING = "Waiting for your OK: not used until you confirm";
const TELL = "Tell Buddy something to remember";

// Baan Mali's sample facts, the board's own: two a customer said, which wait, and two of the five the team knows.
const CLOSED = "Closed on Mondays";
const DISCOUNT = "Customers expect 20% off when they buy 5 sets";
const JASMINE = "Jasmine is the best seller";
const WRAPPING = "Gift wrapping is free in December.";
// A fact's source line is shown whatever the row is doing, so it finds a row while its words are being edited.
const JASMINE_SOURCE = "From the last 90 days of orders";
const WRAPPING_SOURCE = "Told to the team by Fon";

/// The practice-mode fake as the page uses it: any key is accepted. The console test reads the key it stored instead.
function fakeApi(operatorKey?: () => string | null) {
  return createFakeApi({ ...(operatorKey ? { operatorKey } : {}), now: () => NOW, webOrigin: "https://web.test" });
}

function memoryView(api: PilotApi = fakeApi(), shops: Shop[] = SHOPS, tenant: string | null = "shop_baanmali", onForget = () => {}) {
  renderWithApi(<MemoryView shops={shops} tenant={tenant} onForget={onForget} />, api);
  return api;
}

const rowsOf = (name: string) => within(screen.getByRole("list", { name })).getAllByRole("listitem");
const rowWith = (name: string, text: string) => {
  const row = rowsOf(name).find((item) => (item.textContent ?? "").includes(text));
  if (!row) throw new Error(`no row of "${name}" holds "${text}"`);
  return row;
};
const texts = (name: string) => rowsOf(name).map((row) => row.textContent ?? "");

function fact(id: string, text: string, overrides: Partial<Fact> = {}): Fact {
  return { id, text, status: "confirmed", createdAt: NOW - 60_000, updatedAt: NOW - 60_000, source: { kind: "owner" }, ...overrides };
}

describe("the Memory page", () => {
  it("opens from the side menu beside Audit, and shows the board's groups for the chosen shop, newest first", async () => {
    sessionStorage.setItem("manut.pilot.operatorKey", "op-key-123");
    renderWithApi(<OpsConsole />, fakeApi(readOperatorKey));

    const nav = await screen.findByRole("button", { name: "Memory" });
    expect(screen.getByRole("button", { name: "Audit" })).toBeTruthy();
    await screen.findByRole("button", { name: "Baan Mali" });
    fireEvent.click(nav);
    expect(await screen.findByRole("heading", { level: 1, name: "Memory" })).toBeTruthy();
    expect(nav.getAttribute("aria-current")).toBe("page");

    await screen.findByRole("list", { name: KNOWN });
    // The board's bands: each group's title, and what the column or the group is, said once.
    expect(screen.getByRole("heading", { name: KNOWN })).toBeTruthy();
    expect(screen.getByText("Where it came from")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Waiting for your OK" })).toBeTruthy();
    expect(screen.getByText("Not used until you confirm")).toBeTruthy();
    const known = texts(KNOWN);
    expect(known).toHaveLength(5);
    // Newest first: what the sheet taught the team two days ago, down to what Fon said twelve days ago.
    expect(known.map((text) => ["costs ฿118", "best seller", "Reply warmly", "Free shipping", "Gift wrapping"].findIndex((part) => text.includes(part)))).toEqual([0, 1, 2, 3, 4]);
    expect(texts(WAITING).map((text) => [CLOSED, DISCOUNT].findIndex((words) => text.includes(words)))).toEqual([1, 0]);
    expect(screen.getByRole("form", { name: TELL })).toBeTruthy();

    // Going back to a shop leaves the Memory page.
    fireEvent.click(screen.getByRole("button", { name: "Sabai Tea" }));
    expect(await screen.findByRole("heading", { level: 1, name: "Sabai Tea" })).toBeTruthy();
    expect(nav.getAttribute("aria-current")).toBeNull();
  });

  it("says where each fact came from, and puts Correct and Forget on each, and It's true and Forget on the waiting ones", async () => {
    memoryView();
    await screen.findByRole("list", { name: KNOWN });

    const source = (words: string) => rowWith(KNOWN, words).textContent ?? "";
    expect(source("Gift wrapping")).toContain("Told to the team by Fon");
    expect(source("Free shipping")).toContain("From your price list, 3 November");
    expect(source("Reply warmly")).toContain("Learned from 12 of your edits");
    expect(source("best seller")).toContain("From the last 90 days of orders");
    expect(source("costs ฿118")).toContain("From your cost sheet in Google Sheets");
    // The band says it once; the rows only say where.
    expect(texts(KNOWN).some((text) => text.includes("Where it came from"))).toBe(false);
    for (const row of rowsOf(KNOWN)) {
      expect(within(row).getByRole("button", { name: "Correct" })).toBeTruthy();
      expect(within(row).getByRole("button", { name: "Forget" })).toBeTruthy();
      expect(within(row).queryByRole("button", { name: "It's true" })).toBeNull();
    }
    for (const row of rowsOf(WAITING)) {
      expect(within(row).getByRole("button", { name: "It's true" })).toBeTruthy();
      expect(within(row).getByRole("button", { name: "Forget" })).toBeTruthy();
      expect(within(row).queryByRole("button", { name: "Correct" })).toBeNull();
    }
    expect(rowWith(WAITING, CLOSED).textContent).toContain("A customer said it, in chat line:Ujoy");
    for (const row of rowsOf(WAITING)) expect(within(row).getByText("Not confirmed")).toBeTruthy();
    expect(screen.getByText(/Correct or forget a fact only when Fon asks you to\./)).toBeTruthy();
  });

  it("has nothing waiting, and no waiting group, for a shop whose team knows nothing yet", async () => {
    memoryView(fakeApi(), SHOPS, "shop_sabaitea");
    expect(await screen.findByText("Nothing yet. Tell Buddy something to remember below.")).toBeTruthy();
    expect(screen.queryByRole("list", { name: KNOWN })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Waiting for your OK" })).toBeNull();
    expect(screen.getByRole("form", { name: TELL })).toBeTruthy();
  });
});

describe("telling Buddy something to remember", () => {
  it("counts the characters, saves the owner's fact, clears the box and lists it first", async () => {
    const api = memoryView();
    const remember = vi.spyOn(api, "rememberFact");
    await screen.findByRole("list", { name: KNOWN });
    const form = screen.getByRole("form", { name: TELL });
    const box = within(form).getByLabelText(TELL) as HTMLInputElement;
    const save = within(form).getByRole("button", { name: "Remember" }) as HTMLButtonElement;
    expect(box.placeholder).toBe(TELL);
    expect(save.disabled).toBe(true);

    const typed = "We wrap gifts for free in December";
    fireEvent.change(box, { target: { value: `  ${typed}  ` } });
    expect(within(form).getByText(`${[...typed].length} of 280 characters. The team uses it as soon as you save it.`)).toBeTruthy();
    expect(save.disabled).toBe(false);
    fireEvent.click(save);

    expect((await screen.findByRole("status")).textContent).toBe("Remembered.");
    expect(remember).toHaveBeenCalledWith({ tenant: "shop_baanmali", text: typed });
    expect(box.value).toBe("");
    await waitFor(() => expect(texts(KNOWN)).toHaveLength(6));
    expect(texts(KNOWN)[0]).toContain(typed);
    expect(texts(KNOWN)[0]).toContain("Told to the team by Fon");
  });

  it("will not save text that is over 280 characters, and keeps what was typed when the team already knows it", async () => {
    const api = memoryView();
    const remember = vi.spyOn(api, "rememberFact");
    await screen.findByRole("list", { name: KNOWN });
    const form = screen.getByRole("form", { name: TELL });
    const box = within(form).getByLabelText(TELL) as HTMLInputElement;
    const save = within(form).getByRole("button", { name: "Remember" }) as HTMLButtonElement;

    fireEvent.change(box, { target: { value: "x".repeat(281) } });
    expect(box.getAttribute("aria-invalid")).toBe("true");
    expect(within(form).getByText("281 of 280 characters. The team uses it as soon as you save it.")).toBeTruthy();
    expect(save.disabled).toBe(true);
    expect(remember).not.toHaveBeenCalled();

    fireEvent.change(box, { target: { value: "gift wrapping is free  in DECEMBER." } });
    expect(box.getAttribute("aria-invalid")).toBeNull();
    fireEvent.click(save);
    expect((await within(form).findByRole("alert")).textContent).toBe("The team already knows this: a fact says the same.");
    expect(box.value).toBe("gift wrapping is free  in DECEMBER.");
    expect(texts(KNOWN)).toHaveLength(5);
  });

  it("confirms a waiting fact when the owner says the same words, instead of listing them twice", async () => {
    memoryView();
    await screen.findByRole("list", { name: KNOWN });
    const form = screen.getByRole("form", { name: TELL });
    fireEvent.change(within(form).getByLabelText(TELL), { target: { value: DISCOUNT.toUpperCase() } });
    fireEvent.click(within(form).getByRole("button", { name: "Remember" }));
    await waitFor(() => expect(texts(KNOWN)).toHaveLength(6));
    expect(texts(WAITING)).toHaveLength(1);
    expect(rowWith(KNOWN, DISCOUNT).textContent).toContain("A customer said it, in chat line:Ufah");
  });
});

describe("It's true", () => {
  it("moves a waiting fact into what the team knows, and the group goes when nothing is waiting", async () => {
    const api = memoryView();
    const confirm = vi.spyOn(api, "confirmFact");
    await screen.findByRole("list", { name: WAITING });

    fireEvent.click(within(rowWith(WAITING, CLOSED)).getByRole("button", { name: "It's true" }));
    expect((await screen.findByRole("status")).textContent).toBe("Confirmed.");
    expect(confirm).toHaveBeenCalledWith({ tenant: "shop_baanmali", id: "f6" });
    await waitFor(() => expect(texts(WAITING)).toHaveLength(1));
    expect(texts(KNOWN)).toHaveLength(6);
    expect(rowWith(KNOWN, CLOSED)).toBeTruthy();

    fireEvent.click(within(rowWith(WAITING, DISCOUNT)).getByRole("button", { name: "It's true" }));
    await waitFor(() => expect(screen.queryByRole("list", { name: WAITING })).toBeNull());
    expect(screen.queryByRole("heading", { name: "Waiting for your OK" })).toBeNull();
    expect(texts(KNOWN)).toHaveLength(7);
  });

  it("sends one request however often the button is pressed while it waits", async () => {
    const pending = deferred<Fact>();
    const confirmFact = vi.fn(() => pending.promise);
    const memory: Memory = { tenant: "t1", facts: [fact("f1", "Waiting words", { status: "waiting", source: { kind: "customer", chat: "line:U1" } })], forgottenCount: 0 };
    memoryView(stubApi({ getMemory: async () => memory, confirmFact }), [{ tenant: "t1", name: "Baan Mali", ownerName: "Fon", consent: false }], "t1");
    const button = (await screen.findByRole("button", { name: "It's true" })) as HTMLButtonElement;
    fireEvent.click(button);
    fireEvent.click(button);
    await waitFor(() => expect(button.disabled).toBe(true));
    expect(confirmFact).toHaveBeenCalledTimes(1);
    pending.resolve(fact("f1", "Waiting words"));
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("Confirmed."));
  });
});

describe("Correct", () => {
  it("opens the words in place, saves the correction, and marks the fact as corrected, keeping where it came from", async () => {
    const api = memoryView();
    const correct = vi.spyOn(api, "correctFact");
    await screen.findByRole("list", { name: KNOWN });

    fireEvent.click(within(rowWith(KNOWN, JASMINE_SOURCE)).getByRole("button", { name: "Correct" }));
    const box = within(rowWith(KNOWN, JASMINE_SOURCE)).getByLabelText("Corrected words") as HTMLTextAreaElement;
    expect(box.value).toBe(JASMINE);
    fireEvent.change(box, { target: { value: " Jasmine is our best selling candle " } });
    fireEvent.click(within(rowWith(KNOWN, JASMINE_SOURCE)).getByRole("button", { name: "Save correction" }));

    expect((await screen.findByRole("status")).textContent).toBe("Corrected.");
    expect(correct).toHaveBeenCalledWith({ tenant: "shop_baanmali", id: "f4", text: "Jasmine is our best selling candle" });
    await waitFor(() => expect(rowWith(KNOWN, "best selling")).toBeTruthy());
    const row = rowWith(KNOWN, "best selling");
    expect(row.textContent).toContain("Corrected");
    expect(row.textContent).toContain(JASMINE_SOURCE);
    expect(texts(KNOWN).some((text) => text.includes("the best seller"))).toBe(false);
    expect(within(row).queryByLabelText("Corrected words")).toBeNull();
  });

  it("leaves the fact alone when cancelled, and gives a waiting fact no Correct of its own", async () => {
    const api = memoryView();
    const correct = vi.spyOn(api, "correctFact");
    await screen.findByRole("list", { name: KNOWN });
    fireEvent.click(within(rowWith(KNOWN, WRAPPING_SOURCE)).getByRole("button", { name: "Correct" }));
    fireEvent.change(within(rowWith(KNOWN, WRAPPING_SOURCE)).getByLabelText("Corrected words"), { target: { value: "Something else" } });
    fireEvent.click(within(rowWith(KNOWN, WRAPPING_SOURCE)).getByRole("button", { name: "Cancel" }));
    expect(within(rowWith(KNOWN, WRAPPING_SOURCE)).queryByLabelText("Corrected words")).toBeNull();
    expect(rowWith(KNOWN, WRAPPING_SOURCE).textContent).toContain(WRAPPING);
    expect(correct).not.toHaveBeenCalled();

    // A waiting fact has "It's true" or Forget. Its words are corrected once the team knows it.
    expect(within(rowWith(WAITING, DISCOUNT)).queryByRole("button", { name: "Correct" })).toBeNull();
  });

  it("says why when the new words are another fact's, or not 1 to 280 characters, and keeps them open to fix", async () => {
    memoryView();
    await screen.findByRole("list", { name: KNOWN });
    fireEvent.click(within(rowWith(KNOWN, JASMINE_SOURCE)).getByRole("button", { name: "Correct" }));
    const row = () => rowWith(KNOWN, JASMINE_SOURCE);
    const box = () => within(row()).getByLabelText("Corrected words");
    const save = () => within(row()).getByRole("button", { name: "Save correction" }) as HTMLButtonElement;

    fireEvent.change(box(), { target: { value: "GIFT wrapping is free in december." } });
    fireEvent.click(save());
    expect((await within(row()).findByRole("alert")).textContent).toBe("The team already knows this: a fact says the same.");
    expect((box() as HTMLTextAreaElement).value).toBe("GIFT wrapping is free in december.");

    fireEvent.change(box(), { target: { value: "   " } });
    expect(save().disabled).toBe(true);
    fireEvent.change(box(), { target: { value: "x".repeat(281) } });
    expect(save().disabled).toBe(true);
    expect(box().getAttribute("aria-invalid")).toBe("true");
  });
});

describe("Forget", () => {
  it("asks once more in the row, and forgets only on yes, without showing the words again", async () => {
    const api = memoryView();
    const forget = vi.spyOn(api, "forgetFact");
    await screen.findByRole("list", { name: KNOWN });

    fireEvent.click(within(rowWith(KNOWN, WRAPPING)).getByRole("button", { name: "Forget" }));
    const ask = "Forget this fact? The team stops using it and will not learn it again unless Fon says it again.";
    expect(within(rowWith(KNOWN, WRAPPING)).getByText(ask)).toBeTruthy();
    fireEvent.click(within(rowWith(KNOWN, WRAPPING)).getByRole("button", { name: "Keep it" }));
    expect(within(rowWith(KNOWN, WRAPPING)).queryByText(ask)).toBeNull();
    expect(forget).not.toHaveBeenCalled();

    fireEvent.click(within(rowWith(KNOWN, WRAPPING)).getByRole("button", { name: "Forget" }));
    fireEvent.click(within(rowWith(KNOWN, WRAPPING)).getByRole("button", { name: "Yes, forget it" }));
    expect((await screen.findByRole("status")).textContent).toBe("Forgotten.");
    expect(forget).toHaveBeenCalledWith({ tenant: "shop_baanmali", id: "f1" });
    await waitFor(() => expect(texts(KNOWN)).toHaveLength(4));
    expect(document.body.textContent).not.toContain(WRAPPING);
    expect(screen.getByText("1 text was forgotten. Only a fingerprint of it is kept, so the team does not learn it again.")).toBeTruthy();
  });

  it("forgets a waiting fact the same way", async () => {
    memoryView();
    await screen.findByRole("list", { name: WAITING });
    fireEvent.click(within(rowWith(WAITING, DISCOUNT)).getByRole("button", { name: "Forget" }));
    fireEvent.click(within(rowWith(WAITING, DISCOUNT)).getByRole("button", { name: "Yes, forget it" }));
    await waitFor(() => expect(texts(WAITING)).toHaveLength(1));
    expect(texts(KNOWN)).toHaveLength(5);
    expect(document.body.textContent).not.toContain(DISCOUNT);
  });
});

describe("what goes wrong", () => {
  const owner = [{ tenant: "t1", name: "Baan Mali", ownerName: "Fon", consent: false }];

  it("says so, and refreshes, when a fact was already gone", async () => {
    const getMemory = vi.fn(async (): Promise<Memory> => ({ tenant: "t1", facts: [fact("f1", "Waiting words", { status: "waiting", source: { kind: "customer", chat: "line:U1" } })], forgottenCount: 0 }));
    const confirmFact = vi.fn(async () => { throw new ApiError(404, "not_found"); });
    memoryView(stubApi({ getMemory, confirmFact }), owner, "t1");
    fireEvent.click(await screen.findByRole("button", { name: "It's true" }));
    expect((await screen.findByRole("alert")).textContent).toContain("That fact is already gone. The list was refreshed.");
    await waitFor(() => expect(getMemory).toHaveBeenCalledTimes(2));
  });

  it("says the team is full when it holds 200 facts, and keeps what was typed", async () => {
    const rememberFact = vi.fn(async () => { throw new ApiError(409, "full"); });
    memoryView(stubApi({ getMemory: async () => ({ tenant: "t1", facts: [], forgottenCount: 0 }), rememberFact }), owner, "t1");
    const box = (await screen.findByRole("textbox", { name: TELL })) as HTMLInputElement;
    fireEvent.change(box, { target: { value: "One more" } });
    fireEvent.click(screen.getByRole("button", { name: "Remember" }));
    expect((await screen.findByRole("alert")).textContent).toBe("The team already holds 200 facts. Forget one to make room.");
    expect(box.value).toBe("One more");
  });

  it("says so when the memory cannot be read, and offers another key when the API refuses this one", async () => {
    let answer: ApiError = new ApiError(503, "memory_unavailable");
    const onForget = vi.fn();
    memoryView(stubApi({ getMemory: async () => { throw answer; } }), owner, "t1", onForget);
    expect((await screen.findByRole("alert")).textContent).toContain("The API could not read what the team knows.");
    answer = new ApiError(403, "forbidden");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await screen.findByText(/The API refused the operator key/);
    fireEvent.click(screen.getByRole("button", { name: "Enter another key" }));
    expect(onForget).toHaveBeenCalledTimes(1);
  });

  it("starts again from the newest when refreshed or when another shop is chosen, and says when there are no shops", async () => {
    const api = memoryView();
    await screen.findByRole("list", { name: KNOWN });
    await api.rememberFact({ tenant: "shop_baanmali", text: "Added somewhere else" });
    expect(texts(KNOWN)).toHaveLength(5);
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(texts(KNOWN)).toHaveLength(6));

    fireEvent.change(screen.getByLabelText("Shop"), { target: { value: "shop_sabaitea" } });
    expect(await screen.findByText("Nothing yet. Tell Buddy something to remember below.")).toBeTruthy();
    expect(screen.queryByRole("list", { name: WAITING })).toBeNull();
  });

  it("says there are no shops when there are none to read", async () => {
    memoryView(stubApi({}), [], null);
    expect(await screen.findByText("No shops yet.")).toBeTruthy();
  });
});
