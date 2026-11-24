// How a notification reaches the system: every one goes through notify-rules first (quiet hours, hidden details, its
// buttons), the plugin's listener exists before the first one is shown (without one macOS shows no buttons), the buttons
// are registered with Approve last, and a pressed button is read against what that notification offered.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLang } from "../i18n";
import type { Note } from "./notify";

const h = vi.hoisted(() => ({
  sent: [] as Record<string, unknown>[],
  types: [] as { id: string; actions: { id: string; title: string }[] }[],
  order: [] as string[],
  listener: null as null | ((e: unknown) => unknown),
  listenFails: false,
  front: [] as string[],
}));
vi.mock("@tauri-apps/plugin-notification", () => ({
  isPermissionGranted: async () => true,
  requestPermission: async () => "granted",
  registerActionTypes: async (types: { id: string; actions: { id: string; title: string }[] }[]) => {
    h.order.push("register");
    h.types.push(...types);
  },
  onAction: async (cb: (e: unknown) => unknown) => {
    h.order.push("listen");
    if (h.listenFails) throw new Error("the plugin cannot listen");
    h.listener = cb;
    return { unregister: async () => {} };
  },
  sendNotification: (options: Record<string, unknown>) => {
    h.order.push("send");
    h.sent.push(options);
  },
}));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    unminimize: async () => void h.front.push("unminimize"),
    show: async () => void h.front.push("show"),
    setFocus: async () => void h.front.push("focus"),
  }),
}));

// 2026-11-24 in Bangkok (UTC+7)
const at = (hhmm: string) => new Date(`2026-11-24T${hhmm}:00+07:00`);
const fakeStorage = (seed: Record<string, string> = {}) => {
  const data = { ...seed };
  return { getItem: (k: string) => (k in data ? data[k] : null), setItem: (k: string, v: string) => void (data[k] = v) };
};

/** A fresh copy of the module for each test: its listener, registrations and record of what it showed are per page. */
async function load() {
  vi.resetModules();
  return import("./notify");
}

const ask = (kind: string, over: Partial<NonNullable<Note["ask"]>> = {}, id = "req-5@1"): Note => ({
  title: "Buddy needs your approval",
  body: "Send on LINE: “Thanks, Mali!”",
  bot: "buddy",
  tag: "buddy:approval",
  ask: { id, approval: kind, member: "Nam", canApprove: true, action: "Send on LINE: “Thanks, Mali!”", waiting: 1, ...over },
});
const news: Note = { title: "Buddy", body: "Replied to Mali.", bot: "buddy", tag: "buddy:message" };
const performed = (actionId: string, id: unknown) => h.listener!({ actionId, inputValue: null, notification: { id } });
const lastId = () => h.sent[h.sent.length - 1].id;

beforeEach(() => {
  h.sent.length = 0;
  h.types.length = 0;
  h.order.length = 0;
  h.front.length = 0;
  h.listener = null;
  h.listenFails = false;
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(at("12:00"));
  vi.stubGlobal("window", { __TAURI_INTERNALS__: {}, addEventListener: () => {} });
  vi.stubGlobal("navigator", { platform: "MacIntel" });
  vi.stubGlobal("localStorage", fakeStorage());
  setLang("en");
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  setLang("en");
});

