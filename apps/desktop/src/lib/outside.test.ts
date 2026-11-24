// What the app may show outside its window, as `@manut/notify-rules` decides it and the app words it: which events there
// are, which buttons each gets, quiet hours, hidden details, the order the system gets the buttons in, how a pressed
// button is read, and the number on the Dock icon.
import { notificationFor, KNOWN_KINDS, type NotifyEvent } from "@manut/notify-rules";
import { afterEach, describe, expect, it, vi } from "vitest";
import { dayTime } from "../app/time";
import { DICT, LANGS, setLang, t } from "../i18n";
import {
  DEFAULT_QUIET,
  dockCount,
  eventOf,
  formatQuiet,
  hideDetails,
  outsideSettings,
  parseQuiet,
  presentOutside,
  quietHours,
  quietNow,
  routeAction,
  setHideDetails,
  setQuietHours,
  type Outside,
  type PresentContext,
  type RequestInfo,
} from "./outside";

// 2026-11-24 in Bangkok (UTC+7) at the given local time.
const at = (hhmm: string, day = 24) => Date.parse(`2026-11-${String(day).padStart(2, "0")}T${hhmm}:00+07:00`);
const ctx = (over: Partial<PresentContext> = {}): PresentContext => ({ hideDetails: false, quiet: DEFAULT_QUIET, now: at("12:00"), waiting: 1, ...over });
const ask = (kind: string, over: Partial<RequestInfo> = {}): Outside => ({
  kind: "request",
  approval: kind,
  member: "Nam",
  summary: "Send on LINE: “Thanks, Mali!”",
  canApprove: true,
  ...over,
});
const ids = (s: { actions: readonly { id: string }[] } | null) => (s ? s.actions.map((a) => a.id) : null);

afterEach(() => setLang("en"));

describe("a request waiting for the owner", () => {
  it("names the member and says the exact action, with a sound", () => {
    const s = presentOutside(ask("reply"), ctx());
    expect(s).toMatchObject({ title: "Nam needs you", body: "Send on LINE: “Thanks, Mali!”", sound: true });
  });

  it("offers Approve for a message or a reply only, and never first", () => {
    for (const kind of KNOWN_KINDS) {
      const got = ids(presentOutside(ask(kind), ctx()));
      // macOS folds two buttons into an "Options" menu and reports the first for a click on the menu button itself, so the
      // button that does something is last: a stray click can only look
      expect(got, kind).toEqual(kind === "message" || kind === "reply" ? ["look_first", "approve"] : ["look_first", "later"]);
    }
  });

  it("offers Look first and Later for a kind this build does not know, and for a request with no kind at all", () => {
    expect(ids(presentOutside(ask("wire_transfer"), ctx()))).toEqual(["look_first", "later"]);
    expect(ids(presentOutside(ask(""), ctx()))).toEqual(["look_first", "later"]);
  });

  it("drops Approve when the card itself offers no Allow once (an ask this build cannot answer)", () => {
    expect(ids(presentOutside(ask("reply", { canApprove: false }), ctx()))).toEqual(["look_first"]);
  });

  it("is what notify-rules says, in the app's words: the same in English", () => {
    for (const kind of [...KNOWN_KINDS, "wire_transfer"]) {
      for (const hideDetails of [false, true]) {
        const event: NotifyEvent = { type: "request", kind, member: "Nam", summary: "Send on LINE: “Thanks, Mali!”" };
        const rule = notificationFor(event, { hideDetails, waitingCount: 3 }, at("12:00"));
        const shown = presentOutside(ask(kind), ctx({ hideDetails, waiting: 3 }))!;
        expect({ title: shown.title, body: shown.body, sound: shown.sound }, `${kind} ${hideDetails}`).toEqual({ title: rule.title, body: rule.body, sound: rule.sound });
        // the buttons are notify-rules' own, in the system's order
        expect([...ids(shown)!].sort(), `${kind} ${hideDetails}`).toEqual(rule.buttons.map((b) => b.id).sort());
        expect(shown.actions.map((a) => a.title).sort(), `${kind} ${hideDetails}`).toEqual(rule.buttons.map((b) => b.label).sort());
      }
    }
  });

  it("shows no name, words or count of anything but requests while details are hidden, and never Approve", () => {
    const s = presentOutside(ask("reply", { summary: "Refund ฿1,290 to Mali" }), ctx({ hideDetails: true, waiting: 3 }))!;
    expect(s).toMatchObject({ title: "Manut AI", body: "3 requests need you." });
    expect(JSON.stringify(s)).not.toMatch(/Nam|Mali|1,290/);
    expect(ids(s)).toEqual(["look_first"]);
    expect(presentOutside(ask("money"), ctx({ hideDetails: true, waiting: 1 }))!.body).toBe("1 request needs you.");
  });

  it("falls back to Your team when nobody is named", () => {
    expect(presentOutside(ask("reply", { member: " " }), ctx())!.title).toBe("Your team needs you");
  });

  it("waits in Updates during quiet hours: nothing is shown", () => {
    expect(presentOutside(ask("reply"), ctx({ now: at("23:30") }))).toBeNull();
    expect(presentOutside(ask("reply"), ctx({ now: at("07:59", 25) }))).toBeNull();
    expect(presentOutside(ask("reply"), ctx({ now: at("08:00", 25) }))).not.toBeNull();
  });

  it("follows the quiet hours the owner chose", () => {
    const lunch = { start: "12:00", end: "13:00" };
    expect(presentOutside(ask("reply"), ctx({ quiet: lunch, now: at("12:30") }))).toBeNull();
    expect(presentOutside(ask("reply"), ctx({ quiet: lunch, now: at("23:30") }))).not.toBeNull();
    // the same start and end is no quiet hours at all
    expect(presentOutside(ask("reply"), ctx({ quiet: { start: "09:00", end: "09:00" }, now: at("23:30") }))).not.toBeNull();
  });
});

