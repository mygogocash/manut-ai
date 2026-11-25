// The rule every stylesheet keeps (docs/motion.md): a move is one of the Motion board's named moves, timed by
// motion.css's tokens. This walks every stylesheet under src and fails on a curve, a time or a timing word typed by
// hand, a move that is not a named one, a move that plays once for longer than a second, a loop that is not work in
// progress, a transition of the focus ring (or of `all`, which would take the ring with it), a stylesheet of its own
// turning moves off for reduced motion, and a button that does not press. motion.css is where the moves are made, so
// it alone may type them; motion.test.ts holds it to the kit.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseCss, splitTop, type CssRule } from "./cssRules";

const SRC = join(__dirname, "..");
const KIT_CSS = readFileSync(join(SRC, "..", "..", "..", "packages", "ui-kit", "app.css"), "utf8");
const MOTION_FILE = "theme/motion.css";

const files = (readdirSync(SRC, { recursive: true }) as string[])
  .filter((f) => f.endsWith(".css"))
  .map((f) => f.split("\\").join("/"))
  .sort();
const sheets = new Map(files.map((f) => [f, parseCss(readFileSync(join(SRC, f), "utf8"))]));
const MOTION = sheets.get(MOTION_FILE)!;

/** The named moves' keyframes (motion.css's own), and which of them may loop: only work in progress loops. */
const NAMED = new Set(MOTION.keyframes.map((k) => k.name));
const LOOPS = new Set(["shim", "pulse", "roll6", "spin"]);

/** The team faces' moves, read from the kit's face section: the board says they are drawn on States: team faces, with
 *  their own moves, so a stylesheet that draws a face may use them as they are. */
const FACE_MOVES = new Set(
  [...KIT_CSS.slice(KIT_CSS.indexOf("team faces"), KIT_CSS.lastIndexOf("data-fm=")).matchAll(/@keyframes\s+(f[\w-]+)/g)].map((m) => m[1]).filter((n) => n !== "fspin"),
);

/** The true exceptions: a keyframes of a stylesheet's own, used as it is, and why. */
const OWN_MOVES: Record<string, { file: string; why: string }> = {
  "ui-ring-turn": {
    file: "ui/ui.css",
    why: "the live ring's turn: Live.tsx's ringDelay keeps a ring's angle on its 1.2 s period when it moves to another row, so the period changes there and here together (item 85b, the chat's working marks)",
  },
  "bv-flow": {
    file: "runs/runs.css",
    why: "a dash riding an SVG edge into a running node, the Shimmer's idea on a drawn line, which the kit's background shimmer cannot paint; it runs at the Shimmer's time",
  },
  "msg-lit": {
    file: "chat/chat.css",
    why: "a quote's message lit for a moment: the ring holds, then fades, and nothing takes the class away, so its keyframes are what end it; no named move points at what is already there (item 85b settles it)",
  },
};

/** Classes named like a button that are rows: they answer with the Hover fade only, as the kit's rows do. */
const NOT_BUTTONS: Record<string, string> = {
  "me-btn": "the sidebar's account row (face and name across the menu's width)",
  "who-btn": "the chat header's name row (face and name)",
};

const MOVE_PROPS = /^(transition|animation)(-(duration|delay|timing-function|name|iteration-count|property))?$/;
const TIME = /(?<![\w.-])(\d*\.?\d+)(ms|s)(?![\w-])/g;
const WORD = /(?<![\w-])(ease(?:-in-out|-in|-out)?|linear|step-start|step-end)(?![\w-])/;
const KEYWORDS = new Set(["none", "infinite", "both", "forwards", "backwards", "normal", "reverse", "alternate", "alternate-reverse", "running", "paused", "initial", "inherit", "unset"]);

/** motion.css's own tokens, to read how long a move written with them takes. */
const TOKENS: Record<string, string> = {};
for (const r of MOTION.rules.filter((r) => r.selector === ":root" && !r.at.length)) for (const d of r.decls) if (d.prop.startsWith("--")) TOKENS[d.prop] = d.value;

const expand = (v: string): string => {
  let out = v;
  for (let n = 0; n < 10 && /var\(--/.test(out); n++) out = out.replace(/var\((--[\w-]+)(?:,\s*[^)]*)?\)/g, (m, name: string) => TOKENS[name] ?? m);
  return out;
};

