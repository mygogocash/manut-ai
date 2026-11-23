import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ApiError, type AuditEntry, type AuditPage, type AuditQuery, type People, type Shop } from "../src/api";
import { createFakeApi } from "../src/api/fake";
import { AuditView } from "../src/ops/AuditView";
import { OpsConsole } from "../src/ops/OpsConsole";
import { readOperatorKey } from "../src/ops/operatorKey";
import { renderWithApi, stubApi } from "./helpers";

const NOW = Date.parse("2026-11-23T03:00:00Z");

const SHOPS: Shop[] = [
  { tenant: "t1", name: "Baan Mali", ownerName: "Fon", lineConnectionId: "line_1", consent: true },
  { tenant: "t2", name: "Sabai Tea", ownerName: "Dao", consent: false },
];

/// A shop with no helpers: what the people list answers when the page has no names to read off it.
const NO_PEOPLE: People = { tenant: "t1", owner: { name: "Fon" }, helpers: [], invites: [], away: null, passedOn: [],
  removed: [] };
const noPeople = async () => NO_PEOPLE;

function entry(n: number, overrides: Partial<AuditEntry> = {}): AuditEntry {
  return { id: `aud-mi8x2k4c0-${n.toString(36).padStart(3, "0")}-0a1b2c3d`, at: "2026-11-23T02:00:00.000Z",
    actor: { kind: "operator", email: "ops@manut.test" }, action: "shop.created", subject: {}, outcome: "ok",
    ...overrides };
}

function page(tenant: string, entries: AuditEntry[], next: string | null = null,
  missed: AuditPage["missed"] = null): AuditPage {
  return { tenant, entries, next, missed };
}

/// Each entry of the shop's log as an operator reads it.
function rows(name: string): string[] {
  return within(screen.getByRole("list", { name })).getAllByRole("listitem").map((item) => item.textContent ?? "");
}

