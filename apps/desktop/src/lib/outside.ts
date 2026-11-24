// What the app shows outside its window: system notifications (with their buttons) and the number on the Dock icon.
// `@manut/notify-rules` decides everything that is a rule: whether a notification shows, whether it makes a sound,
// which buttons it carries, what quiet hours and hidden details do. This file only feeds it events and puts what it
// answers into the app's words (notify-rules writes English), so nothing here may add a second way to show, to answer
// or to approve (CLAUDE.md: approvals settle once). What it presents is pure: the clock, the settings and the language
// come into `presentOutside`. Only the two settings below are read from this computer's storage.
//
// - Money and public posts never get Approve, and neither does anything this build does not know: notify-rules decides
//   that from the request's approval-core kind. Approve is also dropped when the card itself offers no Allow once, and
//   when the body is not the request's exact action shown whole (cut to fit, changed on the way, or too long to be seen):
//   notify-rules treats that as a hidden detail.
// - macOS folds two or more buttons into an "Options" menu and reports the FIRST button for a click on the menu button
//   itself (tauri-plugin-notification, desktop.rs), so the system gets the buttons with Approve last: a stray click can
//   only look, never approve.
// - A pressed button is read against what that notification offered, so an Approve the notification never carried (a
//   stale or forged action) is not an approval.
import {
  badgeCount as requestsWaiting,
  DEFAULT_QUIET_HOURS,
  inQuietHours,
  notificationFor,
  type ButtonId,
  type NotifyEvent,
  type QuietHours,
} from "@manut/notify-rules";
import { t } from "../i18n";

/** The product's name, as notify-rules writes it for a notification that hides its details. The same in every language. */
export const APP_NAME = "Manut AI";
/** The canvas's quiet hours: 22:00 to 08:00 (Asia/Bangkok, notify-rules' own default zone). */
export const DEFAULT_QUIET: QuietHours = DEFAULT_QUIET_HOURS;

// ---- what the app can report -------------------------------------------------------------------------------------------

/** A request waiting for the owner. */
export interface RequestInfo {
  /** approval-core's kind of the request, as text; "" when it has none (a bot's question, a terminal's ring, a request this
   *  build reads no kind for). notify-rules treats a kind it does not know as owner-only. */
  approval: string;
  /** Who asks. */
  member: string;
  /** The exact action, in one line, as the body says it. */
  summary: string;
  /** The exact action, whole, as the card shows it. Approve is offered only when `summary` is this text, unchanged, and
   *  notify-rules finds it short enough to be shown whole: an owner must not approve what they cannot read. */
  action?: string;
  /** The card offers Allow once: this build can answer the request. */
  canApprove: boolean;
}

export type Outside =
  | ({ kind: "request" } & RequestInfo)
  /** News that asks nothing: an answer, a program that ended, low disk space. */
  | { kind: "notice"; title: string; body: string }
  /** A live page that stopped working. No source in the app yet. */
  | { kind: "page_down"; page?: string }
  /** A sign-in from a new device. No source in the app yet. */
  | { kind: "new_device"; device?: string }
  /** Work that waited while the Mac slept, and when it woke (ms). */
  | { kind: "slept"; count: number; wokeAt: number };

/** The event notify-rules reads, or null for something that is not one of the above. */
export function eventOf(src: Outside): NotifyEvent | null {
  switch (src?.kind) {
    case "request":
      return { type: "request", kind: src.approval, member: src.member, summary: src.summary, ...(src.action === undefined ? {} : { action: src.action }) };
    case "notice":
      return { type: "notice", title: src.title, body: src.body };
    case "page_down":
      return { type: "page_down", page: src.page };
    case "new_device":
      return { type: "new_device", device: src.device };
    case "slept":
      return { type: "waited_while_asleep", count: src.count, wokeAt: src.wokeAt };
    default:
      return null;
  }
}

// ---- the two settings ---------------------------------------------------------------------------------------------------

const HIDE_KEY = "manut.notify.hide";
const QUIET_KEY = "manut.notify.quiet";

const read = (key: string): string | null => {
  try {
    return typeof localStorage === "undefined" ? null : localStorage.getItem(key);
  } catch {
    return null;
  }
};
const write = (key: string, value: string): void => {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* no storage: the choice holds until the page closes at most */
  }
};

/** "Hide details" (Settings › General › Notifications). Off until the owner turns it on; saved on this computer. */
export const hideDetails = (): boolean => read(HIDE_KEY) === "on";
export const setHideDetails = (on: boolean): void => write(HIDE_KEY, on ? "on" : "off");

const QUIET_RE = /^([01]\d|2[0-3]):([0-5]\d)-([01]\d|2[0-3]):([0-5]\d)$/;
/** `22:00-08:00` as hours; anything else is the canvas's default. */
export function parseQuiet(text: string | null | undefined): QuietHours {
  const m = typeof text === "string" ? QUIET_RE.exec(text) : null;
  return m ? { start: `${m[1]}:${m[2]}`, end: `${m[3]}:${m[4]}` } : DEFAULT_QUIET;
}
export const formatQuiet = (q: QuietHours): string => `${q.start}-${q.end}`;

/** Quiet hours (Settings › General › Notifications): a start and an end, which may cross midnight. */
export const quietHours = (): QuietHours => parseQuiet(read(QUIET_KEY));
export const setQuietHours = (q: QuietHours): void => write(QUIET_KEY, formatQuiet(q));

/** Whether `now` (ms) falls in the owner's quiet hours: "Nothing makes a sound", the app's own sounds included. */
export const quietNow = (now: number): boolean => inQuietHours(now, { quietHours: quietHours() });

