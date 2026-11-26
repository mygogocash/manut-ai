// The page's reader of another chat (item 97, threadContext.ts `ContextReader`), over the store, the sessions and the shell it is
// handed: the box passes the app's own, a test its stand-ins. Everything here only reads. A member's thread is read from what the
// store holds, else from the runtime (`readThread`, which opens no chat); a coding chat from its session, and its lane's files
// from the lane's own diff, else from what the chat's events said changed.
import { askText, selectAsks, type Actions, type AppState } from "../../state/store";
import { threadKey } from "../../threads/types";
import type { SessionsStore } from "../../sessions/sessions";
import type { ReadsLaneFolder } from "../../code/laneFolder";
import { changedFiles } from "../../code/changes";
import { folderName } from "../../sessions/agents";
import { pickTitle } from "../../sessions/titles";
import { accountGroups } from "../../settings/accounts/useAccounts";
import type { AccountGroup } from "../../lib/protocol";
import { t } from "../../i18n";
import { chatScope } from "./scope";
import type { ContextReader, ReadMsg, ThreadRef } from "./threadContext";

export interface ReaderParts {
  store: { getState(): AppState; actions: Pick<Actions, "readThread"> };
  sessions: Pick<SessionsStore, "getState" | "chatKey" | "byKey">;
  host: ReadsLaneFolder;
  /** The coding accounts as Settings › Providers lists them (a draft's account); the app's own by default. */
  groups?: () => AccountGroup[] | null;
}

export function appReader(p: ReaderParts): ContextReader {
  const state = () => p.store.getState();
  const rec = (id: string) => p.sessions.getState().list.find((r) => r.id === id) ?? null;
  const row = (bot: string, thread: string) => (state().threads[bot] ?? []).find((r) => r.thread === thread);
  const groups = p.groups ?? accountGroups;
  return {
    chatKey: (ref) => (ref.kind === "thread" ? (row(ref.bot, ref.thread) ? threadKey(ref.bot, ref.thread) : null) : p.sessions.chatKey(ref.id)),
    title: (ref) => {
      if (ref.kind === "thread") return row(ref.bot, ref.thread)?.title || t("thread.untitled");
      const r = rec(ref.id);
      return r ? pickTitle(r, folderName(r.cwd)).title : t("ss.session");
    },
    held: (key) => {
      const c = state().chats[key];
      if (!c || (!c.loaded && !c.messages.length)) return null;
      return c.messages.map((m): ReadMsg => ({ role: m.role, text: m.text }));
    },
    read: async (ref) => (ref.kind === "thread" ? p.store.actions.readThread(ref.bot, ref.thread) : []),
    ask: (key) => {
      const a = selectAsks(state()).find((x) => x.bot === key);
      return a ? askText(a.item) : null;
    },
    lane: async (ref) => {
      if (ref.kind !== "session") return null;
      const r = rec(ref.id);
      const key = p.sessions.chatKey(ref.id);
      if (!r || !key) return null;
      // the lane's own folder is the truth (code/laneFolder.ts); where it cannot be read, what the chat's events said changed
      if (r.lane?.dir) {
        try {
          const f = await p.host.laneDiff(r.lane.dir);
          if (f) return { files: f.files, moreFiles: f.moreFiles };
        } catch {
          /* read from the events below */
        }
      }
      return { files: changedFiles(state().chats[key]), moreFiles: 0 };
    },
    scope: (key) => chatScope(key, state().shops.current, p.sessions.byKey(key), groups()),
  };
}

/** Whether `ref` is a chat a reader can bring at all (its row is listed, or its session has a chat). */
export const bringable = (r: ContextReader, ref: ThreadRef): boolean => r.chatKey(ref) !== null;
