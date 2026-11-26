// The questions the views ask of the state: a bot's timeline, the asks still waiting and how they read, the
// sidebar's bots, the shop's name. Split out of store.ts (item 125d), which re-exports every one. The two
// memos are module-level and live here only.
import { maskCommand, revealHidden } from "../lib/secrets";
import { t as tr } from "../i18n";
import type { Bot, ShopRow } from "../lib/protocol";
import type { SubagentRow, ApprovalItem, ClarifyItem, ChatItem, TimelineItem, AppState } from "./types";
import { subagentEnded } from "./helpers";
import { chatRoute } from "./chatRoutes";

// ---- selectors ------------------------------------------------------------------------------

/**
 * The bot's timeline: its chat rows in order. The bot's sessions elsewhere (Slack, Discord, cron) are not placed in
 * it: the header's "N other places" and the side panel show them (khope: answers from other channels in this chat,
 * with nothing saying where they came from, made the chat hard to follow).
 */
export function selectTimeline(state: AppState, bot: string): TimelineItem[] {
  return state.chats[bot]?.items ?? EMPTY_ITEMS;
}
const EMPTY_ITEMS: ChatItem[] = [];

/** A shop's name as the app shows it: its own; or, for a shop the person owns that the runtime lists unnamed (Practice's
 *  own shop, which is the demo team's), the name the first-run setup took on this computer. "" when neither names it. */
export function shopName(state: Pick<AppState, "ui">, shop: Pick<ShopRow, "name" | "role">): string {
  return shop.name || (shop.role === "owner" ? state.ui.shop.shop : "");
}

/** The shop every page shows, as the account row and Home name it: the one the runtime shows when it lists the person's
 *  shops, else the shop the first-run setup took on this computer; "" when neither names one. */
export function viewedShopName(state: Pick<AppState, "shops" | "ui">): string {
  const current = state.shops.list.find((s) => s.id === state.shops.current);
  return current ? shopName(state, current) : state.ui.shop.shop;
}

/** One approval or question still waiting on the person, in any bot's chat. */
export interface Ask {
  bot: string;
  item: ApprovalItem | ClarifyItem;
  /** seconds since epoch */
  ts: number;
}

/** False once the ask is answered, expired, or what raised it is gone: the turn it was asked in is over (it went
 *  unanswered), or the subagent that asked has ended. An ask of a subagent follows that subagent, not the turn: a
 *  background one runs on after the turn and still waits for the answer (Claude Code asks after its `result`, and
 *  keeps waiting on an ask its turn left open). An ask raised while no turn ran stays open until answered, expired
 *  (the agent withdrew it, or its session ended) or its subagent ends. */
export function askOpen(items: ChatItem[], it: ApprovalItem | ClarifyItem): boolean {
  if (it.expired) return false;
  if (it.kind === "approval" ? !!it.resolved : it.answer !== undefined) return false;
  let sub: SubagentRow | undefined;
  let owner: number | undefined;
  for (const i of items) {
    if (i.kind !== "activity") continue;
    if (i.turn.startedAt <= it.ts * 1000 + 1) owner = i.turn.endedAt ?? -1;
    if (it.subagent?.id) for (const f of i.turn.fanouts ?? []) sub = f.subs.find((s) => s.id === it.subagent!.id) ?? sub;
  }
  if (sub) return !subagentEnded(sub);
  return !!it.outside || owner === undefined || owner === -1;
}

let asksCache: { chats: AppState["chats"]; out: Ask[] } | null = null;

/** Every open ask across bots, oldest first. Memoised on `state.chats`, so safe to call from render. */
export function selectAsks(state: AppState): Ask[] {
  if (asksCache && asksCache.chats === state.chats) return asksCache.out;
  const out: Ask[] = [];
  for (const [bot, chat] of Object.entries(state.chats)) {
    for (const it of chat.items) {
      if ((it.kind === "approval" || it.kind === "clarify") && askOpen(chat.items, it)) out.push({ bot, item: it, ts: it.ts });
    }
  }
  out.sort((a, b) => a.ts - b.ts);
  asksCache = { chats: state.chats, out };
  return out;
}

/** Who an ask comes from, as the Needs-you list names it: the bot's name, or for a SESSIONS chat its route's
 *  label (the session's folder and agent, "web-app · Claude Code"). */
export function askFrom(state: AppState, key: string): string {
  return chatRoute(key)?.label ?? state.bots.find((b) => b.name === key)?.display_name ?? key;
}

/** One plain line for an ask: "Allow `rm -rf build/`?" or the (first) question. A command's keys are masked as on its
 *  card (maskCommand), never anything else in it; a browser write's sentence is as typed. Every character that does not
 *  show, or that reorders what does, is a visible mark, as on the card (item 121). */
export function askText(it: ApprovalItem | ClarifyItem): string {
  if (it.kind === "approval") return it.command ? tr("ask.allowCmd", { cmd: `\`${it.whole ? revealHidden(it.command) : maskCommand(it.command)}\`` }) : revealHidden(it.title) || tr("ask.allowThis");
  const n = it.questions?.length ?? 0;
  return revealHidden(n > 1 ? tr("ask.questions", { n, first: it.questions![0].question }) : it.question);
}

let sideCache: { bots: Bot[]; pinned: string[]; roster: string[] | null; out: Bot[] } | null = null;

/** The sidebar's bots: the roster's bots that Hermes still lists, pinned ones first (in pin order), then the rest
 *  in the order they joined. ⌘1…⌘9 follow this order too. Memoised. */
export function selectSidebarBots(state: AppState): Bot[] {
  const { bots } = state;
  const { pinned, roster } = state.ui;
  if (sideCache && sideCache.bots === bots && sideCache.pinned === pinned && sideCache.roster === roster) return sideCache.out;
  const listed = (roster ?? []).map((n) => bots.find((b) => b.name === n)).filter((b): b is Bot => !!b);
  const pins = pinned.map((n) => listed.find((b) => b.name === n)).filter((b): b is Bot => !!b);
  const out = [...pins, ...listed.filter((b) => !pinned.includes(b.name))];
  sideCache = { bots, pinned, roster, out };
  return out;
}

/** Profiles on this computer that are not in the roster: what the sidebar `+` offers, as Hermes lists them. */
export function selectUnlisted(state: AppState): Bot[] {
  const roster = state.ui.roster ?? [];
  return state.bots.filter((b) => !roster.includes(b.name));
}

export function selectUnreadTotal(state: AppState): number {
  return Object.values(state.unread).reduce((a, b) => a + b, 0);
}
