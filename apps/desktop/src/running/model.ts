// What keeps running (docs/code-editor.md, the canvas's StatesCodeDev board, "Something that keeps running"): the
// commands that this app's own sessions started and that are still running. The shell reads them from the system
// (src-tauri/src/running.rs); this file says what a row shows of one, as pure functions with no page and no clock of
// their own: the command in words a person recognises, how long it has run, the port it listens on, and which rows
// are listed.
import { elapsed } from "../app/time";
import { t } from "../i18n";
import { maskSecrets } from "../lib/secrets";
import { pathKey } from "../sessions/folders";
import { duration } from "../sidebar/usageFormat";

/** One command still running, as the shell reports it (`Row` in src-tauri/src/running.rs). It is the command a
 *  session's shell or agent started, and what it started in turn is part of it: `ports` are the ones any of them listens
 *  on. `argv` is the command's own program and arguments, as the system holds them. */
export interface RunningRow {
  /** A terminal (the shell's pty) or a chat (an agent on pipes). */
  kind: "pty" | "chat";
  /** The id the shell gave that terminal or chat. */
  session: number;
  /** The folder the session started in: the project it belongs to. */
  folder: string;
  pid: number;
  /** When the system says the command started, ms since the epoch; null when it would not say. */
  started: number | null;
  argv: string[];
  /** TCP ports it, or a process it started, listens on, lowest first. */
  ports: number[];
}

/** A command is listed once it has run this long: one that ends in a moment (a `git status`) is never a row, so a row
 *  never flickers in and out under the person's eyes. A dev server is listed this soon after it starts. */
export const MIN_AGE_MS = 5_000;

/** How many characters of a command a row shows; a longer one ends in an ellipsis. */
export const COMMAND_MAX = 160;

/** The same command run again, or one that took a process number a finished command had, is another row. */
export const rowKey = (r: Pick<RunningRow, "kind" | "session" | "pid" | "started">): string => `${r.kind}:${r.session}:${r.pid}:${r.started ?? 0}`;

// ---- the command in words ---------------------------------------------------------------------------------------

const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "mksh", "ash", "fish", "csh", "tcsh"]);
const INTERPRETER = /^(?:node|nodejs|bun|ruby|perl|php|python[\d.]*|pypy[\d.]*)$/;
/** node's and python's options that take the next word, and the ones whose next word is code, not a script. */
const TAKES_VALUE = new Set(["-r", "--require", "--import", "--loader", "--experimental-loader"]);
const INLINE_CODE = new Set(["-e", "-p", "--eval", "--print", "-c"]);
/** A package manager's own script, however it was installed (`npm-cli.js`, `pnpm.cjs`, `yarn-4.1.0.cjs`). */
const RUNNER = /^(pnpm|npm|npx|yarn)(?:-cli|-[\d.]+)?\.(?:c|m)?js$/;
const SCRIPT_FILE = /\.(?:c|m)?[jt]s$|\.(?:py|rb|sh|pl|php)$/;

const base = (path: string): string => path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? path;
/** A program's own name: a login shell's argv[0] has a dash in front of it, a Windows one an extension. */
const programName = (word: string): string => base(word).replace(/^-/, "").replace(/\.exe$/i, "");
const oneLine = (text: string): string => text.replace(/\s+/g, " ").trim();
/** An argument as it reads on a line: one that holds a space is quoted, so it is still one word. A backslash in it is
 *  doubled before a quote is escaped, so `a b\` reads `"a b\\"` and not `"a b\"`, whose quote would seem escaped. */
const word = (arg: string): string => (/\s/.test(arg) ? `"${arg.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"` : arg);

/** The quoted word after the first `eval` of `script`: how Claude Code's Bash tool runs a command (`… && eval '<the
 *  command>' < /dev/null && pwd -P >| …`, a quote inside the command written `'"'"'`). Null when there is no `eval`
 *  followed by a word made of quotes, or the quote never closes: the script is then shown as it is. */
