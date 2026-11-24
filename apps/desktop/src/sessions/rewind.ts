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
//
// Bring it back (the canvas's StatesCode "Reverted"): once the agent took the chat back, the shell keeps the files as they
// were just before the rewind until the next turn starts, and the book remembers which rewind they are of (`backs`). The lane
// offers them back (src/code/BringBack.tsx). Only the files come back: neither Claude Code nor Codex has a message that
// brings a rewound chat back, so the chat stays where the rewind left it.
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

/** How long a message waits for its turn's files to be kept: a slower snapshot (a folder on a stuck disk, the first
 *  read of a very large one) lets the message go without it, and that turn is not offered for rewinding. */
export const SEND_WAIT_MS = 20_000;

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
 *  kept (`marks`). A message the chat no longer holds (an earlier rewind took it) is not offered, nor one that never
 *  reached the agent (its send failed, or Stop threw it away): the agent cannot take back what it never took. */
export function rewindable(items: readonly TimelineItem[], marks: readonly TurnMark[]): RewindTurn[] {
  const kept = new Set(marks.map((m) => m.id));
  const out: RewindTurn[] = [];
  for (const it of items) if (it.kind === "user" && kept.has(it.id) && !it.error && it.wait !== "dropped") out.push({ id: it.id, title: turnTitle(it.text) });
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

/** What a finished Bring it back says in the chat: how many files came back, and that the chat did not. */
export function broughtBackNote(changed: number): string {
  return t(changed === 0 ? "bb.done0" : changed === 1 ? "bb.done1" : "bb.doneN", { n: changed });
}

/** A refusal of Bring it back in the person's words: that the files from before the rewind are no longer kept (the next turn
 *  started, or they were brought back already), else as `whyText` says it. */
export function backWhyText(e: unknown): string {
  return whyOf(e) === "no_snapshot" ? t("bb.why.gone") : whyText(e);
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
  /** each session's last rewind whose files the shell keeps for Bring it back, by the turn it went back to; until the next
   *  turn starts, the files are brought back, or the session goes */
  backs: Record<string, string>;
}

export interface TurnBookDeps {
  /** the shell's snapshots; none where there is no shell to keep them */
  host?: TurnFilesHost;
  /** Take session `session`'s chat back to before message `id`: resolves once the agent did, rejects when it refused,
   *  ended or did not answer. */
  chatRewind: (session: string, id: string) => Promise<void>;
  /** how long a message waits for its turn's files (`SEND_WAIT_MS`; the tests make it short) */
  sendWaitMs?: number;
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e ?? ""));

/** Each coding session's kept turns, and the calls that keep and put back their files, one at a time per session. */
export class TurnBook {
  private state: TurnBookState = { marks: {}, whyNot: {}, backs: {} };
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
    this.state = { ...this.state, marks: m, whyNot: w };
    for (const f of this.fns) f();
  }

  /** The turn session `session`'s last rewind went back to, while its files can still be brought back. */
  backOf(session: string): string | undefined {
    return this.state.backs[session];
  }

  /** The files of a rewind are kept for Bring it back (`turn`), or no longer are (null). */
  private setBack(session: string, turn: string | null) {
    if (turn === null ? !(session in this.state.backs) : this.state.backs[session] === turn) return;
    const backs = { ...this.state.backs };
    if (turn === null) delete backs[session];
    else backs[session] = turn;
    this.state = { ...this.state, backs };
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

  /** Message `id` is about to start a turn of session `session` in folder `cwd`: keep the files first. Never throws,
   *  and waits at most `SEND_WAIT_MS`: a turn whose files could not be kept in time is only not offered for rewinding,
   *  and the panel says why. */
  async beforeSend(session: string, cwd: string, id: string): Promise<void> {
    const host = this.deps.host;
    if (!host || !cwd || !id) return;
    // the turn that starts now is where the work goes on from: the shell drops what Bring it back would put back as it
    // keeps the files, and the lane stops offering it at once
    this.setBack(session, null);
    let late = false;
    const kept = this.queue(session, async () => {
      try {
        const got = await host.take(session, cwd, id);
        // the message went without it: the agent may have changed files while it was read, so it is not offered
        if (late) return;
        this.put(session, [...this.marksOf(session).filter((m) => m.id !== id), { id, n: got.n }].slice(-KEPT_TURNS), null);
      } catch (e) {
        if (late) return;
        const code = whyOf(e);
        const why: WhyNot = code === "too_many" || code === "too_big" || code === "too_broad" ? code : "failed";
        this.put(session, this.marksOf(session).filter((m) => m.id !== id), why);
      }
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const waited = new Promise<void>((resolve) => {
      timer = setTimeout(() => {
        late = true;
        this.put(session, this.marksOf(session).filter((m) => m.id !== id), "failed");
        resolve();
      }, this.deps.sendWaitMs ?? SEND_WAIT_MS);
    });
    await Promise.race([kept, waited]);
    clearTimeout(timer);
  }

  /** Session `session`'s turn ended: keep its files as they are, so what changes before the next turn reads as changed
   *  by hand. */
  afterTurn(session: string): void {
    const host = this.deps.host;
    if (!host || !this.marksOf(session).length) return;
    void this.queue(session, () => host.end(session)).catch(() => undefined);
  }

  /** A turn of session `session` began, a message of the person's or one the agent started itself: the work goes on from
   *  the files as they are, so the rewind before it can no longer be brought back. */
  turnStarted(session: string): void {
    this.setBack(session, null);
  }

  /** Session `session` was removed, or its agent starts again (a new process takes back only what it is sent itself):
   *  its snapshots go. */
  forget(session: string): void {
    if (session in this.state.marks || session in this.state.whyNot) this.put(session, [], null);
    this.setBack(session, null);
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
      const settled = await host.settle(session, id, true).catch(() => undefined);
      // the files as they were just before this rewind stay for Bring it back, in place of an earlier rewind's, until the
      // next turn starts; when the shell could not keep them, none is offered
      this.setBack(session, settled?.back ? id : null);
      return done;
    });
  }

  /** What Bring it back would put back for session `session`: the files as they were just before its last rewind, and which
   *  of them changed by hand since. Writes nothing. Rejects with `why:no_snapshot` when none are kept. */
  backPreview(session: string): Promise<TurnPreview> {
    const host = this.deps.host;
    const turn = this.state.backs[session];
    if (!host || turn === undefined) return Promise.reject(new Error("why:no_snapshot"));
    return this.queue(session, () => host.backPreview(session, turn));
  }

  /** Put session `session`'s files back as they were just before its last rewind. Every file changed since the rewind stays as
   *  it is unless it is in `overwrite` (the ones the person saw listed and unticked). The chat stays where the rewind left it.
   *  Once it is done, nothing is left to bring back; when it fails, the files are as they were and it can be tried again. */
  bringBack(session: string, overwrite: string[]): Promise<TurnRestored> {
    const host = this.deps.host;
    const turn = this.state.backs[session];
    if (!host || turn === undefined) return Promise.reject(new Error("why:no_snapshot"));
    return this.queue(session, async () => {
      // a turn that started while this waited has taken what was kept
      if (this.state.backs[session] !== turn) throw new Error("why:no_snapshot");
      const done = await host.bringBack(session, turn, overwrite);
      this.setBack(session, null);
      return done;
    });
  }
}
