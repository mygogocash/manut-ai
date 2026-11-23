import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ApiError, type DeletedShop, type PilotApi } from "../src/api";
import { createFakeApi } from "../src/api/fake";
import { OpsConsole } from "../src/ops/OpsConsole";
import { readOperatorKey } from "../src/ops/operatorKey";
import { captureDownloads, deferred, renderWithApi } from "./helpers";

const NOW = Date.parse("2026-11-23T03:00:00Z");
const CONFIRM_LABEL = "Type the shop's name to confirm: Baan Mali";
/// The time part depends on whether the test runs on the shop's 23 November, so both forms are accepted.
const DELETED_BAAN_MALI =
  /^Deleted Baan Mali (at|on 23 November at) 10:00\. Removed 1 task with its replies, 1 LINE connection and the shop's messages and payments\.$/;

function fakeApi() {
  return createFakeApi({ operatorKey: readOperatorKey, now: () => NOW, webOrigin: "https://web.test" });
}

async function openShopData(api: PilotApi): Promise<HTMLElement> {
  sessionStorage.setItem("manut.pilot.operatorKey", "op-key-123");
  renderWithApi(<OpsConsole />, api);
  fireEvent.click(await screen.findByRole("tab", { name: "Shop data" }));
  return screen.findByRole("tabpanel", { name: "Shop data" });
}

function openDeletion(panel: HTMLElement): HTMLElement {
  fireEvent.click(within(panel).getByRole("button", { name: "Delete this shop" }));
  return within(panel).getByRole("form", { name: "Delete Baan Mali?" });
}

