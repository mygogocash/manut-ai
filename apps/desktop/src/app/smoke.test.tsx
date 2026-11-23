// The first screen, drawn once on the in-process runtime: the claim of this fork in one test. The app's own store
// starts on the runtime `createRuntime()` picks (no bridge, no Hermes, no other process), and the first screen shows
// Manut AI's side menu and Home, Buddy's chat is a press away, the Team page shows the team, and none of the old
// product's words are left.
import { describe, expect, it } from "vitest";
import { renderToString } from "react-dom/server";
import { Sidebar } from "../sidebar/Sidebar";
import { Chat } from "../chat/Chat";
import { HomePage } from "../pages/HomePage";
import { TeamPage } from "../pages/TeamPage";
import { CustomizePage } from "../pages/CustomizePage";
import { getStore } from "../state/store";
import { setLang } from "../i18n";
import { runtimeKind } from "../runtime";

/** The text a person would read: tags and attribute values removed, entities left as they are. */
const words = (html: string) => html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ");

describe("the app on its default runtime", () => {
  it("starts with no bridge and draws the side menu and Home, then Buddy's chat and, on its page, the team", async () => {
    expect(runtimeKind()).toBe("mock");
    setLang("en");
    const store = getStore();
    await store.actions.init();
    const s = store.getState();
    expect(s.conn).toBe("open");
    expect(s.lastError).toBeNull();
    expect(s.ui.view).toBe("home");

    // the two columns a person sees first (the window frame around them measures the real window, so it is not drawn here)
    const html = renderToString(
      <>
        <Sidebar />
        <HomePage />
      </>,
    );
    const text = words(html);
    expect(html).toContain('data-testid="sidebar"');
    expect(html).toContain('aria-label="Manut AI home"');
    // The design canvas's menu, top to bottom. Home is open, and New marks it.
    expect(text).toContain("New Needs you Team Code Artifacts Customize History");
    expect(html).toMatch(/class="nav new" aria-current="page"[^>]*data-testid="menu-new"/);
    expect(html.split('aria-current="page"').length - 1).toBe(1);
    // Nothing waits on the person yet, so Needs you has no count, and nobody is working.
    expect(html).not.toContain('class="cnt"');
    expect(text).toContain("Nothing needs you yet");
    expect(text).toContain("Nothing is running right now.");
    // Home's ask box, on the canvas's first mode, with all three modes: the demo team has Kit for Code
    expect(html).toContain('data-testid="page-home"');
    expect(html).toMatch(/aria-pressed="true"[^>]*data-testid="home-mode-team"/);
    for (const m of ["chat", "team", "code"]) expect(html, m).toContain(`data-testid="home-mode-${m}"`);

    // Buddy's staged greeting is in Buddy's chat, a press away
    await store.actions.selectBot("buddy");
    const chat = renderToString(<Chat />);
    expect(words(chat)).toContain("demo runtime");
    expect(chat).toContain('data-testid="composer"');

    // The whole team is on the Team page.
    const team = renderToString(<TeamPage />);
    for (const name of ["Buddy", "Nam", "Pim", "Ton", "Kit"]) expect(words(team), name).toContain(name);

    // What the runtime does not have is not offered, in the menu, on Home or on Customize.
    const customize = renderToString(<CustomizePage />);
    for (const id of ["nav-automations", "nav-plugins", "places", "home-automations"]) expect(html + customize, id).not.toContain(`data-testid="${id}"`);
    expect(html).not.toContain('class="me-btn"'); // the old Accounts row
    expect(html).toContain('data-testid="nav-settings"');

    // none of the old product's names reach the screen, in words or in tooltips
    expect(html + chat + team + customize).not.toMatch(/omher|oh-my-hermes|Oh My Hermes|Hermes/);
  });
});
