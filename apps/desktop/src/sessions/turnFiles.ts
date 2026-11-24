// Rewind to before a turn: the page's side of the shell's snapshots (src-tauri/src/turn_files.rs). The shell keeps a
// coding session's files as they were when each turn began, and puts them back for a rewind. In a plain browser (dev,
// e2e) a stand-in keeps a pretend folder for each session folder, so the panel can be seen without the shell.

/** What a turn-start snapshot kept. */
export interface TurnTaken {
  n: number;
  files: number;
  /** files left out: too big to keep, or a name a snapshot cannot hold */
  left: number;
}

/** One file a rewind would put back: `changed` goes back as it was, `back` was removed and comes back, `gone` was
 *  made since and goes. */
export interface TurnChange {
  path: string;
  change: "changed" | "back" | "gone";
}

/** What a rewind to before a turn would do (`turn_files_preview`). */
export interface TurnPreview {
  back: TurnChange[];
  /** of those, the files that changed outside the agent's turns since: the person may keep them */
  hand: string[];
  /** files too big to keep now, which stay as they are */
  tooBig: number;
  /** the branch moved since (a commit, a pull): the files go back, the commits stay */
  headMoved: boolean;
}

/** What a rewind did. */
export interface TurnRestored {
  changed: number;
  kept: number;
  tooBig: number;
}

/** What settling a rewind left behind (`turn_files_settle`). `back`: the files as they were just before a rewind that went
 *  through are kept, so Bring it back can put them back until the next turn starts. */
export interface TurnSettled {
  back: boolean;
}

/** The shell's snapshot book for coding sessions, by SESSIONS id. A refusal rejects with `why:<code>` for the reasons
 *  the page words itself (`too_many`, `too_big`, `too_broad`, `no_snapshot`), else with the shell's own line. */
export interface TurnFilesHost {
  /** Keep the files of `cwd` before turn `turn` (the id of the message that starts it). */
  take(session: string, cwd: string, turn: string): Promise<TurnTaken>;
  /** The turn ended: keep the files as they are, so what changes before the next turn reads as changed by hand. */
  end(session: string): Promise<void>;
  /** What rewinding to before `turn` would do. Writes nothing. */
  preview(session: string, turn: string): Promise<TurnPreview>;
  /** Put the files back as they were before `turn`, every path in `keep` left as it is. */
  restore(session: string, turn: string, keep: string[]): Promise<TurnRestored>;
  /** The agent answered the rewind: `ok` = the chat went back too, and the files from before the rewind are kept for Bring
   *  it back (the answer says so); otherwise the files go back as they were before `restore`. */
  settle(session: string, turn: string, ok: boolean): Promise<TurnSettled>;
  /** What Bring it back would do after the rewind to before `turn`: put back the files as they were just before it, and
   *  which of them changed by hand since the rewind. Writes nothing. A refusal is `why:no_snapshot` when no such rewind is
   *  kept (the next turn started, or it was brought back already). */
  backPreview(session: string, turn: string): Promise<TurnPreview>;
  /** Put the files back as they were just before the rewind to before `turn`, every path in `keep` left as it is. The chat
   *  is not touched: neither Claude Code nor Codex has a message that brings a rewound chat back. */
  bringBack(session: string, turn: string, keep: string[]): Promise<TurnRestored>;
  /** Drop every snapshot of `session` (it was removed, or its agent started again). */
  forget(session: string): Promise<void>;
  /** Drop the snapshots of every session not in `keep` (the app started). */
  prune(keep: string[]): Promise<void>;
}

type Invoke = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;

