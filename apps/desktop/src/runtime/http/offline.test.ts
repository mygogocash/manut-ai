// The connected runtime when the API cannot be reached: the last good read of the shop is kept on this computer after
// every good read and shown, with the time it was read, instead of an empty screen. An ask from it cannot be answered
// and nothing is queued. A kept read is not shown after 7 days, and a damaged file is ignored. Signing out, switching
// to Practice and switching origin or shop remove it, and Practice never reads it. The file's own rules (what is kept,
// its name, the order of its calls) are in cache.test.ts; the shell's commands are in shell.test.ts.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLang, t } from "../../i18n";
import type { BridgeError, BridgeEvent } from "../../lib/protocol";
import { createRuntime } from "../index";
import { MockRuntime } from "../mock";
import { RUNTIME_KEY } from "../setting";
import { CACHE_MAX_AGE_MS, ShopCache, cacheKey, decodeCached } from "./cache";
import { HttpHost, POLL_MS } from "./host";
import { HttpRuntime, sessionFor, sharedHttpHost, shopCache } from "./index";
import { ApiSession } from "./session";
import { LinkDown, type FetchLike } from "./shell";
import {
  actionJson,
  fakeApi,
  memoryCacheStore,
  memoryVault,
  ORIGIN,
  savedRead,
  serveShop,
  storedSession,
  T0,
  taskJson,
  tokens,
  WRITE_OPS,
  type FakeApi,
} from "./testkit";

const NOW = T0 + 600_000;
/** A read an earlier run made five minutes before this one starts. */
const EARLIER = NOW - 300_000;
const DAY = 24 * 3600_000;
/** What a wait on the shell's stand-in gets: its commands go through a dynamic import, which a busy machine can be slow to settle. */
const PATIENT = { timeout: 10_000, interval: 10 };
const KEY = cacheKey(ORIGIN, "apple:owner-1");

interface Options {
  signedIn?: boolean;
  /** what an earlier run left on disk, by file name */
  files?: Record<string, string>;
  keeping?: () => boolean;
  /** the session's way to the API, given the fake API (to hold an answer back) */
  fetch?: (api: FakeApi) => FetchLike;
}

function setup(opts: Options = {}) {
  const api = fakeApi();
  const store = memoryCacheStore(opts.files);
  const cache = new ShopCache(store);
  const vault = memoryVault(opts.signedIn === false ? null : storedSession(NOW));
  const session = new ApiSession({ origin: ORIGIN, fetch: opts.fetch ? opts.fetch(api) : api.fetch, vault, deviceId: () => "device-2", onEnd: () => cache.clear() });
  const host = new HttpHost({ session, cache, keeping: opts.keeping });
  const rt = new HttpRuntime(host);
  const events: BridgeEvent[] = [];
  const statuses: string[] = [];
  rt.onAny((ev) => events.push(ev));
  rt.onStatus((s) => statuses.push(s));
  return { api, store, cache, vault, session, host, rt, events, statuses };
}

