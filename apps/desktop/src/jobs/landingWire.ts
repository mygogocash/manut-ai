// What the shell answers for a helper lane's landing (item 102i; the shell's `lane_land`, `lane_take_back` and `lane_patch` in
// src-tauri/src/lane_land.rs, item 102g), read field by field so a shell of another version, or an answer that is not one, is never
// taken for a landing. `landingOf` turns an answer, or a refusal, into item 102d's `Landing` (rules.ts), which the Helpers card's row
// and the round's report carry; `patchFiles` turns a kept patch's text into the diff view's files for Show patch.
import type { DiffFile } from "../lib/protocol";
import type { Landing } from "./rules";

/** The shell's `Landed`: `outcome` is `landed` (conflicts included), `nothing` or `kept`; `why`, for `kept`, is `outside`,
 *  `bad_path`, `other_repo` or `would_not_apply`. Paths are from the top of the repository, as git writes them. */
export interface LaneLanded {
  readonly outcome: "landed" | "nothing" | "kept";
  readonly files: readonly string[];
  readonly filesTotal: number;
  readonly conflicts: readonly string[];
  readonly keys: readonly string[];
  readonly patch: string;
  readonly why: string;
  readonly outside: readonly string[];
  readonly error: string;
}

/** The shell's `TakenBack`: the files Take back put back. */
export interface LaneTakenBack {
  readonly files: readonly string[];
  readonly filesTotal: number;
}

/** The shell's `KeptPatch`: a kept patch's text, every line masked by the shell, cut when the file is larger than it reads. */
export interface LanePatch {
  readonly text: string;
  readonly bytes: number;
  readonly cut: boolean;
  readonly path: string;
}

const strings = (v: unknown): string[] | null => (Array.isArray(v) && v.every((x) => typeof x === "string") ? (v as string[]) : null);
const count = (v: unknown): number | null => (typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : null);

export function readLanded(v: unknown): LaneLanded | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const outcome = o.outcome;
  if (outcome !== "landed" && outcome !== "nothing" && outcome !== "kept") return null;
  const files = strings(o.files);
  const conflicts = strings(o.conflicts ?? []);
  const keys = strings(o.keys ?? []);
  const outside = strings(o.outside ?? []);
  if (!files || !conflicts || !keys || !outside) return null;
  const total = count(o.files_total) ?? files.length;
  const text = (x: unknown) => (typeof x === "string" ? x : "");
  return { outcome, files, filesTotal: Math.max(total, files.length), conflicts, keys, patch: text(o.patch), why: text(o.why), outside, error: text(o.error) };
}

export function readTakenBack(v: unknown): LaneTakenBack | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const files = strings(o.files);
  if (!files) return null;
  return { files, filesTotal: Math.max(count(o.files_total) ?? files.length, files.length) };
}

export function readPatch(v: unknown): LanePatch | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  if (typeof o.text !== "string" || typeof o.path !== "string") return null;
  return { text: o.text, bytes: count(o.bytes) ?? o.text.length, cut: o.cut === true, path: o.path };
}

/** A landing as item 102d's rules and the row carry it, from the shell's answer. A patch kept without being tried names its reason
 *  as `refusal` (outside the project, a name the app cannot hold, another repository); one git would not apply keeps git's line as
 *  `error`. */
export function landingOf(a: LaneLanded): Landing {
  const more = a.filesTotal - a.files.length;
  const base = { files: a.files.map((path) => ({ path })), ...(more > 0 ? { more } : {}), ...(a.keys.length ? { keys: [...a.keys] } : {}) };
  if (a.outcome === "nothing") return { files: [], conflicts: [] };
  if (a.outcome === "landed") return { ...base, conflicts: [...a.conflicts] };
  const why = a.why || "would_not_apply";
  if (why === "would_not_apply") return { ...base, conflicts: [], patchPath: a.patch, error: a.error || why };
  return { ...base, conflicts: [], patchPath: a.patch, refusal: why, ...(a.outside.length ? { outside: [...a.outside] } : {}) };
}

/** A landing the shell refused, or one that could not be asked for: nothing was written in the lead's folder. `code` is the
 *  shell's short code (`busy`, `no_snapshot`, `config:<setting>`, ...) or git's own line. */
export const refusedLanding = (code: string): Landing => ({ files: [], conflicts: [], error: code || "unread" });

/** The most lines Show patch draws for one file; the rest are counted under it. */
export const PATCH_LINES = 400;

/** A kept patch's text as the diff view's files (`DiffView`): one per `diff --git` block, its hunks' lines (an `@@` line opens each,
 *  as the view reads it), what it added and removed, and a binary file's note in place of its lines. The text is the shell's,
 *  already masked; the view masks each line again as it draws it. Lines before the first block are not a file's and are left out. */
export function patchFiles(text: string): DiffFile[] {
  const out: DiffFile[] = [];
  let f: DiffFile | null = null;
  let inHunk = false;
  const push = (line: string) => {
    if (!f) return;
    if (f.lines.length < PATCH_LINES) f.lines.push(line);
    else f.more = (f.more ?? 0) + 1;
  };
  for (const raw of text.split("\n")) {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (line.startsWith("diff --git ")) {
      // `diff --git a/<path> b/<path>`: without renames both name the same file, so the second half is the path
      const at = line.indexOf(" b/");
      f = { path: at >= 0 ? line.slice(at + 3) : line.slice(11), kind: "update", lines: [], added: 0, removed: 0 };
      out.push(f);
      inHunk = false;
      continue;
    }
    if (!f) continue;
    if (!inHunk) {
      if (line.startsWith("new file mode")) f.kind = "add";
      else if (line.startsWith("deleted file mode")) f.kind = "delete";
      else if (line.startsWith("GIT binary patch") || line.startsWith("Binary files ")) f.note = "binary";
      else if (line.startsWith("@@")) {
        inHunk = true;
        push(line);
      }
      continue;
    }
    if (line.startsWith("@@")) push(line);
    else if (line.startsWith("+")) {
      f.added++;
      push(line);
    } else if (line.startsWith("-")) {
      f.removed++;
      push(line);
    } else if (line.startsWith(" ")) push(line);
    // "\ No newline at end of file" and the empty line the text ends with are not lines of the file
  }
  return out;
}
