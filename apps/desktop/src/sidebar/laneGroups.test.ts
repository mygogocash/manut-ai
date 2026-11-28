// Which lanes the side menu lists while the code mode is open, and in what order (item 167a): grouped by project, the project the
// Code page shows first and the others in its order, each group in the Lanes band's order and marks (the band drawn here beside
// it, so the two cannot part), and the previous and next lane keys stepping through that order, wrapping at the ends.
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setLang } from "../i18n";
import { emptyLane } from "../code/lane";
import { LanesView, laneOrder, laneRowOf, type LaneRow, type LaneRowInput, type LaneStores } from "../code/Lanes";
import type { AppState } from "../state/store";
import type { SessionRec } from "../sessions/agents";
import { stepSession } from "../app/shortcuts";
import { menuLaneGroups, menuLaneIds, menuLanesFrom } from "./laneGroups";
import type { RowMarks } from "./rows";

afterEach(() => setLang("en"));

const NOW = 1_000_000;
const LATER = NOW + 3_600_000;

/** A lane's row: session `id` in folder `cwd`, titled `title`, asking or working when told. */
function lane(id: string, title: string, over: { cwd?: string; asks?: string[]; working?: boolean; startedAt?: number; job?: string; helperOf?: { lead: string; index: number } } = {}): LaneRow {
  const rec: LaneRowInput["rec"] = {
    id,
    agent: "claude",
    cwd: over.cwd ?? "/w/shop",
    status: "running",
    promptTitle: title,
    lane: { name: `kit/${id}`, base: "main" },
    ...(over.startedAt !== undefined ? { startedAt: over.startedAt } : {}),
    ...(over.job ? { job: over.job } : {}),
    ...(over.helperOf ? { helperOf: { lead: over.helperOf.lead, job: "j-help", round: "r1", index: over.helperOf.index } } : {}),
  };
  return laneRowOf({ rec, agent: "Claude Code", live: { branch: `kit/${id}` }, lane: emptyLane(), turn: over.working ? { status: "", startedAt: 1 } : null, asks: over.asks ?? [] });
}

const key = (id: string) => `session:${id}`;
const ids = (xs: readonly { row: LaneRow }[]) => xs.map((x) => x.row.id);

describe("the band's order, which the menu lists", () => {
  // given newest first, as the sessions list them: a lane that asks though it was snoozed, a helper of s1, a job's two lanes (the
  // older one started first), a pinned lane, the helper's lead, a settled lane, a snoozed one and an archived one
  const rows = (): LaneRow[] => [
    lane("s9", "Thai date format", { asks: ["Which year should customers see?"] }),
    lane("s5", "Part 1", { helperOf: { lead: "s1", index: 0 }, startedAt: 5_000 }),
    lane("s3", "Add the QR (Codex)", { job: "j1", startedAt: 3_000 }),
    lane("s4", "Add the QR (Claude Code)", { job: "j1", startedAt: 2_000 }),
    lane("s2", "Stock sync with Shopee"),
    lane("s1", "PromptPay QR at checkout", { startedAt: 1_000 }),
    lane("s6", "Old receipts"),
    lane("s7", "Later work"),
    lane("s8", "Put away"),
  ];
  const marks: RowMarks = {
    [key("s2")]: { pinned: NOW - 10 },
    [key("s6")]: { settled: true, why: "quiet", days: 3 },
    [key("s7")]: { snoozed: LATER },
    [key("s8")]: { archived: NOW - 5 },
    // snoozed, but it asks: an ask is never put away (rows.ts placeOf)
    [key("s9")]: { snoozed: LATER },
  };

  it("is pinned first, then the rest as given with a job's lanes where its first stands and a helper under its lead, then the settled; snoozed and archived lanes are left out", () => {
    const order = laneOrder(rows(), marks, NOW);
    expect(ids(order)).toEqual(["s2", "s9", "s4", "s3", "s1", "s5", "s6"]);
    expect(order.map((x) => x.place)).toEqual(["pinned", "normal", "normal", "normal", "normal", "normal", "settled"]);
    expect(order.filter((x) => x.helper).map((x) => x.row.id)).toEqual(["s5"]);
  });

  it("is the very order the Lanes band draws, with every job's lanes shown", () => {
    const html = renderToString(createElement(LanesView, { rows: rows(), now: NOW, onOpen: vi.fn(), marks, jobOpen: ["j1"] }));
    // the lanes the band lists above its line for the put-away ones (which it keeps shut)
    const drawn = [...html.matchAll(/data-testid="lane-(s\d+)"/g)].map((m) => m[1]);
    expect(drawn).toEqual(ids(laneOrder(rows(), marks, NOW)));
  });
});