/** Seconds from a time written with tokens: `0.5s`, `var(--move-rise)`, `calc(var(--move-pulse) / 8)`. */
function secondsOf(text: string): number {
  const src = expand(text).replace(/(\d*\.?\d+)(ms|s)\b/g, (_, n: string, u: string) => String(u === "ms" ? Number(n) / 1000 : Number(n)));
  let i = 0;
  const peek = () => src.slice(i).trimStart()[0];
  const eat = (c: string) => {
    while (src[i] === " ") i++;
    if (src[i] !== c) throw new Error(`expected ${c} in ${text}`);
    i++;
  };
  const atom = (): number => {
    while (src[i] === " ") i++;
    const fn = /^(calc|min|max)\(/.exec(src.slice(i));
    if (fn) {
      i += fn[0].length;
      const args = [sum()];
      while (peek() === ",") {
        eat(",");
        args.push(sum());
      }
      eat(")");
      return fn[1] === "min" ? Math.min(...args) : fn[1] === "max" ? Math.max(...args) : args[0];
    }
    if (peek() === "(") {
      eat("(");
      const v = sum();
      eat(")");
      return v;
    }
    const num = /^-?\d*\.?\d+/.exec(src.slice(i));
    if (!num) throw new Error(`cannot read a time in ${text}`);
    i += num[0].length;
    return Number(num[0]);
  };
  const product = (): number => {
    let v = atom();
    for (let c = peek(); c === "*" || c === "/"; c = peek()) {
      eat(c);
      v = c === "*" ? v * atom() : v / atom();
    }
    return v;
  };
  const sum = (): number => {
    let v = product();
    for (let c = peek(); c === "+" || c === "-"; c = peek()) {
      eat(c);
      v = c === "+" ? v + product() : v - product();
    }
    return v;
  };
  return sum();
}

/** The keyframes an animation value names, once its tokens are read. */
const namesIn = (value: string) =>
  splitTop(expand(value)).flatMap((item) =>
    item
      .replace(/\b(calc|min|max|cubic-bezier|steps)\([^)]*\)+/g, "")
      .split(/\s+/)
      .filter((w) => w && !/^-?\d*\.?\d+(ms|s)?$/.test(w) && !WORD.test(w) && !KEYWORDS.has(w)),
  );

const reduced = (r: CssRule) => r.at.some((a) => /prefers-reduced-motion/.test(a));

