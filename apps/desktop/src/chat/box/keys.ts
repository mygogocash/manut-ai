// What Enter and Cmd+Enter do in a chat box (item 95), and the two choices in Settings › General › Chat box that decide
// it. Pure, so vitest pins every key in every state; the boxes only ask here.
//
// - Home's box (the New page, where a chat starts): Enter sends and opens the chat it started, as it always has, and
//   Cmd+Enter sends and leaves the person on Home, with a quiet line that says so and opens it. "After sending from New"
//   swaps the two.
// - An open chat while its answer runs: Enter does "While an answer is running" (wait for the answer to finish, or hand it
//   to the running answer now), and Cmd+Enter does the other for that one message. Until the person picks one, each kind
//   of chat does what it did before there was a choice (`FOLLOW_UP_USUAL`): a team member takes the message in at once,
//   as a messenger does, and a coding chat holds it until the answer is done. An agent that has no way to take a message
//   mid-answer waits with either key, and the line under the box says so. With no answer running both keys simply send.
//
// Cmd is the Command key on a Mac and Ctrl elsewhere, as every other shortcut of the app (app/shortcuts.ts). The idea of
// a send key that does the other thing for one message, and of a default for it, is T3 Code's (pingdotgg/t3code, commit
// e75534b3e5658002b9a47c7881fa1efef9797fbd, MIT: `composerSubmissionIntentForKey`, `followUpBehavior`), reimplemented
// here against the app's own boxes.
import { useSyncExternalStore } from "react";
import { composing } from "../../lib/ime";
import { t } from "../../i18n";

/** Where Enter leaves the person after sending from Home: in the chat it started (`open`), or still on Home (`stay`). */
export type AfterSend = "open" | "stay";
/** What Enter does with a message typed while an answer runs: wait for it to finish (`queue`), or hand it in now (`steer`). */
export type FollowUp = "queue" | "steer";

export const AFTER_SEND_KEY = "manut.box.afterSend";
export const FOLLOW_UP_KEY = "manut.box.followUp";

/** Opening the chat is what Enter on Home has always done. */
export const AFTER_SEND_DEFAULT: AfterSend = "open";
/** Where a chat box is: a team member's chat and its threads, or a coding chat. */
export type BoxKind = "member" | "code";
/** What a message typed during an answer did in each kind of chat before there was a choice, and still does until the person
 *  picks one in Settings: a team member takes it in at once (messenger style: it keeps working and takes the message in, no
 *  interrupt), and a coding chat holds it until the answer is done. The setting changes nothing by being there. */
export const FOLLOW_UP_USUAL: Readonly<Record<BoxKind, FollowUp>> = { member: "steer", code: "queue" };

const read = <T extends string>(key: string, values: readonly T[], fallback: T): T => {
  try {
    const v = typeof localStorage === "undefined" ? null : localStorage.getItem(key);
    return values.includes(v as T) ? (v as T) : fallback;
  } catch {
    return fallback;
  }
};

let after: AfterSend = read(AFTER_SEND_KEY, ["open", "stay"], AFTER_SEND_DEFAULT);
/** The person's own pick for both kinds of chat, or null while they have picked none. */
const readPicked = (): FollowUp | null => {
  const v = read<FollowUp | "">(FOLLOW_UP_KEY, ["queue", "steer"], "");
  return v === "" ? null : v;
};
let follow: FollowUp | null = readPicked();
const listeners = new Set<() => void>();
const tell = () => listeners.forEach((l) => l());

const save = (key: string, value: string | null, fallback: string | null) => {
  try {
    if (value === null || value === fallback) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    /* no storage: the choice holds for this run */
  }
};

export const afterSend = (): AfterSend => after;
/** What a message typed during an answer does in a chat of `kind` when its sender did not say: the person's pick, else what
 *  that kind of chat has always done. */
export const followUp = (kind: BoxKind): FollowUp => follow ?? FOLLOW_UP_USUAL[kind];
/** The person's pick in Settings, or null while each kind of chat does its usual. */
export const pickedFollowUp = (): FollowUp | null => follow;

