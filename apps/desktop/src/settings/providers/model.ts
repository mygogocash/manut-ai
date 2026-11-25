// Settings › Providers (item 74), the pure half: what the shell sends for each agent (`View` in
// src-tauri/src/providers.rs), the form the page edits and the patch it sends back, the checks the page runs before the
// shell does (the same table, argRules.json, which a Rust test holds equal to the shell's), and the words for a
// refusal. A variable's value goes to the shell once and never comes back: the view carries names only, and a saved
// variable the person did not retype is sent without a value, which tells the shell to keep the one it has.
import RULES from "./argRules.json";
import { t, type Key } from "../../i18n";

/** One agent as the shell describes it for this page. */
export interface ProviderView {
  id: string;
  /** The agent's own name. */
  label: string;
  kind: "main" | "builtin" | "acp" | "custom";
  mode: "chat" | "hermes" | "terminal";
  off: boolean;
  /** The display name the person set ("" = the agent's own). */
  name: string;
  /** Where its program is for a session now, or null: not installed. */
  found: string | null;
  /** The path the person set ("" = found as always), and whether it is a program here now. */
  path: string;
  path_ok: boolean;
  home_var: string | null;
  home: string;
  args: string[];
  /** Variable names only. */
  env: string[];
  takes_path: boolean;
  takes_args: boolean;
  takes_vars: boolean;
  /** The page may ask for its version, and its sign-in can be read (Claude Code, Codex). */
  version: boolean;
  signin: boolean;
  /** The command a chat and a terminal of it start with now, for the page to show. */
  chat: string | null;
  terminal: string | null;
}

/** A variable on the form: a saved one keeps its value in the shell until the person types a new one (`value` null). */
export interface VarRow {
  name: string;
  value: string | null;
  /** It was saved before (its value is in the shell, never here). */
  saved: boolean;
}

export interface ProviderForm {
  name: string;
  path: string;
  home: string;
  /** One argument per line. */
  args: string;
  env: VarRow[];
}

/** What the page sends: only the fields it changes. A variable without a value keeps the saved one. */
export interface ProviderPatch {
  off?: boolean;
  name?: string;
  path?: string;
  home?: string;
  args?: string[];
  env?: { name: string; value?: string }[];
}

export function formOf(v: ProviderView): ProviderForm {
  return { name: v.name, path: v.path, home: v.home, args: v.args.join("\n"), env: v.env.map((name) => ({ name, value: null, saved: true })) };
}

/** The lines of the arguments field, each one argument as typed (never split on spaces), empty lines dropped. */
export const argLines = (text: string): string[] => text.split("\n").map((l) => l.replace(/\r$/, "")).filter((l) => l.trim() !== "");

/** The patch for what changed between `v` and the form. Every variable row goes, the saved ones the person did not
 *  retype without a value. */
export function patchOf(v: ProviderView, f: ProviderForm): ProviderPatch {
  const p: ProviderPatch = {};
  if (f.name.trim() !== v.name) p.name = f.name.trim();
  if (f.path.trim() !== v.path) p.path = f.path.trim();
  if (f.home.trim() !== v.home) p.home = f.home.trim();
  const args = argLines(f.args);
  if (args.join("\n") !== v.args.join("\n")) p.args = args;
  const rows = f.env.filter((r) => r.name.trim() !== "" || (r.value ?? "") !== "");
  const changed = rows.length !== v.env.length || rows.some((r, i) => r.name.trim() !== v.env[i] || r.value !== null);
  if (changed) p.env = rows.map((r) => (r.value === null ? { name: r.name.trim() } : { name: r.name.trim(), value: r.value }));
  return p;
}

export const isEmptyPatch = (p: ProviderPatch): boolean => Object.keys(p).length === 0;

/** The name the page shows: the display name, else the agent's own. */
export const shownName = (v: Pick<ProviderView, "name" | "label">): string => v.name || v.label;

// ---- the checks the shell makes, run first on the page -----------------------------------------------------

export type Why =
  | "unknown"
  | "name"
  | "path_shape"
  | "path_run"
  | "path_none"
  | "home_shape"
  | "home_missing"
  | "home_none"
  | "arg_shape"
  | "arg_skips"
  | "arg_own"
  | "arg_unlisted"
  | "arg_many"
  | "arg_unchecked"
  | "arg_cmd"
  | "var_name"
  | "var_own"
  | "var_home"
  | "var_many"
  | "var_value"
  | "var_keep"
  | "var_none"
  | "file";