describe("a plain notice", () => {
  const notice: Outside = { kind: "notice", title: "Buddy", body: "Replied to Mali about the candle set." };
  it("keeps its own title and words, silently, and cannot be approved", () => {
    const s = presentOutside(notice, ctx())!;
    expect(s).toMatchObject({ title: "Buddy", body: "Replied to Mali about the candle set.", sound: false });
    expect(ids(s)).toEqual(["look_first", "later"]);
  });
  it("says nothing of what happened while details are hidden", () => {
    const s = presentOutside(notice, ctx({ hideDetails: true }))!;
    expect(s).toMatchObject({ title: "Manut AI", body: "Something happened." });
    expect(JSON.stringify(s)).not.toMatch(/Buddy|Mali|candle/);
  });
  it("waits in Updates during quiet hours", () => {
    expect(presentOutside(notice, ctx({ now: at("23:30") }))).toBeNull();
  });
  it("is what notify-rules says, in the same words in English", () => {
    for (const hideDetails of [false, true]) {
      const rule = notificationFor({ type: "notice", title: "Buddy", body: "Replied to Mali about the candle set." }, { hideDetails }, at("12:00"));
      const s = presentOutside(notice, ctx({ hideDetails }))!;
      expect({ title: s.title, body: s.body, sound: s.sound }).toEqual({ title: rule.title, body: rule.body, sound: rule.sound });
    }
  });
});

