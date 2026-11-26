// The journal a phone catches up from (journal.ts, ported from GoSpark's RemoteEventJournal): numbered events per chat,
// at most 500 or 1 MB, replayed after a cursor only when every event since it is still kept, and the whole chat again
// for anything else.
import { describe, expect, it } from "vitest";
import { EventJournal, MAX_BYTES, MAX_EVENTS, eventBytes } from "./journal";

let ids = 0;
const journal = (options: { maxEvents?: number; maxBytes?: number } = {}) => new EventJournal<string>({ newId: () => `j${++ids}`, ...options });

describe("the event journal", () => {
  it("keeps GoSpark's bounds: 500 events or 1 MB a chat", () => {
    expect(MAX_EVENTS).toBe(500);
    expect(MAX_BYTES).toBe(1024 * 1024);
  });

  it("numbers only the chats a phone watches, from where the snapshot stood", () => {
    const j = journal();
    expect(j.record("buddy", "a")).toBeNull();
    const start = j.open("buddy");
    expect(start.seq).toBe(0);
    expect(j.record("buddy", "a")).toEqual({ journal: start.journal, seq: 1 });
    expect(j.record("buddy", "b")).toEqual({ journal: start.journal, seq: 2 });
    // Opening again keeps the journal and says where it stands.
    expect(j.open("buddy")).toEqual({ journal: start.journal, seq: 2 });
  });

  it("replays exactly what came after a cursor, and nothing for a phone that holds everything", () => {
    const j = journal();
    const start = j.open("buddy");
    for (const e of ["a", "b", "c"]) j.record("buddy", e);
    expect(j.catchUp("buddy", start)).toEqual({
      kind: "replay",
      events: [
        { event: "a", cursor: { journal: start.journal, seq: 1 } },
        { event: "b", cursor: { journal: start.journal, seq: 2 } },
        { event: "c", cursor: { journal: start.journal, seq: 3 } },
      ],
    });
    expect(j.catchUp("buddy", { journal: start.journal, seq: 2 })).toEqual({ kind: "replay", events: [{ event: "c", cursor: { journal: start.journal, seq: 3 } }] });
    expect(j.catchUp("buddy", { journal: start.journal, seq: 3 })).toEqual({ kind: "replay", events: [] });
  });

  it("sends the whole chat for no cursor, another journal's, one ahead, a malformed one, and a closed journal", () => {
    const j = journal();
    const start = j.open("buddy");
    j.record("buddy", "a");
    for (const cursor of [null, { journal: "other", seq: 0 }, { journal: start.journal, seq: 2 }, { journal: start.journal, seq: -1 }, { journal: start.journal, seq: 0.5 }]) {
      expect(j.catchUp("buddy", cursor)).toEqual({ kind: "snapshot" });
    }
    expect(j.catchUp("kit", { journal: start.journal, seq: 0 })).toEqual({ kind: "snapshot" });
    j.close("buddy");
    expect(j.catchUp("buddy", start)).toEqual({ kind: "snapshot" });
    // A new watch is a new journal, which no earlier cursor matches.
    const again = j.open("buddy");
    expect(again.journal).not.toBe(start.journal);
    expect(j.catchUp("buddy", { journal: start.journal, seq: 0 })).toEqual({ kind: "snapshot" });
  });

  it("trims the oldest events past the count, and then sends the whole chat to a phone that far behind", () => {
    const j = journal({ maxEvents: 3 });
    const start = j.open("buddy");
    for (const e of ["a", "b", "c", "d"]) j.record("buddy", e);
    expect(j.catchUp("buddy", start)).toEqual({ kind: "snapshot" });
    const kept = j.catchUp("buddy", { journal: start.journal, seq: 1 });
    expect(kept.kind === "replay" && kept.events.map((e) => e.event)).toEqual(["b", "c", "d"]);
  });

  it("trims past the bytes too, counting each event as it is sent", () => {
    expect(eventBytes({ k: "message", text: "ไทย" })).toBe(new TextEncoder().encode(JSON.stringify({ k: "message", text: "ไทย" })).length);
    const j = new EventJournal<{ text: string }>({ newId: () => "j", maxBytes: 100 });
    const start = j.open("buddy");
    const big = { text: "x".repeat(60) };
    j.record("buddy", big);
    j.record("buddy", big);
    // Two of 72 bytes are over 100: only the newest is kept.
    expect(j.catchUp("buddy", start)).toEqual({ kind: "snapshot" });
    const last = j.catchUp("buddy", { journal: "j", seq: 1 });
    expect(last.kind === "replay" && last.events).toHaveLength(1);
  });

  it("drops every journal when the switch goes off", () => {
    const j = journal();
    j.open("buddy");
    j.open("kit");
    expect(j.chats()).toEqual(["buddy", "kit"]);
    j.clear();
    expect(j.chats()).toEqual([]);
  });
});
