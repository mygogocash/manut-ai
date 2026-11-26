// Kit's dial at work on a coding session's asks (the canvas's StatesCodeDev board, "What Kit may do").
//
// As an ask arrives from a session, the sessions store asks `kitAnswer` whether Kit's dial settles it by itself: a
// step the project's level or a kept rule lets Kit take alone is allowed once, and a step outside the project is
// denied and noted on the Code page. Either way the ask's card is still added to the chat and settled through the
// card's own path (`settleApproval`, chat/cards/respond.ts), so the timeline says what Kit did and there is no second
// way an approval is answered. Every other ask waits on the person, with Kit's words on its card (`kitCard`).
//
// The keys typed into each session's changes are counted here from its `tool.diff` events (secrets.ts): while a
// session's changes hold one, a commit or a push from it asks the person, at every level. Since item 117 a commit or a push
// the dial would otherwise let go alone also waits for a read of what it saves (the lane's own diff, `savedKeys`): a key there,
// written by a command or anything else, or a read that could not be made whole and in time, makes it ask too.
import { useSyncExternalStore } from "react";
import type { ApprovalChoice, DiffFile, EventOf } from "../lib/protocol";
import { appSounds } from "../lib/sounds";
import type { ApprovalItem } from "../state/store";
import { decideAsk, readAsk, type AskRead, type AskWords } from "./ask";
import { foldersAfter, ruleCovers, scriptRun, type Rule, type Say } from "./command";
import { scriptText } from "./previewRun";
import { noteReads, resetPreview } from "./preview";
import { kitProjects, noteBlocked, projectOf, updateKitProjects, type KitProject } from "./project";
import { keyFiles, keysAfter, type SavedKeys } from "./secrets";
import { DEFAULT_KIT_LEVEL, type KitLevel } from "@manut/member-grants";

/** Where a session's ask is asked: its chat, the folder the dial reads as inside (`root`: where the session works, a lane's own
 *  folder), the project whose level, kept rules and allowed folders the dial uses (`project`: the folder the session started
 *  in; none: `root`), the home folder and the branch. A lane's steps in the developer's folder, or in another lane's, are
 *  outside its own. */
export interface AskContext {
  chat: string;
  root: string;
  project?: string;
  home: string | null;
  branch?: string;
  /** A lane a workflow started (src/workflows/), which nobody may be watching: the dial reads its asks at the most careful level,
   *  Asks every time, with no kept rule, whatever the project's dial says. */
  careful?: boolean;
}

/** The project's folder: where its settings are kept, which is also the folder Kit's panel names. */
const projectRoot = (ctx: AskContext): string => ctx.project ?? ctx.root;

/** The project's settings as the dial reads them for this ask: a careful lane's at the lowest level and with no kept rule. */
const projectFor = (ctx: AskContext): KitProject => {
  const p = projectOf(kitProjects(), projectRoot(ctx));
  return ctx.careful ? { ...p, level: DEFAULT_KIT_LEVEL, rules: [] } : p;
};

/** How Kit's dial settled an ask by itself, for its card's settled line. */
export type KitAnswer =
  | { by: "reads" }
  | { by: "dial"; level: KitLevel }
  | { by: "rule" }
  | { by: "blocked"; project: string };

const answered = new Map<string, KitAnswer>();
const askKey = (chat: string, requestId: string) => `${chat}\n${requestId}`;

/** How Kit's dial settled ask `requestId` of chat `chat` by itself, if it did. */
export const kitAnswered = (chat: string, requestId: string): KitAnswer | undefined => answered.get(askKey(chat, requestId));

/** The project's name as the canvas writes it: its folder's last part. */
export const projectName = (root: string): string => root.split(/[\\/]/).filter(Boolean).pop() ?? root;

const wordsOf = (ev: EventOf<"approval.request">): AskWords => ({ title: ev.title, command: ev.command, cwd: ev.cwd, plan: ev.plan, tool: ev.tool });

/** An open card of chat `chat` as the ask it came from, with what the shell named of it (`tool`), for Kit's reading. */
export const askOfItem = (chat: string, item: ApprovalItem): EventOf<"approval.request"> => ({
  event: "approval.request",
  bot: chat,
  request_id: item.request_id,
  title: item.title,
  command: item.command,
  cwd: item.cwd,
  plan: item.plan,
  choices: item.choices,
  tool: item.tool,
});

