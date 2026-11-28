// Find in a chat (item 150): the bar as it is drawn in each state, and what its keys do. `FindBarView` draws from props alone,
// so each state is drawn here without a page, and its handlers are read off the elements it returns.
import { createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DICT, LANGS } from "../../i18n";
import { FindBarView, type FindBarViewProps } from "./ChatFind";

const base = (over: Partial<FindBarViewProps> = {}): FindBarViewProps => ({
  text: "",
  options: { caseSensitive: false },
  results: { index: -1, count: 0, capped: false },
  onText: () => {},
  onCase: () => {},
  onStep: () => {},
  onClose: () => {},
  ...over,
});
const html = (over?: Partial<FindBarViewProps>) => renderToString(createElement(FindBarView, base(over)));

type El = ReactElement<{ children?: ReactNode; onKeyDown?: (e: unknown) => void; "data-testid"?: string }>;
/** Every element under `node`, found by test id. */
function find(node: ReactNode, id: string): El | null {
  if (!isValidElement(node)) return Array.isArray(node) ? (node.map((n) => find(n, id)).find(Boolean) ?? null) : null;
  const el = node as El;
  if (el.props["data-testid"] === id) return el;
  const kids = el.props.children;
  return Array.isArray(kids) ? (kids.map((k) => find(k, id)).find(Boolean) ?? null) : find(kids, id);
}
const tree = (over?: Partial<FindBarViewProps>) => FindBarView(base(over));
const key = (k: string, over: Record<string, unknown> = {}) => {
  const calls = { prevented: 0, stopped: 0, selected: 0 };
  const e = { key: k, code: undefined, altKey: false, ctrlKey: false, metaKey: false, shiftKey: false, nativeEvent: {}, preventDefault: () => void calls.prevented++, stopPropagation: () => void calls.stopped++, currentTarget: { select: () => void calls.selected++ }, ...over };
  return { e, calls };
};

afterEach(() => vi.unstubAllGlobals());

describe("the bar", () => {
  it("is a search landmark named for the chat, with the field, the count and every control, as the terminal's has", () => {
    const out = html({ text: "checkout", results: { index: 2, count: 12, capped: false } });
    expect(out).toContain('role="search"');
    expect(out).toContain('aria-label="Find in this chat"');
    for (const id of ["chat-find", "chat-find-input", "chat-find-count", "chat-find-case", "chat-find-prev", "chat-find-next", "chat-find-close"]) expect(out, id).toContain(`data-testid="${id}"`);
    expect(out).toContain('placeholder="Find"');
    expect(out).toContain('value="checkout"');
    expect(out).toMatch(/data-testid="chat-find-count">3 of 12</);
  });

  it("says which match of how many, more than the limit, no matches, and nothing before a word is typed", () => {
    expect(html({ text: "x", results: { index: 0, count: 2000, capped: true } })).toContain(">1 of 2000+<");
    expect(html({ text: "zzz", results: { index: -1, count: 0, capped: false } })).toContain(">No matches<");
    expect(html({ text: "", results: { index: -1, count: 0, capped: false } })).toMatch(/data-testid="chat-find-count"[^>]*><\/span>/);
    // matches found and none yet current (a message came while the person was reading)
    expect(html({ text: "x", results: { index: -1, count: 3, capped: false } })).toContain(">– of 3<");
  });

  it("has Previous and Next off while there is nothing to go to, and on when there is", () => {
    const off = html({ text: "zzz" });
    expect(off).toMatch(/aria-label="Previous match"[^>]*disabled=""/);
    expect(off).toMatch(/aria-label="Next match"[^>]*disabled=""/);
    const on = html({ text: "x", results: { index: 0, count: 3, capped: false } });
    expect(on).not.toMatch(/aria-label="Previous match"[^>]*disabled/);
    expect(on).not.toMatch(/aria-label="Next match"[^>]*disabled/);
  });

  it("shows Match case as a pressed toggle with the terminal's words, off by default", () => {
    expect(html()).toMatch(/aria-label="Match case" title="Match case \(Alt\+C\)" aria-pressed="false"[^>]*data-testid="chat-find-case">Aa</);
    expect(html({ options: { caseSensitive: true } })).toContain('aria-pressed="true"');
  });

  it("has an empty box layer for a web view with no highlights, hidden from a screen reader", () => {
    expect(html()).toContain('class="cf-layer" aria-hidden="true"');
  });

  it("has its label in all four languages", () => {
    for (const l of LANGS) expect(DICT[l]["find.chatLabel"].trim(), l).not.toBe("");
    expect(DICT.en["find.chatLabel"]).not.toBe(DICT.en["find.label"]);
  });
});

describe("its keys", () => {
  it("Escape closes the bar, and the key goes no further: it is not the running answer's Stop", () => {
    const onClose = vi.fn();
    const { e, calls } = key("Escape");
    find(tree({ onClose }), "chat-find")!.props.onKeyDown!(e);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(calls).toMatchObject({ prevented: 1, stopped: 1 });
  });

  it("Escape that ends an input method's word is not Escape for the bar", () => {
    const onClose = vi.fn();
    const { e } = key("Escape", { nativeEvent: { isComposing: true } });
    find(tree({ onClose }), "chat-find")!.props.onKeyDown!(e);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("Alt+C flips Match case, by the letter or where C stands (Option+C types ç on a Mac), and Alt+R is not a key of this bar", () => {
    const onCase = vi.fn();
    const bar = find(tree({ onCase }), "chat-find")!;
    bar.props.onKeyDown!(key("c", { altKey: true }).e);
    bar.props.onKeyDown!(key("ç", { altKey: true, code: "KeyC" }).e);
    expect(onCase).toHaveBeenCalledTimes(2);
    bar.props.onKeyDown!(key("r", { altKey: true }).e);
    bar.props.onKeyDown!(key("c").e);
    expect(onCase).toHaveBeenCalledTimes(2);
  });

  it("Enter goes to the next match and Shift+Enter to the previous, when there is a word", () => {
    const onStep = vi.fn();
    const field = find(tree({ text: "x", onStep }), "chat-find-input")!;
    field.props.onKeyDown!(key("Enter").e);
    field.props.onKeyDown!(key("Enter", { shiftKey: true }).e);
    expect(onStep.mock.calls).toEqual([[1], [-1]]);
  });

  it("Enter with no word, or that commits an input method's word, goes nowhere", () => {
    const onStep = vi.fn();
    find(tree({ text: "", onStep }), "chat-find-input")!.props.onKeyDown!(key("Enter").e);
    find(tree({ text: "x", onStep }), "chat-find-input")!.props.onKeyDown!(key("Enter", { nativeEvent: { isComposing: true } }).e);
    find(tree({ text: "x", onStep }), "chat-find-input")!.props.onKeyDown!(key("Enter", { keyCode: 229 }).e);
    expect(onStep).not.toHaveBeenCalled();
  });

  it("⌘F in the field takes the keyboard back to it with its words selected, and does not open anything else", () => {
    vi.stubGlobal("navigator", { platform: "MacIntel" });
    const { e, calls } = key("f", { metaKey: true, code: "KeyF", nativeEvent: { key: "f", code: "KeyF", metaKey: true, ctrlKey: false, altKey: false, shiftKey: false } });
    find(tree({ text: "x" }), "chat-find-input")!.props.onKeyDown!(e);
    expect(calls).toMatchObject({ prevented: 1, selected: 1 });
  });
});
