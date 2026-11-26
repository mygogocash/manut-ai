// Send when the limit resets (item 95). When the account a chat would use is at its limit, Send offers to keep the
// message and send it once the limit has reset; the person may also send it now.
//
// What the app trusts: only what the Accounts page shows as "Limited until <time>" (settings/accounts/rules.ts `pill`):
// the account's own `state` and `resets_at`, from the accounts list the app keeps fresh (useAccounts.ts). Nothing here
// guesses a reset from usage numbers.
//
// A waiting message is the person's own words to their own agent, sent later at a time they chose. It is not an
// approval: whatever the agent then wants to do still asks, as it would after any message. So it is sent exactly once,
// to the chat it was written in, never on another account or another agent, and only:
//   - after the reset time has passed, AND when the account reads as usable again (not limited, signed in);
//   - while the app is open (nothing runs anywhere else);
//   - within an hour of the reset time. Later than that (the app was closed then, or the account stayed limited), it
//     asks first, in its chat and on Home: "This was waiting since <time>. Send it now?". A message never goes out long
//     after the person meant it without their yes.
// One message waits in a chat at a time. Cancel puts its words back in the chat's box. Waiting messages are kept on this
// computer, so they come back after a restart.
import { useSyncExternalStore } from "react";
import type { AccountCli, AccountGroup } from "../../lib/protocol";

export const WAITING_KEY = "manut.box.waiting";
/** A message whose reset passed longer ago than this is never sent without the person's yes. */
export const LATE_MS = 60 * 60 * 1000;
/** How often the watcher looks (it also looks whenever the accounts are read again). */
export const WATCH_MS = 30_000;

/** The account a chat would use, and until when it is limited (seconds). */
export interface Limit {
  cli: AccountCli;
  account: string;
  until: number;
}

export interface Waiting {
  /** The chat it was written in (a member's name, a thread's or a session's chat key). */
  key: string;
  text: string;
  cli: AccountCli;
  account: string;
  /** The reset it waits for (seconds). */
  at: number;
  /** When the person chose to wait (ms). */
  since: number;
  /** Past the hour: it waits for the person's yes. */
  late?: boolean;
}

const CLIS: readonly string[] = ["claude", "codex", "pi", "omp", "grok", "gemini"];
export const isCli = (x: string | undefined | null): x is AccountCli => !!x && CLIS.includes(x);

/** The account of `cli` a chat would use (`account`, else the one new sessions start with), when it is limited with a
 *  reset still ahead: exactly what the Accounts page reads as "Limited until <time>". */
export function limitOf(groups: readonly AccountGroup[] | null, cli: string | undefined | null, account: string | undefined | null, nowS: number): Limit | null {
  if (!isCli(cli)) return null;
  const g = groups?.find((x) => x.cli === cli);
  if (!g) return null;
  const id = account || g.active || "default";
  const a = g.accounts.find((x) => x.id === id);
  if (!a || a.state !== "limited" || typeof a.resets_at !== "number" || !(a.resets_at > nowS)) return null;
  return { cli, account: id, until: a.resets_at };
}

/** The account reads as usable: listed, signed in and not limited. */
export function usable(groups: readonly AccountGroup[] | null, cli: AccountCli, account: string): boolean {
  const a = groups?.find((x) => x.cli === cli)?.accounts.find((x) => x.id === account);
  return !!a && a.state !== "limited" && a.state !== "login";
}

/** What to do with a waiting message now: keep waiting, send it, or ask the person first. */
export function decide(w: Waiting, groups: readonly AccountGroup[] | null, nowMs: number): "wait" | "send" | "ask" {
  if (w.late) return "ask";
  if (nowMs < w.at * 1000) return "wait";
  if (nowMs - w.at * 1000 > LATE_MS) return "ask";
  return usable(groups, w.cli, w.account) ? "send" : "wait";
}

// ---- the saved messages -------------------------------------------------------------------------------------------

const storage = (): Storage | null => {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
};