describe("the menu's groups", () => {
  const A = "/w/api";
  const B = "/w/web";
  const C = "/w/docs";
  const lanes = () => [
    { project: B, row: lane("b1", "Checkout page", { cwd: B }) },
    { project: A, row: lane("a1", "Rate limits", { cwd: A }) },
    { project: C, row: lane("c1", "Typos", { cwd: C }) },
    { project: A, row: lane("a2", "Webhooks", { cwd: A }) },
  ];

  it("lead with the project the Code page shows, then keep the Code page's order", () => {
    const groups = menuLaneGroups(lanes(), [B, A, C], A, {}, NOW);
    expect(groups.map((g) => g.project)).toEqual([A, B, C]);
    expect(groups.map((g) => g.name)).toEqual(["api", "web", "docs"]);
    expect(menuLaneIds(groups)).toEqual(["a1", "a2", "b1", "c1"]);
  });

  it("keep the Code page's order when it shows no project, or one with no lane listed", () => {
    expect(menuLaneGroups(lanes(), [B, A, C], null, {}, NOW).map((g) => g.project)).toEqual([B, A, C]);
    expect(menuLaneGroups(lanes(), [B, A, C], "/w/empty", {}, NOW).map((g) => g.project)).toEqual([B, A, C]);
  });

  it("list a lane of a folder the Code page does not name yet last, and draw no group whose lanes are all put away", () => {
    const more = [...lanes(), { project: "/w/new", row: lane("n1", "New folder", { cwd: "/w/new" }) }];
    expect(menuLaneGroups(more, [B, A], null, {}, NOW).map((g) => g.project)).toEqual([B, A, C, "/w/new"]);
    const away: RowMarks = { [key("c1")]: { archived: NOW - 1 } };
    expect(menuLaneGroups(lanes(), [B, A, C], null, away, NOW).map((g) => g.project)).toEqual([B, A]);
  });

  it("are read from the stores: every project's lanes, the projects in the order their sessions are listed, drafts and terminals counted for the order and never listed", () => {
    const rec = (id: string, cwd: string, status: SessionRec["status"] = "running") => ({ id, agent: "claude", cwd, startedAt: 1, view: "chat", status, promptTitle: `Lane ${id}` }) as SessionRec;
    const stores: LaneStores = {
      // newest first: a draft in docs, a lane in web, a terminal in api, a lane in api, a lane in web
      ss: { list: [rec("d1", C, "draft"), rec("s3", B), rec("t1", A), rec("s2", A), rec("s1", B)], agents: null, live: {} },
      app: { chats: {} } as unknown as AppState,
      backs: {},
      // a terminal has no chat to read a lane from
      chatKey: (id) => (id.startsWith("s") ? `agent:${id}` : null),
    };
    const shown = menuLanesFrom(stores, {}, null, NOW);
    expect(shown.map((g) => g.project)).toEqual([B, A]);
    expect(menuLaneIds(shown)).toEqual(["s3", "s1", "s2"]);
    // the project picked on the Code page leads
    expect(menuLaneIds(menuLanesFrom(stores, {}, A, NOW))).toEqual(["s2", "s3", "s1"]);
  });
});

describe("the previous and next lane", () => {
  const order = ["a1", "a2", "b1", "c1"];

  it("step through the menu's order and wrap at both ends", () => {
    expect(stepSession(order, "a2", 1)).toBe("b1");
    expect(stepSession(order, "b1", -1)).toBe("a2");
    expect(stepSession(order, "c1", 1)).toBe("a1");
    expect(stepSession(order, "a1", -1)).toBe("c1");
  });

  it("start from the first or the last when no lane is open, or a terminal is", () => {
    expect(stepSession(order, null, 1)).toBe("a1");
    expect(stepSession(order, null, -1)).toBe("c1");
    expect(stepSession(order, "t1", 1)).toBe("a1");
    expect(stepSession([], null, 1)).toBeNull();
  });

  it("keep one cycle across projects, since opening a lane does not reorder the groups", () => {
    // the groups depend on the project the Code page shows, never on the lane open: stepping from every lane in turn visits each once
    const groups = menuLaneGroups(
      [
        { project: "/w/a", row: lane("a1", "A1", { cwd: "/w/a" }) },
        { project: "/w/b", row: lane("b1", "B1", { cwd: "/w/b" }) },
        { project: "/w/c", row: lane("c1", "C1", { cwd: "/w/c" }) },
        { project: "/w/a", row: lane("a2", "A2", { cwd: "/w/a" }) },
      ],
      ["/w/a", "/w/b", "/w/c"],
      "/w/b",
      {},
      NOW,
    );
    const seen: string[] = [];
    let at: string | null = null;
    for (let i = 0; i < 4; i++) seen.push((at = stepSession(menuLaneIds(groups), at, 1)!));
    expect(seen).toEqual(["b1", "a1", "a2", "c1"]);
    expect(stepSession(menuLaneIds(groups), at, 1)).toBe("b1");
  });
});
