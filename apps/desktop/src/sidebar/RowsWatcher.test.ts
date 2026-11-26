// Which rows wait on the person, which is what brings a snoozed or settled row back (RowsWatcher.tsx, rows.ts).
import { describe, expect, it } from "vitest";
import { keepsMark, needingKeys } from "./RowsWatcher";

describe("the rows that wait on the person", () => {
  it("names a chat with an open ask, a lane whose chat has one and a terminal that rang, and no calm row", () => {
    const keys = needingKeys({
      chats: [
        { bot: "buddy", thread: "t1", needs: true },
        { bot: "buddy", thread: "t2", needs: false },
      ],
      sessions: [
        { key: "lane:/home/me/.manut/lanes/web/promptpay", chat: "agent:lane", rang: false },
        { key: "lane:/home/me/.manut/lanes/web/calm", chat: "agent:calm", rang: false },
        { key: "session:term7link", chat: null, rang: true },
        { key: "session:quietlink", chat: null, rang: false },
      ],
      askedChats: new Set(["agent:lane"]),
    });
    expect(keys).toEqual(["thread:buddy:t1", "lane:/home/me/.manut/lanes/web/promptpay", "session:term7link"]);
  });
});

describe("the marks a closed session takes with it (item 94)", () => {
  it("keeps a chat's always, a listed session's, and one this run never saw listed (its session may not be back yet)", () => {
    const now = new Set(["session:a"]);
    const seen = new Set(["session:a", "lane:/l/b"]);
    expect(keepsMark("thread:buddy:t", now, seen)).toBe(true);
    expect(keepsMark("session:a", now, seen)).toBe(true);
    expect(keepsMark("session:after-restart", now, seen)).toBe(true);
    // seen listed, then gone: closed
    expect(keepsMark("lane:/l/b", now, seen)).toBe(false);
  });
});
