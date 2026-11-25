// Settings › Artifacts (item 83): the one switch, Allow publishing public artifact links, off by default and saved on this computer,
// and the three steps. What the switch stops is tested where it stops it (src/runtime/http/artifacts.test.ts, ArtifactsPage.test.tsx).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToString } from "react-dom/server";
import { setLang } from "../i18n";
import { ARTIFACT_DEFAULTS, artifactSettings, parseArtifactSettings, setArtifactSettings } from "../lib/artifactLinks";
import { Toggle } from "../pages/kit";
import { APP_PAGES } from "./pages";
import { ArtifactLinksPage, ArtifactLinksView } from "./ArtifactLinksPage";

const words = (html: string) => html.replace(/<[^>]*>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ");

function fakeStorage(seed: Record<string, string> = {}): Storage {
  const m = new Map(Object.entries(seed));
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k),
    clear: () => m.clear(), key: () => null, length: 0 } as Storage;
}

/** The first element under `node`, through the children each element was given, that `is` picks. */
function find(node: ReactNode, is: (el: ReactElement<Record<string, unknown>>) => boolean): ReactElement<Record<string, unknown>> | null {
  if (Array.isArray(node)) {
    for (const one of node) {
      const got = find(one, is);
      if (got) return got;
    }
    return null;
  }
  if (!isValidElement<Record<string, unknown>>(node)) return null;
  return is(node) ? node : find(node.props.children as ReactNode, is);
}

beforeEach(() => setLang("en"));
afterEach(() => vi.unstubAllGlobals());

describe("Settings › Artifacts", () => {
  it("is an App page after Source control", () => {
    const ids = APP_PAGES.map((p) => p.id);
    expect(ids.indexOf("artifacts")).toBe(ids.indexOf("source") + 1);
  });

  it("is off by default, and says what the switch does and how links work", () => {
    vi.stubGlobal("localStorage", fakeStorage());
    const html = renderToString(<ArtifactLinksPage />);
    expect(html).toMatch(/role="switch"[^>]*aria-checked="false"[^>]*aria-label="Allow publishing public artifact links"/);
    const text = words(html);
    expect(text).toContain("Share HTML and Markdown files with your team and manage their public links.");
    expect(text).toContain("Publish HTML and Markdown files as links anyone with the URL can open. Each one is asked first.");
    for (const step of ["1. Choose a file to share", "2. Copy the public link", "3. Manage it"]) expect(text).toContain(step);
  });

  it("saves the switch on this computer, and reads anything but a saved yes as off", () => {
    vi.stubGlobal("localStorage", fakeStorage());
    expect(artifactSettings()).toEqual(ARTIFACT_DEFAULTS);
    setArtifactSettings({ publish: true });
    expect(artifactSettings().publish).toBe(true);
    expect(renderToString(<ArtifactLinksPage />)).toMatch(/aria-checked="true"/);
    for (const saved of [null, "", "not json", '{"publish":"yes"}', '{"publish":1}', "[true]"]) {
      expect(parseArtifactSettings(saved).publish, String(saved)).toBe(false);
    }
  });

  it("tells its owner the new value when pressed", () => {
    const changes: boolean[] = [];
    const view = ArtifactLinksView({ publish: false, onPublish: (on) => changes.push(on), onOpen: () => {} });
    const toggle = find(view, (el) => el.type === Toggle);
    expect(toggle?.props.testId).toBe("art-set-publish");
    (toggle!.props as { onChange: (on: boolean) => void }).onChange(true);
    expect(changes).toEqual([true]);
  });
});