const allOffline = (api: FakeApi) => api.on("GET", "/v1/tenant/export", "offline").on("GET", "/v1/schedules", "offline").on("GET", "/v1/inbound/attention", "offline");
const ask = (rt: HttpRuntime) => rt.request.bind(rt) as unknown as (op: string, p?: unknown) => Promise<unknown>;
const refusal = (p: Promise<unknown>) => p.then(() => null, (e: BridgeError) => e);
const settle = () => vi.advanceTimersByTimeAsync(0);
/** Starts connecting without waiting for it: a `close` while it waits refuses it, which nobody is listening for. */
const start = (rt: HttpRuntime) => void rt.connect().catch(() => undefined);

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  setLang("en");
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("keeping the last good read", () => {
  it("writes the read to the saved file after each good read, replacing the last", async () => {
    const { api, rt, store } = setup();
    serveShop(api);
    await rt.connect();
    await settle();
    expect([...store.files.keys()]).toEqual([KEY]);
    expect(decodeCached(store.files.get(KEY)!, NOW)).toMatchObject({
      kind: "usable",
      snapshot: { readAt: NOW, tasks: [{ id: "task-1", title: "Reply to Khun Mali" }], schedules: [{ id: "sched-1" }], attention: [{ id: "att-1" }] },
    });
    serveShop(api, { tasks: [taskJson({ task: { id: "task-2", title: "Weekend post" }, actions: [] })] });
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(store.calls).toEqual(["write", "write"]);
    expect([...store.files.keys()]).toEqual([KEY]);
    expect(decodeCached(store.files.get(KEY)!, NOW + POLL_MS)).toMatchObject({ kind: "usable", snapshot: { readAt: NOW + POLL_MS, tasks: [{ id: "task-2" }] } });
  });

  it("never writes a token, a refresh token or anything else the keychain holds, nor who the shop is", async () => {
    const { api, rt, store, vault } = setup();
    serveShop(api, { tasks: [taskJson({ accessToken: "CANARY-ACCESS", actions: [actionJson({ refreshToken: "CANARY-REFRESH", csrf: "CANARY-CSRF" })] })] });
    await rt.connect();
    await settle();
    const text = store.files.get(KEY)!;
    expect(text.length).toBeGreaterThan(200);
    for (const secret of ["CANARY", "access-1", "refresh-1", "device-1", "device-2", "Bearer", "signedInAt", "accessExpiresAt"]) expect(text, secret).not.toContain(secret);
    // the file is known by its hashed name alone: neither the origin nor the tenant is in its name or in what it holds
    for (const own of ["apple:owner-1", "dev.manut.xyz"]) {
      expect(text, own).not.toContain(own);
      expect(KEY, own).not.toContain(own);
    }
    expect(vault.value).toBe(storedSession(NOW));
  });

  it("keeps nothing once the saved choice is no longer this shop, so a switch's deletion is not undone by the next read", async () => {
    let keep = true;
    const { api, rt, store } = setup({ keeping: () => keep });
    serveShop(api);
    await rt.connect();
    await settle();
    expect(store.files.size).toBe(1);
    keep = false; // Settings moved the choice away while this page still runs the old one
    await store.clear();
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(store.files.size).toBe(0);
    expect(store.calls).toEqual(["write", "clear"]);
  });

  it("costs nothing when the disk refuses: the shop still opens and shows", async () => {
    const { api, rt, store, host } = setup();
    store.refuse = true;
    serveShop(api);
    await rt.connect();
    await settle();
    expect(host.link).toBe("open");
    expect(await ask(rt)("thread.list", { bot: "buddy" })).toEqual({ threads: [expect.objectContaining({ thread: "task-1" })] });
  });
});

