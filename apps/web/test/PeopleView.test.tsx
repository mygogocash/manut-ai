import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ApiError, type CreatedInvite, type HelperRemoval, type People, type PilotApi, type Shop } from "../src/api";
import { createFakeApi } from "../src/api/fake";
import { OpsConsole } from "../src/ops/OpsConsole";
import { readOperatorKey } from "../src/ops/operatorKey";
import { PeopleView } from "../src/ops/PeopleView";
import { deferred, renderWithApi, stubApi } from "./helpers";

// The People page: who can use Manut AI for one shop, laid out from the design canvas's "Settings: people" and "States:
// people and roles" boards. Most tests run against the practice-mode fake, which keeps the API's rules through
// `@manut/people-rules`, so each screen is exercised the way the real backend would answer it; a stub stands in where a test
// needs an answer the fake never gives (an unreadable list, a link the API could not make, a refusal that needs a race).

const NOW = Date.parse("2026-11-23T03:00:00Z");

const SHOPS: Shop[] = [
  { tenant: "shop_baanmali", name: "Baan Mali", ownerName: "Fon", lineConnectionId: "line_baanmali", consent: false },
  { tenant: "shop_sabaitea", name: "Sabai Tea", ownerName: "Dao", consent: false },
];

const BAAN_MALI = "shop_baanmali";
const PEOPLE = "Baan Mali's people";
const NOTES = "Notes passed on to Baan Mali's owner";

/// The practice-mode fake as the page uses it: any key is accepted. The console test reads the key it stored instead.
function fakeApi(operatorKey?: () => string | null) {
  return createFakeApi({ ...(operatorKey ? { operatorKey } : {}), now: () => NOW, webOrigin: "https://web.test" });
}

function peopleView(api: PilotApi = fakeApi(), shops: Shop[] = SHOPS, tenant: string | null = BAAN_MALI, onForget = () => {}) {
  renderWithApi(<PeopleView shops={shops} tenant={tenant} onForget={onForget} />, api);
  return api;
}

const who = () => screen.getByRole("region", { name: "Who can use Manut AI for Baan Mali" });
const cover = () => screen.getByRole("region", { name: "While you are away" });
const rowsOf = (name: string) => within(screen.getByRole("list", { name })).getAllByRole("listitem");
const rowWith = (text: string, list = PEOPLE) => {
  const row = rowsOf(list).find((item) => (item.textContent ?? "").includes(text));
  if (!row) throw new Error(`no row of "${list}" holds "${text}"`);
  return row;
};

function emptyPeople(overrides: Partial<People> = {}): People {
  return { tenant: "t1", owner: { name: "Fon" }, helpers: [], invites: [], away: null, passedOn: [], removed: [], ...overrides };
}

const MINT = { id: "helper-mint", name: "Mint", identity: { kind: "email", address: "mint@baanmali.example" } as const,
  joinedAt: "2026-11-13T03:05:00.000Z", devices: 2 };
const T1: Shop[] = [{ tenant: "t1", name: "Baan Mali", ownerName: "Fon", consent: false }];