export interface Refusal {
  why: Why;
  what: string;
}

interface Rules {
  id: string;
  skips: string[];
  own: string[];
  config: string[];
  config_keys: string[];
  config_allow: string[];
  allow: string[];
  vars: string[];
}
const TABLE = RULES as { rules: Rules[]; appVars: string[]; homeVars: Record<string, string>; versionAgents: string[] };
export const MAX_ARGS = 16;
export const ARG_MAX = 512;
export const MAX_VARS = 32;

/** Agent `id`'s option rules, or undefined: its options were not read here, so it takes no extra arguments. */
export const rulesOf = (id: string): Rules | undefined => TABLE.rules.find((r) => r.id === id);
export const homeVarOf = (id: string): string | undefined => TABLE.homeVars[id];
export const versionAgent = (id: string): boolean => TABLE.versionAgents.includes(id);

/** The option an argument names and whether it is long: `--name[=v]` or `-x[=v]`; null for anything else. */
export function optionOf(a: string): [string, boolean] | null {
  if (a.startsWith("--")) {
    const name = a.slice(2).split("=")[0];
    return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) ? [name, true] : null;
  }
  const m = /^-([A-Za-z0-9])(=.*)?$/s.exec(a);
  return m ? [m[1], false] : null;
}

/** The shell's `norm`: a name whatever its spelling, case folded and with every `-` and `_` taken out, so
 *  `approval-mode`, `approval_mode` and `approvalMode` (yargs reads all three) are one name. */
const norm = (n: string) => n.replace(/[-_]/g, "").toLowerCase();
/** The shell's `names`: to refuse, a long name against every entry, as its `--no-` form and by its part before a dot. */
function names(list: string[], name: string, long: boolean): boolean {
  if (!long) return list.some((r) => r.length === 1 && r === name);
  const forms = [norm(name), norm(name.split(".")[0])];
  return list.map(norm).some((r) => forms.some((n) => n === r || (n.startsWith("no") && n.slice(2) === r)));
}
/** The shell's `listed`: on the short list known to be harmless, whole. */
function listed(list: string[], name: string, long: boolean): boolean {
  if (!long) return list.some((r) => r.length === 1 && r === name);
  return !name.includes(".") && list.some((r) => norm(r) === norm(name));
}
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

/** The shell's `check_args`: the first refusal, or null. */
export function checkArgs(id: string, args: string[]): Refusal | null {
  if (!args.length) return null;
  const r = rulesOf(id);
  if (!r) return { why: "arg_unchecked", what: "" };
  if (args.length > MAX_ARGS) return { why: "arg_many", what: "" };
  for (const a of args) {
    const o = optionOf(a);
    if (!o || a.length > ARG_MAX || CONTROL.test(a)) return { why: "arg_shape", what: o?.[0] ?? "" };
    const [name, long] = o;
    const shown = long ? `--${name}` : `-${name}`;
    if (names(r.skips, name, long)) return { why: "arg_skips", what: shown };
    if (names(r.own, name, long)) return { why: "arg_own", what: shown };
    if (names(r.config, name, long)) {
      const key = (a.includes("=") ? a.slice(a.indexOf("=") + 1) : "").split("=")[0].trim().toLowerCase();
      if (!key || r.config_keys.some((k) => key.startsWith(k))) return { why: "arg_skips", what: shown };
      if (!r.config_allow.includes(key)) return { why: "arg_unlisted", what: shown };
      continue;
    }
    // the rule turned round: anything not known to be harmless is refused, since no help prints a CLI's hidden options
    if (!listed(r.allow, name, long)) return { why: "arg_unlisted", what: shown };
  }
  return null;
}

/** The shell's `check_vars` for the names (a saved value is checked in the shell). */
export function checkVars(id: string, vars: { name: string; value?: string | null }[], takes = true): Refusal | null {
  if (!vars.length) return null;
  if (!takes) return { why: "var_none", what: "" };
  if (vars.length > MAX_VARS) return { why: "var_many", what: "" };
  const seen = new Set<string>();
  for (const v of vars) {
    const shape = v.name.length <= 128 && /^[A-Za-z_][A-Za-z0-9_]*$/.test(v.name);
    const upper = v.name.toUpperCase();
    if (!shape || seen.has(upper)) return { why: "var_name", what: shape ? v.name : "" };
    seen.add(upper);
    const home = homeVarOf(id);
    if (home && norm(home) === norm(v.name)) return { why: "var_home", what: v.name };
    const own = TABLE.appVars.some((a) => norm(a) === norm(v.name)) || upper.startsWith("MANUT_") || !!rulesOf(id)?.vars.some((x) => norm(x) === norm(v.name));
    if (own) return { why: "var_own", what: v.name };
    if (typeof v.value === "string" && (v.value.length > 8192 || v.value.includes("\0"))) return { why: "var_value", what: v.name };
  }
  return null;
}

