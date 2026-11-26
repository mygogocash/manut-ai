// System notifications while manut is in the background: a bot finished its answer, needs an approval,
// or asked a question. Nothing fires while you are looking at that bot's chat. Errors and clean program ends only
// mark their row; the body is what the bot said, as it would say it (`spoken`). In the desktop app this
// goes through the Tauri notification plugin (macOS Notification Center, Windows toasts); in a plain
// browser (dev, e2e) through the Web Notification API.
//
// Every notification goes through `showOutside`, which asks `@manut/notify-rules` (outside.ts) whether to show it, with
// what sound and which buttons: quiet hours and Hide details apply to all of them. A request waiting for the owner may
// carry Approve (a `message` or `reply` only, and never while details are hidden); a pressed Approve is answered by the
// caller's own handler, which is the card's path (store.ts `approveFromNotification`), so there is no second way to
// settle an approval. Look first opens the app on the request, Later only dismisses.
import type { BridgeEvent } from "./protocol";
import { t } from "../i18n";
import { outsideSettings, presentOutside, routeAction, type Outside, type PresentContext, type Shown, type ShownAction } from "./outside";
import { isMacPlatform } from "./power";
import { revealHidden, showCommand } from "./secrets";

export interface Note {
  title: string;
  body: string;
  /** Which bot to open when the notification is clicked (browser build only). */
  bot: string;
  /** Collapse repeats of the same kind for the same bot. */
  tag: string;
  /** Set when this is a request waiting for the owner (an approval, a question), not news: what notify-rules needs to
   *  rule on it (outside.ts). `body` is then the request's one-line summary. */
  ask?: AskNote;
}

export interface AskNote {
  /** The ask's id with the revision shown: the card's own. */
  id: string;
  /** approval-core's kind of the request as text; "" when the ask has none, which is owner-only. */
  approval: string;
  /** Who asks. */
  member: string;
  /** The card offers Allow once. */
  canApprove: boolean;
  /** The exact action, whole, as the card shows it. notify-rules offers Approve only when the body is this text, unchanged,
   *  and short enough to be seen whole: a body cut to fit or changed on the way (a link shortened, marks dropped) is a
   *  hidden detail. */
  action?: string;
  /** How many requests wait for the owner now, this one included: all a notification says while details are hidden. */
  waiting: number;
}

