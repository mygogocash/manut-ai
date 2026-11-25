// A preview with sample values until the owner adds a real one (the canvas's StatesCodeDev board, "No secret in the
// preview"): "The preview has no shop ID yet, so the QR code is a sample", with "Add the shop ID".
//
// Two things live here. The first is what makes a project need a secret to show something: a line Kit changes reads one
// from the environment by a name that says what it is (`process.env.PROMPTPAY_SHOP_ID`). Only the name is read, never a
// value, and only code Kit changed (its `tool.diff` events, as secrets.ts reads them). The second is the one rule for
// what a preview runs with, `previewEnv`: a sample for every secret, unless the owner added that very secret. Nothing
// else can put a real one in, not this computer's environment and not a value found in the code, so a test payment
// cannot reach the owner's account by accident.
//
// The app has no preview of its own yet, and no vault to add a secret to (the owner has not said where a developer's
// secrets live). `previewEnv` is what a preview must be started with when one exists; until then the Code page says
// what the project needs and that the vault comes later (`PreviewSample.tsx`).
import { useSyncExternalStore } from "react";
import type { DiffFile } from "../lib/protocol";
import { pathKey } from "../sessions/folders";

/** What a secret is, for the words about it: the canvas's shop ID (the QR code), or any other key, token or secret. */
export type NeedKind = "shop_id" | "key";

/** A secret the project reads: the name it reads it by (an environment variable) and what it is. */
export interface Need {
  name: string;
  kind: NeedKind;
}

/** What a preview runs one secret with: the owner's value, or the sample (`sample`). */
export interface Slot extends Need {
  value: string;
  sample: boolean;
}

/** The sample for each kind, plainly not real: a shop ID of zeros names no account, so no payment can reach one. */
export const SAMPLES: Readonly<Record<NeedKind, string>> = { shop_id: "0000000000", key: "sample-value" };

const KEY = /(^|_)(API_?KEY|KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIALS?)($|_)/;
const SHOP_ID = /PROMPTPAY|(^|_)SHOP_?ID($|_)|(^|_)MERCHANT_?ID($|_)/;

/** What a variable of this name is, or null when its name does not say it is a secret (`NODE_ENV`, `PORT`, a name that
 *  only contains the letters of one: `MONKEY`, `TOKENIZER`). A key wins over a shop ID: `PROMPTPAY_SECRET` is a key. */
export function kindOf(name: string): NeedKind | null {
  if (KEY.test(name)) return "key";
  return SHOP_ID.test(name) ? "shop_id" : null;
}

const NAME = "[A-Z][A-Z0-9_]{1,63}";
/** The ways code reads an environment variable by name: `process.env.X`, `import.meta.env.X`, a Worker's `env.X`;
 *  `process.env["X"]`, `os.environ["X"]`, `ENV["X"]`; `os.getenv("X")`, `os.environ.get("X")`, `os.Getenv("X")`,
 *  `Deno.env.get("X")`. Only a name written out is seen: a name built from pieces is not. */
const READS = [
  new RegExp(`\\b(?:process\\.env|import\\.meta\\.env|env)\\.(${NAME})\\b`, "g"),
  new RegExp(`\\b(?:process\\.env|import\\.meta\\.env|os\\.environ|ENV)\\[\\s*["'](${NAME})["']\\s*\\]`, "g"),
  new RegExp(`\\b(?:os\\.getenv|os\\.environ\\.get|os\\.Getenv|Deno\\.env\\.get|getenv)\\(\\s*["'](${NAME})["']`, "g"),
];

/** The environment variables one line of code reads, by name. */
const readsOf = (line: string): string[] => READS.flatMap((rx) => [...line.matchAll(rx)].map((m) => m[1]));

/** How many lines read each secret, per file: only names and counts are kept, never a value. */
export type Reads = Record<string, Record<string, number>>;

/** The reads after `files` are applied on top of `before`: a line added that reads a secret counts one, a line taken
 *  out takes one away, and a deleted file reads none. Only names that are still read are kept. */
