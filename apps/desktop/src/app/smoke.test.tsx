// The first screen, drawn once on the in-process runtime: the claim of this fork in one test. The app's own store
// starts on the runtime `createRuntime()` picks (no bridge, no Hermes, no other process). A first run opens on the
// first-run setup's Welcome; once it is skipped the app shows Manut AI's side menu and Home, Buddy's chat is a press
// away, the Team page shows the team, and none of the old product's words are left. The test node has no storage, as a
// fresh install has nothing saved, so the first screen is the same on every run.
import { describe, expect, it } from "vitest";
import { renderToString } from "react-dom/server";
import { App } from "./App";
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
  it("starts with no bridge on the setup's Welcome, then, once it is skipped, draws the side menu and Home, Buddy's chat and the team", async () => {
    expect(runtimeKind()).toBe("mock");
    setLang("en");
    const store = getStore();
    await store.actions.init();
    const s = store.getState();
    expect(s.conn).toBe("open");
    expect(s.lastError).toBeNull();
    // A first run fills the window with the setup's Welcome, and Home waits behind it.
    expect(s.ui.firstRun?.screen).toBe("welcome");
    expect(s.ui.view).toBe("home");
    const first = renderToString(<App />);
    expect(first).toContain('data-testid="first-run"');
    expect(words(first)).toContain("Continue on this computer");
    expect(first).not.toContain('data-testid="sidebar"');
    // Skip for now on the setup's first step lands on Home, which is what the rest of this test draws.
    store.actions.firstRunDo({ type: "next" });
    store.actions.firstRunEnd();
    expect(store.getState().ui).toMatchObject({ firstRun: null, view: "home" });

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
    expect(html).toMatch(/data-testid="home-mode-now"[^>]*>Team</);

    // Buddy's greeting is in Buddy's chat, a press away: it says Buddy answers through the person's own coding agent, which
    // the chat's model line names (the stand-in Claude Code of a page outside the app here)
    await store.actions.selectBot("buddy");
    const chat = renderToString(<Chat />);
    expect(words(chat)).toContain("I answer through a coding agent you already have on this computer");
    expect(words(chat)).toContain("Claude Code");
    expect(words(chat)).not.toMatch(/sample answer|demo runtime/);
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
    expect(first + html + chat + team + customize).not.toMatch(/omher|oh-my-hermes|Oh My Hermes|Hermes/);
  });
});