// ---- the folder each session's shell may be in (item 116) -------------------------------------------------------------
//
// An agent's shell may keep a `cd` for its next command (Claude Code did before item 116; Cursor's agent keeps its shell's
// state), while its ask names only the session's folder. So each session's commands are followed: a command is read from
// the session's folder and from every folder an earlier command of the session may have left the shell in, and the
// strictest reading speaks. A command the dial stopped never ran, so it moves nothing. One the person may still allow is
// counted as if it ran: a refused one only makes later reads more careful.

/** Per chat: the folders its shell may be in besides the session's (null: one that cannot be known). */
const folders = new Map<string, (string | null)[]>();
/** Per ask: the folders and the branch it was read with as it arrived, so its card reads it as the dial did. */
const readWith = new Map<string, { from: (string | null)[]; branch: string | undefined }>();

// ---- the branch a push that names none is read with (item 120) ---------------------------------------------------------
//
// The sessions store reads the branch checked out when a chat starts and when a turn ends. A step the dial lets run may
// switch it in between (`git switch main`, a rename, a command nobody can read, a tool the dial does not read), and the
// session's next `git push` would then be read as a push of the branch read before. So such a step makes the branch
// unknown for the chat until it is read again from disk, and a push that names no branch is read with none: live, which
// asks. A step the dial stopped never ran, and moves nothing.

/** Per chat: how many steps that may move the branch have been let run, and whether one has since the last read. */
const moved = new Map<string, number>();
const stale = new Set<string>();

function noteMoved(chat: string): void {
  moved.set(chat, (moved.get(chat) ?? 0) + 1);
  stale.add(chat);
}

/** Before the branch of chat `chat`'s folder is read from disk: what `afterBranchRead` is given once it has been. */
export const beforeBranchRead = (chat: string): number => moved.get(chat) ?? 0;

/** The branch of chat `chat`'s folder was read from disk after `token` (`beforeBranchRead`): it is known again, unless a step
 *  that may move it was let run while it was read. */
export function afterBranchRead(chat: string, token: number): void {
  if ((moved.get(chat) ?? 0) === token) stale.delete(chat);
}

/** Per chat: the tags its commands made that the dial did not stop (item 120), so a later push of one by its bare name is
 *  read as the tag's push it is. */
const tagsMade = new Map<string, string[]>();

/** The branch an ask of chat `chat` is read with: none while a step that may have moved it has run since it was read. */
const branchOf = (ctx: AskContext): string | undefined => (stale.has(ctx.chat) ? undefined : ctx.branch);

/** Whether an ask is a shell command, read or not: one the dial cannot read may still move the shell. */
const isCommand = (ev: EventOf<"approval.request">) =>
  ev.tool ? ev.tool.kind === "command" || /^bash$/i.test(ev.tool.name ?? "") : ev.title === "Run this command?";

function readIn(ev: EventOf<"approval.request">, ctx: AskContext, from: readonly (string | null)[], branch: string | undefined = branchOf(ctx)): AskRead | null {
  if (ev.outdated) return null;
  const project = projectFor(ctx);
  return readAsk(wordsOf(ev), { cwd: ev.cwd || ctx.root, root: ctx.root, home: ctx.home ?? undefined, allowed: project.folders, branch, from, tags: tagsMade.get(ctx.chat) ?? [] });
}

/** A name standing for a read of what is saved that could not be made: never shown, only counted, so the dial asks. */
const UNREAD = "\u0000unread";

/** The files with a key that the dial weighs for step `read`: the session's own count, and for a step that saves or sends the
 *  change what the read of it found (`saved`), a read that was not made whole counting as a key. */
function keysFor(read: AskRead, chat: string, saved: SavedKeys | null | undefined): string[] {
  const counted = keysIn(chat);
  if (!read.saves) return counted;
  // a line that writes files beside the save, or a message or a body from a file, saves what no read made before it sees
  // (item 120)
  if (!saved || saved.unread || read.unseen) return [...counted, UNREAD];
  const found = foundIn(read, saved);
  // a step that sends weighs the commits it sends too, and asks when they were not read whole (item 120)
  return read.sends && (!saved.history || saved.history.unread) ? [...counted, ...found, UNREAD] : [...new Set([...counted, ...found])];
}

