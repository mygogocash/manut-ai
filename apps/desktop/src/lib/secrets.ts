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

/** A heredoc still to come or being read: its terminator word, and whether tabs before it are allowed (`<<-`). */
interface Heredoc {
  word: string;
  dash: boolean;
}

/** How the shell reads `text` up to the start of its line `line` (an offset): the quote still open there, the heredoc whose
 *  body that line is in, or null when the reading cannot be followed (a `$(`, a backtick, `${`, a heredoc word it cannot read,
 *  a heredoc begun inside a quote). */
function readTo(text: string, line: number): { quote: string | null; heredoc: Heredoc | null } | null {
  let quote: string | null = null;
  let queue: Heredoc[] = [];
  let body: Heredoc | null = null;
  let at = 0;
  while (at < line) {
    const nl = text.indexOf("\n", at);
    const end = nl < 0 ? text.length : nl;
    const l = text.slice(at, end).replace(/\r$/, "");
    if (body) {
      if ((body.dash ? l.replace(/^\t+/, "") : l) === body.word) body = queue.shift() ?? null;
    } else {
      const got = scanLine(l, quote);
      if (!got) return null;
      quote = got.quote;
      if (got.heredocs.length) {
        if (quote) return null;
        queue = [...queue, ...got.heredocs];
        body = queue.shift() ?? null;
      }
    }
    at = end + 1;
  }
  return { quote, heredoc: body };
}

/** One line read as the shell reads it, from quote state `quote`: the quote open at its end and the heredocs it begins, or
 *  null when it holds what this reading cannot follow. `stop` ends the reading early (at a key block's BEGIN marker). */
function scanLine(l: string, quote: string | null, stop = l.length): { quote: string | null; heredocs: Heredoc[] } | null {
  const heredocs: Heredoc[] = [];
  for (let i = 0; i < stop; i++) {
    const c = l[i];
    if (quote === "'") {
      if (c === "'") quote = null;
      continue;
    }
    if (c === "`" || (c === "$" && (l[i + 1] === "(" || l[i + 1] === "{"))) return null;
    if (c === "\\") {
      i++;
      continue;
    }
    if (quote === '"') {
      if (c === '"') quote = null;
      continue;
    }
    if (c === "'" || c === '"') quote = c;
    else if (c === "#" && (i === 0 || /\s/.test(l[i - 1]))) break;
    else if (c === "<" && l[i + 1] === "<" && l[i + 2] !== "<") {
      const m = /^<<(-?)[ \t]*(?:'([^']+)'|"([^"]+)"|\\?([A-Za-z0-9_]+))/.exec(l.slice(i));
      if (!m) return null;
      heredocs.push({ word: m[2] ?? m[3] ?? m[4], dash: m[1] === "-" });
      i += m[0].length - 1;
    }
  }
  return { quote, heredocs };
}

/** Whether the shell reads the key block from `from` to `to` in `text` as data, never as commands (item 117): inside a quoted
 *  string opened on its BEGIN line before the marker that is still open at its end and closes after it, or inside a heredoc's
 *  body whose terminator line does not come before its end. Anything else, and anything unsure, is no. */
function shellData(text: string, from: number, to: number): boolean {
  const line = text.lastIndexOf("\n", from - 1) + 1;
  const before = readTo(text, line);
  if (!before) return false;
  if (before.heredoc) {
    const { word, dash } = before.heredoc;
    const last = text.indexOf("\n", to);
    const lines = text.slice(line, last < 0 ? text.length : last).split("\n");
    return !lines.some((l) => (dash ? l.replace(/\r$/, "").replace(/^\t+/, "") : l.replace(/\r$/, "")) === word);
  }
  if (before.quote) return false;
  const end = text.indexOf("\n", line);
  const own = text.slice(line, end < 0 ? text.length : end);
  const at = scanLine(own, null, from - line);
  if (!at?.quote || at.heredocs.length) return false;
  // the same string closes after the block: the next quote of its kind, nothing it cannot read before it
  const q = at.quote;
  for (let i = to; i < text.length; i++) {
    const c = text[i];
    if (q === "'") {
      if (c === "'") return true;
      continue;
    }
    if (c === "`" || c === "$") return false;
    if (c === "\\") i++;
    else if (c === '"') return true;
  }
  return false;
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

/** How much of a value may be masked in a command: up to the first character the shell acts on (0 when it starts with one). */
const upTo = (value: string): number => {
  const i = value.search(SHELL);
  return i < 0 ? value.length : i;
};

/** `text`'s `whole` matches masked; in a command (`command`), not a key block, which `BLOCKS` masked first. */
function maskWhole(text: string, command = false): string {
  for (const [rx, kind] of WHOLE) {
    if (command && kind === "block") continue;
    text = text.replace(rx, (m: string, ...args: unknown[]) => (kind === "word" && !alone(m, at(args)) ? m : spec.mask));
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
  line = line.replace(WORD, (m: string, ...args: unknown[]) => (alone(m, at(args)) && keyShaped(m) ? spec.mask : m));
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

/** A command, or anything else an approval shows, with its keys masked and nothing else: a private key block whose body holds
 *  only key characters keeps its BEGIN and END lines and shows its body as one mask line, and one whose body holds anything
 *  else is shown whole; then read line by line, so no other masked value spans a line; never joined across a blank, so a
 *  command's next word stays; and a masked value stops at the first character the shell acts on, which is shown with what
 *  follows it. What a person approves is then what runs, less the
 *  keys in it (item 117; the table's `command` rows, which the shell's twin runs too). */
export function maskCommand(text: string): string {
  // a private key block whose body holds nothing the shell acts on, where the shell reads it as data (`shellData`): its BEGIN
  // and END lines stay, its body is one mask line
  for (const [rx, sep, open] of BLOCKS) {
    text = text.replace(rx, (m: string, begin: string, _body: string, end: string, offset: number, whole: string) =>
      (open && !unended(whole, offset + m.length)) || !shellData(whole, offset, offset + m.length) ? m : `${begin}${sep}${spec.mask}${end}`,
    );
  }
  return text.split("\n").map(commandLine).join("\n");
}
