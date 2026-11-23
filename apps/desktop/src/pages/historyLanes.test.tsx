// History's filter chips (All, Chat, Team, Code) and the kind on each row, from the design canvas's History board, drawn with
// react-dom/server from the data they are given; then the days built from the app's own store and the demo runtime's jobs,
// filtered by kind and searched by the words the runtime lists for each thread.
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToString } from "react-dom/server";
import { setLang } from "../i18n";
import { MockHost, MockRuntime } from "../runtime/mock";
import type { JobRow } from "../runtime/mission";
import { createStore } from "../state/store";
import { HistoryView, historyDays, historyLanes, type HistoryDayView, type HistoryRowView } from "./HistoryPage";

const words = (html: string) =>
  html
    .replace(/<[^>]*>/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
const noop = () => {};
const count = (html: string, needle: string) => html.split(needle).length - 1;

function drawn(node: ReactNode): ReactElement<Record<string, unknown>>[] {
  if (Array.isArray(node)) return node.flatMap(drawn);
  if (!isValidElement(node)) return [];
  const el = node as ReactElement<Record<string, unknown>>;
  // the page frame takes the chips and the search as props of their own, besides its children
  return [el, ...drawn(el.props.middle as ReactNode), ...drawn(el.props.acts as ReactNode), ...drawn(el.props.children as ReactNode)];
}
const byId = (view: ReactNode, id: string) => drawn(view).filter((e) => e.props["data-testid"] === id);

const row = (over: Partial<HistoryRowView> & { key: string }): HistoryRowView => ({ bot: "buddy", title: "A thread", who: "Buddy", status: "idle", time: "09:12", open: noop, ...over });
const day = (rows: HistoryRowView[]): HistoryDayView => ({ key: "d", label: "Today", date: null, rows });

afterEach(() => setLang("en"));

describe("History's filter chips", () => {
  it("are All, Chat, Team and Code in a group named Show, with the pressed one marked", () => {
    setLang("en");
    const html = renderToString(<HistoryView days={[day([row({ key: "a" })])]} query="" hasThreads onQuery={noop} lanes={["chat", "team", "code"]} lane="team" onLane={noop} />);
    expect(html).toMatch(/role="group"[^>]*aria-label="Show"/);
    for (const id of ["all", "chat", "team", "code"]) expect(html, id).toContain(`data-testid="history-lane-${id}"`);
    const group = html.slice(html.indexOf('aria-label="Show"'), html.indexOf("</div>", html.indexOf('aria-label="Show"'))).replace(/^[^>]*>/, "");
    expect(words(group)).toBe("All Chat Team Code");
    expect(html).toMatch(/aria-pressed="true"[^>]*data-testid="history-lane-team"/);
    expect(html).toMatch(/aria-pressed="false"[^>]*data-testid="history-lane-all"/);
  });

  it("offer only the kinds there are entries of, and none at all while there is one kind or none", () => {
    setLang("en");
    const two = renderToString(<HistoryView days={[day([row({ key: "a" })])]} query="" hasThreads onQuery={noop} lanes={["chat", "team"]} lane="all" onLane={noop} />);
    expect(two).not.toContain('data-testid="history-lane-code"');
    expect(two).toContain('data-testid="history-lane-chat"');
    for (const lanes of [["team"], []] as const) {
      const html = renderToString(<HistoryView days={[day([row({ key: "a" })])]} query="" hasThreads onQuery={noop} lanes={[...lanes]} lane="all" onLane={noop} />);
      expect(html).not.toContain('aria-label="Show"');
    }
    // a view given no kinds at all draws as it did
    expect(renderToString(<HistoryView days={[day([row({ key: "a" })])]} query="" hasThreads onQuery={noop} />)).not.toContain('aria-label="Show"');
  });

  it("report the kind pressed", () => {
    const onLane = vi.fn();
    const view = HistoryView({ days: [], query: "", hasThreads: true, onQuery: noop, lanes: ["chat", "code"], lane: "all", onLane });
    (byId(view, "history-lane-code")[0].props.onClick as () => void)();
    expect(onLane).toHaveBeenLastCalledWith("code");
    (byId(view, "history-lane-all")[0].props.onClick as () => void)();
    expect(onLane).toHaveBeenLastCalledWith("all");
  });

  it("keep the chips when a search finds nothing of the kind pressed, and say what was searched for", () => {
    setLang("en");
    const html = renderToString(<HistoryView days={[]} query="zzz" hasThreads onQuery={noop} lanes={["chat", "code"]} lane="code" onLane={noop} />);
    expect(words(html)).toContain("No thread matches “zzz”");
    expect(html).toContain('data-testid="history-lane-code"');
  });
});

describe("a row's kind", () => {
  it("is the first thing on the row, in a tag of its own, and a row with none has no tag", () => {
    setLang("en");
    const html = renderToString(
      <HistoryView
        days={[day([row({ key: "a", lane: "chat", title: "Discount for a bulk order" }), row({ key: "b", lane: "code", bot: "kit", who: "Kit", title: "Thai date format" }), row({ key: "c", title: "No kind here" })])]}
        query=""
        hasThreads
        onQuery={noop}
        lanes={["chat", "code"]}
        lane="all"
        onLane={noop}
      />,
    );
    expect(count(html, 'data-testid="history-kind"')).toBe(2);
    expect(html).toMatch(/data-testid="history-kind"[^>]*>Chat</);
    expect(html).toMatch(/data-testid="history-kind"[^>]*>Code</);
    expect(html.indexOf('data-testid="history-kind"')).toBeLessThan(html.indexOf("Discount for a bulk order"));
  });
});

/** A store of its own on a fresh demo runtime, listing the whole team as the app does on a first run. */
async function demoStore() {
  const store = createStore(new MockRuntime(new MockHost()), { firstRoster: "all", hiddenBots: () => [], resume: () => null });
  await store.actions.init();
  return store;
}
const job = (over: Partial<JobRow> & { id: string }): JobRow => ({ title: "A job", bot: "nam", stage: "sent", at: Date.now() / 1000 - 600, ...over });

describe("the days built from the store", () => {
  afterEach(() => vi.useRealTimers());

  async function withThreads() {
    vi.useFakeTimers();
    const store = await demoStore();
    await store.actions.startTaskThread("buddy", "Discount for a bulk order", "What can we offer for twenty candles?");
    await store.actions.startTaskThread("kit", "Thai date format", "Format dates the Thai way.");
    await store.actions.startTaskThread("nam", "Late parcel replies", "Draft three replies.");
    await vi.advanceTimersByTimeAsync(5_000);
    // the runtime's list of each member's threads says what was first asked in them (the row's last-message words)
    for (const bot of ["buddy", "kit", "nam"]) await store.actions.loadThreads(bot);
    return store;
  }
  const titles = (days: HistoryDayView[]) => days.flatMap((d) => d.rows.map((r) => r.title)).sort();
  const jobs = [job({ id: "j1", title: "Daily sales summary", bot: "ton" }), job({ id: "j2", title: "Stock sync", bot: "kit" })];

  it("carry the kind of each thread and job, and the kinds there are", async () => {
    const store = await withThreads();
    const days = historyDays(store.getSnapshot(), "", Date.now(), jobs);
    const kinds = Object.fromEntries(days.flatMap((d) => d.rows.map((r) => [r.title, r.lane])));
    expect(kinds).toEqual({ "Discount for a bulk order": "chat", "Thai date format": "code", "Late parcel replies": "team", "Daily sales summary": "team", "Stock sync": "code" });
    expect(historyLanes(store.getSnapshot(), jobs)).toEqual(["chat", "team", "code"]);
    expect(historyLanes(store.getSnapshot(), [])).toEqual(["chat", "team", "code"]);
  });

  it("keep one kind when it is pressed, and everything for All", async () => {
    const store = await withThreads();
    const of = (lane: "all" | "chat" | "team" | "code") => titles(historyDays(store.getSnapshot(), "", Date.now(), jobs, lane));
    expect(of("all")).toHaveLength(5);
    expect(of("chat")).toEqual(["Discount for a bulk order"]);
    expect(of("team")).toEqual(["Daily sales summary", "Late parcel replies"]);
    expect(of("code")).toEqual(["Stock sync", "Thai date format"]);
  });

  it("search the last message and the member's name as well as the title, within the kind pressed", async () => {
    const store = await withThreads();
    const find = (q: string, lane: "all" | "chat" | "team" | "code" = "all") => titles(historyDays(store.getSnapshot(), q, Date.now(), jobs, lane));
    expect(find("twenty candles")).toEqual(["Discount for a bulk order"]);
    expect(find("kit")).toEqual(["Stock sync", "Thai date format"]);
    expect(find("kit", "team")).toEqual([]);
    expect(find("refund")).toEqual([]);
  });
});
