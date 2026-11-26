// manut's one masker for token-like text (`ghp_…`, `glpat-…`, `sk-…`, `xoxb-…`, `AKIA…`, `token=…`, and since item 113 private key
// blocks, provider-prefixed keys, JSON web tokens, credentials in HTTP headers, `password:` in YAML and JSON, the password of
// `scheme://user:pass@host`, quoted `KEY="…"` and `--password value`). The patterns live in secrets.json, which the desktop shell
// (tasks.rs mask_secrets, mask_command) reads too, so every surface masks the same strings the same way: what a phone is shown, a
// skill bundle before it is published, the keys counted in Kit's changes.
//
// Two forms (item 117). `maskSecrets` is for text that never runs. `maskCommand` is for what an approval shows: a person decides
// on it, so it never hides anything the shell would act on (secrets.json's `about` says how).
import spec from "./secrets.json";

/** A pattern of secrets.json with `{names}` and `{prefixes}` filled in, global, with its own flags. */
const compile = (pattern: string, flags = ""): RegExp => new RegExp(pattern.replaceAll("{names}", spec.names).replaceAll("{prefixes}", spec.prefixes), `g${flags}`);

/** Each `whole` pattern, and its kind: `word` (its match must stand alone as a word), `block` (a private key block, which a
 *  command masks through `BLOCKS` instead), or none. */
const WHOLE = spec.whole.map((e) => [compile(e[0] as string, e[1] as string), (e[2] as string | undefined) ?? ""] as const);
/** A command's private key blocks: [pattern with (BEGIN)(body)(END) groups, the line break that goes before the mask]. */
const BLOCKS = spec.blocks.map((e) => [compile(e[0] as string, (e[3] as string | undefined) ?? ""), e[1] as string, e[2] === "unended"] as const);
const BLOCK_BEGIN = new RegExp(spec.blockBegin);
const BLOCK_END = new RegExp(spec.blockEnd);

/** A word of a command as the shell splits it, and where it is in the command (`from` up to `to`). */
interface Word {
  text: string;
  from: number;
  to: number;
}

/** A command read as the shell reads it (item 121): its words, and for each character whether a key block there is data
 *  that is only written out, so it may be masked. */
interface Reading {
  words: Word[];
  data: boolean[];
}

/** The terminator a heredoc's word names, and whether it was quoted (then nothing in the body runs): a plain word, a word
 *  in one pair of single or double quotes, or a word after one backslash. Any other form is not read (null). */
function heredocWord(w: string): { word: string; quoted: boolean } | null {
  if (/^[A-Za-z0-9_.-]+$/.test(w)) return { word: w, quoted: false };
  const m = /^(?:'([^']*)'|"([^"\\$`]*)"|\\([A-Za-z0-9_.-]+))$/.exec(w);
  return m ? { word: m[1] ?? m[2] ?? m[3], quoted: true } : null;
}

/** A command read as the shell reads it (item 121). Words part at a blank; `;`, `&`, `|`, `(`, `)`, `<`, `>` and a line break
 *  are words of their own; a quote (`'…'`, `"…"`, `$'…'`) or a backslash keeps what it covers in its word; a `#` that starts
 *  a word starts a comment, one word to its line's end; `<<` (not a here-string's `<<<`) takes the next word as a heredoc's
 *  terminator, and after its line the body is one word up to the terminator line, which is another.
 *
 *  `data` marks what a key block may be masked in: the inside of a quoted string or a heredoc's body that belongs to the
 *  command's first simple command, when that command's first word is one that only writes its input out (secrets.json
 *  `sinks`) and nothing in the command could run what it writes (no `|`, `(` or `)` anywhere). Nothing is data from the first
 *  thing this reading cannot follow on: a substitution (`` ` ``, `$(`, `${`), arithmetic (`$[`, `((`), a heredoc word it
 *  cannot read; nor in an unquoted heredoc's body from its first `$(`, `${`, backtick or backslash, which the shell acts on. */