/** The shell's commands, through the Tauri bridge's `invoke` (a test stands in for it). */
export function tauriTurnFiles(invoke: () => Promise<Invoke>): TurnFilesHost {
  const call = async <T>(cmd: string, args: Record<string, unknown>): Promise<T> => (await invoke())<T>(cmd, args);
  return {
    take: (session, cwd, turn) => call<TurnTaken>("turn_files_take", { session, cwd, turn }),
    end: (session) => call<void>("turn_files_end", { session }),
    preview: (session, turn) => call<TurnPreview>("turn_files_preview", { session, turn }),
    restore: (session, turn, keep) => call<TurnRestored>("turn_files_restore", { session, turn, keep }),
    settle: (session, turn, ok) => call<TurnSettled>("turn_files_settle", { session, turn, ok }),
    backPreview: (session, turn) => call<TurnPreview>("turn_files_back_preview", { session, turn }),
    bringBack: (session, turn, keep) => call<TurnRestored>("turn_files_bring_back", { session, turn, keep }),
    forget: (session) => call<void>("turn_files_forget", { session }),
    prune: (keep) => call<void>("turn_files_prune", { keep }),
  };
}

// ---- the stand-in for a plain browser -----------------------------------------------------------------------------

/** A pretend folder: each file's path and text. */
export type MockFiles = Record<string, string>;

interface MockSnap {
  turn: string;
  n: number;
  files: MockFiles;
  /** changed outside a turn since the turn before ended */
  hand: string[];
}

interface MockBook {
  cwd: string;
  next: number;
  starts: MockSnap[];
  end?: { n: number; files: MockFiles };
  undo?: { turn: string; files: MockFiles };
  /** after a rewind that went through, until the next turn starts: the files as they were just before it (`files`) and as
   *  it left them (`rest`) */
  back?: { turn: string; files: MockFiles; rest: MockFiles };
}

export interface MockTurnGlobals {
  /** the pretend folders, by session folder: a test (or the person in a dev page) changes them as by hand */
  __manutMockFolders?: Record<string, MockFiles>;
  /** what the stand-in keeps, by SESSIONS id */
  __manutMockTurnBooks?: Record<string, MockBook>;
}

