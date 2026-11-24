// Rewind to before a turn, the design canvas's StatesCodeDev "Rewind": "The files and the chat go back together.
// Every turn can be undone as a whole. Nothing live changes."
//
// Before a message starts a turn of a coding session that runs as a chat in the app (Claude Code or Codex in a
// folder), the shell keeps the folder's files as they are (turnFiles.ts, src-tauri/src/turn_files.rs), and again when
// the turn ends, so a rewind can tell the agent's changes from changes made by hand. A rewind puts the files back
// first, then asks the agent to take the chat back to before that message (its own rewind, `rewind_to` in
// src-tauri/src/agent_chat.rs). When the agent refuses or does not answer, the files go back as they were, so nothing
// is left half done. An agent takes back only what its running process was sent, so a new process starts with
// nothing to rewind.
//
// A rewind writes files in the session's folder only: nothing pushed, merged or deployed changes. When a step since
// the turn pushed or published, the panel says that rewinding does not take it back (`wentLive`).
import type { AgentId } from "./agents";
import type { TimelineItem } from "../state/store";
import { readCommand, type Where } from "../code/command";
import { clipTitle, promptTitle } from "./titles";
import { t, type Key } from "../i18n";
import type { TurnFilesHost, TurnPreview, TurnRestored } from "./turnFiles";

/** The agents that can take their chat back to before a given message (`Input::RewindTo` in agent_chat.rs). */
export const REWINDS: readonly AgentId[] = ["claude", "codex"];

/** How many turns a session keeps, newest first (`LIMITS.snapshots` in turn_files.rs): the page offers no turn whose
 *  snapshot the shell has dropped. */
export const KEPT_TURNS = 20;

/** Longest turn name in the list, in characters as a person counts them. */
const TITLE_CHARS = 60;

/** A turn whose files were kept: the id of the person's message that began it (its bubble's id). */
export interface TurnMark {
  id: string;
  n: number;
}

/** A turn the panel offers: its message's id and its name. */
export interface RewindTurn {
  id: string;
  title: string;
}

/** Why a session's newest turn has no snapshot: a folder with too many files or too many bytes, the home folder, or
 *  anything else that failed. */
export type WhyNot = "too_many" | "too_big" | "too_broad" | "failed";

/** A turn's name: its message as a short summary (no code, links or `/command`), else its first line, cut short. */
export function turnTitle(text: string): string {
  const first = text.split("\n").map((l) => l.trim()).find(Boolean) ?? "";
  return promptTitle(text, TITLE_CHARS) || clipTitle(first, TITLE_CHARS);
}

/** The turns of a chat that can be rewound, newest first: each message in `items` that began a turn whose files were
 *  kept (`marks`). A message the chat no longer holds (an earlier rewind took it) is not offered. */
export function rewindable(items: readonly TimelineItem[], marks: readonly TurnMark[]): RewindTurn[] {
  const kept = new Set(marks.map((m) => m.id));
  const out: RewindTurn[] = [];
  for (const it of items) if (it.kind === "user" && kept.has(it.id)) out.push({ id: it.id, title: turnTitle(it.text) });
  return out.reverse();
}

/** Whether a step since the turn that message `id` began pushed, published or deployed something, as Kit's command
 *  reader reads its command (src/code/command.ts): a rewind takes none of that back, and the panel says so. A step
 *  that failed or was refused sent nothing. A subagent's command counts too. */
export function wentLive(items: readonly TimelineItem[], id: string, where: Where): boolean {
  const at = items.findIndex((i) => i.kind === "user" && i.id === id);
  if (at < 0) return false;
  const live = (line: string) => {
    const a = readCommand(line, where).action;
    return a === "push" || a === "live";
  };
  for (const it of items.slice(at + 1)) {
    if (it.kind !== "activity") continue;
    for (const st of it.turn.steps) if (st.name === "terminal" && st.ok !== false && st.detail && live(st.detail)) return true;
    for (const f of it.turn.fanouts ?? []) for (const sub of f.subs) for (const st of sub.steps ?? []) if (st.tool === "terminal" && st.text && live(st.text)) return true;
  }
  return false;
}

/** The `why:<code>` a refusal carries (turnFiles.ts), when it carries one. */
export function whyOf(e: unknown): string | null {
  const m = /^why:([a-z_]+)$/.exec(e instanceof Error ? e.message : String(e ?? ""));
  return m ? m[1] : null;
}

const WHY_KEYS: Record<string, Key> = {
  too_many: "rw.to.why.too_many",
  too_big: "rw.to.why.too_big",
  too_broad: "rw.to.why.too_broad",
  failed: "rw.to.why.failed",
  no_snapshot: "rw.to.why.no_snapshot",
};

/** The words for why turns cannot be rewound (`WhyNot`). */
export function whyNotText(why: WhyNot): string {
  return t(WHY_KEYS[why]);
}

/** A refusal in the person's words: the page's own for the reasons it knows, else the line as it came. */
export function whyText(e: unknown): string {
  const code = whyOf(e);
  if (code && WHY_KEYS[code]) return t(WHY_KEYS[code]);
  return e instanceof Error ? e.message : String(e ?? "");
}

/** What a finished rewind says in the chat (the canvas's Reverted state: "3 files are back as they were"). */
export function rewoundNote(title: string, changed: number): string {
  return t(changed === 0 ? "rw.to.done0" : changed === 1 ? "rw.to.done1" : "rw.to.doneN", { title, n: changed });
}

