// The last problems this run met, kept in memory only (never on disk, never sent): a turn that failed, a session that
// would not start, a call the runtime refused, a page error. Settings › Report a problem reads them. Each is kept as one
// short masked line, so what is held is already safe to show; report.ts cleans it once more when it writes the report.
import { maskSecrets } from "../lib/secrets";
import { changes } from "../lib/changes";

/** How many are kept. The report shows at most 20 of them. */
export const KEEP = 50;
/** The longest a kept line is: a cause, never a transcript. */
export const LINE_MAX = 160;

export interface KeptError {
  at: number;
  /** Where it came from: `chat`, `session` or `page`. */
  source: "chat" | "session" | "page";
  text: string;
}

const kept: KeptError[] = [];
const listeners = changes();

/** The first line of `text`, masked and cut. Nothing else of the message is kept. */
export function oneLine(text: string): string {
  const first = text.split(/\r?\n/).find((l) => l.trim() !== "") ?? "";
  const clean = maskSecrets(first.trim());
  return clean.length > LINE_MAX ? `${clean.slice(0, LINE_MAX - 1)}…` : clean;
}

/** Keep one problem. Empty text is not a problem and is dropped; the oldest go past `KEEP`. */
export function recordError(source: KeptError["source"], text: string, at: number = Date.now()): void {
  const line = oneLine(text);
  if (!line) return;
  const last = kept[kept.length - 1];
  // the same cause twice in the same second is one problem (a retry loop must not fill the list)
  if (last && last.source === source && last.text === line && at - last.at < 1000) return;
  kept.push({ at, source, text: line });
  while (kept.length > KEEP) kept.shift();
  listeners.emitSnapshot();
}

/** The kept problems, newest first. */
export function recentErrors(): KeptError[] {
  return [...kept].reverse();
}

export function onErrors(f: () => void): () => void {
  return listeners.subscribe(f);
}

/** Tests only. */
export function clearErrors(): void {
  kept.length = 0;
}

let watching = false;
/** Hear the page's own uncaught errors and refused promises, once. */
export function watchPageErrors(w: Pick<Window, "addEventListener"> | undefined = typeof window === "undefined" ? undefined : window): void {
  if (watching || !w) return;
  watching = true;
  w.addEventListener("error", (e) => recordError("page", (e as ErrorEvent).message || ""));
  w.addEventListener("unhandledrejection", (e) => {
    const r = (e as PromiseRejectionEvent).reason as unknown;
    recordError("page", r instanceof Error ? r.message : typeof r === "string" ? r : "");
  });
}
