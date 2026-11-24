import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ApiError,
  type Outpost,
  type OutpostCredential,
  type OutpostRemoval,
  type PilotApi,
  type Shop,
  type SignIn,
} from "../src/api";
import { createFakeApi } from "../src/api/fake";
import { ConnectionsView } from "../src/ops/ConnectionsView";
import { OpsConsole } from "../src/ops/OpsConsole";
import { readOperatorKey } from "../src/ops/operatorKey";
import { deferred, renderWithApi, stubApi } from "./helpers";

// 10:00 on 23 November in Bangkok. The page words a time as "at 10:00" on the day the browser's clock says it is and as "on 23
// November at 10:00" on any other, so the clock is held here to keep every sentence below the same on every day the tests run.
const NOW = Date.parse("2026-11-23T03:00:00Z");

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});

const SHOPS: Shop[] = [
  { tenant: "t1", name: "Baan Mali", ownerName: "Fon", lineConnectionId: "line_1", consent: true },
  { tenant: "t2", name: "Sabai Tea", ownerName: "Dao", consent: false },
];

const SIGN_INS = "Baan Mali's site sign-ins";
const OUTPOSTS = "Baan Mali's outposts";
const CREDENTIAL = `mo1_${"Zq9".repeat(14)}Q`;

function signIn(overrides: Partial<SignIn> = {}): SignIn {
  return {
    id: "si-shopee", site: "Shopee Seller Centre", origins: ["https://seller.shopee.co.th"], username: "baanmali",
    members: ["nam", "pim"], state: "working", passwordSet: true, passwordSetAt: "2026-11-22T09:30:00.000Z", brokenAt: null,
    brokenBy: null, lastUsedAt: "2026-11-22T08:42:00.000Z", lastUsedBy: "nam", createdAt: "2026-11-14T03:00:00.000Z", ...overrides,
  };
}

const SHOPEE = signIn();
const CARRIER = signIn({
  id: "si-carrier", site: "Carrier portal", origins: ["https://portal.carrier.example"], members: ["nam"], state: "broken",
  passwordSetAt: "2026-11-20T03:00:00.000Z", brokenAt: "2026-11-23T01:00:00.000Z", brokenBy: "nam",
  lastUsedAt: "2026-11-23T00:59:00.000Z",
});

function outpost(overrides: Partial<Outpost> = {}): Outpost {
  return {
    id: "op-mac", name: "Fon's MacBook", kind: "this_mac", status: "online", lastHeartbeatAt: "2026-11-23T02:59:30.000Z",
    createdAt: "2026-11-21T03:00:00.000Z", ...overrides,
  };
}

const MAC = outpost();
const CLOUD = outpost({ id: "op-cloud", name: "Cloud outpost", kind: "cloud", status: "asleep", lastHeartbeatAt: null,
  createdAt: "2026-11-14T03:00:00.000Z" });

const unexpected = (name: string) => () => Promise.reject(new Error(`unexpected call: ${name}`));

type Routes = Partial<Pick<PilotApi, "listSignIns" | "listOutposts" | "setSignInMembers" | "removeSignIn" | "removeOutpost"
  | "replaceOutpostCredential">>;
type Options = { shops?: Shop[] | null; tenant?: string | null; onForget?: () => void };

/// The page over an API whose every route is the test's own, so a route the test did not mean to reach fails it by name.
function renderPage(routes: Routes = {}, options: Options = {}) {
  const calls = {
    listSignIns: vi.fn(routes.listSignIns ?? (async () => [SHOPEE, CARRIER])),
    listOutposts: vi.fn(routes.listOutposts ?? (async () => [MAC, CLOUD])),
    setSignInMembers: vi.fn(routes.setSignInMembers ?? unexpected("setSignInMembers")),
    removeSignIn: vi.fn(routes.removeSignIn ?? unexpected("removeSignIn")),
    removeOutpost: vi.fn(routes.removeOutpost ?? unexpected("removeOutpost")),
    replaceOutpostCredential: vi.fn(routes.replaceOutpostCredential ?? unexpected("replaceOutpostCredential")),
  };
  const view = renderWithApi(
    <ConnectionsView
      shops={options.shops === undefined ? SHOPS : options.shops}
      tenant={options.tenant === undefined ? "t1" : options.tenant}
      onForget={options.onForget ?? (() => {})}
    />,
    stubApi(calls),
  );
  return { calls, ...view };
}

const section = (name: string) => screen.getByRole("region", { name });
const rowsOf = (list: string) => within(screen.getByRole("list", { name: list })).getAllByRole("listitem");
const rowWith = (list: string, text: string) => {
  const row = rowsOf(list).find((item) => (item.textContent ?? "").includes(text));
  if (!row) throw new Error(`no row of "${list}" holds "${text}"`);
  return row;
};
const click = (name: string) => fireEvent.click(screen.getByRole("button", { name }));

/// Opens the question of a row's button, and answers the dialog it opens.
function ask(button: string, dialog: string) {
  click(button);
  return screen.getByRole("dialog", { name: dialog });
}

const REMOVE_SIGN_IN = "Remove the sign-in to Shopee Seller Centre as baanmali?";
const REMOVE_OUTPOST = "Remove Fon's MacBook?";
const GIVE_CREDENTIAL = "Give Fon's MacBook a new credential?";
const WHO = "Who may use Shopee Seller Centre?";

