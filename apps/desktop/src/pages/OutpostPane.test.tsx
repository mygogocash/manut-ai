// Customize › Connections: the Outposts box (the design canvas's Connections.dc.html), drawn with react-dom/server for each
// place this Mac's outpost can stand, in every language, and the Customize page's two tabs. The views use no hooks, so a test
// calls them as plain functions to read the handlers a string render leaves out.
import { afterEach, describe, expect, it, vi } from "vitest";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToString } from "react-dom/server";
import { LANGS, setLang, t } from "../i18n";
import type { OutpostView } from "../runtime/http/outpost";
import { CustomizeView, type MemoryPaneProps, type RoutinesPaneProps } from "./CustomizePage";
import { LOADING } from "./load";
import { MEMORY_START } from "./memory";
import { actionLabel, outpostRow, registeredError, stepsLine, type OutpostContext } from "./outpost";
import { OutpostPane, type OutpostPaneProps } from "./OutpostPane";
import { ROUTINES_START } from "./routines";

afterEach(() => setLang("en"));

const view = (over: Partial<OutpostView> = {}): OutpostView => ({ state: "running", online: true, steps: 0, name: "This Mac", ...over });
const signedIn = (over: Partial<OutpostView> = {}): OutpostContext => ({ kind: "signed_in", view: view(over) });
const pane = (context: OutpostContext, over: Partial<OutpostPaneProps> = {}): OutpostPaneProps => ({
  row: outpostRow(context),
  busy: false,
  error: null,
  onAction: () => {},
  ...over,
});
const words = (html: string) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
const draw = (props: OutpostPaneProps) => renderToString(<OutpostPane {...props} />);

/** Every element a view draws, with its own components expanded. */
function drawn(node: ReactNode): ReactElement<Record<string, unknown>>[] {
  if (Array.isArray(node)) return node.flatMap(drawn);
  if (!isValidElement(node)) return [];
  const el = node as ReactElement<Record<string, unknown>>;
  if (typeof el.type === "function") return drawn((el.type as (props: unknown) => ReactNode)(el.props));
  return [...(typeof el.type === "string" ? [el] : []), ...drawn(el.props.children as ReactNode)];
}

