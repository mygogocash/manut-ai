// Draws the owner's web app's icons (public/app/icons) from the brand mark, and renders the PNGs from the same drawing:
// `node apps/web/scripts/app-icons.mjs`. The mark is the design canvas's Logo board ("Manut AI mark"): a person in profile
// on warm grey, cropped by the right and bottom edges, with the ear and the tick drawn in the ground colour. Its stroke
// widths are the colour-ways' (14 and 15 at 512), which hold at a home screen's size.
//
// `icon.svg` and the two "any" PNGs have the board's rounded corners (22.5% of the width) and see-through corners, for
// browsers that show an icon as it is. The maskable PNG and the Apple touch icon fill the square, since Android and iOS
// cut their own shape from it; the mark's face sits well inside the circle a maskable icon keeps.
//
// The PNGs are rendered by the Chromium Playwright installs for apps/desktop's tests, so nothing new is installed.

import { writeFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(new URL("../../desktop/package.json", import.meta.url));
const { chromium } = require("@playwright/test");

const OUT = new URL("../public/app/icons/", import.meta.url);
const GROUND = "#E3E1DB";
const INK = "#1F2022";
const PERSON = "M186 168 C180 196 176 208 170 226 C162 244 146 256 138 270 C134 278 142 284 160 286 C164 292 158 298 158 304 " +
  "C158 310 168 310 168 314 C168 320 158 322 160 330 C162 338 170 338 170 346 C172 366 178 386 204 392 C222 396 240 392 252 " +
  "388 C258 410 256 430 246 444 C216 456 150 468 122 512 L512 512 L512 372 C470 366 428 356 404 330 C438 334 462 306 446 280 " +
  "C478 268 482 222 452 208 C476 184 462 140 428 138 C432 104 392 76 362 92 C342 64 296 62 280 86 C252 70 212 84 208 116 " +
  "C188 124 180 148 186 168 Z";
const EAR = "M288 236 C314 224 336 248 326 274 C318 296 288 298 282 278 C278 264 292 254 302 262";
const TICK = "M192 232 L206 246 L232 216";

/// The mark at 512, with rounded corners (`rounded`) or filling the square.
function mark(rounded) {
  const clip = rounded
    ? '<defs><clipPath id="r"><rect width="512" height="512" rx="115.2"/></clipPath></defs><g clip-path="url(#r)">'
    : "<g>";
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">` +
    `<title>Manut AI</title>${clip}<rect width="512" height="512" fill="${GROUND}"/><path fill="${INK}" d="${PERSON}"/>` +
    `<path fill="none" stroke="${GROUND}" stroke-width="14" stroke-linecap="round" stroke-linejoin="round" d="${EAR}"/>` +
    `<path fill="none" stroke="${GROUND}" stroke-width="15" stroke-linecap="round" stroke-linejoin="round" d="${TICK}"/>` +
    "</g></svg>\n";
}

writeFileSync(new URL("icon.svg", OUT), mark(true));

const browser = await chromium.launch();
try {
  const page = await browser.newPage({ deviceScaleFactor: 1 });
  for (const [name, size, rounded] of [["icon-192.png", 192, true], ["icon-512.png", 512, true],
    ["maskable-512.png", 512, false], ["apple-touch-icon.png", 180, false]]) {
    await page.setViewportSize({ width: size, height: size });
    const svg = mark(rounded).replace('width="512" height="512"', `width="${size}" height="${size}"`);
    await page.setContent(`<!doctype html><html><body style="margin:0;background:transparent">${svg}</body></html>`);
    await page.screenshot({ path: new URL(name, OUT).pathname, omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } });
  }
} finally {
  await browser.close();
}
console.log("icons written to", OUT.pathname);
