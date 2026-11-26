// The dev server's dictionaries, one module a language (item 129). Since item 128 each language is a folder of area
// files, one per key prefix, which `<lang>.ts` puts together, so the dev server, which serves every source file as a
// module of its own, sent each new page 608 dictionary modules besides the app's 605 (1,218 requests in all, against
// 610 before the split). Every Playwright test opens its page in a fresh browser context, so it fetched all of them
// again: on 26 Nov 2026 the same browser specs ran about a fifth slower on CI right after the split was merged, and a
// fresh page here took about 100ms longer to its first paint.
//
// So `vite` (dev only: a production build bundles the areas anyway, and the unit tests keep reading the files as they
// are) serves `<lang>.ts` with each area's object written in place of its import. The source keeps one file per
// prefix, the type check and areas.test.ts still read the files, and the page gets the same object, from four modules
// instead of 612. A change to an area file still reaches the open page, because each area is registered as a file the
// module depends on.
//
// Only the plain shape README.md describes is put together: an area file of type-only imports and one
// `export const <prefix> = { "<key>": "<words>", ... }` of string words. Anything else is served as it is, one module a
// file as before, with a warning in the dev server's log, so a new kind of area file can never change what a page
// shows; oneModule.test.ts holds every language's areas to that shape.
import { readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { normalizePath, parseAst, type Plugin } from "vite";

/** A language file with its areas written in, and the area files it now stands for. */
export type Combined = { code: string; areas: string[] };
/** Why a language file was left as it is. */
export type Problem = { problem: string };

type Read = (path: string) => string;
type Program = ReturnType<typeof parseAst>;
type Statement = Program["body"][number];

/** The source text of `area`'s one object, when the file is the plain shape: type-only imports and one exported const
 *  named `name` whose value is an object of string words. */
function areaObject(area: string, name: string, read: Read): string | Problem {
  let source: string;
  try {
    source = read(area);
  } catch {
    return { problem: `${area} could not be read` };
  }
  let object: string | undefined;
  for (const node of parseAst(source, { lang: "ts" }, area).body as Statement[]) {
    if (node.type === "ImportDeclaration" && node.importKind === "type") continue;
    const declaration = node.type === "ExportNamedDeclaration" ? node.declaration : null;
    const only = declaration?.type === "VariableDeclaration" && declaration.kind === "const" && declaration.declarations.length === 1 ? declaration.declarations[0] : null;
    const init = only?.init;
    if (object === undefined && only?.id.type === "Identifier" && only.id.name === name && init?.type === "ObjectExpression") {
      // Every entry a plain `"key": "words"`: no spread, no computed key, no value that names anything, so the text is
      // the same object wherever it is written.
      const plain = init.properties.every(
        (p) => p.type === "Property" && p.kind === "init" && !p.computed && !p.method && p.key.type === "Literal" && p.value.type === "Literal" && typeof p.value.value === "string",
      );
      if (!plain) return { problem: `${area}: ${name} holds something other than "key": "words" entries` };
      object = source.slice(init.start, init.end);
      continue;
    }
    return { problem: `${area}: only type imports and one \`export const ${name} = { ... }\` can be put together` };
  }
  return object ?? { problem: `${area}: no \`export const ${name} = { ... }\`` };
}

/** The language file `file` with each import of one of its own areas (`import { lane } from "./en/lane"` in `en.ts`)
 *  replaced by that area's object. Null when the file imports no area of its own (index.ts, a test); a problem when an
 *  area is not the plain shape, and the file is then served as it is. */
export function combine(file: string, read: Read): Combined | Problem | null {
  const lang = basename(file, ".ts");
  const source = read(file);
  const edits: { start: number; end: number; text: string }[] = [];
  const areas: string[] = [];
  for (const node of parseAst(source, { lang: "ts" }, file).body as Statement[]) {
    if (node.type !== "ImportDeclaration" || node.importKind === "type") continue;
    const from = node.source.value;
    if (!from.startsWith(`./${lang}/`)) continue;
    const [only, ...more] = node.specifiers;
    if (!only || more.length > 0 || only.type !== "ImportSpecifier" || only.importKind === "type" || only.imported.type !== "Identifier") {
      return { problem: `${file}: the import from ${from} is not one named import` };
    }
    const area = resolve(dirname(file), `${from}.ts`);
    const object = areaObject(area, only.imported.name, read);
    if (typeof object !== "string") return object;
    edits.push({ start: node.start, end: node.end, text: `const ${only.local.name} = ${object};` });
    areas.push(area);
  }
  if (areas.length === 0) return null;
  let code = source;
  for (const edit of edits.reverse()) code = code.slice(0, edit.start) + edit.text + code.slice(edit.end);
  return { code, areas };
}

/** The dev server's plugin: serves each `src/i18n/<lang>.ts` as one module (see the top of this file). */
export function dictionariesAsOneModule(): Plugin {
  let dir = "";
  return {
    name: "manut:dictionaries-as-one-module",
    apply: "serve",
    configResolved(config) {
      dir = normalizePath(join(config.root, "src", "i18n"));
    },
    load(id) {
      const file = id.split("?", 1)[0];
      if (dirname(file) !== dir || !file.endsWith(".ts")) return null;
      const combined = combine(file, (path) => readFileSync(path, "utf8"));
      if (combined === null) return null;
      if ("problem" in combined) {
        this.warn(`served as separate modules, as before item 129: ${combined.problem}`);
        return null;
      }
      for (const area of combined.areas) this.addWatchFile(area);
      return { code: combined.code, map: null };
    },
  };
}