export function readsAfter(before: Readonly<Reads>, files: readonly DiffFile[]): Reads {
  const after: Reads = { ...before };
  for (const f of files) {
    if (f.kind === "delete") {
      delete after[f.path];
      continue;
    }
    const counts: Record<string, number> = { ...after[f.path] };
    for (const l of f.lines) {
      const step = l[0] === "+" ? 1 : l[0] === "-" ? -1 : 0;
      if (step === 0) continue;
      for (const name of readsOf(l.slice(1))) if (kindOf(name)) counts[name] = (counts[name] ?? 0) + step;
    }
    for (const [name, n] of Object.entries(counts)) if (n <= 0) delete counts[name];
    if (Object.keys(counts).length) after[f.path] = counts;
    else delete after[f.path];
  }
  return after;
}

/** The secrets still read in any file, once each, in name order. */
export function needsOf(reads: Readonly<Reads>): Need[] {
  const names = new Set(Object.values(reads).flatMap((c) => Object.keys(c)));
  return [...names]
    .sort()
    .flatMap((name) => {
      const kind = kindOf(name);
      return kind ? [{ name, kind }] : [];
    });
}

const has = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);

/** What a preview runs with, secret by secret: the value the owner added for that secret, and otherwise its sample. An
 *  empty value is not one. `added` is the only way in for a real one: this reads no environment and no file. */
export function previewEnv(needs: readonly Need[], added: Readonly<Record<string, string>> = {}): Slot[] {
  return needs.map((n) => {
    const own = has(added, n.name) ? added[n.name] : "";
    const real = typeof own === "string" && own.trim() !== "";
    return { ...n, value: real ? own : SAMPLES[n.kind], sample: !real };
  });
}

/** The secrets a preview would still run on a sample. */
export const onSample = (needs: readonly Need[], added: Readonly<Record<string, string>> = {}): Need[] =>
  previewEnv(needs, added)
    .filter((s) => s.sample)
    .map(({ name, kind }) => ({ name, kind }));

// ---- what each session's changes read -----------------------------------------------------------------------------

const reads = new Map<string, Reads>();
const listeners = new Set<() => void>();
let version = 0;

/** A session's change arrived (`tool.diff`): what its files read is counted again. */
export function noteReads(chat: string, files: readonly DiffFile[]): void {
  const before = reads.get(chat) ?? {};
  const after = readsAfter(before, files);
  if (JSON.stringify(after) === JSON.stringify(before)) return;
  reads.set(chat, after);
  version++;
  listeners.forEach((l) => l());
}

/** Every session whose changes read a secret: its chat key and what it reads. */
export const sessionsWithNeeds = (): { chat: string; needs: Need[] }[] =>
  [...reads.entries()].map(([chat, r]) => ({ chat, needs: needsOf(r) })).filter((x) => x.needs.length);

/** The secrets the changes of the one session whose chat key is `chat` read, once each, in name order. */
export const needsOfChat = (chat: string): Need[] => needsOf(reads.get(chat) ?? {});

/** The secrets the changes of project `root`'s sessions read, once each, in name order. A session is the project's when
 *  it started in that folder; its chat key is `agent:<id>`. */
export function needsOfProject(root: string, found: readonly { chat: string; needs: readonly Need[] }[], list: readonly { id: string; cwd: string }[]): Need[] {
  const here = pathKey(root);
  const byName = new Map<string, Need>();
  for (const f of found) {
    const id = f.chat.startsWith("agent:") ? f.chat.slice("agent:".length) : "";
    if (pathKey(list.find((r) => r.id === id)?.cwd ?? "") !== here) continue;
    for (const n of f.needs) byName.set(n.name, n);
  }
  return [...byName.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

/** Re-renders when a session's reads change. */
export function usePreviewVersion(): number {
  return useSyncExternalStore(subscribe, () => version, () => version);
}

/** Forgets what was counted (tests). */
export function resetPreview(): void {
  reads.clear();
  version++;
}
