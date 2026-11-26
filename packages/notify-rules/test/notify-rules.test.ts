import { describe, expect, it } from "vitest";
import {
  KNOWN_KINDS,
  WHOLE_COLUMNS,
  badgeCount,
  canApproveFromNotification,
  columns,
  inQuietHours,
  notificationFor,
  shownWhole,
  type NotifyEvent,
} from "../src/index";

// 2026-11-23 in Bangkok (UTC+7) at the given local time.
const at = (hhmm: string, day = 23) => Date.parse(`2026-11-${String(day).padStart(2, "0")}T${hhmm}:00+07:00`);
/** A request whose body is its exact action, unchanged, as a card shows it. */
const req = (kind: string, summary = "Reply to Mali about the candle set"): NotifyEvent => ({ type: "request", kind, member: "Nam", summary, action: summary });
const ids = (n: { buttons: readonly { id: string }[] }) => n.buttons.map((b) => b.id);

describe("request events", () => {
  it("names the member and says the summary", () => {
    const n = notificationFor(req("reply"), {}, at("12:00"));
    expect(n).toMatchObject({ show: true, sound: true, title: "Nam needs you", body: "Reply to Mali about the candle set", reason: "shown" });
  });
  it("lets only message and reply be approved from the notification", () => {
    for (const kind of KNOWN_KINDS) {
      const n = notificationFor(req(kind), {}, at("12:00"));
      if (kind === "message" || kind === "reply") expect(ids(n)).toEqual(["approve", "look_first"]);
      else expect(ids(n)).toEqual(["look_first", "later"]);
      expect(canApproveFromNotification(kind)).toBe(kind === "message" || kind === "reply");
    }
  });
  it("never offers Approve for a kind it does not know", () => {
    const n = notificationFor(req("wire_transfer"), {}, at("12:00"));
    expect(ids(n)).toEqual(["look_first", "later"]);
    expect(canApproveFromNotification("wire_transfer")).toBe(false);
    expect(canApproveFromNotification(undefined)).toBe(false);
  });
  it("falls back when the member is blank", () => {
    expect(notificationFor({ ...(req("reply") as object), member: " " } as NotifyEvent, {}, at("12:00")).title).toBe("Your team needs you");
  });
  it("refuses an unreadable event without throwing", () => {
    expect(notificationFor(null as never, {}, 0).reason).toBe("unreadable");
    expect(notificationFor({ type: "bogus" } as never, {}, 0).show).toBe(false);
    expect(notificationFor({ type: "request", kind: 5 } as never, {}, 0).reason).toBe("unreadable");
  });
});