describe("the Connections page, reading a shop's vault", () => {
  it("shows a skeleton for each list while it reads, and then the sign-ins and outposts of the chosen shop", async () => {
    const signIns = deferred<SignIn[]>();
    const outposts = deferred<Outpost[]>();
    const { calls } = renderPage({ listSignIns: () => signIns.promise, listOutposts: () => outposts.promise });

    expect(screen.getByRole("heading", { level: 1, name: "Connections" })).toBeTruthy();
    expect(screen.getByLabelText("Loading the shop's sign-ins")).toBeTruthy();
    expect(screen.getByLabelText("Loading the shop's outposts")).toBeTruthy();
    expect(calls.listSignIns).toHaveBeenCalledWith("t1");
    expect(calls.listOutposts).toHaveBeenCalledWith("t1");

    // One list can arrive before the other, and neither waits for the other.
    outposts.resolve([MAC]);
    await screen.findByRole("list", { name: OUTPOSTS });
    expect(screen.getByLabelText("Loading the shop's sign-ins")).toBeTruthy();
    signIns.resolve([SHOPEE]);
    await screen.findByRole("list", { name: SIGN_INS });
    expect(screen.queryByLabelText(/^Loading the shop's/)).toBeNull();
    expect(calls.listSignIns).toHaveBeenCalledTimes(1);
    expect(calls.listOutposts).toHaveBeenCalledTimes(1);
  });

  it("says in one line that the owner adds sign-ins and types passwords in their own app, and takes none itself", async () => {
    const { container } = renderPage();
    await screen.findByRole("list", { name: SIGN_INS });
    expect(screen.getByText("To add a sign-in or give one a new password, the owner types it in their own app, under Customize › Connections. This console never takes a password.")).toBeTruthy();
    expect(screen.getByText("Which sites this shop's team can sign in to, and which machines run its browser. No password is ever shown here: the API never answers one. An outpost's credential is shown once, when you give it a new one.")).toBeTruthy();
    // No field to type one in, and nothing to add a sign-in with: the one control that is not a button is the shop picker.
    expect(container.querySelector("input, textarea")).toBeNull();
    expect(container.querySelectorAll("select")).toHaveLength(1);
    expect(screen.queryByRole("button", { name: /add|password/i })).toBeNull();
    expect(screen.getAllByRole("button").map((button) => button.getAttribute("aria-label") ?? button.textContent)).toEqual([
      "Refresh",
      "Change who may use Shopee Seller Centre", "Remove the sign-in to Shopee Seller Centre",
      "Change who may use Carrier portal", "Remove the sign-in to Carrier portal",
      "New credential for Fon's MacBook", "Remove the outpost Fon's MacBook",
      "New credential for Cloud outpost", "Remove the outpost Cloud outpost",
    ]);
  });

  it("lists a sign-in that works: its site, account, addresses, who may use it, when it was last used and its password's age", async () => {
    renderPage();
    await screen.findByRole("list", { name: SIGN_INS });
    const row = rowWith(SIGN_INS, "Shopee Seller Centre");
    expect(within(row).getByText("Account baanmali")).toBeTruthy();
    expect(within(row).getByText("Signs in only at https://seller.shopee.co.th.")).toBeTruthy();
    expect(within(row).getByText("May be used by Nam and Pim.")).toBeTruthy();
    expect(within(row).getByText("Working")).toBeTruthy();
    expect(within(row).getByText("Last used by Nam on 22 November at 15:42.")).toBeTruthy();
    expect(within(row).getByText("Password set on 22 November at 16:30.")).toBeTruthy();
    expect(within(row).queryByText(/refused/)).toBeNull();
  });

  it("says a sign-in is broken, by whom and when, and that only the owner can mend it with a new password", async () => {
    renderPage();
    await screen.findByRole("list", { name: SIGN_INS });
    const row = rowWith(SIGN_INS, "Carrier portal");
    expect(within(row).getByText("Broken")).toBeTruthy();
    expect(within(row).getByText("The site refused the saved password at 08:00, as Nam reported. It works again once the owner gives a new password in their own app."))
      .toBeTruthy();
    expect(within(row).getByText("Last used by Nam at 07:59.")).toBeTruthy();
    expect(within(row).getByText("Password set on 20 November at 10:00.")).toBeTruthy();
    expect(within(section("Site sign-ins for Baan Mali")).getByText("2 sign-ins, 1 broken")).toBeTruthy();
    // The working one says nothing of the kind.
    expect(within(rowWith(SIGN_INS, "Shopee Seller Centre")).queryByText("Broken")).toBeNull();
  });

  it("says a sign-in that was never used, and one whose break was reported by no member or at no time the API gave", async () => {
    renderPage({ listSignIns: async () => [
      signIn({ lastUsedAt: null, lastUsedBy: null }),
      signIn({ id: "si-odd", site: "Odd portal", state: "broken", brokenAt: null, brokenBy: null }),
    ] });
    await screen.findByRole("list", { name: SIGN_INS });
    expect(within(rowWith(SIGN_INS, "Shopee Seller Centre")).getByText("Never used.")).toBeTruthy();
    expect(within(rowWith(SIGN_INS, "Odd portal")).getByText("The site refused the saved password. It works again once the owner gives a new password in their own app."))
      .toBeTruthy();
  });

  it("lists an outpost that is online with its last heartbeat, and one that is asleep and has never beaten", async () => {
    renderPage();
    await screen.findByRole("list", { name: OUTPOSTS });
    const mac = rowWith(OUTPOSTS, "Fon's MacBook");
    expect(within(mac).getByText("A Mac with the app")).toBeTruthy();
    expect(within(mac).getByText("Online")).toBeTruthy();
    expect(within(mac).getByText("Last heartbeat at 09:59.")).toBeTruthy();
    expect(within(mac).getByText("Registered on 21 November at 10:00.")).toBeTruthy();
    expect(within(mac).queryByText("Work for it waits until it wakes.")).toBeNull();

    const cloud = rowWith(OUTPOSTS, "Cloud outpost");
    expect(within(cloud).getByText("A cloud outpost")).toBeTruthy();
    expect(within(cloud).getByText("Asleep")).toBeTruthy();
    expect(within(cloud).getByText("It has not sent a heartbeat yet.")).toBeTruthy();
    expect(within(cloud).getByText("Work for it waits until it wakes.")).toBeTruthy();
    expect(within(cloud).getByText("Registered on 14 November at 10:00.")).toBeTruthy();
    expect(within(section("Outposts for Baan Mali")).getByText("2 outposts, 1 online")).toBeTruthy();
  });

  it("says when an outpost last beat before it went to sleep, on the day it did", async () => {
    renderPage({ listOutposts: async () => [outpost({ status: "asleep", lastHeartbeatAt: "2026-11-22T13:05:00.000Z" })] });
    await screen.findByRole("list", { name: OUTPOSTS });
    const row = rowWith(OUTPOSTS, "Fon's MacBook");
    expect(within(row).getByText("Asleep")).toBeTruthy();
    expect(within(row).getByText("Last heartbeat on 22 November at 20:05.")).toBeTruthy();
    expect(within(row).getByText("Work for it waits until it wakes.")).toBeTruthy();
    expect(within(section("Outposts for Baan Mali")).getByText("1 outpost, 0 online")).toBeTruthy();
  });

  it("never shows a password, a seal or a credential, even if an answer carried one", async () => {
    const leaky = { ...SHOPEE, password: "hunter2-secret", sealed: "sealed-secret-blob", credentialHash: "ab".repeat(32) };
    const leakyOutpost = { ...MAC, credential: "mo1_leaked-credential", credentialHash: "cd".repeat(32) };
    const { container } = renderPage({ listSignIns: async () => [leaky as SignIn], listOutposts: async () => [leakyOutpost as Outpost] });
    await screen.findByRole("list", { name: SIGN_INS });
    await screen.findByRole("list", { name: OUTPOSTS });
    const everything = `${container.textContent} ${container.innerHTML}`;
    for (const secret of ["hunter2-secret", "sealed-secret-blob", "ab".repeat(32), "mo1_leaked-credential", "cd".repeat(32)]) {
      expect(everything).not.toContain(secret);
    }
  });

  it("shows a state, a kind and a member this console does not know yet as the API sent them", async () => {
    renderPage({
      listSignIns: async () => [signIn({ state: "retired" as never, members: ["nam", "lin"] })],
      listOutposts: async () => [outpost({ kind: "edge" as never, status: "dozing" as never })],
    });
    await screen.findByRole("list", { name: SIGN_INS });
    const row = rowWith(SIGN_INS, "Shopee Seller Centre");
    expect(within(row).getByText("retired")).toBeTruthy();
    expect(within(row).getByText("May be used by Nam and lin.")).toBeTruthy();
    // Nothing is said of a sign-in being broken that the API did not say.
    expect(within(row).queryByText(/refused the saved password/)).toBeNull();
    const mac = rowWith(OUTPOSTS, "Fon's MacBook");
    expect(within(mac).getByText("edge")).toBeTruthy();
    expect(within(mac).getByText("dozing")).toBeTruthy();
    expect(within(mac).queryByText("Work for it waits until it wakes.")).toBeNull();
  });

  it("says a shop has no sign-ins and no outposts, and where they come from, never an empty box", async () => {
    renderPage({ listSignIns: async () => [], listOutposts: async () => [] });
    expect(await screen.findByText("No site sign-ins yet. The owner adds one in their own app, under Customize › Connections.")).toBeTruthy();
    expect(screen.getByText("No outposts yet. The owner's desktop app registers their Mac as one. A cloud outpost is registered by an operator with POST /v1/admin/outposts."))
      .toBeTruthy();
    expect(screen.queryByRole("list", { name: SIGN_INS })).toBeNull();
    expect(screen.queryByRole("list", { name: OUTPOSTS })).toBeNull();
    expect(within(section("Site sign-ins for Baan Mali")).getByText("0 sign-ins")).toBeTruthy();
    expect(within(section("Outposts for Baan Mali")).getByText("0 outposts")).toBeTruthy();
  });

  it("says there are no shops when there are none, and that it is loading while the shops are", () => {
    const first = renderPage({}, { shops: [] });
    expect(screen.getByText("No shops yet.")).toBeTruthy();
    expect(first.calls.listSignIns).not.toHaveBeenCalled();
    first.unmount();
    const second = renderPage({}, { shops: null });
    expect(screen.getByLabelText("Loading connections")).toBeTruthy();
    expect(second.calls.listSignIns).not.toHaveBeenCalled();
    expect(second.calls.listOutposts).not.toHaveBeenCalled();
  });

  it("reads the other shop's vault when the shop is changed, and the first shop's lists are never shown under its name", async () => {
    const { calls } = renderPage({
      listSignIns: async (tenant) => (tenant === "t1" ? [SHOPEE] : []),
      listOutposts: async (tenant) => (tenant === "t1" ? [MAC] : []),
    });
    await screen.findByRole("list", { name: SIGN_INS });
    fireEvent.change(screen.getByLabelText("Shop"), { target: { value: "t2" } });
    expect(await screen.findByText("No site sign-ins yet. The owner adds one in their own app, under Customize › Connections.")).toBeTruthy();
    expect(screen.getByText("No outposts yet. The owner's desktop app registers their Mac as one. A cloud outpost is registered by an operator with POST /v1/admin/outposts."))
      .toBeTruthy();
    expect(calls.listSignIns.mock.calls).toEqual([["t1"], ["t2"]]);
    expect(calls.listOutposts.mock.calls).toEqual([["t1"], ["t2"]]);
    expect(screen.getByRole("heading", { level: 2, name: "Site sign-ins for Sabai Tea" })).toBeTruthy();
    expect(screen.queryByText("Shopee Seller Centre")).toBeNull();
  });

  it("starts on the shop chosen in the side menu, or the first when none is", async () => {
    const first = renderPage({}, { tenant: "t2" });
    await waitFor(() => expect(first.calls.listSignIns).toHaveBeenCalledWith("t2"));
    expect((screen.getByLabelText("Shop") as HTMLSelectElement).value).toBe("t2");
    first.unmount();
    const second = renderPage({}, { tenant: null });
    await waitFor(() => expect(second.calls.listSignIns).toHaveBeenCalledWith("t1"));
  });
});

describe("what the Connections page says when it cannot read a shop's vault", () => {
  it("says which list could not be read, keeps the other, and reads only that one again on Try again", async () => {
    let answer: SignIn[] | ApiError = new ApiError(503, "vault_unavailable");
    const listSignIns = vi.fn(async () => {
      if (answer instanceof ApiError) throw answer;
      return answer;
    });
    const { calls } = renderPage({ listSignIns });
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("The API could not read this shop's vault, so its sign-ins are not shown. Try again.");
    expect(screen.queryByRole("list", { name: SIGN_INS })).toBeNull();
    // The outposts are read, and shown, whatever became of the sign-ins.
    await screen.findByRole("list", { name: OUTPOSTS });
    expect(screen.getAllByRole("alert")).toHaveLength(1);
    expect(within(section("Site sign-ins for Baan Mali")).getByRole("alert")).toBe(alert);

    answer = [SHOPEE];
    fireEvent.click(within(alert).getByRole("button", { name: "Try again" }));
    await screen.findByRole("list", { name: SIGN_INS });
    expect(listSignIns).toHaveBeenCalledTimes(2);
    expect(calls.listOutposts).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("says when the outposts could not be read, with the sign-ins still shown", async () => {
    renderPage({ listOutposts: async () => { throw new ApiError(503, "vault_unavailable"); } });
    await screen.findByRole("list", { name: SIGN_INS });
    const alert = await within(section("Outposts for Baan Mali")).findByRole("alert");
    expect(alert.textContent).toContain("The API could not read this shop's vault, so its outposts are not shown. Try again.");
    expect(screen.queryByLabelText("Loading the shop's outposts")).toBeNull();
  });

  it("says when the API cannot be reached, in the console's usual words, in each list", async () => {
    renderPage({ listSignIns: async () => { throw new ApiError(0, "network"); }, listOutposts: async () => { throw new ApiError(0, "network"); } });
    await waitFor(() => expect(screen.getAllByRole("alert")).toHaveLength(2));
    for (const alert of screen.getAllByRole("alert")) {
      expect(alert.textContent).toContain("Could not reach the API. Check the connection and try again.");
    }
  });

  it("says once, at the top, that the API refused the key, and offers another, with neither list saying it again", async () => {
    const onForget = vi.fn();
    renderPage({
      listSignIns: async () => { throw new ApiError(403, "forbidden"); },
      listOutposts: async () => { throw new ApiError(403, "forbidden"); },
    }, { onForget });
    await screen.findByText(/The API refused the operator key/);
    expect(screen.getAllByRole("alert")).toHaveLength(1);
    expect(screen.queryByLabelText(/^Loading the shop's/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Enter another key" }));
    expect(onForget).toHaveBeenCalledTimes(1);
  });

  it("reads both lists again on Refresh, and the key's refusal clears once the API takes it", async () => {
    let refused = true;
    const answer = async () => {
      if (refused) throw new ApiError(401, "unauthorized");
      return [];
    };
    const { calls } = renderPage({ listSignIns: answer, listOutposts: answer });
    await screen.findByText(/The API refused the operator key/);
    refused = false;
    click("Refresh");
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    expect(calls.listSignIns).toHaveBeenCalledTimes(2);
    expect(calls.listOutposts).toHaveBeenCalledTimes(2);
  });
});

describe("removing a sign-in", () => {
  it("asks in the sign-in's own row, in words that name what happens, and sends nothing until the operator says yes", async () => {
    const { calls } = renderPage();
    await screen.findByRole("list", { name: SIGN_INS });
    const dialog = ask("Remove the sign-in to Shopee Seller Centre", REMOVE_SIGN_IN);
    expect(rowWith(SIGN_INS, "Shopee Seller Centre").contains(dialog)).toBe(true);
    expect(within(dialog).getByText("The team can no longer sign in to Shopee Seller Centre. Its saved password is deleted from the vault, and a sign-in already asked for and not yet used is refused."))
      .toBeTruthy();
    expect(within(dialog).getByText("This cannot be undone. To use it again, the owner adds it again with its password, in their own app."))
      .toBeTruthy();
    expect(calls.removeSignIn).not.toHaveBeenCalled();
    // The other sign-in's row has no question.
    expect(within(rowWith(SIGN_INS, "Carrier portal")).queryByRole("dialog")).toBeNull();
  });

  it("sends nothing when the operator keeps it, closes the question, and leaves the list as it was", async () => {
    const { calls } = renderPage();
    await screen.findByRole("list", { name: SIGN_INS });
    const dialog = ask("Remove the sign-in to Shopee Seller Centre", REMOVE_SIGN_IN);
    fireEvent.click(within(dialog).getByRole("button", { name: "Keep it" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(calls.removeSignIn).not.toHaveBeenCalled();
    expect(rowsOf(SIGN_INS)).toHaveLength(2);
    expect(calls.listSignIns).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("removes it on yes, says what happened, and reads the sign-ins again, and only the sign-ins", async () => {
    let list = [SHOPEE, CARRIER];
    const { calls } = renderPage({
      listSignIns: async () => list,
      removeSignIn: async ({ signInId }) => {
        list = list.filter((one) => one.id !== signInId);
        return { removed: true, signInId };
      },
    });
    await screen.findByRole("list", { name: SIGN_INS });
    const dialog = ask("Remove the sign-in to Shopee Seller Centre", REMOVE_SIGN_IN);
    fireEvent.click(within(dialog).getByRole("button", { name: "Remove Shopee Seller Centre" }));

    const said = await within(section("Site sign-ins for Baan Mali")).findByRole("status");
    expect(said.textContent).toBe("Removed the sign-in to Shopee Seller Centre. The team can no longer sign in there.");
    expect(calls.removeSignIn).toHaveBeenCalledWith({ tenant: "t1", signInId: "si-shopee" });
    expect(screen.queryByRole("dialog")).toBeNull();
    await waitFor(() => expect(rowsOf(SIGN_INS)).toHaveLength(1));
    expect(screen.queryByText("Shopee Seller Centre")).toBeNull();
    expect(within(section("Site sign-ins for Baan Mali")).getByText("1 sign-in, 1 broken")).toBeTruthy();
    expect(calls.listSignIns).toHaveBeenCalledTimes(2);
    expect(calls.listOutposts).toHaveBeenCalledTimes(1);
  });

  it("says the sign-in is already gone when the API says so, closes the question, and reads the list again", async () => {
    const lists = [[SHOPEE, CARRIER], [CARRIER]];
    const { calls } = renderPage({
      listSignIns: async () => lists.shift() ?? [CARRIER],
      removeSignIn: async () => { throw new ApiError(404, "sign_in_not_found"); },
    });
    await screen.findByRole("list", { name: SIGN_INS });
    const dialog = ask("Remove the sign-in to Shopee Seller Centre", REMOVE_SIGN_IN);
    fireEvent.click(within(dialog).getByRole("button", { name: "Remove Shopee Seller Centre" }));
    await waitFor(() => expect(calls.listSignIns).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(rowsOf(SIGN_INS)).toHaveLength(1));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByRole("alert").textContent).toBe("That sign-in is already gone. The list was refreshed.");
  });

  it("keeps the question open when the vault did not answer, saying a change may or may not have been made, so it can be tried again", async () => {
    let answer: ApiError | null = new ApiError(503, "vault_unavailable");
    const removeSignIn = vi.fn(async ({ signInId }: { signInId: string }) => {
      if (answer) throw answer;
      return { removed: true as const, signInId };
    });
    const { calls } = renderPage({ removeSignIn });
    await screen.findByRole("list", { name: SIGN_INS });
    const dialog = ask("Remove the sign-in to Shopee Seller Centre", REMOVE_SIGN_IN);
    fireEvent.click(within(dialog).getByRole("button", { name: "Remove Shopee Seller Centre" }));
    expect((await screen.findByRole("alert")).textContent)
      .toBe("The API could not reach this shop's vault, so nothing may have changed. Press Refresh to check, then try again.");
    // Not read again: the list the page shows is the last it knew, and the operator decides.
    expect(calls.listSignIns).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("dialog", { name: REMOVE_SIGN_IN })).toBeTruthy();
    expect((within(dialog).getByRole("button", { name: "Remove Shopee Seller Centre" }) as HTMLButtonElement).disabled).toBe(false);

    answer = null;
    fireEvent.click(within(dialog).getByRole("button", { name: "Remove Shopee Seller Centre" }));
    expect((await screen.findByRole("status")).textContent).toContain("Removed the sign-in to Shopee Seller Centre.");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(removeSignIn).toHaveBeenCalledTimes(2);
  });
});

describe("changing who may use a sign-in", () => {
  const dialogOf = () => screen.getByRole("dialog", { name: WHO });
  const box = (name: string) => within(dialogOf()).getByRole("checkbox", { name }) as HTMLInputElement;
  const saveButton = () =>
    within(dialogOf()).getByRole("button", { name: /^(Save who may use it|Let .+ use it)$/ }) as HTMLButtonElement;

  async function open(routes: Routes = {}) {
    const rendered = renderPage(routes);
    await screen.findByRole("list", { name: SIGN_INS });
    ask("Change who may use Shopee Seller Centre", WHO);
    return rendered;
  }

  it("opens a box for each member the vault may be told, ticked for those who may use it now, and sends nothing", async () => {
    const { calls } = await open();
    expect(rowWith(SIGN_INS, "Shopee Seller Centre").contains(dialogOf())).toBe(true);
    expect(within(dialogOf()).getByText("Members who may use it")).toBeTruthy();
    expect(["Nam", "Pim", "Ton", "Kit"].map((name) => box(name).checked)).toEqual([true, true, false, false]);
    expect(within(dialogOf()).getAllByRole("checkbox")).toHaveLength(4);
    // Nothing has changed, so there is nothing to save.
    expect(within(dialogOf()).getByText("That is who may use it now.")).toBeTruthy();
    expect(saveButton().textContent).toBe("Save who may use it");
    expect(saveButton().disabled).toBe(true);
    expect(calls.setSignInMembers).not.toHaveBeenCalled();
  });

  it("says exactly what saving would do as the boxes are ticked, and names the button for it", async () => {
    await open();
    fireEvent.click(box("Ton"));
    expect(within(dialogOf()).getByText("Ton may use Shopee Seller Centre from now on.")).toBeTruthy();
    expect(saveButton().textContent).toBe("Let Nam, Pim and Ton use it");
    expect(saveButton().disabled).toBe(false);

    fireEvent.click(box("Pim"));
    expect(within(dialogOf()).getByText("Ton may use Shopee Seller Centre from now on. Pim can no longer use it, and anything they asked for and have not used yet is refused."))
      .toBeTruthy();
    expect(saveButton().textContent).toBe("Let Nam and Ton use it");

    fireEvent.click(box("Nam"));
    expect(within(dialogOf()).getByText("Ton may use Shopee Seller Centre from now on. Nam and Pim can no longer use it, and anything they asked for and have not used yet is refused."))
      .toBeTruthy();
    expect(saveButton().textContent).toBe("Let Ton use it");

    // Back to who may use it now: nothing to save again.
    fireEvent.click(box("Ton"));
    fireEvent.click(box("Nam"));
    fireEvent.click(box("Pim"));
    expect(within(dialogOf()).getByText("That is who may use it now.")).toBeTruthy();
    expect(saveButton().disabled).toBe(true);
  });

  it("will not save with nobody ticked, and says to remove the sign-in instead", async () => {
    const { calls } = await open();
    fireEvent.click(box("Nam"));
    fireEvent.click(box("Pim"));
    expect(within(dialogOf()).getByText("Choose at least one member. To stop everyone using it, remove the sign-in.")).toBeTruthy();
    expect(saveButton().textContent).toBe("Save who may use it");
    expect(saveButton().disabled).toBe(true);
    fireEvent.click(saveButton());
    expect(calls.setSignInMembers).not.toHaveBeenCalled();
  });

  it("sends nothing when the operator keeps it as it is, and opens at who may use it now the next time", async () => {
    const { calls } = await open();
    fireEvent.click(box("Ton"));
    fireEvent.click(within(dialogOf()).getByRole("button", { name: "Keep it as it is" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(calls.setSignInMembers).not.toHaveBeenCalled();
    ask("Change who may use Shopee Seller Centre", WHO);
    expect(box("Ton").checked).toBe(false);
    expect(within(dialogOf()).getByText("That is who may use it now.")).toBeTruthy();
  });

  it("saves the members in the order the API lists them, whatever order they were ticked in, and says what the API answered", async () => {
    const setSignInMembers = vi.fn(async (input: { members: string[] }) => ({ ...SHOPEE, members: input.members.slice(0, 1) }));
    const { calls } = await open({ setSignInMembers });
    fireEvent.click(box("Kit"));
    fireEvent.click(box("Ton"));
    fireEvent.click(box("Pim"));
    fireEvent.click(saveButton());

    // The notice is what the API said was written, which here is not everything that was ticked.
    expect((await within(section("Site sign-ins for Baan Mali")).findByRole("status")).textContent)
      .toBe("Saved. Nam may use Shopee Seller Centre from now on.");
    expect(calls.setSignInMembers).toHaveBeenCalledWith({ tenant: "t1", signInId: "si-shopee", members: ["nam", "ton", "kit"] });
    expect(screen.queryByRole("dialog")).toBeNull();
    await waitFor(() => expect(calls.listSignIns).toHaveBeenCalledTimes(2));
    expect(calls.listOutposts).toHaveBeenCalledTimes(1);
  });

  it("shows a member this console does not know yet that the sign-in has, so saving never takes it off unseen", async () => {
    const setSignInMembers = vi.fn(async (input: { members: string[] }) => ({ ...SHOPEE, members: input.members }));
    renderPage({ listSignIns: async () => [signIn({ members: ["nam", "lin"] })], setSignInMembers });
    await screen.findByRole("list", { name: SIGN_INS });
    ask("Change who may use Shopee Seller Centre", WHO);
    expect(within(dialogOf()).getAllByRole("checkbox").map((one) => (one as HTMLInputElement).labels?.[0]?.textContent)).toEqual([
      "Nam", "Pim", "Ton", "Kit", "lin"]);
    expect(box("lin").checked).toBe(true);
    fireEvent.click(box("Nam"));
    fireEvent.click(box("Pim"));
    fireEvent.click(saveButton());
    await screen.findByRole("status");
    expect(setSignInMembers).toHaveBeenCalledWith({ tenant: "t1", signInId: "si-shopee", members: ["pim", "lin"] });
  });

  it("says the sign-in is already gone when the API says so, and what the vault says of a list it refuses", async () => {
    const answers = [new ApiError(404, "sign_in_not_found"), new ApiError(400, "invalid_members")];
    const { calls } = await open({ setSignInMembers: async () => { throw answers.shift()!; } });
    fireEvent.click(box("Ton"));
    fireEvent.click(saveButton());
    expect((await screen.findByRole("alert")).textContent).toBe("That sign-in is already gone. The list was refreshed.");
    await waitFor(() => expect(calls.listSignIns).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole("dialog")).toBeNull();

    ask("Change who may use Shopee Seller Centre", WHO);
    fireEvent.click(box("Ton"));
    fireEvent.click(saveButton());
    await waitFor(() => expect(screen.getByRole("alert").textContent)
      .toBe("Choose who may use it: one or more of Nam, Pim, Ton and Kit."));
    // A list the vault refused leaves the question open, to be fixed.
    expect(screen.getByRole("dialog", { name: WHO })).toBeTruthy();
  });
});

describe("removing an outpost", () => {
  it("asks in the outpost's own row, in words that name what happens, and sends nothing until the operator says yes", async () => {
    const { calls } = renderPage();
    await screen.findByRole("list", { name: OUTPOSTS });
    const dialog = ask("Remove the outpost Fon's MacBook", REMOVE_OUTPOST);
    expect(rowWith(OUTPOSTS, "Fon's MacBook").contains(dialog)).toBe(true);
    expect(within(dialog).getByText("Fon's MacBook stops working for this shop at once: its credential no longer works, and any step waiting for it is refused."))
      .toBeTruthy();
    expect(within(dialog).getByText("It must be registered again to work.")).toBeTruthy();
    expect(calls.removeOutpost).not.toHaveBeenCalled();

    fireEvent.click(within(dialog).getByRole("button", { name: "Keep it" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(calls.removeOutpost).not.toHaveBeenCalled();
    expect(rowsOf(OUTPOSTS)).toHaveLength(2);
    expect(calls.listOutposts).toHaveBeenCalledTimes(1);
  });

  it("removes it on yes, says what the API refused, and reads the outposts again, and only the outposts", async () => {
    let list = [MAC, CLOUD];
    const removeOutpost = vi.fn(async ({ outpostId }: { outpostId: string }): Promise<OutpostRemoval> => {
      list = list.filter((one) => one.id !== outpostId);
      return { removed: true, outpostId, stepsRefused: 2, grantsRefused: 1 };
    });
    const { calls } = renderPage({ listOutposts: async () => list, removeOutpost });
    await screen.findByRole("list", { name: OUTPOSTS });
    const dialog = ask("Remove the outpost Fon's MacBook", REMOVE_OUTPOST);
    fireEvent.click(within(dialog).getByRole("button", { name: "Remove Fon's MacBook" }));

    const said = await within(section("Outposts for Baan Mali")).findByRole("status");
    expect(said.textContent).toBe("Removed. Fon's MacBook no longer works for Baan Mali. 2 steps waiting for it were refused. 1 sign-in permission it held, not yet used, was cancelled.");
    expect(removeOutpost).toHaveBeenCalledWith({ tenant: "t1", outpostId: "op-mac" });
    await waitFor(() => expect(rowsOf(OUTPOSTS)).toHaveLength(1));
    expect(screen.queryByText("Fon's MacBook")).toBeNull();
    expect(calls.listOutposts).toHaveBeenCalledTimes(2);
    expect(calls.listSignIns).toHaveBeenCalledTimes(1);
  });

  it("says nothing of steps or permissions when none waited, and says one of each in the singular", async () => {
    const answers: OutpostRemoval[] = [
      { removed: true, outpostId: "op-mac", stepsRefused: 0, grantsRefused: 0 },
      { removed: true, outpostId: "op-cloud", stepsRefused: 1, grantsRefused: 0 },
    ];
    renderPage({ removeOutpost: async () => answers.shift()! });
    await screen.findByRole("list", { name: OUTPOSTS });
    fireEvent.click(within(ask("Remove the outpost Fon's MacBook", REMOVE_OUTPOST)).getByRole("button", { name: "Remove Fon's MacBook" }));
    expect((await screen.findByRole("status")).textContent).toBe("Removed. Fon's MacBook no longer works for Baan Mali.");
    fireEvent.click(within(ask("Remove the outpost Cloud outpost", "Remove Cloud outpost?")).getByRole("button", { name: "Remove Cloud outpost" }));
    await waitFor(() => expect(screen.getByRole("status").textContent)
      .toBe("Removed. Cloud outpost no longer works for Baan Mali. 1 step waiting for it was refused."));
  });

  it("says the outpost is already gone when the API says so, closes the question and reads the list again", async () => {
    const lists = [[MAC, CLOUD], [CLOUD]];
    const { calls } = renderPage({
      listOutposts: async () => lists.shift() ?? [CLOUD],
      removeOutpost: async () => { throw new ApiError(404, "outpost_not_found"); },
    });
    await screen.findByRole("list", { name: OUTPOSTS });
    fireEvent.click(within(ask("Remove the outpost Fon's MacBook", REMOVE_OUTPOST)).getByRole("button", { name: "Remove Fon's MacBook" }));
    await waitFor(() => expect(calls.listOutposts).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(rowsOf(OUTPOSTS)).toHaveLength(1));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByRole("alert").textContent).toBe("That outpost is already gone. The list was refreshed.");
  });

  it("offers another key when the API refuses the key on a change, and leaves the question open", async () => {
    const onForget = vi.fn();
    renderPage({ removeOutpost: async () => { throw new ApiError(403, "forbidden"); } }, { onForget });
    await screen.findByRole("list", { name: OUTPOSTS });
    fireEvent.click(within(ask("Remove the outpost Fon's MacBook", REMOVE_OUTPOST)).getByRole("button", { name: "Remove Fon's MacBook" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("The API refused the operator key");
    expect(screen.getByRole("dialog", { name: REMOVE_OUTPOST })).toBeTruthy();
    fireEvent.click(within(alert).getByRole("button", { name: "Enter another key" }));
    expect(onForget).toHaveBeenCalledTimes(1);
  });
});

describe("giving an outpost a new credential, which is shown once", () => {
  const BODY = (credential = CREDENTIAL, id = "op-mac"): OutpostCredential => ({
    outpost: outpost({ id, status: "asleep", lastHeartbeatAt: null }), credential });
  const CREDENTIAL_BOX = "The new credential for Fon's MacBook";

  /// Writes the clipboard where a test can see what was copied.
  function clipboard() {
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    return writeText;
  }

  async function give(routes: Routes = {}) {
    const rendered = renderPage({ replaceOutpostCredential: async () => BODY(), ...routes });
    await screen.findByRole("list", { name: OUTPOSTS });
    const dialog = ask("New credential for Fon's MacBook", GIVE_CREDENTIAL);
    return { ...rendered, dialog };
  }

  it("asks first, saying the old credential stops at once and the new one is shown once, and sends nothing until yes", async () => {
    const { calls, dialog } = await give();
    expect(rowWith(OUTPOSTS, "Fon's MacBook").contains(dialog)).toBe(true);
    expect(within(dialog).getByText("The old credential stops working at once, and Fon's MacBook is asleep until whoever runs it starts it with the new one."))
      .toBeTruthy();
    expect(within(dialog).getByText("The new credential is shown once. Nothing keeps it, so copy it before you leave this page.")).toBeTruthy();
    expect(calls.replaceOutpostCredential).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "Keep the old one" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(calls.replaceOutpostCredential).not.toHaveBeenCalled();
    expect(screen.queryByRole("region", { name: /new credential/ })).toBeNull();
    expect(screen.queryByDisplayValue(CREDENTIAL)).toBeNull();
  });

  it("shows the credential once, in a read-only field beside a Copy button, and says only that one was made in the list", async () => {
    const writeText = clipboard();
    let after: Outpost[] = [MAC, CLOUD];
    const { calls, dialog } = await give({
      listOutposts: async () => after,
      replaceOutpostCredential: async () => {
        after = [outpost({ status: "asleep", lastHeartbeatAt: null }), CLOUD];
        return BODY();
      },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Give Fon's MacBook a new credential" }));

    const box = await screen.findByRole("region", { name: CREDENTIAL_BOX });
    const field = within(box).getByLabelText("Credential") as HTMLInputElement;
    expect(field.value).toBe(CREDENTIAL);
    expect(field.readOnly).toBe(true);
    expect(field.getAttribute("autocomplete")).toBe("off");
    expect(within(box).getByText("Shown once. Copy it now and give it to whoever runs this outpost: nothing here keeps it, and it cannot be shown again. It is forgotten when you press Done or leave this page."))
      .toBeTruthy();
    expect(calls.replaceOutpostCredential).toHaveBeenCalledWith({ tenant: "t1", outpostId: "op-mac" });
    expect(screen.queryByRole("dialog")).toBeNull();

    // The list says that a credential was made and that the Mac is asleep, and never says what the credential is.
    const said = await within(section("Outposts for Baan Mali")).findByRole("status");
    expect(said.textContent).toBe("A new credential was made for Fon's MacBook. The old one no longer works.");
    await waitFor(() => expect(within(rowWith(OUTPOSTS, "Fon's MacBook")).getByText("Asleep")).toBeTruthy());
    expect(calls.listOutposts).toHaveBeenCalledTimes(2);
    expect(rowsOf(OUTPOSTS).map((row) => row.textContent).join(" ")).not.toContain(CREDENTIAL);

    fireEvent.click(within(box).getByRole("button", { name: "Copy the new credential" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(CREDENTIAL));
    expect(await within(box).findByRole("button", { name: "Copied" })).toBeTruthy();
  });

  it("says to select the credential and copy it by hand when the clipboard is blocked", async () => {
    Object.defineProperty(navigator, "clipboard", { value: { writeText: () => Promise.reject(new Error("blocked")) }, configurable: true });
    const { dialog } = await give();
    fireEvent.click(within(dialog).getByRole("button", { name: "Give Fon's MacBook a new credential" }));
    const box = await screen.findByRole("region", { name: CREDENTIAL_BOX });
    fireEvent.click(within(box).getByRole("button", { name: "Copy the new credential" }));
    expect((await within(box).findByRole("alert")).textContent).toBe("Could not copy. Select the credential and copy it by hand.");
  });

  it("lets the credential go when Done is pressed: not on the page, in a field, in the markup or anywhere it could be read again", async () => {
    const { dialog } = await give();
    fireEvent.click(within(dialog).getByRole("button", { name: "Give Fon's MacBook a new credential" }));
    const box = await screen.findByRole("region", { name: CREDENTIAL_BOX });
    expect(document.body.innerHTML).toContain(CREDENTIAL);
    fireEvent.click(within(box).getByRole("button", { name: "Done" }));
    expect(screen.queryByRole("region", { name: CREDENTIAL_BOX })).toBeNull();
    expect(screen.queryByDisplayValue(CREDENTIAL)).toBeNull();
    expect(document.body.innerHTML).not.toContain(CREDENTIAL);
    expect(document.body.textContent).not.toContain(CREDENTIAL);
    // What was said stays said, and still holds no credential.
    expect(screen.getByRole("status").textContent).toBe("A new credential was made for Fon's MacBook. The old one no longer works.");
  });

  it("lets the credential go when the shop is changed, and never shows it under another shop's name", async () => {
    const { dialog } = await give();
    fireEvent.click(within(dialog).getByRole("button", { name: "Give Fon's MacBook a new credential" }));
    await screen.findByRole("region", { name: CREDENTIAL_BOX });
    fireEvent.change(screen.getByLabelText("Shop"), { target: { value: "t2" } });
    await waitFor(() => expect(screen.queryByRole("region", { name: CREDENTIAL_BOX })).toBeNull());
    expect(document.body.innerHTML).not.toContain(CREDENTIAL);
    fireEvent.change(screen.getByLabelText("Shop"), { target: { value: "t1" } });
    await screen.findByRole("list", { name: OUTPOSTS });
    expect(screen.queryByRole("region", { name: CREDENTIAL_BOX })).toBeNull();
    expect(document.body.innerHTML).not.toContain(CREDENTIAL);
  });

  it("shows only the newest credential when another is made, and the first one's is gone from the page", async () => {
    const { dialog } = await give({
      replaceOutpostCredential: async ({ outpostId }) => BODY(outpostId === "op-mac" ? CREDENTIAL : `mo1_${"Yx7".repeat(14)}R`, outpostId),
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Give Fon's MacBook a new credential" }));
    await screen.findByRole("region", { name: CREDENTIAL_BOX });
    ask("New credential for Cloud outpost", "Give Cloud outpost a new credential?");
    fireEvent.click(screen.getByRole("button", { name: "Give Cloud outpost a new credential" }));
    const second = await screen.findByRole("region", { name: "The new credential for Cloud outpost" });
    expect(screen.getAllByRole("region", { name: /^The new credential for/ })).toHaveLength(1);
    expect((within(second).getByLabelText("Credential") as HTMLInputElement).value).toBe(`mo1_${"Yx7".repeat(14)}R`);
    expect(document.body.innerHTML).not.toContain(CREDENTIAL);
  });

  it("lets the credential go when its outpost is removed, since nobody can use it", async () => {
    const { dialog } = await give({ removeOutpost: async ({ outpostId }) => ({ removed: true, outpostId, stepsRefused: 0, grantsRefused: 0 }) });
    fireEvent.click(within(dialog).getByRole("button", { name: "Give Fon's MacBook a new credential" }));
    await screen.findByRole("region", { name: CREDENTIAL_BOX });
    fireEvent.click(within(ask("Remove the outpost Fon's MacBook", REMOVE_OUTPOST)).getByRole("button", { name: "Remove Fon's MacBook" }));
    await waitFor(() => expect(screen.queryByRole("region", { name: CREDENTIAL_BOX })).toBeNull());
    expect(document.body.innerHTML).not.toContain(CREDENTIAL);
  });

  it("keeps the credential through a Refresh, since the operator may still be copying it", async () => {
    const { calls, dialog } = await give();
    fireEvent.click(within(dialog).getByRole("button", { name: "Give Fon's MacBook a new credential" }));
    await screen.findByRole("region", { name: CREDENTIAL_BOX });
    click("Refresh");
    await waitFor(() => expect(calls.listOutposts).toHaveBeenCalledTimes(3));
    expect((screen.getByLabelText("Credential") as HTMLInputElement).value).toBe(CREDENTIAL);
  });

  it("says the outpost is already gone when the API says so, and shows no credential", async () => {
    const { calls, dialog } = await give({ replaceOutpostCredential: async () => { throw new ApiError(404, "outpost_not_found"); } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Give Fon's MacBook a new credential" }));
    expect((await screen.findByRole("alert")).textContent).toBe("That outpost is already gone. The list was refreshed.");
    await waitFor(() => expect(calls.listOutposts).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole("region", { name: CREDENTIAL_BOX })).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("shows no credential when the vault did not answer, says one may have been made, and keeps the question open", async () => {
    const { dialog } = await give({ replaceOutpostCredential: async () => { throw new ApiError(503, "vault_unavailable"); } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Give Fon's MacBook a new credential" }));
    expect((await screen.findByRole("alert")).textContent)
      .toBe("The API could not reach this shop's vault, so nothing may have changed. Press Refresh to check, then try again.");
    expect(screen.queryByRole("region", { name: CREDENTIAL_BOX })).toBeNull();
    expect(screen.getByRole("dialog", { name: GIVE_CREDENTIAL })).toBeTruthy();
  });

  it("has no field but the credential's, read only, and no way to type a password, at any point in the flow", async () => {
    const { container, dialog } = await give();
    expect(container.querySelector("input")).toBeNull();
    fireEvent.click(within(dialog).getByRole("button", { name: "Give Fon's MacBook a new credential" }));
    await screen.findByRole("region", { name: CREDENTIAL_BOX });
    const inputs = [...container.querySelectorAll("input")];
    expect(inputs).toHaveLength(1);
    expect(inputs[0]).toMatchObject({ readOnly: true, type: "text" });
    expect(container.querySelector('input[type="password"], textarea')).toBeNull();
  });
});

describe("one change at a time", () => {
  it("sends one request however often the button is pressed before the page has drawn the first answer", async () => {
    const pending = deferred<{ removed: true; signInId: string }>();
    const { calls } = renderPage({ removeSignIn: () => pending.promise });
    await screen.findByRole("list", { name: SIGN_INS });
    const dialog = ask("Remove the sign-in to Shopee Seller Centre", REMOVE_SIGN_IN);
    const yes = within(dialog).getByRole("button", { name: "Remove Shopee Seller Centre" }) as HTMLButtonElement;
    // Two presses in one step, before React has drawn the first one's busy state: the page's own guard has to hold.
    act(() => {
      yes.click();
      yes.click();
    });
    await waitFor(() => expect(yes.disabled).toBe(true));
    expect(calls.removeSignIn).toHaveBeenCalledTimes(1);
    pending.resolve({ removed: true, signInId: "si-shopee" });
    await screen.findByRole("status");
    expect(calls.removeSignIn).toHaveBeenCalledTimes(1);
  });

  it("says it is working in the button, and locks every other button on the page while it waits", async () => {
    const pending = deferred<OutpostRemoval>();
    const { calls } = renderPage({ removeOutpost: () => pending.promise });
    await screen.findByRole("list", { name: OUTPOSTS });
    const dialog = ask("Remove the outpost Fon's MacBook", REMOVE_OUTPOST);
    fireEvent.click(within(dialog).getByRole("button", { name: "Remove Fon's MacBook" }));
    const working = await within(dialog).findByRole("button", { name: "Removing" }) as HTMLButtonElement;
    expect(working.disabled).toBe(true);
    expect(working.getAttribute("aria-busy")).toBe("true");
    expect((within(dialog).getByRole("button", { name: "Keep it" }) as HTMLButtonElement).disabled).toBe(true);
    for (const button of screen.getAllByRole("button")) {
      if (button.getAttribute("aria-label") !== null || button.textContent === "Keep it") {
        expect((button as HTMLButtonElement).disabled, button.getAttribute("aria-label") ?? "Keep it").toBe(true);
      }
    }
    expect(calls.removeOutpost).toHaveBeenCalledTimes(1);
    pending.resolve({ removed: true, outpostId: "op-mac", stepsRefused: 0, grantsRefused: 0 });
    await screen.findByRole("status");
    await waitFor(() => expect((screen.getByRole("button", { name: "Remove the outpost Cloud outpost" }) as HTMLButtonElement).disabled).toBe(false));
  });

  it("has only one question open at a time: asking another closes the first, and nothing is sent by either", async () => {
    const { calls } = renderPage();
    await screen.findByRole("list", { name: SIGN_INS });
    ask("Change who may use Shopee Seller Centre", WHO);
    ask("Remove the outpost Fon's MacBook", REMOVE_OUTPOST);
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    expect(screen.queryByRole("dialog", { name: WHO })).toBeNull();
    ask("Remove the sign-in to Carrier portal", "Remove the sign-in to Carrier portal as baanmali?");
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    for (const call of [calls.setSignInMembers, calls.removeSignIn, calls.removeOutpost, calls.replaceOutpostCredential]) {
      expect(call).not.toHaveBeenCalled();
    }
  });
});

// Through the console, the way an operator reaches it, with the practice world's own vault behind it: what the side menu offers,
// what the Shops page links to, and what becomes of a credential once the page is left.
describe("the Connections page in the console, over the practice world", () => {
  function practice() {
    sessionStorage.setItem("manut.pilot.operatorKey", "op-key-123");
    const api = createFakeApi({ operatorKey: readOperatorKey, now: () => NOW, webOrigin: "https://web.test", storage: localStorage });
    renderWithApi(<OpsConsole />, api);
    return api;
  }

  it("opens from the side menu beside Model spend, for the shop chosen there, and going back to a shop leaves it", async () => {
    practice();
    const nav = await screen.findByRole("button", { name: "Connections" });
    const names = screen.getAllByRole("navigation", { name: "Console" })[0]!.querySelectorAll("button.nav");
    expect([...names].map((button) => button.textContent).slice(0, 8)).toEqual([
      "Shops", "Pilot gate", "Audit", "Memory", "Drafts", "People", "Model spend", "Connections"]);
    await screen.findByRole("button", { name: "Baan Mali" });
    fireEvent.click(screen.getByRole("button", { name: "Sabai Tea" }));
    fireEvent.click(nav);
    expect(await screen.findByRole("heading", { level: 1, name: "Connections" })).toBeTruthy();
    expect(nav.getAttribute("aria-current")).toBe("page");
    expect((screen.getByLabelText("Shop") as HTMLSelectElement).value).toBe("shop_sabaitea");
    // Sabai Tea's vault is empty.
    expect(await screen.findByText("No site sign-ins yet. The owner adds one in their own app, under Customize › Connections.")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Baan Mali" }));
    expect(await screen.findByRole("heading", { level: 1, name: "Baan Mali" })).toBeTruthy();
    expect(nav.getAttribute("aria-current")).toBeNull();
  });

  it("shows Baan Mali's sample vault as the practice world keeps it: a sign-in that works, one that is broken, an outpost online and one asleep", async () => {
    practice();
    fireEvent.click(await screen.findByRole("button", { name: "Connections" }));
    await screen.findByRole("list", { name: SIGN_INS });
    await screen.findByRole("list", { name: OUTPOSTS });
    expect(within(rowWith(SIGN_INS, "Shopee Seller Centre")).getByText("Working")).toBeTruthy();
    const carrier = rowWith(SIGN_INS, "Carrier portal");
    expect(within(carrier).getByText("Broken")).toBeTruthy();
    expect(within(carrier).getByText(/^The site refused the saved password on 21 November at 10:\d\d, as Nam reported\./)).toBeTruthy();
    expect(within(rowWith(OUTPOSTS, "Fon's MacBook")).getByText("Online")).toBeTruthy();
    expect(within(rowWith(OUTPOSTS, "Cloud outpost")).getByText("Asleep")).toBeTruthy();
    expect(within(section("Site sign-ins for Baan Mali")).getByText("2 sign-ins, 1 broken")).toBeTruthy();
    expect(within(section("Outposts for Baan Mali")).getByText("2 outposts, 1 online")).toBeTruthy();
  });

  it("changes who may use a sign-in in practice, and the list and the audit log say so", async () => {
    const api = practice();
    fireEvent.click(await screen.findByRole("button", { name: "Connections" }));
    await screen.findByRole("list", { name: SIGN_INS });
    ask("Change who may use Carrier portal", "Who may use Carrier portal?");
    const dialog = screen.getByRole("dialog", { name: "Who may use Carrier portal?" });
    fireEvent.click(within(dialog).getByRole("checkbox", { name: "Ton" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Let Nam and Ton use it" }));
    expect((await within(section("Site sign-ins for Baan Mali")).findByRole("status")).textContent)
      .toBe("Saved. Nam and Ton may use Carrier portal from now on.");
    await waitFor(() => expect(within(rowWith(SIGN_INS, "Carrier portal")).getByText("May be used by Nam and Ton.")).toBeTruthy());
    // Still broken: who may use it is all that changed.
    expect(within(rowWith(SIGN_INS, "Carrier portal")).getByText("Broken")).toBeTruthy();
    expect((await api.listAudit("shop_baanmali", { limit: 1 })).entries[0]).toMatchObject({ action: "signin.members_changed",
      actor: { kind: "operator" }, subject: { signInId: "8a1b4c6d-3e52-4f70-b8c9-0d1e2f3a4b5c" } });
  });

  it("keeps a new credential out of every store, lets it go when the page is left, and shows nothing of it on coming back", async () => {
    // Every write the page or the practice world makes to the browser's storage, so a credential written and then taken out again
    // is found too.
    const written: string[] = [];
    const setItem = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (this: Storage, key: string, value: string) {
      written.push(`${key}=${value}`);
      return setItem.call(this, key, value);
    });
    const api = practice();
    fireEvent.click(await screen.findByRole("button", { name: "Connections" }));
    await screen.findByRole("list", { name: OUTPOSTS });
    fireEvent.click(within(ask("New credential for Fon's MacBook", GIVE_CREDENTIAL)).getByRole("button", { name: "Give Fon's MacBook a new credential" }));
    const box = await screen.findByRole("region", { name: "The new credential for Fon's MacBook" });
    const credential = (within(box).getByLabelText("Credential") as HTMLInputElement).value;
    expect(credential).toMatch(/^mo1_[A-Za-z0-9_-]{43}$/);
    await waitFor(() => expect(within(rowWith(OUTPOSTS, "Fon's MacBook")).getByText("Asleep")).toBeTruthy());

    const everywhere = () => [
      ...written,
      ...Object.entries({ ...localStorage }).map(([key, value]) => `${key}=${value}`),
      ...Object.entries({ ...sessionStorage }).map(([key, value]) => `${key}=${value}`),
      window.location.href,
      JSON.stringify(window.history.state),
    ].join("\n");
    expect(written.length).toBeGreaterThan(0);
    for (const text of [everywhere(), JSON.stringify(await api.exportShop("shop_baanmali"))]) {
      expect(text).not.toContain(credential);
      expect(text).not.toContain(credential.slice(4));
    }

    // Leave the page for another, and come back: the credential is not there, nor anywhere in the markup.
    fireEvent.click(screen.getByRole("button", { name: "People" }));
    await screen.findByRole("heading", { level: 1, name: "People" });
    expect(document.body.innerHTML).not.toContain(credential);
    fireEvent.click(screen.getByRole("button", { name: "Connections" }));
    await screen.findByRole("list", { name: OUTPOSTS });
    expect(screen.queryByRole("region", { name: /new credential/ })).toBeNull();
    expect(screen.queryByDisplayValue(credential)).toBeNull();
    expect(document.body.innerHTML).not.toContain(credential);
    // The Mac stays asleep: in practice nobody holds the new credential to beat with it.
    expect(within(rowWith(OUTPOSTS, "Fon's MacBook")).getByText("Asleep")).toBeTruthy();
    expect(everywhere()).not.toContain(credential);
  });
});