describe("what goes to the system", () => {
  it("is a request as notify-rules says it: the member, the exact action, a sound, and Look first before Approve", async () => {
    const { showNote } = await load();
    await showNote(ask("reply"));
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]).toMatchObject({ title: "Nam needs you", body: "Send on LINE: “Thanks, Mali!”", sound: "Ping", actionTypeId: "manut:look_first+approve" });
    expect(h.types).toEqual([
      { id: "manut:look_first+approve", actions: [{ id: "look_first", title: "Look first" }, { id: "approve", title: "Approve" }] },
    ]);
  });

  it("lets the plugin listen before it shows anything: macOS shows no buttons to a notification nobody listens to", async () => {
    const { showNote } = await load();
    await showNote(ask("reply"));
    expect(h.order).toEqual(["listen", "register", "send"]);
    await showNote(ask("reply", {}, "req-6@1"));
    // listening and registering happen once; the words are registered again only if they change
    expect(h.order).toEqual(["listen", "register", "send", "send"]);
  });

  it("registers the buttons again when the app's language changes, and says them in it", async () => {
    const { showNote } = await load();
    // the page's language is the one the freshly loaded module reads, not the copy this file imported
    const { setLang: say } = await import("../i18n");
    await showNote(ask("reply"));
    say("ko");
    await showNote(ask("reply", {}, "req-6@1"));
    expect(h.types[1].actions).toEqual([{ id: "look_first", title: "먼저 보기" }, { id: "approve", title: "승인" }]);
    expect(h.sent[1].title).toBe("Nam: 확인이 필요해요");
  });

  it("gives money, a public post, a payment and a command Look first and Later, and never Approve", async () => {
    const { showNote } = await load();
    let n = 0;
    for (const kind of ["money", "public_post", "payment_confirmation", "command", "wire_transfer", ""]) await showNote(ask(kind, {}, `r-${(n += 1)}@1`));
    expect(h.sent.map((s) => s.actionTypeId)).toEqual(new Array(6).fill("manut:look_first+later"));
    expect(h.types.every((t) => t.id === "manut:look_first+later" && t.actions.every((a) => a.id !== "approve"))).toBe(true);
  });

  it("drops Approve for an ask the card itself offers no Allow once for", async () => {
    const { showNote } = await load();
    await showNote(ask("reply", { canApprove: false }));
    expect(h.sent[0].actionTypeId).toBe("manut:look_first");
  });

  it("makes no sound for news, and gives it Look first and Later", async () => {
    const { showNote } = await load();
    await showNote(news);
    expect(h.sent[0]).toMatchObject({ title: "Buddy", body: "Replied to Mali.", actionTypeId: "manut:look_first+later" });
    expect(h.sent[0]).not.toHaveProperty("sound");
  });

  it("shows nothing in quiet hours, and registers nothing: requests wait in the app", async () => {
    vi.setSystemTime(at("23:30"));
    const { showNote } = await load();
    await showNote(ask("reply"));
    await showNote(news);
    expect(h.sent).toEqual([]);
    expect(h.order).toEqual([]);
  });

  it("follows the owner's quiet hours, and is silent about nothing else", async () => {
    vi.stubGlobal("localStorage", fakeStorage({ "manut.notify.quiet": "11:00-13:00" }));
    const { showNote } = await load();
    await showNote(news);
    expect(h.sent).toEqual([]);
    vi.setSystemTime(at("23:30"));
    await showNote(news);
    expect(h.sent).toHaveLength(1);
  });

  it("hides names, words and customers with Hide details, says how many requests wait, and offers no Approve", async () => {
    vi.stubGlobal("localStorage", fakeStorage({ "manut.notify.hide": "on" }));
    const { showNote } = await load();
    await showNote(ask("reply", { waiting: 3 }));
    await showNote(news);
    expect(h.sent[0]).toMatchObject({ title: "Manut AI", body: "3 requests need you.", actionTypeId: "manut:look_first" });
    expect(h.sent[1]).toMatchObject({ title: "Manut AI", body: "Something happened." });
    expect(JSON.stringify(h.sent)).not.toMatch(/Nam|Mali|Buddy/);
  });

  it("shows the same ask once, so a replay of the shop does not ring again", async () => {
    const { showNote } = await load();
    await showNote(ask("reply"));
    await showNote(ask("reply"));
    expect(h.sent).toHaveLength(1);
    // a revised request is a new ask
    await showNote(ask("reply", {}, "req-5@2"));
    expect(h.sent).toHaveLength(2);
  });

  it("shows a request that waited in quiet hours never, not even when they end", async () => {
    vi.setSystemTime(at("23:30"));
    const { showNote } = await load();
    await showNote(ask("reply"));
    vi.setSystemTime(at("08:30"));
    await showNote(ask("reply"));
    expect(h.sent).toEqual([]);
  });

  it("returns whether it was shown", async () => {
    const { showNote } = await load();
    expect(await showNote(news)).toBe(true);
    vi.setSystemTime(at("23:30"));
    expect(await showNote({ ...news, tag: "other" })).toBe(false);
  });

  it("still shows the notification, without buttons, when the plugin cannot listen", async () => {
    h.listenFails = true;
    const { showNote } = await load();
    await showNote(ask("reply"));
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]).not.toHaveProperty("actionTypeId");
    expect(h.types).toEqual([]);
  });
});

