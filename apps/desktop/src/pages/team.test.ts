// The Team page's status word for each member, decided from what the store already holds.
import { describe, expect, it } from "vitest";
import { asksOf, memberStatus } from "./team";
import type { Ask, Chat } from "../state/store";

const bot = (over: { status?: "online" | "offline"; running?: boolean; paused?: boolean } = {}) => ({
  status: over.status ?? "online",
  running: over.running ?? false,
  ...(over.paused ? { paused: true } : {}),
});
const chat = (over: { turn?: boolean; outcome?: "done" | "interrupted" | "ended" | "error" } = {}) =>
  ({
    turn: over.turn ? { id: "t" } : null,
    lastTurn: over.outcome ? { id: "l", outcome: over.outcome } : null,
  }) as unknown as Pick<Chat, "turn" | "lastTurn">;

describe("a member's status", () => {
  it("is Needs you while an ask of theirs waits, whatever else holds", () => {
    expect(memberStatus(bot({ running: true }), chat({ turn: true }), 1)).toBe("needs");
    expect(memberStatus(bot({ status: "offline" }), undefined, 2)).toBe("needs");
  });

  it("is Paused while Pause everyone holds them, whatever else holds, even an ask that waits for the owner", () => {
    expect(memberStatus(bot({ paused: true }), undefined, 0)).toBe("paused");
    expect(memberStatus(bot({ paused: true, running: true }), chat({ turn: true }), 0)).toBe("paused");
    expect(memberStatus(bot({ paused: true }), chat({ outcome: "error" }), 2)).toBe("paused");
    expect(memberStatus(bot({ paused: false }), undefined, 0)).toBe("idle");
  });

  it("is Not connected when the runtime cannot reach them", () => {
    expect(memberStatus(bot({ status: "offline" }), chat({ outcome: "error" }), 0)).toBe("offline");
  });

  it("is Working while a turn runs in their chat, or the runtime says they are busy", () => {
    expect(memberStatus(bot(), chat({ turn: true }), 0)).toBe("working");
    expect(memberStatus(bot({ running: true }), undefined, 0)).toBe("working");
  });

  it("is Could not finish when their last turn ended in an error", () => {
    expect(memberStatus(bot(), chat({ outcome: "error" }), 0)).toBe("stuck");
  });

  it("is Idle otherwise, including after a turn the person stopped", () => {
    expect(memberStatus(bot(), undefined, 0)).toBe("idle");
    expect(memberStatus(bot(), chat({ outcome: "done" }), 0)).toBe("idle");
    expect(memberStatus(bot(), chat({ outcome: "interrupted" }), 0)).toBe("idle");
  });
});

describe("a member's asks", () => {
  const ask = (key: string) => ({ bot: key, ts: 1, item: { id: key } }) as unknown as Ask;

  it("are the ones in their main chat and in their threads", () => {
    const asks = [ask("nam"), ask("fold:nam:t1"), ask("pim"), ask("fold:pim:t2"), ask("agent:s1")];
    expect(asksOf(asks, "nam").map((a) => a.bot)).toEqual(["nam", "fold:nam:t1"]);
    expect(asksOf(asks, "kit")).toEqual([]);
  });
});
