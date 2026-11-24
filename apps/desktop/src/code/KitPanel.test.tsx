// Kit on the Code page, drawn with react-dom/server from props, and its buttons read from the elements it returns (the
// view uses no hooks). The project is the canvas's baanmali-preorder.
import { createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setLang } from "../i18n";
import { KitPanelView, codeProjects, type KitPanelProps } from "./KitPanel";
import { laneRowOf } from "./Lanes";
import { emptyLane } from "./lane";
import { emptyProject } from "./project";

const root = "/Users/fon/baanmali-preorder";

function props(over: Partial<KitPanelProps> = {}): KitPanelProps {
  return {
    root,
    projects: [root],
    project: { ...emptyProject(), level: "edits_and_safe_commands" },
    keys: [],
    home: "/Users/fon",
    onProject: vi.fn(),
    onLevel: vi.fn(),
    onAllow: vi.fn(),
    onDropRule: vi.fn(),
    onDropFolder: vi.fn(),
    onOpenSession: vi.fn(),
    ...over,
  };
}

function drawn(node: ReactNode): ReactElement<Record<string, unknown>>[] {
  if (Array.isArray(node)) return node.flatMap(drawn);
  if (!isValidElement(node)) return [];
  const el = node as ReactElement<Record<string, unknown>>;
  if (typeof el.type === "function") return drawn((el.type as (props: unknown) => ReactNode)(el.props));
  return [...(typeof el.type === "string" ? [el] : []), ...drawn(el.props.children as ReactNode)];
}
const byId = (p: KitPanelProps, id: string) => drawn(KitPanelView(p)).filter((e) => e.props["data-testid"] === id);
const html = (p: KitPanelProps) => renderToString(createElement(KitPanelView, p));

afterEach(() => setLang("en"));

describe("how much Kit does alone", () => {
  it("draws the canvas's four stops with one pressed, its line, and that going live always asks", () => {
    const out = html(props());
    for (const words of ["How much Kit does alone", "Asks every time", "Edits alone", "Edits and safe commands", "Everything in this project"]) expect(out).toContain(words);
    expect(out).toContain("Kit edits files and runs tests alone. Anything that installs, deletes or pushes asks first.");
    expect(out).toContain("Going live always asks, at every level.");
    const pressed = byId(props(), "kit-dial")[0];
    expect(drawn(pressed.props.children as ReactNode).map((b) => b.props["aria-pressed"])).toEqual([false, false, true, false]);
  });

  it("sets the level a stop names", () => {
    const p = props();
    (byId(p, "kit-level-everything_in_project")[0].props.onClick as () => void)();
    expect(p.onLevel).toHaveBeenCalledWith("everything_in_project");
  });

  it("names the project, and offers the others when the page lists several", () => {
    expect(html(props())).toContain("baanmali-preorder");
    expect(byId(props(), "kit-project")).toHaveLength(0);
    const p = props({ projects: [root, "/Users/fon/storefront"] });
    expect(byId(p, "kit-project")).toHaveLength(1);
    expect(html(p)).toContain("storefront");
  });

  it("is in all four languages", () => {
    for (const [lang, words] of [
      ["ko", "편집과 안전한 명령은 혼자"],
      ["ja", "編集と安全なコマンドはひとりで"],
      ["zh", "独自编辑和运行安全命令"],
    ] as const) {
      setLang(lang);
      expect(html(props())).toContain(words);
    }
  });
});

