// What the chat box's + adds to a message (item 80), as pure helpers so they are tested without a DOM: a teammate
// mentioned with `@` (the same `@name` a chat already draws as a link to that teammate, chat/parts/mentions.ts), an
// action from the `/` menu put in front of what is typed, and a folder named by its path. A folder is never copied:
// the agent reads in it with its own tools, and asks before it does (Buddy's runs in a folder of its own, so every
// other folder is outside it; Kit's dial reads a folder outside the project as blocked).
import { t } from "../../i18n";
import { pickText, type AgentCommand } from "../parts/commands";

/** A teammate the `@` menu offers: the name a mention is written with (the profile slug) and the one people read. */
export interface Member {
  name: string;
  label: string;
}

/** The `@` being typed where the caret is: at the start of the box or after a space, followed by a name's letters up to
 *  the caret. Null anywhere else, so an address (`a@b.com`) or a path opens nothing. */
export function mentionAt(text: string, caret: number): { start: number; query: string } | null {
  const before = text.slice(0, caret);
  const m = /(^|\s)@([a-z0-9_-]*)$/i.exec(before);
  if (!m) return null;
  return { start: before.length - m[2].length - 1, query: m[2] };
}

/** The teammates whose name or slug starts with `query`, then those that contain it; every one for an empty query. */
export function matchMembers(members: readonly Member[], query: string): Member[] {
  const q = query.toLowerCase();
  const starts = members.filter((m) => m.name.toLowerCase().startsWith(q) || m.label.toLowerCase().startsWith(q));
  const has = members.filter((m) => !starts.includes(m) && (m.name.toLowerCase().includes(q) || m.label.toLowerCase().includes(q)));
  return [...starts, ...has];
}

/** The box after picking `member` for the `@` at `start` (the rest of that word replaced), and where the caret goes. */
export function putMention(text: string, start: number, caret: number, member: Member): { text: string; caret: number } {
  let end = caret;
  while (end < text.length && !/\s/.test(text[end])) end += 1;
  const put = `@${member.name} `;
  return { text: text.slice(0, start) + put + text.slice(end).replace(/^ /, ""), caret: start + put.length };
}

/** The box after the `@` row of the + menu: an `@` at the caret, with a space before it when a word ends there, so the
 *  `@` menu opens as it does when typed. */
export function addAt(text: string, caret: number): { text: string; caret: number } {
  const lead = caret > 0 && !/\s/.test(text[caret - 1]) ? " @" : "@";
  return { text: text.slice(0, caret) + lead + text.slice(caret), caret: caret + lead.length };
}

/** The box after an action picked from the + menu's Actions: the command first, then what was already typed. */
export const withAction = (text: string, c: AgentCommand): string => pickText(c) + text.trimStart();

/** The message as it goes: what was typed, then one line for each folder named, in the person's language
 *  ("Folder: /Users/fon/Shop"), which the person sees in their bubble and the agent reads. */
export function withFolders(text: string, folders: readonly string[]): string {
  const typed = text.trim();
  if (!folders.length) return typed;
  return [typed, folders.map((path) => t("box.folderLine", { path })).join("\n")].filter(Boolean).join("\n\n");
}

/** A folder's last part, as its chip names it. */
export const folderLabel = (path: string): string => path.split(/[\\/]/).filter(Boolean).pop() ?? path;