describe("a pressed button", () => {
  it("Look first brings the app forward and opens that request; a click on the notification itself does the same", async () => {
    const { showNote } = await load();
    const open = vi.fn();
    await showNote(ask("reply"), open);
    await performed("look_first", lastId());
    expect(open).toHaveBeenCalledTimes(1);
    expect(h.front).toEqual(["unminimize", "show", "focus"]);
    await performed("tap", lastId());
    expect(open).toHaveBeenCalledTimes(2);
  });

  it("Approve answers through the card's own path, once, and only when the notification offered it", async () => {
    const { showNote } = await load();
    const approve = vi.fn(async () => {});
    await showNote(ask("reply"), undefined, false, approve);
    await performed("approve", lastId());
    expect(approve).toHaveBeenCalledTimes(1);
    // a second press of the same notification answers nothing more
    await performed("approve", lastId());
    expect(approve).toHaveBeenCalledTimes(1);
  });

  it("reads the button by its title too, as the plugin warns it tells actions apart by title", async () => {
    const { showNote } = await load();
    const approve = vi.fn(async () => {});
    await showNote(ask("reply"), undefined, false, approve);
    await performed("Approve", lastId());
    expect(approve).toHaveBeenCalledTimes(1);
  });

  it("never approves what the notification did not offer: money, details hidden, an ask the card cannot answer", async () => {
    const approve = vi.fn(async () => {});
    for (const [seed, note] of [
      [{}, ask("money")],
      [{}, ask("public_post")],
      [{}, ask("wire_transfer")],
      [{}, ask("reply", { canApprove: false })],
      [{ "manut.notify.hide": "on" }, ask("reply")],
    ] as const) {
      vi.stubGlobal("localStorage", fakeStorage(seed));
      const { showNote } = await load();
      await showNote(note, undefined, false, approve);
      await performed("approve", lastId());
      await performed("Approve", lastId());
    }
    expect(approve).not.toHaveBeenCalled();
  });

  it("Later and anything else only dismisses", async () => {
    const { showNote } = await load();
    const open = vi.fn();
    const approve = vi.fn(async () => {});
    await showNote(ask("money"), open, false, approve);
    for (const other of ["later", "Later", "Options", "__closed", "dismiss", ""]) await performed(other, lastId());
    expect(open).not.toHaveBeenCalled();
    expect(approve).not.toHaveBeenCalled();
    expect(h.front).toEqual([]);
  });

  it("Later also forgets the chat the note would have opened when the app next gets focus", async () => {
    const focus: (() => void)[] = [];
    vi.stubGlobal("window", { __TAURI_INTERNALS__: {}, addEventListener: (_: string, fn: () => void) => void focus.push(fn) });
    const { showNote } = await load();
    const open = vi.fn();
    await showNote(news, open, true);
    await performed("later", lastId());
    for (const f of focus) f();
    expect(open).not.toHaveBeenCalled();
    // with no Later, the next focus opens it, as it always did
    await showNote({ ...news, tag: "buddy:again" }, open, true);
    for (const f of focus) f();
    expect(open).toHaveBeenCalledTimes(1);
  });

  it("ignores a button of a notification it never showed, and one with no notification", async () => {
    const { showNote } = await load();
    const approve = vi.fn(async () => {});
    await showNote(ask("reply"), undefined, false, approve);
    await performed("approve", 99);
    await performed("approve", undefined);
    await h.listener!({ actionId: "approve" });
    await h.listener!(null);
    expect(approve).not.toHaveBeenCalled();
  });

  it("never throws into the plugin, whatever the handlers do", async () => {
    const { showNote } = await load();
    await showNote(ask("reply"), () => {
      throw new Error("a handler broke");
    }, false, async () => {
      throw new Error("an answer broke");
    });
    await expect(performed("look_first", lastId())).resolves.toBeUndefined();
    await expect(performed("approve", lastId())).resolves.toBeUndefined();
  });
});