export function evalCommand(script: string): string | null {
  const m = /(?:^|[\s;&|({])eval\s+(?=['"\\])/.exec(script);
  if (!m) return null;
  let out = "";
  let i = m.index + m[0].length;
  let any = false;
  while (i < script.length && !/\s/.test(script[i])) {
    const c = script[i];
    if (c === "'" || c === '"') {
      const end = script.indexOf(c, i + 1);
      if (end < 0) return null;
      out += script.slice(i + 1, end);
      i = end + 1;
      any = true;
    } else if (c === "\\" && i + 1 < script.length) {
      out += script[i + 1];
      i += 2;
      any = true;
    } else return null;
  }
  return any && out ? out : null;
}

/** The script a shell was told to run (`-c`, `-lc`, `-ic`…), or null when it runs a file or nothing (an interactive one). */
function shellScript(args: readonly string[]): string | null {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (/^-[A-Za-z]*c[A-Za-z]*$/.test(a)) return args[i + 1] ?? "";
    // the first word that is no option names a file, and what follows is its own
    if (!a.startsWith("-") && !a.startsWith("+")) return null;
    if (a === "-o" || a === "+o") i++;
  }
  return null;
}

/** The package a script lives in (`…/node_modules/vite/bin/vite.js` is `vite`, `…/@angular/cli/…` is `@angular/cli`, and a
 *  `.bin` link is the name of the link). */
function packageOf(script: string): string | null {
  const parts = script.split(/[\\/]+/);
  const i = parts.lastIndexOf("node_modules");
  const seg = i < 0 ? undefined : parts[i + 1];
  if (!seg) return null;
  if (seg === ".bin") return parts[i + 2] ?? null;
  if (seg.startsWith("@")) return parts[i + 2] ? `${seg}/${parts[i + 2]}` : null;
  return seg;
}

/** An interpreter's command, `node /code/app/node_modules/vite/bin/vite.js --port 3000` as `vite --port 3000`: the script
 *  by its package when it has one, else the interpreter and the script's own name. Null when it runs code or a module. */
function scripted(name: string, args: readonly string[]): string | null {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (INLINE_CODE.has(a)) return null;
    if (TAKES_VALUE.has(a)) {
      i++;
      continue;
    }
    if (a.startsWith("-")) continue;
    // the first word that is no option is the script, if it is a file; `-m http.server` names a module
    if (!/[\\/]/.test(a) && !SCRIPT_FILE.test(a)) return null;
    const rest = args.slice(i + 1).map(word);
    const file = base(a);
    const runner = RUNNER.exec(file)?.[1];
    if (runner) return [runner, ...rest].join(" ");
    const pkg = packageOf(a);
    return pkg ? [pkg, ...rest].join(" ") : [name, file, ...rest].join(" ");
  }
  return null;
}

/** The command a person recognises, on one line, not yet hidden of any key: a program by its own name, a node script by
 *  its package, a shell's `-c` as the script it was given, and Claude Code's wrapper as the command inside it. */
export function commandText(argv: readonly string[]): string {
  if (argv.length === 0) return "";
  const name = programName(argv[0]);
  const args = argv.slice(1);
  if (SHELLS.has(name)) {
    const script = shellScript(args);
    if (script !== null) return oneLine(evalCommand(script) ?? script);
  }
  if (SHELLS.has(name) || INTERPRETER.test(name)) {
    const s = scripted(name, args);
    if (s !== null) return s;
  }
  return [name, ...args.map(word)].join(" ");
}

/** What a row shows of the command: any key in it is hidden as the cards hide one (`maskSecrets`), and only then is a
 *  long one cut, so a cut can never leave the front of a key too short for the masker to know. */
export function commandLabel(argv: readonly string[]): string {
  const text = maskSecrets(commandText(argv));
  const chars = [...text];
  return chars.length > COMMAND_MAX ? `${chars.slice(0, COMMAND_MAX - 1).join("")}…` : text;
}

// ---- how long, and where ----------------------------------------------------------------------------------------

/** How long a row's command has run at `now`: from the system's start time, else from when the page first saw it
 *  (`seen`, by `rowKey`); null when neither is known. A start time a little ahead of this clock is zero, not negative. */
export function ranFor(r: RunningRow, now: number, seen: ReadonlyMap<string, number>): number | null {
  const at = r.started ?? seen.get(rowKey(r));
  return at === undefined ? null : Math.max(0, now - at);
}

/** "38s" under a minute, then the app's minutes, hours and days ("42m", "1h 47m", "4d 23h"). */
export const runFor = (ms: number): string => (ms < 60_000 ? elapsed(ms) : duration(ms / 1000));

/** The ports a row names: "port 3000", "ports 3000, 3001", and for more than three the rest counted ("+2"). */
export function portsText(ports: readonly number[]): string {
  if (ports.length === 0) return "";
  const shown = ports.slice(0, 3).join(", ");
  const more = ports.length - 3;
  return t(ports.length === 1 ? "run.port" : "run.ports", { ports: more > 0 ? `${shown} +${more}` : shown });
}

// ---- which rows -------------------------------------------------------------------------------------------------

/** The rows to list at `now`: the commands that have run `MIN_AGE_MS`, the oldest first. The order does not change as
 *  they run, so a row never moves under the pointer that is about to press its Stop. */
export function listed(rows: readonly RunningRow[], now: number, seen: ReadonlyMap<string, number>): RunningRow[] {
  const at = (r: RunningRow) => r.started ?? seen.get(rowKey(r)) ?? 0;
  return rows.filter((r) => (ranFor(r, now, seen) ?? -1) >= MIN_AGE_MS).sort((a, b) => at(a) - at(b) || a.pid - b.pid);
}

/** The rows of the project at `root` (a folder, compared as the Code page groups its sessions: exactly, with `//` and a
 *  closing `/` ignored); every row when no project is given. `projectOf` says whose a row is: the folder its session started
 *  in, since a lane's commands run in the lane's own folder (none: the folder the shell names). */
export function inProject(rows: readonly RunningRow[], root: string | undefined, projectOf: (row: RunningRow) => string = (r) => r.folder): RunningRow[] {
  return root === undefined ? [...rows] : rows.filter((r) => pathKey(projectOf(r)) === pathKey(root));
}
