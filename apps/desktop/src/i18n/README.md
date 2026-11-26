# The dictionaries

Every word a person reads goes through `t()` (`index.ts`) with a key that is in all four dictionaries: English (`en`,
the source), Korean (`ko`), Japanese (`ja`) and Simplified Chinese (`zh`). No Thai yet.

## Where a key lives

Each language is a folder of area files, one per key prefix: `lane.title` is in `en/lane.ts`, `ja/lane.ts`, `ko/lane.ts`
and `zh/lane.ts`. `en.ts`, `ja.ts`, `ko.ts` and `zh.ts` only put their folder's areas together, so `en` is still one
object, `Key` is still every key, and nothing that imports `t`, `Key` or `DICT` changed.

Until item 128 (26 Nov 2026) each language was one object, and every feature added its keys at its end, so two items
built side by side conflicted there in all four files. Now an item adds to its own area's files.

The dev server (`vite`, which the browser specs and `tauri dev` use) still sends each language as one module:
`oneModule.ts` writes each area's object into `<lang>.ts` as it serves it, because 608 area modules fetched by every
fresh page made the browser specs about a fifth slower (item 129). It does so only for an area file of type-only
imports and one `export const <prefix> = { "<key>": "<words>" }`; any other shape is served as separate files with a
warning in the dev server's log, and `oneModule.test.ts` fails.

## Adding words

1. A key's prefix is its area. Add the key to that area's file in all four languages, at the end of the object or under
   the comment of the feature it belongs to.
2. A new feature takes a prefix of its own, so a new area file in each language. Copy an existing one's shape:
   - `en/<prefix>.ts`: `export const <prefix> = { "<prefix>.title": "...", };`
   - `ja/<prefix>.ts` (and `ko`, `zh`): `import type { <prefix> as en } from "../en/<prefix>";` and
     `export const <prefix>: Record<keyof typeof en, string> = { ... };`

   Then add `import { <prefix> } from "./<lang>/<prefix>";` and `...<prefix>,` to each `<lang>.ts`, both in name order.
   A prefix is a plain name: letters and digits, starting with a letter.
3. Or let a script do both steps: `.claude/skills/lead-merge/scripts/place-keys.py src/i18n <lang>` reads key lines
   (`  "lane.title": "Lanes",`, and comments) on its standard input and puts each in its area, making the file and its
   two lines in `<lang>.ts` when the area is new.

The type check holds each language's area to English's: a key that `ja/lane.ts` lacks, or one too many, fails in that
file.

## The tests

- `i18n.test.ts`: every language carries every key with the same `{slots}`, and the words that stay in English do.
- `literals.test.ts`: no English typed into a component.
- `areas.test.ts`: each key is in the file named after its prefix, every area file is taken into its language, and the
  four languages have the same areas.
- `e2e/i18n-zh.spec.ts`: every Settings page reads fully in Chinese.

## Merging

Two items that add to the same area still meet at the end of its object; `keep-both.py` (the `lead-merge` skill) keeps
both. A branch made before the split adds its keys to the old one-file dictionaries: the lead carries them into the area
files with `place-keys.py`, as `lead-merge` says.