describe("the two alerts quiet hours never silence", () => {
  // A live page that stopped working has no source in the app yet: only its mapping is here. A sign-in to the person's own
  // account has none either; a helper's new device has one, below.
  const down: Outside = { kind: "page_down", page: "baanmali.shop" };
  const device: Outside = { kind: "new_device", device: "Chrome on Windows" };

  it("a stopped page names the page and rings", () => {
    expect(presentOutside(down, ctx())).toMatchObject({ title: "A live page stopped working", body: "baanmali.shop is not working.", sound: true });
    expect(presentOutside({ kind: "page_down" }, ctx())!.body).toBe("One of your live pages is not working.");
  });
  it("a new sign-in names the device and rings", () => {
    expect(presentOutside(device, ctx())).toMatchObject({ title: "New sign-in", body: "Someone signed in from Chrome on Windows. Was it you?", sound: true });
    expect(presentOutside({ kind: "new_device" }, ctx())!.body).toBe("Someone signed in from a new device. Was it you?");
  });
  it("both ring through quiet hours, with Look first and Later", () => {
    for (const src of [down, device]) {
      const s = presentOutside(src, ctx({ now: at("03:00") }))!;
      expect(s.sound).toBe(true);
      expect(ids(s)).toEqual(["look_first", "later"]);
    }
  });
  it("neither names the page or the device while details are hidden", () => {
    for (const src of [down, device]) {
      const s = presentOutside(src, ctx({ hideDetails: true }))!;
      expect(s).toMatchObject({ title: "Manut AI", body: "Something needs you." });
      expect(JSON.stringify(s)).not.toMatch(/baanmali|Chrome/);
    }
  });
  it("say what notify-rules says, in English", () => {
    for (const src of [down, device]) {
      for (const hideDetails of [false, true]) {
        const rule = notificationFor(eventOf(src)!, { hideDetails }, at("12:00"));
        const s = presentOutside(src, ctx({ hideDetails }))!;
        expect({ title: s.title, body: s.body, sound: s.sound }, `${src.kind} ${hideDetails}`).toEqual({ title: rule.title, body: rule.body, sound: rule.sound });
      }
    }
  });
});

