// Answering an ask on the connected runtime, end to end under the app's own store, over a fake API: the answer goes the
// one way every approval is settled in this app (`settleApproval`, the card's and Home's), and on to the decide route as
// exactly `{ optionId, seenRevision }` through the session, never with a role. The card is marked answered only once the
// API says so; every refusal comes back in plain words; and after any answer the shop is read again, so the card and
// the task show what the API holds. What this build cannot answer, and an ask from a kept read, are never sent.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dayTime } from "../../app/time";
import { settleApproval } from "../../chat/cards/respond";
import { setLang, t } from "../../i18n";
import type { BridgeError } from "../../lib/protocol";
import { canApproveHere } from "../../pages/home";
import { createStore, selectAsks, type ApprovalItem, type Store } from "../../state/store";
import { createRuntime } from "../index";
import { MockRuntime } from "../mock";
import { HttpHost, POLL_MS } from "./host";
import { HttpRuntime, sharedHttpHost } from "./index";
import { ApiSession } from "./session";
import type { FetchLike } from "./shell";
import {
  actionJson,
  approvalJson,
  desktopShell,
  fakeApi,
  iso,
  memoryCacheStore,
  memoryVault,
  ORIGIN,
  replyDetail,
  serveShop,
  storedSession,
  T0,
  taskJson,
  tokens,
  type FakeApi,
} from "./testkit";

const NOW = T0 + 600_000;
/** When someone else decided, a few minutes before the person pressed. */
const AT = T0 + 420_000;
const PATH = "/v1/approvals/action-1/decision";
const PATIENT = { timeout: 10_000, interval: 10 };

/** The decide route's answer to a decision it took (apps/api approvals.ts): approval-core's result and the action after. */
const taken = (optionId = "approve", action = "confirmed") => ({
  status: 200,
  json: { result: { ok: true, decision: { requestId: "action-1", optionId, seenRevision: 1, decidedBy: "owner-session", role: "owner", decidedAt: NOW } }, action },
});
/** The shop once the reply was decided: its action settled, its request no longer open. */
const replied = (api: FakeApi, state = "confirmed") => serveShop(api, { tasks: [taskJson({ actions: [actionJson({ state })] })] });

interface Options {
  over?: Parameters<typeof serveShop>[1];
  /** the session's way to the API, given the fake API (to hold an answer back) */
  fetch?: (api: FakeApi) => FetchLike;
}

function connectedStore(opts: Options = {}) {
  const api = serveShop(fakeApi(), opts.over);
  const vault = memoryVault(storedSession(NOW));
  const session = new ApiSession({ origin: ORIGIN, fetch: opts.fetch ? opts.fetch(api) : api.fetch, vault });
  const host = new HttpHost({ session });
  const rt = new HttpRuntime(host);
  const store = createStore(rt, { firstRoster: "all", watchSeen: { get: () => null, set: () => {} } });
  return { api, vault, session, host, rt, store };
}

/** Lets everything the store and the host started, which all answer in-process, run to its end. */
async function settled() {
  for (let i = 0; i < 10; i += 1) await vi.advanceTimersByTimeAsync(5);
}

async function opened(opts: Options = {}) {
  const s = connectedStore(opts);
  await s.store.actions.init();
  await settled();
  return s;
}

const cardOf = (store: Store, requestId: string) =>
  store.getState().chats.buddy?.items.find((i): i is ApprovalItem => i.kind === "approval" && i.request_id === requestId);
