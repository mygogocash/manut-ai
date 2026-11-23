import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ApiError, isAwaitingOwner, type DeletedShop, type PilotApi } from "../src/api";
import { createFakeApi } from "../src/api/fake";
import { OpsConsole } from "../src/ops/OpsConsole";
import { readOperatorKey } from "../src/ops/operatorKey";
import { captureDownloads, deferred, renderWithApi } from "./helpers";

const NOW = Date.parse("2026-11-23T03:00:00Z");
/// The time part depends on whether the test runs on the shop's 23 November, so both forms are accepted. Sabai Tea
/// never went live: it has no LINE connection and no tasks, so only its messages and payments are named.
const DELETED_SABAI_TEA = /^Deleted Sabai Tea (at|on 23 November at) 10:00\. Removed the shop's messages and payments\.$/;

function fakeApi() {
  return createFakeApi({ operatorKey: readOperatorKey, now: () => NOW, webOrigin: "https://web.test" });
}

/// Opens the Shop data tab of `shop`: Baan Mali, the first shop, is live (its LINE account is connected); Sabai
/// Tea never went live.
async function openShopData(api: PilotApi, shop: "Baan Mali" | "Sabai Tea" = "Baan Mali"): Promise<HTMLElement> {
  sessionStorage.setItem("manut.pilot.operatorKey", "op-key-123");
  renderWithApi(<OpsConsole />, api);
  const inMenu = await screen.findByRole("button", { name: shop });
  if (shop !== "Baan Mali") fireEvent.click(inMenu);
  await waitFor(() => expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(shop));
  fireEvent.click(screen.getByRole("tab", { name: "Shop data" }));
  return screen.findByRole("tabpanel", { name: "Shop data" });
}

function openDeletion(panel: HTMLElement, shop = "Baan Mali"): HTMLElement {
  fireEvent.click(within(panel).getByRole("button", { name: "Delete this shop" }));
  return within(panel).getByRole("form", { name: `Delete ${shop}?` });
}

/// Types the shop's name and presses the form's last button: "Ask Fon to confirm" for live Baan Mali, "Delete for
/// good" for Sabai Tea.
function typeNameAndSend(form: HTMLElement, shop = "Baan Mali"): void {
  fireEvent.change(within(form).getByLabelText(`Type the shop's name to confirm: ${shop}`), { target: { value: shop } });
  const last = shop === "Baan Mali" ? "Ask Fon to confirm" : "Delete for good";
  fireEvent.click(within(form).getByRole("button", { name: last }));
}

describe("exporting a shop's data", () => {
  it("downloads the fake's export as one JSON file named after the shop and the date", async () => {
    const api = fakeApi();
    const exportShop = vi.spyOn(api, "exportShop");
    const { blobs, downloads } = captureDownloads();
    const panel = await openShopData(api);

    fireEvent.click(within(panel).getByRole("button", { name: "Export shop data" }));

    expect((await within(panel).findByRole("status")).textContent).toBe(
      "Exported as baan-mali-export-2026-11-23.json. It holds customer messages, so give it only to Fon.",
    );
    expect(exportShop).toHaveBeenCalledWith("shop_baanmali");
    expect(downloads).toEqual([
      { name: "baan-mali-export-2026-11-23.json", href: "blob:https://web.test/download-1", attached: true },
    ]);
    expect(blobs).toHaveLength(1);
    expect(blobs[0]!.type).toBe("application/json");
    // Saved whole and as the API sent it: the same JSON, neither reshaped nor re-indented.
    const text = await blobs[0]!.text();
    const answer = await api.exportShop("shop_baanmali");
    expect(text).toBe(JSON.stringify(answer));
    expect(JSON.parse(text)).toEqual(answer);
  });

  it("says so when the export fails, and downloads nothing", async () => {
    const api = fakeApi();
    vi.spyOn(api, "exportShop").mockRejectedValueOnce(new ApiError(0, "network"));
    const { downloads } = captureDownloads();
    const panel = await openShopData(api);

    fireEvent.click(within(panel).getByRole("button", { name: "Export shop data" }));

    expect((await within(panel).findByRole("alert")).textContent).toBe(
      "Could not reach the API. Check the connection and try again.",
    );
    expect(downloads).toEqual([]);
  });
});

