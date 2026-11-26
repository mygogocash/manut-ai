// Settings as one quiet column (item 85h): the everyday pages first and the developer pages under one "Under the hood"
// entry, which a link to one of its pages opens; one segmented switch for Settings and Home; and the stylesheets held
// to the canvas's scale and rhythm (docs/design-audit.md, findings 4, 10, 13, 19 and 20). How the column looks and
// collapses at 900 wide is in e2e/settings-column.spec.ts.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { renderToString } from "react-dom/server";
import { setLang } from "../i18n";
import { parseCss, type CssRule } from "../theme/cssRules";
import { Modes } from "../ui/Modes";
import { APP_PAGES, EVERYDAY_PAGES, HOOD_PAGES, inHood } from "./pages";

const SRC = join(__dirname, "..");
const read = (f: string) => readFileSync(join(SRC, f), "utf8");

function fakeStorage(seed: Record<string, string> = {}): Storage {
  const m = new Map(Object.entries(seed));
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k),
    clear: () => m.clear(), key: () => null, length: 0 } as Storage;
}

const noop = () => {};

describe("Settings' pages", () => {
  it("lists the everyday pages first and the developer pages under the hood, every id kept", () => {
    expect(EVERYDAY_PAGES.map((p) => p.id)).toEqual(["general", "voice", "remote"]);
    expect(HOOD_PAGES.map((p) => p.id)).toEqual(["terminal", "providers", "computer", "worktrees", "source", "artifacts", "mcp", "workflows", "developer"]);
    // the palette's order and every page's id are what they were
    expect(APP_PAGES.map((p) => p.id)).toEqual(["general", "voice", "remote", "terminal", "providers", "computer", "worktrees", "source", "artifacts", "mcp", "workflows", "developer"]);
    expect(inHood("terminal")).toBe(true);
    expect(inHood("general")).toBe(false);
    expect(inHood("bot:kami")).toBe(false);
  });
});