const asks = (store: Store) => selectAsks(store.getState()).map((a) => a.item as ApprovalItem);
const refusal = (p: Promise<unknown>) => p.then(() => null, (e: BridgeError) => e);

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  setLang("en");
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("answering an ask", () => {
  it("sends exactly the option that approves and the revision the person saw, through the session, never a role", async () => {
    const { api, store } = await opened();
    const [ask] = asks(store);
    expect(ask).toMatchObject({ request_id: "action-1@1", command: "Send on LINE: “Your order ships tomorrow morning.”", choices: ["once", "deny"] });
    api.on("POST", PATH, () => (replied(api), taken()));
    expect(await settleApproval(store, "buddy", ask, "once")).toBeNull();
    const sent = api.to("POST", PATH);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ url: `${ORIGIN}${PATH}`, bearer: "access-1" });
    expect(sent[0].body).toEqual({ optionId: "approve", seenRevision: 1 });
    // who decides is the session's to say: the body names nothing else
    expect(Object.keys(sent[0].body as object)).toEqual(["optionId", "seenRevision"]);
    expect(cardOf(store, "action-1@1")).toMatchObject({ resolved: "once" });
  });

  it("sends the option that declines for Deny", async () => {
    const { api, store } = await opened();
    api.on("POST", PATH, () => (replied(api, "rejected"), taken("decline", "rejected")));
    expect(await settleApproval(store, "buddy", asks(store)[0], "deny")).toBeNull();
    expect(api.to("POST", PATH).map((c) => c.body)).toEqual([{ optionId: "decline", seenRevision: 1 }]);
    expect(cardOf(store, "action-1@1")).toMatchObject({ resolved: "deny" });
  });

  it("marks the card answered only once the API has said so", async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const { api, store } = await opened({
      fetch: (fake) => async (url, init) => {
        if (init.method === "POST") await held;
        return fake.fetch(url, init);
      },
    });
    api.on("POST", PATH, () => (replied(api), taken()));
    const answering = settleApproval(store, "buddy", asks(store)[0], "once");
    await settled();
    expect(cardOf(store, "action-1@1")?.resolved).toBeUndefined();
    expect(asks(store)).toHaveLength(1);
    release();
    expect(await answering).toBeNull();
    expect(cardOf(store, "action-1@1")).toMatchObject({ resolved: "once" });
  });

  it("reads the shop again after an answer, so the screens show what the API holds", async () => {
    const { api, rt, store } = await opened();
    const reads = () => api.to("GET", "/v1/approvals").length;
    expect(reads()).toBe(1);
    api.on("POST", PATH, () => (replied(api), taken()));
    await settleApproval(store, "buddy", asks(store)[0], "once");
    await settled();
    expect(reads()).toBe(2);
    expect(api.to("GET", "/v1/tenant/export")).toHaveLength(2);
    expect(asks(store)).toEqual([]);
    // the task's notes say where the action stands now, as the API holds it
    const threads = rt.request.bind(rt) as unknown as (op: string, p: unknown) => Promise<{ messages: { text: string }[] }>;
    const notes = await threads("thread.open", { bot: "buddy", thread: "task-1" });
    expect(notes.messages.map((m) => m.text)).toContain("Send on LINE: “Your order ships tomorrow morning.” (sent)");
    // the card keeps the person's own answer
    expect(cardOf(store, "action-1@1")).toMatchObject({ resolved: "once" });
  });
});

