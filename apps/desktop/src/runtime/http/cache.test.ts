// The offline cache's own rules, without a runtime: what is kept of a read of the shop, what is read back after a
// restart, when a kept read is too old to show, and how the saved file is looked after (one at a time, in order, never
// raising, forgotten for good when the session ends). The runtime's use of it is in offline.test.ts.
import { isUnknown } from "@manut/approval-core";
import { describe, expect, it } from "vitest";
import { decodeApprovals, type ShopApproval } from "./approvals";
import { CACHE_MAX_AGE_MS, CACHE_VERSION, ShopCache, cacheKey, decodeCached, encodeSnapshot } from "./cache";
import type { ShopSnapshot } from "./shop";
import { approvalJson, memoryCacheStore, replyDetail, type ApprovalOver } from "./testkit";

const NOW = Date.UTC(2026, 10, 23, 7, 0, 0);
const DAY = 24 * 3600_000;
const ORIGIN = "https://dev.manut.xyz";
const TENANT = "apple:owner-1";

/** A request as `readShop` decodes it, with a token-looking value in its detail and in the API's whole entry. */
function approval(over: ApprovalOver = {}): ShopApproval {
  const entry = { ...approvalJson({ detail: { ...replyDetail(), token: "RAW-DETAIL-SECRET" }, ...over }), secret: "RAW-APPROVAL-SECRET" };
  return decodeApprovals({ state: "open", approvals: [entry] }, [])[0];
}

/** A read of the shop as `readShop` decodes it, with the API's whole objects in `raw` and a token-looking value in
 *  each, so a test can see that none of them reaches the file. */
function snapshot(over: Partial<ShopSnapshot> = {}): ShopSnapshot {
  return {
    tasks: [
      {
        id: "task-1",
        title: "Reply to Khun Mali",
        objective: "Answer her question about delivery",
        state: "waitingForAuthorization",
        createdAt: NOW - 600_000,
        updatedAt: NOW - 120_000,
        events: 2,
        actions: [
          {
            id: "action-1",
            taskId: "task-1",
            operationType: "line.message.push",
            targetResourceId: "bot-user-1",
            recipients: ["U-customer"],
            payload: { text: "Your order ships tomorrow morning." },
            state: "proposed",
            proposedAt: NOW - 90_000,
            expiresAt: NOW + DAY,
            raw: { accessToken: "RAW-ACTION-SECRET" },
          },
        ],
        raw: { refreshToken: "RAW-TASK-SECRET", events: [{ kind: "created" }] },
      },
    ],
    approvals: [approval({ passedOn: { by: "helper-mint", name: "Mint", note: "Looks right to me.", at: "2026-11-23T06:55:00.000Z" } })],
    schedules: [
      {
        id: "sched-1",
        name: "Morning brief",
        prompt: "Tell me what came in overnight",
        hour: 8,
        minute: 30,
        weekdays: [2, 3, 4, 5, 6],
        timeZone: "Asia/Bangkok",
        enabled: true,
        revision: 2,
        nextFire: NOW + 3600_000,
        createdAt: NOW - DAY,
        raw: { csrf: "RAW-SCHEDULE-SECRET" },
      },
    ],
    attention: [{ id: "att-1", connectionId: "conn-2", eventType: "linear.issue.update", issueId: "issue-9", receivedAt: NOW - 30_000, raw: { note: "RAW-ATT-SECRET" } }],
    attentionOff: false,
    unreadable: [{ odd: "RAW-UNREADABLE-SECRET" }],
    readAt: NOW,
    ...over,
  };
}

/** The same read as it comes back from a file: what the screens read, with no `raw` and nothing unreadable. */
function kept(s: ShopSnapshot): ShopSnapshot {
  return {
    ...s,
    tasks: s.tasks.map((task) => ({ ...task, raw: null, actions: task.actions.map((a) => ({ ...a, raw: null })) })),
    approvals: s.approvals.map((a) => ({ ...a, raw: null })),
    schedules: s.schedules.map((x) => ({ ...x, raw: null })),
    attention: s.attention.map((x) => ({ ...x, raw: null })),
    unreadable: [],
  };
}

/** The file's JSON, changed by `edit`, as text. */
function damaged(edit: (file: { v: number; snapshot: Record<string, any> }) => void): string {
  const file = JSON.parse(encodeSnapshot(snapshot()));
  edit(file);
  return JSON.stringify(file);
}

