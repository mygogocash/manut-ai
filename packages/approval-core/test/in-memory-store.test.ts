import { describe, expect, it } from "vitest";
import { InMemoryApprovalStore, type ApprovalOption, type ApprovalRecord } from "../src/index";
import { approvalStoreContract } from "./store-contract";

approvalStoreContract("InMemoryApprovalStore", (now) => new InMemoryApprovalStore({ now }));

describe("InMemoryApprovalStore", () => {
  const allow: ApprovalOption = { id: "allow", label: "Approve", effect: "approve" };
  const deny: ApprovalOption = { id: "deny", label: "Decline", effect: "decline" };

  it("OfficeDecisionChokepointTests.onlyTheChokepointDecides (adapted): what the store hands out or takes in cannot settle a request", async () => {
    // GoSpark pins that only its chokepoint settles a request. Here the only way is `decide`: a
    // caller changing a record it read, or the objects it passed in, changes nothing stored.
    const store = new InMemoryApprovalStore({ now: () => 1 });
    const options = [allow, deny];
    const detail = { text: "Sale today" };
    await store.open({ id: "req-1", kind: "public_post", options, detail });
    options.push({ id: "always", label: "Always", effect: "approve" });
    detail.text = "Sale today, 90% off";

    const read = (await store.get("req-1")) as unknown as { status: string; request: { revision: number } };
    read.status = "decided";
    read.request.revision = 99;

    const stored = await store.get("req-1");
    expect(stored).toMatchObject({ status: "pending", request: { revision: 1, detail: { text: "Sale today" } } });
    expect(stored?.request.options.map((o) => o.id)).toEqual(["allow", "deny"]);

    const result = await store.decide(
      { requestId: "req-1", optionId: "allow", seenRevision: 1, decidedBy: "owner@desktop", role: "owner" },
      { running: {} },
    );
    expect(result.ok).toBe(true);
    if (result.ok) (result.decision as unknown as { optionId: string }).optionId = "deny";
    expect(((await store.get("req-1")) as Extract<ApprovalRecord, { status: "decided" }>).decision.optionId).toBe("allow");
  });

  it("keeps only the fields it knows, so nothing attached by accident is stored", async () => {
    const store = new InMemoryApprovalStore({ now: () => 1 });
    const extra = { id: "req-1", kind: "message", options: [{ ...allow, secret: "x" }], note: "x" } as never;
    await store.open(extra);
    const stored = await store.get("req-1");
    expect(stored?.request).toEqual({ id: "req-1", kind: "message", options: [allow], revision: 1, createdAt: 1 });
  });

  it("uses the system clock by default", async () => {
    const store = new InMemoryApprovalStore();
    const before = Date.now();
    const opened = await store.open({ id: "req-1", kind: "message", options: [allow] });
    expect(opened.ok && opened.request.createdAt).toBeGreaterThanOrEqual(before);
  });
});
