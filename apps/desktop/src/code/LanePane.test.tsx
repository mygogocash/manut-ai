// The pane beside a lane (src/code/LanePane.tsx, the design canvas's Code board, "What to look at"): the chips Diff, Preview and
// Tests, and what each shows. Drawn with react-dom/server from props, and its buttons read from the elements it returns (the view
// uses no hooks). The project is the canvas's baanmali-preorder, and the numbers are the canvas's (14 tests, `src/checkout.tsx`
// +6 -1).
import { createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLang } from "../i18n";
import type { DiffFile } from "../lib/protocol";
import type { LaneReview } from "./laneFolder";
import type { PaneScopes } from "./PaneDiff";
import { emptyLane, laneTests, noteLane, type LaneRecord } from "./lane";
import { isLaneChat } from "./laneStore";
import type { LanePreviewProps } from "./LanePreview";
import type { Need } from "./preview";
import { NOT_STARTED, SHOWN, type PreviewRun } from "./previewRun";
import type { PreviewRecord } from "./previewStore";

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

/** The lane's own folder, and the canvas's project in it: a Vite app whose `dev` script pnpm runs. */
const DIR = "/home/you/.manut/lanes/baanmali-preorder/promptpay-qr";
const PACKAGE = JSON.stringify({ scripts: { dev: "vite" } });
const record = (over: Partial<PreviewRecord> = {}): PreviewRecord => ({
  dir: DIR,
  reading: false,
  project: { packageJson: PACKAGE, files: ["package.json", "pnpm-lock.yaml"], envExample: null },
  plan: { argv: ["pnpm", "run", "dev"], label: "pnpm run dev" },
  readWhy: null,
  run: NOT_STARTED,
  openFailed: false,
  token: 0,
  ...over,
});
const run = (over: Partial<PreviewRun>): PreviewRun => ({ ...NOT_STARTED, label: "pnpm run dev", since: 1, ...over });
/** The app's own page, as the desktop app on macOS serves it. */
const APP = { origin: "tauri://localhost", windows: false };
const previewOf = (over: Partial<LanePreviewProps> = {}): LanePreviewProps => ({
  dir: DIR,
  record: record(),
  samples: [],
  onStart: vi.fn(),
  onStop: vi.fn(),
  onOpen: vi.fn(),
  here: APP,
  reloads: 0,
  onReload: vi.fn(),
  ...over,
});

