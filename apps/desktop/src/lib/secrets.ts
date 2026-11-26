// manut's one masker for token-like text (`ghp_…`, `glpat-…`, `sk-…`, `xoxb-…`, `AKIA…`, `token=…`, and since item 113 private key
// blocks, provider-prefixed keys, JSON web tokens, credentials in HTTP headers, `password:` in YAML and JSON, the password of
// `scheme://user:pass@host`, quoted `KEY="…"` and `--password value`). The patterns live in secrets.json, which the desktop shell
// (tasks.rs mask_secrets) reads too, so every surface masks the same strings the same way: what a phone is shown, a skill bundle
// before it is published, the keys counted in Kit's changes.
import spec from "./secrets.json";

/** A pattern of secrets.json with `{names}` filled in, global, with its own flags. */
const compile = (pattern: string, flags = ""): RegExp => new RegExp(pattern.replaceAll("{names}", spec.names), `g${flags}`);

const WHOLE = spec.whole.map(([p, f]) => compile(p as string, f as string));
const SPLIT = spec.split.map(([p, n]) => [new RegExp(p as string, "g"), n as number] as const);
const TOKENS = new RegExp(spec.tokens, "g");
const KEPT = spec.kept.map(([p, f]) => compile(p as string, f as string));
const ASSIGNED = compile(spec.assigned, "i");

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
 *  `glpat-…` broken over lines is taken by its known length, in any letter case. */
export function maskSecrets(text: string): string {
  for (const rx of WHOLE) text = text.replace(rx, () => spec.mask);
  for (const [rx, n] of SPLIT) text = text.replace(rx, (all, body: string) => splitToken(all, body, n));
  text = text.replace(TOKENS, () => spec.mask);
  for (const rx of KEPT) text = text.replace(rx, (_m, before: string, _secret: string, after: string) => `${before}${spec.mask}${after}`);
  return text.replace(ASSIGNED, (_m, name: string) => `${name}=${spec.mask}`);
}