describe("when the API cannot be reached", () => {
  it("shows the last read of this run, and when it was read, when a read fails while open", async () => {
    const { api, rt, host } = setup();
    serveShop(api);
    await rt.connect();
    api.on("GET", "/v1/tenant/export", { status: 503, json: { error: "storage_unavailable" } });
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(host.link).toBe("unavailable");
    expect(host.cache).toEqual({ kind: "showing", at: NOW });
    expect(rt.status).toBe("open");
    const before = api.calls.length;
    expect(await ask(rt)("thread.list", { bot: "buddy" })).toEqual({ threads: [expect.objectContaining({ thread: "task-1", needs: true })] });
    expect(await ask(rt)("automations.list")).toEqual({ automations: [expect.objectContaining({ id: "sched-1" })] });
    // every screen is answered from what was kept: the API is not asked again on each of them
    expect(api.calls.length).toBe(before);
  });

  it("shows the read an earlier run kept, when the app starts with no way to the API, and when it was read", async () => {
    const { api, rt, host, statuses, events } = setup({ files: await savedRead(EARLIER) });
    allOffline(api);
    await rt.connect();
    expect(statuses).toEqual(["connecting", "open"]);
    expect(host.link).toBe("offline");
    expect(host.cache).toEqual({ kind: "showing", at: EARLIER });
    expect(await ask(rt)("thread.list", { bot: "buddy" })).toEqual({ threads: [expect.objectContaining({ thread: "task-1", title: "Reply to Khun Mali", needs: true })] });
    const open = (await ask(rt)("thread.open", { bot: "buddy", thread: "task-1" })) as { messages: { text: string }[] };
    expect(open.messages.map((m) => m.text)).toEqual([
      "**Reply to Khun Mali**\n\nAnswer her question about delivery",
      "Send on LINE: “Your order ships tomorrow morning.” (waiting for you)",
      "Now: waiting for your approval",
    ]);
    expect(await ask(rt)("chat.open", { bot: "buddy" })).toMatchObject({ messages: [expect.objectContaining({ text: "A Linear issue was changed (issue-9)." })] });
    await settle();
    expect(events).toEqual([expect.objectContaining({ event: "approval.request", request_id: "action-1", command: "Send on LINE: “Your order ships tomorrow morning.”" })]);
    expect(await ask(rt)("automations.list")).toEqual({ automations: [expect.objectContaining({ id: "sched-1", name: "Morning brief", schedule: "30 8 * * 1-5" })] });
  });

  it("reads the disk once for a whole outage, not on every try, whatever it finds there", async () => {
    const found: [string, Record<string, string>][] = [
      ["a read it can show", await savedRead(EARLIER)],
      ["a read too old to show", await savedRead(NOW - 8 * DAY)],
      ["a damaged file", { [KEY]: "\u0000 not json" }],
      ["nothing", {}],
    ];
    for (const [what, files] of found) {
      const { api, rt, store } = setup({ files });
      allOffline(api);
      start(rt);
      await vi.advanceTimersByTimeAsync(5 * 60_000);
      expect(api.to("GET", "/v1/schedules").length, what).toBeGreaterThan(3);
      expect(store.calls, what).toEqual(["read"]);
      rt.close();
    }
  });

  it("does not answer an ask from the kept read: answering needs the live record", async () => {
    const { api, rt } = setup({ files: await savedRead(EARLIER) });
    allOffline(api);
    await rt.connect();
    expect(await refusal(ask(rt)("approval.respond", { bot: "buddy", request_id: "action-1", choice: "once" }))).toEqual({
      code: "offline",
      message: t("rt.connectToAnswer"),
    });
    expect(t("rt.connectToAnswer")).toBe("Connect to answer this");
    expect(api.calls.every((c) => c.method === "GET")).toBe(true);
  });

  it("queues no write while offline, and sends none when the API is back", async () => {
    const { api, rt, host } = setup({ files: await savedRead(EARLIER) });
    allOffline(api);
    await rt.connect();
    for (const op of WRITE_OPS) {
      const out = await refusal(ask(rt)(op, { bot: "buddy", request_id: "action-1", choice: "once", text: "hi", job: "sched-1" }));
      expect(out, op).toEqual({ code: "offline", message: t(op === "approval.respond" ? "rt.connectToAnswer" : "rt.offline") });
    }
    serveShop(api);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(host.link).toBe("open");
    await vi.advanceTimersByTimeAsync(5 * POLL_MS);
    // nothing was held back to be sent later: every request ever made was a read
    expect(api.calls.every((c) => c.method === "GET")).toBe(true);
  });

  it("when the API is back, reads again, replaces what was kept, and has the app read everything again", async () => {
    const { api, rt, host, statuses, store, events } = setup({ files: await savedRead(EARLIER) });
    allOffline(api);
    await rt.connect();
    expect(statuses).toEqual(["connecting", "open"]);
    serveShop(api, { tasks: [taskJson({ task: { id: "task-7", title: "Fresh" }, actions: [] })] });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(host.link).toBe("open");
    expect(host.cache).toEqual({ kind: "none" });
    // the store re-reads everything when the runtime opens again, as after any outage; only the ask the kept read showed,
    // whose task is gone now, is said to be over, because the store keeps the cards it has
    expect(statuses).toEqual(["connecting", "open", "closed", "open"]);
    expect(events).toEqual([{ event: "prompt.expired", bot: "buddy", request_id: "action-1", reason: "cancelled" }]);
    expect(await ask(rt)("thread.list", { bot: "buddy" })).toEqual({ threads: [expect.objectContaining({ thread: "task-7" })] });
    expect(decodeCached(store.files.get(KEY)!, NOW + 2_000)).toMatchObject({ kind: "usable", snapshot: { readAt: NOW + 2_000, tasks: [{ id: "task-7" }] } });
  });

  it("is signed out, with nothing shown, for a session the API ended, even with a read kept", async () => {
    const { api, rt, host } = setup();
    serveShop(api);
    await rt.connect();
    api.on("GET", "/v1/schedules", { status: 401, json: {} }).on("POST", "/v1/auth/refresh", { status: 401, json: { error: "session_expired" } });
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(host.link).toBe("signed_out");
    expect(host.cache).toEqual({ kind: "none" });
    expect(rt.status).toBe("closed");
  });
});

