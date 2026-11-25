import { describe, expect, it } from "vitest";
import { previewCommand } from "../src/index";

const pj = (scripts: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ name: "x", scripts, ...extra });

describe("package manager", () => {
  const cases: Array<[string[], string]> = [
    [["pnpm-lock.yaml"], "pnpm"],
    [["yarn.lock"], "yarn"],
    [["bun.lock"], "bun"],
    [["bun.lockb"], "bun"],
    [["package-lock.json"], "npm"],
    [[], "npm"],
    [["package-lock.json", "yarn.lock"], "yarn"],
    [["yarn.lock", "pnpm-lock.yaml"], "pnpm"],
  ];
  for (const [files, manager] of cases) {
    it(`${files.join(", ") || "no lockfile"} -> ${manager}`, () => {
      expect(previewCommand({ packageJson: pj({ dev: "vite" }), files })).toEqual({
        argv: [manager, "run", "dev"],
        manager,
        script: "dev",
      });
    });
  }

  it("the packageManager field wins over the lockfile", () => {
    const r = previewCommand({ packageJson: pj({ dev: "vite" }, { packageManager: "pnpm@9.1.0" }), files: ["yarn.lock"] });
    expect(r).toEqual({ argv: ["pnpm", "run", "dev"], manager: "pnpm", script: "dev" });
  });

  it("a packageManager this does not run falls back to the lockfile", () => {
    const r = previewCommand({ packageJson: pj({ dev: "vite" }, { packageManager: "deno@2" }), files: ["yarn.lock"] });
    expect(r).toMatchObject({ manager: "yarn" });
    const s = previewCommand({ packageJson: pj({ dev: "vite" }, { packageManager: 7 }), files: [] });
    expect(s).toMatchObject({ manager: "npm" });
  });
});

describe("script order", () => {
  it("takes the first of dev, start, preview, serve", () => {
    const all = { serve: "a", preview: "b", start: "c", dev: "d" };
    expect(previewCommand({ packageJson: pj(all), files: [] })).toMatchObject({ script: "dev" });
    const { dev: _d, ...noDev } = all;
    expect(previewCommand({ packageJson: pj(noDev), files: [] })).toMatchObject({ script: "start" });
    const { start: _s, ...noStart } = noDev;
    expect(previewCommand({ packageJson: pj(noStart), files: [] })).toMatchObject({ script: "preview" });
    expect(previewCommand({ packageJson: pj({ serve: "a" }), files: [] })).toMatchObject({ script: "serve" });
  });

  it("ignores scripts that are not strings or are blank", () => {
    expect(previewCommand({ packageJson: pj({ dev: 1, start: "  ", preview: "vite preview" }), files: [] })).toMatchObject({
      script: "preview",
    });
  });

  it("answers argv as separate words", () => {
    const r = previewCommand({ packageJson: pj({ dev: "vite" }), files: [] });
    expect("argv" in r && r.argv).toEqual(["npm", "run", "dev"]);
  });
});

describe("refused scripts", () => {
  const bad = [
    "npm run deploy",
    "wrangler deploy",
    "npm publish",
    "changeset publish",
    "semantic-release --release",
    "vercel --prod",
    "vercel deploy",
    "netlify deploy --prod",
    "netlify --prod",
    "firebase deploy",
    "gh-pages -d dist",
    "VERCEL --PROD",
    "vite && DEPLOY",
  ];
  for (const text of bad) {
    it(`refuses ${text}`, () => {
      expect(previewCommand({ packageJson: pj({ dev: text }), files: [] })).toEqual({ none: "refused" });
    });
  }

  it("allows vercel or netlify without --prod, and look-alike words", () => {
    expect(previewCommand({ packageJson: pj({ dev: "vercel dev" }), files: [] })).toMatchObject({ script: "dev" });
    expect(previewCommand({ packageJson: pj({ dev: "netlify dev" }), files: [] })).toMatchObject({ script: "dev" });
  });

  it("answers the next script after a refused one", () => {
    const r = previewCommand({ packageJson: pj({ dev: "wrangler deploy", start: "node server.js" }), files: ["pnpm-lock.yaml"] });
    expect(r).toEqual({ argv: ["pnpm", "run", "start"], manager: "pnpm", script: "start" });
  });

  it("refuses when every script on the list is refused", () => {
    expect(previewCommand({ packageJson: pj({ dev: "npm publish", start: "gh-pages", serve: "x deploy" }), files: [] })).toEqual({
      none: "refused",
    });
  });
});

describe("nothing to run", () => {
  it("no package.json", () => {
    expect(previewCommand({ packageJson: null, files: ["index.html"] })).toEqual({ none: "no_package_json" });
  });
  it("unreadable text", () => {
    for (const text of ["", "{", "not json", "[]", "null", "7", '"s"']) {
      expect(previewCommand({ packageJson: text, files: [] })).toEqual({ none: "unreadable" });
    }
  });
  it("no usable scripts", () => {
    for (const text of ["{}", pj({}), pj({ build: "tsc", test: "vitest" }), '{"scripts":[]}', '{"scripts":null}', '{"scripts":"dev"}']) {
      expect(previewCommand({ packageJson: text, files: [] })).toEqual({ none: "no_script" });
    }
  });
  it("does not read inherited names", () => {
    expect(previewCommand({ packageJson: '{"scripts":{"toString":"x"}}', files: [] })).toEqual({ none: "no_script" });
  });
});
