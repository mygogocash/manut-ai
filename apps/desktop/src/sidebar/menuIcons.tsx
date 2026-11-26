// The side menu's drawings, from the brand's one set (src/ui/icons.tsx, the canvas's BrandIcons board): 16px stroke icons
// on a 16-unit grid, drawn with the canvas's `.ic` look, and the brand mark at 28px in the mark's own two colours, the
// only literal colours the canvas allows besides the pastel avatar fills.
import { Icon, type IconName } from "../ui/icons";
import type { MenuRow } from "./menu";

/** Each row's drawing, named by what it is (the board's rule): a bell for Needs you, panels for Artifacts. */
const ROW_ICON: Record<MenuRow, IconName> = {
  new: "plus",
  needs: "bell",
  team: "users",
  code: "code",
  artifacts: "panels",
  customize: "sliders",
  history: "clock",
};

/** A menu row's icon; the pages' empty states use the same drawing as their row. */
export function MenuIcon({ row }: { row: MenuRow }) {
  return <Icon name={ROW_ICON[row]} />;
}

/** The magnifier of the menu's Search button and History's search box. */
export function SearchGlyph() {
  return <Icon name="search" />;
}

/** Two chevrons, up and down: the account row's shop switcher, which opens a list above it. */
export function SwitchGlyph() {
  return <Icon name="chevrons-up-down" />;
}

/** A chevron pointing on, at the end of a row that opens a page. */
export function OnGlyph() {
  return <Icon name="chevron-right" />;
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
