// The first screen, drawn once on the in-process runtime: the claim of this fork in one test. The app's own store
// starts on the runtime `createRuntime()` picks (no bridge, no Hermes, no other process), and the first screen shows
// Manut AI's name and the team, with none of the old product's words left on it.
import { describe, expect, it } from "vitest";
import { renderToString } from "react-dom/server";
import { Sidebar } from "../sidebar/Sidebar";
import { Chat } from "../chat/Chat";
import { getStore } from "../state/store";
import { setLang } from "../i18n";
import { runtimeKind } from "../runtime";

/** The text a person would read: tags and attribute values removed, entities left as they are. */
const words = (html: string) => html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ");

describe("the app on its default runtime", () => {
  it("starts with no bridge and draws the sidebar, the team and Buddy's chat", async () => {
    expect(runtimeKind()).toBe("mock");
    setLang("en");
    const store = getStore();
    await store.actions.init();
    const s = store.getState();
    expect(s.conn).toBe("open");
    expect(s.lastError).toBeNull();

    // the two columns a person sees first (the window frame around them measures the real window, so it is not drawn here)
    const html = renderToString(
      <>
        <Sidebar />
        <Chat />
      </>,
    );
    const text = words(html);
    expect(html).toContain('data-testid="sidebar"');
    expect(text).toContain("Manut AI");
    for (const name of ["Buddy", "Nam", "Pim", "Ton", "Kit"]) expect(text, name).toContain(name);
    // Buddy's staged greeting is the open chat
    expect(text).toContain("demo runtime");
    expect(html).toContain('data-testid="composer"');

    // what the runtime does not have is not offered
    for (const id of ["nav-automations", "nav-plugins", "places"]) expect(html, id).not.toContain(`data-testid="${id}"`);
    expect(html).not.toContain('class="me-btn"'); // the Accounts row
    expect(html).toContain('data-testid="nav-settings"');

    // none of the old product's names reach the screen, in words or in tooltips
    expect(html).not.toMatch(/omher|oh-my-hermes|Oh My Hermes|Hermes/);
  });
});
