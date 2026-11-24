// Needs you across the person's shops (src/app/needs.ts): each shop read with its own session, an ended one opened again
// once for every shop of the read, offline and signed out told apart from a shop with nothing waiting; and one answer,
// sent to the shop its ask came from, once more only when the shop answered 401 before reading it.
import { describe, expect, it, vi } from "vitest";
import { ApiError, type WebAnswer, type WebDecision } from "../src/api";
import { decodeApprovals } from "../src/app/asks";
import { decideAsk, mayAnswer, readNeeds, whoDecided, type Ask } from "../src/app/needs";
import { approvalJson, decided, HELPED, listing, OWNED, T0 } from "./appKit";
import { stubApi } from "./helpers";

const ask = (shop = OWNED, over: Parameters<typeof approvalJson>[0] = {}): Ask =>
  ({ shop, approval: decodeApprovals({ approvals: [approvalJson(over)] }, [])[0]! });

describe("reading what waits", () => {
  it("reads each ready shop with its own name, oldest asked first, and keeps answered ones apart", async () => {
    const webApprovals = vi.fn(async (shop: string, state: string): Promise<WebAnswer> => {
      if (state === "recent") {
        return listing("recent", approvalJson({ id: `${shop}-old`, createdAt: T0, standing: { state: "decided", reason: "decided",
          decision: decided({ requestId: `${shop}-old` }) } }));
      }
      return shop === OWNED.id
        ? listing("open", approvalJson({ id: "owned-new", createdAt: T0 + 5000 }), approvalJson({ id: "owned-old", createdAt: T0 + 1000 }))
        : listing("open", approvalJson({ id: "helped", createdAt: T0 + 3000 }));
    });
    const notReady = { ...HELPED, id: "pilot:not-ready", ready: false };
    const read = await readNeeds(stubApi({ webApprovals }), [OWNED, HELPED, notReady]);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.asks.map((one) => [one.shop.id, one.approval.record.request.id])).toEqual([
      [OWNED.id, "owned-old"], [HELPED.id, "helped"], [OWNED.id, "owned-new"]]);
    expect(read.recent.map((one) => one.approval.record.request.id).sort()).toEqual([`${OWNED.id}-old`, `${HELPED.id}-old`]);
    expect(read.problems).toEqual([]);
    expect(read.shops).toBeNull();
    // A shop with no session ready is not read at all.
    expect(webApprovals.mock.calls.map(([shop]) => shop)).not.toContain("pilot:not-ready");
  });

  it("opens an ended session again once for the whole read, and reads that shop again", async () => {
    let reopened = false;
    const webShops = vi.fn(async () => {
      reopened = true;
      return { signedIn: true as const, shops: [OWNED, HELPED] };
    });
    const webApprovals = vi.fn(async (shop: string, state: "open" | "recent"): Promise<WebAnswer> =>
      reopened ? listing(state, ...(state === "open" ? [approvalJson({ id: `${shop}-1` })] : []))
        : { status: 401, body: { error: "session_ended", shop } });
    const read = await readNeeds(stubApi({ webApprovals, webShops }), [OWNED, HELPED]);
    expect(webShops).toHaveBeenCalledTimes(1);
    expect(read.ok && read.asks.map((one) => one.approval.record.request.id).sort()).toEqual([`${OWNED.id}-1`, `${HELPED.id}-1`]);
    expect(read.ok && read.shops).toEqual([OWNED, HELPED]);
  });

  it("says why a shop is not shown: removed, unlinked, or unreadable now", async () => {
    const webApprovals = vi.fn(async (shop: string): Promise<WebAnswer> => shop === OWNED.id
      ? { status: 401, body: { error: "unlinked", unlinkedAt: new Date(T0).toISOString(), shop } }
      : { status: 503, body: { error: "approvals_unavailable" } });
    const read = await readNeeds(stubApi({ webApprovals }), [OWNED, HELPED]);
    expect(read).toEqual({ ok: true, asks: [], recent: [], unreadable: 0, shops: null, problems: [
      { shop: OWNED, why: "left", left: { why: "unlinked", at: T0 } }, { shop: HELPED, why: "unavailable" }] });
  });

  it("is offline when any read gets no answer, and signed out when the shops say so", async () => {
    const offline = await readNeeds(stubApi({ webApprovals: async () => Promise.reject(new ApiError(0, "network")) }), [OWNED]);
    expect(offline).toEqual({ ok: false, why: "offline" });
    const ended = await readNeeds(stubApi({
      webApprovals: async (shop) => ({ status: 401, body: { error: "session_ended", shop } }),
      webShops: async () => ({ signedIn: false, emailSignIn: true }),
    }), [OWNED]);
    expect(ended).toEqual({ ok: false, why: "signed_out" });
  });
});

