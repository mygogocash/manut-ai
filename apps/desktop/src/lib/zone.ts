// Whose clock a routine's time is on. A routine is stored with a time zone of its own (a shop in Bangkok keeps Bangkok time),
// so "Every day at 09:00" is 09:00 there, not on the computer in front of the reader. The rule is one line: say the zone when,
// and only when, it is not this computer's, so a shop owner in Thailand on a Mac set to Bangkok time sees nothing new.
//
// "Not this computer's" is judged by the clock, not by the name. A zone has other names for the same clock (Asia/Calcutta and
// Asia/Kolkata, Asia/Saigon and Asia/Ho_Chi_Minh), and the platform does not always fold them into one, so two zones are the same
// when they show the same offset from UTC across a whole year. The year is sampled, not just now, so a zone that merely shares
// today's offset (a daylight-saving one in winter) is not taken for one that always has it.
import { t } from "../i18n";

/** What a test sets to stand in for this computer's zone: a zone name, or null to read the platform's again. */
let pinned: string | null = null;

/** Pins the computer's zone for a test, so no test depends on the zone of the machine it runs on. null reads the platform's. */
export function pinComputerZone(zone: string | null): void {
  pinned = zone;
}

/** The IANA name of this computer's zone, or null when the platform does not say. */
export function computerZone(): string | null {
  if (pinned !== null) return pinned;
  try {
    return new Intl.DateTimeFormat().resolvedOptions().timeZone || null;
  } catch {
    return null;
  }
}

const MONTH = 30 * 86_400_000;

/** The zone's offset from UTC at an instant as the platform spells it ("GMT+07:00"), or null for a name it does not know. */
function offsetAt(zone: string, ms: number): string | null {
  try {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone: zone, timeZoneName: "longOffset" }).formatToParts(new Date(ms));
    return parts.find((p) => p.type === "timeZoneName")?.value ?? null;
  } catch {
    return null;
  }
}

/** Whether two zones always show the same clock, over the twelve months from `nowMs`. */
function sameClock(a: string, b: string, nowMs: number): boolean {
  if (a === b) return true;
  for (let i = 0; i <= 12; i++) {
    const at = nowMs + i * MONTH;
    const x = offsetAt(a, at);
    if (x === null || x !== offsetAt(b, at)) return false;
  }
  return true;
}

/** How a zone is named: its city and "time" ("Bangkok time", "New York time"), or its offset ("GMT+5:30") for a zone that names
 *  no city (an offset such as +05:30, UTC, or Etc/GMT-7). The city is the zone id's last part, which is the place's own name, so
 *  it is not translated; the word "time" is. */
export function zoneName(zone: string, nowMs = Date.now()): string {
  const [area, ...rest] = zone.split("/");
  const city = rest.length > 0 && area !== "Etc" ? rest[rest.length - 1]!.replace(/_/g, " ") : "";
  if (city) return t("zone.city", { place: city });
  if (zone.toUpperCase() === "UTC") return "UTC";
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: zone, timeZoneName: "shortOffset" }).formatToParts(new Date(nowMs)).find((p) => p.type === "timeZoneName")?.value ?? zone;
  } catch {
    return zone;
  }
}

/** The zone to name beside a routine's time, or null when nothing needs saying: no zone given, one this platform does not know
 *  (nothing true can be said of it), or one on the same clock as this computer. When the computer's zone cannot be read the zone is
 *  named, because a time left unexplained is the mistake this prevents. */
export function zoneNote(zone: string | null | undefined, nowMs = Date.now()): string | null {
  if (!zone || offsetAt(zone, nowMs) === null) return null;
  const mine = computerZone();
  if (mine !== null && offsetAt(mine, nowMs) !== null && sameClock(zone, mine, nowMs)) return null;
  return zoneName(zone, nowMs);
}

/** A time in words with its zone after it ("Every day at 09:00 (Bangkok time)"), or the words unchanged when the zone is this
 *  computer's. */
export function withZone(words: string, zone: string | null | undefined, nowMs = Date.now()): string {
  const note = zoneNote(zone, nowMs);
  return note === null ? words : t("zone.with", { words, zone: note });
}
