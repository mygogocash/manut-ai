// Settings' App pages come from one list (item 128): each entry in pages.ts names the component that draws it, so
// adding a page is one entry there and Settings.slot.tsx draws it with no line of its own. settingsColumn.test.tsx
// pins the ids, their order and their icons; this holds the list's other promises.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { FunctionComponent, ReactElement } from "react";
import { describe, expect, it } from "vitest";
import { hoodIds } from "../../e2e/hoodIds";
import { APP_PAGES, HOOD_PAGES, PAGES, type PageViewProps } from "./pages";
import { ProvidersPage } from "./providers/ProvidersPage";

describe("Settings' list of App pages", () => {
  it("names a component for every page but General, which Settings.slot.tsx draws itself", () => {
    expect(PAGES.filter((p) => !p.view).map((p) => p.id)).toEqual(["general"]);
    expect(new Set(PAGES.map((p) => p.id)).size).toBe(PAGES.length);
    expect(APP_PAGES).toHaveLength(PAGES.length);
  });

  it("leaves Settings.slot.tsx no App page of its own to import or branch on", () => {
    const slot = readFileSync(join(__dirname, "Settings.slot.tsx"), "utf8");
    for (const p of PAGES) {
      if (p.view) expect(slot, p.id).not.toContain(p.view.name);
      expect(slot, p.id).not.toContain(`current === "${p.id}"`);
    }
    expect(slot).not.toMatch(/import \{[^}]*\b(TerminalPage|ProvidersPage|VoicePage|RemotePage|ReportPage|WorkflowsPage)\b/);
  });

  it("opens Providers at its accounts when asked for `accounts`, as Settings.slot.tsx did before the list", () => {
    const view = PAGES.find((p) => p.id === "providers")?.view as FunctionComponent<PageViewProps>;
    const at = (page: string) => (view({ page }) as ReactElement<{ focus?: string }>);
    expect(at("accounts").type).toBe(ProvidersPage);
    expect(at("accounts").props.focus).toBe("accounts");
    expect(at("providers").props.focus).toBeUndefined();
  });

  it("is read by the Playwright helpers as it is: the hood's ids, in order", () => {
    expect(hoodIds(readFileSync(join(__dirname, "pages.ts"), "utf8"))).toEqual(HOOD_PAGES.map((p) => p.id));
  });
});
