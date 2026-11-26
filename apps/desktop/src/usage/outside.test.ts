import { describe, expect, it } from "vitest";
import type { SessionRec } from "../sessions/agents";
import { outsideHost, outsideUseOn, setOutsideUse, skippedCount, startedIds, tokenText, watchOutsideUse } from "./outside";

const memory = () => {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
};

describe("use outside Manut AI", () => {
  it("is off until the person turns it on, and says so when the change happens", () => {
    const store = memory();
    const bus = new EventTarget();
    expect(outsideUseOn(store)).toBe(false);
    let seen = 0;
    const stop = watchOutsideUse(() => seen++, bus);
    setOutsideUse(true, store, bus);
    expect(outsideUseOn(store)).toBe(true);
    setOutsideUse(false, store, bus);
    expect(outsideUseOn(store)).toBe(false);
    stop();
    setOutsideUse(true, store, bus);
    expect(seen).toBe(2);
  });

  it("reads a storage that throws as off", () => {
    expect(outsideUseOn({ getItem: () => { throw new Error("no storage"); } })).toBe(false);
    expect(() => setOutsideUse(true, { setItem: () => { throw new Error("no storage"); } }, new EventTarget())).not.toThrow();
  });

  it("has no host in a plain browser until a stand-in is given", () => {
    expect(outsideHost({})).toBeNull();
    expect(outsideHost(undefined)).toBeNull();
    const host = { scan: async () => { throw new Error("x"); }, cancel: async () => {} };
    expect(outsideHost({ __manutOutsideHost: host })).toBe(host);
  });
  it("names a count of tokens the way a person reads it", () => {
    expect([0, 980, 1200, 34_000, 345_678, 5_600_000, 2_100_000_000].map(tokenText)).toEqual(["0", "980", "1.2k", "34k", "346k", "5.6M", "2.1B"]);
  });

  it("sends only the ids of the sessions this tool had in Manut AI", () => {
    const rec = (agent: string, agentSession?: string) => ({ id: "s", agent, agentSession, cwd: "/w", startedAt: 1, status: "running", view: "chat" }) as SessionRec;
    expect(startedIds([rec("claude", "c1"), rec("codex", "x1"), rec("claude"), rec("claude", "c2")], "claude")).toEqual(["c1", "c2"]);
  });

  it("counts the files worth a line, not the sessions Manut AI started", () => {
    expect(skippedCount({ links: 1, too_big: 2, not_json: 3, compressed: 4, app_started: 9, over_limit: 5 })).toBe(10);
  });
});
