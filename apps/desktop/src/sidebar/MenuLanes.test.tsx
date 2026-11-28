// The lanes in the side menu (item 167a), drawn with react-dom/server and read from the elements the view returns: they take
// Recent's place only while the Code row is current, each is a menu row with its title and one state mark, the open one is
// marked, and each has its More menu. Opening a lane, from its row or by the previous and next lane keys, calls the store's
// openSession and nothing else: no ask is answered, nothing is sent and no approval is touched.
import { readFileSync } from "node:fs";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setLang } from "../i18n";
import { emptyLane, noteLane } from "../code/lane";
import { laneRowOf, type LaneRow, type LaneRowInput } from "../code/Lanes";
import type { LaneGroup } from "./laneGroups";
import { laneOrder } from "../code/Lanes";
import { MenuLanesView, type MenuLanesProps } from "./MenuLanes";
import { SideMenu, type RecentItem } from "./Sidebar";
import type { MenuRow } from "./menu";
import type { RowMarks } from "./rows";

afterEach(() => setLang("en"));

const NOW = 1_000_000;
const PASS = [
  { event: "tool.start", tool_id: "t1", name: "terminal", detail: "pnpm test" },
  { event: "tool.end", tool_id: "t1", name: "", ok: true, ms: 40, output: "      Tests  14 passed (14)\n" },
];

function lane(id: string, title: string, over: Partial<LaneRowInput> & { cwd?: string; helperOf?: { lead: string; index: number } } = {}): LaneRow {
  const rec: LaneRowInput["rec"] = {
    id,
    agent: "claude",
    cwd: over.cwd ?? "/w/shop",
    status: "running",
    promptTitle: title,
    lane: { name: `kit/${id}`, base: "main" },
    ...(over.helperOf ? { helperOf: { lead: over.helperOf.lead, job: "j", round: "r", index: over.helperOf.index } } : {}),
    ...over.rec,
  };
  return laneRowOf({ agent: "Claude Code", live: { branch: `kit/${id}` }, lane: emptyLane(), turn: null, asks: [], ...over, rec });
}

/** The canvas's Code board in one project, and a second project: Checked, Working, Needs you, Failed, and a lane not run yet. */
const rows = () => ({
  shop: [
    lane("s1", "PromptPay QR at checkout", { lane: PASS.reduce((l, ev, i) => noteLane(l, ev, 1_000 + i), emptyLane()) }),
    lane("s2", "Fix stock sync with Shopee", { turn: { status: "Running the tests", startedAt: 1 } }),
    lane("s3", "Thai date format", { asks: ["Which year should customers see: 2026 or 2569?"] }),
    lane("s4", "Old receipt layout", { rec: { id: "s4", agent: "claude", cwd: "/w/shop", status: "failed", error: "Claude Code stopped." } }),
    lane("s5", "Part 1", { helperOf: { lead: "s1", index: 0 } }),
  ],
  docs: [lane("d1", "Typos in the help", { cwd: "/w/docs" })],
});

const marks: RowMarks = { "session:s2": { pinned: NOW - 1 }, "session:s4": { settled: true, why: "quiet", days: 3 } };

function groups(m: RowMarks = marks): LaneGroup[] {
  const r = rows();
  return [
    { project: "/w/shop", name: "shop", lanes: laneOrder(r.shop, m, NOW) },
    { project: "/w/docs", name: "docs", lanes: laneOrder(r.docs, m, NOW) },
  ];
}

const props = (over: Partial<MenuLanesProps> = {}): MenuLanesProps => ({ groups: groups(), open: "s3", onOpen: vi.fn(), marks, ...over });
const recent: RecentItem[] = [{ key: "kami:t1", title: "Late parcels", open: vi.fn(), rowKey: "thread:kami:t1" }];

function menu(current: MenuRow | null, lanes: MenuLanesProps | undefined = props(), working: RecentItem[] = []) {
  return renderToString(<SideMenu current={current} needs={1} recent={recent} working={working} settings={false} onRow={vi.fn()} onSearch={vi.fn()} onAccount={vi.fn()} lanes={lanes} />);
}

/** One lane's `<li>` in the drawn menu. */
const li = (html: string, id: string) => (new RegExp(`<li[^>]*data-testid="menu-lane-${id}"[\\s\\S]*?</li>`).exec(html)?.[0] ?? "").replaceAll("<!-- -->", "");
const count = (html: string, needle: string) => html.split(needle).length - 1;