describe("a helper's new device, as the owner is told", () => {
  // The canvas's board "States: people and roles": "Mint signed in on a new device. ... If this was not Mint, remove access."
  type Helper = NonNullable<Extract<Outside, { kind: "new_device" }>["helper"]>;
  const signedIn = (over: Partial<Helper> = {}): Outside => ({ kind: "new_device", helper: { name: "Mint", shop: "Baan Mali", at: at("21:05"), ...over } });
  const day = (hhmm: string, now: string, nowDay = 24) => dayTime(at(hhmm), at(now, nowDay));

  it("names the helper and the shop, says when, and rings", () => {
    expect(presentOutside(signedIn(), ctx({ now: at("21:06") }))).toMatchObject({
      title: "Mint signed in on a new device",
      body: `Baan Mali, ${day("21:05", "21:06")}. If this was not Mint, remove access.`,
      sound: true,
    });
  });

  it("says the day first when the sign-in was not today, so one from yesterday is never taken for one from this morning", () => {
    const body = presentOutside(signedIn(), ctx({ now: at("08:10", 25) }))!.body;
    expect(body).toBe(`Baan Mali, ${day("21:05", "08:10", 25)}. If this was not Mint, remove access.`);
    expect(body).toContain("Nov 24");
  });

  it("rings through quiet hours with Look first and Later, whatever the hour", () => {
    for (const now of [at("03:00"), at("22:30"), at("12:00")]) {
      const s = presentOutside(signedIn(), ctx({ now }))!;
      expect(s.sound).toBe(true);
      expect(ids(s)).toEqual(["look_first", "later"]);
    }
  });

  it("names neither the helper nor the shop while details are hidden", () => {
    const s = presentOutside(signedIn(), ctx({ hideDetails: true }))!;
    expect(s).toMatchObject({ title: "Manut AI", body: "Something needs you.", sound: true });
    expect(JSON.stringify(s)).not.toMatch(/Mint|Baan Mali/);
  });

  it("is what notify-rules rules on a new sign-in: shown, with a sound, Look first and Later, nothing named when hidden", () => {
    for (const hideDetails of [false, true]) {
      for (const now of [at("03:00"), at("12:00")]) {
        const rule = notificationFor({ type: "new_device" }, { hideDetails }, now);
        const s = presentOutside(signedIn(), ctx({ hideDetails, now }))!;
        expect({ sound: s.sound, ids: ids(s) }, `${hideDetails} ${now}`).toEqual({ sound: rule.sound, ids: rule.buttons.map((b) => b.id) });
        if (hideDetails) expect({ title: s.title, body: s.body }).toEqual({ title: rule.title, body: rule.body });
      }
    }
  });

  it("says Helper and a shop for a name that is blank, and the hour of the alert for a time it cannot read", () => {
    const s = presentOutside(signedIn({ name: "  ", shop: "", at: Number.NaN }), ctx({ now: at("21:06") }))!;
    expect(s.title).toBe("Helper signed in on a new device");
    expect(s.body).toBe(`a shop, ${day("21:06", "21:06")}. If this was not Helper, remove access.`);
    expect(presentOutside(signedIn({ name: "  Mint  ", shop: " Baan Mali " }), ctx())!.title).toBe("Mint signed in on a new device");
  });

  it("is worded in every language the app speaks, with the names and the time in place and no slot left open", () => {
    for (const l of LANGS) {
      setLang(l);
      const s = presentOutside(signedIn(), ctx({ now: at("21:06") }))!;
      expect(s.title, l).toBe(t("out.helperDeviceTitle", { helper: "Mint" }));
      expect(s.title, l).toContain("Mint");
      expect(s.body, l).toContain("Baan Mali");
      expect(s.body, l).toContain("Mint");
      expect(s.body, l).toContain(day("21:05", "21:06"));
      expect(`${s.title} ${s.body}`, l).not.toMatch(/\{\w+\}/);
      // the same buttons, in the app's words
      expect(s.actions.map((a) => a.title), l).toEqual([DICT[l]["out.look"], DICT[l]["out.later"]]);
    }
  });

  it("leaves a sign-in to the person's own account as it was", () => {
    expect(presentOutside({ kind: "new_device", device: "Chrome on Windows" }, ctx())).toMatchObject({ title: "New sign-in", body: "Someone signed in from Chrome on Windows. Was it you?" });
    expect(presentOutside({ kind: "new_device" }, ctx())!.body).toBe("Someone signed in from a new device. Was it you?");
  });
});

describe("a job that waited while the Mac slept", () => {
  const woke = (count: number, wokeAt = at("09:00")): Outside => ({ kind: "slept", count, wokeAt });
  it("is shown after waking, silently, and says how many waited", () => {
    expect(presentOutside(woke(2), ctx())).toMatchObject({ title: "While your Mac slept", body: "2 jobs waited for you.", sound: false });
    expect(presentOutside(woke(1), ctx())!.body).toBe("1 job waited for you.");
    expect(ids(presentOutside(woke(1), ctx()))).toEqual(["look_first", "later"]);
  });
  it("is not shown when nothing waited", () => {
    expect(presentOutside(woke(0), ctx())).toBeNull();
  });
  it("is shown once per wake", () => {
    expect(presentOutside(woke(2), ctx({ lastWaitedShownAt: at("09:00") }))).toBeNull();
    expect(presentOutside(woke(2), ctx({ lastWaitedShownAt: at("08:00") }))).not.toBeNull();
  });
  it("counts the requests while details are hidden, as notify-rules does", () => {
    for (const hideDetails of [false, true]) {
      const rule = notificationFor({ type: "waited_while_asleep", count: 3, wokeAt: at("09:00") }, { hideDetails }, at("09:00"));
      const s = presentOutside(woke(3), ctx({ hideDetails }))!;
      expect({ title: s.title, body: s.body, sound: s.sound }).toEqual({ title: rule.title, body: rule.body, sound: rule.sound });
    }
  });
});