function typeNameAndDelete(form: HTMLElement): void {
  fireEvent.change(within(form).getByLabelText(CONFIRM_LABEL), { target: { value: "Baan Mali" } });
  fireEvent.click(within(form).getByRole("button", { name: "Delete for good" }));
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
    expect(form.textContent).toContain("It can't be undone.");

    const name = within(form).getByLabelText(CONFIRM_LABEL);
    const last = within(form).getByRole("button", { name: "Delete for good" }) as HTMLButtonElement;
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

  it("deletes the shop, refreshes the list and says what was deleted", async () => {
    const api = fakeApi();
    const remove = vi.spyOn(api, "deleteShop");
    const listShops = vi.spyOn(api, "listShops");
    const panel = await openShopData(api);
    const listedBefore = listShops.mock.calls.length;

    typeNameAndDelete(openDeletion(panel));

    expect((await screen.findByRole("status")).textContent).toMatch(DELETED_BAAN_MALI);
    expect(remove).toHaveBeenCalledTimes(1);
    expect(remove).toHaveBeenCalledWith({ tenant: "shop_baanmali", confirmName: "Baan Mali" });
    await waitFor(() => expect(listShops.mock.calls.length).toBeGreaterThan(listedBefore));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Baan Mali" })).toBeNull());
    expect(screen.getByRole("button", { name: "Sabai Tea" }).getAttribute("aria-current")).toBe("page");
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Sabai Tea");
    // The operator lands on the next shop's messages, not on its delete button.
    expect(screen.getByRole("tab", { name: "Messages" }).getAttribute("aria-selected")).toBe("true");
    expect((await api.listShops()).map((shop) => shop.name)).toEqual(["Sabai Tea"]);
  });

  it("says nothing was deleted when the API answers name_mismatch", async () => {
    const api = fakeApi();
    vi.spyOn(api, "deleteShop").mockRejectedValueOnce(new ApiError(409, "name_mismatch"));
    const panel = await openShopData(api);
    const form = openDeletion(panel);

    typeNameAndDelete(form);

    expect((await within(form).findByRole("alert")).textContent).toBe(
      "Nothing was deleted. The name did not match the shop's name exactly. Check the name and type it again.",
    );
    expect(screen.getByRole("button", { name: "Baan Mali" })).toBeTruthy();
    expect(screen.queryByRole("status")).toBeNull();
    expect((await api.listShops()).map((shop) => shop.name)).toContain("Baan Mali");
  });

  it("says when only part was deleted, and running it again finishes the job", async () => {
    const api = fakeApi();
    const remove = vi.spyOn(api, "deleteShop").mockRejectedValueOnce(new ApiError(500, "wipe_incomplete"));
    const panel = await openShopData(api);

    typeNameAndDelete(openDeletion(panel));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain(
      "Deleting Baan Mali did not finish. Part of its data is deleted and the rest is still stored. Run it again to finish the job.",
    );
    // The form has closed in favour of the note above every tab, and focus is back on the button that opened it.
    expect(within(panel).queryByRole("form")).toBeNull();
    await waitFor(() =>
      expect(document.activeElement).toBe(within(panel).getByRole("button", { name: "Delete this shop" })),
    );
    const finish = within(alert).getByRole("button", { name: "Finish deleting" });
    expect(finish.className).toBe("btn danger solid");
    fireEvent.click(finish);

    expect((await screen.findByRole("status")).textContent).toMatch(DELETED_BAAN_MALI);
    expect(remove).toHaveBeenCalledTimes(2);
    expect(remove).toHaveBeenLastCalledWith({ tenant: "shop_baanmali", confirmName: "Baan Mali" });
    expect(screen.queryByRole("alert")).toBeNull();
    await waitFor(() => expect(screen.queryByRole("button", { name: "Baan Mali" })).toBeNull());
  });

  it("keeps the way to finish a partial wipe after the shop has left the list", async () => {
    const api = fakeApi();
    // The API drops the shop's registry row before its last step, so a partial wipe can take the shop off
    // the list while some of its data is still stored.
    const listAll = api.listShops;
    let offTheList = false;
    vi.spyOn(api, "listShops").mockImplementation(async () =>
      (await listAll()).filter((shop) => !(offTheList && shop.tenant === "shop_baanmali")),
    );
    const remove = vi.spyOn(api, "deleteShop").mockImplementationOnce(async () => {
      offTheList = true;
      throw new ApiError(500, "wipe_incomplete");
    });
    const panel = await openShopData(api);

    typeNameAndDelete(openDeletion(panel));

    await screen.findByRole("alert");
    await waitFor(() => expect(screen.queryByRole("button", { name: "Baan Mali" })).toBeNull());
    fireEvent.click(within(screen.getByRole("alert")).getByRole("button", { name: "Finish deleting" }));

    expect((await screen.findByRole("status")).textContent).toMatch(DELETED_BAAN_MALI);
    expect(remove).toHaveBeenLastCalledWith({ tenant: "shop_baanmali", confirmName: "Baan Mali" });
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("says when the API could not be reached, and that running it again is safe", async () => {
    const api = fakeApi();
    vi.spyOn(api, "deleteShop").mockRejectedValueOnce(new ApiError(0, "network"));
    const panel = await openShopData(api);

    typeNameAndDelete(openDeletion(panel));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain(
      "It is not clear whether Baan Mali was deleted. Could not reach the API. Check the connection and try again. Running it again is safe, and finishes the job if anything is left.",
    );
    fireEvent.click(within(alert).getByRole("button", { name: "Run it again" }));

    expect((await screen.findByRole("status")).textContent).toMatch(DELETED_BAAN_MALI);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("says the shop is already gone when the answer to a delete was lost", async () => {
    const api = fakeApi();
    const reallyDelete = api.deleteShop;
    vi.spyOn(api, "deleteShop").mockImplementationOnce(async (input) => {
      await reallyDelete(input);
      throw new ApiError(0, "network");
    });
    const panel = await openShopData(api);

    typeNameAndDelete(openDeletion(panel));
    fireEvent.click(within(await screen.findByRole("alert")).getByRole("button", { name: "Run it again" }));

    expect((await screen.findByRole("status")).textContent).toBe(
      "Baan Mali is already deleted. Nothing of it was left to delete.",
    );
    expect(screen.queryByRole("alert")).toBeNull();
    await waitFor(() => expect(screen.queryByRole("button", { name: "Baan Mali" })).toBeNull());
  });

  it("holds the form open while the deletion is on its way", async () => {
    const api = fakeApi();
    const answer = deferred<DeletedShop>();
    vi.spyOn(api, "deleteShop").mockReturnValueOnce(answer.promise);
    const panel = await openShopData(api);
    const form = openDeletion(panel);

    typeNameAndDelete(form);

    const busy = within(form).getByRole("button", { name: "Deleting" }) as HTMLButtonElement;
    expect(busy.disabled).toBe(true);
    expect(busy.getAttribute("aria-busy")).toBe("true");
    expect((within(form).getByRole("button", { name: "Keep the shop" }) as HTMLButtonElement).disabled).toBe(true);
    expect((within(panel).getByRole("button", { name: "Delete this shop" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.keyDown(within(form).getByLabelText(CONFIRM_LABEL), { key: "Escape" });
    expect(within(panel).getByRole("form", { name: "Delete Baan Mali?" })).toBe(form);

    answer.resolve(await createFakeApi({ now: () => NOW }).deleteShop({ tenant: "shop_baanmali", confirmName: "Baan Mali" }));
    expect((await screen.findByRole("status")).textContent).toMatch(DELETED_BAAN_MALI);
  });

  it("closes the form on Escape when nothing is on its way", async () => {
    const panel = await openShopData(fakeApi());
    const form = openDeletion(panel);

    fireEvent.keyDown(within(form).getByLabelText(CONFIRM_LABEL), { key: "Escape" });

    expect(within(panel).queryByRole("form")).toBeNull();
    expect(document.activeElement).toBe(within(panel).getByRole("button", { name: "Delete this shop" }));
  });

  it("says nothing was deleted when the API could not record the deletion, and keeps the form for another try", async () => {
    const api = fakeApi();
    const remove = vi.spyOn(api, "deleteShop").mockRejectedValueOnce(new ApiError(503, "audit_unavailable"));
    const panel = await openShopData(api);
    const form = openDeletion(panel);

    typeNameAndDelete(form);

    expect((await within(form).findByRole("alert")).textContent).toBe(
      "Nothing was deleted. The API could not record the deletion, so it did not start. It is safe to try again.",
    );
    // A refusal is not an unfinished deletion: nothing is shown above the tabs, and the shop stays.
    expect(screen.getAllByRole("alert")).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Baan Mali" })).toBeTruthy();

    fireEvent.click(within(form).getByRole("button", { name: "Delete for good" }));

    expect((await screen.findByRole("status")).textContent).toMatch(DELETED_BAAN_MALI);
    expect(remove).toHaveBeenCalledTimes(2);
  });

  it("says the shop is already deleted when the API answers tenant_deleted", async () => {
    const api = fakeApi();
    vi.spyOn(api, "deleteShop").mockRejectedValueOnce(new ApiError(404, "tenant_deleted"));
    const panel = await openShopData(api);

    typeNameAndDelete(openDeletion(panel));

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

    typeNameAndDelete(form);

    expect((await within(form).findByRole("alert")).textContent).toBe(
      "Nothing was deleted. The API refused the operator key. Check the key, and that this browser is signed in to Cloudflare Access.",
    );
    // The form stays open with the name, so the operator can send it again once the key is right.
    expect((within(form).getByRole("button", { name: "Delete for good" }) as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByRole("button", { name: "Baan Mali" })).toBeTruthy();
  });
});
