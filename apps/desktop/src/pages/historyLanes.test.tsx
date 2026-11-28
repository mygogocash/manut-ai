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
import { HistoryView, historyArchive, historyDays, historyLanes, type HistoryDayView, type HistoryRowView } from "./HistoryPage";
import { threadRowKey, type RowMarks } from "../sidebar/rows";
import type { PastChat } from "../sessions/host";

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

describe("Remove on History's rows (item 102l-6)", () => {
  const at = Date.now() / 1000;
  const thread = (id: string, title: string, kind?: "chat" | "task") => ({ thread: id, title, cwd: "", started_at: at, running: false, needs: false, message_count: 2, ...(kind ? { kind } : {}) });
  async function withKinds() {
    const store = await demoStore();
    store.dispatch({ type: "threads", bot: "buddy", threads: [thread("cht-1", "Which prices changed?", "chat"), thread("task-1", "Reply to Khun Mali", "task"), thread("plain-1", "A thread of Practice")] });
    return store;
  }

  it("is carried by a conversation's row only: not the team's work, and not a thread of a runtime that marks none", async () => {
    const store = await withKinds();
    const rows = historyDays(store.getSnapshot(), "", Date.now()).flatMap((d) => d.rows);
    expect(Object.fromEntries(rows.map((r) => [r.title, r.remove]))).toEqual({
      "Which prices changed?": { bot: "buddy", thread: "cht-1", title: "Which prices changed?" },
      "Reply to Khun Mali": undefined,
      "A thread of Practice": undefined,
    });
  });

  it("is carried by a conversation in History's Archive too, which brings it back by its menu and can remove it", async () => {
    const store = await withKinds();
    const marks: RowMarks = { [threadRowKey("buddy", "cht-1")]: { archived: 5 }, [threadRowKey("buddy", "task-1")]: { archived: 5 } };
    const archived = historyArchive(store.getSnapshot(), marks);
    expect(Object.fromEntries(archived.map((r) => [r.title, r.remove]))).toEqual({
      "Which prices changed?": { bot: "buddy", thread: "cht-1", title: "Which prices changed?" },
      "Reply to Khun Mali": undefined,
    });
  });

  it("names a conversation no message has named yet as a new thread is named", async () => {
    const store = await demoStore();
    store.dispatch({ type: "threads", bot: "buddy", threads: [thread("chat-new-1", "", "chat")] });
    const rows = historyDays(store.getSnapshot(), "", Date.now()).flatMap((d) => d.rows);
    expect(rows[0].remove).toEqual({ bot: "buddy", thread: "chat-new-1", title: "New thread" });
  });
});

describe("the Archive (item 76)", () => {
  afterEach(() => vi.useRealTimers());

  async function withThreads() {
    vi.useFakeTimers();
    const store = await demoStore();
    await store.actions.startTaskThread("buddy", "Discount for a bulk order", "What can we offer for twenty candles?");
    await store.actions.startTaskThread("buddy", "Weekend sale post", "Draft the weekend sale post.");
    await vi.advanceTimersByTimeAsync(5_000);
    await store.actions.loadThreads("buddy");
    const rows = store.getSnapshot().threads.buddy;
    return { store, rows, key: (title: string) => threadRowKey("buddy", rows.find((r) => r.title === title)!.thread) };
  }
  const titles = (days: HistoryDayView[]) => days.flatMap((d) => d.rows.map((r) => r.title)).sort();

  it("takes an archived chat out of the days and lists it in the Archive, which brings it back by its menu", async () => {
    const { store, key } = await withThreads();
    const marks: RowMarks = { [key("Weekend sale post")]: { archived: 5 } };
    expect(titles(historyDays(store.getSnapshot(), "", Date.now(), [], "all", marks))).toEqual(["Discount for a bulk order"]);
    expect(historyArchive(store.getSnapshot(), marks).map((r) => r.title)).toEqual(["Weekend sale post"]);
    // with no marks (a list saved before them) everything is listed and the Archive is empty
    expect(titles(historyDays(store.getSnapshot(), "", Date.now()))).toEqual(["Discount for a bulk order", "Weekend sale post"]);
    expect(historyArchive(store.getSnapshot(), {})).toEqual([]);
  });

  it("keeps a snoozed, settled or pinned chat in History, tagged, so it can always be found", async () => {
    const { store, key } = await withThreads();
    const marks: RowMarks = { [key("Weekend sale post")]: { snoozed: Date.now() + 3_600_000 }, [key("Discount for a bulk order")]: { pinned: 1 } };
    const rows = historyDays(store.getSnapshot(), "", Date.now(), [], "all", marks).flatMap((d) => d.rows);
    expect(Object.fromEntries(rows.map((r) => [r.title, r.place]))).toEqual({ "Weekend sale post": "snoozed", "Discount for a bulk order": "pinned" });
  });

  it("draws the Archive under the days with its count, and no Archive when nothing is archived", async () => {
    const { store, key } = await withThreads();
    const marks: RowMarks = { [key("Weekend sale post")]: { archived: 5 } };
    const archive = historyArchive(store.getSnapshot(), marks);
    const withIt = renderToString(<HistoryView days={historyDays(store.getSnapshot(), "", Date.now(), [], "all", marks)} archive={archive} query="" hasThreads onQuery={noop} />);
    expect(withIt).toContain('data-testid="history-archive"');
    expect(words(withIt)).toContain("Archive (1)");
    // the list is shut until it is asked for
    expect(withIt).not.toContain('data-testid="history-archive-row"');
    const without = renderToString(<HistoryView days={historyDays(store.getSnapshot(), "", Date.now())} archive={[]} query="" hasThreads onQuery={noop} />);
    expect(without).not.toContain("history-archive");
  });

  it("tags a chat's row with Pinned, Snoozed until a time and Done for now, and gives each chat row its menu button", () => {
    const html = renderToString(
      <HistoryView
        days={[
          day([
            row({ key: "a", rowKey: "thread:buddy:a", place: "pinned", mark: { pinned: 1 } }),
            row({ key: "b", rowKey: "thread:buddy:b", place: "snoozed", mark: { snoozed: new Date(2026, 10, 26, 9).getTime() } }),
            row({ key: "c", rowKey: "thread:buddy:c", place: "settled", mark: { settled: true } }),
            row({ key: "j", kind: "job" }),
          ]),
        ]}
        nowMs={new Date(2026, 10, 25, 14).getTime()}
        query=""
        hasThreads
        onQuery={noop}
      />,
    );
    const text = words(html);
    expect(text).toContain("Pinned");
    expect(text).toMatch(/Snoozed until \w{3} 09:00/);
    expect(text).toContain("Done for now");
    // a job has no menu: three chats, three buttons
    expect(count(html, 'data-testid="row-more"')).toBe(3);
  });
});