/** A rewind that did not happen. `filesBack`: the files were put back as they were before it (else some could not be,
 *  and the message says which went wrong). */
export class RewindError extends Error {
  constructor(
    message: string,
    readonly filesBack: boolean,
  ) {
    super(message);
  }
}

export interface TurnBookState {
  /** each session's turns whose files are kept, oldest first */
  marks: Record<string, TurnMark[]>;
  /** why a session's newest turn has no snapshot */
  whyNot: Record<string, WhyNot>;
}

export interface TurnBookDeps {
  /** the shell's snapshots; none where there is no shell to keep them */
  host?: TurnFilesHost;
  /** Take session `session`'s chat back to before message `id`: resolves once the agent did, rejects when it refused,
   *  ended or did not answer. */
  chatRewind: (session: string, id: string) => Promise<void>;
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e ?? ""));

/** Each coding session's kept turns, and the calls that keep and put back their files, one at a time per session. */
export class TurnBook {
  private state: TurnBookState = { marks: {}, whyNot: {} };
  private chains = new Map<string, Promise<unknown>>();
  private fns = new Set<() => void>();

  constructor(private deps: TurnBookDeps) {}

  getState = (): TurnBookState => this.state;

  subscribe = (fn: () => void): (() => void) => {
    this.fns.add(fn);
    return () => this.fns.delete(fn);
  };

  marksOf(session: string): TurnMark[] {
    return this.state.marks[session] ?? [];
  }

  private put(session: string, marks: TurnMark[], why: WhyNot | null) {
    const m = { ...this.state.marks };
    const w = { ...this.state.whyNot };
    if (marks.length) m[session] = marks;
    else delete m[session];
    if (why) w[session] = why;
    else delete w[session];
    this.state = { marks: m, whyNot: w };
    for (const f of this.fns) f();
  }

  /** Run `job` after every earlier call for `session`: a turn's end is kept before the next turn's start, and a rewind
   *  never meets a snapshot half taken. */
  private queue<T>(session: string, job: () => Promise<T>): Promise<T> {
    const next = (this.chains.get(session) ?? Promise.resolve()).catch(() => undefined).then(job);
    this.chains.set(
      session,
      next.catch(() => undefined),
    );
    return next;
  }

  /** Message `id` is about to start a turn of session `session` in folder `cwd`: keep the files first. Never throws: a
   *  turn whose files could not be kept is only not offered for rewinding, and the panel says why. */
  async beforeSend(session: string, cwd: string, id: string): Promise<void> {
    const host = this.deps.host;
    if (!host || !cwd || !id) return;
    await this.queue(session, async () => {
      try {
        const got = await host.take(session, cwd, id);
        this.put(session, [...this.marksOf(session).filter((m) => m.id !== id), { id, n: got.n }].slice(-KEPT_TURNS), null);
      } catch (e) {
        const code = whyOf(e);
        const why: WhyNot = code === "too_many" || code === "too_big" || code === "too_broad" ? code : "failed";
        this.put(session, this.marksOf(session).filter((m) => m.id !== id), why);
      }
    });
  }

  /** Session `session`'s turn ended: keep its files as they are, so what changes before the next turn reads as changed
   *  by hand. */
  afterTurn(session: string): void {
    const host = this.deps.host;
    if (!host || !this.marksOf(session).length) return;
    void this.queue(session, () => host.end(session)).catch(() => undefined);
  }

  /** Session `session` was removed, or its agent starts again (a new process takes back only what it is sent itself):
   *  its snapshots go. */
  forget(session: string): void {
    if (session in this.state.marks || session in this.state.whyNot) this.put(session, [], null);
    const host = this.deps.host;
    if (host) void this.queue(session, () => host.forget(session)).catch(() => undefined);
  }

  /** The app started with the sessions in `keep`: the snapshots of every other go. */
  prune(keep: string[]): void {
    void this.deps.host?.prune(keep).catch(() => undefined);
  }

  /** What rewinding session `session` to before turn `id` would put back. Writes nothing. */
  preview(session: string, id: string): Promise<TurnPreview> {
    const host = this.deps.host;
    if (!host) return Promise.reject(new Error("why:no_snapshot"));
    return this.queue(session, () => host.preview(session, id));
  }

  /** Rewind session `session` to before turn `id`: the files, every path in `keep` left as it is, then the chat. When
   *  the chat does not go back, the files go back as they were and a `RewindError` says why. */
  rewind(session: string, id: string, keep: string[]): Promise<TurnRestored> {
    const host = this.deps.host;
    if (!host) return Promise.reject(new RewindError(whyText(new Error("why:no_snapshot")), true));
    return this.queue(session, async () => {
      let done: TurnRestored;
      try {
        done = await host.restore(session, id, keep);
      } catch (e) {
        // a rewind that stops part way puts the files back itself, in the shell
        throw new RewindError(whyText(e), true);
      }
      try {
        await this.deps.chatRewind(session, id);
      } catch (e) {
        const why = message(e);
        try {
          await host.settle(session, id, false);
        } catch (s) {
          throw new RewindError(`${why}; ${message(s)}`, false);
        }
        throw new RewindError(why, true);
      }
      // that turn and every later one are gone from the chat, and so are their snapshots
      const list = this.marksOf(session);
      const at = list.findIndex((m) => m.id === id);
      this.put(session, at >= 0 ? list.slice(0, at) : list, this.state.whyNot[session] ?? null);
      await host.settle(session, id, true).catch(() => undefined);
      return done;
    });
  }
}
