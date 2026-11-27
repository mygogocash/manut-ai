// The job's side-by-side view from props alone (item 102b), drawn with react-dom/server, its buttons read from the elements it
// returns (the view uses no hooks). How the columns and tabs lay out is e2e/several-agents.spec.ts's, with its pictures; what is
// pressed in the app, and the one ask settled once across the column, the lane's chat and Needs you, is the same spec's.
import { createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LANGS, setLang, t } from "../i18n";
import { createStore, selectAsks, type ApprovalItem } from "../state/store";
import { MockHost, MockRuntime } from "../runtime/mock";
import { settleApproval } from "../chat/cards/respond";
import { SideBySideView, type JobColumn, type SideBySideProps } from "./SideBySide";

afterEach(() => {
  setLang("en");
  vi.useRealTimers();
});

function drawn(node: ReactNode): ReactElement<Record<string, unknown>>[] {
  if (Array.isArray(node)) return node.flatMap(drawn);
  if (!isValidElement(node)) return [];
  const el = node as ReactElement<Record<string, unknown>>;
  if (typeof el.type === "function") return drawn((el.type as (props: unknown) => ReactNode)(el.props));
  return [...(typeof el.type === "string" ? [el] : []), ...drawn(el.props.children as ReactNode)];
}
const press = (els: ReactElement<Record<string, unknown>>[], id: string) => (els.find((e) => e.props["data-testid"] === id)!.props.onClick as () => void)();

const col = (id: string, over: Partial<JobColumn> = {}): JobColumn => ({
  id,
  agentId: id === "s2" ? "codex" : "claude",
  agent: id === "s2" ? "Codex" : "Claude Code",
  model: id === "s2" ? "GPT-6.1 Sol" : "Opus 5.5",
  branch: `kit/${id}`,
  status: "checked",
  step: "",
  since: null,
  testing: false,
  stoppable: false,
  chat: createElement("div", { "data-chat": id }, `chat of ${id}`),
  asks: null,
  ...over,
});
const THREE = (): JobColumn[] => [
  col("s1", { status: "working", step: "Running the tests", since: 40_000, stoppable: true }),
  col("s2", { status: "needs_you", stoppable: true, asks: createElement("div", { "data-ask": "s2" }, "Allow pnpm add qrcode?") }),
  col("s3", { status: "failed" }),
];
const props = (over: Partial<SideBySideProps> = {}): SideBySideProps => ({
  title: "Add the PromptPay QR",
  columns: THREE(),
  now: 100_000,
  active: "s1",
  onActive: vi.fn(),
  onBack: vi.fn(),
  onOpenLane: vi.fn(),
  onStop: vi.fn(),
  confirm: false,
  onStopAll: vi.fn(),
  onConfirm: vi.fn(),
  onCancel: vi.fn(),
  onAgain: vi.fn(),
  ...over,
});
const html = (p: SideBySideProps) => renderToString(createElement(SideBySideView, p));

