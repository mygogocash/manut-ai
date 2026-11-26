// One icon set (docs/design-audit.md, finding 9; the canvas's BrandIcons board): every icon is a drawing of
// src/ui/icons.tsx, a 16px box on a 16-unit grid with a 1.4 line, round ends and corners and no fill. This draws each
// one, holds the drawings to the board's rules, and walks every component under src so that no page draws a line icon
// of its own again. The files that may still draw an `<svg>` are listed with why: none of them is a line icon.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BOARD, DRAWN, ICONS, Icon, type IconName } from "./icons";

const SRC = join(__dirname, "..");

/** The files that draw an svg that is not a line icon of the set, and why. */
const NOT_ICONS: Record<string, string> = {
  "ui/icons.tsx": "the set itself",
  "sidebar/menuIcons.tsx": "the brand mark, in its own two colours",
  "ui/Avatar.tsx": "a team member's face (KitFaces)",
  "ui/AgentIcon.tsx": "a coding agent's mark, or its letter (Under the hood)",
  "ui/ModelIcon.tsx": "a model maker's mark (Under the hood)",
  "ui/brandIcons.tsx": "a service's own logo, where the person connects it",
  "ui/SourceIcon.tsx": "the mark of the app a member's other session is in",
  "harness/HarnessMark.tsx": "a coding agent's mark",
  "tasks/marks.tsx": "GitHub, GitLab and Linear's marks, naming where tasks come from",
  "ui/PrIcon.tsx": "a pull request's state mark, filled as its host draws it",
  "sidebar/Usage.tsx": "a usage meter's ring, a measure rather than a drawing",
  "threads/StatusGlyph.tsx": "a thread's state mark (running arc, done, failed) inside its status chip",
  "sessions/SessionsSection.tsx": "a session row's state marks (running arc, done, failed, needs you) inside its status slot",
  "sessions/SplitView.tsx": "a map of the split's panes, drawn to the layout",
  "runs/RunGraph.tsx": "the run graph: its edges and each box's state, sized by the graph's geometry",
};

const components = (readdirSync(SRC, { recursive: true }) as string[])
  .map((f) => f.split("\\").join("/"))
  .filter((f) => f.endsWith(".tsx") && !f.includes(".test.") && !f.startsWith("../"))
  .sort();

describe("one icon set", () => {
  it("draws every icon in a 16px box on the 16-unit grid, with a 1.4 line, round ends and corners and no fill", () => {
    const html = renderToString(<Icon name="bell" />);
    expect(html).toMatch(/^<svg class="ic" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"/);
    // the line scales with the box: 12px is a 1.05 line, as the board's sizes say
    expect(renderToString(<Icon name="x" size={12} />)).toContain('width="12" height="12" viewBox="0 0 16 16"');
  });

  it("keeps each drawing to the set: no colour, fill or line of its own, inside the grid", () => {
    for (const name of Object.keys(ICONS) as IconName[]) {
      const body = renderToString(<Icon name={name} />).replace(/^<svg[^>]*>|<\/svg>$/g, "");
      expect(body, name).not.toMatch(/fill=|stroke=|stroke-width=|style=|#[0-9a-f]{3}/i);
      for (const [, n] of body.matchAll(/\b(?:cx|cy|x|y)="(-?[\d.]+)"/g)) {
        expect(Number(n), `${name} ${n}`).toBeGreaterThanOrEqual(1.5);
        expect(Number(n), `${name} ${n}`).toBeLessThanOrEqual(14.5);
      }
    }
  });

  it("names a drawing by what it is, and never draws one twice under two names", () => {
    for (const name of Object.keys(ICONS)) expect(name).toMatch(/^[a-z]+(-[a-z0-9]+)*$/);
    expect(Object.keys(BOARD).filter((k) => k in DRAWN)).toEqual([]);
    const seen = new Map<string, string>();
    for (const name of Object.keys(ICONS) as IconName[]) {
      const body = renderToString(<Icon name={name} />);
      expect(seen.get(body), `${name} draws as ${seen.get(body)}`).toBeUndefined();
      seen.set(body, name);
    }
    // the board's 65, word for word, and the app's own beside them
    expect(Object.keys(BOARD)).toHaveLength(65);
  });

  it("leaves no line icon drawn on a page of its own: every other svg is a mark, a face, a meter or a graph", () => {
    const drawing = components.filter((f) => /<svg\b/.test(readFileSync(join(SRC, f), "utf8")));
    expect(drawing.filter((f) => !(f in NOT_ICONS))).toEqual([]);
    // each exception still draws one, so the list never keeps a file that no longer needs it
    for (const f of Object.keys(NOT_ICONS)) expect(drawing, f).toContain(f);
  });
});
