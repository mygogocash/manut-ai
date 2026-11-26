// The pull request a coding chat opened itself (item 100, part 2): any agent's chat, a lane's or one that works in the
// developer's own folder, that ran `gh pr create` in a command Kit's dial read as a push (command.ts: `gh pr create` is a push in
// the words of a pull request). The address is read from what the command printed (the shell hands a command's end over with
// the tail of its output, agent_chat.rs `command_end`), and the request is then read once (`gh pr view` through Tasks' host)
// to check it is in the chat's own repository, from a branch of that very repository (item 86's rule: a request is known by
// repository and branch, never by a number or a branch alone). Only then is the chat linked to it, both ways: the chat's
// header names the request, the request's row in Tasks › Pull requests names the chat, and the chat's row on the Code page
// shows it as a lane's row shows its own.
//
// Read only: nothing here asks the host for anything but the folder's remote and one view of the address the command printed.
// The links are of this run, as the lanes' pull requests are (tasks/pulls.ts): a request's state is not something to show from
// last week. Only github.com is read: the dial reads `gh` sent to another host as a step that sends, never as a pull request,
// and `glab mr create` is a program it does not know.
import { useSyncExternalStore } from "react";
import type { TaskHost } from "../tasks/host";
import { mergedFor, pullFor, remoteOf, type LanePull } from "../tasks/pulls";
import type { CliSource, TaskItem } from "../tasks/types";
import { readCommand, type Where } from "./command";
import { stripAnsi } from "./testRun";

/** A request a chat opened, as the app read it. */
export interface ChatPull {
  source: CliSource;
  repo: string;
  number: number;
  url: string;
  title: string;
  state: TaskItem["state"];
  /** The branch it is made from (this repository's own). */
  head: string;
}

const ADDRESS = /https:\/\/github\.com\/([A-Za-z0-9._-]{1,100})\/([A-Za-z0-9._-]{1,100})\/pull\/(\d{1,9})(?![\w/])/g;

/** The last pull request address on github.com in `output` (gh prints the new request's address last), or null. */
export function pullAddress(output: string): { source: CliSource; repo: string; number: number; url: string } | null {
  let last: RegExpExecArray | null = null;
  for (const m of stripAnsi(output).matchAll(ADDRESS)) last = m;
  if (!last) return null;
  const [, owner, name, n] = last;
  if (owner.startsWith(".") || owner.startsWith("-") || name.startsWith(".") || name.startsWith("-")) return null;
  const number = Number(n);
  if (!Number.isSafeInteger(number) || number <= 0) return null;
  return { source: "github", repo: `${owner}/${name}`, number, url: `https://github.com/${owner}/${name}/pull/${number}` };
}

/** Whether `command` opens a pull request as Kit's dial reads it: a step that sends (a push, or a push that goes live), with
 *  `gh pr create` among its commands. */
export function opensPull(command: string, where: Where): boolean {
  const c = readCommand(command, where);
  return (c.action === "push" || c.action === "live") && /(^|[\s;&|(])gh\s+pr\s+create(\s|$)/.test(command);
}

// ---- the links ---------------------------------------------------------------------------------------------------------

const byChat = new Map<string, ChatPull>();
const byPull = new Map<string, string>();
const listeners = new Set<() => void>();
let version = 0;
const bump = () => {
  version++;
  listeners.forEach((l) => l());
};
const pullKey = (source: CliSource, repo: string, number: number) => `${source}:${repo.toLowerCase()}:${number}`;

function link(chat: string, p: ChatPull): void {
  const was = byChat.get(chat);
  if (was) byPull.delete(pullKey(was.source, was.repo, was.number));
  byChat.set(chat, p);
  byPull.set(pullKey(p.source, p.repo, p.number), chat);
  bump();
}

/** The request the chat with key `chat` opened, with its state as the app last read it (the lanes' list, when it has the branch). */
export function chatPullOf(chat: string | null | undefined): ChatPull | null {
  const p = chat ? byChat.get(chat) : undefined;
  if (!p) return null;
  const open = pullFor(p.source, p.repo, p.head);
  if (open?.number === p.number) return { ...p, state: open.state, title: open.title || p.title };
  if (mergedFor(p.source, p.repo, p.head)) return { ...p, state: "merged" };
  return p;
}

/** A chat's request as a lane's row shows its own (Lanes.tsx): only while it is open or a draft, as the lanes' list holds only those. */
export function asLanePull(p: ChatPull | null): LanePull | null {
  return p && (p.state === "open" || p.state === "draft") ? { source: p.source, repo: p.repo, number: p.number, state: p.state, title: p.title } : null;
}

/** The chat that opened request `number` of `repo`, by its key, or null. */
export const chatOfPull = (source: CliSource, repo: string, number: number): string | null => byPull.get(pullKey(source, repo, number)) ?? null;

/** Why a command's end linked nothing, for tests: `not_a_pull` (no `gh pr create` the dial read as a push, or it failed or was
 *  refused), `no_address`, `no_remote`, `other_repo` (the address is not the chat's own repository), `fork` (the branch is not
 *  that repository's own), `unread` (the view failed or named another request). */
export type LinkResult = { linked: ChatPull } | { why: "not_a_pull" | "no_address" | "no_remote" | "other_repo" | "fork" | "unread" };

/** One event of the coding chat with key `chat`, which works in `where.cwd`: a command's end that opened a pull request links the
 *  chat to it, after the checks at the top of this file. Uses only the host it is given. */
export async function noteChatPull(host: Pick<TaskHost, "remote" | "view">, chat: string, ev: { event: string; [k: string]: unknown }, where: Where): Promise<LinkResult> {
  if (ev.event !== "tool.end" || !chat) return { why: "not_a_pull" };
  const command = typeof ev.command === "string" ? ev.command : "";
  const output = typeof ev.output === "string" ? ev.output : "";
  if (!command || ev.ok === false || ev.declined === true || !opensPull(command, where)) return { why: "not_a_pull" };
  const at = pullAddress(output);
  if (!at) return { why: "no_address" };
  const remote = await remoteOf(host, where.cwd || where.root).catch(() => null);
  if (!remote) return { why: "no_remote" };
  if (remote.source !== at.source || remote.repo.toLowerCase() !== at.repo.toLowerCase()) return { why: "other_repo" };
  let item: TaskItem;
  try {
    item = (await host.view(remote.source, remote.repo, "prs", at.number)).item;
  } catch {
    return { why: "unread" };
  }
  if (item.number !== at.number) return { why: "unread" };
  if (item.same !== true || !item.head) return { why: "fork" };
  const linked: ChatPull = { source: remote.source, repo: remote.repo, number: at.number, url: item.url || at.url, title: item.title, state: item.state, head: item.head };
  link(chat, linked);
  return { linked };
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => void listeners.delete(l);
};

/** Re-renders when a chat is linked to a request. */
export function useChatPullsVersion(): number {
  return useSyncExternalStore(subscribe, () => version, () => version);
}

/** The chat was closed: its link goes with it. */
export function forgetChatPull(chat: string): void {
  const p = byChat.get(chat);
  if (!p) return;
  byChat.delete(chat);
  byPull.delete(pullKey(p.source, p.repo, p.number));
  bump();
}

/** Tests: start from nothing. */
export function resetChatPulls(): void {
  byChat.clear();
  byPull.clear();
  bump();
}
