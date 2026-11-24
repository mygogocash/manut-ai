// What keeps running on the Code page, drawn with react-dom/server from props, and its buttons read from the elements it
// returns (the view uses no hooks). The project is the canvas's baanmali-preorder.
import { createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setLang } from "../i18n";
import { MIN_AGE_MS, rowKey, type RunningRow } from "./model";
import { RunningPanelView, runningItems, type ItemContext, type RunningItem } from "./RunningPanel";

const NOW = 10_000_000;
const ROOT = "/home/you/code/baanmali-preorder";
const row = (o: Partial<RunningRow> = {}): RunningRow => ({ kind: "pty", session: 1, folder: ROOT, pid: 100, started: NOW - 42 * 60_000, argv: ["node", "/opt/homebrew/lib/node_modules/pnpm/bin/pnpm.cjs", "dev"], ports: [3000], ...o });
const state = (rows: RunningRow[], o: Partial<{ seen: Record<string, number>; stopping: Record<string, number>; failed: Record<string, true> }> = {}) => ({ rows, seen: {}, stopping: {}, failed: {}, ...o });
const ctx = (o: Partial<ItemContext> = {}): ItemContext => ({ now: NOW, lane: () => null, ...o });

function drawn(node: ReactNode): ReactElement<Record<string, unknown>>[] {
  if (Array.isArray(node)) return node.flatMap(drawn);
  if (!isValidElement(node)) return [];
  const el = node as ReactElement<Record<string, unknown>>;
  if (typeof el.type === "function") return drawn((el.type as (props: unknown) => ReactNode)(el.props));
  return [...(typeof el.type === "string" ? [el] : []), ...drawn(el.props.children as ReactNode)];
}
const view = (items: RunningItem[], onStop = vi.fn()) => ({ items, onStop });
const byId = (items: RunningItem[], id: string, onStop = vi.fn()) => drawn(RunningPanelView(view(items, onStop))).filter((e) => e.props["data-testid"] === id);
const html = (items: RunningItem[]) => renderToString(createElement(RunningPanelView, view(items)));

afterEach(() => setLang("en"));

describe("the items", () => {
  it("make a row of each command that has run a few seconds, the oldest first, with its words", () => {
    const dev = row({ pid: 1, started: NOW - 42 * 60_000 });
    const test = row({ pid: 2, started: NOW - 90_000, argv: ["/bin/zsh", "-lc", "pnpm test"], ports: [] });
    const quick = row({ pid: 3, started: NOW - (MIN_AGE_MS - 1), argv: ["git", "status"], ports: [] });
    const items = runningItems(state([test, quick, dev]), ctx());
    expect(items.map((i) => i.row.pid)).toEqual([1, 2]);
    expect(items.map((i) => [i.label, i.ran, i.ports])).toEqual([
      ["pnpm dev", "42m", "port 3000"],
      ["pnpm test", "1m", ""],
    ]);
    expect(items[0].key).toBe(rowKey(dev));
  });

  it("hide a key in the command", () => {
    const key = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";
    const [item] = runningItems(state([row({ argv: ["node", "/code/app/server.js", `--token=${key}`] })]), ctx());
    expect(item.label).not.toContain("ghp_");
    expect(item.label).toContain("••••");
  });

  it("name the project of each row only when the list reaches more than one", () => {
    const a = row({ pid: 1 });
    const b = row({ pid: 2, folder: "/home/you/code/storefront/", started: NOW - 3_600_000 });
    expect(runningItems(state([a]), ctx()).map((i) => i.project)).toEqual([null]);
    expect(runningItems(state([a, b]), ctx()).map((i) => [i.row.pid, i.project])).toEqual([
      [2, "storefront"],
      [1, "baanmali-preorder"],
    ]);
    // asked for one project, it is only that one's, and it needs no name
    expect(runningItems(state([a, b]), ctx({ project: ROOT })).map((i) => [i.row.pid, i.project])).toEqual([[1, null]]);
  });

  it("name the terminal a command runs in, only for a terminal", () => {
    const open = vi.fn();
    const lane = vi.fn((r: RunningRow) => (r.kind === "pty" && r.session === 1 ? { name: "PromptPay QR at checkout", open } : null));
    const items = runningItems(state([row({ pid: 1 }), row({ pid: 2, kind: "chat", session: 1, started: NOW - 3_600_000 }), row({ pid: 3, session: 9, started: NOW - 7_200_000 })]), ctx({ lane }));
    expect(items.map((i) => [i.row.pid, i.lane])).toEqual([
      [3, null],
      [2, null],
      [1, "PromptPay QR at checkout"],
    ]);
    items[2].open?.();
    expect(open).toHaveBeenCalledOnce();
    expect(items[0].open).toBeNull();
  });

  it("carry what Stop did: pressed, or would not work", () => {
    const a = row({ pid: 1 });
    const b = row({ pid: 2, started: NOW - 3_600_000 });
    const items = runningItems(state([a, b], { stopping: { [rowKey(a)]: NOW - 1000 }, failed: { [rowKey(b)]: true } }), ctx());
    expect(items.map((i) => [i.row.pid, i.stopping, i.failed])).toEqual([
      [2, false, true],
      [1, true, false],
    ]);
  });

  it("count a command whose start the system would not say from when the page first saw it", () => {
    const unknown = row({ pid: 8, started: null, ports: [] });
    expect(runningItems(state([unknown]), ctx())).toEqual([]);
    const [item] = runningItems(state([unknown], { seen: { [rowKey(unknown)]: NOW - 125_000 } }), ctx());
    expect(item.ran).toBe("2m");
  });
});