// An owner must not approve what they cannot read, so Approve needs the request's whole exact action in the body. A body
// cut to fit, or changed on the way (a link shortened to its host, marks dropped), is a hidden detail: Look first only.
describe("a body shown whole", () => {
  const reply = (summary: string, action: string | undefined): NotifyEvent => ({ type: "request", kind: "reply", member: "Nam", summary, ...(action === undefined ? {} : { action }) });

  it("offers Approve only when the body is the exact action, unchanged", () => {
    const words = "Send on LINE: “Your order ships tomorrow.”";
    expect(ids(notificationFor(reply(words, words), {}, at("12:00")))).toEqual(["approve", "look_first"]);
    // no exact action to compare: nothing says the body is all of it
    expect(ids(notificationFor(reply(words, undefined), {}, at("12:00")))).toEqual(["look_first"]);
    // cut to fit, or changed on the way
    expect(ids(notificationFor(reply("Send on LINE: “Your order ships…", words), {}, at("12:00")))).toEqual(["look_first"]);
    expect(ids(notificationFor(reply("Send on LINE: “See baanmali.shop”", "Send on LINE: “See https://baanmali.shop/track?o=7”"), {}, at("12:00")))).toEqual(["look_first"]);
    // the body still says what it says; only the button goes
    expect(notificationFor(reply("Send on LINE: “Your order ships…", words), {}, at("12:00")).body).toBe("Send on LINE: “Your order ships…");
  });

  it("offers Approve only for an action short enough for the system to show whole, on one line", () => {
    const fits = "a".repeat(WHOLE_COLUMNS);
    const over = "a".repeat(WHOLE_COLUMNS + 1);
    expect(ids(notificationFor(reply(fits, fits), {}, at("12:00")))).toEqual(["approve", "look_first"]);
    expect(ids(notificationFor(reply(over, over), {}, at("12:00")))).toEqual(["look_first"]);
    for (const broken of ["Hi\nthere", "Hi\tthere", "Hi\u2028there", "Hi\rthere"]) {
      expect(ids(notificationFor(reply(broken, broken), {}, at("12:00"))), JSON.stringify(broken)).toEqual(["look_first"]);
    }
    expect(ids(notificationFor(reply(" ", " "), {}, at("12:00")))).toEqual(["look_first"]);
  });

  it("counts a wide letter as two columns and a mark on a letter as none", () => {
    expect(columns("abc")).toBe(3);
    // Chinese, Japanese and Korean letters, full-width forms and emoji take two
    expect(columns("出荷")).toBe(4);
    expect(columns("ひらカタ")).toBe(8);
    expect(columns("배송")).toBe(4);
    expect(columns("ＡＢ")).toBe(4);
    expect(columns("🔑")).toBe(2);
    // Thai vowels above and below and tone marks sit on their letter: "ที่" is one column
    expect(columns("ที่")).toBe(1);
    expect(columns("ขอบคุณค่ะ")).toBe(7);
    const han = "出".repeat(WHOLE_COLUMNS / 2);
    expect(shownWhole(han)).toBe(true);
    expect(shownWhole(`${han}出`)).toBe(false);
    expect(shownWhole("ขอบคุณค่ะ".repeat(10))).toBe(true);
  });

  it("never offers Approve for money, even shown whole", () => {
    const words = "Refund ฿120 for order RP-118";
    expect(ids(notificationFor({ type: "request", kind: "money", member: "Ton", summary: words, action: words }, {}, at("12:00")))).toEqual(["look_first", "later"]);
  });

  it("is not fooled by something that is not text", () => {
    expect(shownWhole(5 as never)).toBe(false);
    expect(shownWhole(undefined as never)).toBe(false);
    expect(ids(notificationFor({ type: "request", kind: "reply", member: "Nam", summary: "Hi", action: 5 } as never, {}, at("12:00")))).toEqual(["look_first"]);
  });
});

describe("hidden details", () => {
  it("hides names and summary on the lock screen", () => {
    const n = notificationFor(req("reply", "Refund ฿1,290 to Mali"), { screenLocked: true }, at("12:00"));
    expect(n.title).toBe("Manut AI");
    expect(n.body).toBe("1 request needs you.");
    expect(JSON.stringify(n)).not.toMatch(/Nam|Mali|1,290/);
  });
  it("hides them with the setting, counting the waiting requests", () => {
    expect(notificationFor(req("money"), { hideDetails: true, waitingCount: 3 }, at("12:00")).body).toBe("3 requests need you.");
  });
  it("drops Approve while details are hidden", () => {
    expect(ids(notificationFor(req("reply"), { hideDetails: true }, at("12:00")))).toEqual(["look_first"]);
  });
  it("hides the page and device on alerts too", () => {
    const page = notificationFor({ type: "page_down", page: "baanmali.shop" }, { hideDetails: true }, at("12:00"));
    expect(JSON.stringify(page)).not.toContain("baanmali");
    const dev = notificationFor({ type: "new_device", device: "Chrome on Windows" }, { screenLocked: true }, at("12:00"));
    expect(JSON.stringify(dev)).not.toContain("Chrome");
  });
});

describe("quiet hours", () => {
  it("defaults to 22:00 to 08:00 in Bangkok, start in and end out", () => {
    expect(inQuietHours(at("21:59"))).toBe(false);
    expect(inQuietHours(at("22:00"))).toBe(true);
    expect(inQuietHours(at("00:00", 24))).toBe(true);
    expect(inQuietHours(at("07:59", 24))).toBe(true);
    expect(inQuietHours(at("08:00", 24))).toBe(false);
  });
  it("lets a request wait in Updates, silent", () => {
    const n = notificationFor(req("reply"), {}, at("23:30"));
    expect(n).toMatchObject({ show: false, sound: false, reason: "waits_in_updates", title: "Nam needs you" });
  });
  it("still alerts, with sound, for a stopped page and a new device", () => {
    for (const event of [{ type: "page_down" }, { type: "new_device" }] as NotifyEvent[]) {
      expect(notificationFor(event, {}, at("03:00"))).toMatchObject({ show: true, sound: true });
    }
  });
  it("works for hours inside one day and in another zone", () => {
    const q = { quietHours: { start: "13:00", end: "14:00" } };
    expect(inQuietHours(at("13:30"), q)).toBe(true);
    expect(inQuietHours(at("14:00"), q)).toBe(false);
    expect(inQuietHours(at("13:30"), { ...q, timeZone: "UTC" })).toBe(false);
    expect(inQuietHours(at("20:30"), { ...q, timeZone: "UTC" })).toBe(true);
  });
  it("falls back to defaults for unreadable hours and zones, and has none when start equals end", () => {
    expect(inQuietHours(at("23:00"), { quietHours: { start: "late", end: "08:00" } })).toBe(true);
    expect(inQuietHours(at("23:00"), { timeZone: "Not/AZone" })).toBe(true);
    expect(inQuietHours(at("23:00"), { quietHours: { start: "09:00", end: "09:00" } })).toBe(false);
  });
});

