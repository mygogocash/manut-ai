// Keeps the row marks (rows.ts) true to what happens in the app, from the one place that sees it all (the sidebar mounts it):
//  - an ask (an approval or a question) of a snoozed or settled row clears its mark at once, so the row is back where it was and
//    stays back after the ask is answered; a terminal that rang does the same;
//  - opening a settled row brings it back;
//  - a snooze that has run out is dropped when its time comes, so the row returns on time with no other event; and
//  - the marks of a lane or terminal session that was closed go with it.
// It draws nothing. It is read-only for everything but the marks.
import { useEffect } from "react";
import { getSessions, useSessions } from "../sessions/sessions";
import { selectSidebarBots, selectAsks, useStore } from "../state/store";
import { rowStatus } from "../threads/ThreadTree";
import { markRow, nextWake, sessionRowKey, sweepRows, threadRowKey, useRowMarks, wakeRows } from "./rows";

/** The longest a timer may wait (a browser keeps the delay in 31 bits). */
const LONGEST = 2_147_483_647;

/** The keys of the rows that wait on the person: a chat with an open ask, a lane whose chat has one, a terminal that rang. */
export function needingKeys(i: {
  chats: ReadonlyArray<{ bot: string; thread: string; needs: boolean }>;
  sessions: ReadonlyArray<{ id: string; chat: string | null; rang: boolean }>;
  askedChats: ReadonlySet<string>;
}): string[] {
  return [
    ...i.chats.filter((c) => c.needs).map((c) => threadRowKey(c.bot, c.thread)),
    ...i.sessions.filter((x) => x.rang || (x.chat !== null && i.askedChats.has(x.chat))).map((x) => sessionRowKey(x.id)),
  ];
}

export function RowsWatcher() {
  const s = useStore();
  const ss = useSessions();
  const marks = useRowMarks();

  // the rows that wait on the person now
  const members = selectSidebarBots(s).map((b) => b.name);
  const needing = needingKeys({
    chats: members.flatMap((bot) => (s.threads[bot] ?? []).map((row) => ({ bot, thread: row.thread, needs: rowStatus(s, bot, row) === "needs_you" }))),
    sessions: ss.list.map((r) => ({ id: r.id, chat: getSessions().chatKey(r.id), rang: ss.unseen[r.id] === "bell" })),
    askedChats: new Set(selectAsks(s).map((a) => a.bot)),
  });
  const needKey = needing.join("\n");
  // again whenever the marks change: an Undo (item 94) puts back the mark a row had, and a row that asks something since must not
  // be put away by it (wakeAll changes nothing, and so writes nothing, when no row that asks has such a mark)
  useEffect(() => {
    if (needKey) wakeRows(needKey.split("\n"));
  }, [needKey, marks]);

  // the row open in the main column
  const open = s.ui.view === "chat" && s.selectedBot && s.ui.thread ? threadRowKey(s.selectedBot, s.ui.thread) : s.ui.view === "session" && s.ui.session ? sessionRowKey(s.ui.session) : null;
  useEffect(() => {
    if (open) markRow(open, { do: "open" });
  }, [open]);

  // a closed session's marks go, and a snooze that has run out
  const alive = ss.list.map((r) => r.id).join("\n");
  useEffect(() => {
    const ids = new Set(alive ? alive.split("\n") : []);
    sweepRows((key) => !key.startsWith("session:") || ids.has(key.slice("session:".length)));
  }, [alive]);
  const wake = nextWake(marks, Date.now());
  useEffect(() => {
    if (wake === null) return;
    const id = setTimeout(() => sweepRows(() => true), Math.min(Math.max(wake - Date.now(), 0) + 50, LONGEST));
    return () => clearTimeout(id);
  }, [wake]);

  return null;
}