describe("the Outposts box", () => {
  it("shows this Mac running, online, and how many steps it holds, as the canvas's row does", () => {
    const html = draw(pane(signedIn({ steps: 2 })));
    expect(words(html)).toBe(
      "Outposts The machines your team works on. This Mac Running 2 steps Online Stop " +
        "While your team works here, its browser opens in a window of its own and goes only to your shop's own sites. The vault types passwords in. The AI never sees them.",
    );
    expect(html).toContain('class="tag ok"');
    expect(words(draw(pane(signedIn({ steps: 1 }))))).toContain("This Mac Running 1 step Online Stop");
    expect(words(draw(pane(signedIn({ steps: 0, online: false }))))).toContain("This Mac Waiting for work Asleep Stop");
  });

  it("says where it stands in every other case, with the one button that fits", () => {
    const cases: [OutpostContext, string, string | null, string | null][] = [
      [{ kind: "practice" }, "This Mac can be an outpost once Manut AI is connected to your shop.", null, null],
      [{ kind: "signed_out" }, "Sign in to your shop to use this Mac as an outpost.", null, null],
      // A shop the person helps at: only its owner may have this Mac run for it, so there is nothing to press.
      [{ kind: "helper" }, "Only the shop's owner can use this Mac as its outpost.", null, null],
      [signedIn({ state: "unavailable" }), "This computer cannot be an outpost yet.", null, null],
      [signedIn({ state: "unregistered" }), "Not set up. Your team can read your shop's own sites in a browser on this Mac.", null, "Register this Mac"],
      [signedIn({ state: "refused" }), "This Mac is no longer one of your shop's outposts. Register it again to use it.", "Asleep", "Register this Mac"],
      [signedIn({ state: "stopped" }), "Stopped. Your team cannot use this Mac's browser until you start it again.", "Asleep", "Start"],
      [signedIn({ state: "idle" }), "Not running", "Asleep", "Start"],
    ];
    for (const [context, line, tag, button] of cases) {
      const html = draw(pane(context));
      const from = html.indexOf(">", html.indexOf('data-testid="outpost-row"')) + 1;
      const row = words(html.slice(from, html.lastIndexOf("<p", html.indexOf('data-testid="outpost-window"'))));
      expect(row, line).toBe(["This Mac", line, tag, button].filter(Boolean).join(" "));
      expect(html.includes('data-testid="outpost-tag"'), line).toBe(tag !== null);
    }
    // While the shell has not answered, the row says nothing it does not know.
    expect(words(draw(pane({ kind: "signed_in", view: null })))).toContain("This Mac While your team works here");
  });

  it("does what its button says, and offers nothing while a click is under way", () => {
    for (const [state, action] of [["unregistered", "register"], ["refused", "register"], ["running", "stop"], ["stopped", "start"], ["idle", "start"]] as const) {
      const onAction = vi.fn();
      const buttons = drawn(OutpostPane(pane(signedIn({ state }), { onAction }))).filter((e) => e.type === "button");
      expect(buttons.map((b) => b.props["data-testid"])).toEqual([`outpost-${action}`]);
      (buttons[0].props.onClick as () => void)();
      expect(onAction).toHaveBeenCalledWith(action);
    }
    const busy = drawn(OutpostPane(pane(signedIn({ state: "unregistered" }), { busy: true }))).find((e) => e.type === "button")!;
    expect(busy.props.disabled).toBe(true);
    expect(words(renderToString(<>{busy}</>))).toBe("Registering…");
  });

  it("says why a registration did not happen", () => {
    expect(registeredError("registered")).toBeNull();
    expect(registeredError("owner_only")).toBe("Only the shop's owner can add this Mac.");
    expect(registeredError("too_many")).toBe("Your shop already has 20 outposts. Ask your operator to remove one.");
    expect(registeredError("offline")).toBe("Offline: the Manut AI API cannot be reached.");
    expect(registeredError("keychain")).toBe("This Mac's key could not be kept in the keychain, so it is not set up. Try again.");
    expect(registeredError("left")).toBe("You no longer have access to this shop, so this Mac was not added.");
    const html = draw(pane(signedIn({ state: "unregistered" }), { error: registeredError("owner_only") }));
    expect(html).toContain('role="alert"');
    expect(words(html)).toContain("Only the shop's owner can add this Mac.");
  });

  it("has its words in every language", () => {
    const states = ["unregistered", "refused", "stopped", "idle", "unavailable"] as const;
    const english = states.map((state) => outpostRow(signedIn({ state })).line);
    const helper = outpostRow({ kind: "helper" }).line;
    const left = registeredError("left");
    for (const lang of LANGS.filter((l) => l !== "en")) {
      setLang(lang);
      expect(outpostRow({ kind: "helper" }).line, lang).not.toBe(helper);
      expect(registeredError("left"), lang).not.toBe(left);
      expect(draw(pane(signedIn({ steps: 3 })))).toContain(t("outpost.title"));
      expect(stepsLine(3)).toContain("3");
      expect(stepsLine(3)).not.toBe("Running 3 steps");
      expect(actionLabel("register", false)).not.toBe("Register this Mac");
      states.forEach((state, i) => {
        const line = outpostRow(signedIn({ state })).line;
        expect(line, `${lang} ${state}`).not.toBe(english[i]);
        expect(line.length, `${lang} ${state}`).toBeGreaterThan(0);
      });
    }
  });
});

describe("Customize's tabs", () => {
  const memory: MemoryPaneProps = { state: LOADING, ui: MEMORY_START, nowMs: 0, dispatch: () => {}, onRemember: () => {}, onConfirm: () => {}, onCorrect: () => {}, onForget: () => {} };
  const routines: RoutinesPaneProps = { state: LOADING, ui: ROUTINES_START, nowMs: 0, dispatch: () => {}, onAdd: () => {}, onSwitch: () => {} };

  it("draws Memory and routines first, and Connections with the Outposts box in place of memory", () => {
    const onTab = vi.fn();
    const first = renderToString(<CustomizeView memory={memory} routines={routines} onTab={onTab} connections={pane(signedIn({ steps: 2 }))} />);
    expect(words(first)).toMatch(/^Customize Memory and routines Connections /);
    expect(first).not.toContain('data-testid="outposts"');
    expect(first).toContain('data-testid="routines"');
    const second = renderToString(<CustomizeView memory={memory} routines={routines} tab="connections" onTab={onTab} connections={pane(signedIn({ steps: 2 }))} />);
    expect(second).toContain('data-testid="outposts"');
    expect(second).not.toContain('data-testid="routines"');
    expect(words(second)).toContain("This Mac Running 2 steps Online Stop");
    const tabs = drawn(CustomizeView({ memory, routines, tab: "connections", onTab, connections: pane({ kind: "practice" }) }) as ReactNode).filter((e) => e.props.role === "tab");
    expect(tabs.map((tab) => [tab.props["data-testid"], tab.props["aria-selected"]])).toEqual([["customize-tab-memory", false], ["customize-tab-connections", true]]);
    (tabs[0].props.onClick as () => void)();
    expect(onTab).toHaveBeenCalledWith("memory");
  });

  it("draws no tabs where nothing asks for them, as before", () => {
    const html = renderToString(<CustomizeView memory={memory} routines={routines} />);
    expect(html).not.toContain('role="tab"');
    expect(html).toContain('data-testid="routines"');
  });
});