describe("a kept read too old to show, or damaged", () => {
  it("does not show a read more than 7 days old, and says so", async () => {
    const at = NOW - CACHE_MAX_AGE_MS - 1;
    const { api, rt, host, statuses } = setup({ files: await savedRead(at) });
    allOffline(api);
    start(rt);
    await settle();
    expect(host.link).toBe("offline");
    expect(host.cache).toEqual({ kind: "too_old", at });
    expect(rt.status).toBe("closed");
    expect(statuses).toEqual(["connecting", "closed"]);
    expect(await refusal(ask(rt)("thread.list", { bot: "buddy" }))).toEqual({ code: "offline", message: t("rt.offline") });
    rt.close();
  });

  it("shows a read that is exactly 7 days old", async () => {
    const at = NOW - CACHE_MAX_AGE_MS;
    const { api, rt, host } = setup({ files: await savedRead(at) });
    allOffline(api);
    await rt.connect();
    expect(host.cache).toEqual({ kind: "showing", at });
  });

  it("stops showing a read once it is 7 days old, however it came to be shown", async () => {
    const { api, rt, host } = setup();
    serveShop(api).on("POST", "/v1/auth/refresh", { status: 200, json: tokens(2) });
    await rt.connect();
    allOffline(api);
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(host.cache).toEqual({ kind: "showing", at: NOW });
    vi.setSystemTime(NOW + CACHE_MAX_AGE_MS + POLL_MS + 1);
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(host.cache).toEqual({ kind: "too_old", at: NOW });
    expect(rt.status).toBe("closed");
    expect(await refusal(ask(rt)("thread.list", { bot: "buddy" }))).toEqual({ code: "offline", message: t("rt.offline") });
  });

  it("ignores a damaged file: nothing shown, no crash, and it still opens when the API answers", async () => {
    for (const text of ["\u0000\u0001 not json", '{"v":1,"snapshot":{"tasks":[{"id":3}]}}', "[]", "", '{"v":9,"snapshot":{}}']) {
      const { api, rt, host } = setup({ files: { [KEY]: text } });
      allOffline(api);
      start(rt);
      await settle();
      expect(host.link, text).toBe("offline");
      expect(host.cache, text).toEqual({ kind: "none" });
      expect(rt.status, text).toBe("closed");
      serveShop(api);
      await vi.advanceTimersByTimeAsync(2_000);
      expect(rt.status, text).toBe("open");
      rt.close();
    }
  });

  it("never shows another shop's read", async () => {
    const other = cacheKey(ORIGIN, "apple:someone-else");
    const files = Object.fromEntries(Object.values(await savedRead(EARLIER)).map((text) => [other, text]));
    const { api, rt, host } = setup({ files });
    allOffline(api);
    start(rt);
    await settle();
    expect(host.cache).toEqual({ kind: "none" });
    expect(rt.status).toBe("closed");
    rt.close();
  });
});

