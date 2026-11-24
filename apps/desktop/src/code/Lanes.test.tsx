// Kit's lanes on the Code page, drawn with react-dom/server from props, and its buttons read from the elements it returns
// (the view uses no hooks). The project is the canvas's baanmali-preorder, and the lanes are the canvas's.
import { createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setLang } from "../i18n";
import { emptyLane, noteLane, type LaneRecord } from "./lane";
import { LanesView, laneRowOf, type LaneRow, type LaneRowInput } from "./Lanes";

type Ev = { event: string; [k: string]: unknown };
const feed = (events: Ev[]): LaneRecord => events.reduce((lane, ev, i) => noteLane(lane, ev, 1_000 + i), emptyLane());
const tests = (ok: boolean, output: string): Ev[] => [
  { event: "tool.start", tool_id: "t1", name: "terminal", detail: "pnpm test" },
  { event: "tool.end", tool_id: "t1", name: "", ok, ms: 40, output },
];
const PASS14 = " Test Files  2 passed (2)\n      Tests  14 passed (14)\n";
const FAIL1 = " FAIL  tests/promptpay.test.ts > locks the amount into the QR\n      Tests  1 failed | 13 passed (14)\n";

function input(over: Partial<LaneRowInput> = {}): LaneRowInput {
  return {
    rec: { id: "s1", agent: "claude", cwd: "/Users/fon/baanmali-preorder", status: "running", promptTitle: "PromptPay QR at checkout", lane: { name: "kit/promptpay-qr", base: "main" } },
    agent: "Claude Code",
    live: { branch: "kit/promptpay-qr" },
    lane: emptyLane(),
    turn: null,
    asks: [],
    ...over,
  };
}

describe("a lane's row", () => {
  const row = (over: Partial<LaneRowInput> = {}) => laneRowOf(input(over), (ms) => `at ${ms}`);

  it("is named as the session is: the person's name, the agent's, the first message's, else the folder", () => {
    expect(row().title).toBe("PromptPay QR at checkout");
    expect(row({ rec: { ...input().rec, title: "QR work", promptTitle: "x" } }).title).toBe("QR work");
    expect(row({ rec: { ...input().rec, promptTitle: undefined } }).title).toBe("baanmali-preorder");
  });

  it("shows the branch Kit made for it, and says where it was made from", () => {
    expect(row().branch).toEqual({ name: "kit/promptpay-qr", kind: "own", base: "main" });
  });

  it("shows a branch the lane shares with a lane that was already working", () => {
    expect(row({ rec: { ...input().rec, lane: { name: "kit/promptpay-qr", base: "main", shared: true } } }).branch).toEqual({ name: "kit/promptpay-qr", kind: "shared", base: "main" });
  });

  it("shows the branch the folder is on when that is no longer the lane's", () => {
    expect(row({ live: { branch: "main" } }).branch).toEqual({ name: "main", kind: "moved", base: "main", lane: "kit/promptpay-qr" });
  });

  it("shows the folder's own branch, and says it has none of its own, for a lane that made none", () => {
    expect(row({ rec: { ...input().rec, lane: undefined }, live: { branch: "main" } }).branch).toEqual({ name: "main", kind: "folder" });
  });

  it("shows no branch outside a repository", () => {
    expect(row({ rec: { ...input().rec, lane: undefined }, live: {} }).branch).toBeNull();
    expect(row({ rec: { ...input().rec, lane: undefined }, live: undefined }).branch).toBeNull();
  });

  it("is Checked after a run that passed, with its count in the line", () => {
    const r = row({ lane: feed(tests(true, PASS14)) });
    expect(r.status).toBe("checked");
    expect(r.line).toEqual({ key: "lane.line.checkedN", vars: { n: 14 } });
  });

  it("is Tests failed after a run that failed, and names the test", () => {
    const r = row({ lane: feed(tests(false, FAIL1)) });
    expect(r.status).toBe("tests_failed");
    expect(r.line).toEqual({ key: "lane.line.failedOf", vars: { failed: 1, total: 14 } });
    expect(r.failed).toEqual({ names: ["locks the amount into the QR"], more: 0 });
  });

  it("is Working while a turn runs, with the step it names, when it began, and that it runs tests", () => {
    const turn = { status: "Reading the code", startedAt: 5_000 };
    expect(row({ turn })).toMatchObject({ status: "working", step: "Reading the code", since: 5_000, testing: false, line: { key: "lane.line.working" } });
    const running = feed([{ event: "tool.start", tool_id: "t1", name: "terminal", detail: "pnpm test" }]);
    expect(row({ turn, lane: running })).toMatchObject({ status: "working", testing: true });
    // with no branch of its own it does not say it works on a separate one
    expect(row({ turn, rec: { ...input().rec, lane: undefined } }).line).toEqual({ key: "lane.line.workingHere" });
    expect(row({ turn, live: { branch: "main" }, rec: { ...input().rec, lane: undefined } }).line).toEqual({ key: "lane.line.workingHere" });
  });

  it("is Needs you when an ask waits, and says it", () => {
    expect(row({ asks: ["Which year should customers see?"], turn: { status: "", startedAt: 1 } })).toMatchObject({ status: "needs_you", line: { key: "lane.line.asks", vars: { ask: "Which year should customers see?" } } });
  });

  it("is Reverted after a rewind, with the time", () => {
    const r = row({ lane: feed([...tests(true, PASS14), { event: "rewound" }]) });
    expect(r.status).toBe("reverted");
    expect(r.line).toEqual({ key: "lane.line.reverted", vars: { time: "at 1002" } });
  });

  it("is Failed for a session that ended in an error, with its own words", () => {
    const r = row({ rec: { ...input().rec, status: "failed", error: "Claude Code is not signed in." } });
    expect(r).toMatchObject({ status: "failed", line: null, error: "Claude Code is not signed in." });
    expect(row({ rec: { ...input().rec, status: "exited", error: "boom" } }).status).toBe("failed");
    expect(row({ rec: { ...input().rec, status: "exited" } }).status).toBe("not_run");
  });

  it("is Not confirmed when a run could not be read, and never Checked", () => {
    expect(row({ lane: feed(tests(true, "all done")) }).status).toBe("unconfirmed");
  });
});

