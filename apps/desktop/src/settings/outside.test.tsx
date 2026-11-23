// Settings › General › Notifications: "Hide details" (off by default) and quiet hours (a start and an end, 22:00 to 08:00
// by default), in the canvas's words, saved on this computer with the app's other settings. Also what Settings says about
// the lock screen, which the app cannot see: macOS hides previews there itself when "Show previews" is "When Unlocked".
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DICT, LANGS, setLang } from "../i18n";
import { HideDetailsToggle, HideDetailsView, OutsideNotes, OutsideRows, QuietHoursInputs, QuietHoursView } from "./Settings.slot";

const words = (html: string) => html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
const fake = (seed: Record<string, string> = {}) => {
  const data = { ...seed };
  return { data, getItem: (k: string) => (k in data ? data[k] : null), setItem: (k: string, v: string) => void (data[k] = v) };
};

/** Every element in a tree of elements, parents first, for a view that uses no hooks and can be called as a function. */
function walk(node: ReactNode, out: ReactElement<Record<string, unknown>>[] = []): ReactElement<Record<string, unknown>>[] {
  if (Array.isArray(node)) node.forEach((n) => walk(n, out));
  else if (isValidElement(node)) {
    out.push(node as ReactElement<Record<string, unknown>>);
    walk((node.props as { children?: ReactNode }).children, out);
  }
  return out;
}
const testId = (tree: ReactNode, id: string) => walk(tree).find((e) => e.props["data-testid"] === id)!;

afterEach(() => {
  vi.unstubAllGlobals();
  setLang("en");
});

describe("Hide details", () => {
  it("is a switch named Hide details, off until turned on", () => {
    vi.stubGlobal("localStorage", fake());
    const html = renderToString(<HideDetailsToggle />);
    expect(html).toMatch(/role="switch"[^>]*aria-checked="false"[^>]*aria-label="Hide details"/);
  });

  it("is on when it was saved on", () => {
    vi.stubGlobal("localStorage", fake({ "manut.notify.hide": "on" }));
    expect(renderToString(<HideDetailsToggle />)).toMatch(/aria-checked="true"/);
  });

  it("tells its owner the new value when pressed", () => {
    const changes: boolean[] = [];
    const tree = HideDetailsView({ on: false, onChange: (v) => changes.push(v) });
    (tree.props as { onChange: (v: boolean) => void }).onChange(true);
    expect(changes).toEqual([true]);
  });
});

describe("Quiet hours", () => {
  it("shows the canvas's 22:00 to 08:00 until the owner chooses others, as two time fields", () => {
    vi.stubGlobal("localStorage", fake());
    const html = renderToString(<QuietHoursInputs />);
    expect(html).toMatch(/<input type="time"[^>]*aria-label="Quiet hours start"[^>]*value="22:00"/);
    expect(html).toMatch(/<input type="time"[^>]*aria-label="Quiet hours end"[^>]*value="08:00"/);
  });

  it("shows what was saved", () => {
    vi.stubGlobal("localStorage", fake({ "manut.notify.quiet": "21:30-06:15" }));
    const html = renderToString(<QuietHoursInputs />);
    expect(html).toContain('value="21:30"');
    expect(html).toContain('value="06:15"');
  });

  it("gives a new start or end to its owner, and nothing for a field that was emptied", () => {
    const got: string[] = [];
    const tree = QuietHoursView({ start: "22:00", end: "08:00", onStart: (v) => got.push(`start ${v}`), onEnd: (v) => got.push(`end ${v}`) });
    const change = (id: string, value: string) => (testId(tree, id).props.onChange as (e: { target: { value: string } }) => void)({ target: { value } });
    change("set-quiet-start", "23:00");
    change("set-quiet-end", "07:30");
    change("set-quiet-start", "");
    expect(got).toEqual(["start 23:00", "end 07:30"]);
  });
});

describe("what Settings says under the group", () => {
  it("uses the canvas's words for quiet hours and the two alerts that still ring", () => {
    vi.stubGlobal("localStorage", fake());
    expect(words(renderToString(<OutsideRows />))).toContain("Nothing makes a sound. Requests wait in Updates.");
    expect(words(renderToString(<OutsideNotes />))).toContain("A live page that stops working and a sign-in from a new device still alert you.");
  });

  it("has a row for each choice, Hide details first", () => {
    vi.stubGlobal("localStorage", fake());
    const html = renderToString(<OutsideRows />);
    expect(html.indexOf("Hide details")).toBeGreaterThan(-1);
    expect(html.indexOf("Quiet hours")).toBeGreaterThan(html.indexOf("Hide details"));
    expect(words(html)).toContain("A notification shows no names, amounts or customers. It only says how many requests need you.");
  });

  it("says which clock quiet hours follow", () => {
    expect(words(renderToString(<OutsideNotes />))).toContain("Times are Bangkok time (Asia/Bangkok).");
  });

  it("says macOS hides previews on the lock screen when Show previews is When Unlocked, since the app cannot see the lock", () => {
    expect(words(renderToString(<OutsideNotes />))).toContain(
      "macOS hides previews on the lock screen when System Settings › Notifications › Show previews is “When Unlocked”.",
    );
  });

  it("says it in every language the app speaks", () => {
    vi.stubGlobal("localStorage", fake());
    for (const l of LANGS) {
      setLang(l);
      const text = words(renderToString(<OutsideRows />)) + " " + words(renderToString(<OutsideNotes />));
      for (const k of ["out.hideDetails", "out.hideDetailsHint", "out.quiet", "out.quietHint", "out.quietAlerts", "out.quietZone", "out.lockNote"] as const) expect(text, `${l} ${k}`).toContain(DICT[l][k]);
    }
  });
});
