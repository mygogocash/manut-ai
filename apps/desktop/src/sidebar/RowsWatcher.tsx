// Keeps the row marks (rows.ts) true to what happens in the app, from the one place that sees it all (the sidebar mounts it):
//  - an ask (an approval or a question) of a snoozed or settled row clears its mark at once, so the row is back where it was and
//    stays back after the ask is answered; a terminal that rang does the same;
//  - opening a settled row brings it back;
//  - a snooze that has run out is dropped when its time comes, so the row returns on time with no other event; and
//  - the marks of a lane or terminal session the person closed go with it (item 94: only one this run saw open, since the marks
//    are kept across a restart and the sessions' list comes back after this first draws).
// It draws nothing. It is read-only for everything but the marks.
import { useEffect } from "react";
import { getSessions, useSessions } from "../sessions/sessions";
import { selectSidebarBots, selectAsks, useStore } from "../state/store";
import { rowStatus } from "../threads/ThreadTree";
import { isSessionKey, markRow, nextWake, sessionRowKey, sweepRows, threadRowKey, useRowMarks, wakeRows } from "./rows";

/** The longest a timer may wait (a browser keeps the delay in 31 bits). */
const LONGEST = 2_147_483_647;

/** The keys of the rows that wait on the person: a chat with an open ask, a lane whose chat has one, a terminal that rang. */
export function needingKeys(i: {
  chats: ReadonlyArray<{ bot: string; thread: string; needs: boolean }>;
  /** Each session by its row key (rows.ts `sessionRowKey`), its chat's key and whether it rang. */
  sessions: ReadonlyArray<{ key: string; chat: string | null; rang: boolean }>;
  askedChats: ReadonlySet<string>;
}): string[] {
  return [
    ...i.chats.filter((c) => c.needs).map((c) => threadRowKey(c.bot, c.thread)),
    ...i.sessions.filter((x) => x.rang || (x.chat !== null && i.askedChats.has(x.chat))).map((x) => x.key),
  ];
}

/** Whether the marks of `key` stay: a chat's always; a session's while it is listed (`now`), or when this run never saw it listed
 *  (`seen`), since its session may not be back yet after a restart. A session seen and then gone was closed. */
export function keepsMark(key: string, now: ReadonlySet<string>, seen: ReadonlySet<string>): boolean {
  return !isSessionKey(key) || now.has(key) || !seen.has(key);
}

/** The session row keys this run has seen listed. */
const seen = new Set<string>();

export function RowsWatcher() {
  const s = useStore();
  const ss = useSessions();
  const marks = useRowMarks();

  // the rows that wait on the person now
  const members = selectSidebarBots(s).map((b) => b.name);
  const needing = needingKeys({
    chats: members.flatMap((bot) => (s.threads[bot] ?? []).map((row) => ({ bot, thread: row.thread, needs: rowStatus(s, bot, row) === "needs_you" }))),
    sessions: ss.list.map((r) => ({ key: sessionRowKey(r), chat: getSessions().chatKey(r.id), rang: ss.unseen[r.id] === "bell" })),
    askedChats: new Set(selectAsks(s).map((a) => a.bot)),
  });
  const needKey = needing.join("\n");
  // again whenever the marks change: an Undo (item 94) puts back the mark a row had, and a row that asks something since must not
  // be put away by it (wakeAll changes nothing, and so writes nothing, when no row that asks has such a mark)
  useEffect(() => {
    if (needKey) wakeRows(needKey.split("\n"));
  }, [needKey, marks]);

  // the row open in the main column
  const openRec = s.ui.view === "session" && s.ui.session ? ss.list.find((r) => r.id === s.ui.session) : undefined;
  const open = s.ui.view === "chat" && s.selectedBot && s.ui.thread ? threadRowKey(s.selectedBot, s.ui.thread) : openRec ? sessionRowKey(openRec) : null;
  useEffect(() => {
    if (open) markRow(open, { do: "open" });
  }, [open]);

  // a closed session's marks go, and a snooze that has run out. A row closed with Undo still open (closeGrace.ts) is not gone yet.
  const listed = [...ss.list, ...getSessions().closing().map((g) => g.data.rec)].map((r) => sessionRowKey(r));
  const alive = listed.join("\n");
  useEffect(() => {
    const now = new Set(alive ? alive.split("\n") : []);
    for (const k of now) seen.add(k);
    sweepRows((key) => keepsMark(key, now, seen));
  }, [alive]);
  const wake = nextWake(marks, Date.now());
  useEffect(() => {
    if (wake === null) return;
    const id = setTimeout(() => sweepRows(() => true), Math.min(Math.max(wake - Date.now(), 0) + 50, LONGEST));
    return () => clearTimeout(id);
  }, [wake]);

  return null;
}
