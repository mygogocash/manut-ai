// What each member's row on the Team page says under their name (teamLine.ts), drawn with react-dom/server from the rows it
// is given, and the rows built from the app's own store on the demo runtime: a member who waits on the person has Look first
// beside their status, one who is idle says when their last job was, and so on. The words are the design canvas's member
// states (StatesTeam.dc.html).
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToString } from "react-dom/server";
import { setLang } from "../i18n";
import { MockHost, MockRuntime } from "../runtime/mock";
import { APPROVAL_SEED } from "../runtime/mock/seed";
import type { JobRow } from "../runtime/mission";
import { createStore, selectAsks } from "../state/store";
import { TeamView, teamRows, type TeamRow } from "./TeamPage";

const words = (html: string) =>
  html
    .replace(/<[^>]*>/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
const noop = () => {};
const NOW = new Date(2026, 10, 22, 12, 0, 0).getTime();
const at = (h: number, m: number, day = 22) => new Date(2026, 10, day, h, m).getTime() / 1000;

function drawn(node: ReactNode): ReactElement<Record<string, unknown>>[] {
  if (Array.isArray(node)) return node.flatMap(drawn);
  if (!isValidElement(node)) return [];
  const el = node as ReactElement<Record<string, unknown>>;
  return [el, ...drawn(el.props.children as ReactNode)];
}
const byId = (view: ReactNode, id: string) => drawn(view).filter((e) => e.props["data-testid"] === id);
const member = (over: Partial<TeamRow> & { name: string }): TeamRow => ({ displayName: over.name[0].toUpperCase() + over.name.slice(1), description: "", status: "idle", open: noop, ...over });
const line = (html: string, name: string) => {
  const start = html.indexOf(`data-testid="team-line-${name}"`);
  // from the line's opening tag to the end of the row's text, past the tag's own attributes
  return start < 0 ? null : words(html.slice(start, html.indexOf("</span></span>", start) + 14).replace(/^[^>]*>/, ""));
};

afterEach(() => setLang("en"));

describe("a member's line on the Team page", () => {
  it("is drawn under the name with the role beside it, in each state's words", () => {
    setLang("en");
    const html = renderToString(
      <TeamView
        nowMs={NOW}
        members={[
          member({ name: "pim", description: "Content", status: "working", line: { kind: "doing", text: "Drafting the post", since: NOW - 38_000 } }),
          member({ name: "ton", description: "Books", status: "needs", line: { kind: "asks", text: "Allow `refund order SP-2291`?", more: 1 }, look: noop }),
          member({ name: "kit", description: "Engineer", status: "stuck", line: { kind: "stuck", reason: "Shopee did not answer." } }),
          member({ name: "nam", description: "Sales chat", status: "idle", line: { kind: "idle", last: at(9, 20) } }),
          member({ name: "buddy", description: "Your assistant", status: "paused", line: { kind: "paused", since: at(10, 30) } }),
        ]}
      />,
    );
    expect(line(html, "pim")).toBe("Drafting the post 38s");
    expect(line(html, "ton")).toBe("Allow refund order SP-2291 ? +1 more");
    expect(html).toContain("<code>refund order SP-2291</code>");
    expect(line(html, "kit")).toBe("Shopee did not answer.");
    expect(line(html, "nam")).toBe("Nothing to do right now. Last job: 09:20.");
    expect(line(html, "buddy")).toBe("Paused 10:30. Starts nothing new.");
    // the role is the name's neighbour on the first line, as the canvas sets it
    expect(html).toMatch(/Pim<span class="role">Content<\/span>/);
    expect(html).toContain('data-kind="asks"');
  });

  it("draws no line for a row that has none, and keeps its role", () => {
    setLang("en");
    const html = renderToString(<TeamView nowMs={NOW} members={[member({ name: "kit", description: "Engineer", status: "offline" })]} />);
    expect(html).not.toContain('data-testid="team-line-kit"');
    expect(words(html)).toContain("Engineer");
  });

  it("has Look first only for a member who waits on the person, and it opens that ask", () => {
    setLang("en");
    const look = vi.fn();
    const rows = [member({ name: "ton", status: "needs", line: { kind: "asks", text: "Allow `ls`?", more: 0 }, look }), member({ name: "pim", status: "idle" })];
    const html = renderToString(<TeamView nowMs={NOW} members={rows} />);
    expect(html).toContain('data-testid="team-look-ton"');
    expect(html).not.toContain('data-testid="team-look-pim"');
    expect(words(html.slice(html.indexOf('data-testid="team-look-ton"')).replace(/^[^>]*>/, ""))).toMatch(/^Look first/);
    (byId(TeamView({ nowMs: NOW, members: rows }), "team-look-ton")[0].props.onClick as () => void)();
    expect(look).toHaveBeenCalledTimes(1);
  });
});

/** A store of its own on a fresh demo runtime, listing the whole team as the app does on a first run. */
async function demoStore() {
  const store = createStore(new MockRuntime(new MockHost()), { firstRoster: "all", hiddenBots: () => [], resume: () => null });
  await store.actions.init();
  return store;
}
const job = (over: Partial<JobRow> & { id: string }): JobRow => ({ title: "A job", bot: "nam", stage: "sent", at: at(9, 20), ...over });

describe("the rows built from the store", () => {
  afterEach(() => vi.useRealTimers());

  it("say when each idle member's last job was, from the jobs the runtime lists", async () => {
    const store = await demoStore();
    const rows = teamRows(store.getSnapshot(), { canRestart: false, jobs: [job({ id: "a", bot: "nam", at: at(9, 20) }), job({ id: "b", bot: "ton", at: at(8, 2), stage: "checked" })] });
    const by = Object.fromEntries(rows.map((r) => [r.name, r.line]));
    expect(by.nam).toEqual({ kind: "idle", last: at(9, 20) });
    expect(by.ton).toEqual({ kind: "idle", last: at(8, 2) });
    expect(by.pim).toEqual({ kind: "idle", last: null });
    expect(rows.every((r) => r.look === undefined)).toBe(true);
  });

  it("give a member whose ask waits the ask's words and a Look first that opens it in their chat", async () => {
    vi.useFakeTimers();
    const store = await demoStore();
    await store.actions.selectBot("nam");
    const sent = store.actions.send("/approve");
    await vi.advanceTimersByTimeAsync(2_000);
    await sent;
    const [ask] = selectAsks(store.getState());
    const nam = teamRows(store.getSnapshot(), { canRestart: false }).find((r) => r.name === "nam")!;
    expect(nam.status).toBe("needs");
    expect(nam.line).toEqual({ kind: "asks", text: `Allow \`${APPROVAL_SEED.command}\`?`, more: 0 });
    store.actions.openPage("team");
    nam.look!();
    expect(store.getState().ui).toMatchObject({ view: "chat", focusAsk: { bot: "nam", id: ask.item.id } });
  });

  it("say since when Pause everyone holds a paused member", async () => {
    const store = await demoStore();
    await store.actions.teamPause();
    // the runtime tells the store the list changed, and the store reads it again
    await vi.waitFor(() => expect(store.getState().bots.find((b) => b.name === "nam")?.paused).toBe(true));
    const rows = teamRows(store.getSnapshot(), { canRestart: false, pausedSince: at(10, 30) });
    expect(rows.find((r) => r.name === "nam")).toMatchObject({ status: "paused", line: { kind: "paused", since: at(10, 30) } });
    // the lead keeps answering while the others are held
    expect(rows.find((r) => r.name === "buddy")?.line?.kind).toBe("idle");
  });
});
