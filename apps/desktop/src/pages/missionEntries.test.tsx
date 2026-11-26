// Where a job's page is opened from, and where the activity log is: a job in History (beside the threads, with a button to
// the log), in Home's Recent work, and in a member's panel. Each is drawn from the demo runtime's own jobs, started at 10:00
// on Sunday 22 November, and each press opens the page through the store.
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToString } from "react-dom/server";
import { setLang } from "../i18n";
import type { JobRow } from "../runtime/mission";
import { MockHost, MockRuntime } from "../runtime/mock";
import { createStore, type Store } from "../state/store";
import { HistoryView, historyDays } from "./HistoryPage";
import { HomeView, type HomeViewProps } from "./HomePage";
import { MemberWorkView, RecentWorkList, recentRows, type RecentRow } from "./RecentWork";

const BOOT = new Date(2026, 10, 22, 10, 0).getTime() / 1000;
const NOW = BOOT * 1000;
const NAMES: Record<string, string> = { buddy: "Buddy", nam: "Nam", pim: "Pim", ton: "Ton", kit: "Kit" };
const nameOf = (bot: string) => NAMES[bot] ?? bot;

const words = (html: string) =>
  html
    .replace(/<[^>]*>/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");
const count = (html: string, needle: string) => html.split(needle).length - 1;
const noop = () => {};

async function demo(): Promise<{ store: Store; jobs: JobRow[] }> {
  // The store's own clock is pinned too: a thread it names is stamped with the moment it saw, not with today's date.
  const store = createStore(new MockRuntime(new MockHost({ now: () => BOOT })), { firstRoster: "all", hiddenBots: () => [], resume: () => null, now: () => NOW });
  await store.actions.init();
  store.actions.firstRunEnd();
  const { jobs } = await store.actions.missionJobs();
  return { store, jobs };
}

afterEach(() => {
  setLang("en");
  vi.useRealTimers();
});

describe("History's jobs", () => {
  it("lists the jobs by the day of their last step, newest first, each with its member and where it stands", async () => {
    const { store, jobs } = await demo();
    const days = historyDays(store.getSnapshot(), "", NOW, jobs);
    expect(days.map((d) => d.label)).toEqual(["Today", "Yesterday"]);
    expect(days[0].rows.map((r) => r.title)).toEqual(["Replies about weekend orders", "Captions for the pre-order page", "Replies about late parcels", "Daily sales summary"]);
    expect(days[1].rows.map((r) => r.title)).toEqual(["12.12 teaser post", "Order-status replies to 5 customers"]);
    expect(days[0].rows.map((r) => [r.who, r.time, r.kind])).toEqual([
      ["Nam", "09:51", "job"],
      ["Pim", "09:40", "job"],
      ["Nam", "09:20", "job"],
      ["Ton", "06:52", "job"],
    ]);
    // the tag is the stage's: working blue, checked green, a proposal amber
    expect(days[0].rows[0].tag).toMatchObject({ cls: "tag run" });
    expect(days[0].rows[2].tag).toMatchObject({ cls: "tag ok" });
    expect(days[1].rows[0].tag).toMatchObject({ cls: "tag warn" });
  });

  it("puts a thread among them by its time, and finds both by title", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const { store, jobs } = await demo();
    await store.actions.startTaskThread("buddy", "Discount for a bulk order", "What can we offer for 20 candles?");
    await vi.advanceTimersByTimeAsync(5_000);
    const days = historyDays(store.getSnapshot(), "", NOW, jobs);
    expect(days[0].rows[0].title).toBe("Discount for a bulk order");
    expect(days[0].rows[0].kind).toBeUndefined();
    expect(days[0].rows.slice(1, 3).map((r) => r.title)).toEqual(["Replies about weekend orders", "Captions for the pre-order page"]);
    expect(historyDays(store.getSnapshot(), "LATE", NOW, jobs).flatMap((d) => d.rows.map((r) => r.title))).toEqual(["Replies about late parcels"]);
    expect(historyDays(store.getSnapshot(), "bulk", NOW, jobs).flatMap((d) => d.rows.map((r) => r.title))).toEqual(["Discount for a bulk order"]);
    expect(historyDays(store.getSnapshot(), "no such work", NOW, jobs)).toEqual([]);
  });

  it("lists a thread that is also one of the jobs once, as the job (the connected runtime's tasks are both)", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const { store, jobs } = await demo();
    const thread = await store.actions.startTaskThread("buddy", "A reply to a customer", "Draft it");
    await vi.advanceTimersByTimeAsync(5_000);
    const same: JobRow = { id: String(thread), title: "A reply to a customer", bot: "nam", stage: "drafted", at: BOOT + 60 };
    const rows = historyDays(store.getSnapshot(), "", NOW, [...jobs, same]).flatMap((d) => d.rows);
    expect(rows.filter((r) => r.title === "A reply to a customer").map((r) => [r.kind, r.who])).toEqual([["job", "Nam"]]);
    // without the job, the thread is listed as before
    expect(historyDays(store.getSnapshot(), "", NOW, jobs).flatMap((d) => d.rows).filter((r) => r.title === "A reply to a customer")).toHaveLength(1);
  });

  it("opens the job's page from its row, to return to History", async () => {
    const { store, jobs } = await demo();
    store.actions.openPage("history");
    const row = historyDays(store.getSnapshot(), "", NOW, jobs).flatMap((d) => d.rows).find((r) => r.title === "Replies about late parcels");
    row?.open();
    expect(store.getState().ui).toMatchObject({ view: "job", job: "late-parcels", back: "history" });
  });

  it("draws a job's row with a Job tag and its stage, and the Activity log button beside the search", async () => {
    setLang("en");
    const { store, jobs } = await demo();
    const days = historyDays(store.getSnapshot(), "", NOW, jobs);
    const html = renderToString(<HistoryView days={days} query="" hasThreads onQuery={noop} onActivity={noop} />);
    expect(count(html, 'data-testid="history-row"')).toBe(6);
    expect(count(html, '<span class="tag">Job</span>')).toBe(6);
    expect(html).toMatch(/<span class="tag run">Working<\/span>/);
    expect(html).toMatch(/<span class="tag ok">Checked<\/span>/);
    expect(html).toMatch(/<span class="tag warn">Needs you<\/span>/);
    expect(html).toMatch(/<button[^>]*class="btn"[^>]*data-testid="history-activity"[^>]*>Activity log<\/button>/);
    expect(renderToString(<HistoryView days={days} query="" hasThreads onQuery={noop} />)).not.toContain('data-testid="history-activity"');
  });
});