function lex(text: string): Reading {
  const n = text.length;
  const words: Word[] = [];
  const commands: (string | null)[] = [null];
  const regions: { from: number; to: number; command: number }[] = [];
  let until = n;
  let piped = false;
  let start = -1;
  let quote: string | null = null;
  let opened = 0;
  let plain = -1;
  let wanted: boolean | null = null;
  let heredocs: { word: string; quoted: boolean; dash: boolean; command: number }[] = [];
  const command = () => commands.length - 1;
  const stop = (at: number) => {
    until = Math.min(until, at);
  };
  const push = (from: number, to: number) => words.push({ text: text.slice(from, to), from, to });
  const end = (to: number) => {
    if (start < 0) return;
    const w = text.slice(start, to);
    push(start, to);
    if (wanted !== null) {
      const h = heredocWord(w);
      if (h) heredocs.push({ ...h, dash: wanted, command: command() });
      else stop(start);
      wanted = null;
    } else if (commands[command()] === null) commands[command()] = w;
    start = -1;
  };
  const close = (at: number) => {
    regions.push({ from: opened, to: at, command: command() });
    quote = null;
  };
  // the heredocs begun on the line that ended at `from`, in order: each body one word, its terminator line another
  const bodies = (from: number): number => {
    let at = from;
    for (const h of heredocs) {
      const body = at;
      let term = -1;
      let termEnd = n;
      while (at < n) {
        const nl = text.indexOf("\n", at);
        const lineEnd = nl < 0 ? n : nl;
        const line = text.slice(at, lineEnd);
        if ((h.dash ? line.replace(/^\t+/, "") : line) === h.word) {
          term = at;
          termEnd = lineEnd;
          break;
        }
        at = lineEnd + 1;
      }
      const bodyEnd = term < 0 ? n : term;
      push(body, bodyEnd);
      const acts = h.quoted ? -1 : text.slice(body, bodyEnd).search(/[`\\]|\$[({[]/);
      regions.push({ from: body, to: acts < 0 ? bodyEnd : body + acts, command: h.command });
      if (term < 0) return n;
      push(term, termEnd);
      at = termEnd + 1;
    }
    return Math.min(at, n);
  };
  for (let i = 0; i < n; i++) {
    const c = text[i];
    if (quote === "'") {
      if (c === "'") close(i);
      continue;
    }
    if (quote) {
      if (c === "\\") i++;
      else if (quote === "$'" ? c === "'" : c === '"') close(i);
      else if (quote === '"' && (c === "`" || (c === "$" && (text[i + 1] === "(" || text[i + 1] === "{")))) stop(i);
      continue;
    }
    if (c === "\\") {
      if (start < 0) start = i;
      i++;
      continue;
    }
    if (c === "'" || c === '"') {
      if (start < 0) start = i;
      quote = c === "'" && plain === i - 1 && text[i - 1] === "$" ? "$'" : c;
      opened = i + 1;
      continue;
    }
    if (c === "`" || (c === "$" && "({[".includes(text[i + 1] ?? "x")) || (c === "(" && text[i + 1] === "(")) stop(i);
    if (c === " " || c === "\t") {
      end(i);
    } else if (c === "#" && start < 0) {
      const nl = text.indexOf("\n", i);
      push(i, nl < 0 ? n : nl);
      i = (nl < 0 ? n : nl) - 1;
    } else if (c === "<" || c === ">") {
      end(i);
      if (wanted !== null) stop(i);
      if (c === "<" && text[i + 1] === "<" && text[i - 1] !== "<" && text[i + 2] !== "<") {
        const dash = text[i + 2] === "-";
        push(i, i + (dash ? 3 : 2));
        wanted = dash;
        i += dash ? 2 : 1;
      } else push(i, i + 1);
    } else if (";&|()\n".includes(c)) {
      end(i);
      if (wanted !== null) stop(i);
      wanted = null;
      push(i, i + 1);
      if (c === "|" || c === "(" || c === ")") piped = true;
      commands.push(null);
      if (c === "\n" && heredocs.length) {
        i = bodies(i + 1) - 1;
        heredocs = [];
      }
    } else {
      if (start < 0) start = i;
      plain = i;
    }
  }
  end(n);
  const data: boolean[] = new Array<boolean>(n).fill(false);
  const first = commands.findIndex((w) => w !== null);
  if (!piped && first >= 0 && spec.sinks.includes(commands[first]!)) {
    for (const r of regions) if (r.command === first) for (let k = r.from; k < Math.min(r.to, until); k++) data[k] = true;
  }
  return { words, data };
}

/** The words of a command as the shell splits it (`lex`). */
export function shellWords(text: string): string[] {
  return lex(text).words.map((w) => w.text);
}

/** Whether `after` is the word `before` (which starts at `from` in its command) with each mask standing for a run of one or
 *  more of its characters, every one of which `free` allows, and everything else equal. */
function aligned(before: string, from: number, after: string, free: (at: number) => boolean): boolean {
  if (before === after) return true;
  const pieces = after.split(spec.mask);
  if (pieces.length === 1 || pieces.length > 64 || !before.startsWith(pieces[0])) return false;
  const failed = new Set<number>();
  const rest = (i: number, at: number): boolean => {
    const key = i * (before.length + 1) + at;
    if (failed.has(key)) return false;
    const next = pieces[i];
    const last = i === pieces.length - 1;
    for (let end = at + 1; end <= before.length && free(from + end - 1); end++) {
      if (before.startsWith(next, end) && (last ? end + next.length === before.length : rest(i + 1, end + next.length))) return true;
    }
    failed.add(key);
    return false;
  };
  return rest(1, pieces[0].length);
}

/** Whether `after` splits into the same shell words as `before`, as many and each the same, or with masks standing for
 *  characters `free` allows in `before` (given `before`'s reading). */
function shaped(before: string, after: string, free: (reading: Reading) => (at: number) => boolean): boolean {
  const a = lex(before);
  const b = lex(after);
  const ok = free(a);
  return a.words.length === b.words.length && a.words.every((w, i) => aligned(w.text, w.from, b.words[i].text, ok));
}

/** The structural check of what an approval shows (item 121): `after` splits into exactly `before`'s shell words, each the
 *  same or with only a key's part masked, a run that holds no character the command form stops at (secrets.json `shell`). */
export function sameShape(before: string, after: string): boolean {
  return shaped(before, after, () => (k) => !stops(before, k));
}

/** Whether the block that ends its base64 lines at `from` in `text` has no END of its own: none before the next BEGIN. */
function unended(text: string, from: number): boolean {
  const rest = text.slice(from);
  const next = rest.search(BLOCK_BEGIN);
  return !BLOCK_END.test(next < 0 ? rest : rest.slice(0, next));
}
const SPLIT = spec.split.map(([p, n]) => [new RegExp(p as string, "g"), n as number] as const);
const TOKENS = compile(spec.tokens);
const WORD = compile(spec.word);
const KEPT = spec.kept.map(([p, f]) => compile(p as string, f as string));
const ASSIGNED = compile(spec.assigned, "i");
const EDGE = new RegExp(spec.edge);
const NEEDS = new RegExp(spec.needs);
const EXACT = new RegExp(spec.exact);
const WORDLIKE = new RegExp(spec.wordlike);
const NAMED = new RegExp(spec.named);
const RUN = new RegExp(spec.run, "g");
const PREFIX = new RegExp(`^${spec.prefixes}`);
const SHELL = new RegExp(spec.shell);
/** The characters that do not show, or that reorder what does (secrets.json `hidden`, item 121). */
const HIDDEN_CLASS = `[${spec.hidden.map(([a, b]) => `\\u{${a}}-\\u{${b}}`).join("")}]`;
const HIDDEN = new RegExp(HIDDEN_CLASS, "u");
const HIDDEN_ALL = new RegExp(HIDDEN_CLASS, "gu");

/** `text` with every character that does not show, or that reorders what does, replaced by a visible mark (`⟨U+202E⟩`),
 *  so a direction override or a zero-width character can neither hide nor reorder what an ask shows (item 121). Every
 *  surface that shows an ask's command or text runs it: the card, the phone, Home, Needs you, a notification. */
export function revealHidden(text: string): string {
  return text.replace(HIDDEN_ALL, (c) => spec.hiddenMark.replace("{hex}", c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")));
}

/** Whether the character at `k` of `text` (a UTF-16 index) is one a masked value in a command stops at: the command form's
 *  `shell` characters, or one that does not show. */
const stops = (text: string, k: number): boolean => SHELL.test(text.charAt(k)) || HIDDEN.test(String.fromCodePoint(text.codePointAt(k) ?? 0));
const REF = new RegExp(spec.ref);
const PLAIN = new RegExp(spec.plain, "i");

/** Whether a named value is a key at all: not a reference (`${DB_PASSWORD}`, `` `Bearer ${token}` ``) and not a word that says
 *  there is none (`Token: none`), which are ordinary text and stay as they are (item 117). */
const aKey = (value: string): boolean => !REF.test(value) && !PLAIN.test(value);

/** A replacer's last two arguments: where the match is, and the text it was found in. */
type At = [offset: number, text: string];
const at = (args: unknown[]): At => [args[args.length - 2] as number, args[args.length - 1] as string];

/** Whether `m`, found at `offset` in `text`, stands alone: no letter, digit, `_` or `-` glued to either side, so a token
 *  inside a longer name (`build-sk-…`) is the name's and stays. */
const alone = (m: string, [offset, text]: At): boolean => !EDGE.test(text.charAt(offset - 1)) && !EDGE.test(text.charAt(offset + m.length));

/** Whether a `tokens` match has a key's shape: a provider's exact shape and length, or a capital or a digit after its
 *  prefix, and for `sk-`, which CSS classes and names start with too, one of the named forms or a long run of letters and
 *  digits holding one. */
function keyShaped(m: string): boolean {
  if (EXACT.test(m)) return true;
  if (WORDLIKE.test(m)) return NAMED.test(m) || (m.match(RUN) ?? []).some((r) => NEEDS.test(r));
  return NEEDS.test(m.replace(PREFIX, ""));
}

/** How much of a value may be masked in a command: up to the first character it stops at (`stops`), 0 when it starts with
 *  one. */
const upTo = (value: string): number => {
  for (let i = 0; i < value.length; i++) if (stops(value, i)) return i;
  return value.length;
};

/** Whether `m`, found at `offset` in `text`, is part of a path: it holds a `/` or touches one. In a command such a word
 *  names a program or a file (`./whsec_…/deploy.sh`, `rm -rf ./npm_…`), so it is shown (item 121). */
const inPath = (m: string, [offset, text]: At): boolean => m.includes("/") || text.charAt(offset - 1) === "/" || text.charAt(offset + m.length) === "/";

/** `text`'s `whole` matches masked; in a command (`command`), not a key block, which `BLOCKS` masked first, nor a word that
 *  is part of a path. */
function maskWhole(text: string, command = false): string {
  for (const [rx, kind] of WHOLE) {
    if (command && kind === "block") continue;
    text = text.replace(rx, (m: string, ...args: unknown[]) => (kind === "word" && (!alone(m, at(args)) || (command && inPath(m, at(args)))) ? m : spec.mask));
  }
  return text;
}

/** A `split` match: the prefix and the body's pieces up to exactly `n` token characters become `••••` (the pieces
 *  after stay); left as it is when the pieces do not make exactly `n` at the end of one. */
function splitToken(all: string, body: string, n: number): string {
  let k = 0;
  for (let i = 0; i < body.length; i++) {
    if (/\s/.test(body[i])) continue;
    if (++k === n) return i + 1 === body.length || /\s/.test(body[i + 1]) ? spec.mask + body.slice(i + 1) : all;
  }
  return all;
}

/** `text` with every token-like string replaced by `••••`. A secret with a name keeps its name and what frames it
 *  (`token=••••`, `"password": "••••"`, `Authorization: Bearer ••••`, `postgres://admin:••••@host`); a `ghp_…` or
 *  `glpat-…` broken over lines is taken by its known length, in any letter case. For text that never runs: what an
 *  approval shows goes through `maskCommand`. */
export function maskSecrets(text: string): string {
  text = maskWhole(text);
  for (const [rx, n] of SPLIT) text = text.replace(rx, (all, body: string) => splitToken(all, body, n));
  text = text.replace(TOKENS, (m: string, ...args: unknown[]) => (alone(m, at(args)) && keyShaped(m) ? spec.mask : m));
  for (const rx of KEPT) text = text.replace(rx, (m: string, before: string, secret: string, after: string) => (aKey(secret) ? `${before}${spec.mask}${after}` : m));
  return text.replace(ASSIGNED, (m: string, name: string) => (aKey(m.slice(name.length + 1)) ? `${name}=${spec.mask}` : m));
}

/** One line of a command, masked as `maskCommand` says. A value that already holds the mask (a key block's) is left as it is. */
function commandLine(line: string): string {
  line = maskWhole(line, true);
  line = line.replace(WORD, (m: string, ...args: unknown[]) => (alone(m, at(args)) && !inPath(m, at(args)) && keyShaped(m) ? spec.mask : m));
  for (const rx of KEPT) {
    line = line.replace(rx, (m: string, before: string, secret: string, after: string) => {
      const n = aKey(secret) && !secret.includes(spec.mask) ? upTo(secret) : 0;
      return n ? `${before}${spec.mask}${secret.slice(n)}${after}` : m;
    });
  }
  return line.replace(ASSIGNED, (m: string, name: string) => {
    const value = m.slice(name.length + 1);
    const n = aKey(value) && !value.includes(spec.mask) ? upTo(value) : 0;
    return n ? `${name}=${spec.mask}${value.slice(n)}` : m;
  });
}

/** `text`'s private key blocks whose body holds only key lines (base64, or a PEM header such as `Proc-Type: 4,ENCRYPTED`),
 *  where the whole block is data a writer only writes out (`lex`): its BEGIN and END lines stay, its body is one mask line. */
function maskBlocks(text: string): string {
  if (!text.includes("PRIVATE KEY")) return text;
  for (const [rx, sep, open] of BLOCKS) {
    const { data } = lex(text);
    text = text.replace(rx, (m: string, begin: string, _body: string, end: string, offset: number, whole: string) => {
      const inData = data.slice(offset, offset + m.length).every(Boolean);
      return (open && !unended(whole, offset + m.length)) || !inData ? m : `${begin}${sep}${spec.mask}${end}`;
    });
  }
  return text;
}

/** What an approval shows of a command (item 121). */
export interface ShownCommand {
  /** The command with its keys masked; or the command as it is, when masking it could change what it seems to do. */
  text: string;
  /** The masked line would not split into the command's own shell words, or the command already holds the mask's
   *  character, so a mask could not be told from it: it is shown as it is, and the person is told it may hold a key. */
  unmasked: boolean;
  /** It holds characters that do not show or that reorder what does, each replaced in `text` by a visible mark
   *  (`revealHidden`): the person is told it holds hidden characters. */
  hidden: boolean;
}

/** A command, or anything else an approval shows, with its keys masked and nothing else: a private key block whose body holds
 *  only key lines keeps its BEGIN and END lines and shows its body as one mask line, only where it is data a writer only
 *  writes out; then read line by line, so no other masked value spans a line; never joined across a blank, so a command's
 *  next word stays; and a masked value stops at the first blank, quote, `#`, glob character or character the shell acts on,
 *  which is shown with what follows it (item 117, item 121). Then the structural check: the masked command must split into
 *  exactly the command's shell words, each the same or with only a key's part masked, or the command is shown as it is
 *  (`unmasked`). What a person approves is then what runs, less the keys in it (the table's `command` rows, which the shell's
 *  twin runs too). */
export function showCommand(command: string): ShownCommand {
  const blocks = maskBlocks(command);
  const masked = blocks.split("\n").map(commandLine).join("\n");
  const sure =
    masked === command ||
    (!command.includes(spec.mask.charAt(0)) && shaped(command, blocks, (r) => (k) => r.data[k]) && sameShape(blocks, masked));
  const plain = sure ? masked : command;
  const text = revealHidden(plain);
  return { text, unmasked: !sure, hidden: text !== plain };
}

/** `showCommand`'s text: what an approval shows of a command. */
export function maskCommand(text: string): string {
  return showCommand(text).text;
}
