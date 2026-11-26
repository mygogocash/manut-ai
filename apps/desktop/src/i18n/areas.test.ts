// The dictionaries' layout (item 128, README.md): each language is a folder of area files, one per key prefix, and
// `<lang>.ts` puts them together. A key in the wrong area's file, or an area file its language's `<lang>.ts` forgot to
// take in, would pass the type check (a spread does not mind) and fail here.
import { describe, expect, it } from "vitest";
import { DICT, LANGS, type Key, type Lang } from "./index";

const files = import.meta.glob<Record<string, Record<string, string>>>("./*/*.ts", { eager: true });

/** Each language's areas: the file's name, and the one object it exports. */
const areas = (l: Lang): [string, Record<string, string>][] =>
  Object.entries(files)
    .filter(([path]) => path.startsWith(`./${l}/`))
    .map(([path, mod]) => {
      const objects = Object.values(mod);
      expect(objects, path).toHaveLength(1);
      return [path.slice(l.length + 3, -3), objects[0]];
    });

describe("the dictionaries' area files", () => {
  it("holds each key in the file named after its prefix", () => {
    for (const l of LANGS) {
      for (const [area, words] of areas(l)) {
        for (const key of Object.keys(words)) expect(key.split(".")[0], `${l}/${area}.ts ${key}`).toBe(area);
      }
    }
  });

  it("takes every area file of a language into that language's dictionary, and nothing else", () => {
    for (const l of LANGS) {
      const fromFiles = areas(l).flatMap(([, words]) => Object.keys(words));
      expect(fromFiles.length, l).toBe(Object.keys(DICT[l]).length);
      expect([...fromFiles].sort(), l).toEqual(Object.keys(DICT[l]).sort());
      for (const [area, words] of areas(l)) for (const [k, v] of Object.entries(words)) expect(DICT[l][k as Key], `${l}/${area}.ts ${k}`).toBe(v);
    }
  });

  it("has the same areas in every language", () => {
    const names = (l: Lang) => areas(l).map(([area]) => area).sort();
    for (const l of LANGS) expect(names(l), l).toEqual(names("en"));
  });
});
