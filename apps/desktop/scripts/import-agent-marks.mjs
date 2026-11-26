#!/usr/bin/env node
// Carries the coding agents', providers' and editors' published marks into manut: reads the static SVG packages of
// Lobe Icons (MIT) and Simple Icons (CC0) and writes src/ui/agentMarks.ts. Run from apps/desktop with each package
// unpacked in a scratch folder (`npm pack @lobehub/icons-static-svg simple-icons`, then `tar -xzf` each); neither is a
// dependency of the app:
//
//   node scripts/import-agent-marks.mjs <@lobehub/icons-static-svg folder> <simple-icons folder>
//
// Each mark below is taken whole from its file: the <svg>'s viewBox and inner markup, its <title> dropped, its ids
// given a placeholder (`%u`) that AgentIcon replaces with an id of its own each time it draws, so two copies of a mark
// with a gradient never share one. Nothing is redrawn or recoloured: a mark the source draws in `currentColor` follows
// the text colour, and one drawn in its own colours keeps them, as src/ui/modelMarks.ts does. The owner asked for each
// provider's own logo on 26 Nov 2026 (docs/decisions.md); the notices are in THIRD_PARTY_NOTICES.md.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, "..", "src", "ui", "agentMarks.ts");

// [key, title, package, file]. The key is what AgentIcon names a mark by. A product's own mark where the package has
// one, else its maker's (Claude Code draws Claude's, as the owner's brief asks); a tile-shaped mark (Codex's and
// Gemini CLI's colour versions are app tiles) is passed over for the bare one, so every mark stands on the row the same.
const LOBE = "lobe";
const SIMPLE = "simple";
const MARKS = [
  ["claude", "Claude", LOBE, "claude-color.svg"],
  ["codex", "Codex", LOBE, "codex.svg"],
  ["gemini", "Gemini", LOBE, "gemini-color.svg"],
  ["antigravity", "Antigravity", LOBE, "antigravity-color.svg"],
  ["qwen", "Qwen", LOBE, "qwen-color.svg"],
  ["kimi", "Kimi", LOBE, "kimi-color.svg"],
  ["grok", "Grok", LOBE, "grok.svg"],
  ["cursor", "Cursor", LOBE, "cursor.svg"],
  ["copilot", "GitHub Copilot", LOBE, "githubcopilot.svg"],
  ["opencode", "opencode", LOBE, "opencode.svg"],
  ["cline", "Cline", LOBE, "cline.svg"],
  ["pi", "Pi Agent", LOBE, "pi.svg"],
  ["hermes", "Hermes Agent", LOBE, "hermesagent.svg"],
  ["deepseek", "DeepSeek", LOBE, "deepseek-color.svg"],
  ["zai", "Z.ai", LOBE, "zai.svg"],
  ["amp", "Amp", LOBE, "amp-color.svg"],
  ["goose", "Goose", LOBE, "goose.svg"],
  ["kilo", "Kilo Code", LOBE, "kilocode.svg"],
  ["junie", "Junie", LOBE, "junie-color.svg"],
  ["trae", "TRAE", LOBE, "trae-color.svg"],
  ["roo", "Roo Code", LOBE, "roocode.svg"],
  ["windsurf", "Windsurf", LOBE, "windsurf.svg"],
  ["zed", "Zed", SIMPLE, "zedindustries.svg"],
  // No Apple mark (Xcode): the Mac App Store build may not show Apple's logos or icons without Apple's written permission
  // (Apple's trademark guidelines, App Review guideline 5.2.5), so Xcode draws its monogram, as VS Code does.
];

const [lobeDir, simpleDir] = process.argv.slice(2);
if (!lobeDir || !simpleDir) {
  console.error("usage: node scripts/import-agent-marks.mjs <@lobehub/icons-static-svg folder> <simple-icons folder>");
  process.exit(2);
}

