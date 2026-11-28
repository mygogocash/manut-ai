// Permissions for each connection (item 108b; docs/multi-machine.md, part 11, rules R2, R5 and R6): what a paired device
// may ask this machine for. The machine checks it for every request (serve.ts), reading the level from the device's own
// record by the channel's device id, never from anything the device sends. It is pure, so the whole table is tested cell
// by cell (levels.test.ts), and the phases after this one (108c to 108i) add handlers only: the table is whole now.
//
// Three levels, each with everything of the one before:
//   watch    see the chats and their asks, say No, stop a turn, see pictures and the machine's state
//   answer   also Allow once and answer questions, each with a passkey: exactly what a phone could do before this item
//   work     also start lanes, message coding chats, view the preview, move projects
// and two permissions that only Work holds:
//   terminal open a terminal
//   manage   update the machine, pair a device from afar, change levels, see its masked report
//
// It lives in the desktop for now because only the machine checks levels; the page learns of a refusal only by its code,
// `level`. Item 108d, which hides the phone's buttons by level, moves it into a package the page shares.

export const LEVELS = ["watch", "answer", "work"] as const;
export type Level = (typeof LEVELS)[number];

export const PERMISSIONS = ["terminal", "manage"] as const;
export type Permission = (typeof PERMISSIONS)[number];

/** What one connection holds: a level, and the permissions only Work may hold. */
export interface Grant {
  readonly level: Level;
  readonly terminal: boolean;
  readonly manage: boolean;
}

/** What a device paired before this item holds, and what every new pairing gets: Answer, so a phone paired today keeps
 *  exactly today's requests. */
export const DEFAULT_GRANT: Grant = Object.freeze({ level: "answer", terminal: false, manage: false });

/** The levels Settings offers the person at this Mac. Work and its permissions come once their requests exist (108c and
 *  later): offering them before would promise a phone something no request of this build does. */
export const OFFERED_LEVELS: readonly Level[] = ["watch", "answer"];

const RANK: Readonly<Record<Level, number>> = { watch: 0, answer: 1, work: 2 };

/** A grant this build understands: a known level, and Terminal and Manage only with Work. Anything else is no grant at
 *  all, never a wider or a default one. */
export function isGrant(value: unknown): value is Grant {
  if (value === null || typeof value !== "object") return false;
  const { level, terminal, manage } = value as Record<string, unknown>;
  if (typeof level !== "string" || !(LEVELS as readonly string[]).includes(level)) return false;
  if (typeof terminal !== "boolean" || typeof manage !== "boolean") return false;
  return level === "work" || (!terminal && !manage);
}

/** When the person's passkey must answer a challenge before the machine acts (rule R6). */
export type Passkey =
  /** It only reads, or only holds something back. */
  | "none"
  /** Every time. */
  | "each"
  /** The first Work request of a session, and the first after 15 minutes without one. */
  | "session";

/** What one request needs. */
export interface Rule {
  /** The least level. */
  readonly level: Level;
  /** A permission it needs besides; only Work holds one. */
  readonly permission: Permission | null;
  readonly passkey: Passkey;
}

/** One row of the table: a request's rule, and the narrower rule of the one form some requests have. */
export interface Row extends Rule {
  /** `reply` that says No: it only holds back. */
  readonly no?: Rule;
  /** A request that acts on the asking connection alone: `revoke` removing itself, and `set_level` narrowing its own
   *  level (R5), which `mayGive` checks narrows. */
  readonly own?: Rule;
}

const rule = (level: Level, passkey: Passkey, permission: Permission | null = null): Rule => Object.freeze({ level, permission, passkey });

/** Every request a connection can name, from part 11's table, with `notify` (item 78d) beside it. Passkeys follow its
 *  column: a move asks on each side when it moves (`move_out`, `move_in`), not when it lists; a terminal asks at each
 *  opening; `update` asks and `report` does not. */