describe("a job that waited while the Mac slept", () => {
  const woke = (count: number): NotifyEvent => ({ type: "waited_while_asleep", count, wokeAt: at("09:00") });
  it("shows once after waking, silently", () => {
    const n = notificationFor(woke(2), {}, at("09:00"));
    expect(n).toMatchObject({ show: true, sound: false, body: "2 jobs waited for you." });
    expect(notificationFor(woke(1), {}, at("09:00")).body).toBe("1 job waited for you.");
  });
  it("shows nothing when nothing waited", () => {
    expect(notificationFor(woke(0), {}, at("09:00"))).toMatchObject({ show: false, reason: "nothing_waited" });
  });
  it("does not repeat for the same wake, but shows for a later one", () => {
    expect(notificationFor(woke(2), { lastWaitedShownAt: at("09:00") }, at("09:05"))).toMatchObject({ show: false, reason: "already_shown" });
    expect(notificationFor(woke(2), { lastWaitedShownAt: at("08:00") }, at("09:00")).show).toBe(true);
  });
  it("waits in Updates during quiet hours", () => {
    expect(notificationFor({ type: "waited_while_asleep", count: 1, wokeAt: at("23:00") }, {}, at("23:00")).show).toBe(false);
  });
  it("refuses a bad count", () => {
    expect(notificationFor({ type: "waited_while_asleep", count: 1.5, wokeAt: 1 }, {}, 1).reason).toBe("unreadable");
  });
});

describe("a plain notice", () => {
  // News the team has for the owner (an answer, a program that ended, low disk space): it asks nothing, so it carries no
  // Approve, makes no sound, and quiet hours and hidden details apply to it as to everything else the app shows.
  const notice: NotifyEvent = { type: "notice", title: "Nam", body: "Replied to Mali about the candle set." };
  it("says what it was given, silently, with Look first and Later", () => {
    const n = notificationFor(notice, {}, at("12:00"));
    expect(n).toMatchObject({ show: true, sound: false, title: "Nam", body: "Replied to Mali about the candle set.", reason: "shown" });
    expect(ids(n)).toEqual(["look_first", "later"]);
  });
  it("shows no name or words while details are hidden, by the setting or on the lock screen", () => {
    for (const settings of [{ hideDetails: true }, { screenLocked: true }]) {
      const n = notificationFor(notice, settings, at("12:00"));
      expect(n).toMatchObject({ show: true, sound: false, title: "Manut AI", body: "Something happened." });
      expect(JSON.stringify(n)).not.toMatch(/Nam|Mali|candle/);
    }
  });
  it("waits in Updates during quiet hours", () => {
    expect(notificationFor(notice, {}, at("23:30"))).toMatchObject({ show: false, sound: false, reason: "waits_in_updates" });
  });
  it("falls back to the app's name for a blank title, and refuses what is not text", () => {
    expect(notificationFor({ ...notice, title: "  " } as NotifyEvent, {}, at("12:00")).title).toBe("Manut AI");
    expect(notificationFor({ type: "notice", title: 5, body: "x" } as never, {}, at("12:00")).reason).toBe("unreadable");
    expect(notificationFor({ type: "notice", title: "x" } as never, {}, at("12:00")).reason).toBe("unreadable");
  });
});

describe("badgeCount", () => {
  it("is the number of requests waiting and nothing else", () => {
    expect(badgeCount([])).toBe(0);
    expect(badgeCount([{ id: "a" }, { id: "b" }, { id: "c" }])).toBe(3);
    expect(badgeCount(undefined)).toBe(0);
    expect(badgeCount(null)).toBe(0);
  });
});