/** What a stylesheet (`css`, at `file` under src) does against the rule: one line a slip, none when it keeps it. */
function problemsIn(file: string, css: string): string[] {
  const sheet = parseCss(css);
  const problems: string[] = [];
  const text = css.replace(/\/\*[\s\S]*?\*\//g, "");
  if (/cubic-bezier\(|steps\(/.test(text)) problems.push("types a curve: use --aui-ease or --ease-plain through a motion.css token");

  for (const k of sheet.keyframes) {
    const own = OWN_MOVES[k.name];
    if (FACE_MOVES.has(k.name) || (own && own.file === file)) continue;
    problems.push(`@keyframes ${k.name}: not a named move (motion.css has ${[...NAMED].join(", ")})`);
  }

  for (const r of sheet.rules) {
    for (const d of r.decls) {
      if (!MOVE_PROPS.test(d.prop)) continue;
      const where = `${r.selector} { ${d.prop}: ${d.value} }`;
      if (reduced(r)) {
        problems.push(`${where}: motion.css turns every move off for reduced motion; say only what the still frame looks like`);
        continue;
      }
      const names = d.prop === "animation" || d.prop === "animation-name" ? namesIn(d.value) : [];
      if (names.some((n) => OWN_MOVES[n]?.file === file || FACE_MOVES.has(n))) continue;
      for (const m of d.value.matchAll(TIME)) if (Number(m[1]) !== 0) problems.push(`${where}: types a time (${m[0]}); use a --move-* token`);
      if (WORD.test(d.value)) problems.push(`${where}: types a timing word; use a --tr-* or --anim-* token`);
      if (d.prop === "transition" || d.prop === "transition-property") {
        for (const item of splitTop(d.value)) {
          const prop = item.split(/\s+/)[0];
          if (prop === "all" || prop.startsWith("outline")) problems.push(`${where}: the focus ring never moves; name what fades instead of ${prop}`);
        }
      }
      if (d.prop === "animation" || d.prop === "animation-name") {
        for (const n of names) if (!NAMED.has(n)) problems.push(`${where}: ${n} is not a named move`);
        if (d.prop === "animation") {
          for (const item of splitTop(expand(d.value))) {
            if (item === "none") continue;
            const loops = /\binfinite\b/.test(item);
            const name = namesIn(item)[0];
            if (loops && name && !LOOPS.has(name)) problems.push(`${where}: only work in progress loops (Shimmer, Pulse, Roll, Loading, Spin)`);
            const times = [...item.matchAll(/(?:calc|min|max)\((?:[^()]|\([^()]*\))*\)|-?\d*\.?\d+(?:ms|s)\b/g)].map((m) => secondsOf(m[0]));
            if (!loops && times.reduce((a, b) => a + b, 0) > 1) problems.push(`${where}: plays for longer than a second`);
          }
        }
      }
      if (d.prop === "animation-delay" || d.prop === "transition-delay" || d.prop === "transition") {
        const longest = Math.max(0, ...[...expand(d.value).matchAll(/(?:calc|min|max)\((?:[^()]|\([^()]*\))*\)|-?\d*\.?\d+(?:ms|s)\b/g)].map((m) => secondsOf(m[0])));
        if (longest > 1) problems.push(`${where}: takes longer than a second`);
      }
    }
  }
  return problems;
}

describe("every stylesheet moves only by the Motion board", () => {
  it("reads all of them", () => {
    expect(files.length).toBeGreaterThan(50);
    expect(files).toContain(MOTION_FILE);
    expect(NAMED).toEqual(new Set(["rise", "pop", "grow", "shim", "pulse", "roll6", "spin", "leave"]));
    expect(FACE_MOVES.size).toBeGreaterThan(10);
  });

  for (const file of files.filter((f) => f !== MOTION_FILE)) {
    it(file, () => {
      const problems = problemsIn(file, readFileSync(join(SRC, file), "utf8"));
      expect(problems, problems.join("\n")).toEqual([]);
    });
  }

  it("catches each kind of slip, so a green run means the stylesheets keep the rule", () => {
    const slips = (css: string) => problemsIn("x/x.css", css);
    expect(slips(".a { transition: opacity var(--tr-hover); animation: var(--anim-rise); }")).toEqual([]);
    expect(slips(".a { transition: opacity 0.2s; }")[0]).toMatch(/types a time/);
    expect(slips(".a { transition: opacity var(--move-hover) ease; }")[0]).toMatch(/timing word/);
    expect(slips(".a { transition: opacity var(--move-hover) cubic-bezier(0, 0, 1, 1); }")[0]).toMatch(/types a curve/);
    expect(slips(".a { transition: outline-offset var(--tr-hover); }")[0]).toMatch(/focus ring/);
    expect(slips(".a { transition: all var(--tr-hover); }")[0]).toMatch(/focus ring/);
    expect(slips("@keyframes wobble { to { opacity: 0; } } .a { animation: wobble var(--move-rise) both; }")).toEqual([
      expect.stringMatching(/@keyframes wobble: not a named move/),
      expect.stringMatching(/wobble is not a named move/),
    ]);
    expect(slips(".a { animation: rise var(--move-roll) both; }")[0]).toMatch(/longer than a second/);
    expect(slips(".a { animation: rise var(--move-rise) var(--aui-ease) infinite; }")[0]).toMatch(/only work in progress loops/);
    expect(slips(".a { animation-delay: calc(var(--move-step) * 30); }")[0]).toMatch(/longer than a second/);
    expect(slips("@media (prefers-reduced-motion: reduce) { .a { animation: none; } }")[0]).toMatch(/turns every move off/);
    expect(slips("@media (prefers-reduced-motion: reduce) { .a { opacity: 0.8; } }")).toEqual([]);
    // a stylesheet's own move is allowed only where the list says, and a face's anywhere
    expect(slips("@keyframes ui-ring-turn { to { opacity: 1; } }")).toHaveLength(1);
    expect(problemsIn("ui/ui.css", "@keyframes ui-ring-turn { to { opacity: 1; } } .r { animation: ui-ring-turn 1.2s linear infinite; }")).toEqual([]);
    expect(slips("@keyframes fblink { to { opacity: 1; } } .f { animation: fblink 6s infinite; }")).toEqual([]);
  });

  it("lets motion.css alone type the moves, and every move there that plays once stays under a second", () => {
    for (const [name, value] of Object.entries(TOKENS)) {
      if (!/^--move-/.test(name) || ["--move-shimmer", "--move-pulse", "--move-roll", "--move-loading", "--move-spin"].includes(name)) continue;
      expect(secondsOf(value), name).toBeLessThanOrEqual(1);
    }
    for (const [name, own] of Object.entries(OWN_MOVES)) {
      expect(sheets.get(own.file)?.keyframes.some((k) => k.name === name), `${name} in ${own.file}`).toBe(true);
      expect(own.why.length).toBeGreaterThan(40);
    }
  });

  it("presses every button: each class named like one is in motion.css's Press", () => {
    const press = MOTION.rules.find((r) => r.decls.some((d) => d.prop === "scale" && d.value === "var(--press-by)"))!;
    const round = MOTION.rules.find((r) => r.decls.some((d) => d.prop === "scale" && d.value === "var(--press-by-round)"))!;
    const listed = new Set([...`${press.selector} ${round.selector}`.matchAll(/\.([\w-]+)/g)].map((m) => m[1]));
    const named = new Set<string>();
    for (const [file, sheet] of sheets) {
      if (file === MOTION_FILE) continue;
      for (const r of sheet.rules)
        for (const m of r.selector.matchAll(/\.([a-z][\w-]*)/g))
          if (/^(btn|ib|send)$|-(btn|ib|send|plus|x)$|[a-z]btn$/.test(m[1])) named.add(m[1]);
    }
    const missing = [...named].filter((c) => !listed.has(c) && !(c in NOT_BUTTONS)).sort();
    expect(missing, `add to the Press list in motion.css, or to NOT_BUTTONS here with why: ${missing.join(", ")}`).toEqual([]);
    for (const c of Object.keys(NOT_BUTTONS)) expect(listed.has(c), c).toBe(false);
  });
});
