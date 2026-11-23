import { describe, expect, it } from "vitest";
import { KNOWN_KINDS, badgeCount, canApproveFromNotification, inQuietHours, notificationFor, type NotifyEvent } from "../src/index";

// 2026-11-23 in Bangkok (UTC+7) at the given local time.
const at = (hhmm: string, day = 23) => Date.parse(`2026-11-${String(day).padStart(2, "0")}T${hhmm}:00+07:00`);
const req = (kind: string, summary = "Reply to Mali about the candle set"): NotifyEvent => ({ type: "request", kind, member: "Nam", summary });
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
