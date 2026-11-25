// The palette's list for what is typed: three groups in a fixed order (Go to, Do, Chats) and, last, a row that carries
// the typed words to History. The order is the order of the person's questions: where do I want to be, what do I want
// done, and only then something I said before.
import { t, type Key } from "../i18n";
import { matches } from "./filter";
import { doRows, goRows, type PaletteCtx, type Row } from "./registry";

export interface Group {
  key: "go" | "do" | "chats" | "history";
  /** the heading's words; none for the lone History row */
  heading?: Key;
  rows: Row[];
}

/** The most chats the list shows: the rest are one press away in History, by the last row. */
export const CHAT_LIMIT = 5;

/** The groups for `query`. With nothing typed the list is short: the menu's pages and what can be done here; typing
 *  also finds the Settings pages and the chats. `chats` are the rows History's own search found for the same words
 *  (the caller runs that search), kept as they are. Empty groups are left out. */
export function buildGroups(c: PaletteCtx, query: string, chats: readonly Row[]): Group[] {
  const q = query.trim();
  const go = goRows(c).filter((r) => (q ? matches(r.label, q) : !r.id.startsWith("go:settings:")));
  const act = doRows(c).filter((r) => matches(r.label, q));
  const found = q ? chats.slice(0, CHAT_LIMIT) : [];
  const groups: Group[] = [
    { key: "go", heading: "pal.go", rows: go },
    { key: "do", heading: "pal.do", rows: act },
    { key: "chats", heading: "pal.chats", rows: found },
  ];
  if (q) groups.push({ key: "history", rows: [{ id: "history:search", label: t("pal.history", { q }), run: () => c.openHistory(q) }] });
  return groups.filter((g) => g.rows.length > 0);
}

export const flat = (groups: readonly Group[]): Row[] => groups.flatMap((g) => g.rows);
