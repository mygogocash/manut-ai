// What the app may show outside its window (design canvas board "States: outside the app").
// Pure rules: showing a notification is somebody else's job. Nothing here throws; a refusal is a result value.

/** The approval kinds this build knows. Kept local so the package has no dependency; a kind outside the list is owner-only. */
export const KNOWN_KINDS = ["message", "reply", "money", "public_post", "payment_confirmation", "command"] as const;

/** Only these two may be approved from a notification. Money, posts, payments and commands never are. */
const APPROVABLE_FROM_NOTIFICATION: readonly string[] = ["message", "reply"];

export type NotifyEvent =
  | { readonly type: "request"; readonly kind: string; readonly member: string; readonly summary: string }
  | { readonly type: "page_down"; readonly page?: string }
  | { readonly type: "new_device"; readonly device?: string }
  | { readonly type: "waited_while_asleep"; readonly count: number; readonly wokeAt: number };

export interface QuietHours {
  /** "HH:MM", 24-hour clock. May be later than `end`, which means the hours cross midnight. */
  readonly start: string;
  readonly end: string;
}

export interface NotifySettings {
  /** The setting "Hide details". */
  readonly hideDetails?: boolean;
  /** True while the screen is locked: details are hidden whatever the setting says. */
  readonly screenLocked?: boolean;
  readonly quietHours?: QuietHours;
  /** Default `Asia/Bangkok`. */
  readonly timeZone?: string;
  /** How many requests wait for the owner now, this one included. Used by the hidden-details body. Default 1. */
  readonly waitingCount?: number;
  /** When a "waited while the Mac slept" notice was last shown, so a wake shows it once. */
  readonly lastWaitedShownAt?: number;
}

export type ButtonId = "approve" | "look_first" | "later";
export interface NotifyButton {
  readonly id: ButtonId;
  readonly label: string;
}

export type NotifyReason = "shown" | "waits_in_updates" | "nothing_waited" | "already_shown" | "unreadable";

export interface Notification {
  readonly show: boolean;
  readonly sound: boolean;
  readonly title: string;
  readonly body: string;
  readonly buttons: readonly NotifyButton[];
  readonly reason: NotifyReason;
}

export const DEFAULT_QUIET_HOURS: QuietHours = { start: "22:00", end: "08:00" };
export const DEFAULT_TIME_ZONE = "Asia/Bangkok";

const APPROVE: NotifyButton = { id: "approve", label: "Approve" };
const LOOK: NotifyButton = { id: "look_first", label: "Look first" };
const LATER: NotifyButton = { id: "later", label: "Later" };

function parseClock(text: unknown): number | null {
  if (typeof text !== "string") return null;
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(text);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

function minutesOfDay(now: number, timeZone: string): number | null {
  try {
    const parts = new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(now);
    const h = Number(parts.find((p) => p.type === "hour")?.value);
    const mi = Number(parts.find((p) => p.type === "minute")?.value);
    return Number.isFinite(h) && Number.isFinite(mi) ? h * 60 + mi : null;
  } catch {
    return null;
  }
}

/**
 * Whether `now` falls inside the owner's quiet hours. The start is included and the end is not, so 22:00 to
 * 08:00 is quiet at 22:00 and not quiet at 08:00. Unreadable hours or zone fall back to the defaults, and equal
 * start and end mean there are no quiet hours at all.
 */
export function inQuietHours(now: number, settings: NotifySettings = {}): boolean {
  const hours = settings.quietHours ?? DEFAULT_QUIET_HOURS;
  let start = parseClock(hours.start);
  let end = parseClock(hours.end);
  if (start === null || end === null) {
    start = parseClock(DEFAULT_QUIET_HOURS.start) as number;
    end = parseClock(DEFAULT_QUIET_HOURS.end) as number;
  }
  if (start === end) return false;
  const at = minutesOfDay(now, settings.timeZone ?? DEFAULT_TIME_ZONE) ?? minutesOfDay(now, DEFAULT_TIME_ZONE);
  if (at === null) return false;
  return start < end ? at >= start && at < end : at >= start || at < end;
}

function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}

function hiddenBody(count: number): string {
  const n = Number.isInteger(count) && count >= 1 ? count : 1;
  return `${n} ${plural(n, "request needs you.", "requests need you.")}`;
}

function nonEmpty(v: unknown, fallback: string): string {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : fallback;
}

/** Whether a kind may be approved from a notification. Anything this build does not know may not. */
export function canApproveFromNotification(kind: unknown): boolean {
  return typeof kind === "string" && APPROVABLE_FROM_NOTIFICATION.includes(kind);
}

const unreadable: Notification = { show: false, sound: false, title: "", body: "", buttons: [], reason: "unreadable" };

/**
 * What to show for one event. Money never moves from a notification: only a `message` or `reply` request carries
 * "Approve", and not even that while details are hidden, because an owner must not approve what they cannot read.
 */
export function notificationFor(event: NotifyEvent, settings: NotifySettings, now: number): Notification {
  if (typeof event !== "object" || event === null) return unreadable;
  const s = settings ?? {};
  const hidden = s.hideDetails === true || s.screenLocked === true;
  const quiet = inQuietHours(now, s);

  switch (event.type) {
    case "request": {
      if (typeof event.kind !== "string" || typeof event.summary !== "string") return unreadable;
      const member = nonEmpty(event.member, "Your team");
      const buttons = canApproveFromNotification(event.kind) && !hidden ? [APPROVE, LOOK] : canApproveFromNotification(event.kind) ? [LOOK] : [LOOK, LATER];
      return {
        show: !quiet,
        sound: !quiet,
        title: hidden ? "Manut AI" : `${member} needs you`,
        body: hidden ? hiddenBody(s.waitingCount ?? 1) : event.summary,
        buttons,
        reason: quiet ? "waits_in_updates" : "shown",
      };
    }
    // The two alerts that quiet hours never silence.
    case "page_down":
      return {
        show: true,
        sound: true,
        title: hidden ? "Manut AI" : "A live page stopped working",
        body: hidden ? "Something needs you." : nonEmpty(event.page, "One of your live pages") + " is not working.",
        buttons: [LOOK, LATER],
        reason: "shown",
      };
    case "new_device":
      return {
        show: true,
        sound: true,
        title: hidden ? "Manut AI" : "New sign-in",
        body: hidden ? "Something needs you." : `Someone signed in from ${nonEmpty(event.device, "a new device")}. Was it you?`,
        buttons: [LOOK, LATER],
        reason: "shown",
      };
    case "waited_while_asleep": {
      if (!Number.isInteger(event.count) || !Number.isFinite(event.wokeAt)) return unreadable;
      // Shown once per wake, and only when something really had to wait. It is silent: it is news, not an alarm.
      if (event.count < 1) return { ...unreadable, reason: "nothing_waited" };
      if (s.lastWaitedShownAt !== undefined && s.lastWaitedShownAt >= event.wokeAt) return { ...unreadable, reason: "already_shown" };
      return {
        show: !quiet,
        sound: false,
        title: hidden ? "Manut AI" : "While your Mac slept",
        body: hidden ? hiddenBody(event.count) : `${event.count} ${plural(event.count, "job", "jobs")} waited for you.`,
        buttons: [LOOK, LATER],
        reason: quiet ? "waits_in_updates" : "shown",
      };
    }
    default:
      return unreadable;
  }
}

/** The number on the Dock icon: the requests waiting, and nothing else. */
export function badgeCount(requests: readonly unknown[] | null | undefined): number {
  return Array.isArray(requests) ? requests.length : 0;
}
