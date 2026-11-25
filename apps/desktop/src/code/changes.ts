// The files a coding session changed, for the Diff beside its lane (LanePane.tsx): the newest change to each file, from the
// `tool.diff` events of the session. A change reaches the chat on the step that made it (`Step.diff`), and the chat is what a
// rewind takes back: Rewind to before a turn cuts that turn's steps, so the files it listed go with them and the earlier turns'
// stay. The agent's own rewind of the last message cuts the chat the same way, though it leaves the files where they were, so
// after it the list holds what the chat still holds (docs/code-editor.md). Nothing is kept here: the chat's steps are the one
// record, and the same lines the timeline draws are drawn again.
import type { DiffFile } from "../lib/protocol";
import type { Chat } from "../state/store";

/** What each step of the chat changed: a step's own list of files, as the chat holds it (so the same list while its words stream
 *  in, which `sameDiffs` relies on), oldest step first. Steps that changed no file are left out. */
export function diffsOf(chat: Pick<Chat, "items"> | undefined): DiffFile[][] {
  const out: DiffFile[][] = [];
  for (const item of chat?.items ?? []) {
    if (item.kind !== "activity") continue;
    for (const step of item.turn.steps) if (step.diff?.length) out.push(step.diff);
  }
  return out;
}

/** Whether two readings of the chat hold the very same lists, so what is drawn from them need not be drawn again. */
export const sameDiffs = (a: readonly DiffFile[][], b: readonly DiffFile[][]): boolean => a.length === b.length && a.every((list, i) => list === b[i]);

/** The files of `steps` once each, in the order of their newest change: the newest step first, and a step's own files in the order
 *  it gave them. A file a step changed twice is its later change. */
export function newestFirst(steps: readonly DiffFile[][]): DiffFile[] {
  const seen = new Set<string>();
  const out: DiffFile[] = [];
  for (let i = steps.length - 1; i >= 0; i--) {
    // a Map keeps the first place of a path and the last file given for it
    for (const f of new Map(steps[i].map((x) => [x.path, x])).values()) {
      if (seen.has(f.path)) continue;
      seen.add(f.path);
      out.push(f);
    }
  }
  return out;
}

/** The files the session changed, the newest change to each, the file that changed last first. */
export const changedFiles = (chat: Pick<Chat, "items"> | undefined): DiffFile[] => newestFirst(diffsOf(chat));