// ---- drawn ---------------------------------------------------------------------------------------------------------

function drawn(node: ReactNode): ReactElement<Record<string, unknown>>[] {
  if (Array.isArray(node)) return node.flatMap(drawn);
  if (!isValidElement(node)) return [];
  const el = node as ReactElement<Record<string, unknown>>;
  if (typeof el.type === "function") return drawn((el.type as (props: unknown) => ReactNode)(el.props));
  return [...(typeof el.type === "string" ? [el] : []), ...drawn(el.props.children as ReactNode)];
}
const byId = (rows: LaneRow[], id: string, onOpen = vi.fn()) => drawn(LanesView({ rows, now: 100_000, onOpen })).filter((e) => e.props["data-testid"] === id);
const html = (rows: LaneRow[]) => renderToString(createElement(LanesView, { rows, now: 100_000, onOpen: vi.fn() }));

/** The canvas's Code board: three lanes in baanmali-preorder, each in the state its Lanes band draws. */
const canvas = (): LaneRow[] => [
  laneRowOf(input({ lane: feed(tests(true, PASS14)) })),
  laneRowOf(input({ rec: { id: "s2", agent: "claude", cwd: "/x", status: "running", promptTitle: "Fix stock sync with Shopee", lane: { name: "kit/fix-stock-sync-shopee", base: "main" } }, live: { branch: "kit/fix-stock-sync-shopee" }, turn: { status: "Running the tests", startedAt: 28_000 } })),
  laneRowOf(input({ rec: { id: "s3", agent: "claude", cwd: "/x", status: "running", promptTitle: "Thai date format", lane: { name: "kit/thai-date-format", base: "main" } }, live: { branch: "kit/thai-date-format" }, asks: ["Which year should customers see: 2026 or 2569?"], turn: { status: "", startedAt: 1 } })),
];

afterEach(() => setLang("en"));

