// The four dictionaries pinned key by key and word by word (item 128). The snapshot in `snapshot/` was written from the
// one-file dictionaries before they were split into a file per area, so it proves the split moved every key and
// changed none. A later change of words writes it again on purpose:
// `UPDATE_I18N_SNAPSHOT=1 pnpm --filter @manut/desktop exec vitest run src/i18n/snapshot.test.ts`.
// Keys are sorted, one to a line, so two items that change different keys change different lines.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DICT, LANGS } from "./index";

const DIR = join(__dirname, "snapshot");

const sorted = (d: Record<string, string>): Record<string, string> =>
  Object.fromEntries(Object.keys(d).sort().map((k) => [k, d[k]]));

describe("the dictionaries' snapshot", () => {
  for (const l of LANGS) {
    it(`${l} holds exactly the pinned keys and words`, () => {
      const file = join(DIR, `${l}.json`);
      const now = sorted(DICT[l]);
      if (process.env.UPDATE_I18N_SNAPSHOT === "1") writeFileSync(file, `${JSON.stringify(now, null, 2)}\n`);
      const pinned = JSON.parse(readFileSync(file, "utf8")) as Record<string, string>;
      const why = `${l}: the words differ from src/i18n/snapshot/${l}.json. If you changed them on purpose, write it again with UPDATE_I18N_SNAPSHOT=1 (src/i18n/README.md)`;
      expect(Object.keys(now), why).toEqual(Object.keys(pinned));
      expect(now, why).toEqual(pinned);
    });
  }
});