describe("forgetting what was kept", () => {
  it("deletes the saved read when the person signs out", async () => {
    const { api, rt, host, store, session } = setup();
    serveShop(api).on("DELETE", "/v1/auth/session", { status: 200, json: {} });
    await rt.connect();
    await settle();
    expect(store.files.size).toBe(1);
    await session.signOut();
    expect(store.files.size).toBe(0);
    expect(host.link).toBe("signed_out");
    expect(host.cache).toEqual({ kind: "none" });
    expect(rt.status).toBe("closed");
  });

  it("deletes it when the API ends the session", async () => {
    const { api, rt, store } = setup();
    serveShop(api);
    await rt.connect();
    await settle();
    expect(store.files.size).toBe(1);
    api.on("GET", "/v1/schedules", { status: 401, json: {} }).on("POST", "/v1/auth/refresh", { status: 401, json: { error: "session_expired" } });
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(store.files.size).toBe(0);
  });

  it("leaves no file, and shows nothing, when a read that was on its way finishes after the person signed out", async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const { api, rt, host, store, session } = setup({
      fetch: (a) => async (url, init) => {
        if (new URL(url).pathname === "/v1/tenant/export") await held;
        return a.fetch(url, init);
      },
    });
    serveShop(api).on("DELETE", "/v1/auth/session", { status: 200, json: {} });
    start(rt);
    await settle(); // the export's answer is held back
    await session.signOut();
    expect(host.link).toBe("signed_out");
    release();
    await settle();
    expect(host.link).toBe("signed_out");
    expect(host.cache).toEqual({ kind: "none" });
    expect(rt.status).toBe("closed");
    expect(store.calls.filter((c) => c === "write")).toEqual([]);
    expect(store.files.size).toBe(0);
  });
});

describe("a look at the disk that ends late", () => {
  it("does not bring back a read the person deleted: the host was stopped while it was being read, then they signed out and in again", async () => {
    const { api, rt, host, store, session } = setup({ files: await savedRead(EARLIER) });
    allOffline(api).on("DELETE", "/v1/auth/session", { status: 200, json: {} }).on("POST", "/v1/auth/exchange", { status: 200, json: tokens(2) });
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let reached!: () => void;
    const started = new Promise<void>((resolve) => (reached = resolve));
    const read = store.read.bind(store);
    store.read = async (key) => {
      reached();
      await held;
      return read(key);
    };
    start(rt);
    await started; // the outage's one look at the disk is on its way
    rt.close(); // the last client lets go: the host stops
    release();
    await settle(); // the look ends after the host stopped
    await session.signOut(); // the saved read is deleted
    expect(store.files.size).toBe(0);
    store.read = read;
    await session.signIn("eyJ.eyJ.sig", "nonce"); // the same shop again, with the API still out of reach
    const again = new HttpRuntime(host);
    start(again);
    await settle();
    expect(host.link).toBe("offline");
    expect(host.cache).toEqual({ kind: "none" });
    expect(again.status).toBe("closed");
    again.close();
  });
});

/** The desktop shell's commands in memory: the API through the fake, the keychain item, and the saved read. */
function desktopShell(api: FakeApi, store: ReturnType<typeof memoryCacheStore>, keychain: string | null) {
  const calls: { cmd: string; args: Record<string, any> }[] = [];
  let answered = 0;
  let item = keychain;
  const invoke = async (cmd: string, args: Record<string, any> = {}) => {
    calls.push({ cmd, args });
    switch (cmd) {
      case "api_request": {
        try {
          const answer = await api.fetch(args.url, { method: args.method, headers: args.bearer ? { authorization: `Bearer ${args.bearer}` } : {}, ...(args.body ? { body: args.body } : {}) });
          const body = await answer.text();
          answered += 1;
          return { status: answer.status, body };
        } catch (e) {
          throw e instanceof LinkDown && e.kind === "offline" ? "offline" : "failed";
        }
      }
      case "api_session_read":
        return item;
      case "api_session_write":
        item = args.value;
        return null;
      case "api_session_clear":
        item = null;
        return null;
      case "shop_cache_write":
        return store.write(args.key, args.text);
      case "shop_cache_read":
        return store.read(args.key);
      case "shop_cache_clear":
        return store.clear();
    }
    throw new Error(`no such command: ${cmd}`);
  };
  vi.stubGlobal("window", { __TAURI_INTERNALS__: { invoke } });
  return { calls, commands: (name: string) => calls.filter((c) => c.cmd === name), answered: () => answered };
}

