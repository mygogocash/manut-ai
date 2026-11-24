// The side menu's drawings, copied from the design canvas's `<nav class="sb">` (Approvals.dc.html): 16px stroke icons
// on a 16-unit grid, drawn with the canvas's `.ic` look (menu.css and menuPages.css give it), and the brand mark at
// 28px in the mark's own two colours, the only literal colours the canvas allows besides the pastel avatar fills.
import type { ReactNode } from "react";
import type { MenuRow } from "./menu";

const ROW_PATHS: Record<MenuRow, ReactNode> = {
  new: <path d="M8 3v10M3 8h10" />,
  needs: <path d="M4 11V7a4 4 0 018 0v4l1 1.5H3L4 11zM6.5 13.5a1.5 1.5 0 003 0" />,
  team: (
    <>
      <circle cx="6" cy="6" r="2.2" />
      <path d="M2 13c.4-2.2 2-3.3 4-3.3s3.6 1.1 4 3.3M11 4.2a2 2 0 010 3.8M12 9.9c1.3.4 2 1.4 2.3 3.1" />
    </>
  ),
  code: <path d="M5.5 4.5L2 8l3.5 3.5M10.5 4.5L14 8l-3.5 3.5" />,
  artifacts: (
    <>
      <rect x="2.5" y="2.5" width="11" height="11" rx="2" />
      <path d="M2.5 6.5h11M6.5 6.5v7" />
    </>
  ),
  customize: (
    <>
      <path d="M3 5h6M12 5h1M3 11h1M7 11h6" />
      <circle cx="10.5" cy="5" r="1.5" />
      <circle cx="5.5" cy="11" r="1.5" />
    </>
  ),
  history: (
    <>
      <circle cx="8" cy="8" r="5.5" />
      <path d="M8 5v3l2 1.5" />
    </>
  ),
};

/** A menu row's icon; the pages' empty states use the same drawing as their row. */
export function MenuIcon({ row }: { row: MenuRow }) {
  return (
    <svg className="ic" viewBox="0 0 16 16" aria-hidden="true">
      {ROW_PATHS[row]}
    </svg>
  );
}

/** The magnifier of the menu's Search button and History's search box. */
export function SearchGlyph() {
  return (
    <svg className="ic" viewBox="0 0 16 16" aria-hidden="true">
      <circle cx="7" cy="7" r="4.2" />
      <path d="M10.2 10.2L13.5 13.5" />
    </svg>
  );
}

/** Two chevrons, up and down: the account row's shop switcher, which opens a list above it. */
export function SwitchGlyph() {
  return (
    <svg className="ic" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M5 6l3-3 3 3M5 10l3 3 3-3" />
    </svg>
  );
}

/** A chevron pointing on, at the end of a row that opens a page. */
export function OnGlyph() {
  return (
    <svg className="ic" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M6.5 4.5L10 8l-3.5 3.5" />
    </svg>
  );
}

/** The brand mark: a person in profile with the tick cut out, on the mark's light ground. It is 28px in the menu and
 *  46px in Home's lockup, where the canvas draws the tick thinner (20 units of 512 instead of 28) so it keeps its weight. */
export function BrandMark({ size = 28 }: { size?: number }) {
  return (
    <svg className="sb-mark" width={size} height={size} viewBox="0 0 512 512" aria-hidden="true">
      <rect width="512" height="512" fill="#E3E1DB" />
      <path
        fill="#1F2022"
        d="M186 168 C180 196 176 208 170 226 C162 244 146 256 138 270 C134 278 142 284 160 286 C164 292 158 298 158 304 C158 310 168 310 168 314 C168 320 158 322 160 330 C162 338 170 338 170 346 C172 366 178 386 204 392 C222 396 240 392 252 388 C258 410 256 430 246 444 C216 456 150 468 122 512 L512 512 L512 372 C470 366 428 356 404 330 C438 334 462 306 446 280 C478 268 482 222 452 208 C476 184 462 140 428 138 C432 104 392 76 362 92 C342 64 296 62 280 86 C252 70 212 84 208 116 C188 124 180 148 186 168 Z"
      />
      <path fill="none" stroke="#E3E1DB" strokeWidth={size > 28 ? 20 : 28} strokeLinecap="round" strokeLinejoin="round" d="M192 232 L206 246 L232 216" />
    </svg>
  );
}
