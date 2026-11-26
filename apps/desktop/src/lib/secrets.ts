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

/** Each `whole` pattern, and whether its match must stand alone as a word. */
const WHOLE = spec.whole.map((e) => [compile(e[0] as string, e[1] as string), e[2] === "word"] as const);
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

/** `text`'s `whole` matches masked. */
function maskWhole(text: string): string {
  for (const [rx, word] of WHOLE) text = text.replace(rx, (m: string, ...args: unknown[]) => (word && !alone(m, at(args)) ? m : spec.mask));
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
  for (const rx of KEPT) text = text.replace(rx, (_m, before: string, _secret: string, after: string) => `${before}${spec.mask}${after}`);
  return text.replace(ASSIGNED, (_m, name: string) => `${name}=${spec.mask}`);
}

/** One line of a command, masked as `maskCommand` says. */
function commandLine(line: string): string {
  line = maskWhole(line);
  line = line.replace(WORD, (m: string, ...args: unknown[]) => (alone(m, at(args)) && keyShaped(m) ? spec.mask : m));
  for (const rx of KEPT) {
    line = line.replace(rx, (m: string, before: string, secret: string, after: string) => {
      const n = upTo(secret);
      return n ? `${before}${spec.mask}${secret.slice(n)}${after}` : m;
    });
  }
  return line.replace(ASSIGNED, (m: string, name: string) => {
    const value = m.slice(name.length + 1);
    const n = upTo(value);
    return n ? `${name}=${spec.mask}${value.slice(n)}` : m;
  });
}

/** A command, or anything else an approval shows, with its keys masked and nothing else: read line by line, so no masked
 *  value spans a line; never joined across a blank, so a command's next word stays; and a masked value stops at the first
 *  character the shell acts on, which is shown with what follows it. What a person approves is then what runs, less the
 *  keys in it (item 117; the table's `command` rows, which the shell's twin runs too). */
export function maskCommand(text: string): string {
  return text.split("\n").map(commandLine).join("\n");
}