/** A refusal from `why:<code>` or `why:<code>:<name>` (the shell's), or null for any other error. */
export function refusalOf(e: unknown): Refusal | null {
  const text = typeof e === "object" && e && "message" in e ? String((e as { message: unknown }).message) : String(e);
  const m = /^why:([a-z_]+)(?::(.*))?$/s.exec(text.trim());
  return m ? { why: m[1] as Why, what: m[2] ?? "" } : null;
}

const WHY_KEY: Record<Why, Key> = {
  unknown: "prov.why.unknown",
  name: "prov.why.name",
  path_shape: "prov.why.pathShape",
  path_run: "prov.why.pathRun",
  path_none: "prov.why.pathNone",
  home_shape: "prov.why.homeShape",
  home_missing: "prov.why.homeMissing",
  home_none: "prov.why.homeNone",
  arg_shape: "prov.why.argShape",
  arg_skips: "prov.why.argSkips",
  arg_own: "prov.why.argOwn",
  arg_unlisted: "prov.why.argUnlisted",
  arg_many: "prov.why.argMany",
  arg_unchecked: "prov.why.argUnchecked",
  arg_cmd: "prov.why.argCmd",
  var_name: "prov.why.varName",
  var_own: "prov.why.varOwn",
  var_home: "prov.why.varHome",
  var_many: "prov.why.varMany",
  var_value: "prov.why.varValue",
  var_keep: "prov.why.varKeep",
  var_none: "prov.why.varNone",
  file: "prov.why.file",
};

/** A refusal in words, naming the option or variable (never a value) and the agent. */
export function refusalText(r: Refusal, agent: string): string {
  const key = WHY_KEY[r.why] ?? "prov.why.unknown";
  return t(key, { what: r.what || "", agent, n: r.why === "arg_many" ? MAX_ARGS : MAX_VARS });
}

/** Any error from a save in words: a refusal by its code, anything else as the shell said it. */
export function errorText(e: unknown, agent: string): string {
  const r = refusalOf(e);
  if (r) return refusalText(r, agent);
  return typeof e === "object" && e && "message" in e ? String((e as { message: unknown }).message) : String(e);
}

/** What the form would send, checked as the shell will check it; null when it passes. */
export function checkForm(v: ProviderView, f: ProviderForm): Refusal | null {
  const args = argLines(f.args);
  if (args.length && !v.takes_args) return { why: "arg_unchecked", what: "" };
  return checkArgs(v.id, args) ?? checkVars(v.id, f.env.filter((r) => r.name.trim() !== "" || (r.value ?? "") !== "").map((r) => ({ name: r.name.trim(), value: r.value })), v.takes_vars);
}

/** A sign-in as the page read it (the Accounts copy's status of the account new sessions use). */
export interface SignIn {
  logged_in: boolean;
  email?: string | null;
  plan?: string | null;
}

/** The row's line under the name: turned off, not installed, its set path no longer a program, else the sign-in when
 *  the app can read one (Claude Code, Codex), else installed. An agent with no check of its own gets none. */
export function statusLine(v: ProviderView, signin: SignIn | null | undefined, plan: (p?: string | null) => string): { text: string; tone: "off" | "warn" | "ok" | "quiet" } {
  if (v.off) return { text: t("prov.offLine"), tone: "off" };
  if (v.path && !v.path_ok) return { text: t("prov.pathGone"), tone: "warn" };
  if (!v.found) return { text: t("ag.notInstalled"), tone: "quiet" };
  if (v.signin && signin) {
    if (!signin.logged_in) return { text: t("prov.signedOut"), tone: "warn" };
    const who = [signin.email, plan(signin.plan)].filter(Boolean).join(" · ");
    return { text: who ? t("prov.signedInAs", { who }) : t("prov.signedIn"), tone: "ok" };
  }
  return { text: t("ag.installed"), tone: "ok" };
}
