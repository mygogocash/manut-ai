// The pane beside a lane (src/code/LanePane.tsx, the design canvas's Code board, "What to look at"): the chips Diff, Preview and
// Tests, and what each shows. Drawn with react-dom/server from props, and its buttons read from the elements it returns (the view
// uses no hooks). The project is the canvas's baanmali-preorder, and the numbers are the canvas's (14 tests, `src/checkout.tsx`
// +6 -1).
import { createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLang } from "../i18n";
import type { DiffFile } from "../lib/protocol";
import { emptyLane, laneTests, noteLane, type LaneRecord } from "./lane";
import { isLaneChat } from "./laneStore";
import type { Need } from "./preview";

// A diff scrolls itself into view when it opens, by an effect that no server render runs: the two hooks it uses are stood in for, a ref
// whose element records the scroll and a layout effect that runs at once, so the pane can be seen not to scroll (it is not opened by a click).
const scrolled = vi.fn();
vi.mock("react", async (importOriginal) => {
  const react = await importOriginal<typeof import("react")>();
  return {
    ...react,
    useRef: () => ({ current: { scrollIntoView: scrolled } }),
    useLayoutEffect: (effect: () => void) => {
      effect();
    },
  };
});

const { LanePaneView } = await import("./LanePane");
type LanePaneProps = Parameters<typeof LanePaneView>[0];

const KEY = "sk-FAKE0000000000000000TEST";
const SHOP: Need = { name: "PROMPTPAY_SHOP_ID", kind: "shop_id" };
const STRIPE: Need = { name: "STRIPE_SECRET_KEY", kind: "key" };

const file = (path: string, lines: string[], added: number, removed = 0, kind: DiffFile["kind"] = "update"): DiffFile => ({ path, kind, lines: ["@@ -12,3 +12,9 @@", ...lines], added, removed });
const CHECKOUT = file("src/checkout.tsx", ["   const total = order.items.reduce(sum, 0);", "-  return <PayByTransfer amount={total} />;", "+  const qr = promptPayQR(SHOP_ID, total);"], 6, 1);
const PROMPTPAY = file("src/promptpay.ts", ["+export function promptPayQR(id: string, amount: number) {", "+  return `00020101${id}${amount}`;", "+}"], 38, 0, "add");

type Ev = { event: string; [k: string]: unknown };
const feed = (events: Ev[]): LaneRecord => events.reduce((lane, ev, i) => noteLane(lane, ev, new Date(2026, 10, 25, 10, 2, i).getTime()), emptyLane());
const ran = (command: string, ok: boolean, output?: string): Ev[] => [
  { event: "tool.start", tool_id: "t1", name: "terminal", detail: command },
  { event: "tool.end", tool_id: "t1", name: "", ok, ms: 40, ...(output === undefined ? {} : { output }) },
];
const PASS14 = " Test Files  2 passed (2)\n      Tests  14 passed (14)\n";
const FAIL1 = " FAIL  tests/promptpay.test.ts > locks the amount into the QR\n      Tests  1 failed | 13 passed (14)\n";

const props = (over: Partial<LanePaneProps> = {}): LanePaneProps => ({
  view: "diff",
  onView: vi.fn(),
  files: [],
  needs: [],
  asked: null,
  onAdd: vi.fn(),
  tests: laneTests(emptyLane()),
  time: (ms) => `${new Date(ms).getHours()}:${String(new Date(ms).getMinutes()).padStart(2, "0")}`,
  ...over,
});

