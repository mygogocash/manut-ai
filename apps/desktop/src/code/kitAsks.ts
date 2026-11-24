// Kit's dial at work on a coding session's asks (the canvas's StatesCodeDev board, "What Kit may do").
//
// As an ask arrives from a session, the sessions store asks `kitAnswer` whether Kit's dial settles it by itself: a
// step the project's level or a kept rule lets Kit take alone is allowed once, and a step outside the project is
// denied and noted on the Code page. Either way the ask's card is still added to the chat and settled through the
// card's own path (`settleApproval`, chat/cards/respond.ts), so the timeline says what Kit did and there is no second
// way an approval is answered. Every other ask waits on the person, with Kit's words on its card (`kitCard`).
//
// The keys typed into each session's changes are counted here from its `tool.diff` events (secrets.ts): while a
// session's changes hold one, a commit or a push from it asks the person, at every level.
import { useSyncExternalStore } from "react";
import type { ApprovalChoice, DiffFile, EventOf } from "../lib/protocol";
import { appSounds } from "../lib/sounds";
import type { ApprovalItem } from "../state/store";
import { decideAsk, readAsk, type AskRead, type AskWords } from "./ask";
import { ruleMatches, type Rule, type Say } from "./command";
import { noteReads, resetPreview } from "./preview";
import { kitProjects, noteBlocked, projectOf, updateKitProjects } from "./project";
import { keyFiles, keysAfter } from "./secrets";
import type { KitLevel } from "@manut/member-grants";

/** Where a session's ask is asked: its chat, its project (the folder it started in), the home folder and the branch. */
export interface AskContext {
  chat: string;
  root: string;
  home: string | null;
  branch?: string;
}

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

function readIn(ev: EventOf<"approval.request">, ctx: AskContext): AskRead | null {
  if (ev.outdated) return null;
  const project = projectOf(kitProjects(), ctx.root);
  return readAsk(wordsOf(ev), { cwd: ev.cwd || ctx.root, root: ctx.root, home: ctx.home ?? undefined, allowed: project.folders, branch: ctx.branch });
}

/** The answer Kit's dial gives ask `ev` by itself, or null when it waits on the person. A step outside the project is
 *  noted on the Code page as it is denied. The answer never rings: the app gave it, nobody needs to look. */
export function kitAnswer(ev: EventOf<"approval.request">, ctx: AskContext, now: number = Date.now()): { choice: ApprovalChoice; answer: KitAnswer } | null {
  const read = readIn(ev, ctx);
  if (!read) return null;
  const project = projectOf(kitProjects(), ctx.root);
  const d = decideAsk(read, project, keysIn(ctx.chat), now);
  let out: { choice: ApprovalChoice; answer: KitAnswer } | null = null;
  if (d.answer === "alone" && ev.choices.includes("once")) {
    const byLevel = decideAsk(read, { ...project, rules: [] }, keysIn(ctx.chat), now).answer === "alone";
    const answer: KitAnswer = read.action === "read" || read.action === "check" ? { by: "reads" } : byLevel ? { by: "dial", level: project.level } : { by: "rule" };
    out = { choice: "once", answer };
  } else if (d.answer === "blocked" && ev.choices.includes("deny")) {
    updateKitProjects((p) => noteBlocked(p, ctx.root, { what: read.what, path: read.outside[0] ?? "", folder: read.folder ?? "", at: now }));
    out = { choice: "deny", answer: { by: "blocked", project: projectName(ctx.root) } };
  }
  if (out) {
    answered.set(askKey(ctx.chat, ev.request_id), out.answer);
    appSounds().answered(ctx.chat, ev.request_id);
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
}

export function kitCard(ev: EventOf<"approval.request">, ctx: AskContext): KitCard | null {
  const read = readIn(ev, ctx);
  if (!read) return null;
  const project = projectOf(kitProjects(), ctx.root);
  const keys = keysIn(ctx.chat);
  const d = decideAsk(read, project, keys);
  // a rule is matched against the line that was read, never the card's one-line command
  const kept = read.line !== undefined && project.rules.some((r) => ruleMatches(r, read.line!));
  const always = d.answer === "ask" && d.mayAlwaysAllow && read.rule && !kept ? read.rule : null;
  return { root: ctx.root, say: read.say, always, keys: read.saves ? keys : [] };
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
  resetPreview();
  version++;
}
