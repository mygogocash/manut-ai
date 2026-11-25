// A shop the person only helps at, drawn with react-dom/server on the app's own store (docs/runtime-adapter.md, "A shop the person
// helps at"): the account row marks it, and each page that is the owner's (the team and Pause everyone, past work, the activity
// log, the routines, who is working on Home) says whose it is, in place of the empty list a helper's session would leave, and offers
// nothing it could only be refused. Practice's Ran Pa Noi is such a shop, and back at the person's own shop every page is as it was.
// The connected runtime's side, what a helper's session reads and is refused, is src/runtime/http/helper.test.ts.
import { afterEach, describe, expect, it } from "vitest";
import { renderToString } from "react-dom/server";
import { setLang } from "../i18n";
import { HELPED_SHOP, OWN_SHOP } from "../runtime/mock/shops";
import { Sidebar } from "../sidebar/Sidebar";
import { getStore } from "../state/store";
import { ActivityPage, ActivityView, type ActivityViewProps } from "./ActivityPage";
import { AutomationsPage } from "./Automations";
import { HistoryPage, HistoryView } from "./HistoryPage";
import { HomePage } from "./HomePage";
import { TeamPage, TeamView } from "./TeamPage";
import { LOADING } from "./load";
import { PAUSE_START } from "./pause";

/** The text a person would read. */
const words = (html: string) => html.replace(/<[^>]*>/g, " ").replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, " ");
const has = (html: string, testid: string) => html.includes(`data-testid="${testid}"`);
const noop = () => {};
const NOI = { name: "Ran Pa Noi", owner: "Noi" };

async function until(ok: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !ok(); i += 1) await new Promise((r) => setTimeout(r, 5));
  expect(ok()).toBe(true);
}

/** The app's own store on Practice, past the first run, viewing `shop`. */
async function viewing(shop: string) {
  setLang("en");
  const store = getStore();
  await store.actions.init();
  store.actions.firstRunEnd();
  await until(() => store.getState().shops.loaded);
  await store.actions.switchShop(shop);
  await until(() => store.getState().shops.current === shop);
  return store;
}

afterEach(() => setLang("en"));

describe("at Ran Pa Noi, where the person helps Noi", () => {
  it("marks the shop on the account row and on Home, and says only Noi sees who is working", async () => {
    await viewing(HELPED_SHOP);
    const menu = renderToString(<Sidebar />);
    expect(menu).toMatch(/<span class="acct-role" data-testid="acct-role">Helper<\/span>/);
    expect(words(menu)).toContain("Ran Pa Noi");
    const home = renderToString(<HomePage />);
    expect(words(home)).toContain("Helping Noi at Ran Pa Noi");
    expect(words(home)).toContain("Only Noi sees who is working at Ran Pa Noi.");
    expect(has(home, "home-idle")).toBe(false);
    // no count of routines the helper may not see
    expect(has(home, "home-automations")).toBe(false);
  });

  it("says the team and Pause everyone are Noi's, lists Buddy, who holds what waits, and offers no Pause", async () => {
    await viewing(HELPED_SHOP);
    const html = renderToString(<TeamPage />);
    expect(words(html)).toContain("Only Noi sees this");
    expect(words(html)).toContain("You help at Ran Pa Noi. Its team, what each member is doing and Pause everyone are Noi's. What waits for you there is in Needs you.");
    expect(has(html, "team-buddy")).toBe(true);
    expect(has(html, "owners-needs")).toBe(true);
    for (const id of ["pause-open", "pause-side", "pause-error", "team-empty"]) expect(has(html, id), id).toBe(false);
  });

  it("says past work, the activity log and the routines are Noi's, with no list, search, export or form", async () => {
    await viewing(HELPED_SHOP);
    const history = renderToString(<HistoryPage />);
    expect(words(history)).toContain("You help at Ran Pa Noi. Its past work is Noi's to see.");
    for (const id of ["history-find", "history-activity", "history-empty", "history-row"]) expect(has(history, id), id).toBe(false);
    const log = renderToString(<ActivityPage />);
    expect(words(log)).toContain("You help at Ran Pa Noi. Its activity log is Noi's to see.");
    for (const id of ["act-loading", "act-empty", "act-export", "act-find"]) expect(has(log, id), id).toBe(false);
    // the log's tab back to History stays, so the page is not a dead end
    expect(has(log, "act-tab-jobs")).toBe(true);
    const auto = renderToString(<AutomationsPage />);
    expect(words(auto)).toContain("You help at Ran Pa Noi. Its routines are Noi's to see and change.");
    for (const id of ["auto-new", "watch-new", "auto-empty", "auto-list", "suggestions"]) expect(has(auto, id), id).toBe(false);
  });

  it("is as it was at the person's own shop: the team with Pause everyone, History's search and the routines' form", async () => {
    await viewing(OWN_SHOP);
    const team = renderToString(<TeamPage />);
    expect(has(team, "owners-team")).toBe(false);
    expect(has(team, "pause-side")).toBe(true);
    expect(has(renderToString(<HistoryPage />), "history-find")).toBe(true);
    expect(has(renderToString(<HistoryPage />), "owners-history")).toBe(false);
    expect(has(renderToString(<AutomationsPage />), "auto-new")).toBe(true);
    expect(has(renderToString(<Sidebar />), "acct-role")).toBe(false);
    expect(words(renderToString(<HomePage />))).not.toContain("Helping");
  });
});

describe("the views, told the shop is a helper's", () => {
  it("draw the owner's words whatever else they are given, and in every language", () => {
    for (const lang of ["en", "ko", "ja", "zh"] as const) {
      setLang(lang);
      const member = { name: "buddy", displayName: "Buddy", description: "", status: "idle" as const, open: noop };
      const pause = { state: LOADING, ui: PAUSE_START, nowMs: 0, nameOf: (b: string) => b, onAsk: noop, onKeep: noop, onPause: noop, onResume: noop, onOpenJob: noop };
      const team = renderToString(<TeamView members={[member]} pause={pause} helped={NOI} />);
      expect(has(team, "owners-team"), lang).toBe(true);
      expect(has(team, "pause-open"), lang).toBe(false);
      const history = renderToString(<HistoryView days={[]} query="" hasThreads={false} onQuery={noop} helped={NOI} />);
      expect(has(history, "owners-history"), lang).toBe(true);
      const log = renderToString(<ActivityView {...({ load: LOADING, helped: NOI, onBack: noop } as unknown as ActivityViewProps)} />);
      expect(has(log, "owners-activity"), lang).toBe(true);
      for (const html of [team, history, log]) {
        expect(words(html), lang).toContain("Ran Pa Noi");
        expect(words(html), lang).not.toContain("{");
      }
    }
  });
});
