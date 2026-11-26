// Home's rules, kept apart from its markup so they can be tested without a page, as menu.ts and team.ts are. Home is
// the design canvas's Main.dc.html: the ask box with its three modes, a few of the asks waiting on the person, and who
// is working now. Everything here reads what the store already holds, so nothing on Home is a made-up number.
import { t, type Key } from "../i18n";
import type { Bot } from "../lib/protocol";
import { askText, type Actions, type ApprovalItem, type Ask, type Chat, type ClarifyItem } from "../state/store";
import { riskOf } from "../chat/cards/risk";
import { maskCommand, revealHidden, showCommand } from "../lib/secrets";
import { asksOf, memberStatus } from "./team";

export type HomeMode = "chat" | "team" | "code";

/** The ask box's modes, in the canvas's order. */
export const HOME_MODES: readonly HomeMode[] = ["chat", "team", "code"];

/** The canvas opens Home on Team (Main.dc.html: `s.mode || 'team'`), and so does the app, each time Home opens. */
export const FIRST_MODE: HomeMode = "team";

/** What a mode says on Home: its button, the word beside the brand in the lockup, the box's placeholder, the
 *  suggestions' title (which also names the box) and the four suggestions. */
export interface ModeWords {
  label: Key;
  word: Key;
  placeholder: Key;
  title: Key;
  chips: readonly Key[];
}

/** The canvas's words for each mode (the `sets` in Main.dc.html's logic; canvas.json only places the board). */
export const MODE_WORDS: Record<HomeMode, ModeWords> = {
  chat: {
    label: "home.mode.chat",
    word: "home.word.chat",
    placeholder: "home.ph.chat",
    title: "home.sugg.chat",
    chips: ["home.chip.chat1", "home.chip.chat2", "home.chip.chat3", "home.chip.chat4"],
  },
  team: {
    label: "home.mode.team",
    word: "home.word.team",
    placeholder: "home.ph.team",
    title: "home.sugg.team",
    chips: ["home.chip.team1", "home.chip.team2", "home.chip.team3", "home.chip.team4"],
  },
  code: {
    label: "home.mode.code",
    word: "home.word.code",
    placeholder: "home.ph.code",
    title: "home.sugg.code",
    chips: ["home.chip.code1", "home.chip.code2", "home.chip.code3", "home.chip.code4"],
  },
};

/** The member Code talks to. The runtime marks no member as the engineer, so Kit is found by the name that the
 *  canvas's team and the runtime's own team both use. */
export const KIT = "kit";

/** Kit, when Kit is among the listed members; otherwise nobody. */
export function kitOf(listed: readonly string[]): string | null {
  return listed.includes(KIT) ? KIT : null;
}

/** The modes Home offers. Code is a conversation with Kit, so it is left out while the team has no Kit, as the app
 *  leaves out anything the runtime cannot do; the Code row of the menu still leads to the terminals. */
export function offeredModes(kit: string | null): HomeMode[] {
  return HOME_MODES.filter((m) => m !== "code" || kit !== null);
}

/** Where an ask goes: a new thread under a member, or that member's main chat. */
export interface AskRoute {
  to: "thread" | "main";
  bot: string;
}

/** Where each mode sends an ask. Chat starts a new thread with Buddy, a conversation of its own. Team goes to Buddy's
 *  main chat, the one place where Buddy hands work to the team and opens a thread for a job. Code starts a new thread
 *  with Kit: the app holds a coding conversation as a member's thread since threads replaced chat-mode coding
 *  sessions (src/sessions/entry.ts), and a terminal session takes no first prompt. Null while there is nobody to take
 *  the ask. `home` is the member homeBot names (Buddy). */
export function askRoute(mode: HomeMode, home: string | null, kit: string | null): AskRoute | null {
  if (mode === "code") return kit ? { to: "thread", bot: kit } : null;
  if (!home) return null;
  return mode === "chat" ? { to: "thread", bot: home } : { to: "main", bot: home };
}

/** Where a send from Home went: the member's main chat, or the thread it started. */
export type Sent = { to: "main"; bot: string } | { to: "thread"; bot: string; thread: string };

/** Sends `text` where `route` says, through the store's own actions: `sendTo` opens a member's main chat and sends
 *  there, `newThreadWith` opens a new thread and sends its first message. With `stay` (Cmd+Enter, item 95) nothing is
 *  opened: `sendAway` sends to the main chat where it is, and the new thread is made without opening it. Null when the
 *  thread could not be made, so the ask box keeps the words. */
export async function sendAsk(actions: Pick<Actions, "sendTo" | "sendAway" | "newThreadWith">, route: AskRoute, text: string, stay = false): Promise<Sent | null> {
  if (route.to === "main") {
    await (stay ? actions.sendAway(route.bot, text) : actions.sendTo(route.bot, text));
    return { to: "main", bot: route.bot };
  }
  const thread = await actions.newThreadWith(route.bot, text, stay);
  return thread === null ? null : { to: "thread", bot: route.bot, thread };
}

/** Whether Home may offer Approve on an ask, beside Look first. Only for an approval whose chat card would show no more
 *  than Home does: one that offers Allow once (the choice Approve sends) and names its exact action (the command), with
 *  no plan to read, no folder it runs in, no risk warning, no subagent asking, and a command its card shows with no note
 *  (item 121: not one shown as it is because it may hold a key, nor one that holds hidden characters). Every other ask is
 *  settled on its card, after Look first.
 *  Either way it goes through the one approval path the card uses (chat/cards/respond.ts). */
