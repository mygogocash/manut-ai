// A home for the old member rows' actions, which the side menu dropped: on the Team page each member's row has a More
// button that opens a menu with a new thread with the member, Pin to top (Unpin) and, where the runtime can restart an
// agent, Restart (Start). The view is drawn from the rows it is given, as the other pages are; the last tests build the
// rows from the app's own store on the demo runtime and press the actions.
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { renderToString } from "react-dom/server";
import { setLang } from "../i18n";
import { MockHost, MockRuntime } from "../runtime/mock";
import { createStore } from "../state/store";
import { TeamView, teamRows, type TeamRow } from "./TeamPage";
import { tryAction } from "./team";

const words = (html: string) =>
  html
    .replace(/<[^>]*>/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");
const count = (html: string, needle: string) => html.split(needle).length - 1;
const noop = () => {};

/** Every element the view itself draws, without running the components it nests (those may hold hooks). */
function drawn(node: ReactNode): ReactElement<Record<string, unknown>>[] {
  if (Array.isArray(node)) return node.flatMap(drawn);
  if (!isValidElement(node)) return [];
  const el = node as ReactElement<Record<string, unknown>>;
  return [el, ...drawn(el.props.children as ReactNode)];
}
const byId = (view: ReactNode, id: string) => drawn(view).filter((e) => e.props["data-testid"] === id);

const member = (over: Partial<TeamRow> & { name: string }): TeamRow => ({ displayName: over.name[0].toUpperCase() + over.name.slice(1), description: "", status: "idle", open: noop, ...over });

describe("a member's menu on the Team page", () => {
  it("draws a More button for a member that has a menu, and none for one that has not, and no menu until one is open", () => {
    setLang("en");
    const html = renderToString(
      <TeamView
        members={[
          member({ name: "nam", menu: [{ action: "new", run: noop }, { action: "pin", run: noop }] }),
          member({ name: "pim" }),
        ]}
        menu={null}
        onMenu={noop}
      />,
    );
    expect(html).toMatch(/<button[^>]*aria-label="More for Nam"[^>]*aria-haspopup="menu"[^>]*aria-expanded="false"/);
    expect(html).toContain('data-testid="team-more-nam"');
    expect(html).not.toContain('data-testid="team-more-pim"');
    expect(html).not.toContain('role="menu"');
  });

  it("lists the open member's actions in the old row menu's words, and marks only that member's button open", () => {
    setLang("en");
    const html = renderToString(
      <TeamView
        members={[
          member({ name: "nam", menu: [{ action: "new", run: noop }, { action: "pin", run: noop }, { action: "restart", run: noop }] }),
          member({ name: "pim", menu: [{ action: "new", run: noop }, { action: "pin", run: noop }] }),
        ]}
        menu="nam"
        onMenu={noop}
      />,
    );
    expect(count(html, 'role="menu"')).toBe(1);
    expect(html).toContain('aria-label="Nam actions"');
    expect(html).toMatch(/aria-label="More for Nam"[^>]*aria-expanded="true"/);
    expect(html).toMatch(/aria-label="More for Pim"[^>]*aria-expanded="false"/);
    const menu = words(html.slice(html.indexOf('role="menu"'), html.indexOf("</ul>", html.indexOf('role="menu"'))));
    expect(menu).toContain("New thread · Nam");
    expect(menu).toContain("Pin to top");
    expect(menu).toContain("Restart");
    for (const id of ["team-menu-new-nam", "team-menu-pin-nam", "team-menu-restart-nam"]) expect(html, id).toContain(`data-testid="${id}"`);
  });

  it("says Unpin and Start for a pinned member that is not running, and marks the pinned member", () => {
    setLang("en");
    const html = renderToString(<TeamView members={[member({ name: "kit", status: "offline", pinned: true, menu: [{ action: "unpin", run: noop }, { action: "start", run: noop }] })]} menu="kit" onMenu={noop} />);
    const menu = words(html.slice(html.indexOf('role="menu"')));
    expect(menu).toContain("Unpin");
    expect(menu).toContain("Start");
    expect(menu).not.toContain("Pin to top");
    expect(html).toContain('data-testid="team-pinned-kit"');
    expect(html).toContain('aria-label="Pinned"');
  });

  it("opens the menu on a press of More, and closes it on a second press", () => {
    const onMenu = vi.fn();
    const rows = [member({ name: "nam", menu: [{ action: "pin", run: noop }] })];
    const [open] = byId(TeamView({ members: rows, menu: null, onMenu }), "team-more-nam");
    (open.props.onClick as () => void)();
    expect(onMenu).toHaveBeenLastCalledWith("nam");
    const [shut] = byId(TeamView({ members: rows, menu: "nam", onMenu }), "team-more-nam");
    (shut.props.onClick as () => void)();
    expect(onMenu).toHaveBeenLastCalledWith(null);
  });

  it("runs an action once and closes the menu, and Escape closes it without running anything", () => {
    const onMenu = vi.fn();
    const pin = vi.fn();
    const view = TeamView({ members: [member({ name: "nam", menu: [{ action: "pin", run: pin }] })], menu: "nam", onMenu });
    (byId(view, "team-menu-pin-nam")[0].props.onClick as () => void)();
    expect(pin).toHaveBeenCalledTimes(1);
    expect(onMenu).toHaveBeenLastCalledWith(null);
    onMenu.mockClear();
    const [menu] = byId(view, "team-menu-nam");
    const key = { key: "Escape", preventDefault: vi.fn() };
    (menu.props.onKeyDown as (e: typeof key) => void)(key);
    expect(key.preventDefault).toHaveBeenCalled();
    expect(onMenu).toHaveBeenCalledWith(null);
    expect(pin).toHaveBeenCalledTimes(1);
  });
});

/** A store of its own on a fresh demo runtime, listing the whole team as the app does on a first run. */
async function demoStore() {
  const store = createStore(new MockRuntime(new MockHost()), { firstRoster: "all", hiddenBots: () => [], resume: () => null });
  await store.actions.init();
  return store;
}

describe("the rows built from the store", () => {
  it("give every listed member a new thread and pinning, and no restart on a runtime that cannot restart", async () => {
    const store = await demoStore();
    const rows = teamRows(store.getSnapshot(), { canRestart: false });
    expect(rows.map((r) => [r.name, r.menu?.map((a) => a.action)])).toEqual([
      ["buddy", ["new", "pin"]],
      ["nam", ["new", "pin"]],
      ["pim", ["new", "pin"]],
      ["ton", ["new", "pin"]],
      ["kit", ["new", "pin"]],
    ]);
  });

  it("add Restart for a runtime that can restart, and press it through the restart that the other places use", async () => {
    const store = await demoStore();
    const restart = vi.fn();
    const rows = teamRows(store.getSnapshot(), { canRestart: true, restart });
    const nam = rows.find((r) => r.name === "nam")!;
    expect(nam.menu?.map((a) => a.action)).toEqual(["new", "pin", "restart"]);
    nam.menu!.find((a) => a.action === "restart")!.run();
    expect(restart).toHaveBeenCalledWith("nam");
  });

  it("pin a member to the top, where the list then puts them, and Unpin puts them back", async () => {
    const store = await demoStore();
    const nam = () => teamRows(store.getSnapshot(), { canRestart: false }).find((r) => r.name === "nam")!;
    nam().menu!.find((a) => a.action === "pin")!.run();
    const pinned = teamRows(store.getSnapshot(), { canRestart: false });
    expect(pinned.map((r) => r.name)).toEqual(["nam", "buddy", "pim", "ton", "kit"]);
    expect(pinned[0]).toMatchObject({ name: "nam", pinned: true });
    expect(pinned[0].menu?.map((a) => a.action)).toEqual(["new", "unpin"]);
    pinned[0].menu!.find((a) => a.action === "unpin")!.run();
    const back = teamRows(store.getSnapshot(), { canRestart: false });
    expect(back.map((r) => r.name)).toEqual(["buddy", "nam", "pim", "ton", "kit"]);
    expect(back.find((r) => r.name === "nam")?.pinned).toBeFalsy();
  });

  it("start a new, empty thread with that member and open it", async () => {
    const store = await demoStore();
    const nam = teamRows(store.getSnapshot(), { canRestart: false }).find((r) => r.name === "nam")!;
    await nam.menu!.find((a) => a.action === "new")!.run();
    const { ui, selectedBot } = store.getState();
    expect(selectedBot).toBe("nam");
    expect(ui).toMatchObject({ view: "chat" });
    expect(ui.thread).not.toBeNull();
    expect(store.getState().threads.nam?.some((t) => t.thread === ui.thread)).toBe(true);
  });
});

describe("an action that only the store's error reports", () => {
  const store = (lastError: string | null) => {
    const state = { lastError };
    return { getState: () => state, dispatch: (a: { type: string; message: string | null }) => void (state.lastError = a.message) };
  };

  it("answers null when it went through, and the runtime's own words when it did not", async () => {
    expect(await tryAction(store(null), async () => undefined)).toBeNull();
    const refused = store(null);
    expect(await tryAction(refused, async () => void refused.dispatch({ type: "error", message: "Not yet: the connected runtime does not start threads." }))).toBe("Not yet: the connected runtime does not start threads.");
  });

  it("ignores an error left over from something earlier", async () => {
    expect(await tryAction(store("an old error"), async () => undefined)).toBeNull();
  });
});
