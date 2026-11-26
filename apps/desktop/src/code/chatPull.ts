// The pull request a coding chat opened itself (item 100, part 2): any agent's chat, a lane's or one that works in the
// developer's own folder, that ran `gh pr create` in a command Kit's dial read as a push (command.ts: `gh pr create` is a push in
// the words of a pull request). The address is read from what the command printed (the shell hands a command's end over with
// the tail of its output, agent_chat.rs `command_end`), and the request is then read once (`gh pr view` through Tasks' host)
// to check it is in the chat's own repository, from a branch of that very repository (item 86's rule: a request is known by
// repository and branch, never by a number or a branch alone). Only then is the chat linked to it, both ways: the chat's
// header names the request, the request's row in Tasks › Pull requests names the chat, and the chat's row on the Code page
// shows it as a lane's row shows its own.
//
// Since item 120 the request must also be one made from the chat's own branch (a lane's own, else the branch its folder had
// when it was read): the output is the agent's to write, so an address printed by `echo` beside a `gh pr create` could name a
// colleague's request of the same repository. A `gh pr create --dry-run` makes no request, and opens none here.
//
// Read only: nothing here asks the host for anything but the folder's remote and one view of the address the command printed.
// The links are of this run, as the lanes' pull requests are (tasks/pulls.ts): a request's state is not something to show from
// last week. GitHub's requests are read on github.com only: the dial reads `gh` sent to another host as a step that sends, never as
// a pull request. GitLab's (item 100b): a `glab mr create` the dial read as a push, whose output names a merge request on a host
// with `gitlab` among its names (`https://gitlab.com/<group>/<project>/-/merge_requests/<n>`, the hosts Tasks reads a remote of),
// is linked the same way, after the same checks: the chat's remote names that project, and one `glab mr view` says the branch is
// the project's own.
import { useSyncExternalStore } from "react";
import type { TaskHost } from "../tasks/host";
import { mergedFor, pullFor, remoteOf, type LanePull } from "../tasks/pulls";
import type { CliSource, TaskItem } from "../tasks/types";
import { readCommand, type Where } from "./command";
import { stripAnsi } from "./testRun";
import { changes } from "../lib/changes";

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
/** A merge request's address: a host with `gitlab` among its names, the project's path (two to six names, as Tasks reads a GitLab
 *  remote), `/-/merge_requests/<n>`. */
const GL_ADDRESS = /https:\/\/((?:[A-Za-z0-9-]{1,63}\.)*gitlab(?:\.[A-Za-z0-9-]{1,63})+)\/((?:[A-Za-z0-9._-]{1,100}\/){1,5}[A-Za-z0-9._-]{1,100})\/-\/merge_requests\/(\d{1,9})(?![\w/])/g;

const nameOk = (w: string) => !w.startsWith(".") && !w.startsWith("-");

/** The last pull request address on github.com, or merge request address on a GitLab host, in `output` (gh and glab print the
 *  new request's address last), or null. */
export function pullAddress(output: string): { source: CliSource; repo: string; number: number; url: string } | null {
  const text = stripAnsi(output);
  let last: { source: CliSource; repo: string; n: string; url: string; at: number } | null = null;
  for (const m of text.matchAll(ADDRESS)) last = { source: "github", repo: `${m[1]}/${m[2]}`, n: m[3], url: `https://github.com/${m[1]}/${m[2]}/pull/${m[3]}`, at: m.index ?? 0 };
  for (const m of text.matchAll(GL_ADDRESS))
    if (!last || (m.index ?? 0) > last.at) last = { source: "gitlab", repo: m[2], n: m[3], url: `https://${m[1]}/${m[2]}/-/merge_requests/${m[3]}`, at: m.index ?? 0 };
  if (!last || !last.repo.split("/").every(nameOk)) return null;
  const number = Number(last.n);
  if (!Number.isSafeInteger(number) || number <= 0) return null;
  return { source: last.source, repo: last.repo, number, url: last.url };
}

/** Whether `command` opens a pull or merge request as Kit's dial reads it: a step that sends (a push, or a push that goes live),
 *  with `gh pr create` or `glab mr create` among its commands. */
export function opensPull(command: string, where: Where): boolean {
  const c = readCommand(command, where);
  // `--dry-run` (gh 2.104) prints what it would do and makes no request (item 120)
  if (/(^|\s)--dry-run(\s|=|$)/.test(command)) return false;
  return (c.action === "push" || c.action === "live") && /(^|[\s;&|(])(gh\s+pr|glab\s+mr)\s+create(\s|$)/.test(command);
}

// ---- the links ---------------------------------------------------------------------------------------------------------

const byChat = new Map<string, ChatPull>();
const byPull = new Map<string, string>();
const listeners = changes();
let version = 0;
const bump = () => {
  version++;
  listeners.emit();
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

/** Why a command's end linked nothing, for tests: `not_a_pull` (no `gh pr create` the dial read as a push, or it failed, was
 *  refused or was a dry run), `no_address`, `no_remote`, `other_repo` (the address is not the chat's own repository), `fork` (the
 *  branch is not that repository's own), `other_branch` (the request is not made from the chat's own branch, or that branch is
 *  not known), `unread` (the view failed or named another request). */
export type LinkResult = { linked: ChatPull } | { why: "not_a_pull" | "no_address" | "no_remote" | "other_repo" | "fork" | "other_branch" | "unread" };

/** One event of the coding chat with key `chat`, which works in `where.cwd` on its own branch `where.branch`: a command's end that
 *  opened a pull request links the chat to it, after the checks at the top of this file. Uses only the host it is given. */
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
  // only a request made from the chat's own branch is the one it opened (item 120)
  if (!where.branch || item.head !== where.branch) return { why: "other_branch" };
  const linked: ChatPull = { source: remote.source, repo: remote.repo, number: at.number, url: item.url || at.url, title: item.title, state: item.state, head: item.head };
  link(chat, linked);
  return { linked };
}

const subscribe = (l: () => void) => {
  return listeners.subscribe(l);
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