const props = (over: Partial<LanePaneProps> = {}): LanePaneProps => ({
  view: "diff",
  onView: vi.fn(),
  files: [],
  needs: [],
  asked: null,
  onAdd: vi.fn(),
  preview: previewOf(),
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

  it("start the pane, as the board's do: Put up for review and Merge are the lane's top bar's (item 167e), and nothing offers a Commit, a Push or a Discard", () => {
    for (const view of ["diff", "preview", "tests"] as const) {
      // the Diff with its review's switches too (item 146), whose Commits and Not committed are views, not acts
      const p = props({ view, files: [CHECKOUT, PROMPTPAY], scopes: { scope: "all", onScope: vi.fn(), review: null, failed: false } });
      const out = html(p);
      expect(out.indexOf("<aside")).toBeLessThan(out.indexOf('role="group"'));
      // the chips are the pane's first thing: nothing stands between the pane's start and its group
      expect(out.slice(out.indexOf("<aside"), out.indexOf('role="group"'))).not.toContain("<button");
      for (const id of ["review", "review-start", "review-merge-start", "lane-step-button"]) expect(out, `${view} ${id}`).not.toContain(`data-testid="${id}"`);
      for (const b of drawn(LanePaneView(p)).filter((e) => e.type === "button")) {
        const name = renderToString(b).replace(/<[^>]*>/g, " ");
        expect(name, view).not.toMatch(/\b(commit|push|discard|merge)\b|put up for review/i);
      }
    }
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
    const says = { diff: "lane-diff-none", preview: "lane-preview", tests: "lane-tests-none" } as const;
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

  it("draws the changes as the timeline draws them, and numbers the lines: the added and removed lines, and the lines about them", () => {
    const out = html(props({ files: [CHECKOUT] }));
    expect(out).toContain('class="dv-l add n"');
    expect(out).toContain('class="dv-l del n"');
    expect(out).toContain('class="dv-l ctx n"');
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
  const withRun = (r: Partial<PreviewRun>, over: Partial<PreviewRecord> = {}) => preview({ preview: previewOf({ record: record({ run: run(r), ...over }) }) });
  const press = (p: LanePaneProps, id: string) => (byId(p, id)[0].props.onClick as () => void)();
  const ids = (p: LanePaneProps) => drawn(LanePaneView(p)).map((e) => e.props["data-testid"]).filter(Boolean);

  it("names the exact command before anything runs, with Start, which is what starts it", () => {
    const p = preview();
    const out = words(p);
    expect(out).toContain("Start runs this in the lane's own folder, with a sample for each secret:");
    expect(byId(p, "lane-preview-command")[0].props.children).toEqual(["$ ", "pnpm run dev"]);
    expect(byId(p, "lane-preview-start")).toHaveLength(1);
    expect(words(p)).toContain(" Start ");
    press(p, "lane-preview-start");
    expect(p.preview.onStart).toHaveBeenCalledTimes(1);
    expect(byId(p, "lane-preview")[0].props["data-phase"]).toBe("idle");
    // `dev` is only a name: what it runs is said under it, from package.json
    expect(byId(p, "lane-preview-script")).toHaveLength(0);
    const said = preview({ preview: previewOf({ record: record({ plan: { argv: ["pnpm", "run", "dev"], label: "pnpm run dev", script: { name: "dev", text: "vite --port 5173" } } }) }) });
    expect(words(said)).toContain("The dev script runs: vite --port 5173");
  });

  it("offers no Start in the developer's own folder, and says the preview runs only in a lane's own folder", () => {
    const p = preview({ preview: previewOf({ dir: null }) });
    expect(words(p)).toContain("The preview runs only in a lane's own folder. This session works in your own folder, which can hold your real .env.local, so nothing is started here.");
    expect(byId(p, "lane-preview-start")).toHaveLength(0);
    expect(byId(p, "lane-preview-command")).toHaveLength(0);
  });

  it("says why there is no command in plain words, and offers no Start", () => {
    const said = {
      no_package_json: "This folder has no package.json, so there is nothing to start.",
      unreadable: "Its package.json could not be read, so there is nothing to start.",
      no_script: "Its package.json has no dev, start, preview or serve script to start.",
      refused: "Its start scripts look like they publish or deploy, so the app does not run them.",
    } as const;
    for (const [why, line] of Object.entries(said)) {
      const p = preview({ preview: previewOf({ record: record({ plan: { none: why as keyof typeof said } }) }) });
      expect(words(p), why).toContain(line);
      expect(byId(p, "lane-preview-start"), why).toHaveLength(0);
      expect(byId(p, "lane-preview-command"), why).toHaveLength(0);
    }
  });

  it("says it is reading the folder until it has, and why it could not", () => {
    expect(words(preview({ preview: previewOf({ record: record({ plan: null, project: null, reading: true }) }) }))).toContain("Reading the project…");
    const unread = preview({ preview: previewOf({ record: record({ plan: null, project: null, readWhy: "not_a_lane" }) }) });
    expect(byId(unread, "lane-preview-unread")[0].props.children).toBe("this is not a lane's own folder.");
    expect(byId(unread, "lane-preview-start")).toHaveLength(0);
  });

  it("while it starts, says so with its command and Stop, and offers no second Start", () => {
    const p = withRun({ phase: "starting", id: 3 });
    expect(byId(p, "lane-preview-state")[0].props.children).toBe("Starting…");
    expect(byId(p, "lane-preview-command")[0].props.children).toEqual(["$ ", "pnpm run dev"]);
    expect(byId(p, "lane-preview-start")).toHaveLength(0);
    press(p, "lane-preview-stop");
    expect(p.preview.onStop).toHaveBeenCalledTimes(1);
  });

  it("running, says where with Reload, Open in browser and Stop, and draws the page at that very address in a sandboxed frame", () => {
    const p = withRun({ phase: "running", id: 3, url: "http://localhost:5173/" });
    expect(byId(p, "lane-preview-state")[0].props.children).toBe("Running at http://localhost:5173/");
    const buttons = drawn(LanePaneView(p)).filter((e) => e.type === "button" && String(e.props["data-testid"]).startsWith("lane-preview-"));
    expect(buttons.map((b) => b.props["data-testid"])).toEqual(["lane-preview-reload", "lane-preview-open", "lane-preview-stop"]);
    expect(words(p)).toContain(" Reload Open in browser Stop ");
    press(p, "lane-preview-reload");
    expect(p.preview.onReload).toHaveBeenCalledTimes(1);
    press(p, "lane-preview-open");
    expect(p.preview.onOpen).toHaveBeenCalledTimes(1);
    press(p, "lane-preview-stop");
    expect(p.preview.onStop).toHaveBeenCalledTimes(1);
    const [frame] = byId(p, "lane-preview-frame");
    expect(frame.type).toBe("iframe");
    expect(frame.props).toMatchObject({
      src: "http://localhost:5173/",
      sandbox: "allow-scripts allow-same-origin allow-forms",
      referrerPolicy: "no-referrer",
      title: "The page at http://localhost:5173/",
    });
    // the one frame, and nothing else of the project's: no webview, object, embed, form or link of its own
    expect(html(p).match(/<iframe/g)).toHaveLength(1);
    expect(html(p)).not.toMatch(/<(webview|object|embed|form|a )/);
    expect(byId(p, "lane-preview-frame-note")[0].props.children).toBe("Pop-ups, downloads and links to other sites do not open here. Open in browser shows the whole page.");
    expect(byId(p, "lane-preview-noframe")).toHaveLength(0);
    expect(byId(p, "lane-preview-open-failed")).toHaveLength(0);
    const failed = withRun({ phase: "running", id: 3, url: "http://localhost:5173/" }, { openFailed: true });
    expect(byId(failed, "lane-preview-open-failed")[0].props.children).toBe("The browser could not be opened.");
  });

  it("makes the frame again at the same address on each Reload, and puts it under the preview's box, before the samples", () => {
    const at = (reloads: number) => {
      const p = preview({ preview: previewOf({ reloads, record: record({ run: run({ phase: "running", id: 3, url: "http://localhost:5173/" }) }) }) });
      return byId(p, "lane-preview-frame")[0];
    };
    expect(at(0).key).toBe("http://localhost:5173/#0");
    expect(at(1).key).toBe("http://localhost:5173/#1");
    expect(at(1).props.src).toBe("http://localhost:5173/");
    const p = preview({ preview: previewOf({ samples: ["PROMPTPAY_SHOP_ID"], record: record({ run: run({ phase: "running", id: 3, url: "http://localhost:5173/" }) }) }) });
    const order = ids(p).filter((id) => ["lane-preview", "lane-preview-page", "lane-preview-frame-note", "lane-preview-samples"].includes(String(id)));
    expect(order).toEqual(["lane-preview", "lane-preview-page", "lane-preview-frame-note", "lane-preview-samples"]);
  });

  it("draws the frame only while it runs at an address: not while it starts, prints none, is being stopped, or after it ended", () => {
    for (const r of [
      { phase: "starting", id: 3 },
      { phase: "quiet", id: 3, lines: ["Compiling…"] },
      { phase: "stopping", id: 3, url: "http://localhost:5173/" },
      { phase: "stopped", url: "http://localhost:5173/" },
      { phase: "ended", code: 1, url: "http://localhost:5173/", lines: ["Error"] },
      { phase: "failed", why: "running" },
      { phase: "running", id: 3, url: null },
    ] as Partial<PreviewRun>[]) {
      const p = withRun(r);
      expect(html(p), r.phase).not.toContain("<iframe");
      expect(byId(p, "lane-preview-reload"), r.phase).toHaveLength(0);
      expect(byId(p, "lane-preview-frame-note"), r.phase).toHaveLength(0);
    }
  });

  it("keeps Open in browser and says why when the address cannot be shown inside the app", () => {
    const said = {
      unnamed: [{ url: "http://[::1]:5173/" }, APP, "The app shows a page inside it only at localhost. Open this one in your browser."],
      own: [{ url: "http://localhost:5207/" }, { origin: "http://localhost:5207", windows: false }, "This is the app's own address, so the page is not shown inside the app."],
      windows: [{ url: "http://localhost:5173/" }, { origin: "http://tauri.localhost", windows: true }, "On Windows the page is not shown inside the app yet. Open it in your browser."],
      not_loopback: [{ url: "http://192.168.1.5:5173/" }, APP, "This is not an address of this computer, so the page is not shown here."],
    } as const;
    for (const [why, [r, here, line]] of Object.entries(said)) {
      const p = preview({ preview: previewOf({ here, record: record({ run: run({ phase: "running", id: 3, ...r }) }) }) });
      expect(html(p), why).not.toContain("<iframe");
      expect(byId(p, "lane-preview-noframe")[0].props["data-why"], why).toBe(why);
      expect(byId(p, "lane-preview-noframe")[0].props.children, why).toBe(line);
      expect(byId(p, "lane-preview-reload"), why).toHaveLength(0);
      expect(byId(p, "lane-preview-open"), why).toHaveLength(1);
      expect(byId(p, "lane-preview-stop"), why).toHaveLength(1);
    }
  });

  it("stopping, its Stop is busy and pressing it again does nothing", () => {
    const p = withRun({ phase: "stopping", id: 3 });
    const stop = byId(p, "lane-preview-stop")[0];
    expect(stop.props["aria-busy"]).toBe(true);
    expect(stop.props.children).toBe("Stopping");
    press(p, "lane-preview-stop");
    expect(p.preview.onStop).not.toHaveBeenCalled();
    expect(byId(p, "lane-preview-start")).toHaveLength(0);
  });

  it("stopped, says so and offers Start again with the command it would run", () => {
    const p = withRun({ phase: "stopped" });
    expect(byId(p, "lane-preview-state")[0].props.children).toBe("Stopped.");
    expect(byId(p, "lane-preview-start")[0].props.children).toBe("Start again");
    press(p, "lane-preview-start");
    expect(p.preview.onStart).toHaveBeenCalledTimes(1);
  });

  it("ended by itself, says its exit code and its last few lines with any key hidden, and offers Start again", () => {
    const lines = [...Array.from({ length: 10 }, (_, i) => `line ${i}`), "Error: Cannot find module 'vite'", `- loaded with STRIPE_SECRET_KEY ${KEY}`];
    const p = withRun({ phase: "ended", code: 1, lines });
    expect(byId(p, "lane-preview-state")[0].props.children).toBe("It ended by itself (exit 1).");
    const shown = byId(p, "lane-preview-lines")[0].props.children as string;
    expect(shown.split("\n")).toHaveLength(SHOWN);
    expect(shown).toContain("Error: Cannot find module 'vite'");
    expect(shown).not.toContain(KEY);
    expect(shown).toContain("••••");
    expect(shown).not.toContain("line 0");
    expect(html(p)).not.toContain(KEY);
    expect(byId(p, "lane-preview-start")[0].props.children).toBe("Start again");
    expect(byId(withRun({ phase: "ended", code: null }), "lane-preview-state")[0].props.children).toBe("It ended by itself.");
  });

  it("that could not start, says why in words, and offers Start again", () => {
    const said: [string, string][] = [
      ["missing:pnpm", "Could not start: pnpm is not installed on this computer."],
      ["changed", "Could not start: package.json changed after it was read. Look at the command again and press Start."],
      ["running", "Could not start: a preview of this lane is running already."],
      ["unsupported", "Could not start: the preview runs on macOS and Linux for now."],
      [`spawn: Permission denied ${KEY}`, "Could not start: spawn: Permission denied ••••"],
    ];
    for (const [why, line] of said) {
      const p = withRun({ phase: "failed", why });
      expect(byId(p, "lane-preview-state")[0].props.children, why).toBe(line);
      expect(byId(p, "lane-preview-start")[0].props.children, why).toBe("Start again");
    }
  });

  it("that printed no address in its first minute, says so with its last lines and Stop", () => {
    const p = withRun({ phase: "quiet", id: 3, lines: ["Compiling the first build…"] });
    expect(byId(p, "lane-preview-state")[0].props.children).toBe("It is running, but has not printed an address the app can open.");
    expect(byId(p, "lane-preview-lines")[0].props.children).toBe("Compiling the first build…");
    expect(byId(p, "lane-preview-stop")).toHaveLength(1);
    expect(byId(p, "lane-preview-open")).toHaveLength(0);
  });

  it("offers no Start again once the folder has no command, and says why instead", () => {
    const p = withRun({ phase: "stopped" }, { plan: { none: "no_script" } });
    expect(byId(p, "lane-preview-start")).toHaveLength(0);
    expect(words(p)).toContain("Its package.json has no dev, start, preview or serve script to start.");
  });

  it("names the secrets it runs on samples, and never a value", () => {
    const p = preview({ preview: previewOf({ samples: ["PROMPTPAY_SHOP_ID", "STRIPE_SECRET_KEY"] }), needs: [SHOP, STRIPE] });
    expect(byId(p, "lane-preview-samples")[0].props.children).toBe("Secrets run on samples: PROMPTPAY_SHOP_ID and STRIPE_SECRET_KEY.");
    const out = html(p);
    expect(out).not.toContain("0000000000");
    expect(out).not.toContain("sample-value");
    expect(out).not.toContain("sample-stripe_secret_key");
    // none to name: no line
    expect(byId(preview(), "lane-preview-samples")).toHaveLength(0);
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
    expect(p.preview.onStart).not.toHaveBeenCalled();
  });

  it("has Start as its only button that runs anything: the rest are the chips and Add", () => {
    const buttons = drawn(LanePaneView(preview({ needs: [SHOP, STRIPE] }))).filter((e) => e.type === "button");
    expect(buttons.map((b) => b.props["data-testid"])).toEqual(["lane-chip-diff", "lane-chip-preview", "lane-chip-tests", "lane-preview-start", "kit-sample-add", "kit-sample-add"]);
    expect(ids(preview())).toContain("lane-preview");
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
      expect(html(props({ view: "preview" })), lang).not.toContain("Start runs this in the lane's own folder");
      const running = props({ view: "preview", preview: previewOf({ record: record({ run: run({ phase: "running", id: 3, url: "http://localhost:5173/" }) }) }) });
      expect(html(running), lang).toContain("http://localhost:5173/");
      expect(html(running), lang).not.toContain("Running at");
      expect(html(running), lang).not.toContain("Reload");
      expect(html(running), lang).not.toContain("Open in browser");
      expect(html(running), lang).not.toContain("Pop-ups, downloads");
      expect(html(running), lang).not.toContain("The page at");
    }
  });

  it("say Reload, Open in browser and what does not open in the frame in all four languages", () => {
    const running = props({ view: "preview", preview: previewOf({ record: record({ run: run({ phase: "running", id: 3, url: "http://localhost:5173/" }) }) }) });
    for (const [lang, reload, open, title] of [
      ["en", "Reload", "Open in browser", "The page at http://localhost:5173/"],
      ["ko", "새로고침", "브라우저에서 열기", "http://localhost:5173/ 페이지"],
      ["ja", "再読み込み", "ブラウザで開く", "http://localhost:5173/ のページ"],
      ["zh", "重新加载", "在浏览器中打开", "http://localhost:5173/ 的页面"],
    ] as const) {
      setLang(lang);
      expect(byId(running, "lane-preview-reload")[0].props.children, lang).toBe(reload);
      expect(byId(running, "lane-preview-open")[0].props.children, lang).toBe(open);
      expect(byId(running, "lane-preview-frame")[0].props.title, lang).toBe(title);
      expect(String(byId(running, "lane-preview-frame-note")[0].props.children).length, lang).toBeGreaterThan(10);
    }
  });
});

// The Diff as a review (item 146): scopes, the unified and side by side layouts, one file at a time, and the lane's commits and
// uncommitted work as sections. The sections hold state (whether a commit is open), so they are read from the markup, not from the
// elements the view returns.
describe("the Diff as a review", () => {
  const REVIEW: LaneReview = {
    uncommitted: { files: [PROMPTPAY], moreFiles: 0 },
    commits: [
      { id: "3f2a1bcd9e01", subject: "Add the PromptPay QR", files: [CHECKOUT, PROMPTPAY], moreFiles: 1, unread: false },
      { id: "9c8d7e6f5a43", subject: "Start the checkout page", files: [file("src/start.ts", ["+export const a = 1;"], 1)], moreFiles: 0, unread: false },
      { id: "5b4a39281706", subject: "Old commit", files: [], moreFiles: 0, unread: true },
      { id: "0f1e2d3c4b5a", subject: "An empty one", files: [], moreFiles: 0, unread: false },
    ],
    moreCommits: 2,
  };
  const scopes = (over: Partial<PaneScopes> = {}): PaneScopes => ({ scope: "all", onScope: vi.fn(), review: null, failed: false, ...over });
  const diff = (over: Partial<LanePaneProps> = {}) => props({ files: [CHECKOUT, PROMPTPAY], scopes: scopes(), ...over });
  const radios = (p: LanePaneProps, id: string) => drawn(byId(p, id)[0]).filter((e) => e.props.role === "radio");
  const prefs = (layout: "unified" | "split", one = false) => ({ layout, one });

  it("numbers the lines from the hunk's header: old and new beside a line of context, the old alone beside a removed line, the new alone beside an added one", () => {
    const out = html(diff());
    // CHECKOUT's hunk starts at 12 on both sides: the context line is 12 | 12, the removed line is 13 in the old file and the added one 13 in the new
    expect(out).toContain('data-kind="ctx" data-row="1" data-old="12" data-new="12"');
    expect(out).toContain('data-kind="del" data-row="2" data-old="13"');
    expect(out).not.toMatch(/data-kind="del" data-row="2" data-old="13" data-new/);
    expect(out).toContain('data-kind="add" data-row="3" data-new="13"');
    expect(out).not.toMatch(/data-kind="add" data-row="3" data-old/);
    // the file is named on its box, for a note on its lines
    expect(out).toContain('data-path="src/checkout.tsx"');
  });

  it("draws side by side as pairs: the removed line on the left against the added line on the right, a line of context on both", () => {
    const out = html(diff({ prefs: prefs("split") }));
    expect(out).toContain('class="dv-sr"');
    const rows = out.split('<div class="dv-sr">').slice(1);
    // the first row of CHECKOUT after the rule is its line of context: one line, on both sides
    expect(rows[0]).toContain('class="dv-l ctx n s" data-kind="ctx" data-row="1" data-side="old"');
    expect(rows[0]).toContain('class="dv-l ctx n s" data-kind="ctx" data-row="1" data-side="new"');
    // the change is one row: removed on the left, added on the right
    const change = rows.find((r) => r.includes('data-kind="del"'))!;
    expect(change).toContain('data-kind="del" data-row="2" data-side="old"');
    expect(change).toContain('data-kind="add" data-row="3" data-side="new"');
    expect(change.indexOf('data-kind="del"')).toBeLessThan(change.indexOf('data-kind="add"'));
    // one number on each side
    expect(change).toContain('<span class="dv-n" aria-hidden="true">13</span>');
  });

  it("gives the split layout's empty cell to a line only one file has", () => {
    const lone = file("src/lone.ts", ["+only added"], 1);
    const out = html(diff({ files: [lone], prefs: prefs("split") }));
    expect(out).toContain('class="dv-l n s empty" aria-hidden="true"');
    expect(out.indexOf("dv-l n s empty")).toBeLessThan(out.indexOf('data-kind="add"'));
  });

  it("gives the pane room for side by side while it is chosen, and only then", () => {
    expect(html(diff({ prefs: prefs("split") }))).toContain("data-wide");
    expect(html(diff({ prefs: prefs("unified") }))).not.toContain("data-wide");
    expect(html(diff({ prefs: prefs("split"), view: "tests" }))).not.toContain("data-wide");
  });

  it("switches between unified and side by side with a radio group that says which is chosen, and calls back with the other", () => {
    const onPrefs = vi.fn();
    const unified = diff({ onPrefs });
    expect(radios(unified, "lane-diff-layout").map((r) => [r.props.children, r.props["aria-checked"]])).toEqual([
      ["Unified", true],
      ["Side by side", false],
    ]);
    (radios(unified, "lane-diff-layout")[1].props.onClick as () => void)();
    expect(onPrefs).toHaveBeenLastCalledWith({ layout: "split" });
    (radios(unified, "lane-diff-layout")[0].props.onClick as () => void)();
    expect(onPrefs).toHaveBeenCalledTimes(1);
    const split = diff({ onPrefs, prefs: prefs("split") });
    expect(radios(split, "lane-diff-layout").map((r) => r.props["aria-checked"])).toEqual([false, true]);
    (radios(split, "lane-diff-layout")[0].props.onClick as () => void)();
    expect(onPrefs).toHaveBeenLastCalledWith({ layout: "unified" });
  });

  it("offers the layout and the list or one at a time only when there is a file to show", () => {
    expect(byId(diff({ files: [] }), "lane-diff-layout")).toHaveLength(0);
    expect(byId(diff({ files: [] }), "lane-diff-show")).toHaveLength(0);
    expect(byId(diff(), "lane-diff-layout")).toHaveLength(1);
    expect(byId(diff(), "lane-diff-show")).toHaveLength(1);
  });

  it("shows the whole list by default, with no Prev and Next, and every file", () => {
    const out = html(diff());
    expect(out.match(/data-testid="lane-diff-file"/g)).toHaveLength(2);
    expect(out).not.toContain("lane-diff-prev");
    expect(out).toContain('data-one="false"');
  });

  it("shows one file at a time with its place, and Prev and Next that stop at the ends", () => {
    const first = diff({ prefs: prefs("unified", true) });
    const out = html(first);
    expect(out.match(/data-testid="lane-diff-file"/g)).toHaveLength(1);
    expect(out).toContain("src/checkout.tsx");
    expect(out).not.toContain("src/promptpay.ts");
    expect(words(first)).toContain("1 of 2");
    expect(byId(first, "lane-diff-prev")[0].props.disabled).toBe(true);
    expect(byId(first, "lane-diff-next")[0].props.disabled).toBe(false);
    expect(words(first)).toContain("Prev");
    expect(words(first)).toContain("Next");
    // the file takes the height its lines need
    expect(out).toContain('class="dv tall"');
    // Next goes to the second file, by its key and its place
    const onCurrent = vi.fn();
    (byId(diff({ prefs: prefs("unified", true), onCurrent }), "lane-diff-next")[0].props.onClick as () => void)();
    expect(onCurrent).toHaveBeenLastCalledWith({ key: "all\u0000src/promptpay.ts", was: 1 });
    // on the second file the place says so, Prev is back and Next is not
    const second = diff({ prefs: prefs("unified", true), current: { key: "all\u0000src/promptpay.ts", was: 1 }, onCurrent });
    expect(words(second)).toContain("2 of 2");
    expect(html(second)).toContain("src/promptpay.ts");
    expect(html(second)).not.toContain("src/checkout.tsx");
    expect(byId(second, "lane-diff-prev")[0].props.disabled).toBe(false);
    expect(byId(second, "lane-diff-next")[0].props.disabled).toBe(true);
    (byId(second, "lane-diff-prev")[0].props.onClick as () => void)();
    expect(onCurrent).toHaveBeenLastCalledWith({ key: "all\u0000src/checkout.tsx", was: 0 });
  });

  it("follows the file it shows when the list is read again and it has moved, and holds its place when it is gone", () => {
    const moved = diff({ files: [PROMPTPAY, CHECKOUT], prefs: prefs("unified", true), current: { key: "all\u0000src/checkout.tsx", was: 0 } });
    expect(words(moved)).toContain("2 of 2");
    expect(html(moved)).toContain("src/checkout.tsx");
    const gone = diff({ files: [PROMPTPAY], prefs: prefs("unified", true), current: { key: "all\u0000src/checkout.tsx", was: 1 } });
    expect(words(gone)).toContain("1 of 1");
  });

  it("starts one at a time at the first file when it is chosen, and says so by the switch", () => {
    const onCurrent = vi.fn();
    const onPrefs = vi.fn();
    const p = diff({ onCurrent, onPrefs });
    expect(radios(p, "lane-diff-show").map((r) => [r.props.children, r.props["aria-checked"]])).toEqual([
      ["List", true],
      ["One at a time", false],
    ]);
    (radios(p, "lane-diff-show")[1].props.onClick as () => void)();
    expect(onCurrent).toHaveBeenLastCalledWith({ key: "all\u0000src/checkout.tsx", was: 0 });
    expect(onPrefs).toHaveBeenLastCalledWith({ one: true });
  });

  it("has three scopes where the shell can read the folder, none where it cannot, and says which is chosen", () => {
    expect(radios(diff(), "lane-diff-scope").map((r) => [r.props.children, r.props["aria-checked"]])).toEqual([
      ["All changes", true],
      ["Not committed", false],
      ["Commits", false],
    ]);
    expect(byId(diff({ scopes: null }), "lane-diff-scope")).toHaveLength(0);
    // the list is as it always was where the folder cannot be read
    expect(html(diff({ scopes: null })).match(/data-testid="lane-diff-file"/g)).toHaveLength(2);
    const onScope = vi.fn();
    (radios(diff({ scopes: scopes({ onScope }) }), "lane-diff-scope")[2].props.onClick as () => void)();
    expect(onScope).toHaveBeenCalledWith("commits");
  });

  it("lists the work not committed under its own heading, with its files", () => {
    const p = diff({ scopes: scopes({ scope: "uncommitted", review: REVIEW }) });
    const out = html(p);
    expect(out).toContain('data-section="uncommitted"');
    expect(words(p)).toContain("Not committed yet 1 file");
    expect(out.match(/data-testid="lane-diff-file"/g)).toHaveLength(1);
    expect(out).toContain("src/promptpay.ts");
    expect(out).not.toContain("src/checkout.tsx");
  });

  it("lists each commit as a section with its short id, its subject and how many files it has, the newest open and the rest shut", () => {
    const p = diff({ scopes: scopes({ scope: "commits", review: REVIEW }) });
    const out = html(p);
    expect(out.match(/data-testid="lane-diff-commit"/g)).toHaveLength(4);
    const text = words(p);
    expect(text).toContain("3f2a1bcd9e01 Add the PromptPay QR 3 files");
    expect(text).toContain("9c8d7e6f5a43 Start the checkout page 1 file");
    // only the newest commit's files are drawn: its two, and the one more it could not list is counted
    expect(out.match(/data-testid="lane-diff-file"/g)).toHaveLength(2);
    expect(out).toContain('aria-expanded="true"');
    expect(out.match(/aria-expanded="false"/g)).toHaveLength(3);
    expect(text).toContain("and 1 more files");
    expect(text).toContain("and 2 more commits");
    expect(out).not.toContain("src/start.ts");
  });

  it("says in words for a commit whose files could not be read, and for one that changed none, when they are opened", () => {
    // each of those two is the newest in a review of its own, so it is open
    const unread = diff({ scopes: scopes({ scope: "commits", review: { ...REVIEW, commits: [REVIEW.commits[2]], moreCommits: 0 } }) });
    expect(words(unread)).toContain("This commit's files could not be read.");
    expect(html(unread)).toContain('data-testid="lane-diff-unread"');
    const empty = diff({ scopes: scopes({ scope: "commits", review: { ...REVIEW, commits: [REVIEW.commits[3]], moreCommits: 0 } }) });
    expect(words(empty)).toContain("This commit changed no file.");
  });

  it("walks the files of every commit one at a time, a file changed in two commits being two of them", () => {
    const p = diff({ prefs: prefs("unified", true), scopes: scopes({ scope: "commits", review: REVIEW }) });
    // the commits hold 2 + 1 + 0 + 0 files that were listed: three
    expect(words(p)).toContain("1 of 3");
    expect(words(p)).toContain("3f2a1bcd9e01 Add the PromptPay QR");
    const third = diff({ prefs: prefs("unified", true), current: { key: "9c8d7e6f5a43\u0000src/start.ts", was: 2 }, scopes: scopes({ scope: "commits", review: REVIEW }) });
    expect(words(third)).toContain("3 of 3");
    expect(words(third)).toContain("9c8d7e6f5a43 Start the checkout page");
    expect(html(third)).toContain("src/start.ts");
  });

  it("says it is reading the folder until it has, and that it could not when it could not, in a scope that needs the review", () => {
    expect(byId(diff({ scopes: scopes({ scope: "commits" }) }), "lane-diff-reading")).toHaveLength(1);
    expect(words(diff({ scopes: scopes({ scope: "commits" }) }))).toContain("Reading the lane's folder…");
    expect(words(diff({ scopes: scopes({ scope: "uncommitted", failed: true }) }))).toContain("The lane's folder could not be read just now.");
    expect(byId(diff({ scopes: scopes({ scope: "uncommitted", failed: true }) }), "lane-diff-failed")).toHaveLength(1);
    // not for All changes, which needs no review
    expect(byId(diff(), "lane-diff-reading")).toHaveLength(0);
  });

  it("says in words when a scope has nothing to list", () => {
    const none: LaneReview = { uncommitted: { files: [], moreFiles: 0 }, commits: [], moreCommits: 0 };
    expect(words(diff({ scopes: scopes({ scope: "uncommitted", review: none }) }))).toContain("Nothing is waiting to be committed.");
    expect(words(diff({ scopes: scopes({ scope: "commits", review: none }) }))).toContain("This lane has no commits of its own yet.");
    expect(words(diff({ files: [], scopes: scopes() }))).toContain("Kit has not changed any file yet.");
    // the scope switch stays, so a lane with nothing net can still be looked at by commit
    expect(byId(diff({ files: [], scopes: scopes() }), "lane-diff-scope")).toHaveLength(1);
  });

  it("hides a key in a commit's subject and in its lines", () => {
    const keyed = file("src/config.ts", [`+export const K = "${KEY}";`], 1);
    const review: LaneReview = { uncommitted: { files: [], moreFiles: 0 }, commits: [{ id: "aaaaaaaaaaaa", subject: `use ${KEY} here`, files: [keyed], moreFiles: 0, unread: false }], moreCommits: 0 };
    const out = html(diff({ scopes: scopes({ scope: "commits", review }) }));
    expect(out).not.toContain(KEY);
    expect(out).not.toContain("sk-FAKE");
    expect(out).toContain("••••");
  });

  it("keeps a long subject to one line and the whole of it in the markup", () => {
    const long = "x".repeat(300);
    const review: LaneReview = { uncommitted: { files: [], moreFiles: 0 }, commits: [{ id: "bbbbbbbbbbbb", subject: long, files: [], moreFiles: 0, unread: false }], moreCommits: 0 };
    expect(html(diff({ scopes: scopes({ scope: "commits", review }) }))).toContain(long);
  });
});
