// The Rewind panel (the design canvas's StatesCodeDev "Rewind"), drawn with react-dom/server from props, and its
// controls read from the elements it returns (the view uses no hooks). The turns are the canvas's.
import { createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setLang } from "../i18n";
import { RewindPanelView, type RewindPanelProps } from "./RewindPanel";

const turns = [
  { id: "local-s3", title: "Thai date format" },
  { id: "local-s2", title: "PromptPay QR at checkout" },
  { id: "local-s1", title: "Fix stock sync with Shopee" },
];

function props(over: Partial<RewindPanelProps> = {}): RewindPanelProps {
  return {
    turns,
    picked: "local-s3",
    preview: { back: [{ path: "src/date.ts", change: "changed" }, { path: "src/thai.ts", change: "gone" }, { path: "README.md", change: "changed" }], hand: [], tooBig: 0, headMoved: false },
    loading: false,
    live: false,
    keep: [],
    busy: false,
    running: false,
    error: "",
    onPick: vi.fn(),
    onKeep: vi.fn(),
    onRewind: vi.fn(),
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
const byId = (p: RewindPanelProps, id: string) => drawn(RewindPanelView(p)).filter((e) => e.props["data-testid"] === id);
const html = (p: RewindPanelProps) => renderToString(createElement(RewindPanelView, p));
const text = (s: string) => s.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, " ");

afterEach(() => setLang("en"));

describe("the Rewind panel", () => {
  it("draws the canvas's panel: the turns to rewind to before, newest first, the one picked, and the promise", () => {
    const p = props();
    const radios = byId(p, "rewind-turn");
    expect(radios.map((r) => r.props.title)).toEqual(["Thai date format", "PromptPay QR at checkout", "Fix stock sync with Shopee"]);
    expect(radios.map((r) => r.props["aria-checked"])).toEqual([true, false, false]);
    expect(radios.every((r) => r.props.role === "radio")).toBe(true);
    const page = text(html(p));
    expect(page).toContain("Rewind to before");
    expect(page).toContain("The files and the chat go back together.");
    expect(page).toContain("3 files go back as they were.");
    (radios[1].props.onClick as () => void)();
    expect(p.onPick).toHaveBeenCalledWith("local-s2");
    const go = byId(p, "rewind-go")[0];
    expect(go.props.disabled).toBe(false);
    (go.props.onClick as () => void)();
    expect(p.onRewind).toHaveBeenCalledOnce();
  });

  it("lists the files changed by hand, each kept unless the person unticks it", () => {
    const p = props({ preview: { ...props().preview!, hand: ["README.md"] }, keep: ["README.md"] });
    expect(text(html(p))).toContain("Changed by hand since then. A ticked file stays as it is now.");
    const box = byId(p, "rewind-keep");
    expect(box).toHaveLength(1);
    expect(box[0].props.checked).toBe(true);
    (box[0].props.onChange as (e: unknown) => void)({ currentTarget: { checked: false } });
    expect(p.onKeep).toHaveBeenCalledWith("README.md", false);
    expect(byId(props(), "rewind-hand")).toHaveLength(0);
  });

  it("says what a rewind does not take back: a push or a publish, the branch's commits, files too big to keep", () => {
    const page = text(html(props({ live: true, preview: { ...props().preview!, headMoved: true, tooBig: 2 } })));
    expect(page).toContain("Something was pushed or published since then. Rewinding does not take that back.");
    expect(page).toContain("The branch has new commits since then. Rewinding puts the files back; the commits stay.");
    expect(page).toContain("2 files are too big to keep, so they stay as they are.");
    expect(byId(props(), "rewind-live")).toHaveLength(0);
    expect(byId(props(), "rewind-branch")).toHaveLength(0);
  });

  it("says when only the chat goes back, and counts one file as one", () => {
    expect(text(html(props({ preview: { back: [], hand: [], tooBig: 0, headMoved: false } })))).toContain("No file changed since then. Only the chat goes back.");
    expect(text(html(props({ preview: { back: [{ path: "a.ts", change: "back" }], hand: [], tooBig: 0, headMoved: false } })))).toContain("1 file goes back as it was.");
  });

  it("rewinds nothing while the files are read, a turn runs, or the rewind is under way", () => {
    const go = (p: RewindPanelProps) => byId(p, "rewind-go")[0].props;
    expect(go(props({ loading: true, preview: null })).disabled).toBe(true);
    expect(text(html(props({ loading: true, preview: null })))).toContain("Looking at the files…");
    expect(go(props({ running: true })).disabled).toBe(true);
    expect(text(html(props({ running: true })))).toContain("Wait until the turn ends.");
    expect(go(props({ busy: true })).disabled).toBe(true);
    expect(go(props({ busy: true })).children).toBe("Rewinding…");
    expect(go(props({ picked: null })).disabled).toBe(true);
  });

  it("says why a folder's turns cannot be rewound, and what went wrong", () => {
    const p = props({ turns: [], picked: null, preview: null, whyNot: "too_many" });
    expect(byId(p, "rewind-turn")).toHaveLength(0);
    expect(byId(p, "rewind-go")).toHaveLength(0);
    expect(text(html(p))).toContain("This folder has too many files to keep a copy of each turn, so its turns cannot be rewound.");
    const err = byId(props({ error: "Not rewound: Claude Code did not answer. The files are as they were." }), "rewind-error")[0];
    expect(err.props.role).toBe("alert");
  });

  it("speaks the app's language", () => {
    setLang("ja");
    const page = text(html(props()));
    expect(page).toContain("巻き戻す先");
    expect(page).toContain("ファイルとチャットが一緒に戻ります。");
    expect(page).toContain("3 個のファイルが元に戻ります。");
  });
});
