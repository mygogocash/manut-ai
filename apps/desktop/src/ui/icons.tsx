// The brand's one set of line icons (the design canvas's BrandIcons board; KitNavigation draws the side menu with it):
// a 16px box on a 16-unit grid, the drawing inside its middle 11 to 12 units, a 1.4 line with round ends and round
// corners, no fill, and the colour of the text beside it. "One set of line icons on a 16 px grid. An icon shows a thing
// you can see. A word beside it, or a spoken label, says what it does." Every page draws its icons from here (item 85i,
// finding 9 of docs/design-audit.md), named by what each drawing is, not by what it means where it is used.
//
// BOARD holds the board's drawings as it has them. DRAWN holds the ones the app needs and the board does not have,
// drawn on the same grid with the same line, ends and corners, as the board's "New icons" rule says; each is listed in
// docs/design-audit.md for the board to take in or redraw.
import type { ReactNode } from "react";

/** The board's drawings, word for word. */
export const BOARD = {
  "search": <><circle cx="7" cy="7" r="4.2" /><path d="M10.2 10.2L13.5 13.5" /></>,
  "panel-left": <><rect x="2.5" y="3" width="11" height="10" rx="2" /><path d="M6.5 3v10" /></>,
  "plus": <><path d="M8 3v10M3 8h10" /></>,
  "bell": <><path d="M4 11V7a4 4 0 018 0v4l1 1.5H3L4 11zM6.5 13.5a1.5 1.5 0 003 0" /></>,
  "users": <><circle cx="6" cy="6" r="2.2" /><path d="M2 13c.4-2.2 2-3.3 4-3.3s3.6 1.1 4 3.3M11 4.2a2 2 0 010 3.8M12 9.9c1.3.4 2 1.4 2.3 3.1" /></>,
  "code": <><path d="M5.5 4.5L2 8l3.5 3.5M10.5 4.5L14 8l-3.5 3.5" /></>,
  "panels": <><rect x="2.5" y="2.5" width="11" height="11" rx="2" /><path d="M2.5 6.5h11M6.5 6.5v7" /></>,
  "sliders": <><path d="M3 5h6M12 5h1M3 11h1M7 11h6" /><circle cx="10.5" cy="5" r="1.5" /><circle cx="5.5" cy="11" r="1.5" /></>,
  "clock": <><circle cx="8" cy="8" r="5.5" /><path d="M8 5v3l2 1.5" /></>,
  "check": <><path d="M3.5 8.5l3 3 6-7" /></>,
  "rotate-ccw": <><path d="M3 8a5 5 0 1 0 1.6-3.7M3 3v2.6h2.6" /></>,
  "rotate-cw": <><path d="M13 8a5 5 0 11-1.5-3.5M13 3v2.5h-2.5" /></>,
  "arrow-up": <><path d="M8 13V3M4 7l4-4 4 4" /></>,
  "chevron-right": <><path d="M6.5 4.5L10 8l-3.5 3.5" /></>,
  "chevron-down": <><path d="M4.5 6.5L8 10l3.5-3.5" /></>,
  "copy": <><rect x="5.5" y="5.5" width="8" height="8" rx="1.5" /><path d="M3.5 10.5h-1v-8h8v1" /></>,
  "mic": <><rect x="6" y="2.5" width="4" height="7" rx="2" /><path d="M3.5 8a4.5 4.5 0 009 0M8 12.5v1.5" /></>,
  "calendar": <><rect x="2.5" y="3.5" width="11" height="10" rx="2" /><path d="M2.5 7h11M5.5 2v3M10.5 2v3" /></>,
  "info": <><circle cx="8" cy="8" r="5.5" /><path d="M8 7.4v3.4M8 5.1v.2" /></>,
  "stop": <><rect x="4.5" y="4.5" width="7" height="7" rx="1.5" /></>,
  "square-plus": <><rect x="2.5" y="2.5" width="11" height="11" rx="2" /><path d="M8 5.5v5M5.5 8h5" /></>,
  "user-plus": <><circle cx="6.5" cy="6" r="2.2" /><path d="M2.5 13c.4-2.2 2-3.3 4-3.3s3.6 1.1 4 3.3M12.5 4.5v4M10.5 6.5h4" /></>,
  "minus": <><path d="M3 8h10" /></>,
  "x": <><path d="M4 4l8 8M12 4l-8 8" /></>,
  "inbox": <><path d="M2.5 8.5l1.8-4.2a1.5 1.5 0 011.4-.8h4.6a1.5 1.5 0 011.4.8l1.8 4.2v3a2 2 0 01-2 2h-7a2 2 0 01-2-2z" /><path d="M2.5 8.5h3l1 1.5h3l1-1.5h3" /></>,
  "arrow-down-to-line": <><path d="M8 2.5v8M4.5 7.5L8 11l3.5-3.5M3 13.5h10" /></>,
  "arrow-up-from-line": <><path d="M8 11V3M4.5 6.5L8 3l3.5 3.5M3 13.5h10" /></>,
  "funnel": <><path d="M2.5 3.5h11l-4.2 5v4.5l-2.6-1.3V8.5z" /></>,
  "lock": <><rect x="3.5" y="7" width="9" height="6.5" rx="1.5" /><path d="M5.5 7V5a2.5 2.5 0 015 0v2M8 9.6v1.4" /></>,
  "shield": <><path d="M8 2.2l4.8 1.8v3.6c0 3.1-2 5.2-4.8 6.2-2.8-1-4.8-3.1-4.8-6.2V4L8 2.2z" /></>,
  "circle-question": <><circle cx="8" cy="8" r="5.5" /><path d="M6.3 6.5a1.7 1.7 0 1 1 2.9 1.2c-.5.5-1.2.8-1.2 1.6v.3M8 11.4v.2" /></>,
  "box-arrow-out": <><path d="M9 2.5h4.5V7M13.5 2.5L7.5 8.5M11.5 9.5v2a2 2 0 01-2 2h-5a2 2 0 01-2-2v-5a2 2 0 012-2h2" /></>,
  "dots": <><circle cx="3.5" cy="8" r=".6" /><circle cx="8" cy="8" r=".6" /><circle cx="12.5" cy="8" r=".6" /></>,
  "trash": <><path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 7.6a1.5 1.5 0 001.5 1.4h2.8a1.5 1.5 0 001.5-1.4l.6-7.6M6.8 7v4M9.2 7v4" /></>,
  "pencil": <><path d="M10.5 3l2.5 2.5-7 7H3.5V10zM9 4.5l2.5 2.5" /></>,
  "eye": <><path d="M2 8s2.2-4.5 6-4.5S14 8 14 8s-2.2 4.5-6 4.5S2 8 2 8z" /><circle cx="8" cy="8" r="2" /></>,
  "eye-off": <><path d="M2 8s2.2-4.5 6-4.5S14 8 14 8s-2.2 4.5-6 4.5S2 8 2 8z" /><circle cx="8" cy="8" r="2" /><path d="M3 3l10 10" /></>,
  "circle-arrows": <><path d="M3 8a5 5 0 018.5-3.5M13 3v2.5h-2.5M13 8a5 5 0 01-8.5 3.5M3 13v-2.5h2.5" /></>,
  "receipt": <><path d="M4 2.5h8v11l-1.3-1-1.4 1-1.3-1-1.3 1-1.4-1-1.3 1zM6 5.5h4M6 8h4M6 10.5h2" /></>,
  "qr-code": <><rect x="2.5" y="2.5" width="4" height="4" rx="1" /><rect x="9.5" y="2.5" width="4" height="4" rx="1" /><rect x="2.5" y="9.5" width="4" height="4" rx="1" /><path d="M9.5 9.5h2M13.5 9.5v2M9.5 12v1.5M11.5 11.5v2h2" /></>,
  "sparkle": <><path d="M8 2.5c.5 3.2 1.8 4.5 5.5 5.5-3.7 1-5 2.3-5.5 5.5-.5-3.2-1.8-4.5-5.5-5.5 3.7-1 5-2.3 5.5-5.5z" /></>,
  "chevron-left": <><path d="M9.5 4.5L6 8l3.5 3.5" /></>,
  "chevron-up": <><path d="M4.5 9.5L8 6l3.5 3.5" /></>,
  "message": <><path d="M2.5 4.5a2 2 0 012-2h7a2 2 0 012 2V9a2 2 0 01-2 2H7l-3 2.5V11a1.5 1.5 0 01-1.5-1.5z" /></>,
  "file": <><path d="M4 2.5h5l3 3v8H4zM9 2.5v3h3" /></>,
  "file-text": <><path d="M4 2.5h5l3 3v8H4zM9 2.5v3h3M6 8h4M6 10.5h4" /></>,
  "file-plus": <><path d="M4 2.5h5l3 3v8H4zM9 2.5v3h3M8 7.5v4M6 9.5h4" /></>,
  "link": <><path d="M6.5 9.5l3-3M7 4.5l1-1a2.5 2.5 0 013.5 3.5l-1 1M9 11.5l-1 1a2.5 2.5 0 01-3.5-3.5l1-1" /></>,
  "mail": <><rect x="2.5" y="3.5" width="11" height="9" rx="1.5" /><path d="M3 4.5l5 4 5-4" /></>,
  "printer": <><path d="M4.5 6V2.5h7V6M4.5 11.5h-2v-5h11v5h-2" /><rect x="4.5" y="9.5" width="7" height="4" /></>,
  "credit-card": <><rect x="2" y="3.5" width="12" height="9" rx="1.5" /><path d="M2 6.5h12M4.5 10h2.5" /></>,
  "flag": <><path d="M3.5 13.5V2.5M3.5 3h8l-1.5 2.5L11.5 8h-8" /></>,
  "columns": <><rect x="2.5" y="3" width="11" height="10" rx="2" /><path d="M6.2 3v10M9.8 3v10" /></>,
  "banknote": <><rect x="2" y="4" width="12" height="8" rx="1.5" /><circle cx="8" cy="8" r="1.8" /></>,
  "circle-x": <><circle cx="8" cy="8" r="5.5" /><path d="M6 6l4 4M10 6l-4 4" /></>,
  "circle-alert": <><circle cx="8" cy="8" r="5.5" /><path d="M8 5v3.5M8 10.8v.2" /></>,
  "table": <><rect x="2.5" y="3" width="11" height="10" rx="1.5" /><path d="M2.5 6.5h11M2.5 9.75h11M6.5 6.5V13" /></>,
  "log-out": <><path d="M6.5 2.5h-3v11h3M10 5l3 3-3 3M13 8H6.5" /></>,
  "key": <><circle cx="5.5" cy="10.5" r="3" /><path d="M7.6 8.4L13 3M11 5l1.5 1.5" /></>,
  "plug": <><path d="M6 2.5v3M10 2.5v3M4.5 5.5h7v2.5a3.5 3.5 0 01-7 0V5.5zM8 11.5v2" /></>,
  "shield-check": <><path d="M8 2.2l4.8 1.8v3.6c0 3.1-2 5.2-4.8 6.2-2.8-1-4.8-3.1-4.8-6.2V4L8 2.2zM6 8l1.4 1.4L10.2 6.6" /></>,
  "coin": <><path d="M8 2.5a5.5 5.5 0 100 11 5.5 5.5 0 100-11zM8 5a3 3 0 100 6 3 3 0 100-6z" /></>,
  "laptop": <><path d="M3.5 4.5h9v6h-9zM2 12.5h12" /></>,
  "smartphone": <><path d="M5.5 2h5a1 1 0 011 1v10a1 1 0 01-1 1h-5a1 1 0 01-1-1V3a1 1 0 011-1zM7.3 12h1.4" /></>,
  "monitor": <><path d="M2.5 3h11v7.5h-11zM6 13.5h4M8 10.5v3" /></>,
} satisfies Record<string, ReactNode>;