describe("answering one ask", () => {
  it("sends the answer to the ask's own shop, by the option's effect, at the revision shown", async () => {
    const sent: WebDecision[] = [];
    const webDecide = vi.fn(async (input: WebDecision): Promise<WebAnswer> => {
      sent.push(input);
      return { status: 200, body: { result: { ok: true, decision: decided() }, action: "confirmed" } };
    });
    const api = stubApi({ webDecide });
    const helped = ask(HELPED, { id: "req-h", revision: 2, options: [{ id: "yes-2", label: "ส่ง", effect: "approve" },
      { id: "no-2", label: "ไม่ส่ง", effect: "decline" }] });
    expect(await decideAsk(api, helped, "approve")).toEqual({ kind: "decided", approved: true, action: "confirmed" });
    expect(await decideAsk(api, ask(OWNED, { id: "req-o" }), "decline")).toEqual({ kind: "decided", approved: false, action: "confirmed" });
    expect(sent).toEqual([
      { shop: HELPED.id, requestId: "req-h", optionId: "yes-2", seenRevision: 2 },
      { shop: OWNED.id, requestId: "req-o", optionId: "decline", seenRevision: 1 },
    ]);
  });

  it("opens the shop again and sends once more when its session had ended, and never a third time", async () => {
    const webDecide = vi.fn(async (input: WebDecision): Promise<WebAnswer> => ({ status: 401, body: { error: "session_ended", shop: input.shop } }));
    const webShops = vi.fn(async () => ({ signedIn: true as const, shops: [OWNED] }));
    expect(await decideAsk(stubApi({ webDecide, webShops }), ask(), "approve")).toEqual({ kind: "session_ended" });
    expect(webDecide).toHaveBeenCalledTimes(2);
    expect(webShops).toHaveBeenCalledTimes(1);
  });

  it("is unclear with no answer, and never sends what the request does not offer", async () => {
    const webDecide = vi.fn(async (): Promise<WebAnswer> => Promise.reject(new ApiError(0, "network")));
    expect(await decideAsk(stubApi({ webDecide }), ask(), "approve")).toEqual({ kind: "unclear" });
    const approveOnly = ask(OWNED, { options: [{ id: "approve", label: "Approve", effect: "approve" }] });
    expect(await decideAsk(stubApi({ webDecide }), approveOnly, "decline")).toEqual({ kind: "not_offered" });
    const expired = ask(OWNED, { standing: { state: "expired", reason: "expired", expiredAt: T0 } });
    expect(await decideAsk(stubApi({ webDecide }), expired, "approve")).toEqual({ kind: "not_offered" });
    expect(webDecide).toHaveBeenCalledTimes(1);
  });
});

describe("who may answer, and who did", () => {
  it("lets a helper answer messages and replies only, as approval-core's mayDecide says, and the owner everything", () => {
    for (const kind of ["message", "reply"]) expect(mayAnswer(ask(HELPED, { kind })), kind).toBe(true);
    for (const kind of ["money", "public_post", "payment_confirmation", "command"]) {
      expect(mayAnswer(ask(HELPED, { kind })), kind).toBe(false);
      expect(mayAnswer(ask(OWNED, { kind })), kind).toBe(true);
    }
    expect(mayAnswer(ask(OWNED, { kind: "refund_partial" }))).toBe(false);
  });

  it("names the person themselves, the owner (from the LINE link or not), a helper, or someone", () => {
    expect(whoDecided({ ...decided(), decidedBy: "helper-noi", role: "helper" } as never, HELPED)).toEqual({ kind: "you", link: false });
    expect(whoDecided({ ...decided(), decidedBy: "helper-mint", role: "helper" } as never, HELPED)).toEqual({ kind: "helper" });
    expect(whoDecided({ ...decided(), decidedBy: "owner-link", role: "owner" } as never, HELPED))
      .toEqual({ kind: "owner", name: "Lek", link: true });
    expect(whoDecided({ ...decided(), decidedBy: "owner-session", role: "owner" } as never, HELPED))
      .toEqual({ kind: "owner", name: "Lek", link: false });
    // An owner's decision from another of their surfaces is their own.
    expect(whoDecided({ ...decided(), decidedBy: "owner-link", role: "owner" } as never, OWNED)).toEqual({ kind: "you", link: true });
    expect(whoDecided({ ...decided(), role: { unknown: true, raw: "manager" } } as never, OWNED)).toEqual({ kind: "someone" });
  });
});
