// What a notification may answer, for every kind of ask the connected runtime shows (docs/runtime-adapter.md, "From a
// notification"). The canvas allows exactly one thing: "A message request can be approved from the notification", and
// "Money never from a notification". So only a `message` or a `reply` request carries Approve, never while details are
// hidden and never for an ask this build cannot answer; any other kind, and any kind this build does not know, carries
// Look first and Later and nothing that could approve. Approve is the card's own Allow once, sent through the same path
// (`settleApproval`, then the host's `answer`: the decide route with exactly the option and the revision the card showed),
// never a second way round. Run end to end under the app's own store over a fake API, with the notification plugin stood in.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  sent: [] as Record<string, unknown>[],
  listener: null as null | ((e: unknown) => unknown),
  front: [] as string[],
}));
vi.mock("@tauri-apps/plugin-notification", () => ({
  isPermissionGranted: async () => true,
  requestPermission: async () => "granted",
  registerActionTypes: async () => {},
  onAction: async (cb: (e: unknown) => unknown) => {
    h.listener = cb;
    return { unregister: async () => {} };
  },
  sendNotification: (options: Record<string, unknown>) => void h.sent.push(options),
}));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    unminimize: async () => void h.front.push("unminimize"),
    show: async () => void h.front.push("show"),
    setFocus: async () => void h.front.push("focus"),
  }),
}));

const NOW = Date.UTC(2026, 10, 23, 1, 0, 0) + 600_000; // 08:10 in Bangkok: quiet hours have ended
const AT = NOW - 180_000;

/** The page as the desktop shell runs it: a connected runtime over a fake API, the store with notifications switched on,
 *  and a fresh copy of every module, since what notify.ts keeps (its listener, the asks it showed) is per page. */
async function opened(
  over: { approvals?: unknown[]; tasks?: unknown[] } = {},
  fetchWith?: (api: any) => (url: string, init: any) => Promise<unknown>,
  settings: Record<string, string> = {},
  now = NOW,
) {
  vi.resetModules();
  vi.stubGlobal("window", { __TAURI_INTERNALS__: {}, addEventListener: () => {} });
  vi.stubGlobal("navigator", { platform: "MacIntel" });
  const data: Record<string, string> = { ...settings };
  vi.stubGlobal("localStorage", { getItem: (k: string) => (k in data ? data[k] : null), setItem: (k: string, v: string) => void (data[k] = v), removeItem: (k: string) => void delete data[k] });
  const kit = await import("../runtime/http/testkit");
  const { createStore, notifySessionEvent } = await import("../state/store");
  const { HttpHost } = await import("../runtime/http/host");
  const { HttpRuntime } = await import("../runtime/http");
  const { ApiSession } = await import("../runtime/http/session");
  const api = kit.serveShop(kit.fakeApi(), over);
  const session = new ApiSession({ origin: kit.ORIGIN, fetch: (fetchWith ? fetchWith(api) : api.fetch) as never, vault: kit.memoryVault(kit.storedSession(now)) });
  const rt = new HttpRuntime(new HttpHost({ session }));
  const store: import("../state/store").Store = createStore(rt, {
    firstRoster: "all",
    watchSeen: { get: () => null, set: () => {} },
    onEvent: (ev, state) => notifySessionEvent(ev, state, store),
  });
  await store.actions.init();
  await settled();
  return { api, store, kit };
}

/** Lets everything the store and the host started, which all answer in-process, run to its end. The clock is faked but not
 *  `setImmediate`: the notification plugin is loaded on demand, which needs real turns of the event loop. */
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
async function settled() {
  for (let i = 0; i < 12; i += 1) {
    await vi.advanceTimersByTimeAsync(5);
    await tick();
  }
}
/** Waits until `n` notifications have gone to the system. */
const shown = (n: number) => vi.waitFor(() => expect(h.sent).toHaveLength(n), { timeout: 4000, interval: 5 });

