// Draws the desktop app's icons (src-tauri/icons) and its small in-app mark (src/assets/manut-mark.svg) from the brand
// mark: `node apps/desktop/scripts/app-icons.mjs`, on a Mac. The mark is the design canvas's Logo board ("Manut AI mark"):
// a person in profile on warm grey, cropped by the right and bottom edges, with the ear and the tick drawn in the ground
// colour. It is the same drawing as the web app's icons (apps/web/scripts/app-icons.mjs) and the app's own BrandMark
// (src/sidebar/menuIcons.tsx). Until 25 Nov 2026 the icon was a placeholder, an "M" in the mark's colours.
//
// An app icon is the mark on Apple's icon grid: a rounded square of 824 in a canvas of 1024 with see-through margins, as
// macOS draws every app's icon, so it sits in the Dock at the size of its neighbours. Each size is drawn for itself, not
// scaled down from the largest: the whole mark from 128px up, and below that the mark as BrandMark draws it small, with no
// ear and a heavier tick, which is what still reads at 16px in a Finder list.
//
// The PNGs are rendered by the Chromium that Playwright installs for this app's tests, the .icns is made by macOS's own
// iconutil, and the .ico by `tauri icon`, so nothing new is installed. The set of files is the one that was here before.

import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const ICONS = join(ROOT, "src-tauri", "icons");
const GROUND = "#E3E1DB";
const INK = "#1F2022";
const PERSON = "M186 168 C180 196 176 208 170 226 C162 244 146 256 138 270 C134 278 142 284 160 286 C164 292 158 298 158 304 " +
  "C158 310 168 310 168 314 C168 320 158 322 160 330 C162 338 170 338 170 346 C172 366 178 386 204 392 C222 396 240 392 252 " +
  "388 C258 410 256 430 246 444 C216 456 150 468 122 512 L512 512 L512 372 C470 366 428 356 404 330 C438 334 462 306 446 280 " +
  "C478 268 482 222 452 208 C476 184 462 140 428 138 C432 104 392 76 362 92 C342 64 296 62 280 86 C252 70 212 84 208 116 " +
  "C188 124 180 148 186 168 Z";
const EAR = "M288 236 C314 224 336 248 326 274 C318 296 288 298 282 278 C278 264 292 254 302 262";
const TICK = "M192 232 L206 246 L232 216";

/** The mark on its 512 square, drawn for the size it will be seen at (`px`, the mark's own width on screen): the whole
 *  mark with its ear from 100px up (the colour-ways' widths, 14 and 15), and under that no ear and a tick of 20, or of 28
 *  at 28px and under, as BrandMark draws it. */
function drawing(px) {
  const line = (d, width) => `<path fill="none" stroke="${GROUND}" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round" d="${d}"/>`;
  const whole = px >= 100;
  return `<rect width="512" height="512" fill="${GROUND}"/><path fill="${INK}" d="${PERSON}"/>` +
    (whole ? line(EAR, 14) : "") + line(TICK, whole ? 15 : px > 28 ? 20 : 28);
}

/** The small in-app mark, seen at 11 and 12px: the mark with the board's rounded corners (22.5% of the width). */
function markSvg() {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" role="img" aria-label="Manut AI">\n` +
    `  <!-- The brand mark, small: a person in profile with the tick cut out (the design canvas's Logo board). Written by\n` +
    `       scripts/app-icons.mjs; change it there. -->\n` +
    `  <defs><clipPath id="r"><rect width="512" height="512" rx="115.2"/></clipPath></defs>\n` +
    `  <g clip-path="url(#r)">${drawing(12)}</g>\n</svg>\n`;
}

/** An app icon `size` pixels wide: the mark on Apple's icon grid, with see-through margins. */
function iconSvg(size) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" width="${size}" height="${size}">` +
    `<defs><clipPath id="r"><rect x="100" y="100" width="824" height="824" rx="185.4"/></clipPath></defs>` +
    `<g clip-path="url(#r)"><g transform="translate(100 100) scale(${824 / 512})">${drawing((size * 824) / 1024)}</g></g></svg>`;
}

/** A PNG's width, from its header: every icon here is square. */
const widthOf = (file) => readFileSync(file).readUInt32BE(16);

writeFileSync(join(ROOT, "src", "assets", "manut-mark.svg"), markSvg());

const work = mkdtempSync(join(tmpdir(), "manut-icons-"));
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ deviceScaleFactor: 1 });
  const render = async (size, to) => {
    await page.setViewportSize({ width: size, height: size });
    await page.setContent(`<!doctype html><html><body style="margin:0;background:transparent">${iconSvg(size)}</body></html>`);
    await page.screenshot({ path: to, omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } });
  };

  // every PNG that was here, each at its own size
  for (const name of readdirSync(ICONS).filter((f) => f.endsWith(".png"))) await render(widthOf(join(ICONS, name)), join(ICONS, name));

  // icon.icns: macOS's own sizes, each drawn for itself
  const set = join(work, "icon.iconset");
  mkdirSync(set);
  for (const pt of [16, 32, 128, 256, 512]) {
    await render(pt, join(set, `icon_${pt}x${pt}.png`));
    await render(pt * 2, join(set, `icon_${pt}x${pt}@2x.png`));
  }
  execFileSync("iconutil", ["-c", "icns", "-o", join(ICONS, "icon.icns"), set]);

  // icon.ico: Windows' sizes, which `tauri icon` packs from the largest drawing
  const source = join(work, "source.png");
  await render(1024, source);
  const made = join(work, "tauri");
  execFileSync("pnpm", ["exec", "tauri", "icon", source, "-o", made], { cwd: ROOT, stdio: "ignore" });
  copyFileSync(join(made, "icon.ico"), join(ICONS, "icon.ico"));
} finally {
  await browser.close();
  rmSync(work, { recursive: true, force: true });
}
console.log("icons written to", ICONS);
