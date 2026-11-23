// The first screen, drawn once on the in-process runtime: the claim of this fork in one test. The app's own store
// starts on the runtime `createRuntime()` picks (no bridge, no Hermes, no other process), and the first screen shows
// Manut AI's side menu and Buddy's chat, the Team page shows the team, and none of the old product's words are left.
import { describe, expect, it } from "vitest";
import { renderToString } from "react-dom/server";
import { Sidebar } from "../sidebar/Sidebar";
import { Chat } from "../chat/Chat";
import { TeamPage } from "../pages/TeamPage";
import { CustomizePage } from "../pages/CustomizePage";
import { getStore } from "../state/store";
import { setLang } from "../i18n";
import { runtimeKind } from "../runtime";

/** The text a person would read: tags and attribute values removed, entities left as they are. */
const words = (html: string) => html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ");

describe("the app on its default runtime", () => {
  it("starts with no bridge and draws the side menu, Buddy's chat and, on its page, the team", async () => {
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
    expect(html).toContain('aria-label="Manut AI home"');
    // The design canvas's menu, top to bottom. Buddy's main chat is open, and it stands in for Home, which New marks.
    expect(text).toContain("New Needs you Team Code Artifacts Customize History");
    expect(html).toMatch(/class="nav new" aria-current="page"[^>]*data-testid="menu-new"/);
    expect(html.split('aria-current="page"').length - 1).toBe(1);
    // Nothing waits on the person yet, so Needs you has no count.
    expect(html).not.toContain('class="cnt"');
    // Buddy's staged greeting is the open chat
    expect(text).toContain("demo runtime");
    expect(html).toContain('data-testid="composer"');

    // The whole team is on the Team page.
    const team = renderToString(<TeamPage />);
    for (const name of ["Buddy", "Nam", "Pim", "Ton", "Kit"]) expect(words(team), name).toContain(name);

    // What the runtime does not have is not offered, in the menu or on Customize.
    const customize = renderToString(<CustomizePage />);
    for (const id of ["nav-automations", "nav-plugins", "places"]) expect(html + customize, id).not.toContain(`data-testid="${id}"`);
    expect(html).not.toContain('class="me-btn"'); // the old Accounts row
    expect(html).toContain('data-testid="nav-settings"');

    // none of the old product's names reach the screen, in words or in tooltips
    expect(html + team + customize).not.toMatch(/omher|oh-my-hermes|Oh My Hermes|Hermes/);
  });
});