function drawn(node: ReactNode): ReactElement<Record<string, unknown>>[] {
  if (Array.isArray(node)) return node.flatMap(drawn);
  if (!isValidElement(node)) return [];
  const el = node as ReactElement<Record<string, unknown>>;
  if (typeof el.type === "function") return drawn((el.type as (props: unknown) => ReactNode)(el.props));
  return [...(typeof el.type === "string" ? [el] : []), ...drawn(el.props.children as ReactNode)];
}
const byId = (p: LanePaneProps, id: string) => drawn(LanePaneView(p)).filter((e) => e.props["data-testid"] === id);
const html = (p: LanePaneProps) => renderToString(createElement(LanePaneView, p));
/** The text the pane says, once its markup is gone (the server's markers between two pieces of text too). */
const words = (p: LanePaneProps) => html(p).replace(/<!-- -->/g, "").replace(/<[^>]*>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ");

beforeEach(() => scrolled.mockClear());
afterEach(() => setLang("en"));

describe("which chats are a lane's", () => {
  it("are the coding sessions that run as a chat in the app, and no other", () => {
    expect(isLaneChat("agent:s1")).toBe(true);
    expect(isLaneChat("agent:0d9a-77")).toBe(true);
    // a bot's own chat, a thread, a Hermes folder chat, and no chat at all
    for (const key of ["kami", "thread:kami/t1", "folder:/Users/fon/shop", "omh-tui", "agentx:s1", " agent:s1", "", null, undefined]) {
      expect(isLaneChat(key), String(key)).toBe(false);
    }
  });
});

describe("the pane's three chips", () => {
  it("are Diff, Preview and Tests, in the group the canvas names What to look at", () => {
    const out = html(props());
    expect(out).toContain('aria-label="What to look at"');
    const chips = ["diff", "preview", "tests"].map((v) => byId(props(), `lane-chip-${v}`)[0]);
    expect(chips.map((c) => (c.props.children as string))).toEqual(["Diff", "Preview", "Tests"]);
    expect(out.indexOf("Diff")).toBeLessThan(out.indexOf("Preview"));
    expect(out.indexOf("Preview")).toBeLessThan(out.indexOf("Tests"));
  });

  it("press the one that is shown, Diff when nothing was picked", () => {
    const pressed = (view: LanePaneProps["view"]) => ["diff", "preview", "tests"].filter((v) => byId(props({ view }), `lane-chip-${v}`)[0].props["aria-pressed"] === true);
    expect(pressed("diff")).toEqual(["diff"]);
    expect(pressed("preview")).toEqual(["preview"]);
    expect(pressed("tests")).toEqual(["tests"]);
  });

  it("pick their view when pressed, and are buttons that submit nothing", () => {
    for (const v of ["diff", "preview", "tests"] as const) {
      const p = props();
      const chip = byId(p, `lane-chip-${v}`)[0];
      expect(chip.type).toBe("button");
      expect(chip.props.type).toBe("button");
      (chip.props.onClick as () => void)();
      expect(p.onView).toHaveBeenCalledWith(v);
    }
  });

  it("show one view at a time, and say which in the pane's own mark", () => {
    // what each view says when it has nothing to show: said by that view alone
    const says = { diff: "lane-diff-none", preview: "lane-preview-note", tests: "lane-tests-none" } as const;
    for (const view of ["diff", "preview", "tests"] as const) {
      const out = html(props({ view }));
      expect(out).toContain(`data-view="${view}"`);
      for (const other of ["diff", "preview", "tests"] as const) {
        expect(out.includes(`data-testid="lane-view-${other}"`), `${view} holds the ${other} view`).toBe(other === view);
        expect(out.includes(`data-testid="${says[other]}"`), `${view} shows what ${other} says`).toBe(other === view);
      }
    }
  });
});

describe("Diff", () => {
  it("says Kit has changed no file yet when it has changed none", () => {
    const out = words(props());
    expect(out).toContain("Kit has not changed any file yet.");
    expect(byId(props(), "lane-diff-none")).toHaveLength(1);
    expect(html(props())).not.toContain("lane-diff-file");
  });

  it("shows each file the session changed with its added and removed counts, in the order given", () => {
    const out = html(props({ files: [CHECKOUT, PROMPTPAY] }));
    expect(out.match(/data-testid="lane-diff-file"/g)).toHaveLength(2);
    expect(out.indexOf("src/checkout.tsx")).toBeLessThan(out.indexOf("src/promptpay.ts"));
    expect(words(props({ files: [CHECKOUT] }))).toContain("src/checkout.tsx +6 −1");
    expect(words(props({ files: [PROMPTPAY] }))).toContain("src/promptpay.ts new +38");
    expect(words(props({ files: [CHECKOUT] }))).not.toContain("Kit has not changed any file yet.");
  });

  it("draws the changes as the timeline draws them: the added and removed lines, and the lines about them", () => {
    const out = html(props({ files: [CHECKOUT] }));
    expect(out).toContain('class="dv-l add"');
    expect(out).toContain('class="dv-l del"');
    expect(out).toContain('class="dv-l ctx"');
    expect(out).toContain("const qr = promptPayQR(SHOP_ID, total);");
    expect(out).toContain('class="dv-l hunk"');
  });

  it("does not scroll itself into view, as a diff opened by a click does: nothing opened this one", () => {
    html(props({ files: [CHECKOUT] }));
    expect(scrolled).not.toHaveBeenCalled();
  });

  it("has its own ids, so the timeline's diffs are the only ones the chat's own ids count", () => {
    const out = html(props({ files: [CHECKOUT] }));
    expect(out).toContain('data-testid="lane-diff-view"');
    expect(out).toContain('data-testid="lane-diff-body"');
    for (const own of ["diff-view", "diff-file", "diff-body"]) expect(out.includes(`data-testid="${own}"`), own).toBe(false);
  });

  it("hides a key in a changed line, as the timeline does", () => {
    const keyed = file("src/config.ts", [`+export const PROMPTPAY_KEY = "${KEY}";`, `-export const OLD = "${KEY}";`], 1, 1);
    const out = html(props({ files: [keyed] }));
    expect(out).not.toContain(KEY);
    expect(out).not.toContain("sk-FAKE");
    expect(out).toContain("••••");
    // a key typed into a context line is hidden too
    const ctx = file("src/config.ts", [` const k = "${KEY}";`, "+x"], 1);
    expect(html(props({ files: [ctx] }))).not.toContain(KEY);
  });

  it("says how many lines of a long change were not sent", () => {
    expect(words(props({ files: [{ ...CHECKOUT, more: 40 }] }))).toContain("40 more lines");
  });
});

describe("Preview", () => {
  const preview = (over: Partial<LanePaneProps> = {}) => props({ view: "preview", ...over });

  it("says the preview does not run in the app yet, with or without a secret to show", () => {
    expect(words(preview())).toContain("The preview does not run in the app yet.");
    expect(words(preview({ needs: [SHOP] }))).toContain("The preview does not run in the app yet.");
    expect(byId(preview(), "lane-preview-note")).toHaveLength(1);
  });

  it("shows a Sample row for each secret Kit's changed code reads, as the Code page does", () => {
    const out = words(preview({ needs: [SHOP, STRIPE] }));
    expect(out).toContain("Sample");
    expect(out).toContain("The preview has no shop ID yet, so the QR code is a sample.");
    expect(out).toContain("Add the shop ID");
    expect(out).toContain("The preview has no value for STRIPE_SECRET_KEY yet, so what needs it is a sample.");
    expect(byId(preview({ needs: [SHOP, STRIPE] }), "kit-sample")).toHaveLength(2);
  });

  it("shows no Sample row when the code reads no secret, and does not name the band that the chip already names", () => {
    expect(byId(preview(), "kit-sample")).toHaveLength(0);
    expect(html(preview({ needs: [SHOP] }))).not.toContain('class="band"');
  });

  it("answers Add the shop ID with the vault's note under that secret only, and nothing is added", () => {
    const p = preview({ needs: [SHOP, STRIPE] });
    (byId(p, "kit-sample-add")[0].props.onClick as () => void)();
    expect(p.onAdd).toHaveBeenCalledWith("PROMPTPAY_SHOP_ID");
    expect(words(preview({ needs: [SHOP, STRIPE] }))).not.toContain("comes later");
    const asked = words(preview({ needs: [SHOP, STRIPE], asked: "PROMPTPAY_SHOP_ID" }));
    expect(asked).toContain("The vault for a project's secrets comes later.");
    expect(html(preview({ needs: [SHOP, STRIPE], asked: "PROMPTPAY_SHOP_ID" })).match(/data-testid="kit-sample-vault"/g)).toHaveLength(1);
  });

  it("starts nothing: the only buttons are the chips and Add", () => {
    const buttons = drawn(LanePaneView(preview({ needs: [SHOP, STRIPE] }))).filter((e) => e.type === "button");
    expect(buttons.map((b) => b.props["data-testid"])).toEqual(["lane-chip-diff", "lane-chip-preview", "lane-chip-tests", "kit-sample-add", "kit-sample-add"]);
    expect(html(preview({ needs: [SHOP] }))).not.toMatch(/<(iframe|webview|form|a )/);
  });

  it("never shows a sample value or a secret's value: only the name", () => {
    const out = html(preview({ needs: [SHOP, STRIPE] }));
    expect(out).not.toContain("0000000000");
    expect(out).not.toContain("sample-value");
  });
});

describe("Tests", () => {
  const tests = (events: Ev[]) => props({ view: "tests", tests: laneTests(feed(events)) });

  it("says no tests have run when the lane has run none", () => {
    expect(words(props({ view: "tests" }))).toContain("No tests have run in this lane yet.");
    expect(byId(props({ view: "tests" }), "lane-tests-none")).toHaveLength(1);
    expect(html(props({ view: "tests" }))).not.toContain("lane-tests-last");
    // and no box for a run in progress either
    expect(html(props({ view: "tests" }))).not.toContain("lane-tests-running");
  });

  it("shows a run that passed: its command, how many passed, and when it finished", () => {
    const p = tests(ran("pnpm test", true, PASS14));
    const out = words(p);
    expect(out).toContain("$ pnpm test");
    expect(out).toContain("14 tests passed.");
    expect(out).toContain("Finished at 10:02.");
    expect(byId(p, "lane-tests-result")[0].props["data-tone"]).toBe("ok");
    expect(html(p)).not.toContain("lane-tests-stale");
    expect(html(p)).not.toContain("lane-tests-why");
    expect(html(p)).not.toContain("lane-tests-names");
    expect(html(p)).not.toContain("lane-tests-running");
  });

  it("shows a run that failed: how many of how many, and the failing test by its name", () => {
    const p = tests(ran("pnpm test", false, FAIL1));
    const out = words(p);
    expect(out).toContain("1 of 14 tests failed. Nothing is live.");
    expect(byId(p, "lane-tests-result")[0].props["data-tone"]).toBe("err");
    expect(byId(p, "lane-tests-names")).toHaveLength(1);
    expect(out).toContain("locks the amount into the QR");
    expect(out).not.toContain("and 0 more");
  });

  it("counts the failing tests it does not name", () => {
    const many = Array.from({ length: 12 }, (_, i) => ` FAIL  a.test.ts > case ${i}`).join("\n");
    const out = words(tests(ran("vitest run", false, `${many}\n      Tests  12 failed (14)\n`)));
    expect(out).toContain("case 9");
    expect(out).not.toContain("case 10");
    expect(out).toContain("and 2 more");
  });

  it("shows a run that could not be read as not confirmed, with why in words, and marks nothing as passed", () => {
    const out = words(tests(ran("pnpm test", true, "all done")));
    expect(out).toContain("Kit ran the tests, but the result could not be read. Nothing is marked as passed.");
    expect(out).toContain("What it printed has no test summary that the app can read.");
    // the sentences that say tests passed are not there: only the one that says nothing is marked as passed
    expect(out).not.toMatch(/\d+ tests? passed\.|The tests passed\./);
    const none = tests(ran("pnpm test", true));
    expect(words(none)).toContain("The agent did not hand on what the run printed.");
    expect(byId(none, "lane-tests-result")[0].props["data-tone"]).toBe("");
    // a run whose output says it passed but whose command ended in an error is no pass either
    expect(words(tests(ran("pnpm test", false, PASS14)))).toContain("The command ended with an error.");
  });

  it("says a file changed since, so the result is of older code, and keeps the result", () => {
    const p = tests([...ran("pnpm test", true, PASS14), { event: "tool.diff", tool_id: "e1", files: [] }]);
    const out = words(p);
    expect(out).toContain("A file changed after this run, so the result is of older code.");
    expect(out).toContain("14 tests passed.");
    expect(byId(p, "lane-tests-stale")).toHaveLength(1);
  });

  it("says a run is in progress with its command, above the last result", () => {
    const p = tests([...ran("pnpm test", true, PASS14), { event: "tool.start", tool_id: "t2", name: "terminal", detail: "vitest run src/promptpay.test.ts" }]);
    const out = words(p);
    expect(out).toContain("A test run is in progress.");
    expect(out).toContain("$ vitest run src/promptpay.test.ts");
    expect(out).toContain("14 tests passed.");
    expect(html(p).indexOf("lane-tests-running")).toBeLessThan(html(p).indexOf("lane-tests-last"));
    // with no run behind it, it is the only thing there, and the lane has not said it ran none
    const first = tests([{ event: "tool.start", tool_id: "t2", name: "terminal", detail: "pnpm test" }]);
    expect(words(first)).toContain("A test run is in progress.");
    expect(words(first)).not.toContain("No tests have run in this lane yet.");
    expect(html(first)).not.toContain("lane-tests-last");
  });

  it("never shows a key: not in the command that ran, nor the one that runs, nor a test's name", () => {
    const named = ` FAIL  a.test.ts > sends ${KEY} to the api\n      Tests  1 failed (1)\n`;
    const out = html(tests([...ran(`API_KEY=${KEY} pnpm test`, false, named), { event: "tool.start", tool_id: "t2", name: "terminal", detail: `vitest run --token ${KEY}` }]));
    expect(out).not.toContain(KEY);
    expect(out).not.toContain("sk-FAKE");
    expect(out).toContain("••••");
  });

  it("shows none of the run's output: the lane never kept it", () => {
    const noisy = `${PASS14}\nprinted by a test: a password hunter2-MARKER\n`;
    expect(html(tests(ran("pnpm test", true, noisy)))).not.toContain("MARKER");
  });

  it("shows what the board's Tests box shows, drawn from the result that was read: the command, then the count", () => {
    const out = words(tests(ran("pnpm test", true, PASS14)));
    expect(out.indexOf("$ pnpm test")).toBeLessThan(out.indexOf("14 tests passed."));
  });
});

describe("the pane's words", () => {
  it("are in all four languages, for the chips and for each view", () => {
    const passed = props({ view: "tests", tests: laneTests(feed(ran("pnpm test", true, PASS14))) });
    for (const [lang, chips, line] of [
      ["ko", ["Diff", "미리보기", "테스트"], "테스트 14개가 통과했어요."],
      ["ja", ["Diff", "プレビュー", "テスト"], "テスト 14 件が成功しました。"],
      ["zh", ["Diff", "预览", "测试"], "14 个测试通过。"],
    ] as const) {
      setLang(lang);
      const out = html(passed);
      for (const chip of chips) expect(out, `${lang} ${chip}`).toContain(chip);
      expect(out, lang).toContain(line);
      expect(html(props()), lang).not.toContain("Kit has not changed any file yet.");
      expect(html(props({ view: "preview" })), lang).not.toContain("The preview does not run in the app yet.");
    }
  });
});