describe("the panel", () => {
  it("says nothing runs when nothing does", () => {
    const out = html([]);
    expect(out).toContain("What keeps running");
    expect(out).toContain("Nothing started here is still running.");
    expect(byId([], "running-row")).toHaveLength(0);
    expect(byId([], "running-none")).toHaveLength(1);
  });

  it("draws a command as the canvas does: Running, what it is, how long, its port, and Stop", () => {
    const items = runningItems(state([row()]), ctx());
    const out = html(items);
    for (const words of ["Running", "pnpm dev", "42m", "port 3000", "Stop"]) expect(out).toContain(words);
    expect(out).toContain('aria-label="Stop pnpm dev"');
    expect(byId(items, "running-row")).toHaveLength(1);
    expect(byId(items, "running-none")).toHaveLength(0);
  });

  it("stops the command its Stop names, once", () => {
    const r = row();
    const onStop = vi.fn();
    const [stop] = byId(runningItems(state([r]), ctx()), "running-stop", onStop);
    expect(stop.props["aria-disabled"]).toBeUndefined();
    (stop.props.onClick as () => void)();
    expect(onStop).toHaveBeenCalledWith(r);
    // while it is stopping the button says so, is marked busy and disabled (it keeps the focus), and does nothing
    const busy = runningItems(state([r], { stopping: { [rowKey(r)]: NOW } }), ctx());
    const [again] = byId(busy, "running-stop", onStop);
    expect(again.props["aria-busy"]).toBe(true);
    expect(again.props["aria-disabled"]).toBe(true);
    (again.props.onClick as () => void)();
    expect(onStop).toHaveBeenCalledTimes(1);
    expect(html(busy)).toContain("Stopping");
  });

  it("says when a command would not stop", () => {
    const r = row();
    expect(html(runningItems(state([r]), ctx()))).not.toContain("Could not stop it");
    const items = runningItems(state([r], { failed: { [rowKey(r)]: true } }), ctx());
    expect(html(items)).toContain("Could not stop it. Try again.");
    expect(byId(items, "running-failed")[0].props.role).toBe("status");
  });

  it("opens the terminal a command runs in from its name", () => {
    const open = vi.fn();
    const items = runningItems(state([row()]), ctx({ lane: () => ({ name: "Shell", open }) }));
    expect(html(items)).toContain("Shell");
    (byId(items, "running-lane")[0].props.onClick as () => void)();
    expect(open).toHaveBeenCalledOnce();
  });

  it("shows no key anywhere a person or a screen reader reads", () => {
    const key = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";
    const out = html(runningItems(state([row({ argv: ["node", "/code/app/server.js", `--token=${key}`] })]), ctx()));
    expect(out).not.toContain("ghp_");
    expect(out).not.toContain("abcdefghijklmnop");
  });

  it("is in all four languages", () => {
    for (const [lang, words] of [
      ["ko", ["계속 실행 중인 명령", "실행 중", "멈추기", "포트 3000", "42분"]],
      ["ja", ["実行し続けているコマンド", "実行中", "停止", "ポート 3000", "42分"]],
      ["zh", ["持续运行的命令", "运行中", "停止", "端口 3000", "42 分钟"]],
    ] as const) {
      setLang(lang);
      // the items carry their words, so they are made after the language is set, as the page makes them on each draw
      const out = html(runningItems(state([row()]), ctx()));
      for (const w of words) expect(out, `${lang} ${w}`).toContain(w);
    }
  });
});
