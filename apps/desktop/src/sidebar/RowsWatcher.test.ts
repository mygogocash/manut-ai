// Which rows wait on the person, which is what brings a snoozed or settled row back (RowsWatcher.tsx, rows.ts).
import { describe, expect, it } from "vitest";
import { needingKeys } from "./RowsWatcher";

describe("the rows that wait on the person", () => {
  it("names a chat with an open ask, a lane whose chat has one and a terminal that rang, and no calm row", () => {
    const keys = needingKeys({
      chats: [
        { bot: "buddy", thread: "t1", needs: true },
        { bot: "buddy", thread: "t2", needs: false },
      ],
      sessions: [
        { id: "lane", chat: "agent:lane", rang: false },
        { id: "calmlane", chat: "agent:calm", rang: false },
        { id: "term", chat: null, rang: true },
        { id: "quiet", chat: null, rang: false },
      ],
      askedChats: new Set(["agent:lane"]),
    });
    expect(keys).toEqual(["thread:buddy:t1", "session:lane", "session:term"]);
  });
});
