// The dev server's one module a language (oneModule.ts, item 129): every language's areas are the plain shape that can be
// put together, the module a real Vite dev server then serves is the same dictionary the area files make, it imports no
// area, and a change to an area still reaches it. A shape it cannot put together is served as before.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createServer, type ViteDevServer } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DICT, LANGS } from "./index";
import { combine, dictionariesAsOneModule, type Combined } from "./oneModule";

const DIR = __dirname;
const ROOT = join(DIR, "..", "..");
const read = (path: string) => readFileSync(path, "utf8");

describe("putting a language together", () => {
  it("takes in every area file of every language, and leaves no import of one", () => {
    for (const lang of LANGS) {
      const combined = combine(join(DIR, `${lang}.ts`), read);
      expect(combined && "problem" in combined ? combined.problem : null, lang).toBeNull();
      const { code, areas } = combined as Combined;
      const files = readdirSync(join(DIR, lang)).filter((f) => f.endsWith(".ts"));
      expect(areas.map((a) => a.slice(join(DIR, lang).length + 1)).sort(), lang).toEqual(files.sort());
      expect(code, lang).not.toMatch(new RegExp(`from "\\./${lang}/`));
    }
  });

  it("leaves a file that imports none of its own areas alone", () => {
    expect(combine(join(DIR, "index.ts"), read)).toBeNull();
  });

  // In-memory files: what a language file and its areas could look like, and what may not be put together.
  const files = (area: string) => {
    const all: Record<string, string> = {
      "/i18n/xx.ts": `import type { Key } from "./index";\nimport { lane } from "./xx/lane";\nexport const xx: Record<Key, string> = { ...lane };\n`,
      "/i18n/xx/lane.ts": area,
    };
    return (path: string) => {
      if (!(path in all)) throw new Error(`no ${path}`);
      return all[path];
    };
  };
  const tryArea = (area: string) => combine("/i18n/xx.ts", files(area));

  it("writes a plain area in place of its import, comments and all", () => {
    const combined = tryArea(`import type { lane as en } from "../en/lane";\n\nexport const lane: Record<keyof typeof en, string> = {\n  // why\n  "lane.title": "Lanes",\n};\n`);
    expect(combined).toEqual({
      code: `import type { Key } from "./index";\nconst lane = {\n  // why\n  "lane.title": "Lanes",\n};\nexport const xx: Record<Key, string> = { ...lane };\n`,
      areas: ["/i18n/xx/lane.ts"],
    });
  });

  it.each([
    ["a spread", `const more = { "lane.b": "B" };\nexport const lane = { ...more, "lane.a": "A" };\n`],
    ["a value that names something", `const b = "B";\nexport const lane = { "lane.b": b };\n`],
    ["a computed key", `export const lane = { ["lane.a"]: "A" };\n`],
    ["a value that is not words", `export const lane = { "lane.a": 1 };\n`],
    ["a second export", `export const lane = { "lane.a": "A" };\nexport const other = 1;\n`],
    ["a value import", `import { x } from "./x";\nexport const lane = { "lane.a": "A" };\n`],
    ["another name", `export const lanes = { "lane.a": "A" };\n`],
    ["no object", `export const lane = make();\n`],
  ])("serves the files as before when an area holds %s", (_why, area) => {
    expect(tryArea(area)).toHaveProperty("problem");
  });

  it("serves the files as before when an area file is missing", () => {
    expect(combine("/i18n/xx.ts", (path) => (path === "/i18n/xx.ts" ? `import { lane } from "./xx/lane";\nexport const xx = { ...lane };\n` : read("/nowhere")))).toHaveProperty("problem");
  });
});

describe("the dev server", () => {
  let server: ViteDevServer;
  beforeAll(async () => {
    server = await createServer({
      root: ROOT,
      configFile: false,
      logLevel: "silent",
      appType: "custom",
      plugins: [dictionariesAsOneModule()],
      server: { middlewareMode: true, hmr: false, watch: null },
      optimizeDeps: { noDiscovery: true, include: [] },
    });
  }, 30_000);
  afterAll(async () => {
    await server?.close();
  });

  it.each(LANGS)("serves %s as one module that holds the same dictionary, key for key", async (lang) => {
    const mod = (await server.ssrLoadModule(`/src/i18n/${lang}.ts`)) as Record<string, Record<string, string>>;
    expect(Object.keys(mod[lang])).toEqual(Object.keys(DICT[lang]));
    expect(mod[lang]).toEqual(DICT[lang]);
  });

  it.each(LANGS)("sends the page %s with no area to fetch, and knows its areas for a change", async (lang) => {
    const result = await server.transformRequest(`/src/i18n/${lang}.ts`);
    expect(result?.code).not.toMatch(new RegExp(`/src/i18n/${lang}/`));
    const mod = server.moduleGraph.getModuleById(join(DIR, `${lang}.ts`));
    const imported = [...(mod?.importedModules ?? [])].map((m) => m.file);
    expect(imported).toHaveLength(readdirSync(join(DIR, lang)).filter((f) => f.endsWith(".ts")).length);
    expect(imported.every((file) => file?.startsWith(join(DIR, lang)))).toBe(true);
  });
});