/** The files that differ between two pretend folders. */
function differ(a: MockFiles, b: MockFiles): string[] {
  return [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((p) => a[p] !== b[p]).sort();
}

/** The shell's snapshot book with the same rules, over pretend folders. The stand-in coding agent's turn changes one
 *  file (a note named after the turn), so a rewind always has something to put back. */
export class MockTurnFiles implements TurnFilesHost {
  constructor(private g: MockTurnGlobals = globalThis as MockTurnGlobals) {}

  /** The pretend folder `cwd`: two files the first time it is used. */
  folder(cwd: string): MockFiles {
    const all = (this.g.__manutMockFolders ??= {});
    return (all[cwd] ??= { "README.md": "# Baan Mali pre-orders\n", "src/checkout.tsx": "export function Checkout() {}\n" });
  }
  private books() {
    return (this.g.__manutMockTurnBooks ??= {});
  }
  private book(session: string): MockBook {
    const b = this.books()[session];
    if (!b) throw new Error("why:no_snapshot");
    return b;
  }
  private start(session: string, turn: string): MockSnap {
    const s = this.book(session).starts.find((x) => x.turn === turn);
    if (!s) throw new Error("why:no_snapshot");
    return s;
  }

  async take(session: string, cwd: string, turn: string): Promise<TurnTaken> {
    const books = this.books();
    if (books[session]?.cwd !== cwd) books[session] = { cwd, next: 1, starts: [] };
    const b = books[session];
    // a turn starts: what Bring it back would put back is no longer where the work goes on from
    b.back = undefined;
    const files = { ...this.folder(cwd) };
    const last = b.starts.at(-1);
    const hand = b.end && b.end.n === (last?.n ?? 0) ? differ(b.end.files, files) : last ? differ(last.files, files) : [];
    const n = b.next++;
    b.starts = [...b.starts.filter((s) => s.turn !== turn), { turn, n, files, hand }].slice(-20);
    return { n, files: Object.keys(files).length, left: 0 };
  }

  async end(session: string): Promise<void> {
    const b = this.books()[session];
    const last = b?.starts.at(-1);
    if (!b || !last) return;
    // the stand-in agent's turn: one note, named after the turn
    const f = this.folder(b.cwd);
    f[`notes/turn-${last.n}.md`] = `What turn ${last.n} did.\n`;
    b.end = { n: last.n, files: { ...f } };
  }

  async preview(session: string, turn: string): Promise<TurnPreview> {
    const b = this.book(session);
    const target = this.start(session, turn);
    const now = this.folder(b.cwd);
    const back = differ(target.files, now).map((path) => ({ path, change: path in target.files ? (path in now ? "changed" : "back") : "gone" }) as const);
    const last = b.starts.at(-1)!;
    const hand = new Set(b.starts.filter((s) => s.n > target.n).flatMap((s) => s.hand));
    for (const p of b.end && b.end.n === last.n ? differ(b.end.files, now) : differ(last.files, now)) hand.add(p);
    return { back, hand: back.map((c) => c.path).filter((p) => hand.has(p)), tooBig: 0, headMoved: false };
  }

  async restore(session: string, turn: string, keep: string[]): Promise<TurnRestored> {
    const b = this.book(session);
    const target = this.start(session, turn);
    const now = this.folder(b.cwd);
    b.undo = { turn, files: { ...now } };
    const changed = differ(target.files, now).filter((p) => !keep.includes(p));
    for (const p of changed) {
      if (p in target.files) now[p] = target.files[p];
      else delete now[p];
    }
    return { changed: changed.length, kept: keep.length, tooBig: 0 };
  }

  async settle(session: string, turn: string, ok: boolean): Promise<TurnSettled> {
    const b = this.books()[session];
    if (!b?.undo) return { back: false };
    if (b.undo.turn !== turn) throw new Error("that rewind is not the one waiting");
    const target = this.start(session, turn);
    if (ok) {
      const before = b.starts.filter((s) => s.n < target.n).at(-1);
      b.starts = b.starts.filter((s) => s.n < target.n);
      b.end = { n: before?.n ?? 0, files: { ...this.folder(b.cwd) } };
      // the files as they were just before the rewind stay for Bring it back, with where the rewind left them
      b.back = { turn, files: { ...b.undo.files }, rest: { ...this.folder(b.cwd) } };
    } else {
      (this.g.__manutMockFolders ??= {})[b.cwd] = { ...b.undo.files };
    }
    b.undo = undefined;
    return { back: ok };
  }

  /** The files kept for Bring it back after the rewind to before `turn`; a rewind to another turn has none. */
  private kept(session: string, turn: string) {
    const b = this.book(session);
    if (!b.back || b.back.turn !== turn) throw new Error("why:no_snapshot");
    return { b, back: b.back };
  }

  async backPreview(session: string, turn: string): Promise<TurnPreview> {
    const { b, back } = this.kept(session, turn);
    const now = this.folder(b.cwd);
    const list = differ(back.files, now).map((path) => ({ path, change: path in back.files ? (path in now ? "changed" : "back") : "gone" }) as const);
    const hand = new Set(differ(back.rest, now));
    return { back: list, hand: list.map((c) => c.path).filter((p) => hand.has(p)), tooBig: 0, headMoved: false };
  }

  async bringBack(session: string, turn: string, keep: string[]): Promise<TurnRestored> {
    const { b, back } = this.kept(session, turn);
    const now = this.folder(b.cwd);
    const changed = differ(back.files, now).filter((p) => !keep.includes(p));
    for (const p of changed) {
      if (p in back.files) now[p] = back.files[p];
      else delete now[p];
    }
    // the next turn starts from the files as they are now: what was put back is not read as changed by hand
    b.end = { n: b.end?.n ?? b.starts.at(-1)?.n ?? 0, files: { ...now } };
    b.back = undefined;
    return { changed: changed.length, kept: keep.length, tooBig: 0 };
  }

  async forget(session: string): Promise<void> {
    delete this.books()[session];
  }

  async prune(keep: string[]): Promise<void> {
    const books = this.books();
    for (const s of Object.keys(books)) if (!keep.includes(s)) delete books[s];
  }
}