describe("the conversations brought over from Claude Code and Codex (item 101e)", () => {
  afterEach(() => vi.useRealTimers());
  const now = Date.now();
  const past: PastChat[] = [
    { agent: "claude", id: "aaaaaaaa-1111-4222-8333-444444444444", cwd: "/home/you/code/web-app", title: "Fix the login redirect", named: true, at: now / 1000 - 3_600 },
    { agent: "codex", id: "01a1d060-4ab7-72b2-b02b-1dbee1d5f52c", cwd: "/home/you/code/shop-api", title: "Add a dark theme", named: true, at: now / 1000 - 600 },
  ];

  it("are Code rows among the days, newest first, each by its agent and folder, opening its conversation", async () => {
    vi.useFakeTimers();
    const store = await demoStore();
    const opened: string[] = [];
    const rows = historyDays(store.getSnapshot(), "", now, [], "all", {}, past, (c) => opened.push(c.id)).flatMap((d) => d.rows);
    const mine = rows.filter((r) => r.kind === "past");
    expect(mine.map((r) => [r.title, r.who, r.folder, r.lane, r.agent])).toEqual([
      ["Add a dark theme", "Codex", "shop-api", "code", "codex"],
      ["Fix the login redirect", "Claude Code", "web-app", "code", "claude"],
    ]);
    // no chat menu and no marks: they are the agents' conversations, not the team's chats
    expect(mine.every((r) => r.rowKey === undefined)).toBe(true);
    mine[1].open();
    expect(opened).toEqual(["aaaaaaaa-1111-4222-8333-444444444444"]);
    expect(historyLanes(store.getSnapshot(), [], past)).toContain("code");
  });

  it("are found by their title, their agent and their folder, and only under All and Code", async () => {
    vi.useFakeTimers();
    const store = await demoStore();
    const find = (q: string, lane: "all" | "chat" | "code" = "all") =>
      historyDays(store.getSnapshot(), q, now, [], lane, {}, past, () => {})
        .flatMap((d) => d.rows)
        .filter((r) => r.kind === "past")
        .map((r) => r.title);
    expect(find("login")).toEqual(["Fix the login redirect"]);
    expect(find("codex")).toEqual(["Add a dark theme"]);
    expect(find("shop-api")).toEqual(["Add a dark theme"]);
    expect(find("", "code")).toHaveLength(2);
    expect(find("", "chat")).toEqual([]);
  });

  it("draw the agent's mark and the folder's name, with no menu button, and say when History shows only the newest", () => {
    setLang("en");
    const r = row({ key: "past:claude:x", bot: "", kind: "past", agent: "claude", folder: "web-app", lane: "code", who: "Claude Code", title: "Fix the login redirect" });
    const html = renderToString(<HistoryView days={[day([r])]} query="" hasThreads onQuery={noop} pastMore />);
    expect(html).toContain('data-kind="past"');
    expect(html).toMatch(/data-testid="history-folder"[^>]*>web-app</);
    expect(html).toContain('class="hist-agent"');
    expect(html).not.toContain("hist-more");
    expect(words(html)).toContain("Showing the newest 30 conversations of each of Claude Code and Codex from the projects brought over.");
    expect(renderToString(<HistoryView days={[day([r])]} query="" hasThreads onQuery={noop} />)).not.toContain("history-past-more");
  });

  it("put Bring over… in the top bar only when the offer can open", () => {
    setLang("en");
    const onImport = vi.fn();
    const view = HistoryView({ days: [], query: "", hasThreads: false, onQuery: noop, onImport });
    const btn = byId(view, "history-import")[0];
    expect(btn.props.children).toBe("Bring over…");
    (btn.props.onClick as () => void)();
    expect(onImport).toHaveBeenCalledTimes(1);
    expect(byId(HistoryView({ days: [], query: "", hasThreads: false, onQuery: noop }), "history-import")).toEqual([]);
  });
});