describe("Settings' list", () => {
  // Settings loads every one of its pages' modules, which takes a few seconds on a cold run.
  let Settings: (p: { page: string; onClose: () => void }) => ReactElement;
  beforeAll(async () => {
    setLang("en");
    const { getStore } = await import("../state/store");
    Settings = (await import("./Settings.slot")).default as typeof Settings;
    await getStore().actions.init();
  }, 30_000);
  beforeEach(() => setLang("en"));
  afterEach(() => vi.unstubAllGlobals());

  const nav = (html: string) => html.slice(html.indexOf("<nav"), html.indexOf("</nav>"));
  const at = (html: string, testId: string) => html.indexOf(`data-testid="${testId}"`);

  it("starts with the hood closed: the everyday pages and the team first, then one entry for the developer pages", () => {
    vi.stubGlobal("localStorage", fakeStorage());
    const list = nav(renderToString(<Settings page="general" onClose={noop} />));
    expect(list).toMatch(/aria-expanded="false"[^>]*data-testid="settings-hood"[^>]*><span class="st-nav-i" aria-hidden="true"><svg[^]*?<\/svg><\/span><span class="st-nav-n">Under the hood</);
    for (const p of HOOD_PAGES) expect(list).not.toContain(`settings-nav-${p.id}"`);
    expect(at(list, "settings-nav-general")).toBeLessThan(at(list, "settings-nav-voice"));
    expect(at(list, "settings-nav-voice")).toBeLessThan(at(list, "settings-nav-bots"));
    expect(at(list, "settings-nav-bots")).toBeLessThan(at(list, "settings-hood"));
    expect(list).toMatch(/data-testid="settings-nav-general"[^>]*>.*?<span class="st-nav-n">General</);
    // the group names are words in sentence case; the stylesheet draws them as bands
    expect(list).toContain('<div class="st-sh">Team members</div>');
  });

  it("leads every entry of the list with an icon of the set, hidden from a screen reader, before its words (item 122)", () => {
    vi.stubGlobal("localStorage", fakeStorage({ "manut.settings.hood": "1" }));
    const list = nav(renderToString(<Settings page="general" onClose={noop} />));
    const entries = [...list.matchAll(/<button[^>]*data-testid="(settings-nav-[a-z]+|settings-hood)"[^>]*>([^]*?)<\/button>/g)];
    const ids = entries.map((m) => m[1]);
    expect(ids).toEqual(["settings-nav-general", "settings-nav-voice", "settings-nav-remote", "settings-nav-bots", "settings-nav-people", "settings-hood", ...HOOD_PAGES.map((p) => `settings-nav-${p.id}`)]);
    for (const [, id, inner] of entries) expect(inner, id).toMatch(/^<span class="st-nav-i" aria-hidden="true"><svg class="ic" width="16" height="16"/);
    // every page's icon is its own
    const icons = [...EVERYDAY_PAGES, ...HOOD_PAGES].map((p) => p.icon);
    expect(new Set(icons).size).toBe(icons.length);
  });

  it("opens the hood by itself when a link names one of its pages, with that page chosen", () => {
    vi.stubGlobal("localStorage", fakeStorage());
    for (const id of ["terminal", "workflows", "developer"]) {
      const html = renderToString(<Settings page={id} onClose={noop} />);
      expect(nav(html), id).toMatch(/aria-expanded="true"[^>]*data-testid="settings-hood"/);
      expect(nav(html), id).toMatch(new RegExp(`class="on" aria-current="page" data-testid="settings-nav-${id}"`));
      expect(html, id).toContain(`data-testid="settings-page-${id}"`);
    }
    // the ids of the two pages Providers replaced still land on it, inside the hood
    const html = renderToString(<Settings page="accounts" onClose={noop} />);
    expect(nav(html)).toMatch(/class="on" aria-current="page" data-testid="settings-nav-providers"/);
    expect(html).toContain('data-testid="settings-page-providers"');
  });

  it("keeps the hood open where it was left open, and reads storage it cannot read as closed", () => {
    vi.stubGlobal("localStorage", fakeStorage({ "manut.settings.hood": "1" }));
    let list = nav(renderToString(<Settings page="general" onClose={noop} />));
    expect(list).toMatch(/aria-expanded="true"[^>]*data-testid="settings-hood"/);
    for (const p of HOOD_PAGES) expect(list).toContain(`data-testid="settings-nav-${p.id}"`);
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("blocked");
      },
    });
    list = nav(renderToString(<Settings page="general" onClose={noop} />));
    expect(list).toMatch(/aria-expanded="false"[^>]*data-testid="settings-hood"/);
  });
});

describe("the one segmented switch", () => {
  it("draws Settings' choices as Home's pill: radios in a group, the chosen one checked", () => {
    const html = renderToString(
      <Modes label="Theme" value="dark" options={[{ value: "system", label: "System" }, { value: "dark", label: "Dark" }]} onChange={noop} testId="theme-seg" />,
    );
    expect(html).toContain('class="ui-modes" role="radiogroup" aria-label="Theme" data-testid="theme-seg"');
    expect(html).toContain('role="radio" aria-checked="false" class="ui-mode">System<');
    expect(html).toContain('role="radio" aria-checked="true" class="ui-mode">Dark<');
  });

  it("is the only one Settings and Home use: no page of Settings imports the old one, and Home draws the same classes", () => {
    for (const f of ["settings/Settings.slot.tsx", "settings/Appearance.tsx", "settings/VoicePage.tsx", "settings/DeveloperPage.tsx", "settings/terminal/TerminalPage.tsx"]) {
      expect(read(f), f).not.toMatch(/chat\/model\/Seg|<Seg\b/);
    }
    expect(read("pages/HomePage.tsx")).toContain('className="ui-modes"');
    expect(read("pages/HomePage.tsx")).toContain('className="ui-mode"');
    expect(read("pages/home.css")).not.toMatch(/\.mode\b|\.modes\b/);
    const ui = parseCss(read("ui/ui.css")).rules;
    const decl = (sel: string, prop: string) => ui.find((r) => r.selector === sel)?.decls.find((d) => d.prop === prop)?.value;
    expect(decl(".ui-mode", "min-height")).toBe("28px");
    expect(decl(".ui-mode", "font-size")).toBe("13px");
    expect(decl(".ui-mode", "border-radius")).toBe("var(--rad-pill)");
    expect(decl(".ui-modes", "border-radius")).toBe("var(--rad-pill)");
  });
});

