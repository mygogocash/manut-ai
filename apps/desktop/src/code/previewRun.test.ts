// What a lane's preview decides (src/code/previewRun.ts): the command chosen from the lane folder's package.json, the secrets it runs
// with and what each is set to, and what each thing the shell says of a run makes of it. Pure functions, so the tests are tables.
import { afterEach, describe, expect, it } from "vitest";
import devUrlSource from "../../../../packages/dev-url/src/index.ts?raw";
import envExampleSource from "../../../../packages/env-example/src/index.ts?raw";
import previewCommandSource from "../../../../packages/preview-command/src/index.ts?raw";
import { setLang, t } from "../i18n";
import type { Need } from "./preview";
import {
  exitRun,
  isLive,
  lastLines,
  linesRun,
  NOT_STARTED,
  planOf,
  previewSecrets,
  readProject,
  refusedRun,
  reservedName,
  SHOWN,
  START_WAIT_MS,
  startedRun,
  startingRun,
  stoppingRun,
  TAIL,
  waitedRun,
  whyWords,
  type PreviewProject,
} from "./previewRun";

const SHOP: Need = { name: "PROMPTPAY_SHOP_ID", kind: "shop_id" };
const STRIPE: Need = { name: "STRIPE_SECRET_KEY", kind: "key" };
const KEY = "sk-FAKE0000000000000000TEST";
const project = (o: Partial<PreviewProject> = {}): PreviewProject => ({ packageJson: JSON.stringify({ scripts: { dev: "vite" } }), files: ["package.json", "pnpm-lock.yaml"], envExample: null, ...o });

afterEach(() => setLang("en"));

describe("the shell's answer for a lane's folder", () => {
  it("is read whole, and anything else is not a project", () => {
    expect(readProject({ packageJson: "{}", files: ["package.json", 3], envExample: null })).toEqual({ packageJson: "{}", files: ["package.json"], envExample: null });
    expect(readProject({ packageJson: null, files: [], envExample: "A=1\n" })).toEqual({ packageJson: null, files: [], envExample: "A=1\n" });
    for (const bad of [null, "x", 3, {}, { packageJson: "{}" }, { packageJson: "{}", files: "package.json" }]) expect(readProject(bad), JSON.stringify(bad)).toBeNull();
  });
});

describe("the command", () => {
  it("is the one @manut/preview-command chooses, as words for the shell and one line for the view", () => {
    expect(planOf(project())).toEqual({ argv: ["pnpm", "run", "dev"], label: "pnpm run dev" });
    expect(planOf(project({ files: ["package.json", "yarn.lock"], packageJson: JSON.stringify({ scripts: { start: "next start" } }) }))).toEqual({ argv: ["yarn", "run", "start"], label: "yarn run start" });
  });

  it("is none, with why, for no package.json, one that cannot be read, no script, and scripts that publish", () => {
    expect(planOf(project({ packageJson: null }))).toEqual({ none: "no_package_json" });
    // the shell sends an empty text for one it would not read (a link, too big)
    expect(planOf(project({ packageJson: "" }))).toEqual({ none: "unreadable" });
    expect(planOf(project({ packageJson: JSON.stringify({ scripts: { build: "vite build" } }) }))).toEqual({ none: "no_script" });
    expect(planOf(project({ packageJson: JSON.stringify({ scripts: { dev: "vite", predev: "vercel deploy --prod" } }) }))).toEqual({ none: "refused" });
  });
});

