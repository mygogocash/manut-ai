// Whose clock a routine's time is on: named when, and only when, it is not this computer's. No test here depends on the zone of
// the machine it runs on: the computer's zone is pinned each time (src/testSetup.ts pins Bangkok for every other test).
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setLang } from "../i18n";
import { computerZone, pinComputerZone, withZone, zoneName, zoneNote } from "./zone";

/** Sunday 22 November 2026, 10:00 in Bangkok: winter in the north, summer in the south. */
const NOW = Date.UTC(2026, 10, 22, 3, 0);

beforeEach(() => setLang("en"));
afterEach(() => {
  setLang("en");
  pinComputerZone("Asia/Bangkok");
});

describe("the computer's zone", () => {
  it("is the one a test pins, and the platform's once the pin is cleared", () => {
    pinComputerZone("Europe/London");
    expect(computerZone()).toBe("Europe/London");
    pinComputerZone(null);
    expect(computerZone()).toBe(new Intl.DateTimeFormat().resolvedOptions().timeZone);
  });
});

describe("when a zone is named", () => {
  it("is not, for the computer's own zone: nothing changes for a shop in Bangkok on a Mac set to Bangkok", () => {
    expect(zoneNote("Asia/Bangkok", NOW)).toBeNull();
    expect(withZone("Every day at 09:00", "Asia/Bangkok", NOW)).toBe("Every day at 09:00");
  });

  it("is not, for the computer's zone under another name (the same clock all year)", () => {
    pinComputerZone("Asia/Kolkata");
    expect(zoneNote("Asia/Calcutta", NOW)).toBeNull();
    pinComputerZone("Asia/Ho_Chi_Minh");
    expect(zoneNote("Asia/Saigon", NOW)).toBeNull();
    // Bangkok and Ho Chi Minh City show one clock, so neither needs naming beside the other.
    expect(zoneNote("Asia/Bangkok", NOW)).toBeNull();
  });

  it("is, for a zone on another clock", () => {
    pinComputerZone("Europe/London");
    expect(zoneNote("Asia/Bangkok", NOW)).toBe("Bangkok time");
    expect(withZone("Every day at 09:00", "Asia/Bangkok", NOW)).toBe("Every day at 09:00 (Bangkok time)");
  });

  it("is, for a zone on the other side of midnight, so a next run's day is read on the routine's own calendar", () => {
    pinComputerZone("America/Los_Angeles");
    expect(zoneNote("Pacific/Auckland", NOW)).toBe("Auckland time");
  });

  it("is, for a zone that shares today's offset but not the year's (daylight saving)", () => {
    // In late November London is on GMT, as Reykjavik always is; in summer London is an hour ahead.
    pinComputerZone("Atlantic/Reykjavik");
    expect(zoneNote("Europe/London", NOW)).toBe("London time");
  });

  it("is, for the same city on the other side of a daylight-saving change that the computer's zone does not make", () => {
    pinComputerZone("America/Phoenix");
    expect(zoneNote("America/Denver", Date.UTC(2026, 6, 1))).toBe("Denver time");
  });

  it("says nothing of no zone, or of one this platform does not know", () => {
    pinComputerZone("Europe/London");
    expect(zoneNote(undefined, NOW)).toBeNull();
    expect(zoneNote("", NOW)).toBeNull();
    expect(zoneNote("Mars/Olympus", NOW)).toBeNull();
    expect(withZone("Every day at 09:00", "Mars/Olympus", NOW)).toBe("Every day at 09:00");
  });
});

describe("how a zone is named", () => {
  it("is its city and the word time, with the underscores of the id taken out", () => {
    expect(zoneName("Asia/Bangkok", NOW)).toBe("Bangkok time");
    expect(zoneName("America/New_York", NOW)).toBe("New York time");
    expect(zoneName("America/Argentina/Buenos_Aires", NOW)).toBe("Buenos Aires time");
  });

  it("is its offset for an offset zone, UTC and an Etc zone, which name no city", () => {
    expect(zoneName("+05:30", NOW)).toBe("GMT+5:30");
    expect(zoneName("Etc/GMT-7", NOW)).toBe("GMT+7");
    expect(zoneName("UTC", NOW)).toBe("UTC");
  });

  it("says the word time in the app's language", () => {
    setLang("ja");
    pinComputerZone("Europe/London");
    expect(zoneName("Asia/Bangkok", NOW)).toBe("Bangkok時間");
    setLang("zh");
    pinComputerZone("Europe/London");
    expect(withZone("每天 09:00", "Asia/Bangkok", NOW).endsWith("（Bangkok时间）")).toBe(true);
  });

  it("names an offset zone beside a time, when it is not the computer's", () => {
    pinComputerZone("Asia/Bangkok");
    expect(withZone("Every day at 09:00", "+05:30", NOW)).toBe("Every day at 09:00 (GMT+5:30)");
    // An offset zone equal to the computer's clock needs no naming.
    expect(zoneNote("+07:00", NOW)).toBeNull();
  });
});