describe("Practice", () => {
  it("never reads or writes the saved read, whatever is on disk, and reaches no command of the shell at all", async () => {
    const store = memoryCacheStore(await savedRead(EARLIER));
    const shell = desktopShell(fakeApi(), store, storedSession(NOW));
    const rt = createRuntime({ mode: "practice" });
    expect(rt).toBeInstanceOf(MockRuntime);
    await rt.connect();
    await rt.request("bots.list", {});
    await vi.advanceTimersByTimeAsync(2 * POLL_MS);
    rt.close();
    // let anything started on the side, however late it arrives, arrive before looking
    vi.useRealTimers();
    await vi.dynamicImportSettled();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(shell.calls).toEqual([]);
    expect(store.calls).toEqual([]);
    expect(store.files.size).toBe(1);
  });
});

describe("through the desktop shell", () => {
  it("keeps the read with shop_cache_write, stops keeping it once the choice moves away, and forgets it with shop_cache_clear", async () => {
    const origin = "https://shell-1.manut.xyz";
    const api = serveShop(fakeApi()).on("DELETE", "/v1/auth/session", { status: 200, json: {} });
    const store = memoryCacheStore();
    const shell = desktopShell(api, store, storedSession(NOW, { origin }));
    const saved = new Map([[RUNTIME_KEY, JSON.stringify({ mode: "connected", origin })]]);
    vi.stubGlobal("localStorage", { getItem: (k: string) => saved.get(k) ?? null, setItem: (k: string, v: string) => void saved.set(k, v) });
    const keep = vi.spyOn(shopCache(), "keep");
    const rt = new HttpRuntime(sharedHttpHost(origin));
    await rt.connect();
    await vi.waitFor(() => expect(shell.commands("shop_cache_write")).toHaveLength(1), PATIENT);
    const writes = shell.commands("shop_cache_write");
    expect(writes[0].args.key).toBe(cacheKey(origin, "apple:owner-1"));
    expect(decodeCached(writes[0].args.text, NOW)).toMatchObject({ kind: "usable", snapshot: { tasks: [{ id: "task-1" }] } });
    expect(JSON.stringify(shell.calls.filter((c) => c.cmd.startsWith("shop_cache")))).not.toMatch(/access-1|refresh-1|device-1/);
    // Settings moved the saved choice to Practice: this page runs on, reading as before, but keeps nothing more
    saved.set(RUNTIME_KEY, JSON.stringify({ mode: "practice" }));
    await vi.advanceTimersByTimeAsync(POLL_MS);
    await vi.waitFor(() => expect(shell.answered()).toBe(6), PATIENT);
    await settle();
    expect(keep).toHaveBeenCalledTimes(1);
    // back to this shop: it is kept again from the next read
    saved.set(RUNTIME_KEY, JSON.stringify({ mode: "connected", origin }));
    await vi.advanceTimersByTimeAsync(POLL_MS);
    await vi.waitFor(() => expect(keep).toHaveBeenCalledTimes(2), PATIENT);
    await vi.waitFor(() => expect(shell.commands("shop_cache_write")).toHaveLength(2), PATIENT);
    await sessionFor(origin).signOut();
    expect(shell.commands("shop_cache_clear")).toHaveLength(1);
    expect(store.files.size).toBe(0);
    rt.close();
  });
});