/** The names a read of what step `read` saves found a key in: the folder's files and, for a step that sends, the commits'. */
const foundIn = (read: AskRead, saved: SavedKeys): string[] => [...saved.files, ...(read.sends && saved.history ? saved.history.files : [])];

/** Whether ask `ev` saves or sends the change (a commit, a push) and the dial would let it go alone were nothing found in
 *  what it saves: such an ask waits for `savedKeys` first, and `kitAnswer` is then given what the read found. */
export function savesAlone(ev: EventOf<"approval.request">, ctx: AskContext, now: number = Date.now()): boolean {
  const read = readIn(ev, ctx, folders.get(ctx.chat) ?? []);
  // a save no read could see asks without one (item 120)
  if (!read?.saves || read.unseen || !ev.choices.includes("once")) return false;
  return decideAsk(read, projectFor(ctx), keysIn(ctx.chat), now).answer === "alone";
}

/** The files a read of what is saved found a key in, added to session `chat`'s own count so its card names them. Nothing is
 *  taken away. */
export function noteSaved(chat: string, files: readonly string[]): void {
  const before = keys.get(chat) ?? {};
  const after = { ...before };
  for (const f of files) after[f] = Math.max(after[f] ?? 0, 1);
  if (JSON.stringify(after) === JSON.stringify(before)) return;
  keys.set(chat, after);
  version++;
  listeners.forEach((l) => l());
}

/** The answer Kit's dial gives ask `ev` by itself, or null when it waits on the person. A step outside the project is
 *  noted on the Code page as it is denied. The answer never rings: the app gave it, nobody needs to look. `saved` is what a
 *  read of what the step saves found (`savedKeys`); for a step that saves or sends the change, none given (or none read) means
 *  it was not read, and the step asks. */
export function kitAnswer(
  ev: EventOf<"approval.request">,
  ctx: AskContext,
  now: number = Date.now(),
  saved?: SavedKeys | null,
): { choice: ApprovalChoice; answer: KitAnswer } | null {
  const from = folders.get(ctx.chat) ?? [];
  const branch = branchOf(ctx);
  readWith.set(askKey(ctx.chat, ev.request_id), { from, branch });
  const read = readIn(ev, ctx, from, branch);
  if (!read) {
    // a command the dial cannot read, which the person may allow, leaves the shell where nobody can say; and any ask it
    // cannot read (a command, a tool of an MCP server's) may move the branch checked out
    if (!ev.outdated && isCommand(ev)) folders.set(ctx.chat, [null]);
    if (!ev.outdated) noteMoved(ctx.chat);
    return null;
  }
  const project = projectFor(ctx);
  const weighed = keysFor(read, ctx.chat, saved);
  const d = decideAsk(read, project, weighed, now);
  if (read.what === "command" && read.ends && d.answer !== "blocked") folders.set(ctx.chat, foldersAfter(from, { ends: read.ends, ...(read.resets ? { resets: read.resets } : {}) }));
  if (d.answer !== "blocked" && (read.movesHead || read.action === "unknown" || read.action === "live")) noteMoved(ctx.chat);
  if (d.answer !== "blocked" && read.tags?.length) tagsMade.set(ctx.chat, [...new Set([...(tagsMade.get(ctx.chat) ?? []), ...read.tags])]);
  let out: { choice: ApprovalChoice; answer: KitAnswer } | null = null;
  if (d.answer === "alone" && ev.choices.includes("once")) {
    const byLevel = decideAsk(read, { ...project, rules: [] }, weighed, now).answer === "alone";
    const answer: KitAnswer = read.action === "read" || read.action === "check" ? { by: "reads" } : byLevel ? { by: "dial", level: project.level } : { by: "rule" };
    out = { choice: "once", answer };
  } else if (d.answer === "blocked" && ev.choices.includes("deny")) {
    updateKitProjects((p) => noteBlocked(p, projectRoot(ctx), { what: read.what, path: read.outside[0] ?? "", folder: read.folder ?? "", at: now, ...(ctx.project !== undefined && ctx.project !== ctx.root ? { lane: true as const } : {}) }));
    out = { choice: "deny", answer: { by: "blocked", project: projectName(projectRoot(ctx)) } };
  }
  if (out) {
    answered.set(askKey(ctx.chat, ev.request_id), out.answer);
    appSounds().answered(ctx.chat, ev.request_id);
  } else if (saved && read.saves) {
    // what the read found is added to the session's own count, so the card names it
    noteSaved(ctx.chat, foundIn(read, saved));
  }
  return out;
}

