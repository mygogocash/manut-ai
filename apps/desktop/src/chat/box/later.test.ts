// Send when the limit resets (item 95, chat/box/later.ts): which limit is trusted (only what Accounts reads as Limited
// until), when a waiting message goes (after the reset, the account usable again, within the hour), that it goes once,
// that one long past its reset asks first, and that the list outlives a restart.
import { afterEach, describe, expect, it } from "vitest";
import type { Account, AccountGroup } from "../../lib/protocol";
import { LATE_MS, WAITING_KEY, allWaiting, cancelWait, decide, limitOf, look, parseWaiting, reloadWaiting, sendWaiting, usable, waitFor, waitingIn, type Waiting } from "./later";

const NOW_S = 1_800_000_000;
const acct = (over: Partial<Account> = {}): Account => ({ id: "default", label: "", email: "me@example.com", state: "active", ...over });
const groups = (accounts: Account[], active: string | null = "default"): AccountGroup[] => [{ cli: "claude", installed: true, active, accounts }];

function withStorage(): Map<string, string> {
  const m = new Map<string, string>();
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
  };
  reloadWaiting();
  return m;
}

afterEach(() => {
  for (const w of allWaiting()) cancelWait(w.key);
  delete (globalThis as { localStorage?: unknown }).localStorage;
  reloadWaiting();
});

describe("which limit is trusted", () => {
  it("only an account Accounts reads as Limited until a time still ahead", () => {
    const g = groups([acct({ state: "limited", resets_at: NOW_S + 3600 }), acct({ id: "work", state: "ready" })]);
    expect(limitOf(g, "claude", "default", NOW_S)).toEqual({ cli: "claude", account: "default", until: NOW_S + 3600 });
    // no account named: the one new sessions use
    expect(limitOf(g, "claude", null, NOW_S)).toEqual({ cli: "claude", account: "default", until: NOW_S + 3600 });
    expect(limitOf(g, "claude", "work", NOW_S)).toBeNull();
    // a reset already past, a limit with no reset time, an agent with no accounts: nothing to wait for
    expect(limitOf(groups([acct({ state: "limited", resets_at: NOW_S - 1 })]), "claude", "default", NOW_S)).toBeNull();
    expect(limitOf(groups([acct({ state: "limited" })]), "claude", "default", NOW_S)).toBeNull();
    expect(limitOf(g, "dsh", "default", NOW_S)).toBeNull();
    expect(limitOf(null, "claude", "default", NOW_S)).toBeNull();
  });

  it("usable means listed, signed in and not limited", () => {
    expect(usable(groups([acct({ state: "ready" })]), "claude", "default")).toBe(true);
    expect(usable(groups([acct({ state: "limited" })]), "claude", "default")).toBe(false);
    expect(usable(groups([acct({ state: "login" })]), "claude", "default")).toBe(false);
    expect(usable(groups([]), "claude", "default")).toBe(false);
  });
});

describe("when a waiting message goes", () => {
  const w: Waiting = { key: "agent:s4", text: "run the tests", cli: "claude", account: "default", at: NOW_S + 3600, since: NOW_S * 1000 };
  const ready = groups([acct({ state: "ready" })]);
  const still = groups([acct({ state: "limited", resets_at: NOW_S + 7200 })]);

  it("waits until the reset time, whatever the account says", () => {
    expect(decide(w, ready, (NOW_S + 3599) * 1000)).toBe("wait");
  });

  it("after the reset, goes once the account is usable; while it still reads limited, it waits", () => {
    expect(decide(w, ready, (NOW_S + 3601) * 1000)).toBe("send");
    expect(decide(w, still, (NOW_S + 3601) * 1000)).toBe("wait");
  });

  it("more than an hour past the reset it asks first, usable or not", () => {
    expect(decide(w, ready, (NOW_S + 3600) * 1000 + LATE_MS + 1)).toBe("ask");
    expect(decide(w, still, (NOW_S + 3600) * 1000 + LATE_MS + 1)).toBe("ask");
    expect(decide({ ...w, late: true }, ready, (NOW_S + 3601) * 1000)).toBe("ask");
  });
});

describe("keeping, sending and cancelling", () => {
  const limit = { cli: "claude" as const, account: "default", until: NOW_S + 3600 };
  const ready = groups([acct({ state: "ready" })]);

  it("keeps one message a chat, and Cancel gives its words back", () => {
    withStorage();
    expect(waitFor("agent:s4", "run the tests", limit, NOW_S * 1000)).toBe(true);
    expect(waitFor("agent:s4", "and another", limit, NOW_S * 1000)).toBe(false);
    expect(waitFor("agent:s5", "   ", limit, NOW_S * 1000)).toBe(false);
    expect(cancelWait("agent:s4")).toBe("run the tests");
    expect(waitingIn("agent:s4")).toBeNull();
    expect(cancelWait("agent:s4")).toBeNull();
  });

  it("is kept on this computer, so it comes back after a restart", () => {
    const m = withStorage();
    waitFor("agent:s4", "run the tests", limit, NOW_S * 1000);
    expect(parseWaiting(m.get(WAITING_KEY)!)["agent:s4"]).toMatchObject({ text: "run the tests", at: NOW_S + 3600 });
    reloadWaiting();
    expect(waitingIn("agent:s4")?.text).toBe("run the tests");
    expect(parseWaiting('{"agent:s1":{"text":"x","cli":"nope","account":"a","at":1,"since":1}}')).toEqual({});
    expect(parseWaiting("not json")).toEqual({});
  });

  it("the watcher sends a due message exactly once, however often it looks", async () => {
    withStorage();
    waitFor("agent:s4", "run the tests", limit, NOW_S * 1000);
    const sent: string[] = [];
    let release: () => void = () => {};
    const send = (key: string, text: string) => new Promise<void>((r) => ((release = r), sent.push(`${key} ${text}`)));
    const at = (NOW_S + 3601) * 1000;
    const first = look(ready, at, send);
    await look(ready, at, send);
    release();
    await first;
    await look(ready, at + 1000, send);
    expect(sent).toEqual(["agent:s4 run the tests"]);
    expect(waitingIn("agent:s4")).toBeNull();
  });

  it("one long past its reset is marked to ask, never sent by the watcher; the person's yes sends it", async () => {
    withStorage();
    waitFor("agent:s4", "run the tests", limit, NOW_S * 1000);
    const sent: string[] = [];
    const send = async (_k: string, text: string) => void sent.push(text);
    await look(ready, (NOW_S + 3600) * 1000 + LATE_MS + 1, send);
    expect(sent).toEqual([]);
    expect(waitingIn("agent:s4")).toMatchObject({ late: true });
    await look(ready, (NOW_S + 3600) * 1000 + LATE_MS + 2, send);
    expect(sent).toEqual([]);
    expect(await sendWaiting("agent:s4", send)).toBe(true);
    expect(sent).toEqual(["run the tests"]);
  });

  it("a chat that cannot take it (it ended) keeps it, asking: it is never tried again by itself", async () => {
    withStorage();
    waitFor("agent:s4", "run the tests", limit, NOW_S * 1000);
    let tries = 0;
    const fail = async () => {
      tries += 1;
      throw new Error("not running");
    };
    await look(ready, (NOW_S + 3601) * 1000, fail);
    expect(waitingIn("agent:s4")).toMatchObject({ late: true, text: "run the tests" });
    await look(ready, (NOW_S + 3602) * 1000, fail);
    expect(tries).toBe(1);
  });
});