/** Drawn for the app in the set's style, where the board has no such drawing. */
export const DRAWN = {
  "arrow-left": <><path d="M13 8H3M7 4L3 8l4 4" /></>,
  "panel-right": <><rect x="2.5" y="3" width="11" height="10" rx="2" /><path d="M9.5 3v10" /></>,
  "terminal": <><rect x="2.5" y="3" width="11" height="10" rx="2" /><path d="M5 6.5L7 8l-2 1.5M8.5 10H11" /></>,
  "grid": <><rect x="2.5" y="2.5" width="4.5" height="4.5" rx="1" /><rect x="9" y="2.5" width="4.5" height="4.5" rx="1" /><rect x="2.5" y="9" width="4.5" height="4.5" rx="1" /><rect x="9" y="9" width="4.5" height="4.5" rx="1" /></>,
  "gear": <><circle cx="8" cy="8" r="2" /><circle cx="8" cy="8" r="4.3" /><path d="M8 2.5v1.2M8 12.3v1.2M2.5 8h1.2M12.3 8h1.2M4.1 4.1l.9.9M11 11l.9.9M4.1 11.9l.9-.9M11 5l.9-.9" /></>,
  "expand": <><path d="M9.5 2.5h4v4M6.5 13.5h-4v-4M13.5 2.5l-4 4M2.5 13.5l4-4" /></>,
  "shrink": <><path d="M13.5 6.5h-4v-4M2.5 9.5h4v4M9.5 6.5l4-4M6.5 9.5l-4 4" /></>,
  "pin": <><path d="M6 2.5h4M7 2.5v3.8L4.5 8.8h7L9 6.3V2.5M8 8.8v4.7" /></>,
  "bolt": <><path d="M9 2.5L4 9h4l-1 4.5L12 7H8z" /></>,
  "wrench": <><path d="M9.8 4.2a2.7 2.7 0 00-3.6 3.6L2.7 11.3l2 2 3.5-3.5a2.7 2.7 0 003.6-3.6l-1.7 1.7-1.6-.4-.4-1.6z" /></>,
  "database": <><ellipse cx="8" cy="4" rx="4.7" ry="1.7" /><path d="M3.3 4v4c0 .9 2.1 1.7 4.7 1.7s4.7-.8 4.7-1.7V4M3.3 8v4c0 .9 2.1 1.7 4.7 1.7s4.7-.8 4.7-1.7V8" /></>,
  "globe": <><circle cx="8" cy="8" r="5.5" /><path d="M2.5 8h11M8 2.5c1.7 1.7 1.7 9.3 0 11M8 2.5c-1.7 1.7-1.7 9.3 0 11" /></>,
  "chip": <><rect x="4.5" y="4.5" width="7" height="7" rx="1.5" /><path d="M6.5 2.5v2M9.5 2.5v2M6.5 11.5v2M9.5 11.5v2M2.5 6.5h2M2.5 9.5h2M11.5 6.5h2M11.5 9.5h2" /></>,
  "cube": <><path d="M2.5 5L8 2.5 13.5 5v6L8 13.5 2.5 11zM2.5 5L8 7.8 13.5 5M8 7.8v5.7" /></>,
  "folder": <><path d="M2.5 5a1.5 1.5 0 011.5-1.5h2.6l1.4 1.5h4a1.5 1.5 0 011.5 1.5v5A1.5 1.5 0 0112 13H4a1.5 1.5 0 01-1.5-1.5z" /></>,
  "chevrons-up-down": <><path d="M5 6l3-3 3 3M5 10l3 3 3-3" /></>,
  "chevrons-down-up": <><path d="M5 3l3 3 3-3M5 13l3-3 3 3" /></>,
  "git-branch": <><circle cx="4.5" cy="3.8" r="1.3" /><circle cx="4.5" cy="12.2" r="1.3" /><circle cx="11.5" cy="5.5" r="1.3" /><path d="M4.5 5.1v5.8M11.5 6.8c0 2.7-3.3 2.7-7 4.2" /></>,
  "diff": <><path d="M5.5 2.5v5M3 5h5M3 12h5M10 4h3.5M10 12h3.5M10 8h3.5" /></>,
  "camera": <><path d="M2.5 5.2h2.2l1.1-1.7h4.4l1.1 1.7h2.2v7.3h-11z" /><circle cx="8" cy="8.7" r="2.3" /></>,
  "hard-drive": <><rect x="2.5" y="3.5" width="11" height="9" rx="2" /><path d="M5 9.5h3M10.8 9.5v.2" /></>,
  "columns-2": <><rect x="2.5" y="3" width="11" height="10" rx="2" /><path d="M8 3v10" /></>,
  "message-plus": <><path d="M2.5 4.5a2 2 0 012-2h7a2 2 0 012 2V9a2 2 0 01-2 2H7l-3 2.5V11a1.5 1.5 0 01-1.5-1.5z" /><path d="M8 4.8v4M6 6.8h4" /></>,
  "list": <><path d="M6 4h7M6 8h7M6 12h7M3 4v.2M3 8v.2M3 12v.2" /></>,
  "paperclip": <><path d="M13 7.7L8.3 12.6a3.2 3.2 0 01-4.6-4.6l4.9-4.9a2.1 2.1 0 013 3L6.7 11a1.1 1.1 0 01-1.6-1.6l4.5-4.5" /></>,
  "audio-lines": <><path d="M3 6.5v3M5.5 4.5v7M8 2.5v11M10.5 4.5v7M13 6.5v3" /></>,
  "reply": <><path d="M6 9.5L2.5 6 6 2.5M2.5 6h7a4 4 0 010 8H7.5" /></>,
  "home": <><path d="M2.5 7L8 2.5 13.5 7v5.5a1 1 0 01-1 1h-3v-4h-3v4h-3a1 1 0 01-1-1z" /></>,
  "pause": <><path d="M6 4v8M10 4v8" /></>,
  "nodes": <><rect x="2" y="6.5" width="3.5" height="3.5" rx="1" /><rect x="10.5" y="2.5" width="3.5" height="3.5" rx="1" /><rect x="10.5" y="10" width="3.5" height="3.5" rx="1" /><path d="M5.5 8.2c3 0 3-4 5-4M5.5 8.2c3 0 3 4 5 4" /></>,
  // item 122: drawn for menu entries that had words only (an icon shows a thing you can see)
  "at-sign": <><circle cx="8" cy="8" r="2.2" /><path d="M10.2 5.8v3a1.65 1.65 0 0 0 3.3 0V8a5.5 5.5 0 1 0-2.2 4.4" /></>,
  "square-slash": <><rect x="2.5" y="2.5" width="11" height="11" rx="2" /><path d="M9.5 5.5l-3 5" /></>,
  "archive": <><rect x="2.5" y="3" width="11" height="3" rx="1" /><path d="M3.5 6v6a1.5 1.5 0 001.5 1.5h6a1.5 1.5 0 001.5-1.5V6M6.5 8.5h3" /></>,
  "pin-off": <><path d="M6 2.5h4M7 2.5v3.8L4.5 8.8h7L9 6.3V2.5M8 8.8v4.7M3 3l10 10" /></>,
  "folder-plus": <><path d="M2.5 5a1.5 1.5 0 011.5-1.5h2.6l1.4 1.5h4a1.5 1.5 0 011.5 1.5v5A1.5 1.5 0 0112 13H4a1.5 1.5 0 01-1.5-1.5z" /><path d="M8 7.3v3.4M6.3 9h3.4" /></>,
  "clipboard": <><rect x="3.5" y="3" width="9" height="10.5" rx="1.5" /><path d="M6 3V2.5h4V3M6 7h4M6 9.5h4" /></>,
  "text-select": <><path d="M3 4.5h10M3 8h10M3 11.5h6" /></>,
  "user": <><circle cx="8" cy="5.8" r="2.4" /><path d="M3.5 13.5c.4-2.6 2.2-4 4.5-4s4.1 1.4 4.5 4" /></>,
  "git-pull-request": <><circle cx="4.5" cy="3.8" r="1.3" /><circle cx="4.5" cy="12.2" r="1.3" /><circle cx="11.5" cy="12.2" r="1.3" /><path d="M4.5 5.1v5.8M11.5 10.9V6.5A1.5 1.5 0 0010 5H7.5M9 3.5L7.5 5 9 6.5" /></>,
  "rows-2": <><rect x="2.5" y="3" width="11" height="10" rx="2" /><path d="M2.5 8h11" /></>,
  "eraser": <><path d="M9.3 3.2l3.5 3.5-6.1 6.1H3.9L2.7 11.6a1.4 1.4 0 010-2zM6.2 6.3l3.5 3.5M7 12.8h6" /></>,
} satisfies Record<string, ReactNode>;