describe("what is kept", () => {
  it("keeps what the screens read of the shop, and nothing else the API carried", () => {
    const text = encodeSnapshot(snapshot());
    const file = JSON.parse(text);
    expect(Object.keys(file).sort()).toEqual(["snapshot", "v"]);
    expect(file.v).toBe(3);
    expect(CACHE_VERSION).toBe(3);
    expect(Object.keys(file.snapshot).sort()).toEqual(["approvals", "attention", "attentionOff", "readAt", "schedules", "tasks"]);
    expect(Object.keys(file.snapshot.tasks[0]).sort()).toEqual(["actions", "createdAt", "events", "id", "objective", "state", "title", "updatedAt"]);
    expect(Object.keys(file.snapshot.tasks[0].actions[0]).sort()).toEqual([
      "expiresAt",
      "id",
      "operationType",
      "payload",
      "proposedAt",
      "recipients",
      "state",
      "targetResourceId",
      "taskId",
    ]);
    expect(Object.keys(file.snapshot.schedules[0]).sort()).toEqual(["createdAt", "enabled", "hour", "id", "minute", "name", "nextFire", "prompt", "revision", "timeZone", "weekdays"]);
    expect(Object.keys(file.snapshot.attention[0]).sort()).toEqual(["connectionId", "eventType", "id", "issueId", "receivedAt"]);
    // what waits for the owner, as approval-core's own wire JSON, its detail only the words the card shows
    expect(Object.keys(file.snapshot.approvals[0]).sort()).toEqual(["passedOn", "record", "standing", "taskId"]);
    expect(file.snapshot.approvals[0].standing).toEqual({ state: "open", reason: "waiting" });
    expect(Object.keys(file.snapshot.approvals[0].record).sort()).toEqual(["request", "status"]);
    expect(Object.keys(file.snapshot.approvals[0].record.request.detail).sort()).toEqual(["actionId", "operationType", "recipient", "targetResourceId", "text"]);
    expect(file.snapshot.approvals[0].passedOn).toEqual({ by: "helper-mint", name: "Mint", note: "Looks right to me.", at: Date.parse("2026-11-23T06:55:00.000Z") });
    // the API's whole objects, which a later slice may read, are not what an offline screen needs: none is written
    expect(text).not.toMatch(/SECRET/);
  });

  it("reads back what it kept, whole", () => {
    const back = decodeCached(encodeSnapshot(snapshot()), NOW + 60_000);
    expect(back).toEqual({ kind: "usable", snapshot: kept(snapshot()) });
  });

  it("keeps a shop with nothing in it, and an inbound feed that is switched off", () => {
    const empty = snapshot({ tasks: [], approvals: [], schedules: [], attention: [], attentionOff: true, unreadable: [] });
    expect(decodeCached(encodeSnapshot(empty), NOW)).toEqual({ kind: "usable", snapshot: empty });
  });

  it("keeps an ask this build cannot answer as it was, so it is still shown, and still says to update the app", () => {
    const s = snapshot({ approvals: [approval({ kind: "refund_partial", standing: { state: "paused_by_owner" } })] });
    const back = decodeCached(encodeSnapshot(s), NOW);
    if (back.kind !== "usable") throw new Error("expected the read back");
    const [a] = back.snapshot.approvals;
    expect(a.record.request.kind).toEqual({ unknown: true, raw: "refund_partial" });
    expect(isUnknown(a.standing.state)).toBe(true);
    expect(back.snapshot).toEqual(kept(s));
  });
});