describe("Settings' stylesheets", () => {
  const SHEETS = ["settings/settings.css", "settings/accounts/accounts.css", "settings/agents/agents.css", "settings/providers/providers.css",
    "settings/terminal/terminal.css", "workflows/workflows.css"];
  const rules: [string, CssRule][] = SHEETS.flatMap((f) => parseCss(read(f)).rules.map((r) => [f, r] as [string, CssRule]));
  const settings = parseCss(read("settings/settings.css")).rules;
  const decl = (sel: string, prop: string, at: string[] = []) =>
    settings.find((r) => r.selector === sel && r.at.join() === at.join())?.decls.find((d) => d.prop === prop)?.value;

  it("sets no text under the scale's 12px, no capitals and no letter-spacing on words", () => {
    for (const [f, r] of rules) {
      for (const d of r.decls) {
        const where = `${f} ${r.selector} ${d.prop}: ${d.value}`;
        if (d.prop === "font-size") {
          const px = /^([\d.]+)px/.exec(d.value);
          if (px) expect(Number(px[1]), where).toBeGreaterThanOrEqual(12);
        }
        expect(d.prop === "text-transform" && d.value === "uppercase", where).toBe(false);
        // the six-digit code box spaces its digits as cells, which is what it is for; no label is spaced
        if (d.prop === "letter-spacing") expect(r.selector, where).toBe(".dev-code");
      }
    }
  });

  it("draws a group's name as a grey band in sentence case, weight 600", () => {
    expect(decl(".st-sh, .st-gh", "background")).toBe("var(--aui-subtle)");
    expect(decl(".st-sh, .st-gh", "font-weight")).toBe("600");
    expect(decl(".st-sh, .st-gh", "font-size")).toBe("13px");
    expect(decl(".st-sh, .st-gh", "min-height")).toBe("32px");
  });

  it("keeps the rhythm: rows 44, buttons 34, fields 40, text 696 at most, body 14, 24 between groups", () => {
    expect(decl(".st-row", "min-height")).toBe("44px");
    expect(decl(".st-btn", "min-height")).toBe("34px");
    for (const field of [".dev-in", ".bots-q", ".vc-select", ".be-name-edit input"]) expect(decl(field, "min-height"), field).toBe("40px");
    expect(decl(".st-page", "max-width")).toBe("696px");
    expect(decl(".st-page.st-wide", "max-width")).toBe("696px");
    expect(decl(".st", "font-size")).toBe("14px");
    expect(decl(".st-k b", "font-size")).toBe("14px");
    expect(decl(".st-gh", "margin")).toBe("24px 0 8px");
    // a group is held together by its band and space, not a box
    expect(decl(".st-grp", "border")).toBeUndefined();
  });

  it("gives the Appearance preview's chip the colour that sits on the accent, so dark is not white on near-white", () => {
    expect(decl(".ap-pv-chip", "color")).toBe("var(--on-accent)");
    expect(read("settings/settings.css")).not.toMatch(/\.ap-pv-chip \{[^}]*#fff/);
  });

  it("moves only by name: the hood's chevron turns with the Switch move, a page's content comes in with the Rise", () => {
    expect(decl(".st-hood-ic", "transition")).toBe("transform var(--tr-switch)");
    expect(decl(".st-hood[aria-expanded=\"true\"] .st-hood-ic", "transform")).toBe("rotate(180deg)");
    expect(decl(".st-body > *", "animation")).toBe("var(--anim-rise)");
    expect(decl(".st-body > *", "--rise-by")).toBe("var(--arrive-by)");
  });

  it("stacks the list above the page when the main column is under the side menu's 196 and a page's 560", () => {
    const narrow = ["@container settings (max-width: 755px)"];
    expect(decl(".settings-body", "container")).toBe("settings / inline-size");
    expect(decl(".st", "grid-template-columns")).toBe("196px minmax(0, 1fr)");
    expect(decl(".st", "grid-template-columns", narrow)).toBe("minmax(0, 1fr)");
    expect(decl(".st-nav", "flex-wrap", narrow)).toBe("wrap");
    expect(decl(".st-hood-list", "display", narrow)).toBe("contents");
  });
});
