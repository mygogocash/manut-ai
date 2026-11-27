// The files a coding session's messages carried, as the sessions store keeps them (lifted out of sessions.ts, the refactor of
// 27 Nov 2026): each file saved under the session's own folder before its message goes, the book on this computer that lets a
// bubble show its files again after a restart (`manut.sessions.files`), and the bubbles' picture previews, let go when the
// session is closed. Sending, holding and opening chats stay the sessions store's; this module only reads, saves and forgets.
//
// `createSentFiles` takes the shell's two file calls, so a test drives it with stand-ins.
import { t as tr } from "../i18n";
import { errText } from "./sessionErrors";
import type { OutFile, SentFile } from "../state/store";
import { blobType, bytesOf, inlinePicture, putSentFiles, SENT_FILES_KEY, wireText, type SavedFile, type SentFilesBook } from "./attach";
import { readSentFiles } from "./sessionBooks";

export interface SentFilesDeps {
  /** Saves `bytes` as `name` under session `session`'s own folder; the path it was saved at. */
  saveFile(session: string, name: string, bytes: Uint8Array): Promise<string>;
  readFile(path: string): Promise<Uint8Array>;
}

/** A message with files, ready for the agent: what goes on the wire, what the book keeps, and what the bubble shows. */
export interface Prepared {
  readonly input: { kind: "send"; text: string; images?: string[] };
  readonly saved: SavedFile[];
  readonly shown: SentFile[];
}

/** A sent message's bubble as the book brings it back: its id in the book, its text and time, and its files. */
export interface ShownBack {
  readonly mid: string;
  readonly text: string;
  readonly ts: number;
  readonly files: SentFile[];
}

export function createSentFiles(d: SentFilesDeps) {
  let book: SentFilesBook = readSentFiles();
  const save = (next: SentFilesBook) => {
    book = next;
    try {
      localStorage.setItem(SENT_FILES_KEY, JSON.stringify(next));
    } catch {
      /* no storage: the bubbles still show their files until the app closes */
    }
  };

  /** Each session's bubble previews: a preview holds the picture's bytes for as long as its URL lives, and nothing else
   *  frees it. */
  const previews = new Map<string, string[]>();
  /** The bubble's own preview of a file (the composer lets go of its chips' copies when it goes). */
  const preview = (id: string, name: string, kind: SentFile["kind"], bytes: Uint8Array): string | null => {
    if (kind === "file") return null;
    const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: blobType(name) }));
    previews.set(id, [...(previews.get(id) ?? []), url]);
    return url;
  };

  return {
    /** Whether session `id` has sent files kept, so its restored chat is opened with them. */
    has: (id: string): boolean => !!book[id],

    /** A message with files, ready for the agent: each file saved under the session's own folder (pictures the agent reads
     *  itself listed apart), the text naming the others. Throws on the first file that cannot be saved; then nothing is sent. */
    async prepare(id: string, text: string, files: readonly OutFile[]): Promise<Prepared> {
      const images: string[] = [];
      const named: string[] = [];
      const saved: SavedFile[] = [];
      const shown: SentFile[] = [];
      for (const f of files) {
        let path: string;
        let bytes: Uint8Array;
        try {
          bytes = bytesOf(await f.read());
          path = await d.saveFile(id, f.name, bytes);
        } catch (e) {
          throw new Error(tr("att.failed", { name: f.name, error: errText(e) }));
        }
        (inlinePicture(f.name, f.size) ? images : named).push(path);
        saved.push({ name: f.name, size: f.size, kind: f.kind, path });
        shown.push({ name: f.name, size: f.size, kind: f.kind, url: preview(id, f.name, f.kind, bytes) });
      }
      return { input: { kind: "send", text: wireText(text, named), ...(images.length ? { images } : {}) }, saved, shown };
    },

    /** Keeps a message that went out with its files, so its bubble shows them again after a restart. */
    keep(id: string, text: string, saved: readonly SavedFile[], now: number = Date.now()): void {
      save(putSentFiles(book, id, String(now), { ts: now / 1000, text, files: [...saved] }));
    },

    /** The bubbles session `id`'s book brings back, one at a time, each file read again from its saved copy (one that cannot
     *  be read is shown as a plain file), leaving out those older than `oldest` (seconds), which the chat no longer keeps. One
     *  at a time, so the caller can stop as soon as its chat has loaded, before the next one's files are read. */
    async *shownBack(id: string, oldest: number): AsyncGenerator<ShownBack> {
      for (const [mid, e] of Object.entries(book[id] ?? {})) {
        if (e.ts < oldest - 1) continue;
        const files: SentFile[] = await Promise.all(
          e.files.map(async (f): Promise<SentFile> => {
            if (f.kind === "file") return { name: f.name, size: f.size, kind: f.kind, url: null };
            try {
              return { name: f.name, size: f.size, kind: f.kind, url: preview(id, f.name, f.kind, await d.readFile(f.path)) };
            } catch {
              return { name: f.name, size: f.size, kind: "file", url: null };
            }
          }),
        );
        yield { mid, text: e.text, ts: e.ts, files };
      }
    },

    /** Forgets session `id`'s kept files and lets go of its previews (it was closed). */
    forget(id: string): void {
      if (book[id]) {
        const next = { ...book };
        delete next[id];
        save(next);
      }
      for (const url of previews.get(id) ?? []) URL.revokeObjectURL(url);
      previews.delete(id);
    },

    /** Keeps only the sessions in `ids` (a restore: the others are gone). */
    keepOnly(ids: readonly string[]): void {
      save(Object.fromEntries(Object.entries(book).filter(([sid]) => ids.includes(sid))));
    },
  };
}

export type SentFiles = ReturnType<typeof createSentFiles>;