describe("a refused answer", () => {
  it("says who decided first and when, and the card closes with those words once the shop is read again", async () => {
    // Mint, a helper, passed a refund on to the owner with a note, so this app knows her name; she approved the reply too
    const refund = approvalJson({ id: "req-5", kind: "money", createdAt: T0 + 100_000, detail: { operationType: "money.refund", targetResourceId: "order-17" }, passedOn: { by: "helper-mint", name: "Mint", note: "The jar arrived broken.", at: iso(T0 + 200_000) } });
    const { api, store } = await opened({ over: { approvals: [approvalJson(), refund] } });
    api.on("POST", PATH, () => {
      serveShop(api, { tasks: [taskJson({ actions: [actionJson({ state: "confirmed" })] })], approvals: [refund] });
      const decision = { requestId: "action-1", optionId: "approve", seenRevision: 1, decidedBy: "helper-mint", role: "helper", decidedAt: AT };
      return { status: 409, json: { error: "already_decided", result: { ok: false, refused: "already_decided", decision }, action: "confirmed" } };
    });
    const words = `Already decided by Mint at ${dayTime(AT, NOW)}`;
    expect(await settleApproval(store, "buddy", cardOf(store, "action-1@1")!, "once")).toBe(words);
    await settled();
    expect(cardOf(store, "action-1@1")).toMatchObject({ expired: "resolved", expiredNote: words });
    expect(cardOf(store, "action-1@1")?.resolved).toBeUndefined();
    expect(asks(store).map((a) => a.request_id)).toEqual(["req-5@1"]);
  });

  it("says a role that may not decide it may not, and leaves the ask waiting for the owner", async () => {
    const refund = approvalJson({ id: "req-5", kind: "money", detail: { operationType: "money.refund", targetResourceId: "order-17" } });
    const { api, store } = await opened({ over: { approvals: [refund] } });
    api.on("POST", "/v1/approvals/req-5/decision", { status: 403, json: { error: "not_permitted", result: { ok: false, refused: "not_permitted" }, action: "proposed" } });
    expect(await settleApproval(store, "buddy", asks(store)[0], "once")).toBe("Only the owner can approve money");
    await settled();
    expect(asks(store).map((a) => a.request_id)).toEqual(["req-5@1"]);
    expect(cardOf(store, "req-5@1")).not.toHaveProperty("expired");
  });

  it("closes a card whose request changed, and asks the new version, which is answered at its own revision", async () => {
    const issue = (title: string) => taskJson({ actions: [actionJson({ id: "req-7", operationType: "linear.issue.create", targetResourceId: "project-1", payload: { title } })] });
    const asked = (revision: number) => approvalJson({ id: "req-7", kind: "command", revision, attemptId: "attempt-2", detail: { actionId: "req-7", operationType: "linear.issue.create", targetResourceId: "project-1", payloadHash: "h" } });
    const { api, store } = await opened({ over: { tasks: [issue("Restock jasmine gift sets")], approvals: [asked(1)] } });
    const decide = "/v1/approvals/req-7/decision";
    api.on("POST", decide, () => {
      serveShop(api, { tasks: [issue("Restock jasmine and rose gift sets")], approvals: [asked(2)] });
      return { status: 409, json: { error: "changed", result: { ok: false, refused: "changed", currentRevision: 2 } } };
    });
    const words = "It changed since you saw it. Answer the new version";
    expect(await settleApproval(store, "buddy", cardOf(store, "req-7@1")!, "once")).toBe(words);
    await settled();
    expect(cardOf(store, "req-7@1")).toMatchObject({ expired: "cancelled", expiredNote: words });
    const [next] = asks(store);
    expect(next).toMatchObject({ request_id: "req-7@2", command: "Create a Linear issue: “Restock jasmine and rose gift sets”" });
    api.on("POST", decide, { status: 200, json: { result: { ok: true }, action: "approved" } });
    expect(await settleApproval(store, "buddy", next, "once")).toBeNull();
    expect(api.to("POST", decide).map((c) => c.body)).toEqual([
      { optionId: "approve", seenRevision: 1 },
      { optionId: "approve", seenRevision: 2 },
    ]);
  });

  it("never sends a revision the card did not show: a card the shop has moved past is refused here, and nothing is sent", async () => {
    const { api, rt, store } = await opened();
    // the request is revised, and the next read brings the new version while the old card is still on screen somewhere
    serveShop(api, { approvals: [approvalJson({ revision: 2, detail: replyDetail("action-1", "Your order ships on Friday.") })] });
    await vi.advanceTimersByTimeAsync(POLL_MS);
    await settled();
    expect(cardOf(store, "action-1@1")).toMatchObject({ expired: "cancelled", expiredNote: "It changed since you saw it. Answer the new version" });
    expect(asks(store).map((a) => a.request_id)).toEqual(["action-1@2"]);
    expect(await refusal(rt.request("approval.respond", { bot: "buddy", request_id: "action-1@1", choice: "once" }))).toEqual({
      code: "changed",
      message: "It changed since you saw it. Answer the new version",
    });
    expect(api.to("POST", PATH)).toEqual([]);
  });

  it("says why a request that is over can no longer be answered, and closes its card with it", async () => {
    const cases: [Record<string, unknown>, number, string, ApprovalItem["expired"]][] = [
      [{ error: "superseded", result: { ok: false, refused: "superseded", reason: "attempt_ended" } }, 409, "No longer asked: the work it was for has stopped", "cancelled"],
      [{ error: "superseded", result: { ok: false, refused: "superseded", reason: "withdrawn" } }, 409, "Withdrawn: the team took it back", "cancelled"],
      [{ error: "expired", result: { ok: false, refused: "expired", expiredAt: AT } }, 410, `Expired at ${dayTime(AT, NOW)}`, "timeout"],
      [{ error: "not_found" }, 404, "That is not in this shop any more.", "cancelled"],
    ];
    for (const [json, status, words, reason] of cases) {
      const { api, store } = await opened();
      api.on("POST", PATH, () => (serveShop(api, { approvals: [] }), { status, json }));
      expect(await settleApproval(store, "buddy", asks(store)[0], "once"), words).toBe(words);
      await settled();
      expect(cardOf(store, "action-1@1"), words).toMatchObject({ expired: reason, expiredNote: words });
    }
  });

  it("says what stands in the way when nothing was decided, and leaves the card open to try again", async () => {
    const cases: [Record<string, unknown>, number, string][] = [
      [{ error: "consent_required" }, 403, "The shop has not agreed yet to let Manut AI send for it"],
      [{ error: "feature_disabled", feature: "officeExternalWrites" }, 403, "Answering is switched off on this API for now"],
    ];
    for (const [json, status, words] of cases) {
      const { api, store } = await opened();
      api.on("POST", PATH, { status, json });
      expect(await settleApproval(store, "buddy", asks(store)[0], "once"), words).toBe(words);
      await settled();
      expect(asks(store).map((a) => a.request_id), words).toEqual(["action-1@1"]);
    }
  });

  it("tells a removed helper when the owner removed them, and ends the session here", async () => {
    const { api, store, host, vault } = await opened();
    const removedAt = new Date(2026, 10, 22, 21, 5).toISOString();
    api.on("POST", PATH, { status: 401, json: { error: "removed", removedAt } });
    const words = await settleApproval(store, "buddy", asks(store)[0], "once");
    expect(words).toMatch(/^The owner removed you on .+\. Ask them if this is a mistake$/);
    expect(api.to("POST", "/v1/auth/refresh")).toEqual([]);
    await settled();
    expect(host.link).toBe("signed_out");
    expect(vault.value).toBeNull();
  });

  it("never takes no answer for an answer: it says so, sends nothing again, and reads the shop to see where it stands", async () => {
    const { api, store } = await opened();
    api.on("POST", PATH, "offline");
    expect(await settleApproval(store, "buddy", asks(store)[0], "once")).toBe("No reply from the API. Checking whether your answer arrived");
    await settled();
    expect(api.to("POST", PATH)).toHaveLength(1);
    expect(api.to("GET", "/v1/approvals")).toHaveLength(2);
    expect(cardOf(store, "action-1@1")?.resolved).toBeUndefined();
    expect(asks(store).map((a) => a.request_id)).toEqual(["action-1@1"]);
    await vi.advanceTimersByTimeAsync(5 * POLL_MS);
    expect(api.to("POST", PATH)).toHaveLength(1);
  });

  it("refreshes the session on a 401 and sends the same answer once more", async () => {
    const { api, store } = await opened();
    api
      .on("POST", PATH, { status: 401, json: { error: "unauthorized" } }, () => (replied(api), taken()))
      .on("POST", "/v1/auth/refresh", { status: 200, json: tokens(2) });
    expect(await settleApproval(store, "buddy", asks(store)[0], "once")).toBeNull();
    expect(api.to("POST", PATH).map((c) => [c.bearer, c.body])).toEqual([
      ["access-1", { optionId: "approve", seenRevision: 1 }],
      ["access-2", { optionId: "approve", seenRevision: 1 }],
    ]);
  });
});