/** Both settings, as read now. */
export const outsideSettings = (): { hideDetails: boolean; quiet: QuietHours } => ({ hideDetails: hideDetails(), quiet: quietHours() });

// ---- what a notification says ---------------------------------------------------------------------------------------------

export interface PresentContext {
  hideDetails: boolean;
  quiet: QuietHours;
  /** ms, now */
  now: number;
  /** How many requests wait for the owner now, this one included: all that a notification says while details are hidden. */
  waiting: number;
  /** When a "waited while the Mac slept" notice was last shown (the wake's time), so a wake shows it once. */
  lastWaitedShownAt?: number;
}

export interface ShownAction {
  id: ButtonId;
  /** The button's words, in the app's language. */
  title: string;
}

/** A notification that may be shown. */
export interface Shown {
  title: string;
  body: string;
  sound: boolean;
  /** Its buttons in the order the system gets them: the one that does something is last. */
  actions: ShownAction[];
  /** The wake a "waited while the Mac slept" notice is for, so it is shown once. */
  wokeAt?: number;
}

const LABEL = { approve: "out.approve", look_first: "out.look", later: "out.later" } as const;

/** A count notify-rules can say: a whole number of at least 1, else 1 (the notification is about one request at least). */
const countOf = (n: number): number => (Number.isInteger(n) && n >= 1 ? n : 1);
const blank = (v: unknown): boolean => typeof v !== "string" || v.trim() === "";

/** The words, in the app's language, for what notify-rules says in English. Its English and these are the same (a test
 *  keeps them so), so a change of its words shows up as a failing test, not as a silent difference. */
function words(src: Outside, hidden: boolean, waiting: number): { title: string; body: string } {
  const waitingBody = (n: number) => (n === 1 ? t("out.waitingOne") : t("out.waitingMany", { n }));
  switch (src.kind) {
    case "request":
      return hidden
        ? { title: APP_NAME, body: waitingBody(countOf(waiting)) }
        : { title: t("out.needsYou", { member: blank(src.member) ? t("out.yourTeam") : src.member.trim() }), body: src.summary };
    case "notice":
      return hidden ? { title: APP_NAME, body: t("out.somethingHappened") } : { title: blank(src.title) ? APP_NAME : src.title.trim(), body: src.body };
    case "page_down":
      return hidden
        ? { title: APP_NAME, body: t("out.somethingNeedsYou") }
        : { title: t("out.pageDownTitle"), body: t("out.pageDownBody", { page: blank(src.page) ? t("out.aLivePage") : src.page!.trim() }) };
    case "new_device":
      return hidden
        ? { title: APP_NAME, body: t("out.somethingNeedsYou") }
        : { title: t("out.newDeviceTitle"), body: t("out.newDeviceBody", { device: blank(src.device) ? t("out.aNewDevice") : src.device!.trim() }) };
    default:
      return hidden
        ? { title: APP_NAME, body: waitingBody(countOf(src.count)) }
        : { title: t("out.sleptTitle"), body: src.count === 1 ? t("out.sleptOne") : t("out.sleptMany", { n: src.count }) };
  }
}

/** What to show for `src` now, or null when nothing may be shown: quiet hours, nothing that waited, the same wake twice, or
 *  something that is not an event at all. The buttons are notify-rules', less Approve when the card offers no Allow once,
 *  put in the order the system should get them. */
export function presentOutside(src: Outside, c: PresentContext): Shown | null {
  const event = eventOf(src);
  if (!event) return null;
  const rule = notificationFor(event, { hideDetails: c.hideDetails, quietHours: c.quiet, waitingCount: c.waiting, lastWaitedShownAt: c.lastWaitedShownAt }, c.now);
  if (!rule.show) return null;
  const approvable = src.kind === "request" && src.canApprove;
  const buttons = rule.buttons.filter((b) => b.id !== "approve" || approvable);
  // the button that does something goes last (macOS reports the first for a click on its "Options" button itself)
  const ordered = [...buttons.filter((b) => b.id !== "approve"), ...buttons.filter((b) => b.id === "approve")];
  const { title, body } = words(src, c.hideDetails, c.waiting);
  return {
    title,
    body,
    sound: rule.sound,
    actions: ordered.map((b) => ({ id: b.id, title: t(LABEL[b.id]) })),
    ...(src.kind === "slept" ? { wokeAt: src.wokeAt } : {}),
  };
}

export type Pressed = "approve" | "look" | "later";

/** What a pressed button means, or null for anything this notification did not offer. A click on the notification itself
 *  (`tap`) is Look first. The system names an action by its id and, as the plugin warns, tells actions apart by their
 *  title, so either reads. Approve counts only when this notification carried an Approve button. */
export function routeAction(actionId: string, shown: Pick<Shown, "actions">): Pressed | null {
  if (actionId === "tap") return "look";
  const hit = shown.actions.find((a) => a.id === actionId) ?? shown.actions.find((a) => a.title === actionId);
  if (!hit) return null;
  return hit.id === "approve" ? "approve" : hit.id === "later" ? "later" : "look";
}

// ---- the Dock ---------------------------------------------------------------------------------------------------------------

/** The Dock cuts a longer label. */
export const DOCK_MAX = 99;

/** The number on the Dock icon: the requests waiting, and nothing else (notify-rules' count), at most 99. */
export const dockCount = (requests: readonly unknown[] | null | undefined): number => Math.min(requestsWaiting(requests), DOCK_MAX);
