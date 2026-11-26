// Another chat's context, as the chat box carries it (item 97): built by the app from what that chat already holds, with no model,
// so the person can read exactly what goes before they send. Each part is labelled: the chat's title, its first message, its
// last answer (cut to a cap), the files its lane changed (names and counts from the lane's own diff, never what is in them), and
// the ask it is waiting on, if any. Everything is masked with the app's one masker (lib/secrets.ts) before it is cut, so a cut
// never leaves half a key showing, and the whole is at most CONTEXT_MAX characters. Nothing of the other chat changes: it is
// only read.
//
// A summary written by a model (item 96's runs) would plug in at `buildContext`: its text would take the place of the first
// message and last answer, under its own label, and still be masked, capped and shown in full before it goes. Not built here.
import type { DragEvent } from "react";
import { t } from "../../i18n";
import { maskSecrets } from "../../lib/secrets";
import { bareText, firstWords, scopeRefusal, type Carried, type Scope } from "./carry";

/** The most characters the whole context takes, its first and last lines included. */
export const CONTEXT_MAX = 6_000;
/** The caps of its parts, each before the whole is fitted. */
export const TITLE_MAX = 120;
export const FIRST_MAX = 1_500;
export const LAST_MAX = 2_500;
export const ASK_MAX = 600;
/** The most file names listed; the rest are counted. */
export const FILES_SHOWN = 30;

/** A file the lane changed, as its diff counts it: the name and the lines added and removed. Nothing else is read. */
export interface ChangedFile {
  path: string;
  added: number;
  removed: number;
}

export interface ContextInput {
  title: string;
  first?: string | null;
  last?: string | null;
  /** The lane's changed files (null or absent: the chat is no lane). `moreFiles`: how many more the diff did not list. */
  files?: readonly ChangedFile[] | null;
  moreFiles?: number;
  /** What it is waiting on the person for, in words. */
  ask?: string | null;
}

/** `text` on lines with no blank line between (a blank line would end the block in a sent message, carry.ts `splitSent`). */
const tight = (text: string): string =>
  text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((l) => l.trimEnd())
    .filter((l) => l.trim())
    .join("\n");

/** `text` cut to at most `max` characters, the mark saying how much was left out included (never inside a character of two code
 *  units). */
export function cutTo(text: string, max: number): string {
  if (text.length <= max) return text;
  // the mark's own length depends on the number in it: room for the longest it can be
  const mark = (n: number) => t("carry.cut", { n: n.toLocaleString("en-US") });
  let at = Math.max(0, max - mark(text.length).length - 1);
  const code = text.charCodeAt(at - 1);
  if (code >= 0xd800 && code <= 0xdbff) at -= 1;
  return `${text.slice(0, at)} ${mark(text.length - at)}`;
}

/** A part masked, made tight and cut to `max`. */
const part = (text: string, max: number): string => cutTo(tight(maskSecrets(text)), max);

/** The files line: each name (masked) with its counts, at most FILES_SHOWN, then how many more. */
function filesLine(files: readonly ChangedFile[], more: number): string {
  if (!files.length && !more) return t("carry.ctx.noFiles");
  const shown = files.slice(0, FILES_SHOWN).map((f) => `${maskSecrets(f.path).replace(/\s+/g, " ")} (+${Math.max(0, f.added | 0)} -${Math.max(0, f.removed | 0)})`);
  const rest = files.length - shown.length + Math.max(0, more | 0);
  const list = rest > 0 ? `${shown.join(", ")} ${t("carry.ctx.filesMore", { n: rest })}` : shown.join(", ");
  return t("carry.ctx.files", { n: files.length + Math.max(0, more | 0), list: cutTo(list, 1_400) });
}

/** The context of a chat as it goes before the person's message: one block, every part labelled, at most CONTEXT_MAX. */
export function buildContext(i: ContextInput): string {
  const title = firstWords(maskSecrets(i.title), TITLE_MAX) || t("thread.untitled");
  const head = [t("carry.ctx.head", { title }), t("carry.ctx.fence"), t("carry.ctx.title", { v: title })];
  const end = t("carry.ctx.end", { title });
  const tail: string[] = [];
  if (i.files) tail.push(filesLine(i.files, i.moreFiles ?? 0));
  if (i.ask?.trim()) tail.push(t("carry.ctx.ask", { v: part(i.ask, ASK_MAX) }));
  // what the first message and the last answer may take, so the whole stays under the cap (each line adds its line end)
  const fixed = [...head, ...tail, end].reduce((n, l) => n + l.length + 1, 0);
  const firstText = i.first?.trim() ? part(i.first, FIRST_MAX) : "";
  const label = (key: "carry.ctx.first" | "carry.ctx.last") => t(key, { v: "" }).length + 1;
  let room = CONTEXT_MAX - fixed;
  const lines = [...head];
  if (firstText) {
    const first = cutTo(firstText, Math.min(firstText.length, room - label("carry.ctx.first") - 200));
    lines.push(t("carry.ctx.first", { v: first }));
    room -= first.length + label("carry.ctx.first");
  }
  if (i.last?.trim()) {
    const last = part(i.last, Math.min(LAST_MAX, room - label("carry.ctx.last")));
    lines.push(t("carry.ctx.last", { v: last }));
  }
  return [...lines, ...tail, end].join("\n");
}

// ---- which chat, and reading it ------------------------------------------------------------------------------------