describe("lanes in the side menu", () => {
  it("take Recent's place, and the Working group's, only while the Code row is current", () => {
    const code = menu("code", props(), [{ key: "kami:t2", title: "Replies", open: vi.fn(), rowKey: "thread:kami:t2" }]);
    expect(code).toContain('data-testid="menu-lanes"');
    expect(code).not.toContain('data-testid="menu-recent"');
    expect(code).not.toContain('data-testid="menu-working"');
    for (const row of ["new", "needs", "team", "artifacts", "customize", "history", null] as const) {
      const html = menu(row);
      expect(html, String(row)).toContain('data-testid="menu-recent"');
      expect(html, String(row)).not.toContain('data-testid="menu-lanes"');
    }
  });

  it("leave Recent where it is while no lane is listed", () => {
    const html = menu("code", props({ groups: [] }));
    expect(html).toContain('data-testid="menu-recent"');
    expect(html).not.toContain('data-testid="menu-lanes"');
  });

  it("are grouped by project under the project's name, in the order given, each list named for a screen reader", () => {
    const html = menu("code");
    expect([...html.matchAll(/data-testid="menu-lanes-h"[^>]*>([^<]+)</g)].map((m) => m[1])).toEqual(["shop", "docs"]);
    expect(html).toContain('aria-label="Lanes in shop"');
    expect(html).toContain('aria-label="Lanes in docs"');
    // the band's order: the pinned lane first, the helper under its lead, the settled one last
    expect([...html.matchAll(/data-testid="menu-lane-([sd]\d)"/g)].map((m) => m[1])).toEqual(["s2", "s1", "s5", "s3", "s4", "d1"]);
  });

  it("draw each lane as a menu row with its title and one state mark in its tag's colour, its words for a screen reader", () => {
    const html = menu("code");
    const tones = { s1: "ok", s2: "run", s3: "warn", s4: "err", d1: "plain" } as const;
    const words = { s1: "Checked", s2: "Working", s3: "Needs you", s4: "Failed", d1: "Not run yet" } as const;
    for (const id of Object.keys(tones) as (keyof typeof tones)[]) {
      const row = li(html, id);
      expect(count(row, 'data-testid="menu-lane-mark"'), id).toBe(1);
      expect(row, id).toContain(`data-tone="${tones[id]}"`);
      expect(row, id).toContain(`<span class="vh">, ${words[id]}</span>`);
      expect(row, id).toMatch(/class="rec"/);
    }
    expect(li(html, "s3")).toContain("Thai date format");
    // only the working dot is one that pulses (its class); the others stand still
    expect(li(html, "s2")).toContain('class="dotst run"');
    // a lane that asks or failed fades where it stands as the rows arrive, and never rises (docs/motion.md)
    for (const id of ["s3", "s4"]) expect(li(html, id), id).toContain('data-ask="true"');
    for (const id of ["s1", "s2", "d1"]) expect(li(html, id), id).not.toContain("data-ask");
    expect(html).toContain('data-arrive="menu-lanes:/w/shop"');
  });

  it("mark the open lane, and keep the one current page the Code row", () => {
    const html = menu("code");
    expect(count(html, 'aria-current="true"')).toBe(1);
    expect(li(html, "s3")).toContain('aria-current="true"');
    expect(count(html, 'aria-current="page"')).toBe(1);
    expect(html).toMatch(/aria-current="page"[^>]*data-testid="menu-code"/);
    expect(count(menu("code", props({ open: null })), 'aria-current="true"')).toBe(0);
  });

  it("show a pinned lane's pin, a settled lane's quiet line, a helper indented under its lead, and each lane's More menu", () => {
    const html = menu("code");
    expect(li(html, "s2")).toContain('data-testid="menu-lane-pin"');
    expect(li(html, "s4")).toMatch(/class="rec-li lane-li settled"/);
    expect(li(html, "s4")).toContain("Done after 3 quiet days");
    expect(li(html, "s5")).toMatch(/class="rec-li lane-li helper"/);
    expect(count(html, 'data-testid="row-more"')).toBe(6);
    expect(li(html, "s3")).toContain('aria-label="More for Thai date format"');
    expect(li(html, "s3")).toContain('aria-haspopup="menu"');
  });
});

// ---- what a press does -----------------------------------------------------------------------------------------------