export function setAfterSend(next: AfterSend): void {
  if (next === after) return;
  after = next;
  save(AFTER_SEND_KEY, next, AFTER_SEND_DEFAULT);
  tell();
}

/** `null` goes back to each kind of chat's usual. */
export function setFollowUp(next: FollowUp | null): void {
  if (next === follow) return;
  follow = next;
  save(FOLLOW_UP_KEY, next, null);
  tell();
}

/** Tests: read both choices again from storage. */
export function reloadBoxKeys(): void {
  after = read(AFTER_SEND_KEY, ["open", "stay"], AFTER_SEND_DEFAULT);
  follow = readPicked();
  tell();
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => void listeners.delete(l);
};
export const useAfterSend = (): AfterSend => useSyncExternalStore(subscribe, afterSend, afterSend);
const memberFollowUp = () => followUp("member");
const codeFollowUp = () => followUp("code");
export const useFollowUp = (kind: BoxKind): FollowUp => useSyncExternalStore(subscribe, kind === "code" ? codeFollowUp : memberFollowUp, kind === "code" ? codeFollowUp : memberFollowUp);
export const usePickedFollowUp = (): FollowUp | null => useSyncExternalStore(subscribe, pickedFollowUp, pickedFollowUp);

// ---- keys ---------------------------------------------------------------------------------------------------------

export type KeyLike = { key: string; code?: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean; isComposing?: boolean; keyCode?: number; nativeEvent?: { isComposing?: boolean } };

export const onMac = (): boolean => typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

/** The app's Cmd: Command on a Mac, Ctrl elsewhere, alone (no Shift or Option with it). */
const cmd = (e: KeyLike, mac: boolean) => (mac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey) && !e.altKey && !e.shiftKey;
const plain = (e: KeyLike) => !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey;

/** Enter or Cmd+Enter, and which; null for any other key, Shift+Enter (a new line) and an Enter that only commits an
 *  input method's word. */
export function sendKey(e: KeyLike, mac = onMac()): "enter" | "cmd" | null {
  if (e.key !== "Enter" || composing(e)) return null;
  if (plain(e)) return "enter";
  return cmd(e, mac) ? "cmd" : null;
}

/** Cmd+S: put the draft aside (item 95's stash). On a Korean or Russian layout, the key where S stands. */
export function stashKey(e: KeyLike, mac = onMac()): boolean {
  if (composing(e) || !cmd(e, mac)) return false;
  return e.key.toLowerCase() === "s" || (!/^[a-z]$/i.test(e.key) && e.code === "KeyS");
}

/** Home's box: whether this send leaves the person on Home. Enter does the setting, Cmd+Enter the other. */
export function staysHome(key: "enter" | "cmd", pref: AfterSend = after): boolean {
  const stay = pref === "stay";
  return key === "cmd" ? !stay : stay;
}

/** An open chat with an answer running: whether this message waits for the answer or goes into it now. Enter does the
 *  setting and Cmd+Enter the other; an agent that cannot take a message mid-answer always waits. */
export function whileRunning(key: "enter" | "cmd", steers: boolean, pref: FollowUp): FollowUp {
  if (!steers) return "queue";
  if (key === "enter") return pref;
  return pref === "queue" ? "steer" : "queue";
}

/** "⌘" on a Mac, "Ctrl+" elsewhere, as Settings › Keyboard writes keys. */
export const modLabel = (mac = onMac()): string => (mac ? "⌘" : "Ctrl+");

/** The line under a chat box while its answer runs: what Enter does now, and what Cmd+Enter does instead. */
export function keysCaption(steers: boolean, agent: string, pref: FollowUp, mac = onMac()): string {
  const mod = modLabel(mac);
  if (!steers) return t("box.keys.noSteer", { agent, mod });
  return t(pref === "queue" ? "box.keys.queue" : "box.keys.steer", { mod });
}
