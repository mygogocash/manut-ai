import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ApiError, type AuditEntry, type AuditPage, type AuditQuery, type Shop } from "../src/api";
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
    renderWithApi(<AuditView shops={SHOPS} tenant="t1" onForget={() => {}} />, stubApi({ listAudit }));

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
    renderWithApi(<AuditView shops={SHOPS} tenant="t1" onForget={() => {}} />, stubApi({ listAudit }));
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
    renderWithApi(<AuditView shops={SHOPS} tenant="t1" onForget={onForget} />, stubApi({ listAudit }));
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
