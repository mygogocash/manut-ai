// The desktop's moves must be the design system's. motion.css carries the Motion board's curve, times and keyframes
// (packages/ui-kit/app.css and tokens.json "motion"); this reads both and fails on any drift, as tokens.test.ts does
// for the colours, so a move is changed in the kit first and here second, never here alone.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseCss, splitTop, type CssRule } from "./cssRules";
import { LEAVE_MS } from "../ui/leave";
import { DOCK_FADE_MS } from "../sidebar/Dock";

const KIT_DIR = join(__dirname, "..", "..", "..", "..", "packages", "ui-kit");
const KIT_CSS = parseCss(readFileSync(join(KIT_DIR, "app.css"), "utf8"));
const KIT = JSON.parse(readFileSync(join(KIT_DIR, "tokens.json"), "utf8")) as {
  motion: {
    ease: { var: string; value: string };
    plainEase: string;
    moves: { name: string; seconds: number; staggerMs?: number; loops?: boolean }[];
  };
};
const MOTION_TEXT = readFileSync(join(__dirname, "motion.css"), "utf8");
const MOTION = parseCss(MOTION_TEXT);

/** The custom properties a rule list sets, the first time each is set. */
function props(rules: CssRule[], selector: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const r of rules.filter((r) => r.selector === selector && r.at.length === 0))
    for (const d of r.decls) if (d.prop.startsWith("--") && !(d.prop in out)) out[d.prop] = d.value;
  return out;
}
const OURS = props(MOTION.rules, ":root");
const KIT_VARS = props(KIT_CSS.rules, ".r");

/** `value` with every var() replaced from `vars`, its times in seconds and its spelling made plain. */
function resolve(value: string, vars: Record<string, string>): string {
  let v = value;
  for (let n = 0; n < 10 && /var\(--/.test(v); n++) v = v.replace(/var\((--[\w-]+)(?:,\s*([^)]*))?\)/g, (_, name: string, dflt?: string) => vars[name] ?? dflt ?? `<${name}?>`);
  return v
    .replace(/(\d*\.?\d+)ms\b/g, (_, n: string) => `${Number(n) / 1000}s`)
    .replace(/(\d*\.?\d+)s\b/g, (_, n: string) => `${Number(n)}s`)
    .replace(/(^|[^\d.])0\./g, "$1.")
    .replace(/\s*,\s*/g, ",")
    .replace(/\s+/g, " ")
    .trim();
}
const ours = (value: string) => resolve(value, OURS);
const kits = (value: string) => resolve(value, KIT_VARS);

/** A declaration of the kit's rule whose selector is exactly `selector`. */
function kit(selector: string, prop: string): string {
  const r = KIT_CSS.rules.find((r) => r.selector === selector && r.decls.some((d) => d.prop === prop));
  const d = r?.decls.find((d) => d.prop === prop);
  expect(d, `${selector} { ${prop} } in packages/ui-kit/app.css`).toBeDefined();
  return d!.value;
}
const move = (name: string) => {
  const m = KIT.motion.moves.find((m) => m.name === name);
  expect(m, name).toBeDefined();
  return m!;
};
const seconds = (v: string) => {
  const m = /^(\d*\.?\d+)(ms|s)$/.exec(ours(v));
  expect(m, v).not.toBeNull();
  return Number(m![1]) / (m![2] === "ms" ? 1000 : 1);
};
/** Keyframes text with the spelling made plain; Rise's and Leave's distances read as their defaults. */
const frames = (body: string) =>
  body
    .replace(/var\(--(?:rise|leave)-by,\s*([^)]*)\)/g, "$1")
    .replace(/\s+/g, "")
    .replace(/;}/g, "}")
    .replace(/(^|[^\d.])0\./g, "$1.");