/** The saved messages by chat, one a chat; anything that cannot be read is left out. */
export function parseWaiting(raw: string | null): Record<string, Waiting> {
  let v: unknown;
  try {
    v = JSON.parse(raw ?? "{}");
  } catch {
    return {};
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) return {};
  const out: Record<string, Waiting> = {};
  for (const [key, x] of Object.entries(v as Record<string, unknown>)) {
    const w = x as Partial<Waiting> | null;
    if (!w || typeof w.text !== "string" || !w.text.trim() || !isCli(w.cli) || typeof w.account !== "string") continue;
    if (typeof w.at !== "number" || !Number.isFinite(w.at) || typeof w.since !== "number") continue;
    out[key] = { key, text: w.text, cli: w.cli, account: w.account, at: w.at, since: w.since, ...(w.late === true ? { late: true } : {}) };
  }
  return out;
}

let all: Record<string, Waiting> = parseWaiting(storage()?.getItem(WAITING_KEY) ?? null);
const listeners = new Set<() => void>();
function put(next: Record<string, Waiting>): void {
  all = next;
  try {
    const s = storage();
    if (Object.keys(next).length) s?.setItem(WAITING_KEY, JSON.stringify(next));
    else s?.removeItem(WAITING_KEY);
  } catch {
    /* no storage: it waits for this run */
  }
  for (const l of [...listeners]) l();
}
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => void listeners.delete(l);
};

export const waitingIn = (key: string): Waiting | null => all[key] ?? null;
export const allWaiting = (): Waiting[] => Object.values(all);
export const useWaiting = (key: string): Waiting | null => useSyncExternalStore(subscribe, () => all[key] ?? null, () => all[key] ?? null);
export const useAllWaiting = (): Record<string, Waiting> => useSyncExternalStore(subscribe, () => all, () => all);

/** Keep `text` to send to chat `key` when `limit` resets. False, keeping nothing, when a message already waits there. */
export function waitFor(key: string, text: string, limit: Limit, nowMs = Date.now()): boolean {
  if (all[key] || !text.trim()) return false;
  put({ ...all, [key]: { key, text, cli: limit.cli, account: limit.account, at: limit.until, since: nowMs } });
  return true;
}

/** Cancel the message waiting in chat `key`; its words are returned, to go back in the box. */
export function cancelWait(key: string): string | null {
  const w = all[key];
  if (!w) return null;
  const { [key]: _gone, ...rest } = all;
  put(rest);
  return w.text;
}

/** Messages being sent now: a second look while one goes never sends it again. */
const sending = new Set<string>();

/** Send the message waiting in `key` now (the watcher's send, or the person's yes to the question). It leaves the saved
 *  list before it is sent, so it goes out once, whatever happens next. When the chat cannot take it (it ended, the agent
 *  refused it before it went), it comes back, asking the person: never sent again by itself. */
export async function sendWaiting(key: string, send: (key: string, text: string) => Promise<void>): Promise<boolean> {
  const w = all[key];
  if (!w || sending.has(key)) return false;
  sending.add(key);
  try {
    const { [key]: _gone, ...rest } = all;
    put(rest);
    await send(key, w.text);
    return true;
  } catch {
    if (!all[key]) put({ ...all, [key]: { ...w, late: true } });
    return false;
  } finally {
    sending.delete(key);
  }
}

/** One look at every waiting message: those due go out, those long past their reset wait for a yes. */
export async function look(groups: readonly AccountGroup[] | null, nowMs: number, send: (key: string, text: string) => Promise<void>): Promise<void> {
  for (const w of Object.values(all)) {
    const d = decide(w, groups, nowMs);
    if (d === "send") await sendWaiting(w.key, send);
    else if (d === "ask" && !w.late) put({ ...all, [w.key]: { ...w, late: true } });
  }
}

/** Tests: read the saved messages again. */
export function reloadWaiting(): void {
  all = parseWaiting(storage()?.getItem(WAITING_KEY) ?? null);
  sending.clear();
  for (const l of [...listeners]) l();
}