describe("reading a kept read back", () => {
  it("is nothing when nothing was kept, or the file is not one of ours", () => {
    for (const text of [null, "", "not json", "{", "[]", "null", "7", '"x"', '{"v":3,"snapshot":{}}', '{"v":2}', '{"v":2,"snapshot":null}', '{"v":2,"snapshot":{"tasks":"x"}}']) {
      expect(decodeCached(text, NOW), String(text)).toEqual({ kind: "none" });
    }
  });

  it("is nothing for a file the earlier version kept: it holds no approvals, so what waits for the owner would be missing", () => {
    const earlier = damaged((f) => {
      f.v = 1;
      delete f.snapshot.approvals;
    });
    expect(decodeCached(earlier, NOW)).toEqual({ kind: "none" });
  });

  it("is nothing when any entry is damaged: half a shop is never shown as the whole one", () => {
    const edits: [string, (f: { snapshot: Record<string, any> }) => void][] = [
      ["a task with no id", (f) => (f.snapshot.tasks[0].id = "")],
      ["a task whose title is a number", (f) => (f.snapshot.tasks[0].title = 7)],
      ["a task whose actions are not a list", (f) => (f.snapshot.tasks[0].actions = null)],
      ["an action with no payload", (f) => (f.snapshot.tasks[0].actions[0].payload = null)],
      ["an action whose recipients are not strings", (f) => (f.snapshot.tasks[0].actions[0].recipients = [3])],
      ["an action whose expiry is text", (f) => (f.snapshot.tasks[0].actions[0].expiresAt = "soon")],
      ["a schedule whose hour is text", (f) => (f.snapshot.schedules[0].hour = "8")],
      ["a schedule whose days are not numbers", (f) => (f.snapshot.schedules[0].weekdays = ["mon"])],
      ["a schedule that is not switched on or off", (f) => (f.snapshot.schedules[0].enabled = "yes")],
      ["an attention item with no id", (f) => delete f.snapshot.attention[0].id],
      ["no read time", (f) => delete f.snapshot.readAt],
      ["a read time that is not a number", (f) => (f.snapshot.readAt = "yesterday")],
      ["a switch for the inbound feed that is text", (f) => (f.snapshot.attentionOff = "no")],
      ["a list of tasks that holds a string", (f) => f.snapshot.tasks.push("x")],
      ["no list of approvals", (f) => delete f.snapshot.approvals],
      ["a list of approvals that is not a list", (f) => (f.snapshot.approvals = {})],
      ["an approval that is not an object", (f) => f.snapshot.approvals.push("x")],
      ["an approval whose request has no id", (f) => (f.snapshot.approvals[0].record.request.id = "")],
      ["an approval whose record is not an object", (f) => (f.snapshot.approvals[0].record = "x")],
      ["an approval whose record has no status", (f) => delete f.snapshot.approvals[0].record.status],
      ["an approval whose request has no revision", (f) => delete f.snapshot.approvals[0].record.request.revision],
      ["an approval whose request's options are not a list", (f) => (f.snapshot.approvals[0].record.request.options = null)],
      ["an approval with no standing", (f) => delete f.snapshot.approvals[0].standing],
      ["an approval whose task id is a number", (f) => (f.snapshot.approvals[0].taskId = 7)],
      ["a note passed on whose name is a number", (f) => (f.snapshot.approvals[0].passedOn.name = 7)],
    ];
    for (const [what, edit] of edits) expect(decodeCached(damaged(edit), NOW), what).toEqual({ kind: "none" });
  });

  it("is usable for 7 days after the read, and too old to show after that", () => {
    const text = encodeSnapshot(snapshot());
    expect(CACHE_MAX_AGE_MS).toBe(7 * DAY);
    expect(decodeCached(text, NOW + CACHE_MAX_AGE_MS - 1).kind).toBe("usable");
    expect(decodeCached(text, NOW + CACHE_MAX_AGE_MS).kind).toBe("usable");
    expect(decodeCached(text, NOW + CACHE_MAX_AGE_MS + 1)).toEqual({ kind: "too_old", at: NOW });
    expect(decodeCached(text, NOW + 30 * DAY)).toEqual({ kind: "too_old", at: NOW });
  });

  it("does not believe a read dated well ahead of the clock, which would never grow old", () => {
    const text = encodeSnapshot(snapshot());
    expect(decodeCached(text, NOW - 60_000).kind).toBe("usable"); // a clock a minute behind is only a clock
    expect(decodeCached(text, NOW - 6 * 60_000)).toEqual({ kind: "none" });
    expect(decodeCached(text, NOW - 30 * DAY)).toEqual({ kind: "none" });
  });
});

describe("the key a read is kept under", () => {
  it("is one name per origin and tenant, and says neither", () => {
    const key = cacheKey(ORIGIN, TENANT);
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(cacheKey(ORIGIN, TENANT)).toBe(key);
    expect(cacheKey(ORIGIN, "apple:owner-2")).not.toBe(key);
    expect(cacheKey("https://staging.manut.xyz", TENANT)).not.toBe(key);
    // the two parts cannot be shifted into one another
    expect(cacheKey("a", "b:c")).not.toBe(cacheKey("a:b", "c"));
  });
});