describe("motion.css against packages/ui-kit (the Motion board)", () => {
  it("has the board's one curve and the plain ease", () => {
    expect(KIT.motion.ease.var).toBe("--aui-ease");
    expect(ours("var(--aui-ease)")).toBe(resolve(KIT.motion.ease.value, {}));
    expect(ours("var(--aui-ease)")).toBe(kits("var(--aui-ease)"));
    expect(ours("var(--ease-plain)")).toBe(resolve(KIT.motion.plainEase, {}));
  });

  it("gives each named move the kit's time", () => {
    const pairs: [string, string][] = [
      ["--move-rise", "rise"],
      ["--move-settle", "pop"],
      ["--move-fill", "grow"],
      ["--move-shimmer", "shim"],
      ["--move-pulse", "pulse"],
      ["--move-roll", "roll6"],
      ["--move-press", "press"],
      ["--move-switch", "switch"],
      ["--move-hover", "hover"],
    ];
    for (const [token, name] of pairs) expect(seconds(OURS[token]), token).toBe(move(name).seconds);
    expect(seconds(OURS["--move-step"]) * 1000).toBe(move("rise").staggerMs);
    // the three the board names without a tokens.json row: Loading (the kit's .skel), the busy spinner (.spin) and an
    // overlay's short Rise (the bulk-action bar's)
    expect(ours("var(--anim-loading)")).toBe(kits(kit(".skel", "animation")));
    expect(ours("var(--anim-spin)").replace(/^spin /, "fspin ")).toBe(kits(kit(".spin", "animation")));
    expect(ours("var(--anim-arrive)")).toBe(kits(kit(".bulk", "animation")));
  });

  it("plays each move on the kit's keyframes with the kit's curve", () => {
    expect(ours("var(--anim-rise)")).toBe(kits(kit(".chips>*,.grid>*", "animation")));
    expect(ours("var(--anim-settle)")).toBe(kits(kit('.pop,.tag.ok[style*="padding:6px 12px"],.tag.ok[style*="padding: 6px 12px"]', "animation")));
    expect(ours("var(--anim-fill)")).toBe(kits(kit(".bar span,.day i", "animation")));
    expect(ours("var(--anim-shimmer)")).toBe(kits(kit(".shim", "animation")));
    expect(ours("var(--anim-pulse)")).toBe(kits(kit('.tag.run::before', "animation")));
    expect(ours("var(--anim-roll)")).toBe(kits(kit(".wordroll>span", "animation")));
    const kitFrames = new Map(KIT_CSS.keyframes.map((k) => [k.name, k.body]));
    const ourFrames = new Map(MOTION.keyframes.map((k) => [k.name, k.body]));
    for (const name of ["rise", "pop", "grow", "shim", "pulse", "roll6"]) expect(frames(ourFrames.get(name) ?? ""), name).toBe(frames(kitFrames.get(name) ?? "?"));
    expect(frames(ourFrames.get("spin") ?? "")).toBe(frames(kitFrames.get("fspin") ?? "?"));
    // Rise's distance is the board's 8px unless an overlay asks for less
    expect(ourFrames.get("rise")).toContain("var(--rise-by, 8px)");
    expect(Number.parseFloat(OURS["--arrive-by"])).toBeLessThan(8);
  });

  it("staggers Rise by the kit's step, and stops adding steps where the kit does", () => {
    expect(seconds(kit(".chips>*:nth-child(2),.grid>*:nth-child(2)", "animation-delay"))).toBe(seconds(OURS["--move-step"]));
    const last = seconds(kit(".chips>*:nth-child(n+5),.grid>*:nth-child(n+5)", "animation-delay"));
    expect(last / seconds(OURS["--move-step"])).toBeCloseTo(4);
    const rise = MOTION.rules.find((r) => r.selector === ".mo-rise")!;
    expect(rise.decls.find((d) => d.prop === "animation-delay")?.value).toBe("calc(min(var(--i, 0), 4) * var(--move-step))");
    expect(MOTION.rules.find((r) => r.selector === ".mo-fill")?.decls).toContainEqual({ prop: "transform-origin", value: "left bottom" });
  });

  it("presses, hovers and switches as the kit's controls do", () => {
    const btn = splitTop(kits(kit(".btn", "transition")));
    expect(btn).toContain(kits(`background ${OURS["--move-hover"]}`));
    expect(btn).toContain(ours("transform var(--tr-press)"));
    expect(kits(kit(".btn:active", "transform"))).toBe(`scale(${ours("var(--press-by)")})`);
    expect(kits(kit(".send:active", "transform"))).toBe(`scale(${ours("var(--press-by-round)")})`);
    expect(kits(kit(".send", "transition"))).toBe(ours("transform var(--tr-press)"));
    expect(kits(kit(".sw::after", "transition"))).toBe(splitTop(ours("var(--tr-switch-thumb)"))[0]);
    // the track: the kit's background over 0.2 s, on the plain ease rather than the browser's own
    expect(kits(kit(".sw::before", "transition"))).toBe(splitTop(ours("var(--tr-switch-track)"))[0].replace("background-color", "background").replace(/ cubic-bezier\(.*\)$/, ""));
    expect(seconds(OURS["--move-leave"])).toBeLessThan(seconds(OURS["--move-arrive"]));
  });

  it("turns every move off in one reduced-motion block, and the shimmer becomes plain grey text", () => {
    const reduced = MOTION.rules.filter((r) => r.at.some((a) => /prefers-reduced-motion:\s*reduce/.test(a)));
    expect(MOTION_TEXT.match(/prefers-reduced-motion/g)).toHaveLength(1);
    const all = reduced.find((r) => r.selector === "*, *::before, *::after")!;
    const decl = (p: string) => all.decls.find((d) => d.prop === p)?.value ?? "";
    expect(seconds(decl("animation-duration").replace(" !important", ""))).toBeLessThan(0.001);
    expect(decl("animation-iteration-count")).toBe("1 !important");
    expect(decl("animation-delay")).toBe("0s !important");
    expect(decl("transition-duration")).toBe("0s !important");
    expect(decl("transition-delay")).toBe("0s !important");
    // the kit's own reduced block: .shim{color:var(--mut);background:none}
    const kitReduced = KIT_CSS.rules.find((r) => r.selector === ".shim" && r.at.some((a) => a.includes("reduced-motion")))!;
    expect(kitReduced.decls).toEqual([
      { prop: "color", value: "var(--mut)" },
      { prop: "background", value: "none" },
    ]);
    expect(reduced.find((r) => r.selector === ".mo-shimmer")?.decls).toEqual([
      { prop: "color", value: "var(--muted)" },
      { prop: "background", value: "none" },
    ]);
  });

  it("keeps every move that plays once under a second, and lets only the loops run longer", () => {
    const loops = new Set(KIT.motion.moves.filter((m) => m.loops).map((m) => m.name));
    expect([...loops].sort()).toEqual(["pulse", "roll6", "shim"]);
    for (const [name, value] of Object.entries(OURS)) {
      if (!name.startsWith("--anim-")) continue;
      const v = ours(value);
      const time = Number(/ (\d*\.?\d+)s /.exec(v)![1]);
      if (v.endsWith(" infinite")) expect(["shim", "pulse", "roll6", "spin"], name).toContain(v.split(" ")[0]);
      else expect(time, name).toBeLessThanOrEqual(1);
    }
  });

  it("is what the app loads, after the tokens, and the overlays that wait for Leave wait as long as it takes", () => {
    const app = readFileSync(join(__dirname, "..", "app", "App.tsx"), "utf8");
    const order = ["../theme/tokens.css", "../theme/base.css", "../theme/motion.css"].map((f) => app.indexOf(`import "${f}"`));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    const leave = seconds(OURS["--move-leave"]) * 1000;
    expect(LEAVE_MS).toBe(leave);
    expect(DOCK_FADE_MS).toBe(leave);
  });
});