describe("the People page", () => {
  it("opens from the side menu beside Audit and Memory, and shows the board's four sections for the chosen shop", async () => {
    sessionStorage.setItem("manut.pilot.operatorKey", "op-key-123");
    renderWithApi(<OpsConsole />, fakeApi(readOperatorKey));

    const nav = await screen.findByRole("button", { name: "People" });
    expect(screen.getByRole("button", { name: "Memory" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Audit" })).toBeTruthy();
    await screen.findByRole("button", { name: "Baan Mali" });
    fireEvent.click(nav);
    expect(await screen.findByRole("heading", { level: 1, name: "People" })).toBeTruthy();
    expect(nav.getAttribute("aria-current")).toBe("page");

    await screen.findByRole("list", { name: PEOPLE });
    for (const title of ["Who can use Manut AI for Baan Mali", "What each role can approve", "While you are away",
      "Notes helpers passed on"]) {
      expect(screen.getByRole("heading", { level: 2, name: title })).toBeTruthy();
    }
    expect(within(who()).getByText("2 people, 1 invited")).toBeTruthy();
    expect(screen.getByText(/Fon has no account here in the pilot, so invite, cancel, remove and set cover only when Fon asks you to\./))
      .toBeTruthy();

    // Going back to a shop leaves the People page.
    fireEvent.click(screen.getByRole("button", { name: "Sabai Tea" }));
    expect(await screen.findByRole("heading", { level: 1, name: "Sabai Tea" })).toBeTruthy();
    expect(nav.getAttribute("aria-current")).toBeNull();
  });

  it("lists the owner, Mint and Beam's invite, each with what they may approve, and never offers a helper money or posts", async () => {
    peopleView();
    await screen.findByRole("list", { name: PEOPLE });
    const rows = rowsOf(PEOPLE);
    expect(rows).toHaveLength(3);

    const fon = rowWith("Fon");
    expect(within(fon).getByText("Owner")).toBeTruthy();
    expect(within(fon).getByText("Approves everything: messages and replies, money and public posts.")).toBeTruthy();
    expect(within(fon).queryByRole("button")).toBeNull();

    const mint = rowWith("Mint");
    expect(within(mint).getByText("Helper")).toBeTruthy();
    expect(within(mint).getByText("mint@baanmali.example")).toBeTruthy();
    expect(within(mint).getByText("Helper since 13 November. Signed in on 2 devices.")).toBeTruthy();
    expect(within(mint).getByText("Approves messages and replies to customers. Money and public posts stay with Fon.")).toBeTruthy();
    expect(within(mint).getByText("Covering")).toBeTruthy();
    expect(within(mint).getByRole("button", { name: "Remove" })).toBeTruthy();
    expect(mint.textContent).not.toContain("Approves everything");

    const beam = rowWith("Beam");
    expect(within(beam).getByText("Invited")).toBeTruthy();
    expect(within(beam).getByText("LINE ID beam.baanmali")).toBeTruthy();
    expect(within(beam).getByText("Invite made 23 November at 08:00. It works once, until Monday 30 November at 08:00.")).toBeTruthy();
    expect(within(beam).getByRole("button", { name: "Copy link for Beam's invite" })).toBeTruthy();
    expect(within(beam).getByRole("button", { name: "Cancel invite" })).toBeTruthy();
    // A person who joined, and an invite that was cancelled, are not listed as waiting.
    expect(rows.map((row) => row.textContent ?? "").filter((text) => text.includes("Invited"))).toHaveLength(1);
    expect(within(who()).getByText("Send this link yourself; Manut AI does not send it.")).toBeTruthy();
  });

  it("shows what each role can approve, read from approval-core's rule: a helper only messages and replies", async () => {
    peopleView();
    const table = await screen.findByRole("table", { name: "What each role can approve" });
    const [header, ...rows] = within(table).getAllByRole("row");
    expect(within(header!).getAllByRole("columnheader").map((cell) => cell.textContent)).toEqual(["What", "Owner", "Helper"]);
    expect(rows.map((row) => within(row).getAllByRole("cell").map((cell) => cell.textContent))).toEqual([
      ["Messages to customers", "Yes", "Yes"],
      ["Replies to customers", "Yes", "Yes"],
      ["Money: refunds, discounts and payments", "Yes", "No, asks Fon"],
      ["Public posts", "Yes", "No, asks Fon"],
      ["Confirming that a payment arrived", "Yes", "No, asks Fon"],
      ["Commands the team asks to run", "Yes", "No, asks Fon"],
    ]);
    expect(screen.getByText("A request a helper cannot approve waits for Fon, and the helper can pass it on with a note."))
      .toBeTruthy();
  });

  it("says who is covering and until when in the board's words, with money and public posts still waiting for the owner", async () => {
    peopleView();
    await screen.findByRole("list", { name: PEOPLE });
    expect(within(cover()).getByRole("status").textContent)
      .toBe("You are away until Friday 27 November. Mint is covering messages.");
    expect(within(cover()).getByText("Money and public posts still wait for Fon.")).toBeTruthy();
    expect(within(cover()).getByRole("button", { name: "End cover" })).toBeTruthy();
  });

  it("shows the notes helpers passed on, newest first, with the kind of request and who passed it on", async () => {
    const people = emptyPeople({
      helpers: [MINT],
      passedOn: [
        { requestId: "req_old", kind: "public_post", by: "helper-mint", name: "Mint", note: "Older note", at: "2026-11-22T03:00:00.000Z" },
        { requestId: "req_refund", kind: "money", by: "helper-mint", name: "Mint",
          note: "The customer sent a photo of the broken jar. It looks right to me.", at: "2026-11-23T00:00:00.000Z" },
        { requestId: "req_new", kind: "something_new", by: "helper-gone", name: "Kai", note: "ขอให้ตรวจสอบหน่อยค่ะ", at: "2026-11-23T02:00:00.000Z" },
      ],
    });
    peopleView(stubApi({ getPeople: async () => people }), T1, "t1");
    await screen.findByRole("list", { name: "Notes passed on to Baan Mali's owner" });
    expect(screen.getByText("Fon still decides")).toBeTruthy();
    const notes = rowsOf("Notes passed on to Baan Mali's owner");
    expect(notes.map((note) => within(note).getByText(/^request /).textContent)).toEqual(["request req_new", "request req_refund", "request req_old"]);

    const refund = notes[1]!;
    expect(within(refund).getByText("Passed on by Mint")).toBeTruthy();
    expect(within(refund).getByText("Money")).toBeTruthy();
    expect(within(refund).getByText("The customer sent a photo of the broken jar. It looks right to me.")).toBeTruthy();
    expect(within(refund).getByText("23 November at 07:00")).toBeTruthy();
    // A kind this console does not know yet is shown as it is, a name that is no longer a helper's still stands, and Thai
    // words are marked as Thai.
    expect(within(notes[0]!).getByText("something_new")).toBeTruthy();
    expect(within(notes[0]!).getByText("Passed on by Kai")).toBeTruthy();
    expect(within(notes[0]!).getByText("ขอให้ตรวจสอบหน่อยค่ะ").getAttribute("lang")).toBe("th");
    expect(within(notes[2]!).getByText("Public post")).toBeTruthy();
  });

  it("has only the owner, no cover and no notes for a shop that has been given no helpers", async () => {
    peopleView(fakeApi(), SHOPS, "shop_sabaitea");
    await screen.findByRole("list", { name: "Sabai Tea's people" });
    const rows = rowsOf("Sabai Tea's people");
    expect(rows).toHaveLength(1);
    expect(within(rows[0]!).getByText("Owner")).toBeTruthy();
    expect(within(rows[0]!).getByText("Dao")).toBeTruthy();
    expect(screen.getByText("1 person")).toBeTruthy();
    expect(screen.getByText("No helpers yet. Dao is the only person who can use Manut AI for Sabai Tea. Invite a helper to let someone approve messages and replies."))
      .toBeTruthy();
    expect(screen.getByText("Invite a helper first: cover needs someone to approve messages while Dao is away.")).toBeTruthy();
    expect(screen.queryByRole("form", { name: "Set cover" })).toBeNull();
    expect(screen.getByText("No notes yet. When a helper cannot approve a request, they can pass it to Dao with a note, and it shows here."))
      .toBeTruthy();
    expect(screen.queryByText(/Send this link yourself/)).toBeNull();
    expect(screen.queryByText(/Removed helpers/)).toBeNull();
  });

  it("says when an invite ran out, when the API could not make an invite's link, and who was removed", async () => {
    const people = emptyPeople({
      helpers: [MINT],
      invites: [
        { id: "inv-old", name: "Beam", identity: { kind: "line", id: "beam.baanmali" }, status: "expired",
          createdAt: "2026-11-10T01:00:00.000Z", expiresAt: "2026-11-17T01:00:00.000Z" },
        { id: "inv-nolink", name: "Kai", identity: { kind: "email", address: "kai@sabai.example" }, status: "pending",
          createdAt: "2026-11-23T01:00:00.000Z", expiresAt: "2026-11-30T01:00:00.000Z" },
        { id: "inv-used", name: "Mint", identity: MINT.identity, status: "used", createdAt: "2026-11-12T01:00:00.000Z",
          expiresAt: "2026-11-19T01:00:00.000Z" },
        { id: "inv-gone", name: "Pim", identity: { kind: "line", id: "pim" }, status: "revoked", createdAt: "2026-11-12T01:00:00.000Z",
          expiresAt: "2026-11-19T01:00:00.000Z" },
      ],
      removed: [{ id: "helper-kai", name: "Kai" }, { id: "helper-x", name: "" }, { id: "helper-pim", name: "Pim" }],
    });
    peopleView(stubApi({ getPeople: async () => people }), T1, "t1");
    await screen.findByRole("list", { name: PEOPLE });
    // Fon, Mint, one invite waiting and one that ran out; a used or cancelled invite is not listed.
    expect(rowsOf(PEOPLE)).toHaveLength(4);
    const ranOut = rowWith("Beam");
    expect(within(ranOut).getByText("Expired")).toBeTruthy();
    expect(within(ranOut).getByText("This invite ran out on Tuesday 17 November at 08:00. Invite again for a new link.")).toBeTruthy();
    expect(within(ranOut).queryByRole("button")).toBeNull();
    const nolink = rowWith("Kai");
    expect(within(nolink).getByText(/The API could not make this invite's link just now\./)).toBeTruthy();
    expect(within(nolink).queryByRole("button", { name: /Copy link/ })).toBeNull();
    expect(within(nolink).getByRole("button", { name: "Cancel invite" })).toBeTruthy();
    expect(within(who()).getByText("2 people, 1 invited")).toBeTruthy();
    expect(within(who()).getByText("Removed helpers: Kai and Pim. What they approved stays in the activity log, with their names.")).toBeTruthy();
  });
});

describe("what the page says when it cannot show the people", () => {
  it("says it is loading, then shows the list", async () => {
    const pending = deferred<People>();
    peopleView(stubApi({ getPeople: () => pending.promise }), T1, "t1");
    expect(await screen.findByLabelText("Loading people")).toBeTruthy();
    pending.resolve(emptyPeople());
    await screen.findByRole("list", { name: PEOPLE });
    expect(screen.queryByLabelText("Loading people")).toBeNull();
  });

  it("says so when the people cannot be read, never an empty list, and reads them again on Try again", async () => {
    let answer: People | ApiError = new ApiError(503, "people_unavailable");
    const getPeople = vi.fn(async () => {
      if (answer instanceof ApiError) throw answer;
      return answer;
    });
    peopleView(stubApi({ getPeople }), T1, "t1");
    expect((await screen.findByRole("alert")).textContent).toContain("The API could not read this shop's people. Try again.");
    expect(screen.queryByRole("list", { name: PEOPLE })).toBeNull();
    answer = emptyPeople({ helpers: [MINT] });
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await screen.findByRole("list", { name: PEOPLE });
    expect(getPeople).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("offers another key when the API refuses this one, and says when it cannot be reached", async () => {
    let answer = new ApiError(403, "forbidden");
    const onForget = vi.fn();
    peopleView(stubApi({ getPeople: async () => { throw answer; } }), T1, "t1", onForget);
    await screen.findByText(/The API refused the operator key/);
    fireEvent.click(screen.getByRole("button", { name: "Enter another key" }));
    expect(onForget).toHaveBeenCalledTimes(1);
    answer = new ApiError(0, "network");
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await screen.findByText("Could not reach the API. Check the connection and try again.");
  });

  it("says there are no shops when there are none to read", async () => {
    peopleView(stubApi({}), [], null);
    expect(await screen.findByText("No shops yet.")).toBeTruthy();
    expect(screen.queryByRole("list", { name: PEOPLE })).toBeNull();
  });

  it("reads another shop's people when the shop is changed on the page, and leaves an open form behind", async () => {
    peopleView();
    await screen.findByRole("list", { name: PEOPLE });
    fireEvent.click(screen.getByRole("button", { name: "Invite a helper" }));
    expect(screen.getByRole("form", { name: "Invite a helper" })).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Shop"), { target: { value: "shop_sabaitea" } });
    await screen.findByRole("list", { name: "Sabai Tea's people" });
    expect(screen.queryByRole("form", { name: "Invite a helper" })).toBeNull();
    expect(screen.getByRole("button", { name: "Invite a helper" })).toBeTruthy();
  });
});

describe("inviting a helper", () => {
  const open = async (api: PilotApi = fakeApi()) => {
    peopleView(api);
    await screen.findByRole("list", { name: PEOPLE });
    fireEvent.click(screen.getByRole("button", { name: "Invite a helper" }));
    const form = screen.getByRole("form", { name: "Invite a helper" });
    return {
      api,
      form,
      name: within(form).getByLabelText("Name") as HTMLInputElement,
      contact: within(form).getByLabelText("LINE ID or email") as HTMLInputElement,
      submit: within(form).getByRole("button", { name: "Make invite link" }) as HTMLButtonElement,
    };
  };
  const fill = (name: HTMLInputElement, contact: HTMLInputElement, typed: string, account: string) => {
    fireEvent.change(name, { target: { value: typed } });
    fireEvent.change(contact, { target: { value: account } });
  };

  it("asks for a name and a LINE account or an email, says what a helper may do, and says what the pilot cannot do yet", async () => {
    const { form, name, contact, submit } = await open();
    expect(screen.queryByRole("button", { name: "Invite a helper" })).toBeNull();
    expect(submit.disabled).toBe(true);
    expect(within(form).getByText(/Manut AI does not send the invite: you get a link to send yourself\. It works once, for 7 days\./)).toBeTruthy();
    expect(within(form).getByText("Signing in with LINE is not built yet, so an invite to a LINE ID cannot be opened until it is. An email invite opens only for someone whose Apple ID uses that email."))
      .toBeTruthy();
    expect(within(form).getByText("A helper can approve messages and replies to customers. Money and public posts stay with Fon.")).toBeTruthy();

    fireEvent.change(name, { target: { value: "  Kai " } });
    expect(within(form).getByText("Kai can approve messages and replies to customers. Money and public posts stay with Fon.")).toBeTruthy();
    expect(submit.disabled).toBe(true);
    fireEvent.change(contact, { target: { value: "kai.sabai" } });
    expect(submit.disabled).toBe(false);
    fireEvent.change(name, { target: { value: "   " } });
    expect(submit.disabled).toBe(true);
    fireEvent.change(name, { target: { value: "x".repeat(81) } });
    expect(name.getAttribute("aria-invalid")).toBe("true");
    expect(within(form).getByText("Write a name of 1 to 80 characters.")).toBeTruthy();
    expect(submit.disabled).toBe(true);
    fireEvent.change(name, { target: { value: "x".repeat(80) } });
    expect(name.getAttribute("aria-invalid")).toBeNull();
    expect(submit.disabled).toBe(false);

    fireEvent.click(within(form).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("form", { name: "Invite a helper" })).toBeNull();
    expect(screen.getByRole("button", { name: "Invite a helper" })).toBeTruthy();
  });

  it("makes the invite, shows its link with a copy button and says to send it by hand, and lists Kai as invited", async () => {
    const { api, name, contact, submit } = await open();
    const create = vi.spyOn(api, "createInvite");
    fill(name, contact, "  Kai ", "  Kai@Sabai.example ");
    fireEvent.click(submit);

    const ready = await screen.findByRole("region", { name: "The invite for Kai is ready." });
    expect(create).toHaveBeenCalledWith({ tenant: BAAN_MALI, name: "Kai", identity: { kind: "email", address: "Kai@Sabai.example" } });
    const link = within(ready).getByLabelText("Invite link") as HTMLInputElement;
    expect(link.readOnly).toBe(true);
    expect(link.value).toMatch(/^https:\/\/web\.test\/join\/practice-inv-\d+$/);
    expect(within(ready).getByRole("button", { name: "Copy link for the new invite" })).toBeTruthy();
    expect(within(ready).getByText("Send this link yourself; Manut AI does not send it.")).toBeTruthy();
    expect(screen.queryByRole("form", { name: "Invite a helper" })).toBeNull();
    expect(screen.getByRole("button", { name: "Invite a helper" })).toBeTruthy();

    await waitFor(() => expect(rowsOf(PEOPLE)).toHaveLength(4));
    const kai = rowWith("Kai");
    expect(within(kai).getByText("Invited")).toBeTruthy();
    expect(within(kai).getByText("Kai@Sabai.example")).toBeTruthy();
    expect(within(who()).getByText("2 people, 2 invited")).toBeTruthy();
    // The sentence is said once while the new link is showing, and once more under the list after it is put away.
    expect(screen.getAllByText("Send this link yourself; Manut AI does not send it.")).toHaveLength(1);
    fireEvent.click(within(ready).getByRole("button", { name: "Done" }));
    expect(screen.queryByRole("region", { name: "The invite for Kai is ready." })).toBeNull();
    expect(screen.getAllByText("Send this link yourself; Manut AI does not send it.")).toHaveLength(1);
  });

  it("takes an account with no @ as a LINE ID, exactly as typed but for outer spaces", async () => {
    const { api, name, contact, submit } = await open();
    const create = vi.spyOn(api, "createInvite");
    fill(name, contact, "Nok", "  Nok.Line  ");
    fireEvent.click(submit);
    await screen.findByRole("region", { name: "The invite for Nok is ready." });
    expect(create).toHaveBeenCalledWith({ tenant: BAAN_MALI, name: "Nok", identity: { kind: "line", id: "Nok.Line" } });
  });

  it("copies the link, says so, and says when the browser would not copy it", async () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    const { name, contact, submit } = await open();
    fill(name, contact, "Kai", "kai@sabai.example");
    fireEvent.click(submit);
    const ready = await screen.findByRole("region", { name: "The invite for Kai is ready." });
    const link = (within(ready).getByLabelText("Invite link") as HTMLInputElement).value;
    fireEvent.click(within(ready).getByRole("button", { name: "Copy link for the new invite" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(link));
    expect(await within(ready).findByRole("button", { name: "Copied" })).toBeTruthy();

    // A waiting invite's row copies its own link, the one the list shows again.
    fireEvent.click(within(rowWith("Beam")).getByRole("button", { name: "Copy link for Beam's invite" }));
    await waitFor(() => expect(writeText).toHaveBeenLastCalledWith("https://web.test/join/practice-inv-beam"));

    writeText.mockImplementation(() => Promise.reject(new Error("blocked")));
    fireEvent.click(within(ready).getByRole("button", { name: /^(Copy link for the new invite|Copied)$/ }));
    expect((await within(ready).findByRole("alert")).textContent).toBe("Could not copy. Select the link and copy it by hand.");
  });

  it("says why when the API refuses, keeps what was typed to fix, and makes no invite", async () => {
    const { api, form, name, contact, submit } = await open();
    const refusal = async (typed: string, account: string, said: string) => {
      fill(name, contact, typed, account);
      fireEvent.click(submit);
      expect((await within(form).findByRole("alert")).textContent).toBe(said);
      expect(name.value).toBe(typed);
      expect(contact.value).toBe(account);
    };
    // Beam's invite is still waiting, Mint is a helper, and "kai@" is not an address.
    await refusal("Beam again", "beam.baanmali", "That account already has an invite waiting. Send its link, or cancel it first.");
    await refusal("Mint again", " MINT@baanmali.example ", "That person is already a helper.");
    await refusal("Kai", "kai@", "Write a LINE ID, or an email address like name@example.com.");
    expect(rowsOf(PEOPLE)).toHaveLength(3);
    expect((await api.getPeople(BAAN_MALI)).invites).toHaveLength(2);
    // A right answer then goes through, and the old refusal is gone.
    fill(name, contact, "Kai", "kai@sabai.example");
    fireEvent.click(submit);
    await screen.findByRole("region", { name: "The invite for Kai is ready." });
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("names the setting when the API cannot make invite links, and says so when it could not save", async () => {
    let answer = new ApiError(503, "not_configured", undefined, { setting: "WEB_ORIGIN" });
    const createInvite = vi.fn(async () => { throw answer; });
    const { form, name, contact, submit } = await open(stubApi({ getPeople: async () => emptyPeople({ helpers: [MINT] }), createInvite }));
    fill(name, contact, "Kai", "kai@sabai.example");
    fireEvent.click(submit);
    expect((await within(form).findByRole("alert")).textContent)
      .toBe("The API cannot make invite links: its setting WEB_ORIGIN is missing or cannot be read. Ask whoever deploys the API to fix it, then try again.");
    answer = new ApiError(503, "people_unavailable");
    fireEvent.click(submit);
    await waitFor(() => expect(within(form).getByRole("alert").textContent)
      .toBe("The API could not read or save this shop's people. Check the list, then try again."));
    expect(createInvite).toHaveBeenCalledTimes(2);
  });

  it("sends one request however often the button is pressed while it waits", async () => {
    const pending = deferred<CreatedInvite>();
    const createInvite = vi.fn(() => pending.promise);
    const { name, contact, submit } = await open(stubApi({ getPeople: async () => emptyPeople(), createInvite }));
    fill(name, contact, "Kai", "kai@sabai.example");
    fireEvent.click(submit);
    fireEvent.click(submit);
    await waitFor(() => expect(submit.disabled).toBe(true));
    expect(submit.getAttribute("aria-busy")).toBe("true");
    expect(createInvite).toHaveBeenCalledTimes(1);
    pending.resolve({ invite: { id: "inv-1", name: "Kai", identity: { kind: "email", address: "kai@sabai.example" },
      status: "pending", createdAt: "2026-11-23T03:00:00.000Z", expiresAt: "2026-11-30T03:00:00.000Z" },
    inviteUrl: "https://web.test/join/x" });
    await screen.findByRole("region", { name: "The invite for Kai is ready." });
  });
});

describe("cancelling an invite", () => {
  it("cancels Beam's invite, says so, and drops it from the people waiting", async () => {
    const api = peopleView();
    const revoke = vi.spyOn(api, "revokeInvite");
    await screen.findByRole("list", { name: PEOPLE });
    fireEvent.click(within(rowWith("Beam")).getByRole("button", { name: "Cancel invite" }));
    expect((await within(who()).findByRole("status")).textContent).toBe("The invite for Beam was cancelled.");
    expect(revoke).toHaveBeenCalledWith({ tenant: BAAN_MALI, inviteId: "inv-beam" });
    await waitFor(() => expect(rowsOf(PEOPLE)).toHaveLength(2));
    expect(within(who()).getByText("2 people")).toBeTruthy();
    expect(screen.queryByText(/Send this link yourself/)).toBeNull();
    expect((await api.getPeople(BAAN_MALI)).invites.find((invite) => invite.id === "inv-beam")?.status).toBe("revoked");
  });

  it("says the list moved on when the invite is already gone or already used, and reads the list again", async () => {
    const invite = { id: "inv-1", name: "Beam", identity: { kind: "line", id: "beam" } as const, status: "pending" as const,
      createdAt: "2026-11-23T01:00:00.000Z", expiresAt: "2026-11-30T01:00:00.000Z", inviteUrl: "https://web.test/join/x" };
    let refusal = new ApiError(404, "unknown_invite");
    const getPeople = vi.fn(async () => emptyPeople({ invites: [invite] }));
    const revokeInvite = vi.fn(async () => { throw refusal; });
    peopleView(stubApi({ getPeople, revokeInvite }), T1, "t1");
    await screen.findByRole("list", { name: PEOPLE });
    fireEvent.click(screen.getByRole("button", { name: "Cancel invite" }));
    expect((await screen.findByRole("alert")).textContent).toBe("That invite is already gone. The list was refreshed.");
    await waitFor(() => expect(getPeople).toHaveBeenCalledTimes(2));
    refusal = new ApiError(409, "not_pending");
    fireEvent.click(screen.getByRole("button", { name: "Cancel invite" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent)
      .toBe("That invite was already used or cancelled, so it cannot be cancelled. The list was refreshed."));
    await waitFor(() => expect(getPeople).toHaveBeenCalledTimes(3));
  });
});

describe("cancelling an invite that is already gone", () => {
  it("keeps saying so after the refreshed list has no row left for the message to sit in", async () => {
    const invite = { id: "inv-1", name: "Beam", identity: { kind: "line", id: "beam" } as const, status: "pending" as const,
      createdAt: "2026-11-23T01:00:00.000Z", expiresAt: "2026-11-30T01:00:00.000Z", inviteUrl: "https://web.test/join/x" };
    const getPeople = vi.fn()
      .mockResolvedValueOnce(emptyPeople({ invites: [invite] }))
      .mockResolvedValue(emptyPeople());
    const revokeInvite = vi.fn(async () => { throw new ApiError(409, "not_pending"); });
    peopleView(stubApi({ getPeople, revokeInvite }), T1, "t1");
    await screen.findByRole("list", { name: PEOPLE });
    fireEvent.click(screen.getByRole("button", { name: "Cancel invite" }));
    await waitFor(() => expect(getPeople).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Cancel invite" })).toBeNull());
    expect(screen.getByRole("alert").textContent)
      .toBe("That invite was already used or cancelled, so it cannot be cancelled. The list was refreshed.");
  });
});

describe("removing a helper", () => {
  it("asks once more in the board's words, and does nothing until the operator says yes", async () => {
    const api = peopleView();
    const remove = vi.spyOn(api, "removeHelper");
    await screen.findByRole("list", { name: PEOPLE });
    fireEvent.click(within(rowWith("Mint")).getByRole("button", { name: "Remove" }));

    const dialog = screen.getByRole("dialog", { name: "Remove Mint?" });
    expect(within(dialog).getByText("Mint can no longer sign in to Baan Mali. Requests Mint was looking at go back to you.")).toBeTruthy();
    expect(within(dialog).getByText("What Mint approved stays in the activity log, with Mint's name.")).toBeTruthy();
    expect(remove).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "Keep Mint" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(remove).not.toHaveBeenCalled();
    expect(rowsOf(PEOPLE)).toHaveLength(3);
  });

  it("removes Mint on yes, says what the API did, and keeps Mint's name for the log", async () => {
    const api = peopleView();
    const remove = vi.spyOn(api, "removeHelper");
    await screen.findByRole("list", { name: PEOPLE });
    fireEvent.click(within(rowWith("Mint")).getByRole("button", { name: "Remove" }));
    fireEvent.click(within(screen.getByRole("dialog", { name: "Remove Mint?" })).getByRole("button", { name: "Remove Mint" }));

    expect((await within(who()).findByRole("status")).textContent)
      .toBe("Mint was removed and signed out on every device. Their cover has ended.");
    expect(remove).toHaveBeenCalledWith({ tenant: BAAN_MALI, helperId: "helper-mint" });
    expect(screen.queryByRole("dialog")).toBeNull();
    await waitFor(() => expect(rowsOf(PEOPLE)).toHaveLength(2));
    expect(within(who()).getByText("1 person, 1 invited")).toBeTruthy();
    expect(within(who()).getByText("Removed helpers: Mint. What they approved stays in the activity log, with their names.")).toBeTruthy();
    // The cover Mint held ended with Mint, so nobody is covering and there is no one to choose.
    expect(within(cover()).queryByRole("status")).toBeNull();
    expect(within(cover()).getByText("Invite a helper first: cover needs someone to approve messages while Fon is away.")).toBeTruthy();
    // What Mint passed on keeps Mint's name.
    expect(within(rowWith("Passed on by Mint", NOTES)).getByText("Money")).toBeTruthy();
  });

  it("says the list moved on when the helper is already gone, reads the list again, and keeps saying so once the row is gone", async () => {
    // The first read has Mint; by the second, someone else has removed Mint, so the refreshed list has no row for the message
    // to sit in.
    const getPeople = vi.fn()
      .mockResolvedValueOnce(emptyPeople({ helpers: [MINT] }))
      .mockResolvedValue(emptyPeople());
    const removeHelper = vi.fn(async (): Promise<HelperRemoval> => { throw new ApiError(404, "not_a_helper"); });
    peopleView(stubApi({ getPeople, removeHelper }), T1, "t1");
    await screen.findByRole("list", { name: PEOPLE });
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove Mint" }));
    await waitFor(() => expect(getPeople).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Remove" })).toBeNull());
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByRole("alert").textContent).toBe("That person is no longer a helper. The list was refreshed.");
  });

  it("says what else the removal did: the invites it cancelled, and a cover it did not end", async () => {
    const removeHelper = vi.fn(async (): Promise<HelperRemoval> =>
      ({ removed: "helper-mint", sessionsEnded: 1, invitesRevoked: ["inv-9", "inv-10"], coverEnded: false }));
    peopleView(stubApi({ getPeople: async () => emptyPeople({ helpers: [MINT] }), removeHelper }), T1, "t1");
    await screen.findByRole("list", { name: PEOPLE });
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove Mint" }));
    expect((await screen.findByRole("status")).textContent)
      .toBe("Mint was removed and signed out on every device. 2 pending invites for them were cancelled.");
  });

  it("sends one request however often the button is pressed while it waits, and locks the page's other buttons", async () => {
    const pending = deferred<HelperRemoval>();
    const removeHelper = vi.fn(() => pending.promise);
    peopleView(stubApi({ getPeople: async () => emptyPeople({ helpers: [MINT] }), removeHelper }), T1, "t1");
    await screen.findByRole("list", { name: PEOPLE });
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    const yes = screen.getByRole("button", { name: "Remove Mint" }) as HTMLButtonElement;
    fireEvent.click(yes);
    fireEvent.click(yes);
    await waitFor(() => expect(yes.disabled).toBe(true));
    expect((screen.getByRole("button", { name: "Keep Mint" }) as HTMLButtonElement).disabled).toBe(true);
    expect(removeHelper).toHaveBeenCalledTimes(1);
    pending.resolve({ removed: "helper-mint", sessionsEnded: 1, invitesRevoked: [], coverEnded: false });
    await screen.findByRole("status");
  });
});

describe("cover while the owner is away", () => {
  const form = () => screen.getByRole("form", { name: "Set cover" });

  it("sets cover for a helper until the end of a day, says so, and shows it in the board's words", async () => {
    const api = peopleView();
    const set = vi.spyOn(api, "setAway");
    await screen.findByRole("list", { name: PEOPLE });
    const submit = within(form()).getByRole("button", { name: "Set cover" }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    expect((within(form()).getByLabelText("Helper who covers") as HTMLSelectElement).value).toBe("helper-mint");
    expect(within(form()).getByText("Cover lasts to the end of that day.")).toBeTruthy();

    fireEvent.change(within(form()).getByLabelText("Away until"), { target: { value: "2026-12-04" } });
    expect(submit.disabled).toBe(false);
    fireEvent.click(submit);

    const said = () => within(cover()).getAllByRole("status").map((box) => box.textContent);
    await waitFor(() => expect(said()).toContain("Mint covers messages until Friday 4 December."));
    expect(set).toHaveBeenCalledWith({ tenant: BAAN_MALI, helperId: "helper-mint", until: "2026-12-04T16:59:59.000Z" });
    await waitFor(() => expect(said()).toContain("You are away until Friday 4 December. Mint is covering messages."));
    expect(said()).not.toContain("You are away until Friday 27 November. Mint is covering messages.");
  });

  it("ends the cover, says so, and says nobody is covering", async () => {
    const api = peopleView();
    const clear = vi.spyOn(api, "clearAway");
    await screen.findByRole("list", { name: PEOPLE });
    fireEvent.click(within(cover()).getByRole("button", { name: "End cover" }));
    await waitFor(() => expect(within(cover()).getByRole("status").textContent).toBe("The cover has ended."));
    expect(clear).toHaveBeenCalledWith({ tenant: BAAN_MALI });
    await waitFor(() => expect(within(cover()).getByText("Nobody is covering. Choose a helper and a day to let them approve messages while Fon is away."))
      .toBeTruthy());
    expect(within(cover()).queryByRole("button", { name: "End cover" })).toBeNull();
    expect(within(rowWith("Mint")).queryByText("Covering")).toBeNull();
  });

  it("says why when the day has passed, keeps it to fix, and covers once a right day is chosen", async () => {
    peopleView();
    await screen.findByRole("list", { name: PEOPLE });
    const day = within(form()).getByLabelText("Away until") as HTMLInputElement;
    fireEvent.change(day, { target: { value: "2026-11-20" } });
    fireEvent.click(within(form()).getByRole("button", { name: "Set cover" }));
    expect((await within(cover()).findByRole("alert")).textContent).toBe("Choose a day that has not passed yet.");
    expect(day.value).toBe("2026-11-20");
    fireEvent.change(day, { target: { value: "2026-12-04" } });
    fireEvent.click(within(form()).getByRole("button", { name: "Set cover" }));
    await waitFor(() => expect(within(cover()).queryByRole("alert")).toBeNull());
    await waitFor(() => expect(within(cover()).getAllByRole("status").map((box) => box.textContent)).toContain(
      "You are away until Friday 4 December. Mint is covering messages."));
  });

  it("says when a cover is over, offers no End cover for it, and sets a new one", async () => {
    let now = NOW;
    const api = createFakeApi({ now: () => now, webOrigin: "https://web.test" });
    peopleView(api);
    await screen.findByRole("list", { name: PEOPLE });
    now = Date.parse("2026-11-28T03:00:00Z");
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(within(cover()).getByText("The cover for Mint ended on Friday 27 November. Nobody is covering now.")).toBeTruthy());
    expect(within(cover()).queryByRole("button", { name: "End cover" })).toBeNull();
    expect(within(rowWith("Mint")).queryByText("Covering")).toBeNull();
    fireEvent.change(within(form()).getByLabelText("Away until"), { target: { value: "2026-12-04" } });
    fireEvent.click(within(form()).getByRole("button", { name: "Set cover" }));
    await waitFor(() => expect(within(cover()).getAllByRole("status").map((box) => box.textContent)).toContain(
      "You are away until Friday 4 December. Mint is covering messages."));
  });

  it("says the list moved on when the helper is gone, and says so when the cover could not be saved", async () => {
    let answer = new ApiError(404, "not_a_helper");
    const setAway = vi.fn(async () => { throw answer; });
    const getPeople = vi.fn(async () => emptyPeople({ helpers: [MINT] }));
    peopleView(stubApi({ getPeople, setAway }), T1, "t1");
    await screen.findByRole("list", { name: PEOPLE });
    fireEvent.change(within(form()).getByLabelText("Away until"), { target: { value: "2026-12-04" } });
    fireEvent.click(within(form()).getByRole("button", { name: "Set cover" }));
    expect((await within(cover()).findByRole("alert")).textContent).toBe("That person is no longer a helper. The list was refreshed.");
    await waitFor(() => expect(getPeople).toHaveBeenCalledTimes(2));
    answer = new ApiError(503, "people_unavailable");
    fireEvent.click(within(form()).getByRole("button", { name: "Set cover" }));
    await waitFor(() => expect(within(cover()).getByRole("alert").textContent)
      .toBe("The API could not read or save this shop's people. Check the list, then try again."));
  });
});