describe("the Audit page", () => {
  it("opens from the side menu and lists the chosen shop's log newest first, in plain words", async () => {
    sessionStorage.setItem("manut.pilot.operatorKey", "op-key-123");
    renderWithApi(<OpsConsole />,
      createFakeApi({ operatorKey: readOperatorKey, now: () => NOW, webOrigin: "https://web.test" }));

    const nav = await screen.findByRole("button", { name: "Audit" });
    await screen.findByRole("button", { name: "Baan Mali" });
    fireEvent.click(nav);
    expect(await screen.findByRole("heading", { name: "Audit" })).toBeTruthy();
    expect(nav.getAttribute("aria-current")).toBe("page");
    await screen.findByRole("list", { name: "Baan Mali's audit log" });
    const read = rows("Baan Mali's audit log");
    expect(read[0]).toContain("An operator (no Access identity) proposed a reply.");
    // Newest first: Fon approved Khun Mai's reply after declining Khun Fah's.
    expect(read.filter((text) => text.includes("Fon decided a reply."))).toEqual([expect.stringContaining("Approved"),
      expect.stringContaining("Declined")]);
    expect(read.find((text) => text.includes("Manut AI finished sending an approved action."))).toContain("Sent");
    expect(read.some((text) => text.includes("recorded an order payment of ฿1,290."))).toBe(true);
    expect(read.at(-1)).toContain("An operator (no Access identity) created the shop.");
    // Going back to a shop leaves the Audit page.
    fireEvent.click(screen.getByRole("button", { name: "Sabai Tea" }));
    expect(await screen.findByRole("heading", { name: "Sabai Tea" })).toBeTruthy();
    expect(nav.getAttribute("aria-current")).toBeNull();
  });

  it("pages back through older entries, and starts from the newest page again after a refresh or another shop", async () => {
    const listAudit = vi.fn(async (tenant: string, query: AuditQuery = {}): Promise<AuditPage> => {
      if (tenant === "t2") return page("t2", [entry(9, { actor: { kind: "owner" }, action: "consent.given" })]);
      if (!query.before) {
        return page("t1", [entry(3, { action: "payment.recorded", amountSatang: 5000, subject: { paymentId: "pay_1" } }),
          entry(2, { action: "reply.proposed", subject: { taskId: "task_1", actionId: "act_1", messageId: "msg_1" } })],
        entry(2).id);
      }
      return page("t1", [entry(1)]);
    });
    renderWithApi(<AuditView shops={SHOPS} tenant="t1" onForget={() => {}} />, stubApi({ listAudit, getPeople: noPeople }));

    await screen.findByText("ops@manut.test recorded an order payment of ฿50.");
    expect(screen.getByText(/task task_1 · action act_1 · message msg_1/)).toBeTruthy();
    expect(rows("Baan Mali's audit log")).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: "Show older entries" }));
    await screen.findByText("ops@manut.test created the shop.");
    expect(rows("Baan Mali's audit log")).toHaveLength(3);
    expect(screen.queryByRole("button", { name: "Show older entries" })).toBeNull();
    expect(listAudit.mock.calls).toEqual([["t1", { limit: 50 }], ["t1", { before: entry(2).id, limit: 50 }]]);

    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(rows("Baan Mali's audit log")).toHaveLength(2));
    expect(screen.getByRole("button", { name: "Show older entries" })).toBeTruthy();

    fireEvent.change(screen.getByLabelText("Shop"), { target: { value: "t2" } });
    await screen.findByRole("list", { name: "Sabai Tea's audit log" });
    expect(rows("Sabai Tea's audit log")).toEqual([expect.stringContaining("Dao allowed Manut AI to send for the shop.")]);
  });

  it("warns that the log is not complete when entries could not be written, and says when there is nothing yet", async () => {
    const listAudit = vi.fn(async (tenant: string): Promise<AuditPage> => tenant === "t1"
      ? page("t1", [entry(1)], null, { count: 2, lastAt: "2026-11-23T02:30:00.000Z", lastAction: "dispatch.settled" })
      : page(tenant, []));
    renderWithApi(<AuditView shops={SHOPS} tenant="t1" onForget={() => {}} />, stubApi({ listAudit, getPeople: noPeople }));
    expect((await screen.findByRole("alert")).textContent)
      .toContain("2 entries could not be written, so this log is not complete.");
    fireEvent.change(screen.getByLabelText("Shop"), { target: { value: "t2" } });
    expect(await screen.findByText("Nothing recorded for this shop yet.")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("says so when the log cannot be read, and offers another key when the API refuses this one", async () => {
    let answer: ApiError = new ApiError(503, "audit_unavailable");
    const listAudit = vi.fn(async () => { throw answer; });
    const onForget = vi.fn();
    renderWithApi(<AuditView shops={SHOPS} tenant="t1" onForget={onForget} />, stubApi({ listAudit, getPeople: noPeople }));
    expect((await screen.findByRole("alert")).textContent).toContain("The API could not read the audit log.");
    answer = new ApiError(403, "forbidden");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await screen.findByText(/The API refused the operator key/);
    fireEvent.click(screen.getByRole("button", { name: "Enter another key" }));
    expect(onForget).toHaveBeenCalledTimes(1);
  });

  it("says there are no shops when there are none to read", async () => {
    renderWithApi(<AuditView shops={[]} tenant={null} onForget={() => {}} />, stubApi({}));
    expect(await screen.findByText("No shops yet.")).toBeTruthy();
  });
});

// The log holds ids only, never a name. What a removed helper approved "stays in the activity log, with Mint's name" (the
// People page says so), so the page reads the names off the shop's people list when it shows an entry.
describe("the Audit page's names for the owner's people", () => {
  const fakeApi = () => createFakeApi({ now: () => NOW, webOrigin: "https://web.test" });
  const read = () => rows("Baan Mali's audit log");

  it("names Mint and Beam as the owner named them, in the sample shop's log, while the ids stay under each entry", async () => {
    renderWithApi(<AuditView shops={[{ ...SHOPS[0]!, tenant: "shop_baanmali" }, SHOPS[1]!]} tenant="shop_baanmali" onForget={() => {}} />,
      fakeApi());
    await screen.findByRole("list", { name: "Baan Mali's audit log" });
    await waitFor(() => expect(read().some((text) => text.includes("Mint joined the shop through an invite."))).toBe(true));
    const text = read();
    for (const sentence of [
      "An operator (no Access identity) invited Mint.",
      "Mint joined the shop through an invite.",
      "Mint signed in on another device.",
      "An operator (no Access identity) set Mint to cover messages while Fon is away.",
      "Mint passed a request on to Fon.",
      "An operator (no Access identity) invited Beam.",
    ]) expect(text.some((row) => row.includes(sentence)), sentence).toBe(true);
    // Only ids are under an entry: the name comes from the people list, never from the log.
    expect(text.find((row) => row.includes("Mint joined"))).toContain("invite inv-mint · helper helper-mint");
  });

  it("keeps a removed helper's name on what they did, and names the one who was removed", async () => {
    const api = fakeApi();
    await api.removeHelper({ tenant: "shop_baanmali", helperId: "helper-mint" });
    renderWithApi(<AuditView shops={[{ ...SHOPS[0]!, tenant: "shop_baanmali" }]} tenant="shop_baanmali" onForget={() => {}} />, api);
    await screen.findByRole("list", { name: "Baan Mali's audit log" });
    await waitFor(() => expect(read().some((row) => row.includes("An operator (no Access identity) removed Mint."))).toBe(true));
    expect(read().some((row) => row.includes("Mint passed a request on to Fon."))).toBe(true);
    expect(read().some((row) => row.includes("Helper helper-mint"))).toBe(false);
  });

  it("shows the id instead when the people cannot be read, and says nothing about it", async () => {
    const listAudit = vi.fn(async () => page("t1", [entry(1, { actor: { kind: "helper", id: "helper-1" }, action: "request.passed_on",
      subject: { requestId: "req_1", taskId: "task_1" } })]));
    const getPeople = vi.fn(async (): Promise<People> => { throw new ApiError(503, "people_unavailable"); });
    renderWithApi(<AuditView shops={SHOPS} tenant="t1" onForget={() => {}} />, stubApi({ listAudit, getPeople }));
    await screen.findByText("Helper helper-1 passed a request on to Fon.");
    await waitFor(() => expect(getPeople).toHaveBeenCalledWith("t1"));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("never carries one shop's names to another's entries", async () => {
    const asHelper = (n: number) => entry(n, { actor: { kind: "helper", id: "helper-1" }, action: "helper.session_opened",
      subject: { helperId: "helper-1" } });
    const listAudit = vi.fn(async (tenant: string) => page(tenant, [asHelper(1)]));
    const getPeople = vi.fn(async (tenant: string): Promise<People> => tenant === "t1"
      ? { ...NO_PEOPLE, helpers: [{ id: "helper-1", name: "Mint", identity: { kind: "email", address: "mint@baanmali.example" },
        joinedAt: "2026-11-13T03:05:00.000Z", devices: 1 }] }
      : { ...NO_PEOPLE, tenant });
    renderWithApi(<AuditView shops={SHOPS} tenant="t1" onForget={() => {}} />, stubApi({ listAudit, getPeople }));
    await screen.findByText("Mint signed in on another device.");
    fireEvent.change(screen.getByLabelText("Shop"), { target: { value: "t2" } });
    await screen.findByText("Helper helper-1 signed in on another device.");
    expect(screen.queryByText("Mint signed in on another device.")).toBeNull();
  });

  it("shows browser control's entries in plain words: the outpost, the sign-in step and why it was refused", async () => {
    const worker = { kind: "worker" as const, attemptId: "6f9d1f0e-9a7e-4a53-9a0b-2f5c1d1f7c11" };
    const outpost = { kind: "outpost" as const, id: "b4c8d1e2-5f60-4a71-8b92-0c3d4e5f6a7b" };
    const listAudit = vi.fn(async () => page("t1", [
      entry(4, { actor: outpost, action: "signin.redeemed", subject: { outpostId: "o1" } }),
      entry(3, { actor: worker, action: "signin.requested", subject: { signInId: "s1", outpostId: "o1", taskId: "t1", attemptId: "a1" },
        outcome: "refused", reason: "outpost_asleep" }),
      entry(2, { action: "outpost.registered", actor: { kind: "operator", email: "ops@manut.test" }, subject: { outpostId: "o1" } }),
      entry(1, { action: "signin.created", actor: { kind: "operator", email: "ops@manut.test" }, subject: { signInId: "s1" } }),
    ]));
    renderWithApi(<AuditView shops={SHOPS} tenant="t1" onForget={() => {}} />, stubApi({ listAudit, getPeople: noPeople }));
    await screen.findByText("Outpost b4c8d1e2 asked for a sign-in to type into a site.");
    const read = rows("Baan Mali's audit log");
    expect(read[1]).toContain("Worker attempt 6f9d1f0e asked to sign in to a site.");
    expect(read[1]).toContain("Refused");
    expect(read[1]).toContain("The outpost was asleep.");
    expect(read[1]).toContain("task t1 · attempt a1 · sign-in s1 · outpost o1");
    expect(read[2]).toContain("ops@manut.test registered an outpost.");
    expect(read[3]).toContain("ops@manut.test added a site sign-in to the vault.");
    for (const text of read) expect(text).not.toMatch(/signin\.|outpost\.registered|\bdid\b/);
  });
});