describe("an ask this build cannot answer", () => {
  it("is shown with its exact action and no answer: Home offers no Approve, the runtime sends nothing, and says to update the app", async () => {
    const { api, store } = await opened({ over: { approvals: [approvalJson({ kind: "refund_partial" })] } });
    const [ask] = asks(store);
    expect(ask).toMatchObject({ request_id: "action-1@1", command: "Send on LINE: “Your order ships tomorrow morning.”", choices: [], outdated: true });
    expect(canApproveHere(ask)).toBe(false);
    expect(await settleApproval(store, "buddy", ask, "once")).toBe("Update the app to answer this");
    expect(t("rt.updateToAnswer")).toBe("Update the app to answer this");
    expect(api.calls.every((c) => c.method === "GET")).toBe(true);
    expect(asks(store)).toHaveLength(1);
  });

  it("answers nothing for a session or for always: approval-core has no standing approval", async () => {
    const { api, rt } = await opened();
    for (const choice of ["session", "always"] as const)
      expect(await refusal(rt.request("approval.respond", { bot: "buddy", request_id: "action-1@1", choice })), choice).toEqual({
        code: "not_offered",
        message: "That answer is not offered here",
      });
    expect(api.calls.every((c) => c.method === "GET")).toBe(true);
  });

  it("refuses an ask id it did not make, and one for no request it holds, sending nothing", async () => {
    const { api, rt } = await opened();
    for (const request_id of ["action-1", "action-9@1"])
      expect((await refusal(rt.request("approval.respond", { bot: "buddy", request_id, choice: "once" })))?.code, request_id).toBe("not_found");
    expect(api.calls.every((c) => c.method === "GET")).toBe(true);
  });
});