describe("the Lanes band", () => {
  it("draws nothing when the project has no lane", () => {
    expect(html([])).toBe("");
  });

  it("draws the canvas's three lanes: Checked, Working with its step and time, and Needs you with Answer Kit", () => {
    const out = html(canvas());
    for (const words of ["Lanes", "PromptPay QR at checkout", "Fix stock sync with Shopee", "Thai date format", "Kit · Claude Code", "kit/promptpay-qr", "kit/fix-stock-sync-shopee", "Checked", "14 tests passed.", "Running the tests", "1m 12s", "Kit works on a separate branch. Nothing is live.", "Needs you", "Kit asks: Which year should customers see: 2026 or 2569?", "Answer Kit"]) expect(out, words).toContain(words);
    expect(byId(canvas(), "lane-state").map((e) => e.props.className)).toEqual(["tag ok", "tag run", "tag warn"]);
  });

  it("draws Tests failed with the test it names, and says what could not be read", () => {
    const failed = html([laneRowOf(input({ lane: feed(tests(false, FAIL1)) }))]);
    for (const words of ["Tests failed", "1 of 14 tests failed. Nothing is live.", "locks the amount into the QR"]) expect(failed, words).toContain(words);
    const unread = html([laneRowOf(input({ lane: feed(tests(true, "all done")) }))]);
    expect(unread).toContain("Not confirmed");
    expect(unread).toContain("Kit ran the tests, but the result could not be read. Nothing is marked as passed.");
    expect(unread).not.toContain("Checked");
  });

  it("draws Reverted and Not run yet in the plain tag, and Failed with the session's own words", () => {
    const reverted = byId([laneRowOf(input({ lane: feed([{ event: "rewound" }]) }))], "lane-state");
    expect(reverted[0].props.className).toBe("tag");
    expect(html([laneRowOf(input({ lane: feed([{ event: "rewound" }]) }))])).toContain("The files stay as they are.");
    expect(html([laneRowOf(input())])).toContain("Not run yet");
    const failed = html([laneRowOf(input({ rec: { ...input().rec, status: "failed", error: "Claude Code is not signed in." } }))]);
    expect(failed).toContain("Failed");
    expect(failed).toContain("Claude Code is not signed in.");
  });

  it("names the failing tests, three at most, and counts the rest", () => {
    const names = Array.from({ length: 5 }, (_, i) => ` FAIL  a.test.ts > case ${i}`).join("\n");
    const out = html([laneRowOf(input({ lane: feed(tests(false, `${names}\n      Tests  5 failed (9)\n`)) }))]);
    expect(out).toContain("case 0");
    expect(out).toContain("case 2");
    expect(out).not.toContain("case 3");
    expect(out).toContain("and 2 more");
  });

  it("opens the lane's session from its row and from Answer Kit", () => {
    const onOpen = vi.fn();
    const rows = canvas();
    const buttons = drawn(LanesView({ rows, now: 100_000, onOpen })).filter((e) => e.type === "button");
    // one row button and, for the lane that needs Kit's answer, the link
    expect(buttons).toHaveLength(4);
    for (const b of buttons) (b.props.onClick as () => void)();
    expect(onOpen.mock.calls.map((c) => c[0])).toEqual(["s1", "s2", "s3", "s3"]);
  });

  it("says what its branch is: made from where, shared, moved, or the folder's own", () => {
    const title = (r: LaneRow) => byId([r], "lane-branch")[0].props.title as string;
    expect(title(laneRowOf(input()))).toBe("Made from main. Kit never pushes or merges from here.");
    expect(title(laneRowOf(input({ rec: { ...input().rec, lane: { name: "kit/promptpay-qr", base: "main", shared: true } } })))).toContain("one checkout");
    expect(title(laneRowOf(input({ live: { branch: "main" } })))).toBe("Kit made kit/promptpay-qr for this lane, but the folder is on main now.");
    expect(title(laneRowOf(input({ rec: { ...input().rec, lane: undefined }, live: { branch: "main" } })))).toContain("no branch of its own");
  });

  it("says its words in Korean, Japanese and Chinese", () => {
    setLang("ko");
    expect(html(canvas())).toContain("확인됨");
    setLang("ja");
    expect(html(canvas())).toContain("確認済み");
    expect(html(canvas())).toContain("テスト 14 件が成功しました。");
    setLang("zh");
    const out = html(canvas());
    expect(out).toContain("已检查");
    expect(out).toContain("Kit 询问：Which year should customers see: 2026 or 2569?");
  });
});
