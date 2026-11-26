// The side menu's pages, drawn with react-dom/server as smoke.test.tsx draws the first screen. Each view is drawn from
// the data it is given; the last tests draw the connected pages on the app's own store and the demo runtime.
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToString } from "react-dom/server";
import { setLang } from "../i18n";
import { NeedsView, needRows, newestFirst, type NeedRow } from "./NeedsPage";
import { TeamView, teamRows, type TeamRow } from "./TeamPage";
import { HistoryView, historyDays, type HistoryDayView } from "./HistoryPage";
import { CustomizePage } from "./CustomizePage";
import { ArtifactsPage } from "./ArtifactsPage";
import { CodePage } from "./CodePage";
import { createStore, getStore, selectAsks, type Ask } from "../state/store";
import { MockHost, MockRuntime } from "../runtime/mock";
import { APPROVAL_SEED } from "../runtime/mock/seed";

/** The text a person would read: tags and attribute values removed, entities decoded where tests compare them. */
const words = (html: string) =>
  html
    .replace(/<[^>]*>/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");
const draw = (el: React.ReactElement) => {
  setLang("en");
  return renderToString(el);
};
const count = (html: string, needle: string) => html.split(needle).length - 1;

describe("Needs you", () => {
  const row = (over: Partial<NeedRow>): NeedRow => ({ key: "k", who: "Nam", kind: "approval", text: "Allow this?", age: "3m", face: null, open: () => {}, ...over });

  it("lists every open ask in the order given, each with who asks, what, what kind and how long ago", () => {
    const html = draw(
      <NeedsView
        rows={[
          row({ key: "a", who: "Nam", kind: "approval", text: "Allow `rm -rf build/`?", age: "now" }),
          row({ key: "b", who: "Pim", kind: "clarify", text: "Which page should the post go on?", age: "4m" }),
        ]}
      />,
    );
    const text = words(html);
    expect(html).toContain('data-testid="page-needs"');
    expect(text).toContain("Needs you");
    expect(count(html, 'data-testid="needs-row"')).toBe(2);
    expect(text.indexOf("Nam")).toBeLessThan(text.indexOf("Pim"));
    expect(text).toContain("Approve");
    expect(text).toContain("Question");
    expect(text).toContain("Which page should the post go on?");
    // A command in the ask is set as code, not shown with its backticks.
    expect(html).toContain("<code>rm -rf build/</code>");
    expect(text).not.toContain("Nothing needs you");
  });

  it("says nothing waits, in the canvas's words, when no ask is open", () => {
    const text = words(draw(<NeedsView rows={[]} />));
    expect(text).toContain("Nothing needs you");
    expect(text).toContain("When the team wants to send, spend or publish, it asks here first.");
  });

  it("puts the newest ask first; asks of the same moment keep their order", () => {
    const ask = (id: string, ts: number) => ({ bot: "nam", ts, item: { id } }) as unknown as Ask;
    expect(newestFirst([ask("a", 1), ask("b", 3), ask("c", 2), ask("d", 3)]).map((a) => a.item.id)).toEqual(["b", "d", "c", "a"]);
  });
});

describe("Team", () => {
  const member = (over: Partial<TeamRow>): TeamRow => ({ name: "nam", displayName: "Nam", description: "Sales chat", status: "idle", open: () => {}, ...over });

  it("lists the members in the order given, each with face, name, what they do and status", () => {
    const html = draw(
      <TeamView
        members={[
          member({ name: "buddy", displayName: "Buddy", description: "Your assistant", status: "working" }),
          member({ name: "nam", displayName: "Nam", description: "Sales chat", status: "needs" }),
          member({ name: "ton", displayName: "Ton", description: "Books", status: "stuck" }),
          member({ name: "kit", displayName: "Kit", description: "Engineer", status: "offline" }),
          member({ name: "pim", displayName: "Pim", description: "Content", status: "idle" }),
        ]}
      />,
    );
    const text = words(html);
    expect(html).toContain('data-testid="page-team"');
    const names = ["Buddy", "Nam", "Ton", "Kit", "Pim"];
    expect(names.map((n) => text.indexOf(n))).toEqual([...names.map((n) => text.indexOf(n))].sort((a, b) => a - b));
    for (const d of ["Your assistant", "Sales chat", "Books", "Engineer", "Content"]) expect(text, d).toContain(d);
    expect(html).toMatch(/class="tag run"[^>]*>Working</);
    expect(html).toMatch(/class="tag warn"[^>]*>Needs you</);
    expect(html).toMatch(/class="tag err"[^>]*>Could not finish</);
    expect(html).toMatch(/class="tag"[^>]*>Not connected</);
    expect(html).toMatch(/class="tag"[^>]*>Idle</);
    // Each member's face is the brand's: Buddy's blue face, and the others drawn on their own colour at the kit's 40
    expect(count(html, 'class="ui-av"')).toBe(5);
    expect(count(html, 'data-face="buddy"')).toBe(1);
    expect(count(html, 'class="face lg"')).toBe(4);
    expect(html).toMatch(/data-face="nam"[^]*?class="fg"[^>]*fill="#CDDDEB"/);
    expect(html).toMatch(/data-face="kit"[^]*?class="fg"[^>]*fill="#E6D9C2"/);
    expect(html).toContain('data-testid="team-kit"');
  });

  it("says where the team will show when there is none yet", () => {
    expect(words(draw(<TeamView members={[]} />))).toContain("No team yet");
  });
});

describe("History", () => {
  const days: HistoryDayView[] = [
    {
      key: "d1",
      label: "Today",
      date: "Sunday 22 November",
      rows: [
        { key: "r1", bot: "nam", title: "Replies about late parcels", who: "Nam", status: "running", time: "09:20", open: () => {} },
        { key: "r2", bot: "buddy", title: "Discount for a bulk order", who: "Buddy", status: "idle", time: "09:12", open: () => {} },
      ],
    },
    { key: "d2", label: "Friday 20 November", date: null, rows: [{ key: "r3", bot: "kit", title: "Thai date format", who: "Kit", status: "done", time: "16:40", open: () => {} }] },
  ];

  it("shows each day's band and its threads, newest first, with who, status and time", () => {
    const html = draw(<HistoryView days={days} query="" hasThreads onQuery={() => {}} />);
    const text = words(html);
    expect(html).toContain('data-testid="page-history"');
    expect(text).toContain("Today");
    expect(text).toContain("Sunday 22 November");
    expect(text).toContain("Friday 20 November");
    for (const s of ["Replies about late parcels", "Discount for a bulk order", "Thai date format", "09:20", "16:40", "Nam", "Kit"]) expect(text, s).toContain(s);
    expect(text.indexOf("Replies about late parcels")).toBeLessThan(text.indexOf("Thai date format"));
    expect(html).toMatch(/class="tag run"[^>]*>Working</);
    expect(html).toMatch(/class="tag ok"[^>]*>Done</);
    // An idle thread carries no status word: most threads are idle, and a word on every row would be noise.
    expect(html).not.toContain(">Idle<");
    expect(count(html, 'data-testid="history-row"')).toBe(3);
  });

  it("has a search box named for what it does, holding the words typed", () => {
    const html = draw(<HistoryView days={days} query="parcels" hasThreads onQuery={() => {}} />);
    expect(html).toContain('placeholder="Search titles and latest messages"');
    expect(html).toMatch(/<label[^>]*for="history-find"[^>]*>Search history<\/label>/);
    expect(html).toMatch(/<input[^>]*id="history-find"[^>]*value="parcels"/);
  });

  it("says no thread matches the words, when none does", () => {
    const text = words(draw(<HistoryView days={[]} query="refund" hasThreads onQuery={() => {}} />));
    expect(text).toContain("No thread matches “refund”");
    expect(text).not.toContain("Nothing here yet");
  });

  it("says what will show here while the team has no thread", () => {
    const text = words(draw(<HistoryView days={[]} query="" hasThreads={false} onQuery={() => {}} />));
    expect(text).toContain("Nothing here yet");
    expect(text).toContain("Threads with Buddy and the team show here, newest first.");
  });
});

describe("Artifacts", () => {
  // The page's states, its ask and its list are drawn from data in ArtifactsPage.test.tsx.
  it("says publishing public links is off until it is turned on in Settings, and offers nothing else", () => {
    const html = draw(<ArtifactsPage />);
    expect(html).toContain('data-testid="page-artifacts"');
    expect(words(html)).toContain("Publishing public links is off on this Mac. Turn it on in Settings › Artifacts.");
    expect(html).not.toContain('data-testid="art-links"');
  });
});

describe("Customize", () => {
  // The page reads what the team knows and its routines when it opens, so the first draw is the waiting one; the board itself
  // (the facts, the routines, the form, every state) is drawn from data in CustomizePage.test.tsx.
  it("is the page of memory and routines, and says it is reading while it waits", () => {
    const html = draw(<CustomizePage />);
    const text = words(html);
    expect(html).toContain('data-testid="page-customize"');
    expect(text).toContain("What your team knows");
    expect(text).toContain("Routines");
    expect(html).toContain('data-testid="memory-loading"');
    expect(html).toContain('data-testid="routines-loading"');
  });

  it("offers neither Automations nor Plugins when the runtime has neither, as the demo runtime has neither", () => {
    const html = draw(<CustomizePage />);
    expect(html).not.toContain('data-testid="nav-automations"');
    expect(html).not.toContain('data-testid="nav-plugins"');
  });
});

/** A store of its own on a fresh demo runtime, listing the whole team as the app does on a first run. Unlike the app's
 *  own store it plays no sounds, which need a browser. */
async function demoStore() {
  const store = createStore(new MockRuntime(new MockHost()), { firstRoster: "all", hiddenBots: () => [], resume: () => null });
  await store.actions.init();
  return store;
}

describe("the pages on the demo runtime", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("Code lists the terminals with their + menu, and Tasks, on the app's own store", async () => {
    const store = getStore();
    await store.actions.init();
    const html = draw(<CodePage />);
    const text = words(html);
    expect(html).toContain('data-testid="page-code"');
    expect(text).toContain("Terminals");
    expect(html).toContain('data-testid="session-new"');
    expect(html).toContain('data-testid="tasks-bar"');
  });

  it("Needs you lists the demo team's real ask, and its row opens that member's chat with the ask focused", async () => {
    vi.useFakeTimers();
    const store = await demoStore();
    await store.actions.selectBot("nam");
    const sent = store.actions.send("/approve");
    await vi.advanceTimersByTimeAsync(2_000);
    await sent;
    const asks = selectAsks(store.getState());
    expect(asks).toHaveLength(1);
    const html = draw(<NeedsView rows={needRows(store.getSnapshot(), Date.now())} />);
    const text = words(html);
    expect(count(html, 'data-testid="needs-row"')).toBe(1);
    expect(text).toContain("Nam");
    expect(text).toContain(APPROVAL_SEED.command);
    // The row focuses that ask in Nam's chat, as the sidebar's strip did.
    store.actions.openPage("needs");
    const [row] = needRows(store.getSnapshot(), Date.now());
    expect(row).toMatchObject({ who: "Nam", kind: "approval" });
    row.open();
    expect(store.getState().ui).toMatchObject({ view: "chat", thread: null, focusAsk: { bot: "nam", id: asks[0].item.id } });
    expect(store.getState().selectedBot).toBe("nam");

    // Team lists the five demo members in roster order, with Nam waiting on the person, and each row opens that
    // member's chat.
    const team = teamRows(store.getSnapshot());
    expect(team.map((m) => [m.displayName, m.status])).toEqual([
      ["Buddy", "idle"],
      ["Nam", "needs"],
      ["Pim", "idle"],
      ["Ton", "idle"],
      ["Kit", "idle"],
    ]);
    store.actions.openPage("team");
    team.find((m) => m.name === "kit")!.open();
    expect(store.getState().ui.view).toBe("chat");
    expect(store.getState().selectedBot).toBe("kit");
  });

  it("History lists the team's real threads under Today, filters them by title, and opens one", async () => {
    vi.useFakeTimers();
    const store = await demoStore();
    const id = await store.actions.startTaskThread("buddy", "Discount for a bulk order", "What can we offer for 20 candles?");
    await vi.advanceTimersByTimeAsync(5_000);
    expect(id).not.toBeNull();
    const days = historyDays(store.getSnapshot(), "", Date.now());
    expect(days.map((d) => d.label)).toEqual(["Today"]);
    expect(days[0].rows.map((r) => [r.title, r.who])).toEqual([["Discount for a bulk order", "Buddy"]]);
    expect(historyDays(store.getSnapshot(), "BULK", Date.now())[0].rows).toHaveLength(1);
    expect(historyDays(store.getSnapshot(), "refund", Date.now())).toEqual([]);
    store.actions.openPage("history");
    days[0].rows[0].open();
    expect(store.getState().ui).toMatchObject({ view: "chat", thread: id });
    expect(store.getState().selectedBot).toBe("buddy");
  });
});