describe("the side-by-side view", () => {
  it("has a column for each lane, with the agent, its model and its branch, and the job's name on top", () => {
    const out = html(props());
    expect(out).toContain("3 agents: Add the PromptPay QR");
    for (const id of ["s1", "s2", "s3"]) {
      expect(out).toContain(`data-testid="jv-col-${id}"`);
      expect(out).toContain(`kit/${id}`);
    }
    expect(out).toContain("Opus 5.5");
    expect(out).toContain("GPT-6.1 Sol");
    // the lane's own chat is drawn in its column
    expect(out).toContain("chat of s2");
  });

  it("tags each column as the Lanes band does: the step and its time while working, else the state's words", () => {
    const out = html(props());
    expect(out).toMatch(/data-testid="jv-state-s1"[^>]*>Running the tests<span class="when">[^<]+<\/span>/);
    expect(out).toMatch(/data-testid="jv-state-s2"[^>]*>Needs you</);
    expect(out).toMatch(/data-testid="jv-state-s3"[^>]*>Failed</);
  });

  it("draws the ask card only in the column of a lane that asks", () => {
    const out = html(props());
    expect(out.split("data-ask=").length - 1).toBe(1);
    expect(out).toContain('data-testid="jv-asks-s2"');
    expect(out).not.toContain('data-testid="jv-asks-s1"');
    expect(out).not.toContain('data-testid="jv-asks-s3"');
  });

  it("has tabs that name each agent and its state, and the active one is marked", () => {
    const els = drawn(SideBySideView(props({ active: "s2" })));
    const tabs = els.filter((e) => e.props.role === "tab");
    expect(tabs.map((e) => e.props["aria-selected"])).toEqual([false, true, false]);
    const onActive = vi.fn();
    press(drawn(SideBySideView(props({ onActive }))), "jv-tab-s3");
    expect(onActive).toHaveBeenCalledWith("s3");
    expect(html(props())).toContain('data-active="true"');
  });

  it("opens a lane with Open lane, and stops a lane with Stop only while its turn runs", () => {
    const onOpenLane = vi.fn();
    const onStop = vi.fn();
    const els = drawn(SideBySideView(props({ onOpenLane, onStop })));
    press(els, "jv-open-s3");
    expect(onOpenLane).toHaveBeenCalledWith("s3");
    press(els, "jv-stop-s1");
    expect(onStop).toHaveBeenCalledWith("s1");
    const stop = (id: string) => els.find((e) => e.props["data-testid"] === `jv-stop-${id}`)!;
    expect(stop("s1").props.disabled).toBe(false);
    expect(stop("s3").props.disabled).toBe(true);
  });

  it("asks once before Stop all: the first press stops nothing, the question names how many are working, and only Stop all in it stops", () => {
    const onStopAll = vi.fn();
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    const first = drawn(SideBySideView(props({ onStopAll, onConfirm, onCancel })));
    press(first, "jv-stopall");
    expect(onStopAll).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
    // the question, in place of the two buttons
    const asking = props({ confirm: true, onConfirm, onCancel });
    const out = html(asking);
    expect(out).toContain("Stop all 2 agents that are working?");
    expect(out).not.toContain('data-testid="jv-stopall"');
    const els = drawn(SideBySideView(asking));
    press(els, "jv-stopall-keep");
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
    press(els, "jv-stopall-yes");
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("holds Stop all while no lane's turn runs", () => {
    const quiet = props({ columns: [col("s1"), col("s2")] });
    const stopAll = drawn(SideBySideView(quiet)).find((e) => e.props["data-testid"] === "jv-stopall")!;
    expect(stopAll.props.disabled).toBe(true);
  });

  it("has Ask them again and no box that writes to every lane", () => {
    const onAgain = vi.fn();
    const els = drawn(SideBySideView(props({ onAgain })));
    press(els, "jv-again");
    expect(onAgain).toHaveBeenCalledTimes(1);
    expect(els.some((e) => e.type === "textarea" || e.type === "input" || e.props["data-testid"] === "composer")).toBe(false);
  });

  it("goes back to the lanes", () => {
    const onBack = vi.fn();
    press(drawn(SideBySideView(props({ onBack }))), "jv-back");
    expect(onBack).toHaveBeenCalled();
  });

  it("reads in every language", () => {
    for (const lang of LANGS) {
      setLang(lang);
      const out = html(props({ confirm: true }));
      for (const key of ["jobview.back", "jobview.openLane", "jobview.stop", "jobview.keep"] as const) expect(out, `${lang} ${key}`).toContain(t(key));
      expect(out, lang).toContain(t("jobview.stopAllAsk", { n: 2 }));
    }
  });
});

describe("an ask shown in a column", () => {
  // The column draws the lane's own ask card (`Timeline`'s and Needs you's `Cards`), which settles through `settleApproval`; so the
  // one ask is the same request in the column, in the lane's chat and in Needs you, and the runtime takes the first answer only.
  it("is one request: answered once it leaves Needs you, and a second press on it is refused", async () => {
    vi.useFakeTimers();
    const store = createStore(new MockRuntime(new MockHost()), { firstRoster: "all", hiddenBots: () => [], resume: () => null });
    await store.actions.init();
    await store.actions.selectBot("nam");
    const sent = store.actions.send("/approve");
    await vi.advanceTimersByTimeAsync(2_000);
    await sent;
    const [ask] = selectAsks(store.getState());
    const item = ask.item as ApprovalItem;
    expect(await settleApproval(store, ask.bot, item, "once")).toBeNull();
    expect(selectAsks(store.getState())).toEqual([]);
    const decided = store.getState().chats.nam.items.find((i) => i.id === item.id) as ApprovalItem;
    expect(decided.resolved).toBe("once");
    // the second press, from any of the three places, is refused and the first answer stands
    await settleApproval(store, ask.bot, item, "deny");
    expect(store.getState().lastError).toMatch(/no pending approval/);
    expect((store.getState().chats.nam.items.find((i) => i.id === item.id) as ApprovalItem).resolved).toBe("once");
  });
});
