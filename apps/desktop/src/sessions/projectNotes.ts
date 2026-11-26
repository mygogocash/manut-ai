// Item 93: the project's own instructions, as the chat says them. A chat's Claude Code or OpenCode no longer reads a
// project's CLAUDE.md, rules or AGENTS.md itself (item 89), so the shell reads them as plain text and hands them over
// (src-tauri/src/project_notes.rs). It tells the page once, as a `session.note` of kind `instructions`, which files the
// agent was given and which were left out and why; this turns that into the chat's one quiet line.
import { listText, t as tr, type Key } from "../i18n";

/** Why the shell left a file out (`project_notes::Why`). */
const WHY = ["link", "size", "total", "text", "scoped", "unsent"] as const;
type Why = (typeof WHY)[number];

/** How many names a line spells out before it counts the rest. */
const SHOWN = 3;

const names = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.length > 0) : []);

/** The files left out, as the shell sent them: a path and one of [`WHY`]; anything else is dropped. */
const leftOut = (v: unknown): { path: string; why: Why }[] =>
  Array.isArray(v)
    ? v.flatMap((x) => {
        const o = (x ?? {}) as { path?: unknown; why?: unknown };
        return typeof o.path === "string" && o.path && WHY.includes(o.why as Why) ? [{ path: o.path, why: o.why as Why }] : [];
      })
    : [];

/** `items` as one list in the person's language, the first [`SHOWN`] by name and the rest counted. */
const some = (items: string[]): string =>
  listText(items.length > SHOWN ? [...items.slice(0, SHOWN), tr("ss.notes.more", { n: items.length - SHOWN })] : items);

/** The chat's line for an `instructions` note (`{read, left}`), or null when it names nothing. */
export function notesSaid(ev: { read?: unknown; left?: unknown }): string | null {
  const read = names(ev.read);
  const left = leftOut(ev.left);
  const said: string[] = [];
  if (read.length > 0) said.push(tr("ss.notes.read", { names: some(read) }));
  if (left.length > 0) said.push(tr("ss.notes.left", { items: some(left.map((l) => tr("ss.notes.item", { name: l.path, why: tr(`ss.notes.why.${l.why}` as Key) }))) }));
  return said.length > 0 ? said.join(" ") : null;
}