const PATH = "/v1/approvals/action-1/decision";
const press = async (actionId: string, id: unknown) => {
  await h.listener!({ actionId, inputValue: null, notification: { id } });
  await settled();
};
const lastId = () => h.sent[h.sent.length - 1].id;
const card = (store: import("../state/store").Store, id: string) => store.getState().chats.buddy?.items.find((i) => i.kind === "approval" && i.request_id === id) as import("../state/store").ApprovalItem | undefined;

/** One request of the given kind, whose words are its kind, so the notification for it can be told apart. */
async function ofKind(kind: string) {
  const { approvalJson, replyDetail } = await import("../runtime/http/testkit");
  return approvalJson({ id: `req-${kind}`, kind, detail: replyDetail(`req-${kind}`, `about ${kind}`) });
}

beforeEach(() => {
  h.sent.length = 0;
  h.listener = null;
  h.front.length = 0;
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("which asks a notification may approve", () => {
  it("offers Approve for a message and a reply, never first, and nothing else for any other kind or one this build does not know", async () => {
    const kinds = ["message", "reply", "money", "public_post", "payment_confirmation", "command", "refund_partial"];
    const approvals = await Promise.all(kinds.map(ofKind));
    await opened({ approvals, tasks: [] });
    await shown(kinds.length);
    // a notification's body drops markdown marks, underscores among them: "about public_post" is said "about publicpost"
    const types = Object.fromEntries(kinds.map((k) => [k, h.sent.find((s) => String(s.body).includes(`about ${k.replace(/_/g, "")}`))?.actionTypeId]));
    expect(types).toEqual({
      message: "manut:look_first+approve",
      reply: "manut:look_first+approve",
      money: "manut:look_first+later",
      public_post: "manut:look_first+later",
      payment_confirmation: "manut:look_first+later",
      command: "manut:look_first+later",
      refund_partial: "manut:look_first+later",
    });
    expect(h.sent).toHaveLength(kinds.length);
  });

  it("names who asks and the exact action, as the card does", async () => {
    await opened({ approvals: [await ofKind("reply")], tasks: [] });
    await shown(1);
    expect(h.sent[0]).toMatchObject({ title: "Buddy needs you", body: "Send on LINE: “about reply”" });
  });

  it("offers no Approve while details are hidden, and says only how many requests wait", async () => {
    await opened({ approvals: [await ofKind("reply"), await ofKind("message")], tasks: [] }, undefined, { "manut.notify.hide": "on" });
    await shown(2);
    // each says how many wait when it comes: the second request makes two
    expect(h.sent.map((s) => [s.title, s.body, s.actionTypeId])).toEqual([
      ["Manut AI", "1 request needs you.", "manut:look_first"],
      ["Manut AI", "2 requests need you.", "manut:look_first"],
    ]);
    expect(JSON.stringify(h.sent)).not.toMatch(/Buddy|about/);
  });

  it("offers no Approve for a reply the card itself offers no answer to", async () => {
    const { approvalJson, replyDetail, OPTIONS } = await import("../runtime/http/testkit");
    // an option this build does not know the effect of: shown, never answered (Update the app to answer this)
    const odd = approvalJson({ id: "req-odd", kind: "reply", options: [...OPTIONS, { id: "later", label: "Later", effect: "snooze" }], detail: replyDetail("req-odd", "about odd") });
    await opened({ approvals: [odd], tasks: [] });
    await shown(1);
    // a reply notify-rules would let be approved, but the card offers no Allow once: only Look first is left
    expect(h.sent[0].actionTypeId).toBe("manut:look_first");
  });

  it("shows nothing in quiet hours: the request waits in the app", async () => {
    const night = Date.UTC(2026, 10, 23, 16, 30, 0); // 23:30 in Bangkok
    vi.setSystemTime(night);
    const { store } = await opened({ approvals: [await ofKind("reply")], tasks: [] }, undefined, {}, night);
    expect(h.sent).toEqual([]);
    expect(store.getState().chats.buddy.items.filter((i) => i.kind === "approval")).toHaveLength(1);
  });
});

describe("Approve on a notification", () => {
  it("sends exactly the card's Allow once: the option that approves and the revision the card showed, never a role", async () => {
    for (const kind of ["reply", "message"]) {
      h.sent.length = 0;
      const { api, store, kit } = await opened({ approvals: [await ofKind(kind)], tasks: [] });
      await shown(1);
      const decide = `/v1/approvals/req-${kind}/decision`;
      api.on("POST", decide, { status: 200, json: { result: { ok: true, decision: { requestId: `req-${kind}`, optionId: "approve", seenRevision: 1, decidedBy: "owner-session", role: "owner", decidedAt: NOW }, action: "confirmed" } } });
      await press("approve", lastId());
      const sent = api.to("POST", decide);
      expect(sent, kind).toHaveLength(1);
      expect(sent[0].url).toBe(`${kit.ORIGIN}${decide}`);
      expect(sent[0].body, kind).toEqual({ optionId: "approve", seenRevision: 1 });
      expect(Object.keys(sent[0].body as object), kind).toEqual(["optionId", "seenRevision"]);
      expect(card(store, `req-${kind}@1`), kind).toMatchObject({ resolved: "once" });
      // it was taken: the app does not need to open
      expect(h.front, kind).toEqual([]);
    }
  });

  it("answers once, however many times the system reports the button", async () => {
    const { api, store, kit } = await opened({ approvals: [await ofKind("reply")], tasks: [] });
    await shown(1);
    api.on("POST", "/v1/approvals/req-reply/decision", { status: 200, json: { result: { ok: true } } });
    const id = lastId();
    await press("approve", id);
    await press("approve", id);
    expect(api.to("POST", "/v1/approvals/req-reply/decision")).toHaveLength(1);
    expect(card(store, "req-reply@1")).toMatchObject({ resolved: "once" });
    void kit;
  });

  it("answers nothing for money, a post, a payment, a command or a kind it does not know, whatever the system reports", async () => {
    const kinds = ["money", "public_post", "payment_confirmation", "command", "refund_partial"];
    const { api, store } = await opened({ approvals: await Promise.all(kinds.map(ofKind)), tasks: [] });
    await shown(kinds.length);
    for (const s of h.sent) {
      await press("approve", s.id);
      await press("Approve", s.id);
    }
    for (const kind of kinds) expect(api.to("POST", `/v1/approvals/req-${kind}/decision`), kind).toEqual([]);
    expect(store.getState().chats.buddy.items.filter((i) => i.kind === "approval" && i.resolved)).toEqual([]);
    expect(h.front).toEqual([]);
  });

  it("answers nothing for a reply while details are hidden", async () => {
    const { api } = await opened({ approvals: [await ofKind("reply")], tasks: [] }, undefined, { "manut.notify.hide": "on" });
    await shown(1);
    await press("approve", lastId());
    expect(api.to("POST", "/v1/approvals/req-reply/decision")).toEqual([]);
  });

  it("brings the app forward on the card, with the API's words under it, when the answer was refused", async () => {
    const { api, store, kit } = await opened({ approvals: [await ofKind("reply")], tasks: [] });
    await shown(1);
    // the owner's own session may decide a reply; this refusal is the shop's consent, which leaves the card open
    api.on("POST", "/v1/approvals/req-reply/decision", { status: 403, json: { error: "consent_required", result: { ok: false, refused: "consent_required" } } });
    await press("approve", lastId());
    const { askNoteOf } = await import("../chat/cards/askNote");
    expect(api.to("POST", "/v1/approvals/req-reply/decision")).toHaveLength(1);
    expect(askNoteOf("req-reply@1")).toBe("The shop has not agreed yet to let Manut AI send for it");
    expect(h.front).toEqual(["unminimize", "show", "focus"]);
    expect(store.getState().ui.focusAsk).toMatchObject({ bot: "buddy", id: "approval-req-reply@1" });
    // the card is still waiting for the owner, and says why under its buttons
    expect(card(store, "req-reply@1")?.resolved).toBeUndefined();
    void kit;
  });

  it("closes the card in the API's words, and brings the app forward on it, when someone decided first", async () => {
    const { api, store, kit } = await opened({ approvals: [await ofKind("reply")], tasks: [] });
    await shown(1);
    api.on("POST", "/v1/approvals/req-reply/decision", () => {
      kit.serveShop(api, { approvals: [] , tasks: []});
      const decision = { requestId: "req-reply", optionId: "approve", seenRevision: 1, decidedBy: "owner-link", role: "owner", decidedAt: AT };
      return { status: 409, json: { error: "already_decided", result: { ok: false, refused: "already_decided", decision } } };
    });
    await press("approve", lastId());
    expect(card(store, "req-reply@1")).toMatchObject({ expired: "resolved" });
    expect(card(store, "req-reply@1")?.expiredNote).toMatch(/^Already decided from your LINE link at /);
    expect(h.front).toEqual(["unminimize", "show", "focus"]);
    expect(store.getState().ui.focusAsk).toMatchObject({ bot: "buddy", id: "approval-req-reply@1" });
  });

  it("brings the app forward on the card, saying it is being checked, when no word came back", async () => {
    const { api, store } = await opened(
      { approvals: [await ofKind("reply")], tasks: [] },
      (fake) => async (url, init) => {
        if (init.method === "POST") throw new Error("the network dropped");
        return fake.fetch(url, init);
      },
    );
    void api;
    await shown(1);
    await press("approve", lastId());
    const { askNoteOf } = await import("../chat/cards/askNote");
    expect(askNoteOf("req-reply@1")).toBe("No reply from the API. Checking whether your answer arrived");
    expect(h.front).toEqual(["unminimize", "show", "focus"]);
    expect(card(store, "req-reply@1")?.resolved).toBeUndefined();
  });

  it("sends nothing, and shows the card, when the request is no longer waiting", async () => {
    const { api, store } = await opened({ approvals: [await ofKind("reply")], tasks: [] });
    await shown(1);
    const { settleApproval } = await import("../chat/cards/respond");
    api.on("POST", "/v1/approvals/req-reply/decision", { status: 200, json: { result: { ok: true } } });
    // the owner answered on the card first
    expect(await settleApproval(store, "buddy", card(store, "req-reply@1")!, "once")).toBeNull();
    await settled();
    expect(api.to("POST", "/v1/approvals/req-reply/decision")).toHaveLength(1);
    await press("approve", lastId());
    expect(api.to("POST", "/v1/approvals/req-reply/decision")).toHaveLength(1);
    expect(h.front).toEqual(["unminimize", "show", "focus"]);
    expect(store.getState().ui.focusAsk).toMatchObject({ bot: "buddy", id: "approval-req-reply@1" });
  });
});

describe("Look first and Later on a notification", () => {
  it("Look first, or a click on the notification, brings the app forward and focuses that request's card", async () => {
    const { store } = await opened({ approvals: [await ofKind("money")], tasks: [] });
    await shown(1);
    await press("look_first", lastId());
    expect(h.front).toEqual(["unminimize", "show", "focus"]);
    expect(store.getState().ui.focusAsk).toMatchObject({ bot: "buddy", id: "approval-req-money@1" });
    h.front.length = 0;
    await press("tap", lastId());
    expect(h.front).toEqual(["unminimize", "show", "focus"]);
  });

  it("Later only dismisses: nothing is sent, nothing opens", async () => {
    const { api, store } = await opened({ approvals: [await ofKind("money")], tasks: [] });
    await shown(1);
    await press("later", lastId());
    expect(h.front).toEqual([]);
    expect(store.getState().ui.focusAsk).toBeNull();
    expect(api.to("POST", "/v1/approvals/req-money/decision")).toEqual([]);
  });
});