/** A chat a row names: one of a member's threads, or a coding chat (a SESSIONS session, a lane's among them). */
export type ThreadRef = { kind: "thread"; bot: string; thread: string } | { kind: "session"; id: string };

/** The drag's own data type: a row dragged onto a box carries its chat this way, and nothing else does. */
export const THREAD_DRAG = "application/x-manut-thread";

/** What makes a row draggable onto a chat box: it carries its chat as THREAD_DRAG, to be copied, never moved. */
export function dragRef(ref: ThreadRef): { draggable: true; onDragStart: (e: DragEvent) => void } {
  return {
    draggable: true,
    onDragStart: (e) => {
      e.dataTransfer.setData(THREAD_DRAG, refText(ref));
      e.dataTransfer.effectAllowed = "copy";
    },
  };
}

/** `ref` as the drag carries it, and back; anything else reads as null. */
export const refText = (ref: ThreadRef): string => JSON.stringify(ref);
export function readRef(raw: string | null | undefined): ThreadRef | null {
  try {
    const v = JSON.parse(raw ?? "") as Partial<{ kind: string; bot: string; thread: string; id: string }>;
    if (v?.kind === "thread" && typeof v.bot === "string" && v.bot && typeof v.thread === "string" && v.thread) return { kind: "thread", bot: v.bot, thread: v.thread };
    if (v?.kind === "session" && typeof v.id === "string" && v.id) return { kind: "session", id: v.id };
  } catch {
    /* not ours */
  }
  return null;
}
/** A ref's own key, one per chat: a chip of the same chat is not added twice. */
export const refKey = (ref: ThreadRef): string => (ref.kind === "thread" ? `thread:${ref.bot}:${ref.thread}` : `session:${ref.id}`);

/** One message as a chat holds it. */
export interface ReadMsg {
  role: "user" | "assistant";
  text: string;
}

/** What reading a chat needs, handed in by the page (the app's store, sessions and shell) or by a test. Each is only read. */
export interface ContextReader {
  /** The chat key of `ref` (a thread's `fold:` key, a session's `agent:` key), or null when it is gone. */
  chatKey(ref: ThreadRef): string | null;
  /** The chat's title as its row shows it. */
  title(ref: ThreadRef): string;
  /** Its messages, oldest first, when this page holds them; null to read them (`read`). */
  held(key: string): ReadMsg[] | null;
  /** Its messages read from the runtime (a thread no one opened since the app started); nothing is changed by it. */
  read(ref: ThreadRef): Promise<ReadMsg[]>;
  /** The ask it waits on, in words, or null. */
  ask(key: string): string | null;
  /** Its lane's changed files from the lane's own diff (null: it is no lane, or the diff cannot be read here). */
  lane(ref: ThreadRef): Promise<{ files: ChangedFile[]; moreFiles: number } | null | undefined>;
  /** What it belongs to (scope.ts). */
  scope(key: string): Scope;
}

/** What a chip of `ref` needs: its key, title, scope and the context text, built with no model. Throws when it is gone. */
export async function gatherContext(ref: ThreadRef, r: ContextReader): Promise<{ key: string; title: string; scope: Scope; text: string }> {
  const key = r.chatKey(ref);
  if (!key) throw new Error("gone");
  const title = r.title(ref);
  const msgs = r.held(key) ?? (await r.read(ref));
  // the person's own words: a first message that itself carried notes or another chat's context gives only what was typed
  const first = msgs.find((m) => m.role === "user" && bareText(m.text).trim());
  const last = [...msgs].reverse().find((m) => m.role === "assistant" && m.text.trim());
  const lane = await r.lane(ref);
  const text = buildContext({
    title,
    first: first ? bareText(first.text) : null,
    last: last?.text ?? null,
    // names and counts only: whatever else a diff file holds is never read
    files: lane ? lane.files.map((f) => ({ path: f.path, added: f.added, removed: f.removed })) : null,
    moreFiles: lane?.moreFiles ?? 0,
    ask: r.ask(key),
  });
  return { key, title, scope: r.scope(key), text };
}

let chipSeq = 0;

/** Bring `ref`'s context into the box of chat `to` (its key and scope): the chip goes through `put` (carry.ts `carry`, or a test's).
 *  Null when it was added; else the plain line the box shows: the chat it is in, another shop or account (said before anything
 *  of it is read), the same chat twice, a fourth chat, or a chat that could not be read. */
export async function bringContext(
  ref: ThreadRef,
  to: { key: string; scope: Scope },
  r: ContextReader,
  put: (key: string, chip: Carried) => "notes" | "threads" | "same" | null,
): Promise<string | null> {
  const key = r.chatKey(ref);
  const title = firstWords(r.title(ref), 60);
  if (!key) return t("carry.readFailed", { title, error: t("ss.closed") });
  if (key === to.key) return t("carry.refuseSelf");
  const why = scopeRefusal(r.scope(key), to.scope);
  if (why) return t(why === "shop" ? "carry.refuseShop" : "carry.refuseAccount", { title });
  let got: Awaited<ReturnType<typeof gatherContext>>;
  try {
    got = await gatherContext(ref, r);
  } catch (e) {
    return t("carry.readFailed", { title, error: e instanceof Error ? e.message : String(e) });
  }
  const refused = put(to.key, { kind: "thread", id: `x${Date.now().toString(36)}${(chipSeq += 1)}`, ref: refKey(ref), title: got.title, text: got.text, scope: got.scope });
  if (refused === "same") return t("carry.refuseSame", { title });
  if (refused === "threads") return t("carry.refuseThreads");
  return null;
}