describe("the saved file", () => {
  const cache = (store = memoryCacheStore(), now = () => NOW) => ({ store, cache: new ShopCache(store, now) });

  it("keeps a read under its key and reads it back", async () => {
    const { store, cache: c } = cache();
    await c.keep(ORIGIN, TENANT, snapshot(), c.ticket());
    expect([...store.files.keys()]).toEqual([cacheKey(ORIGIN, TENANT)]);
    expect(await c.load(ORIGIN, TENANT)).toEqual({ kind: "usable", snapshot: kept(snapshot()) });
  });

  it("never gives one shop's read to another origin or tenant", async () => {
    const { cache: c } = cache();
    await c.keep(ORIGIN, TENANT, snapshot(), c.ticket());
    expect(await c.load(ORIGIN, "apple:owner-2")).toEqual({ kind: "none" });
    expect(await c.load("https://staging.manut.xyz", TENANT)).toEqual({ kind: "none" });
  });

  it("finds nothing when nothing was kept, and ignores a damaged file", async () => {
    const { store, cache: c } = cache();
    expect(await c.load(ORIGIN, TENANT)).toEqual({ kind: "none" });
    store.files.set(cacheKey(ORIGIN, TENANT), '{"v":1,"snapshot":{"tasks":[{"id":3}]}}');
    expect(await c.load(ORIGIN, TENANT)).toEqual({ kind: "none" });
    store.files.set(cacheKey(ORIGIN, TENANT), "\u0000\u0001 not json");
    expect(await c.load(ORIGIN, TENANT)).toEqual({ kind: "none" });
  });

  it("says a read is too old when it is, from the clock it was given", async () => {
    const { store } = cache();
    const young = new ShopCache(store, () => NOW + 2 * DAY);
    await young.keep(ORIGIN, TENANT, snapshot(), young.ticket());
    expect((await young.load(ORIGIN, TENANT)).kind).toBe("usable");
    expect(await new ShopCache(store, () => NOW + 8 * DAY).load(ORIGIN, TENANT)).toEqual({ kind: "too_old", at: NOW });
  });

  it("never raises: a disk that refuses reads as nothing kept, and a write that fails is dropped", async () => {
    const { store, cache: c } = cache();
    store.refuse = true;
    await expect(c.keep(ORIGIN, TENANT, snapshot(), c.ticket())).resolves.toBeUndefined();
    await expect(c.load(ORIGIN, TENANT)).resolves.toEqual({ kind: "none" });
    await expect(c.clear()).resolves.toBeUndefined();
  });

  it("forgets what it kept, and drops a write that was started before the forgetting", async () => {
    const { store, cache: c } = cache();
    await c.keep(ORIGIN, TENANT, snapshot(), c.ticket());
    const before = c.ticket(); // a read starts here: the person signs out while it is on its way
    await c.clear();
    expect(store.files.size).toBe(0);
    await c.keep(ORIGIN, TENANT, snapshot(), before);
    expect(store.files.size).toBe(0);
    // a read that started after the forgetting is kept as usual
    await c.keep(ORIGIN, TENANT, snapshot(), c.ticket());
    expect(store.files.size).toBe(1);
  });

  it("runs one call at a time in the order they were made, so a write already under way cannot outlive a forgetting", async () => {
    const { store, cache: c } = cache();
    let release!: () => void;
    const slow = new Promise<void>((resolve) => (release = resolve));
    let reached!: () => void;
    const started = new Promise<void>((resolve) => (reached = resolve));
    const write = store.write.bind(store);
    store.write = async (key, text) => {
      reached();
      await slow;
      await write(key, text);
    };
    const first = c.keep(ORIGIN, TENANT, snapshot(), c.ticket());
    await started; // the write is on its way to the disk
    const second = c.clear(); // the person signs out now
    await Promise.resolve();
    expect(store.calls).toEqual([]); // the clear waits behind the write instead of running beside it
    release();
    await Promise.all([first, second]);
    expect(store.calls).toEqual(["write", "clear"]);
    expect(store.files.size).toBe(0);
  });

  it("drops a write that was still waiting its turn when the forgetting was asked for", async () => {
    const { store, cache: c } = cache();
    let release!: () => void;
    const slow = new Promise<void>((resolve) => (release = resolve));
    let reached!: () => void;
    const started = new Promise<void>((resolve) => (reached = resolve));
    const read = store.read.bind(store);
    store.read = async (key) => {
      reached();
      await slow;
      return read(key);
    };
    const loading = c.load(ORIGIN, TENANT); // holds the disk
    await started;
    const waiting = c.keep(ORIGIN, TENANT, snapshot(), c.ticket()); // queued behind the read
    const cleared = c.clear();
    release();
    await Promise.all([loading, waiting, cleared]);
    expect(store.calls).toEqual(["read", "clear"]);
    expect(store.files.size).toBe(0);
  });
});