const clip = (s: string, n = 140) => {
  const t = s.replace(/[`*_#>]+/g, "").replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

/** A URL as its host, a path with folders as its last name: `https://x.y/z?q` -> `x.y`, `/a/b/c.ts` -> `c.ts`. */
export function shortenRefs(s: string): string {
  return s
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/([^\s/?#)]+)[^\s)]*/gi, "$1")
    .replace(/(?:~|\.{1,2})?(?:\/[^\s/]+){2,}\/?|\b[\w.-]+(?:\/[\w.-]+){2,}\/?/g, (m) => m.replace(/\/$/, "").split("/").pop() || m);
}

/** Honorifics a greeting carries; with them and the punctuation gone, a greeting is a few letters. */
const HONORIFIC = /선생님|님|sir|ma'?am|madam|さん|様|先生/gi;
/** A sentence that is only a greeting or filler ("Done!", "네, 선생님!"): six letters or fewer once the honorifics go. */
const filler = (s: string) => (s.replace(HONORIFIC, "").match(/[\p{L}\p{N}]/gu) ?? []).length <= 6;

/** What a bot or agent said, as a notification says it: its first sentence, or up to three when the first is only a
 *  greeting, at most 140 characters. Code blocks, tables, headings, markdown marks, list bullets and asides in
 *  brackets go; a path keeps its last name, a URL its host. Pure. */
export function spoken(text: string, max = 140): string {
  const lines = text
    .replace(/```[\s\S]*?(?:```|$)/g, "\n")
    .replace(/~~~[\s\S]*?(?:~~~|$)/g, "\n")
    .split(/\r?\n/)
    .map((l) => l.trim())
    // tables and headings carry no sentence of the bot's own
    .filter((l) => l && !l.startsWith("|") && !/^#{1,6}\s/.test(l) && !/^[-=*_]{3,}$/.test(l))
    .map((l) =>
      shortenRefs(
        l
          .replace(/^(?:>\s*)+/, "")
          .replace(/^(?:[-*+•]|\d+[.)])\s+(?:\[[ xX]\]\s+)?/, "")
          .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
          .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, "$1"),
      )
        .replace(/\s*\([^()]*\)|\s*（[^（）]*）/g, "")
        .replace(/\*\*|__|~~|`/g, "")
        .replace(/(^|[\s(])[*_]([^*_\s][^*_]*?)[*_](?=[\s.,!?;:)]|$)/g, "$1$2")
        .replace(/\s+/g, " ")
        .trim(),
    )
    .filter(Boolean);
  // `.` `!` `?` end a sentence before a space (not `c.ts`, `x.y`); full-width marks end one wherever they stand
  const sentences = lines.flatMap((l) => l.split(/(?<=[.!?])\s+|(?<=[。！？])(?![。！？])/).map((x) => x.trim()).filter(Boolean));
  const picked: string[] = [];
  for (const x of sentences) {
    picked.push(x);
    if (picked.length >= 3 || !filler(x)) break;
  }
  const out = picked.join(" ").replace(/([。！？])\s+/g, "$1").replace(/\s+/g, " ").trim();
  return out.length > max ? `${out.slice(0, max - 1).trimEnd()}…` : out;
}

/** `spoken(text)`, or the plain clipped text when nothing sayable is left (an answer that is only a code block). */
const say = (text: string) => spoken(text) || clip(shortenRefs(text));

/** What an approval's notification says of its command: a browser write's sentence as typed, any other command as its card
 *  shows it, or, for one its card shows as it is because it may hold a key, the plain words that it may (item 121). */
function noteCommand(ev: { command?: string; whole?: boolean }): string {
  if (!ev.command) return "";
  if (ev.whole) return revealHidden(ev.command);
  const shown = showCommand(ev.command);
  return shown.unmasked ? t("note.mayHoldKey") : shown.text;
}

/** The notification for `ev`, or null when there is nothing worth interrupting for: an answer, an approval, a question.
 *  A turn that ended with an error only marks its chat unless `ctx.errors` ("Also notify on errors"). Pure: no globals. */
export function noteFor(
  ev: BridgeEvent,
  ctx: { name: (bot: string) => string; watching: (bot: string) => boolean; errors?: boolean; waiting?: () => number },
): Note | null {
  const bot = ev.bot;
  if (!bot || ctx.watching(bot)) return null;
  const who = ctx.name(bot);
  switch (ev.event) {
    case "message":
      if (ev.watch) return ev.text.trim() ? watchNote(who, bot, ev.watch.name, ev.text) : null;
      return ev.text.trim() ? { title: who, body: say(ev.text), bot, tag: `${bot}:message` } : null;
    case "approval.request":
      return {
        // an ask from one of several shops says whose it is: "Buddy at Ran Pa Noi needs your approval"
        title: t("note.approval", { bot: ev.shop?.name ? t("note.atShop", { bot: who, shop: ev.shop.name }) : who }),
        // a request whose whole text is too long for a notification says its own short line instead (Ton's append of the books).
        // A command's keys are masked as on its card (showCommand): Notification Centre keeps what it was shown, and a body
        // a masker changed is no longer the exact action below, so it never offers Approve (item 117). A command its card
        // shows as it is, since it may hold a key, is not put here at all: the body says so (item 121).
        body: clip(shortenRefs(revealHidden(ev.brief || noteCommand(ev) || ev.title || t("ask.allowThis")))),
        bot,
        tag: `${bot}:approval`,
        // only the connected runtime's asks carry an approval-core kind; any other has none and is owner-only
        ask: {
          id: ev.request_id,
          approval: ev.kind ?? "",
          member: who,
          canApprove: Array.isArray(ev.choices) && ev.choices.includes("once") && !ev.outdated,
          // what the body must be, word for word, for Approve: the command the card shows (a browser write's sentence)
          ...(ev.command ? { action: ev.command } : {}),
          waiting: ctx.waiting?.() ?? 1,
        },
      };
    case "clarify.request":
      return {
        title: t("note.question", { bot: who }),
        // a character that does not show, or that reorders what does, is a visible mark, as on the card (item 121)
        body: ev.question.trim() ? say(revealHidden(ev.question)) : t("note.waiting"),
        bot,
        tag: `${bot}:clarify`,
        ask: { id: ev.request_id, approval: "", member: who, canApprove: false, waiting: ctx.waiting?.() ?? 1 },
      };
    case "turn.end":
      return ev.outcome === "error" && ctx.errors
        ? { title: t("note.error", { bot: who }), body: say(ev.error || t("note.failed")), bot, tag: `${bot}:error` }
        : null;
    default:
      return null;
  }
}

/** An automation's answer: "<bot> · <watch>", its first line. */
export function watchNote(who: string, bot: string, name: string, text: string): Note {
  // manut's own Slack briefing reads as "<bot> · Brief", not its job name
  return { title: `${who} · ${name === "manut-brief" ? t("brief.line") : name}`, body: say(text), bot, tag: `${bot}:watch` };
}

/** Answers that came in while manut was closed: one note for the bot, never one per answer. */
export function watchMissedNote(who: string, bot: string, rows: { text: string; watch?: { name: string } }[]): Note | null {
  if (!rows.length) return null;
  const last = rows[rows.length - 1];
  if (rows.length === 1) return watchNote(who, bot, last.watch?.name ?? "", last.text);
  return { title: t("note.watchMany", { bot: who, n: rows.length }), body: say(last.text), bot, tag: `${bot}:watch` };
}

/** Something a SESSIONS session did that is not a chat event: its program ended, it could not start, or its
 *  terminal rang its bell. */
export interface SessionNote {
  kind: "ended" | "failed" | "bell";
  /** `web-app · Claude Code` */
  name: string;
  code?: number | null;
  error?: string;
  /** How long its program ran, ms (ended). */
  ms?: number;
  /** The turn that failed with this end already said why (its own error notification, when those are on). */
  told?: boolean;
  /** bell: the terminal's foreground program is a coding agent (an agent rings when it waits for the person; a plain
   *  shell rings on a failed tab completion or a stray `\\a`, which only marks the row). */
  agent?: boolean;
}

/** A program that ends this soon after it started did not really run. */
export const EARLY_END_MS = 5000;

/** Whether `n` is worth a notification: a ring, a start that failed, and an end that went wrong (an exit code, a reason,
 *  or within its first 5 s). A clean exit only marks the row. Pure. */
export function sessionRings(n: SessionNote): boolean {
  if (n.kind === "bell") return !!n.agent;
  if (n.kind !== "ended") return true;
  if (n.error || (typeof n.code === "number" && n.code !== 0)) return true;
  return typeof n.ms === "number" && n.ms < EARLY_END_MS;
}

/** The notification for `n` of session `id`. Pure: no globals. */
export function sessionNote(id: string, n: SessionNote): Note {
  const title = t(n.kind === "bell" ? "note.session.bell" : n.kind === "failed" ? "note.session.failed" : "note.session.ended", { name: n.name });
  const exit = typeof n.code === "number" && n.code !== 0 ? t("ss.endedExit", { code: n.code }) : "";
  const body = n.kind === "bell" ? t("note.session.bellBody") : n.error ? say(n.error) : clip(exit || t(n.kind === "failed" ? "ss.couldNotStart" : "note.session.endedBody"));
  return { title, body, bot: id, tag: `${id}:${n.kind}` };
}

/** How long a ring with no words waits for the question that says what it wants. */
export const HOLD_MS = 8000;

/** The notification gate for chats. A ring with no words (a bell, an OSC 9 ring, a question with no text) waits
 *  `ms` per chat: an agent often rings just before the question that says what it wants, and both rang. A texted
 *  question or approval for the same chat takes its place; with nothing in `ms` the held one fires. */
export function createNoteGate(ms = HOLD_MS) {
  const held = new Map<string, ReturnType<typeof setTimeout>>();
  const drop = (key: string) => {
    const h = held.get(key);
    if (h === undefined) return;
    clearTimeout(h);
    held.delete(key);
  };
  return {
    /** `fire` shows chat `key`'s note: `empty` (a ring with no words) is held, `ask` (a texted question or approval)
     *  replaces a held one, `plain` goes out as is. */
    offer(key: string, how: "empty" | "ask" | "plain", fire: () => void) {
      if (how === "empty") {
        drop(key);
        held.set(
          key,
          setTimeout(() => {
            held.delete(key);
            fire();
          }, ms),
        );
        return;
      }
      if (how === "ask") drop(key);
      fire();
    },
    /** Chats with a ring waiting. */
    pending: () => [...held.keys()],
  };
}

const isTauri = () => !!(window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;

type Plugin = typeof import("@tauri-apps/plugin-notification");

/** The desktop plugin, loaded once however many notifications arrive together. */
let plugin: Promise<Plugin> | null = null;
const loadPlugin = (): Promise<Plugin> => (plugin ??= import("@tauri-apps/plugin-notification"));

async function askPermission(): Promise<boolean> {
  try {
    if (isTauri()) {
      const n = await loadPlugin();
      return (await n.isPermissionGranted()) || (await n.requestPermission()) === "granted";
    }
    if (typeof Notification !== "undefined") return Notification.permission === "granted" || (await Notification.requestPermission()) === "granted";
    return false;
  } catch {
    return false;
  }
}

/** Asked once, and what it said holds for the page: several notifications arriving together share the one question. */
let permission: Promise<boolean> | null = null;
const permitted = (): Promise<boolean> => (permission ??= askPermission());

/** The bot to open when manut next gets focus after a desktop notification. The plugin reports a click only while its
 *  listener works, and not every button brings the app forward, so this stays as the way a note still opens its chat. */
let openOnFocus: (() => void) | null = null;
let focusHooked = false;
function armFocusOpen(open: () => void): void {
  openOnFocus = open;
  if (focusHooked || typeof window === "undefined") return;
  focusHooked = true;
  window.addEventListener("focus", () => {
    const fn = openOnFocus;
    openOnFocus = null;
    fn?.();
  });
}

// ---- what a pressed button does ---------------------------------------------------------------------------------------------

/** What the caller does for a notification's buttons: Look first (and a click on the notification) and Approve. */
export interface Handlers {
  open?: () => void;
  /** The card's own answer, Allow once. Only ever called for a notification that carried an Approve button. */
  approve?: () => void | Promise<void>;
}

interface Delivered {
  shown: Shown;
  handlers: Handlers;
  /** Approve was pressed: one answer per notification, whatever the system reports. */
  answered: boolean;
}

/** The notifications shown to the system, by the id each was given, so a pressed button is read against what that
 *  notification offered. Bounded: a notification nobody pressed is forgotten in the end. */
const delivered = new Map<number, Delivered>();
const KEEP = 100;
let lastId = 0;

/** Brings the window forward from wherever it is: hidden in the menu bar, minimised, or behind another app. A button on a
 *  notification does not always bring the app forward by itself. Never throws. */
export async function bringToFront(): Promise<void> {
  try {
    if (!isTauri()) {
      window.focus();
      return;
    }
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    const w = getCurrentWindow();
    await w.unminimize();
    await w.show();
    await w.setFocus();
  } catch {
    /* no window to bring: the app opens on the request the next time the person opens it */
  }
}

/** The plugin reports a pressed button here: `tap` for a click on the notification itself, otherwise the button's id. */
async function performed(e: { actionId?: unknown; notification?: { id?: unknown } | null } | null | undefined): Promise<void> {
  const id = e?.notification?.id;
  const rec = typeof id === "number" ? delivered.get(id) : undefined;
  if (!rec || typeof e?.actionId !== "string") return;
  const pressed = routeAction(e.actionId, rec.shown);
  try {
    if (pressed === "look") {
      await bringToFront();
      rec.handlers.open?.();
    } else if (pressed === "approve" && rec.handlers.approve && !rec.answered) {
      rec.answered = true;
      await rec.handlers.approve();
    } else if (pressed === "later" && openOnFocus && openOnFocus === rec.handlers.open) {
      // Later only dismisses: the chat this note would have opened on the next focus stays closed
      openOnFocus = null;
    }
    // anything this notification did not offer only dismisses
  } catch {
    /* a handler's failure is never the plugin's */
  }
}

/** One listener for the page. Without one the system shows no buttons (tauri-plugin-notification: "Without a listener,
 *  desktop notifications are shown without their actions"), so it exists before the first notification goes out. */
let listening: Promise<boolean> | null = null;
function listen(n: Plugin): Promise<boolean> {
  return (listening ??= n.onAction(performed).then(
    () => true,
    () => false,
  ));
}

/** The action types registered, and the words each was registered with, so a change of language registers it again. */
const registered = new Map<string, string>();
async function actionType(n: Plugin, actions: ShownAction[]): Promise<string | undefined> {
  if (!actions.length) return undefined;
  const id = `manut:${actions.map((a) => a.id).join("+")}`;
  const words = actions.map((a) => a.title).join("\n");
  if (registered.get(id) !== words) {
    await n.registerActionTypes([{ id, actions: actions.map((a) => ({ id: a.id, title: a.title })) }]);
    registered.set(id, words);
  }
  return id;
}

/** macOS names its sounds; the other systems have their own default, which a notification with a sound just gets. */
const SOUND = "Ping";

async function toSystem(shown: Shown, handlers: Handlers): Promise<void> {
  const n = await loadPlugin();
  // If the plugin cannot listen or register, the notification still shows, with no buttons: a click is Look first
  const buttons = (await listen(n)) ? await actionType(n, shown.actions).catch(() => undefined) : undefined;
  lastId = (lastId % 0x7fffffff) + 1;
  const id = lastId;
  delivered.set(id, { shown, handlers, answered: false });
  if (delivered.size > KEEP) delivered.delete(delivered.keys().next().value as number);
  n.sendNotification({
    id,
    title: shown.title,
    body: shown.body,
    ...(shown.sound && isMacPlatform() ? { sound: SOUND } : {}),
    ...(buttons ? { actionTypeId: buttons } : {}),
  });
}

// ---- showing ---------------------------------------------------------------------------------------------------------------

/** When a "waited while the Mac slept" notice was last shown (the wake's time), so one wake shows it once. */
let lastWaitedShownAt: number | undefined;

/** Asks already given their one chance to notify. A request asked again (a replay of the shop after a reconnect) does not
 *  ring again, and one that waited out quiet hours does not ring when they end: it waits in the app. */
const notified = new Set<string>();

/** The one way anything is shown outside the window: notify-rules rules on it (quiet hours, hidden details, sound and
 *  buttons), then it goes to the system. True when it was shown. Never throws: notifications are best effort. */
export async function showOutside(src: Outside, handlers: Handlers = {}, tag = "", focusOpen = false, waiting = 1): Promise<boolean> {
  const settings = outsideSettings();
  const context: PresentContext = { hideDetails: settings.hideDetails, quiet: settings.quiet, now: Date.now(), waiting, lastWaitedShownAt };
  const shown = presentOutside(src, context);
  if (!shown || !(await permitted())) return false;
  try {
    if (isTauri()) {
      await toSystem(shown, handlers);
      if (focusOpen && handlers.open && !windowWatched()) armFocusOpen(handlers.open);
    } else {
      const n = new Notification(shown.title, { body: shown.body, tag });
      n.onclick = () => {
        window.focus();
        handlers.open?.();
        n.close();
      };
    }
    if (shown.wokeAt !== undefined) lastWaitedShownAt = shown.wokeAt;
    return true;
  } catch {
    return false;
  }
}

/** Show `note`. `onClick` opens that bot's chat (or the request): on a click, or with `focusOpen` when the desktop app next
 *  gets focus after it was shown in the background. `approve` answers Allow once, for a request that may be approved from
 *  here. True when it was shown. Never throws. */
export async function showNote(note: Note, onClick?: () => void, focusOpen = false, approve?: () => void | Promise<void>): Promise<boolean> {
  if (note.ask) {
    if (notified.has(note.ask.id)) return false;
    notified.add(note.ask.id);
  }
  const src: Outside = note.ask
    ? { kind: "request", approval: note.ask.approval, member: note.ask.member, summary: note.body, canApprove: note.ask.canApprove, ...(note.ask.action === undefined ? {} : { action: note.ask.action }) }
    : { kind: "notice", title: note.title, body: note.body };
  return showOutside(src, { open: onClick, approve }, note.tag, focusOpen, note.ask?.waiting ?? 1);
}

/** Work that waited while the Mac slept, shown once after it woke (`wokeAt`, ms) and only if something waited. */
export function showWoke(count: number, wokeAt: number, open?: () => void): Promise<boolean> {
  return showOutside({ kind: "slept", count, wokeAt }, { open }, "manut:slept");
}

/** A helper signed in on a new device at a shop the person owns: the owner's alert (docs/people.md, "A helper's new device").
 *  It goes through `showOutside` like every notification, so notify-rules rules on it: quiet hours never silence it, and
 *  Hide details hides the helper and the shop. Each sign-in has a notification of its own (the tag carries its id). `open`
 *  is Look first; Later only dismisses. `at` is ms. True when it was shown. Never throws. */
export function showNewDevice(sign: { id: string; helper: string; shop: string; at: number }, open?: () => void): Promise<boolean> {
  return showOutside({ kind: "new_device", helper: { name: sign.helper, shop: sign.shop, at: sign.at } }, { open }, `manut:device:${sign.id}`);
}

/** True while the person can see the manut window. */
export function windowWatched(): boolean {
  return typeof document !== "undefined" && document.visibilityState === "visible" && document.hasFocus();
}