export const ICONS = { ...BOARD, ...DRAWN };
export type IconName = keyof typeof ICONS;

/** One icon of the set. 16px is the board's size everywhere; 12 (a 1.05 line) is for a simple shape inside a tag or
 *  beside 12px text, and 20 (a 1.75 line) for an icon alone in a large tile. The line scales with the box, since the
 *  drawing is on the 16-unit grid whatever its size. */
export function Icon({ name, size = 16, className }: { name: IconName; size?: number; className?: string }) {
  return (
    <svg
      className={className ? `ic ${className}` : "ic"}
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.4}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {ICONS[name]}
    </svg>
  );
}

// The names the app's code already uses, each now the set's drawing. `size` stays for the few places that still pass
// one (see Icon for the sizes the board allows).
type Sized = { size?: number };
export const PlusIcon = ({ size }: Sized) => <Icon name="plus" size={size} />;
export const SearchIcon = ({ size }: Sized) => <Icon name="search" size={size} />;
export const CalendarIcon = ({ size }: Sized) => <Icon name="calendar" size={size} />;
export const GridIcon = ({ size }: Sized) => <Icon name="grid" size={size} />;
export const GearIcon = ({ size }: Sized) => <Icon name="gear" size={size} />;
export const ChevronDown = ({ size }: Sized) => <Icon name="chevron-down" size={size} />;
export const ChevronRight = ({ size }: Sized) => <Icon name="chevron-right" size={size} />;
/** A page's back arrow (top left of Settings, Automations and Plugins). */
export const ArrowLeft = ({ size }: Sized) => <Icon name="arrow-left" size={size} />;
export const ArrowUp = ({ size }: Sized) => <Icon name="arrow-up" size={size} />;
export const StopIcon = ({ size }: Sized) => <Icon name="stop" size={size} />;
export const CloseIcon = ({ size }: Sized) => <Icon name="x" size={size} />;
/** A terminal window with a prompt: the session header's "Open in Terminal". */
export const TerminalIcon = ({ size }: Sized) => <Icon name="terminal" size={size} />;
/** A speech bubble: back to the chat from the terminal view. */
export const ChatIcon = ({ size }: Sized) => <Icon name="message" size={size} />;
/** A window with a column on its right: the header's button for the right-hand panel. */
export const PanelIcon = ({ size }: Sized) => <Icon name="panel-right" size={size} />;
/** Two corners pulling apart: open something at full size (the plan's full view). */
export const ExpandIcon = ({ size }: Sized) => <Icon name="expand" size={size} />;