describe("deleting a shop", () => {
  it("says what goes, and keeps the last button disabled until the exact name is typed", async () => {
    const api = fakeApi();
    const remove = vi.spyOn(api, "deleteShop");
    const panel = await openShopData(api);

    const opener = within(panel).getByRole("button", { name: "Delete this shop" });
    expect(opener.className).toBe("btn danger");
    expect(opener.getAttribute("aria-expanded")).toBe("false");
    const form = openDeletion(panel);
    expect(opener.getAttribute("aria-expanded")).toBe("true");

    expect(form.textContent).toContain(
      "This removes everything stored for Baan Mali: customer messages, replies, recorded payments and the LINE connection.",
    );
    expect(form.textContent).toContain(
      "Fon's approval links stop working, and new messages to the shop's LINE account stop arriving here.",
    );
    expect(form.textContent).toContain(
      "Baan Mali is live, so Fon confirms the deletion. You get a link to send Fon on LINE, and nothing is deleted until Fon says yes.",
    );
    expect(form.textContent).toContain("It can't be undone.");

    const name = within(form).getByLabelText("Type the shop's name to confirm: Baan Mali");
    const last = within(form).getByRole("button", { name: "Ask Fon to confirm" }) as HTMLButtonElement;
    expect(last.className).toBe("btn danger solid");
    expect(last.disabled).toBe(true);
    for (const nearly of ["Baan Mal", "baan mali", "BAAN MALI", "Baan Mali ", " Baan Mali", "Baan  Mali"]) {
      fireEvent.change(name, { target: { value: nearly } });
      expect(last.disabled, nearly).toBe(true);
    }
    // Enter in the field sends nothing while the name is wrong.
    fireEvent.submit(form);
    fireEvent.change(name, { target: { value: "Baan Mali" } });
    expect(last.disabled).toBe(false);

    fireEvent.click(within(form).getByRole("button", { name: "Keep the shop" }));
    expect(within(panel).queryByRole("form")).toBeNull();
    expect(document.activeElement).toBe(opener);
    expect(remove).not.toHaveBeenCalled();
  });

  it("deletes a shop that never went live at once, refreshes the list and says what was deleted", async () => {
    const api = fakeApi();
    const remove = vi.spyOn(api, "deleteShop");
    const listShops = vi.spyOn(api, "listShops");
    const panel = await openShopData(api, "Sabai Tea");
    const listedBefore = listShops.mock.calls.length;
    const form = openDeletion(panel, "Sabai Tea");
    expect(form.textContent).not.toContain("confirms the deletion");

    typeNameAndSend(form, "Sabai Tea");

    expect((await screen.findByRole("status")).textContent).toMatch(DELETED_SABAI_TEA);
    expect(remove).toHaveBeenCalledTimes(1);
    expect(remove).toHaveBeenCalledWith({ tenant: "shop_sabaitea", confirmName: "Sabai Tea" });
    await waitFor(() => expect(listShops.mock.calls.length).toBeGreaterThan(listedBefore));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Sabai Tea" })).toBeNull());
    expect(screen.getByRole("button", { name: "Baan Mali" }).getAttribute("aria-current")).toBe("page");
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Baan Mali");
    // The operator lands on the next shop's messages, not on its delete button.
    expect(screen.getByRole("tab", { name: "Messages" }).getAttribute("aria-selected")).toBe("true");
    expect((await api.listShops()).map((shop) => shop.name)).toEqual(["Baan Mali"]);
  });

  it("says nothing was deleted when the API answers name_mismatch", async () => {
    const api = fakeApi();
    vi.spyOn(api, "deleteShop").mockRejectedValueOnce(new ApiError(409, "name_mismatch"));
    const panel = await openShopData(api);
    const form = openDeletion(panel);

    typeNameAndSend(form);

    expect((await within(form).findByRole("alert")).textContent).toBe(
      "Nothing was deleted. The name did not match the shop's name exactly. Check the name and type it again.",
    );
    expect(screen.getByRole("button", { name: "Baan Mali" })).toBeTruthy();
    expect(screen.queryByRole("status")).toBeNull();
    expect((await api.listShops()).map((shop) => shop.name)).toContain("Baan Mali");
  });

  it("says when only part was deleted, and running it again finishes the job", async () => {
    const api = fakeApi();
    const remove = vi.spyOn(api, "deleteShop").mockRejectedValueOnce(
      new ApiError(500, "wipe_incomplete", undefined, { failed: ["connections"] }));
    const panel = await openShopData(api, "Sabai Tea");

    typeNameAndSend(openDeletion(panel, "Sabai Tea"), "Sabai Tea");

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain(
      "Deleting Sabai Tea did not finish. Part of its data is deleted and the rest is still stored. Run it again to finish the job.",
    );
    // The form has closed in favour of the note above every tab, and focus is back on the button that opened it.
    expect(within(panel).queryByRole("form")).toBeNull();
    await waitFor(() =>
      expect(document.activeElement).toBe(within(panel).getByRole("button", { name: "Delete this shop" })),
    );
    const finish = within(alert).getByRole("button", { name: "Finish deleting" });
    expect(finish.className).toBe("btn danger solid");
    fireEvent.click(finish);

    expect((await screen.findByRole("status")).textContent).toMatch(DELETED_SABAI_TEA);
    expect(remove).toHaveBeenCalledTimes(2);
    expect(remove).toHaveBeenLastCalledWith({ tenant: "shop_sabaitea", confirmName: "Sabai Tea" });
    expect(screen.queryByRole("alert")).toBeNull();
    await waitFor(() => expect(screen.queryByRole("button", { name: "Sabai Tea" })).toBeNull());
  });

  it("keeps the way to finish a partial wipe after the shop has left the list", async () => {
    const api = fakeApi();
    // The API drops the shop's registry row before its last step, so a partial wipe can take the shop off
    // the list while some of its data is still stored.
    const listAll = api.listShops;
    let offTheList = false;
    vi.spyOn(api, "listShops").mockImplementation(async () =>
      (await listAll()).filter((shop) => !(offTheList && shop.tenant === "shop_sabaitea")),
    );
    const remove = vi.spyOn(api, "deleteShop").mockImplementationOnce(async () => {
      offTheList = true;
      throw new ApiError(500, "wipe_incomplete");
    });
    const panel = await openShopData(api, "Sabai Tea");

    typeNameAndSend(openDeletion(panel, "Sabai Tea"), "Sabai Tea");

    await screen.findByRole("alert");
    await waitFor(() => expect(screen.queryByRole("button", { name: "Sabai Tea" })).toBeNull());
    fireEvent.click(within(screen.getByRole("alert")).getByRole("button", { name: "Finish deleting" }));

    expect((await screen.findByRole("status")).textContent).toMatch(DELETED_SABAI_TEA);
    expect(remove).toHaveBeenLastCalledWith({ tenant: "shop_sabaitea", confirmName: "Sabai Tea" });
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("says when the API could not be reached, and that running it again is safe", async () => {
    const api = fakeApi();
    vi.spyOn(api, "deleteShop").mockRejectedValueOnce(new ApiError(0, "network"));
    const panel = await openShopData(api, "Sabai Tea");

    typeNameAndSend(openDeletion(panel, "Sabai Tea"), "Sabai Tea");

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain(
      "It is not clear whether Sabai Tea was deleted. Could not reach the API. Check the connection and try again. Running it again is safe, and finishes the job if anything is left.",
    );
    fireEvent.click(within(alert).getByRole("button", { name: "Run it again" }));

    expect((await screen.findByRole("status")).textContent).toMatch(DELETED_SABAI_TEA);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("says the shop is already gone when the answer to a delete was lost", async () => {
    const api = fakeApi();
    const reallyDelete = api.deleteShop;
    vi.spyOn(api, "deleteShop").mockImplementationOnce(async (input) => {
      await reallyDelete(input);
      throw new ApiError(0, "network");
    });
    const panel = await openShopData(api, "Sabai Tea");

    typeNameAndSend(openDeletion(panel, "Sabai Tea"), "Sabai Tea");
    fireEvent.click(within(await screen.findByRole("alert")).getByRole("button", { name: "Run it again" }));

    expect((await screen.findByRole("status")).textContent).toBe(
      "Sabai Tea is already deleted. Nothing of it was left to delete.",
    );
    expect(screen.queryByRole("alert")).toBeNull();
    await waitFor(() => expect(screen.queryByRole("button", { name: "Sabai Tea" })).toBeNull());
  });

  it("holds the form open while the deletion is on its way", async () => {
    const api = fakeApi();
    const answer = deferred<DeletedShop>();
    vi.spyOn(api, "deleteShop").mockReturnValueOnce(answer.promise);
    const panel = await openShopData(api, "Sabai Tea");
    const form = openDeletion(panel, "Sabai Tea");

    typeNameAndSend(form, "Sabai Tea");

    const busy = within(form).getByRole("button", { name: "Deleting" }) as HTMLButtonElement;
    expect(busy.disabled).toBe(true);
    expect(busy.getAttribute("aria-busy")).toBe("true");
    expect((within(form).getByRole("button", { name: "Keep the shop" }) as HTMLButtonElement).disabled).toBe(true);
    expect((within(panel).getByRole("button", { name: "Delete this shop" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.keyDown(within(form).getByLabelText("Type the shop's name to confirm: Sabai Tea"), { key: "Escape" });
    expect(within(panel).getByRole("form", { name: "Delete Sabai Tea?" })).toBe(form);

    const deleted = await createFakeApi({ now: () => NOW }).deleteShop({ tenant: "shop_sabaitea", confirmName: "Sabai Tea" });
    if (isAwaitingOwner(deleted)) throw new Error("Sabai Tea never went live, so it is deleted at once");
    answer.resolve(deleted);
    expect((await screen.findByRole("status")).textContent).toMatch(DELETED_SABAI_TEA);
  });

  it("closes the form on Escape when nothing is on its way", async () => {
    const panel = await openShopData(fakeApi());
    const form = openDeletion(panel);

    fireEvent.keyDown(within(form).getByLabelText("Type the shop's name to confirm: Baan Mali"), { key: "Escape" });

    expect(within(panel).queryByRole("form")).toBeNull();
    expect(document.activeElement).toBe(within(panel).getByRole("button", { name: "Delete this shop" }));
  });

  it("says nothing was deleted when the API could not record the deletion, and keeps the form for another try", async () => {
    const api = fakeApi();
    const remove = vi.spyOn(api, "deleteShop").mockRejectedValueOnce(new ApiError(503, "audit_unavailable"));
    const panel = await openShopData(api, "Sabai Tea");
    const form = openDeletion(panel, "Sabai Tea");

    typeNameAndSend(form, "Sabai Tea");

    expect((await within(form).findByRole("alert")).textContent).toBe(
      "Nothing was deleted. The API could not record the deletion, so it did not start. It is safe to try again.",
    );
    // A refusal is not an unfinished deletion: nothing is shown above the tabs, and the shop stays.
    expect(screen.getAllByRole("alert")).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Sabai Tea" })).toBeTruthy();

    fireEvent.click(within(form).getByRole("button", { name: "Delete for good" }));

    expect((await screen.findByRole("status")).textContent).toMatch(DELETED_SABAI_TEA);
    expect(remove).toHaveBeenCalledTimes(2);
  });

  it("says the shop is already deleted when the API answers tenant_deleted", async () => {
    const api = fakeApi();
    vi.spyOn(api, "deleteShop").mockRejectedValueOnce(new ApiError(404, "tenant_deleted"));
    const panel = await openShopData(api);

    typeNameAndSend(openDeletion(panel));

    expect((await screen.findByRole("status")).textContent).toBe(
      "Baan Mali is already deleted. Nothing of it was left to delete.",
    );
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByRole("button", { name: "Baan Mali" })).toBeNull();
  });

  it("shows any other refusal in the form, where nothing was deleted", async () => {
    const api = fakeApi();
    vi.spyOn(api, "deleteShop").mockRejectedValueOnce(new ApiError(403, "forbidden"));
    const panel = await openShopData(api);
    const form = openDeletion(panel);

    typeNameAndSend(form);

    expect((await within(form).findByRole("alert")).textContent).toBe(
      "Nothing was deleted. The API refused the operator key. Check the key, and that this browser is signed in to Cloudflare Access.",
    );
    // The form stays open with the name, so the operator can send it again once the key is right.
    expect((within(form).getByRole("button", { name: "Ask Fon to confirm" }) as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByRole("button", { name: "Baan Mali" })).toBeTruthy();
  });
});

describe("deleting a live shop: waiting for its owner", () => {
  it("shows the link to copy and send the owner, and the shop as waiting, deleting nothing", async () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    const api = fakeApi();
    const panel = await openShopData(api);

    typeNameAndSend(openDeletion(panel));

    const box = await within(panel).findByRole("status");
    expect(within(box).getByText("Deletion link for Fon")).toBeTruthy();
    const link = within(box).getByLabelText("Deletion link") as HTMLInputElement;
    expect(link.value).toMatch(/^https:\/\/web\.test\/delete\/.+/);
    expect(box.textContent).toContain(
      "Send it to Fon on LINE. Nothing is deleted until Fon says yes. It works until 24 November 10:00.");
    fireEvent.click(within(box).getByRole("button", { name: "Copy deletion link" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(link.value));
    // The form has closed, focus is back on the button that opened it, and the shop says it is waiting.
    expect(within(panel).queryByRole("form")).toBeNull();
    await waitFor(() =>
      expect(document.activeElement).toBe(within(panel).getByRole("button", { name: "Delete this shop" })),
    );
    expect(screen.getByText("Deletion waiting for Fon")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Baan Mali" })).toBeTruthy();
    expect(await api.listMessages("shop_baanmali")).toHaveLength(7);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("still shows the shop as waiting, with the same link, after the console is opened again", async () => {
    const api = fakeApi();
    // Asked from an earlier visit to the console: this one knows of it only through the shop list.
    sessionStorage.setItem("manut.pilot.operatorKey", "op-key-123");
    const asked = await api.deleteShop({ tenant: "shop_baanmali", confirmName: "Baan Mali" });
    if (!isAwaitingOwner(asked)) throw new Error("Baan Mali is live, so its owner is asked");
    const panel = await openShopData(api);

    expect(screen.getByText("Deletion waiting for Fon")).toBeTruthy();
    expect((within(panel).getByLabelText("Deletion link") as HTMLInputElement).value).toBe(asked.confirmUrl);
  });

  it("shows the owner's answer once the list is refreshed", async () => {
    const api = fakeApi();
    const panel = await openShopData(api);
    typeNameAndSend(openDeletion(panel));
    const link = (await within(panel).findByLabelText("Deletion link")) as HTMLInputElement;
    const token = decodeURIComponent(link.value.split("/delete/")[1]!);

    await api.decideDeletion(token, false);
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));

    expect(await within(panel).findByText(/^Fon chose to keep Baan Mali's data (at|on 23 November at) 10:00\. Nothing was deleted\.$/))
      .toBeTruthy();
    expect(within(panel).queryByLabelText("Deletion link")).toBeNull();
    expect(screen.queryByText("Deletion waiting for Fon")).toBeNull();

    // Asked again, the owner says yes: the shop leaves the list.
    typeNameAndSend(openDeletion(panel));
    const again = (await within(panel).findByLabelText("Deletion link")) as HTMLInputElement;
    expect(again.value).not.toBe(link.value);
    await api.decideDeletion(decodeURIComponent(again.value.split("/delete/")[1]!), true);
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Baan Mali" })).toBeNull());
  });

  it("says when nobody answered in time, so a new request makes a new link", async () => {
    const api = fakeApi();
    const listAll = api.listShops;
    vi.spyOn(api, "listShops").mockImplementation(async () => (await listAll()).map((shop) =>
      shop.tenant === "shop_baanmali"
        ? { ...shop, deletion: { state: "expired" as const, confirmUrl: "https://web.test/delete/old",
          expiresAt: "2026-11-23T02:00:00Z" } }
        : shop));
    const panel = await openShopData(api);

    expect(within(panel).getByText("Fon did not answer within 24 hours, so nothing was deleted. Delete again for a new link."))
      .toBeTruthy();
    expect(screen.queryByText("Deletion waiting for Fon")).toBeNull();
  });

  it("offers to finish a deletion the owner said yes to that did not finish", async () => {
    const api = fakeApi();
    const listAll = api.listShops;
    vi.spyOn(api, "listShops").mockImplementation(async () => (await listAll()).map((shop) =>
      shop.tenant === "shop_baanmali"
        ? { ...shop, deletion: { state: "deleting" as const, confirmUrl: "https://web.test/delete/yes",
          expiresAt: "2026-11-24T02:00:00Z", decidedAt: "2026-11-23T02:30:00Z" } }
        : shop));
    const done: DeletedShop = { tasksWiped: 1, connectionsWiped: 1, schedulesWiped: 0, occurrencesWiped: 0,
      sessionsWiped: 0, deletedAt: "2026-11-23T03:00:00Z" };
    const remove = vi.spyOn(api, "deleteShop").mockResolvedValueOnce(done);
    const panel = await openShopData(api);

    expect(screen.getByText("Deletion not finished")).toBeTruthy();
    const alert = within(panel).getByRole("alert");
    expect(alert.textContent).toMatch(
      /^Fon said yes (at|on 23 November at) 09:30, but deleting Baan Mali did not finish\. Part of its data is still stored\./);
    fireEvent.click(within(alert).getByRole("button", { name: "Finish deleting" }));

    expect((await screen.findByRole("status")).textContent).toMatch(
      /^Deleted Baan Mali (at|on 23 November at) 10:00\. Removed 1 task with its replies, 1 LINE connection and the shop's messages and payments\.$/);
    expect(remove).toHaveBeenCalledWith({ tenant: "shop_baanmali", confirmName: "Baan Mali" });
  });
});
