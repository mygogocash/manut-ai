// Where the undo toasts of a closed terminal (sessions/CloseToasts.tsx) are mounted. ⌘W on the terminal in view closes
// its session, and the toast with Undo (and the ⌘Z behind it) has to be there for that: the close happens on the
// session page, where the Code page's list is not drawn. Before, the toasts hung on the list's header, so a terminal
// closed from its own page stopped after the undo window with nothing on screen to bring it back.
//
// The toast itself is drawn into document.body, which this node test has none of, so the host is replaced by a marker
// and the test counts where the app mounts it.
import { describe, expect, it, vi } from "vitest";
import { renderToString } from "react-dom/server";

vi.mock("../sessions/CloseToasts", async () => {
  const { createElement } = await import("react");
  return { CloseToasts: () => createElement("i", { "data-testid": "close-toasts-host" }) };
});

// the panel's resize handle measures the real window while it draws (smoke.test.tsx leaves the frame out for that too)
vi.mock("./PanelResizer", () => ({ PanelResizer: () => null }));

import { App } from "./App";
import { SessionsHeader } from "../sessions/SessionsSection";
import { getStore } from "../state/store";
import { setLang } from "../i18n";

const hosts = (html: string) => html.split('data-testid="close-toasts-host"').length - 1;

describe("the undo toasts' host", () => {
  it("is mounted once by the app on every page and with a terminal in view", async () => {
    setLang("en");
    const store = getStore();
    await store.actions.init();
    store.actions.firstRunDo({ type: "next" });
    store.actions.firstRunEnd();
    const views: [string, () => void][] = [
      ["Home", () => store.actions.openPage("home")],
      ["Code, where the sessions are listed", () => store.actions.openPage("code")],
      ["Team", () => store.actions.openPage("team")],
      ["a terminal in view", () => store.actions.openSession("s1")],
    ];
    for (const [name, open] of views) {
      open();
      expect(hosts(renderToString(<App />)), name).toBe(1);
    }
  });

  it("is not also mounted by the Code page's list header, which would show each toast twice", () => {
    expect(hosts(renderToString(<SessionsHeader />))).toBe(0);
  });
});