describe("through the desktop shell", () => {
  it("goes to the API by the shell's request command, the token apart from the address and the body", async () => {
    const origin = "https://answer-shell.manut.xyz";
    const api = serveShop(fakeApi()).on("POST", PATH, () => (replied(api), taken()));
    const shell = desktopShell(api, memoryCacheStore(), storedSession(NOW, { origin }));
    const rt = new HttpRuntime(sharedHttpHost(origin));
    await rt.connect();
    await rt.request("chat.open", { bot: "buddy" });
    await rt.request("approval.respond", { bot: "buddy", request_id: "action-1@1", choice: "once" });
    const posts = shell.commands("api_request").filter((c) => c.args.method === "POST");
    expect(posts.map((c) => c.args)).toEqual([{ url: `${origin}${PATH}`, method: "POST", bearer: "access-1", body: '{"optionId":"approve","seenRevision":1}' }]);
    await vi.waitFor(() => expect(api.to("GET", "/v1/approvals")).toHaveLength(2), PATIENT);
    rt.close();
  });
});

describe("Practice", () => {
  it("answers as it always did: the demo settles it, and nothing reaches the shell or an API", async () => {
    const api = fakeApi();
    const shell = desktopShell(api, memoryCacheStore(), storedSession(NOW));
    const rt = createRuntime({ mode: "practice" });
    expect(rt).toBeInstanceOf(MockRuntime);
    const store = createStore(rt, { firstRoster: "all", hiddenBots: () => [], resume: () => null });
    await store.actions.init();
    await store.actions.selectBot("nam");
    const sent = store.actions.send("/approve");
    await vi.advanceTimersByTimeAsync(2_000);
    await sent;
    const [ask] = selectAsks(store.getState());
    expect(await settleApproval(store, ask.bot, ask.item as ApprovalItem, "once")).toBeNull();
    expect(store.getState().chats.nam.items.find((i) => i.id === ask.item.id)).toMatchObject({ resolved: "once" });
    rt.close();
    vi.useRealTimers();
    await vi.dynamicImportSettled();
    expect(shell.calls).toEqual([]);
    expect(api.calls).toEqual([]);
  });
});