export function canApproveHere(item: ApprovalItem | ClarifyItem): item is ApprovalItem {
  return (
    item.kind === "approval" &&
    item.choices.includes("once") &&
    item.command.trim() !== "" &&
    !item.plan &&
    !item.cwd &&
    !item.subagent &&
    riskOf(item.command).length === 0 &&
    plainCommand(item)
  );
}

/** Whether an approval's card shows its command with no note: not one shown as it is because it may hold a key, nor one
 *  that holds characters that do not show (item 121). */
function plainCommand(item: ApprovalItem): boolean {
  if (item.whole) return revealHidden(item.command) === item.command;
  const shown = showCommand(item.command);
  return !shown.unmasked && !shown.hidden;
}

/** An ask in the words of its chat card: an approval's title (or the card's own words for an untitled one, or for one
 *  that starts on a plan) over the exact action it names, and whether that action must be shown whole (a browser write's
 *  sentence, never cut or scrolled away, as its card shows it); a question as asked, or an interview's count and first
 *  question. */
export function askLines(item: ApprovalItem | ClarifyItem): { title: string; action: string | null; whole: boolean } {
  if (item.kind === "clarify") return { title: askText(item), action: null, whole: false };
  // as its card shows it: a browser write's sentence exactly as typed, any other command whole with only its keys masked
  // (maskCommand, item 117), each with every character that does not show as a visible mark (item 121)
  const action = item.command.trim() ? (item.whole ? revealHidden(item.command) : maskCommand(item.command)) : null;
  return {
    title: item.plan ? t("card.startPlan") : revealHidden(item.title) || t("card.approvalNeeded"),
    action,
    whole: action !== null && !!item.whole,
  };
}

/** How many open asks Home lists; the rest are a press away on Needs you. Three two-line rows fit, as they did in the
 *  sidebar's old Needs-you list. */
export const HOME_ASKS = 3;

/** An ask as Home lists it: still open, or settled here. */
export interface HomeAsk extends Ask {
  settled: boolean;
}

/** The asks Home lists under Needs you: the `n` newest open ones, and the ones approved here since Home opened, each
 *  in its place by when it was asked, newest first. An ask approved here stays as its settled line instead of
 *  jumping out of the list; one that is open again (its approval was not taken) is listed once, open. */
export function homeAsks(open: readonly Ask[], settled: readonly Ask[], n = HOME_ASKS): HomeAsk[] {
  const key = (a: Ask) => `${a.bot}\n${a.item.id}`;
  const isOpen = new Set(open.map(key));
  const newest = [...open].sort((a, b) => b.ts - a.ts).slice(0, n);
  const rows = [...newest.map((a) => ({ ...a, settled: false })), ...settled.filter((a) => !isOpen.has(key(a))).map((a) => ({ ...a, settled: true }))];
  // The sort is stable, so asks of the same moment keep the order above.
  return rows.sort((a, b) => b.ts - a.ts);
}

/** An ask Home approved: the chat it was asked in and its card's id. */
export interface DoneHere {
  bot: string;
  id: string;
}

/** The asks approved from Home that the store now shows settled, read from the chats they were asked in, each once. One
 *  that is gone, one that was not taken after all and anything that is not an approval are left out. */
export function settledAsks(chats: Readonly<Record<string, Pick<Chat, "items">>>, done: readonly DoneHere[]): Ask[] {
  const out: Ask[] = [];
  const seen = new Set<string>();
  for (const { bot, id } of done) {
    const key = `${bot}\n${id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const it = chats[bot]?.items.find((i) => i.id === id);
    if (it?.kind === "approval" && it.resolved) out.push({ bot, item: it, ts: it.ts });
  }
  return out;
}

/** A member at work, as Working now lists it. */
export interface Working {
  name: string;
  displayName: string;
  description: string;
  /** what the running turn says it is doing ("Drafting the post"); "" when its main chat has no turn to say it */
  status: string;
  /** when that turn started (ms), or null */
  since: number | null;
}

/** The listed members who are working, by the Team page's own rule (team.ts `memberStatus`): a member whose ask waits
 *  is under Needs you instead, and one the runtime cannot reach is not working. Each with what its running turn says
 *  and when the turn started, when its main chat has one. */
export function workingMembers(listed: readonly Bot[], chats: Readonly<Record<string, Chat>>, asks: readonly Ask[]): Working[] {
  return listed
    .filter((b) => memberStatus(b, chats[b.name], asksOf(asks, b.name).length) === "working")
    .map((b) => {
      const turn = chats[b.name]?.turn ?? null;
      return { name: b.name, displayName: b.display_name, description: b.description, status: turn?.status ?? "", since: turn?.startedAt ?? null };
    });
}

/** How long a turn has run: "38s", "3m", "2h". */
export function elapsed(since: number, nowMs: number): string {
  const s = Math.max(0, Math.floor((nowMs - since) / 1000));
  if (s < 60) return t("unit.s", { n: s });
  if (s < 3600) return t("unit.m", { n: Math.floor(s / 60) });
  return t("unit.h", { n: Math.floor(s / 3600) });
}
