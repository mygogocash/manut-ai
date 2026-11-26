// The store as a paired phone reaches it: its chats reduced to what project.ts shows (fromStore), and the four things a
// phone may have done (storeActions), each through the store's own action that the Mac's buttons use. Allow once and No
// go through `settleApproval` (chat/cards/respond.ts), exactly as the ask card's buttons do, with the phone's device id as
// who decided, so approval-core's rule that an ask settles once holds for the phone as for the Mac. An answer goes
// through `respondClarify`, and Stop through `interrupt`, for that chat.
import { settleApproval, respond } from "../chat/cards/respond";
import type { ClarifyAnswers } from "../lib/protocol";
import { type AppState, type ApprovalItem, type ClarifyItem, type Store, askFrom, askOpen } from "../state/store";
import type { ChatSource, SourceItem } from "./project";
import type { ChatSources, MacActions } from "./serve";

function approvalOf(chat: AppState["chats"][string], item: ApprovalItem): SourceItem {
  const from = item.subagent?.name ?? item.shop?.name;
  return {
    kind: "approval",
    id: item.request_id,
    ts: item.ts,
    open: askOpen(chat.items, item),
    title: item.title,
    command: item.command,
    ...(item.cwd ? { cwd: item.cwd } : {}),
    ...(item.plan ? { plan: item.plan } : {}),
    // An ask the person may only pass on to the shop's owner is decided by no one here, phone or not.
    choices: item.passOn ? [] : item.choices,
    ...(item.outdated ? { outdated: true } : {}),
    ...(item.resolved ? { resolved: item.resolved } : {}),
    ...(item.expired ? { expired: item.expired } : {}),
    ...(from ? { from } : {}),
  };
}

function questionOf(chat: AppState["chats"][string], item: ClarifyItem): SourceItem {
  return {
    kind: "clarify",
    id: item.request_id,
    ts: item.ts,
    open: askOpen(chat.items, item),
    question: item.question,
    ...(item.choices?.length ? { choices: item.choices } : {}),
    ...(item.multi ? { multi: true } : {}),
    ...(item.questions?.length
      ? { questions: item.questions.map((q) => ({ id: q.qid, question: q.question, ...(q.choices?.length ? { choices: q.choices } : {}), ...(q.multi_select ? { multi: true } : {}) })) }
      : {}),
    ...(item.answer !== undefined ? { answered: true } : {}),
    ...(item.expired ? { expired: item.expired } : {}),
    ...(item.subagent?.name ? { from: item.subagent.name } : {}),
  };
}

/** One chat of the store as a phone may see it. */
export function sourceOf(state: AppState, key: string): ChatSource | null {
  const chat = state.chats[key];
  if (!chat) return null;
  const items: SourceItem[] = [];
  let updatedAt = 0;
  for (const item of chat.items) {
    updatedAt = Math.max(updatedAt, item.ts);
    if (item.kind === "user" || item.kind === "assistant") {
      // A message still held on the Mac (the steer queue) has not been sent; the phone sees what the chat holds.
      if (!item.held) items.push({ kind: "message", id: item.id, role: item.kind, text: item.text, ts: item.ts });
    } else if (item.kind === "approval") items.push(approvalOf(chat, item));
    else if (item.kind === "clarify") items.push(questionOf(chat, item));
  }
  return { key, title: askFrom(state, key), working: !!chat.turn, step: chat.turn?.status || null, updatedAt, items };
}

/** The store's chats, read fresh on every call, so a phone always gets what the Mac shows now. */
export function fromStore(store: Pick<Store, "getState">): ChatSources {
  return {
    list: () => {
      const state = store.getState();
      return Object.keys(state.chats)
        .map((key) => sourceOf(state, key))
        .filter((c): c is ChatSource => c !== null && c.items.length > 0)
        .sort((a, b) => b.updatedAt - a.updatedAt);
    },
    get: (chat) => sourceOf(store.getState(), chat),
  };
}

function approvalItem(store: Pick<Store, "getState">, chat: string, ask: string): ApprovalItem | null {
  const item = store.getState().chats[chat]?.items.find((i): i is ApprovalItem => i.kind === "approval" && i.request_id === ask);
  return item ?? null;
}

/** What a phone may have the Mac do, through the store. */
export function storeActions(store: Pick<Store, "getState" | "actions">): MacActions {
  return {
    allowOnce: async (chat, ask, by) => {
      const item = approvalItem(store, chat, ask);
      return item ? settleApproval(store, chat, item, "once", by) : "gone";
    },
    decline: async (chat, ask, by) => {
      const item = approvalItem(store, chat, ask);
      return item ? settleApproval(store, chat, item, "deny", by) : "gone";
    },
    answer: async (chat, ask, answer) => {
      const item = store.getState().chats[chat]?.items.find((i): i is ClarifyItem => i.kind === "clarify" && i.request_id === ask);
      if (!item) return "gone";
      return respond(store, chat, item.id, () => store.actions.respondClarify(ask, answer as string | ClarifyAnswers, chat));
    },
    stop: async (chat) => {
      if (!store.getState().chats[chat]?.turn) return "no_turn";
      await store.actions.interrupt(chat);
      return null;
    },
  };
}