describe("what it runs with", () => {
  it("sets each secret Kit's changes read to its sample through previewEnv: a shop ID of zeros, a key a plain fake", () => {
    expect(previewSecrets([SHOP, STRIPE], null)).toEqual([
      ["PROMPTPAY_SHOP_ID", "0000000000"],
      ["STRIPE_SECRET_KEY", "sample-value"],
    ]);
  });

  it("a secret the owner added is the one real value that gets in, and only through previewEnv", () => {
    expect(previewSecrets([SHOP, STRIPE], null, { PROMPTPAY_SHOP_ID: "0812345678" })).toEqual([
      ["PROMPTPAY_SHOP_ID", "0812345678"],
      ["STRIPE_SECRET_KEY", "sample-value"],
    ]);
  });

  it("adds each secret the folder's .env.example names, with a fake value, never the one written there", () => {
    const example = [
      "# the shop's PromptPay ID",
      "PROMPTPAY_SHOP_ID=0812345678",
      "OPENAI_API_KEY=sk-live-written-by-mistake",
      "SUPABASE_PRIVATE_URL=https://db.example",
      "SESSION_SIGNING=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      "PORT=3000",
      "VITE_SHOP_NAME=Baan Mali",
    ].join("\n");
    const env = Object.fromEntries(previewSecrets([], example));
    expect(env).toEqual({
      // its name says it is a shop ID: all zeros, as previewEnv has it, though the file wrote a real-looking one
      PROMPTPAY_SHOP_ID: "0000000000",
      // a key by its name (previewEnv), and secrets by .env.example's own rule (sampleEnv)
      OPENAI_API_KEY: "sample-value",
      SUPABASE_PRIVATE_URL: "sample-supabase_private_url",
      SESSION_SIGNING: "sample-session_signing",
    });
    // what is no secret is left to the project: the app sets nothing a .env file would not
    expect(env).not.toHaveProperty("PORT");
    expect(env).not.toHaveProperty("VITE_SHOP_NAME");
    expect(JSON.stringify(previewSecrets([], example))).not.toMatch(/0812345678|sk-live|db\.example|AAAA/);
  });

  it("keeps a name found both ways once, as previewEnv says, in name order", () => {
    const env = previewSecrets([STRIPE], "STRIPE_SECRET_KEY=sk_test_x\nAPI_TOKEN=\n");
    expect(env).toEqual([
      ["API_TOKEN", "sample-value"],
      ["STRIPE_SECRET_KEY", "sample-value"],
    ]);
  });

  it("leaves out a name the shell keeps for itself, which it would refuse to start over", () => {
    for (const name of ["PATH", "HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "LANG", "TERM", "LC_ALL", "LC_API_KEY", "DYLD_INSERT_LIBRARIES", "LD_PRELOAD"]) expect(reservedName(name), name).toBe(true);
    for (const name of ["API_KEY", "PROMPTPAY_SHOP_ID", "PATH_TOKEN", "LCD_KEY"]) expect(reservedName(name), name).toBe(false);
    expect(previewSecrets([], "LC_API_KEY=x\nDYLD_SECRET=y\nAPI_KEY=z\n")).toEqual([["API_KEY", "sample-value"]]);
  });

  it("is nothing when nothing is known to be a secret", () => {
    expect(previewSecrets([], null)).toEqual([]);
    expect(previewSecrets([], "")).toEqual([]);
    expect(previewSecrets([], "PORT=3000\nNODE_ENV=development\n")).toEqual([]);
  });
});

describe("a run", () => {
  const started = () => startedRun(startingRun("pnpm run dev", 1_000), 7);

  it("starts as Starting, with the command, and is live until it ends", () => {
    const r = startingRun("pnpm run dev", 1_000);
    expect(r).toMatchObject({ phase: "starting", label: "pnpm run dev", since: 1_000, id: null, url: null, lines: [] });
    expect(isLive(r)).toBe(true);
    expect(isLive(NOT_STARTED)).toBe(false);
    expect(started().id).toBe(7);
  });

  it("is Running at the first address of this computer it prints, read through a terminal's colours", () => {
    let r = linesRun(started(), ["> vite", "  ➜  Network: http://192.168.1.5:5173/"]);
    expect(r.phase).toBe("starting");
    r = linesRun(r, ["  \u001b[32m➜\u001b[39m  Local:   \u001b[36mhttp://localhost:\u001b[1m5173\u001b[22m/\u001b[39m"]);
    expect(r).toMatchObject({ phase: "running", url: "http://localhost:5173/" });
    // kept as a person reads them
    expect(r.lines.at(-1)).toBe("  ➜  Local:   http://localhost:5173/");
    // a later address does not move it
    expect(linesRun(r, ["Local: http://localhost:3000/"]).url).toBe("http://localhost:5173/");
    // nor does an address printed after Stop was pressed make it Running again
    const stopping = linesRun(stoppingRun(started()), ["  ➜  Local:   http://localhost:5173/"]);
    expect(stopping).toMatchObject({ phase: "stopping", url: null });
    expect(stopping.lines).toEqual(["  ➜  Local:   http://localhost:5173/"]);
  });

  it("keeps only its last lines, in memory", () => {
    let r = started();
    for (let i = 0; i < TAIL + 50; i++) r = linesRun(r, [`line ${i}`]);
    expect(r.lines).toHaveLength(TAIL);
    expect(r.lines[0]).toBe("line 50");
  });

  it("is no longer said to be starting once it ran a minute with no address, and an address after that still counts", () => {
    const r = started();
    expect(waitedRun(r, 1_000 + START_WAIT_MS - 1).phase).toBe("starting");
    const quiet = waitedRun(r, 1_000 + START_WAIT_MS);
    expect(quiet.phase).toBe("quiet");
    expect(isLive(quiet)).toBe(true);
    expect(linesRun(quiet, ["ready on http://localhost:8787"])).toMatchObject({ phase: "running", url: "http://localhost:8787/" });
    // a start the shell has not answered yet waits on, and a shorter wait is the host's to give
    expect(waitedRun(startingRun("x", 0), START_WAIT_MS * 2).phase).toBe("starting");
    expect(waitedRun(r, 1_500, 500).phase).toBe("quiet");
  });

  it("is Stopped when it was stopped, and Ended with its code when it ended by itself", () => {
    const running = linesRun(started(), ["Local: http://localhost:5173/"]);
    expect(exitRun(running, null, true)).toMatchObject({ phase: "stopped", id: null });
    expect(exitRun(stoppingRun(running), 0, false)).toMatchObject({ phase: "stopped" });
    expect(exitRun(running, 1, false)).toMatchObject({ phase: "ended", code: 1, id: null });
    expect(exitRun(started(), null, false)).toMatchObject({ phase: "ended", code: null });
    expect(stoppingRun(running).phase).toBe("stopping");
  });

  it("takes nothing more after it ended or could not start", () => {
    const ended = exitRun(started(), 1, false);
    expect(linesRun(ended, ["more"])).toBe(ended);
    expect(exitRun(ended, null, true)).toBe(ended);
    expect(stoppingRun(ended)).toBe(ended);
    const failed = refusedRun(startingRun("pnpm run dev", 1), "missing:pnpm");
    expect(failed).toMatchObject({ phase: "failed", why: "missing:pnpm" });
    expect(startedRun(failed, 9)).toBe(failed);
    expect(isLive(failed)).toBe(false);
  });

  it("shows its last few lines with any key hidden", () => {
    let r = started();
    r = linesRun(r, [...Array.from({ length: 10 }, (_, i) => `line ${i}`), `token=${KEY}`]);
    const shown = lastLines(r);
    expect(shown).toHaveLength(SHOWN);
    expect(shown.at(-1)).toBe("token=••••");
    expect(shown.join("\n")).not.toContain(KEY);
  });
});

describe("why, in words", () => {
  it("has words for each of the shell's codes, and the system's own words otherwise, keys hidden and cut", () => {
    expect(t(whyWords("not_a_lane").key)).toBe("this is not a lane's own folder.");
    expect(t(whyWords("changed").key)).toContain("package.json changed after it was read.");
    const missing = whyWords("missing:bun");
    expect(t(missing.key, missing.vars)).toBe("bun is not installed on this computer.");
    // an unknown manager is no code: its words are shown as they are
    expect(t(whyWords("missing:deno").key, whyWords("missing:deno").vars)).toBe("missing:deno");
    const other = whyWords(`spawn: No such file\n${KEY} ${"x".repeat(300)}`);
    const text = t(other.key, other.vars);
    expect(text).not.toContain(KEY);
    expect(text.startsWith("spawn: No such file ••••")).toBe(true);
    expect([...text].length).toBe(160);
  });

  it("are in all four languages", () => {
    for (const lang of ["ko", "ja", "zh"] as const) {
      setLang(lang);
      expect(t("lane.preview.running", { url: "http://localhost:5173/" }), lang).toContain("http://localhost:5173/");
      expect(t(whyWords("missing:pnpm").key, whyWords("missing:pnpm").vars), lang).toContain("pnpm");
      expect(t("lane.preview.ended", { code: 1 }), lang).toContain("exit 1");
    }
  });
});

describe("the packages the preview runs in the desktop's webview", () => {
  it("call nothing macOS 11's Safari lacks: no Object.hasOwn, Array.at, findLast, structuredClone or a regex lookbehind", () => {
    // tauri.conf.json's minimumSystemVersion is 11.0, whose Safari can be 14; one of these fails the page as it loads or runs
    for (const [name, src] of [
      ["preview-command", previewCommandSource],
      ["dev-url", devUrlSource],
      ["env-example", envExampleSource],
    ] as const) {
      const code = src.replace(/^\s*\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
      expect(code, name).not.toMatch(/Object\.hasOwn\(|\.at\(|\.findLast(Index)?\(|structuredClone\(|\(\?<[=!]/);
    }
  });
});