describe("what was stopped, and what is allowed", () => {
  it("shows a read stopped outside the project, with Allow this folder", () => {
    const p = props({ project: { ...emptyProject(), blocked: [{ what: "read", path: "~/Documents/tax-2026.xlsx", folder: "/Users/fon/Documents", at: 1 }] } });
    const out = html(p);
    expect(out).toContain("Blocked");
    expect(out).toContain("Kit tried to read a file outside baanmali-preorder. It was stopped.");
    expect(out).toContain("~/Documents/tax-2026.xlsx");
    (byId(p, "kit-allow-folder")[0].props.onClick as () => void)();
    expect(p.onAllow).toHaveBeenCalledWith("/Users/fon/Documents");
  });

  it("offers no Allow this folder for a folder the project is in", () => {
    const p = props({ project: { ...emptyProject(), blocked: [{ what: "command", path: "~", folder: "/Users/fon", at: 1 }] } });
    expect(byId(p, "kit-allow-folder")).toHaveLength(0);
    expect(html(p)).toContain("Kit tried to run a command outside baanmali-preorder. It was stopped.");
  });

  it("lists the rules and folders kept, each of which can be taken back", () => {
    const p = props({ project: { ...emptyProject(), rules: [{ words: ["pnpm", "add"] }], folders: ["/Users/fon/Documents"] } });
    const out = html(p);
    expect(out).toContain("Always allowed in this project");
    expect(out).toContain("pnpm add …");
    expect(out).toContain("Folders Kit may read");
    expect(out).toContain("~/Documents");
    const takeBack = drawn(KitPanelView(p)).filter((e) => e.props.children === "Take back");
    expect(takeBack).toHaveLength(2);
    (takeBack[0].props.onClick as () => void)();
    expect(p.onDropRule).toHaveBeenCalledWith({ words: ["pnpm", "add"] });
    (takeBack[1].props.onClick as () => void)();
    expect(p.onDropFolder).toHaveBeenCalledWith("/Users/fon/Documents");
  });

  it("says nothing of rules, folders or stops while there are none", () => {
    const out = html(props());
    for (const words of ["Stopped outside the project", "Always allowed in this project", "Folders Kit may read"]) expect(out).not.toContain(words);
  });
});

describe("a key typed into the code", () => {
  it("says which file, and opens the session that holds the change", () => {
    const p = props({ keys: [{ session: "s1", files: ["src/config.ts"] }] });
    expect(html(p)).toContain("A key was typed into src/config.ts. Kit does not save it to the project&#x27;s history without asking.");
    (drawn(KitPanelView(p)).find((e) => e.props.children === "See the change")!.props.onClick as () => void)();
    expect(p.onOpenSession).toHaveBeenCalledWith("s1");
    expect(html(props({ keys: [{ session: "s1", files: ["a.ts", "b.ts"] }] }))).toContain("Keys were typed into 2 files.");
  });
});

describe("the projects the page lists", () => {
  it("are the folders sessions run in, newest first, then the added ones, each once", () => {
    expect(codeProjects([root, "/Users/fon/storefront", `${root}/`], ["/Users/fon/blog", root])).toEqual([root, "/Users/fon/storefront", "/Users/fon/blog"]);
    expect(codeProjects([], [])).toEqual([]);
  });
});

describe("the lanes", () => {
  const lane = laneRowOf({ rec: { id: "s1", agent: "claude", cwd: root, status: "running", promptTitle: "PromptPay QR at checkout", lane: { name: "kit/promptpay-qr", base: "main" } }, agent: "Claude Code", lane: emptyLane(), turn: null, asks: [] });

  it("open the panel, before how much Kit does alone, and open the lane's session", () => {
    const p = props({ lanes: [lane], now: 1, onOpenLane: vi.fn() });
    const out = html(p);
    expect(out).toContain("PromptPay QR at checkout");
    expect(out).toContain("kit/promptpay-qr");
    expect(out.indexOf("Lanes")).toBeGreaterThan(-1);
    expect(out.indexOf("Lanes")).toBeLessThan(out.indexOf("How much Kit does alone"));
    const open = drawn(KitPanelView(p)).find((e) => e.type === "button" && e.props.title === "Open this lane");
    (open!.props.onClick as () => void)();
    expect(p.onOpenLane).toHaveBeenCalledWith("s1");
  });

  it("are not drawn when the project has none, and the panel is as it was", () => {
    for (const p of [props(), props({ lanes: [] })]) {
      const out = html(p);
      expect(out).not.toContain("Lanes");
      expect(byId(p, "lanes")).toHaveLength(0);
      expect(out).toContain("How much Kit does alone");
    }
  });
});
