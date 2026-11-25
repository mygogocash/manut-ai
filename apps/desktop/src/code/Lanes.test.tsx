// Kit's lanes on the Code page, drawn with react-dom/server from props, and its buttons read from the elements it returns
// (the view uses no hooks). The project is the canvas's baanmali-preorder, and the lanes are the canvas's.
import { createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LANGS, setLang, t } from "../i18n";
import { emptyLane, noteLane, type LaneRecord } from "./lane";
import { sessionRowKey, type RowMarks } from "../sidebar/rows";
import { LanesView, laneBase, laneRowOf, type LaneRow, type LaneRowInput } from "./Lanes";

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

  it("shows the folder of its own the lane works in, which its main-moved note reads", () => {
    const dir = "/Users/fon/.manut/lanes/baanmali-preorder/promptpay-qr";
    const r = row({ rec: { ...input().rec, lane: { name: "kit/promptpay-qr", base: "main", dir, worktree: dir } } });
    expect(r.branch).toEqual({ name: "kit/promptpay-qr", kind: "own", base: "main", dir });
    expect(r.dir).toBe(dir);
    // a lane with no folder of its own works in the session's
    expect(row().dir).toBeNull();
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
  // a lane's menu keeps state of its own (item 76: Pin, Snooze, Done for now, Archive), so it is drawn by its own test and not called here
  if (typeof el.type === "function") return el.type.name === "LaneMore" ? [] : drawn((el.type as (props: unknown) => ReactNode)(el.props));
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

  it("draws New lane in the band, with the lanes under it, and presses it", () => {
    const onNew = vi.fn();
    const els = drawn(LanesView({ rows: canvas(), now: 100_000, onOpen: vi.fn(), onNew }));
    const link = els.filter((e) => e.props["data-testid"] === "lane-new");
    expect(link).toHaveLength(1);
    expect(link[0].type).toBe("button");
    expect(link[0].props.className).toBe("lk");
    expect(link[0].props.title).toBe("Start a lane: choose an agent and a folder. It starts with your first message.");
    (link[0].props.onClick as () => void)();
    expect(onNew).toHaveBeenCalledTimes(1);
    const out = renderToString(createElement(LanesView, { rows: canvas(), now: 100_000, onOpen: vi.fn(), onNew }));
    expect(out).toContain("New lane");
    expect(out.indexOf("New lane")).toBeLessThan(out.indexOf('data-testid="lanes"'));
  });

  it("draws the band with only New lane while the project has no lane, since a person with none needs it most", () => {
    const out = renderToString(createElement(LanesView, { rows: [], now: 100_000, onOpen: vi.fn(), onNew: vi.fn() }));
    expect(out).toContain("Lanes");
    expect(out).toContain("New lane");
    expect(out).not.toContain('data-testid="lanes"');
  });

  it("has no link, and no band for no lane, where the page gives it nothing to open", () => {
    expect(drawn(LanesView({ rows: canvas(), now: 100_000, onOpen: vi.fn() })).filter((e) => e.props["data-testid"] === "lane-new")).toHaveLength(0);
  });

  it("names New lane in every language", () => {
    for (const lang of LANGS) {
      setLang(lang);
      const out = renderToString(createElement(LanesView, { rows: [], now: 100_000, onOpen: vi.fn(), onNew: vi.fn() }));
      expect(out, lang).toContain(t("lane.new"));
      expect(out, lang).toContain(t("lane.newTip"));
    }
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

  it("says what its branch is: made from where and in which folder, moved, or the folder's own", () => {
    const title = (r: LaneRow) => byId([r], "lane-branch")[0].props.title as string;
    expect(title(laneRowOf(input()))).toBe("Made from main. Kit never pushes or merges from here.");
    const dir = "/Users/fon/.manut/lanes/baanmali-preorder/promptpay-qr";
    expect(title(laneRowOf(input({ rec: { ...input().rec, lane: { name: "kit/promptpay-qr", base: "main", dir, worktree: dir } } })))).toBe(
      `Made from main, in a folder of its own: ${dir}. Kit never pushes or merges from here.`,
    );
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

describe("the branch a lane's main-moved note reads", () => {
  it("is the lane's own branch and the one it was made from, while the folder is on it", () => {
    expect(laneBase(laneRowOf(input()))).toEqual({ branch: "kit/promptpay-qr", base: "main" });
    // in its own folder, read for the branch it was made from
    const dir = "/Users/fon/.manut/lanes/baanmali-preorder/promptpay-qr";
    expect(laneBase(laneRowOf(input({ rec: { ...input().rec, lane: { name: "kit/promptpay-qr", base: "develop", dir, worktree: dir } } })))).toEqual({ branch: "kit/promptpay-qr", base: "develop" });
  });

  it("is none for a lane with no branch of its own, and for one whose branch the folder has left", () => {
    expect(laneBase(laneRowOf(input({ rec: { ...input().rec, lane: undefined }, live: { branch: "main" } })))).toBeNull();
    expect(laneBase(laneRowOf(input({ rec: { ...input().rec, lane: undefined }, live: {} })))).toBeNull();
    // the shell answers for the checked-out branch, which is not this lane's
    expect(laneBase(laneRowOf(input({ live: { branch: "main" } })))).toBeNull();
  });
});

describe("Bring it back on a lane's row", () => {
  /** A lane a Rewind took back to a named message, whose files the shell still keeps. */
  const rewound = feed([...tests(true, PASS14), { event: "rewound", id: "m-1", text: "PromptPay QR at checkout" }]);
  const row = (over: Partial<LaneRowInput> = {}) => laneRowOf(input({ lane: rewound, canBringBack: true, ...over }), (ms) => `at ${ms}`);
  const under = (r: LaneRow) => createElement("p", { "data-testid": "under" }, `under ${r.id}`);
  const view = (rows: LaneRow[], over: Partial<Parameters<typeof LanesView>[0]> = {}) => ({ rows, now: 100_000, onOpen: vi.fn(), ...over });

  it("is offered on a lane a Rewind put the files back for, while the shell keeps them", () => {
    expect(row()).toMatchObject({ status: "reverted", canBringBack: true });
    expect(row().line).toEqual({ key: "lane.line.revertedFiles", vars: { time: "at 1002" } });
  });

  it("is not offered once the shell keeps nothing, after the agent's own rewind (which left the files), or on a lane that is not reverted", () => {
    expect(row({ canBringBack: false }).canBringBack).toBe(false);
    expect(row({ canBringBack: undefined }).canBringBack).toBe(false);
    expect(row({ lane: feed([...tests(true, PASS14), { event: "rewound" }]) })).toMatchObject({ status: "reverted", canBringBack: false });
    expect(laneRowOf(input({ lane: feed(tests(true, PASS14)), canBringBack: true })).canBringBack).toBe(false);
    // a turn that is running replaces Reverted, so nothing is offered then either
    expect(row({ turn: { status: "Reading the code", startedAt: 1 } })).toMatchObject({ status: "working", canBringBack: false });
  });

  it("reads by its tests after the files came back, and says the chat did not", () => {
    const back = feed([...tests(true, PASS14), { event: "rewound", id: "m-1" }, { event: "files.back" }]);
    const r = laneRowOf(input({ lane: back, canBringBack: false }), (ms) => `at ${ms}`);
    expect(r.status).toBe("not_run");
    expect(r.line).toEqual({ key: "lane.line.broughtBack", vars: { time: "at 1003" } });
    expect(r.canBringBack).toBe(false);
    expect(html([r])).toContain("You brought the files back at");
    expect(html([r])).toContain("The chat stays where the rewind left it.");
    expect(html([r])).not.toContain("Bring it back");
  });

  it("draws Bring it back at the end of the Reverted line, and opens or shuts the panel from it", () => {
    const onBack = vi.fn();
    const link = (open: string | null) => drawn(LanesView(view([row()], { onBack, backOpen: open }))).filter((e) => e.props["data-testid"] === "lane-back");
    expect(link(null)).toHaveLength(1);
    expect(link(null)[0].props["aria-expanded"]).toBe(false);
    expect(link("s1")[0].props["aria-expanded"]).toBe(true);
    (link(null)[0].props.onClick as () => void)();
    expect(onBack).toHaveBeenCalledWith("s1");
    const out = renderToString(createElement(LanesView, view([row()])));
    expect(out).toContain("You rewound this turn at at 1002. The files are back as they were.");
    expect(out).toContain("Bring it back");
  });

  it("draws no link for a lane that cannot bring its files back", () => {
    const rows = [row({ canBringBack: false }), laneRowOf(input({ lane: feed(tests(true, PASS14)) }))];
    expect(drawn(LanesView(view(rows))).filter((e) => e.props["data-testid"] === "lane-back")).toHaveLength(0);
    expect(renderToString(createElement(LanesView, view(rows)))).not.toContain("Bring it back");
  });

  it("draws what the page puts under each row, under that row", () => {
    const other = laneRowOf(input({ rec: { id: "s2", agent: "claude", cwd: "/x", status: "running", promptTitle: "Thai date format", lane: { name: "kit/thai-date-format", base: "main" } }, live: { branch: "kit/thai-date-format" } }));
    const els = drawn(LanesView(view([row(), other], { below: under })));
    expect(els.filter((e) => e.props["data-testid"] === "under").map((e) => e.props.children)).toEqual(["under s1", "under s2"]);
  });

  it("says its words in Korean, Japanese and Chinese", () => {
    for (const [lang, words] of [["ko", "되살리기"], ["ja", "復元する"], ["zh", "找回"]] as const) {
      setLang(lang);
      expect(renderToString(createElement(LanesView, view([row()]))), lang).toContain(words);
    }
    setLang("zh");
    const back = laneRowOf(input({ lane: feed([...tests(true, PASS14), { event: "rewound", id: "m-1" }, { event: "files.back" }]) }), (ms) => `at ${ms}`);
    expect(html([back])).toContain("聊天仍停留在回退后的位置。");
  });
});

describe("pinned, settled, snoozed and archived lanes (item 76)", () => {
  const NOW = 100_000;
  const ids = (marks: RowMarks, over: { away?: boolean } = {}) => {
    const out = renderToString(createElement(LanesView, { rows: canvas(), now: NOW, onOpen: vi.fn(), marks, ...over }));
    return [...out.matchAll(/data-testid="lane-(s\d)"/g)].map((m) => m[1]);
  };

  it("keeps the order it was given when nothing is marked", () => {
    expect(ids({})).toEqual(["s1", "s2", "s3"]);
  });

  it("puts a pinned lane on top, in the order pinned, and a settled one last", () => {
    expect(ids({ [sessionRowKey("s3")]: { pinned: 2 }, [sessionRowKey("s2")]: { pinned: 1 } })).toEqual(["s2", "s3", "s1"]);
    expect(ids({ [sessionRowKey("s1")]: { settled: true } })).toEqual(["s2", "s3", "s1"]);
  });

  it("puts a snoozed and an archived lane away behind one line that counts them, and shows them when it is open", () => {
    const marks: RowMarks = { [sessionRowKey("s1")]: { snoozed: NOW + 60_000 }, [sessionRowKey("s2")]: { archived: 5 } };
    expect(ids(marks)).toEqual(["s3"]);
    const closed = renderToString(createElement(LanesView, { rows: canvas(), now: NOW, onOpen: vi.fn(), marks }));
    expect(closed).toContain("Snoozed and archived (2)");
    expect(closed).toContain('data-testid="lane-away"');
    expect(closed).not.toContain('data-testid="lane-away-s1"');
    expect(ids(marks, { away: true })).toEqual(["s3", "s1", "s2"]);
  });

  it("never puts away a lane that asks something: the Needs you lane stays in its place, snoozed or settled", () => {
    const marks: RowMarks = { [sessionRowKey("s3")]: { snoozed: NOW + 60_000 }, [sessionRowKey("s1")]: { settled: true } };
    expect(ids(marks)).toEqual(["s2", "s3", "s1"]);
    expect(renderToString(createElement(LanesView, { rows: canvas(), now: NOW, onOpen: vi.fn(), marks }))).not.toContain("lane-away");
  });

  it("marks a pinned lane with its pin and a settled one as settled", () => {
    const out = renderToString(createElement(LanesView, { rows: canvas(), now: NOW, onOpen: vi.fn(), marks: { [sessionRowKey("s1")]: { pinned: 1 }, [sessionRowKey("s2")]: { settled: true } } }));
    expect(out).toContain('data-testid="lane-pin"');
    expect(out).toMatch(/class="lane settled"[^>]*data-testid="lane-s2"/);
  });
});