/** What an ask's card shows of Kit's reading: what the step does, whether it may keep a rule, and the files with a
 *  key while the step would save them. Null for an ask Kit's words do not cover (the card is as it always was). */
export interface KitCard {
  /** The project's folder, where a kept rule goes. */
  root: string;
  say: Say;
  /** The rule "Always allow in this project" keeps, when the dial lets the ask offer it. */
  always: Rule | null;
  /** Files with a key typed in, when the step saves or sends the change. */
  keys: string[];
  /** For a command that runs a package.json script by its name, what the script runs, a key in it masked. */
  script?: { name: string; text: string };
}

/** `a` and `b` as one folder, a separator at the end aside. */
const sameDir = (a: string, b: string) => a.replace(/[\\/]+$/, "") === b.replace(/[\\/]+$/, "");

/** Kit's reading of ask `ev` for its card. `packageJson` is the text of package.json in the folder the session works in
 *  (`ctx.root`), when the app has read it: a script run in that folder then shows what the script runs. */
export function kitCard(ev: EventOf<"approval.request">, ctx: AskContext, packageJson?: string | null): KitCard | null {
  const was = readWith.get(askKey(ctx.chat, ev.request_id));
  const from = was?.from ?? folders.get(ctx.chat) ?? [];
  const read = readIn(ev, ctx, from, was ? was.branch : branchOf(ctx));
  if (!read) return null;
  const project = projectFor(ctx);
  const keys = keysIn(ctx.chat);
  const d = decideAsk(read, project, keys);
  // a rule is matched against the line that was read, never the card's one-line command
  const kept = read.line !== undefined && project.rules.some((r) => ruleCovers(r, read.line!, read.action));
  const always = d.answer === "ask" && d.mayAlwaysAllow && read.rule && !kept ? read.rule : null;
  // a script's text is shown only while the shell can only be in the session's folder: elsewhere it runs another one
  const here = ev.tool?.cwd ?? ev.cwd ?? ctx.root;
  const name = read.line !== undefined && sameDir(here, ctx.root) && from.every((f) => f !== null && sameDir(f, here)) ? scriptRun(read.line) : null;
  const text = name === null ? null : scriptText(packageJson, name);
  return { root: projectRoot(ctx), say: read.say, always, keys: read.saves ? keys : [], ...(name !== null && text !== null ? { script: { name, text } } : {}) };
}

// ---- keys in each session's changes -------------------------------------------------------------------------------

const keys = new Map<string, Record<string, number>>();
const listeners = new Set<() => void>();
let version = 0;

/** A session's change arrived (`tool.diff`): its keys are counted again, and so are the secrets its code reads (preview.ts). */
export function noteChange(chat: string, files: readonly DiffFile[]): void {
  noteReads(chat, files);
  const before = keys.get(chat) ?? {};
  const after = keysAfter(before, files);
  if (JSON.stringify(after) === JSON.stringify(before)) return;
  keys.set(chat, after);
  version++;
  listeners.forEach((l) => l());
}

/** The files in session `chat`'s changes that hold a key, in name order. */
export const keysIn = (chat: string): string[] => keyFiles(keys.get(chat) ?? {});

/** Every session with a key in its changes: its chat key and the files. */
export const sessionsWithKeys = (): { chat: string; files: string[] }[] =>
  [...keys.entries()].map(([chat, k]) => ({ chat, files: keyFiles(k) })).filter((x) => x.files.length);

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

/** Re-renders when a session's keys change. */
export function useKeysVersion(): number {
  return useSyncExternalStore(subscribe, () => version, () => version);
}

/** Forgets what was answered and counted (tests). */
export function resetKitAsks(): void {
  answered.clear();
  keys.clear();
  folders.clear();
  readWith.clear();
  moved.clear();
  stale.clear();
  tagsMade.clear();
  resetPreview();
  version++;
}