describe("a job that waited while the Mac slept", () => {
  it("is shown once after waking, only if something waited, and silently", async () => {
    const { showWoke } = await load();
    const woke = at("09:00").getTime();
    expect(await showWoke(0, woke)).toBe(false);
    expect(h.sent).toEqual([]);
    expect(await showWoke(2, woke)).toBe(true);
    expect(h.sent[0]).toMatchObject({ title: "While your Mac slept", body: "2 jobs waited for you.", actionTypeId: "manut:look_first+later" });
    expect(h.sent[0]).not.toHaveProperty("sound");
    // the same wake again says nothing; a later one does
    expect(await showWoke(2, woke)).toBe(false);
    expect(await showWoke(1, woke + 3_600_000)).toBe(true);
    expect(h.sent).toHaveLength(2);
  });

  it("waits in the app during quiet hours", async () => {
    vi.setSystemTime(at("23:30"));
    const { showWoke } = await load();
    expect(await showWoke(1, at("23:30").getTime())).toBe(false);
    expect(h.sent).toEqual([]);
  });
});

describe("the two alerts quiet hours never silence", () => {
  // A helper's new device has its own source (notify.device.test.ts); a live page that stops has none yet.
  it("ring through quiet hours, with Look first and Later", async () => {
    vi.setSystemTime(at("03:00"));
    const { showOutside } = await load();
    await showOutside({ kind: "page_down", page: "baanmali.shop" });
    await showOutside({ kind: "new_device", device: "Chrome on Windows" });
    expect(h.sent.map((s) => [s.title, s.sound, s.actionTypeId])).toEqual([
      ["A live page stopped working", "Ping", "manut:look_first+later"],
      ["New sign-in", "Ping", "manut:look_first+later"],
    ]);
  });
});

describe("in a plain browser (the demo, the Playwright suite)", () => {
  class FakeNotification {
    static permission = "granted";
    static requestPermission = async () => "granted";
    static made: { title: string; options: { body?: string; tag?: string } }[] = [];
    onclick: null | (() => void) = null;
    constructor(title: string, options: { body?: string; tag?: string } = {}) {
      FakeNotification.made.push({ title, options });
    }
    close() {}
  }
  beforeEach(() => {
    FakeNotification.made = [];
    vi.stubGlobal("window", { focus: () => {}, addEventListener: () => {} });
    vi.stubGlobal("Notification", FakeNotification);
  });

  it("shows the web notification as before, after notify-rules has ruled on it", async () => {
    const { showNote } = await load();
    await showNote(news);
    expect(FakeNotification.made).toEqual([{ title: "Buddy", options: { body: "Replied to Mali.", tag: "buddy:message" } }]);
    expect(h.sent).toEqual([]);
  });

  it("holds quiet hours and hidden details there too", async () => {
    vi.setSystemTime(at("23:30"));
    const { showNote } = await load();
    await showNote(news);
    expect(FakeNotification.made).toEqual([]);
    vi.setSystemTime(at("12:00"));
    vi.stubGlobal("localStorage", fakeStorage({ "manut.notify.hide": "on" }));
    const again = await load();
    await again.showNote(news);
    expect(FakeNotification.made).toEqual([{ title: "Manut AI", options: { body: "Something happened.", tag: "buddy:message" } }]);
  });
});