describe("Recent work", () => {
  it("is the newest jobs, at most three, each with its title, member, stage and when it last moved", async () => {
    const { jobs } = await demo();
    const rows = recentRows(jobs, { nameOf, nowMs: NOW, open: noop });
    expect(rows.map((r) => r.title)).toEqual(["Replies about weekend orders", "Captions for the pre-order page", "Replies about late parcels"]);
    expect(rows.map((r) => [r.who, r.word, r.cls, r.when])).toEqual([
      ["Nam", "Working", "tag run", "09:51"],
      ["Pim", "Working", "tag run", "09:40"],
      ["Nam", "Checked", "tag ok", "09:20"],
    ]);
    expect(recentRows(jobs, { nameOf, nowMs: NOW, open: noop, n: 5 })).toHaveLength(5);
  });

  it("is one member's own work on that member's page, and what has not moved for a day says which day", async () => {
    const { jobs } = await demo();
    const nam = recentRows(jobs, { nameOf, nowMs: NOW, open: noop, bot: "nam", n: 5 });
    expect(nam.map((r) => [r.title, r.when])).toEqual([
      ["Replies about weekend orders", "09:51"],
      ["Replies about late parcels", "09:20"],
      ["Order-status replies to 5 customers", "Yesterday 14:00"],
    ]);
    expect(recentRows(jobs, { nameOf, nowMs: NOW, open: noop, bot: "kit" })).toEqual([]);
  });

  it("opens the job it names", async () => {
    const opened: string[] = [];
    const { jobs } = await demo();
    recentRows(jobs, { nameOf, nowMs: NOW, open: (id) => opened.push(id) })[2].open();
    expect(opened).toEqual(["late-parcels"]);
  });
});

describe("Home's Recent work", () => {
  const home = (over: Partial<HomeViewProps> = {}) => {
    setLang("en");
    return renderToString(
      <HomeView mode="team" modes={["chat", "team"]} text="" canSend={false} onMode={noop} onText={noop} onSubmit={noop} onChip={noop} asks={[]} waiting={0} onSeeAll={noop} working={[]} onSeeTeam={noop} {...over} />,
    );
  };
  const rows: RecentRow[] = [
    { key: "a", title: "Replies about late parcels", who: "Nam", word: "Checked", cls: "tag ok", when: "09:20", open: noop },
    { key: "b", title: "Daily sales summary", who: "Ton", word: "Sent", cls: "tag ok", when: "06:52", open: noop },
  ];

  it("lists the jobs under Working now, each opening its page, with a way on to History", () => {
    const html = home({ recent: rows, onSeeHistory: noop });
    expect(html).toContain('data-testid="home-recent"');
    const text = words(html.slice(html.indexOf('data-testid="home-recent"')));
    expect(text).toContain("Recent work See history");
    expect(text).toMatch(/Replies about late parcels Nam Checked 09:20/);
    expect(text).toMatch(/Daily sales summary Ton Sent 06:52/);
    expect(count(html, 'data-testid="recent-row"')).toBe(2);
    expect(html.indexOf('data-testid="home-working"')).toBeLessThan(html.indexOf('data-testid="home-recent"'));
  });

  it("is not there when there is no work to show, or the runtime has none to give", () => {
    expect(home()).not.toContain('data-testid="home-recent"');
    expect(home({ recent: [] })).not.toContain('data-testid="home-recent"');
  });

  it("draws rows on their own as a list of buttons", () => {
    const html = renderToString(<RecentWorkList rows={rows} />);
    expect(count(html, "<button")).toBe(2);
  });
});

describe("a member's Recent work", () => {
  const rows: RecentRow[] = [{ key: "a", title: "Replies about late parcels", who: "Nam", word: "Checked", cls: "tag ok", when: "09:20", open: noop }];

  it("is a section of the member's panel in the panel's own look, with how many jobs and each one's title, stage and time", () => {
    setLang("en");
    const html = renderToString(<MemberWorkView rows={rows} />);
    const text = words(html);
    expect(html).toContain('data-testid="work-sec"');
    expect(text).toMatch(/Recent work 1/);
    expect(text).toMatch(/Replies about late parcels 09:20 Checked/);
    expect(html).toContain('data-testid="work-row"');
  });

  it("leaves the panel as it was when the member has no work, or the runtime has none to give", () => {
    expect(renderToString(<MemberWorkView rows={[]} />)).toBe("");
  });
});