describe("what is shown is never an unreadable event", () => {
  it("refuses what notify-rules refuses, without throwing", () => {
    expect(presentOutside({ kind: "slept", count: 1.5, wokeAt: 1 }, ctx())).toBeNull();
    expect(presentOutside({ kind: "notice", title: 5, body: "x" } as never, ctx())).toBeNull();
    expect(presentOutside({ kind: "bogus" } as never, ctx())).toBeNull();
  });
});

describe("the buttons' words", () => {
  it("are the app's, in every language the app speaks", () => {
    for (const l of LANGS) {
      setLang(l);
      const s = presentOutside(ask("reply"), ctx())!;
      expect(s.actions.map((a) => a.title)).toEqual([DICT[l]["out.look"], DICT[l]["out.approve"]]);
      expect(new Set(s.actions.map((a) => a.title)).size).toBe(s.actions.length);
    }
    setLang("ko");
    expect(presentOutside(ask("reply"), ctx())!.title).toBe(t("out.needsYou", { member: "Nam" }));
  });
});

describe("the buttons' titles, which macOS builds its Options menu from", () => {
  it("never hold a comma: the menu is made from one comma-joined list, so a comma would split a button in two", () => {
    for (const l of LANGS) {
      setLang(l);
      for (const src of [ask("reply"), ask("money"), { kind: "notice", title: "x", body: "y" } as Outside]) {
        for (const a of presentOutside(src, ctx())!.actions) expect(a.title, `${l} ${a.id}`).not.toMatch(/[,，、]/);
      }
    }
  });
});

describe("reading a pressed button", () => {
  const withApprove = presentOutside(ask("reply"), ctx())!;
  const withoutApprove = presentOutside(ask("money"), ctx())!;

  it("reads a button by its id, and a click on the notification itself as Look first", () => {
    expect(routeAction("approve", withApprove)).toBe("approve");
    expect(routeAction("look_first", withApprove)).toBe("look");
    expect(routeAction("later", withoutApprove)).toBe("later");
    expect(routeAction("tap", withApprove)).toBe("look");
    expect(routeAction("tap", withoutApprove)).toBe("look");
  });

  it("reads a button by its title too, since the system tells actions apart by title", () => {
    expect(routeAction("Approve", withApprove)).toBe("approve");
    expect(routeAction("Look first", withApprove)).toBe("look");
    setLang("ko");
    const ko = presentOutside(ask("reply"), ctx())!;
    expect(routeAction(DICT.ko["out.approve"], ko)).toBe("approve");
  });

  it("never reads Approve for a notification that did not offer it", () => {
    // money, a post, an unknown kind, hidden details, an ask the card cannot answer
    expect(routeAction("approve", withoutApprove)).toBeNull();
    expect(routeAction("Approve", withoutApprove)).toBeNull();
    expect(routeAction("approve", presentOutside(ask("reply"), ctx({ hideDetails: true }))!)).toBeNull();
    expect(routeAction("approve", presentOutside(ask("reply", { canApprove: false }), ctx())!)).toBeNull();
    expect(routeAction("approve", presentOutside({ kind: "notice", title: "x", body: "y" }, ctx())!)).toBeNull();
  });

  it("ignores anything else the system might report", () => {
    for (const other of ["", "Options", "__closed", "dismiss", "default"]) expect(routeAction(other, withApprove), other).toBeNull();
  });
});

describe("quiet hours as the owner writes them", () => {
  it("reads HH:MM-HH:MM and falls back to the canvas's 22:00 to 08:00", () => {
    expect(DEFAULT_QUIET).toEqual({ start: "22:00", end: "08:00" });
    expect(parseQuiet("23:30-07:15")).toEqual({ start: "23:30", end: "07:15" });
    for (const bad of [null, "", "late", "25:00-08:00", "22:00-8:00", "22:00", "22:00-08:00-09:00"]) expect(parseQuiet(bad), String(bad)).toEqual(DEFAULT_QUIET);
  });
  it("writes what it reads", () => {
    expect(formatQuiet({ start: "21:00", end: "06:30" })).toBe("21:00-06:30");
    expect(parseQuiet(formatQuiet({ start: "21:00", end: "06:30" }))).toEqual({ start: "21:00", end: "06:30" });
  });
});

