// Bring it back on a Reverted lane (the canvas's StatesCode "Reverted"), drawn with react-dom/server from props, and its
// controls read from the elements it returns (the view uses no hooks). The files and the turn are the canvas's.
import { createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setLang } from "../i18n";
import type { TurnPreview } from "../sessions/turnFiles";
import { BringBackView, type BringBackProps } from "./BringBack";

const preview = (over: Partial<TurnPreview> = {}): TurnPreview => ({
  back: [
    { path: "src/checkout.tsx", change: "changed" },
    { path: "src/promptpay.ts", change: "back" },
    { path: "notes.md", change: "gone" },
  ],
  hand: [],
  tooBig: 0,
  headMoved: false,
  ...over,
});

const props = (over: Partial<BringBackProps> = {}): BringBackProps => ({
  preview: preview(),
  loading: false,
  keep: [],
  busy: false,
  error: "",
  onKeep: vi.fn(),
  onGo: vi.fn(),
  onClose: vi.fn(),
  ...over,
});

function drawn(node: ReactNode): ReactElement<Record<string, unknown>>[] {
  if (Array.isArray(node)) return node.flatMap(drawn);
  if (!isValidElement(node)) return [];
  const el = node as ReactElement<Record<string, unknown>>;
  if (typeof el.type === "function") return drawn((el.type as (props: unknown) => ReactNode)(el.props));
  return [...(typeof el.type === "string" ? [el] : []), ...drawn(el.props.children as ReactNode)];
}
const byId = (p: BringBackProps, id: string) => drawn(BringBackView(p)).filter((e) => e.props["data-testid"] === id);
const html = (p: BringBackProps) => renderToString(createElement(BringBackView, p));

const CHAT = "The chat stays where the rewind left it. Kit will not remember the turns you rewound.";

afterEach(() => setLang("en"));

describe("what Bring it back says", () => {
  it("counts the files that go back as they were just before the rewind, and says the chat stays", () => {
    const out = html(props());
    expect(out).toContain("3 files go back as they were just before the rewind.");
    expect(out).toContain(CHAT);
    expect(out).toContain("Bring it back");
    expect(out).toContain("Not now");
  });

  it("says the chat stays in every state: while it reads, with nothing to bring back, and after a refusal", () => {
    for (const p of [props({ preview: null, loading: true }), props({ preview: preview({ back: [] }) }), props({ preview: null, error: "The files from before the rewind are no longer kept." })]) {
      expect(html(p)).toContain(CHAT);
    }
  });

  it("says one file in the singular", () => {
    expect(html(props({ preview: preview({ back: [{ path: "a.ts", change: "changed" }] }) }))).toContain("1 file goes back as it was just before the rewind.");
  });

  it("says it is looking at the files, and presses nothing until it has", () => {
    const p = props({ preview: null, loading: true });
    expect(html(p)).toContain("Looking at the files…");
    expect(byId(p, "bring-back-go")[0].props.disabled).toBe(true);
    expect(byId(p, "bring-back-count")).toHaveLength(0);
  });

  it("says there is nothing to bring back when no file differs, and offers nothing to press", () => {
    const p = props({ preview: preview({ back: [] }) });
    expect(html(p)).toContain("No file differs from the files before the rewind, so there is nothing to bring back.");
    expect(byId(p, "bring-back-go")[0].props.disabled).toBe(true);
  });

  it("names the files changed by hand since the rewind, each kept unless unticked", () => {
    const p = props({ preview: preview({ hand: ["src/checkout.tsx", "notes.md"] }), keep: ["src/checkout.tsx"] });
    const out = html(p);
    expect(out).toContain("Changed by hand since the rewind. A ticked file stays as it is now.");
    expect(out).toContain("notes.md");
    const boxes = byId(p, "bring-back-keep");
    expect(boxes.map((b) => b.props.checked)).toEqual([true, false]);
    // ticking and unticking go to the page with the file's own name
    (boxes[1].props.onChange as (e: unknown) => void)({ currentTarget: { checked: true } });
    (boxes[0].props.onChange as (e: unknown) => void)({ currentTarget: { checked: false } });
    expect((p.onKeep as ReturnType<typeof vi.fn>).mock.calls).toEqual([
      ["notes.md", true],
      ["src/checkout.tsx", false],
    ]);
  });

  it("lists no files changed by hand when there are none", () => {
    expect(byId(props(), "bring-back-hand")).toHaveLength(0);
  });

  it("says what stays as it is: files too big to keep, and commits made since", () => {
    expect(html(props({ preview: preview({ tooBig: 1 }) }))).toContain("1 file is too big to keep, so it stays as it is.");
    expect(html(props({ preview: preview({ tooBig: 3 }) }))).toContain("3 files are too big to keep, so they stay as they are.");
    const moved = props({ preview: preview({ headMoved: true }) });
    expect(byId(moved, "bring-back-branch")).toHaveLength(1);
    expect(html(moved)).toContain("The branch has new commits since then. Bringing the files back puts the files back; the commits stay.");
    expect(byId(props(), "bring-back-branch")).toHaveLength(0);
  });

  it("shows what went wrong, as an alert", () => {
    const p = props({ error: "Not brought back: sub is a link, so nothing is written through it. The files are as they were." });
    const alert = byId(p, "bring-back-error")[0];
    expect(alert.props.role).toBe("alert");
    expect(html(p)).toContain("sub is a link, so nothing is written through it");
    expect(byId(props(), "bring-back-error")).toHaveLength(0);
  });
});

describe("what can be pressed", () => {
  it("puts the files back with Bring it back, and closes with Not now", () => {
    const p = props();
    const go = byId(p, "bring-back-go")[0];
    expect(go.props.disabled).toBe(false);
    (go.props.onClick as () => void)();
    (byId(p, "bring-back-close")[0].props.onClick as () => void)();
    expect(p.onGo).toHaveBeenCalledTimes(1);
    expect(p.onClose).toHaveBeenCalledTimes(1);
  });

  it("holds both buttons while the files are being put back, once", () => {
    const p = props({ busy: true });
    expect(byId(p, "bring-back-go")[0].props.disabled).toBe(true);
    expect(byId(p, "bring-back-close")[0].props.disabled).toBe(true);
    expect(html(p)).toContain("Bringing it back…");
  });

  it("is a labelled group, so a screen reader names it", () => {
    const group = byId(props(), "bring-back")[0];
    expect(group.props.role).toBe("group");
    expect(group.props["aria-label"]).toBe("Bring the files back");
  });
});

describe("in the person's language", () => {
  it("says the files come back and the chat stays, in Korean, Japanese and Chinese", () => {
    for (const [lang, words] of [
      ["ko", "채팅은 되감기가 남긴 자리에 그대로 있어요."],
      ["ja", "チャットは巻き戻しが残した場所のままです。"],
      ["zh", "聊天仍停留在回退后的位置。"],
    ] as const) {
      setLang(lang);
      expect(html(props()), lang).toContain(words);
    }
    setLang("ko");
    expect(html(props())).toContain("파일 3개가 되감기 직전 상태로 돌아가요.");
    setLang("ja");
    expect(html(props())).toContain("3 個のファイルが巻き戻しの直前の状態に戻ります。");
    setLang("zh");
    expect(html(props())).toContain("3 个文件会恢复为回退前一刻的样子。");
  });
});