export const REQUEST_TABLE: ReadonlyMap<string, Row> = new Map<string, Row>([
  ["list", rule("watch", "none")],
  ["open", rule("watch", "none")],
  ["catchup", rule("watch", "none")],
  // Answering a question steers the agent as an Allow does; No only holds back.
  ["reply", { ...rule("answer", "each"), no: rule("watch", "none") }],
  ["stop", rule("watch", "none")],
  ["status", rule("watch", "none")],
  ["picture", rule("watch", "none")],
  // This device's own push address: it acts on nothing of the machine's and reaches only the device that asked, so it
  // belongs with watching (a notification says only that the machine needs the person).
  ["notify", rule("watch", "none")],
  ["allow", rule("answer", "each")],
  ["projects", rule("work", "none")],
  ["start", rule("work", "session")],
  ["send", rule("work", "session")],
  ["view_open", rule("work", "session")],
  ["view_input", rule("work", "session")],
  ["view_close", rule("work", "session")],
  ["move_list", rule("work", "none")],
  ["move_out", rule("work", "each")],
  ["move_in", rule("work", "each")],
  ["term_open", rule("work", "each", "terminal")],
  ["term_input", rule("work", "none", "terminal")],
  ["term_resize", rule("work", "none", "terminal")],
  ["term_close", rule("work", "none", "terminal")],
  ["update", rule("work", "each", "manage")],
  ["report", rule("work", "none", "manage")],
  ["pair_code", rule("work", "each", "manage")],
  ["pair_allow", rule("work", "each", "manage")],
  ["set_level", { ...rule("work", "each", "manage"), own: rule("watch", "none") }],
  // Revoking only removes power, so any connection may, with a passkey unless it removes itself.
  ["revoke", { ...rule("watch", "each"), own: rule("watch", "none") }],
]);

/** Refused by name at every level: what stays on the machine, as 78's list stayed on the Mac (Kit's dial, a lane's mode,
 *  Always allow and Allow this folder, a road or the main switch, pairing at the machine, the consent sheets, the
 *  agents' sign-ins, the credential vault, and Settings). Replaces serve.ts's `STAYS_ON_MAC`. */
export const STAYS_ON_MACHINE: ReadonlySet<string> = new Set([
  "always",
  "allow_always",
  "session",
  "allow_session",
  "folder",
  "dial",
  "mode",
  "pair",
  "unpair",
  "switch",
  "consent",
  "road",
  "sign_in",
  "vault",
  "settings",
]);

/** Whether `grant` holds what `rule` needs. A grant this build does not understand holds nothing. */
export function covers(grant: Grant, need: Rule): boolean {
  if (!isGrant(grant)) return false;
  if (RANK[grant.level] < RANK[need.level]) return false;
  return need.permission === null || grant[need.permission];
}

/** The rule one request needs, or null for a name not in the table. `reply` is a No only when it says no and carries no
 *  answer, so a request never passes as a No and is then read as an answer. `own` is the handler's to say, once it has
 *  read whom the request is about (its own `revoke`, or `set_level` narrowing its own level). */
export function ruleFor(name: string, request: Readonly<Record<string, unknown>>, own = false): Rule | null {
  const row = REQUEST_TABLE.get(name);
  if (!row) return null;
  if (row.no && request.no === true && request.answer === undefined && request.answers === undefined) return row.no;
  if (row.own && own) return row.own;
  return rule(row.level, row.passkey, row.permission);
}

/** Whether `narrower` holds nothing that `wider` lacks. */
export function within(narrower: Grant, wider: Grant): boolean {
  if (!isGrant(narrower) || !isGrant(wider)) return false;
  return RANK[narrower.level] <= RANK[wider.level] && (!narrower.terminal || wider.terminal) && (!narrower.manage || wider.manage);
}

/** Whether a connection holding `giver` may set a connection to `wanted` (R5): only with Manage, and never above its own,
 *  so Manage without Terminal cannot give Terminal. With `own` (the connection is the giver's own) it may always narrow,
 *  Manage or not, and never widen. Revoking is not this: it removes and is never capped. */
export function mayGive(giver: Grant, wanted: Grant, own: boolean): boolean {
  if (!within(wanted, giver)) return false;
  return own || giver.manage;
}