describe("the two settings, kept on this computer", () => {
  const fake = (seed: Record<string, string> = {}) => {
    const data = { ...seed };
    return { data, getItem: (k: string) => (k in data ? data[k] : null), setItem: (k: string, v: string) => void (data[k] = v) };
  };
  afterEach(() => vi.unstubAllGlobals());

  it("hide details is off until the owner turns it on, and quiet hours are the canvas's until they change them", () => {
    vi.stubGlobal("localStorage", fake());
    expect(hideDetails()).toBe(false);
    expect(quietHours()).toEqual({ start: "22:00", end: "08:00" });
    expect(outsideSettings()).toEqual({ hideDetails: false, quiet: { start: "22:00", end: "08:00" } });
  });

  it("keeps what the owner chose", () => {
    const store = fake();
    vi.stubGlobal("localStorage", store);
    setHideDetails(true);
    setQuietHours({ start: "21:30", end: "07:00" });
    expect(store.data).toEqual({ "manut.notify.hide": "on", "manut.notify.quiet": "21:30-07:00" });
    expect(hideDetails()).toBe(true);
    expect(quietHours()).toEqual({ start: "21:30", end: "07:00" });
    setHideDetails(false);
    expect(hideDetails()).toBe(false);
  });

  it("reads a damaged saved value as the default, and a storage that throws as the default", () => {
    vi.stubGlobal("localStorage", fake({ "manut.notify.quiet": "soon", "manut.notify.hide": "maybe" }));
    expect(quietHours()).toEqual(DEFAULT_QUIET);
    expect(hideDetails()).toBe(false);
    const broken = {
      getItem: () => {
        throw new Error("no storage");
      },
      setItem: () => {
        throw new Error("no storage");
      },
    };
    vi.stubGlobal("localStorage", broken);
    expect(hideDetails()).toBe(false);
    expect(quietHours()).toEqual(DEFAULT_QUIET);
    expect(() => setHideDetails(true)).not.toThrow();
    expect(() => setQuietHours({ start: "01:00", end: "02:00" })).not.toThrow();
  });

  it("has no storage in a plain run: the defaults", () => {
    expect(hideDetails()).toBe(false);
    expect(quietHours()).toEqual(DEFAULT_QUIET);
  });
});

describe("the number on the Dock icon", () => {
  it("is the number of requests waiting, and nothing else", () => {
    expect(dockCount([])).toBe(0);
    expect(dockCount([{ id: "a" }, { id: "b" }, { id: "c" }])).toBe(3);
    expect(dockCount(null)).toBe(0);
    expect(dockCount(undefined)).toBe(0);
  });
  it("stops at 99, as the Dock cuts longer labels", () => {
    expect(dockCount(new Array(150).fill({}))).toBe(99);
  });
});

describe("whether it is quiet now", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("follows the quiet hours the owner chose, in Bangkok time", () => {
    vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {} });
    expect(quietNow(at("23:30"))).toBe(true);
    expect(quietNow(at("12:00"))).toBe(false);
    vi.stubGlobal("localStorage", { getItem: (k: string) => (k === "manut.notify.quiet" ? "11:00-13:00" : null), setItem: () => {} });
    expect(quietNow(at("12:00"))).toBe(true);
    expect(quietNow(at("23:30"))).toBe(false);
    vi.stubGlobal("localStorage", { getItem: (k: string) => (k === "manut.notify.quiet" ? "00:00-00:00" : null), setItem: () => {} });
    expect(quietNow(at("03:00"))).toBe(false);
  });
});