function drawn(node: ReactNode): ReactElement<Record<string, unknown>>[] {
  if (Array.isArray(node)) return node.flatMap(drawn);
  if (!isValidElement(node)) return [];
  const el = node as ReactElement<Record<string, unknown>>;
  // a lane's More menu keeps state of its own and is drawn by the band's tests, so it is not called here
  if (typeof el.type === "function") return el.type.name === "LaneMore" ? [] : drawn((el.type as (props: unknown) => ReactNode)(el.props));
  return [...(typeof el.type === "string" ? [el] : []), ...drawn(el.props.children as ReactNode)];
}

/** A lane as a restart brings it back: a chat with Kit in `cwd`, not running. */
const saved = (id: string, cwd: string, title: string) => ({ id, agent: "claude", cwd, startedAt: Number(id.slice(1)), view: "chat", running: false, title, messages: [] });

describe("opening a lane", () => {
  it("from its row calls only what the row was given, with the lane's id", () => {
    const onOpen = vi.fn();
    const row = drawn(MenuLanesView(props({ onOpen }))).find((e) => e.props["data-testid"] === "menu-lane" && String(e.props.title).startsWith("Thai date format"));
    (row!.props.onClick as () => void)();
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onOpen).toHaveBeenCalledWith("s3");
  });

  it("from its row or by the previous and next lane keys calls the store's openSession and nothing else: no ask is answered, nothing is sent", async () => {
    const { getStore } = await import("../state/store");
    const { getSessions } = await import("../sessions/sessions");
    const { onShortcutKey, isMac } = await import("../app/shortcuts");
    const { openLane } = await import("../code/Lanes");
    const store = getStore();
    await store.actions.init();
    store.actions.firstRunEnd();
    const sessions = getSessions();
    sessions.restore([saved("s2", "/w/shop", "Second lane"), saved("s1", "/w/shop", "First lane")] as never);
    expect(sessions.getState().list.map((r) => r.id)).toEqual(["s2", "s1"]);

    // every action of the app's store and every call of the sessions store, watched; only reads may run besides openSession
    const actions = store.actions as unknown as Record<string, (...a: unknown[]) => unknown>;
    const watched = Object.keys(actions).filter((k) => typeof actions[k] === "function").map((k) => [k, vi.spyOn(actions, k)] as const);
    const ss = sessions as unknown as Record<string, (...a: unknown[]) => unknown>;
    const reads = new Set(["getState", "chatKey", "subscribe"]);
    const writes = Object.keys(ss).filter((k) => typeof ss[k] === "function" && !reads.has(k)).map((k) => [k, vi.spyOn(ss, k)] as const);
    const chats = store.getState().chats;

    const press = (key: "ArrowDown" | "ArrowUp") =>
      onShortcutKey({ key, code: key, metaKey: isMac(), ctrlKey: !isMac(), altKey: true, shiftKey: !isMac(), target: null, repeat: false, defaultPrevented: false, preventDefault() {}, stopPropagation() {} } as unknown as KeyboardEvent);
    press("ArrowDown"); // no lane open: the first
    expect(store.getState().ui).toMatchObject({ view: "session", session: "s2" });
    press("ArrowDown");
    press("ArrowDown"); // past the last: the first again
    press("ArrowUp"); // before the first: the last
    openLane("s2"); // the row's press

    const opened = watched.find(([k]) => k === "openSession")![1];
    expect(opened.mock.calls.map((c) => c[0])).toEqual(["s2", "s1", "s2", "s1", "s2"]);
    for (const [k, spy] of watched) if (k !== "openSession") expect(spy, k).not.toHaveBeenCalled();
    for (const [k, spy] of writes) expect(spy, k).not.toHaveBeenCalled();
    // no chat was written to: no message went out, no card was settled
    expect(store.getState().chats).toBe(chats);
  });

  it("reaches no code that settles an ask, answers a question or sends", () => {
    const here = new URL(".", import.meta.url).pathname;
    const files = ["MenuLanes.tsx", "laneGroups.ts", "../code/codeProject.ts"].map((f) => readFileSync(here + f, "utf8"));
    const step = readFileSync(here + "../app/shortcuts.ts", "utf8").match(/export function stepLane[\s\S]*?\n}\n/)?.[0] ?? "";
    expect(step).toContain("openLane(to)");
    for (const text of [...files, step]) for (const bad of [/settleApproval/, /respondApproval/, /resolveAsk/, /chat\/cards/, /\.send\(/, /approval-core/, /answer\w*\(/]) expect(text, String(bad)).not.toMatch(bad);
  });
});