const pkg = (dir) => JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
const SOURCES = {
  [LOBE]: { dir: lobeDir, pkg: pkg(lobeDir), licence: "MIT License, Copyright (c) 2023 LobeHub" },
  [SIMPLE]: { dir: simpleDir, pkg: pkg(simpleDir), licence: "CC0 1.0 Universal (Simple Icons)" },
};
if (SOURCES[LOBE].pkg.name !== "@lobehub/icons-static-svg") throw new Error(`${lobeDir} is not @lobehub/icons-static-svg`);
if (SOURCES[SIMPLE].pkg.name !== "simple-icons") throw new Error(`${simpleDir} is not simple-icons`);

/** One mark: the viewBox, the inner markup with its title gone and its ids made placeholders, and the fill rule the
 *  file's own <svg> sets (a path that sets none follows it). */
function take(src, file) {
  const raw = readFileSync(join(SOURCES[src].dir, "icons", file), "utf8").trim();
  const open = /^<svg\b([^>]*)>/.exec(raw);
  if (!open || !raw.endsWith("</svg>")) throw new Error(`${file}: not one <svg> element`);
  const attrs = open[1];
  const viewBox = /\bviewBox="([^"]+)"/.exec(attrs)?.[1];
  if (!viewBox) throw new Error(`${file}: no viewBox`);
  if (/<script|<foreignObject|\son[a-z]+=|javascript:|<image\b/i.test(raw)) throw new Error(`${file}: holds more than a drawing`);
  const ids = [...raw.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]);
  let body = raw.slice(open[0].length, -"</svg>".length).replace(/<title>[\s\S]*?<\/title>/g, "").trim();
  ids.forEach((id, n) => {
    const esc = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    body = body
      .replace(new RegExp(`\\bid="${esc}"`, "g"), `id="%u-${n}"`)
      .replace(new RegExp(`url\\(#${esc}\\)`, "g"), `url(#%u-${n})`)
      .replace(new RegExp(`href="#${esc}"`, "g"), `href="#%u-${n}"`);
  });
  if (/url\(#(?!%u-)/.test(body)) throw new Error(`${file}: a reference to an id the file does not define`);
  return { viewBox, body, evenodd: /\bfill-rule="evenodd"/.test(attrs) };
}

const rows = MARKS.map(([key, title, src, file]) => ({ key, title, src, file, ...take(src, file) }));
const ver = (src) => `${SOURCES[src].pkg.name} ${SOURCES[src].pkg.version}`;
const out = [
  "// GENERATED by scripts/import-agent-marks.mjs: do not edit by hand, run the script again.",
  "// The coding agents', providers' and editors' own marks, each taken whole from its published file:",
  ...[LOBE, SIMPLE].map((src) => `//   ${ver(src)} (${SOURCES[src].licence}): ${rows.filter((r) => r.src === src).map((r) => `${r.key} ${r.file}`).join(", ")}.`),
  "// The notices are in apps/desktop/THIRD_PARTY_NOTICES.md. The names and marks are their owners' trademarks; each is",
  "// shown only to name that owner's own product. `%u` in a body is replaced by an id of AgentIcon's own each time a mark",
  "// is drawn. A mark the source draws in `currentColor` follows the text colour; one with colours of its own keeps them.",
  "export interface AgentMarkArt {",
  "  title: string;",
  "  viewBox: string;",
  "  body: string;",
  "  /** The fill rule its file's own <svg> sets, which every path that sets none follows. */",
  "  evenodd: boolean;",
  "  /** Where it comes from: the package, its version and the file. */",
  "  source: string;",
  "}",
  "",
  "export const AGENT_MARKS: Record<string, AgentMarkArt> = {",
  ...rows.map(
    (r) =>
      `  ${JSON.stringify(r.key)}: ${JSON.stringify({ title: r.title, viewBox: r.viewBox, body: r.body, evenodd: r.evenodd, source: `${ver(r.src)} icons/${r.file}` })},`,
  ),
  "};",
  "",
];
writeFileSync(OUT, out.join("\n"));
console.log(`wrote ${rows.length} marks to ${OUT}`);
