// The Needs you list as the design canvas's ask (Approvals.dc.html) draws it: one card an ask, with who asks and what they
// do, since when it waits (one time), which kind as its amber mark, what is asked with the exact action under it, and Look
// first. Drawn with react-dom/server from the rows it is
// given; the last test builds the rows from the app's own store on the demo runtime.
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToString } from "react-dom/server";
import { setLang } from "../i18n";
import { MockHost, MockRuntime } from "../runtime/mock";
import { APPROVAL_SEED } from "../runtime/mock/seed";
import { createStore, selectAsks } from "../state/store";
import { NeedsView, needRows, type NeedRow } from "./NeedsPage";

const words = (html: string) =>
  html
    .replace(/<[^>]*>/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
const noop = () => {};

function drawn(node: ReactNode): ReactElement<Record<string, unknown>>[] {
  if (Array.isArray(node)) return node.flatMap(drawn);
  if (!isValidElement(node)) return [];
  const el = node as ReactElement<Record<string, unknown>>;
  return [el, ...drawn(el.props.children as ReactNode)];
}
const byId = (view: ReactNode, id: string) => drawn(view).filter((e) => e.props["data-testid"] === id);

const row = (over: Partial<NeedRow> = {}): NeedRow => ({ key: "k", who: "Nam", kind: "approval", text: "Allow this?", age: "3m", face: null, open: noop, ...over });

afterEach(() => setLang("en"));

describe("an ask on Needs you", () => {
  const full = row({
    role: "Sales chat",
    title: "Send a reply to a customer",
    action: 'Reply to Khun Mali on LINE: "Your order ships tomorrow morning."',
    asked: "09:14",
  });

  it("says who asks and what they do, what is asked with its exact action under it, and since when it waits, one time only", () => {
    setLang("en");
    const html = renderToString(<NeedsView rows={[full]} />);
    const text = words(html);
    expect(text).toContain("Send a reply to a customer");
    expect(html).toContain('<code class="act">Reply to Khun Mali on LINE: &quot;Your order ships tomorrow morning.&quot;</code>');
    expect(text).toContain("Nam · Sales chat · Waiting since 09:14");
    // an ask from one of several shops names its shop beside who asks
    expect(words(renderToString(<NeedsView rows={[{ ...full, who: "Buddy", role: undefined, shop: "Ran Pa Noi" }]} />))).toContain("Buddy · Ran Pa Noi · Waiting since 09:14");
    // one time: when it was asked, not also how long ago
    expect(text).not.toContain("3m");
    // the kind is the card's amber mark, not a button
    expect(html).toMatch(/<span class="tag warn">Approve<\/span>/);
    expect(html.match(/<button/g)).toHaveLength(2);
  });

  it("falls back to the ask's one line when the row has no card words, and leaves out what it does not know", () => {
    setLang("en");
    const html = renderToString(<NeedsView rows={[row({ text: "Allow `ls`?" })]} />);
    expect(html).toContain("<code>ls</code>");
    expect(html).not.toContain('class="act"');
    // with no time it was asked, the one time is how long ago
    expect(words(html)).toContain("Nam · 3m Approve");
    expect(words(html)).not.toContain("Waiting since");
  });

  it("has Look first beside the row, and the row opens the ask as well", () => {
    setLang("en");
    const open = vi.fn();
    const rows = [full, row({ key: "q", who: "Pim", kind: "clarify", text: "Which page should the post go on?", open })];
    const html = renderToString(<NeedsView rows={rows} />);
    expect(html.split('data-testid="needs-look"').length - 1).toBe(2);
    expect(words(html.slice(html.indexOf('data-testid="needs-look"')).replace(/^[^>]*>/, ""))).toMatch(/^Look first/);
    const view = NeedsView({ rows });
    (byId(view, "needs-look")[1].props.onClick as () => void)();
    (byId(view, "needs-open")[1].props.onClick as () => void)();
    expect(open).toHaveBeenCalledTimes(2);
  });
});

describe("the rows built from the store", () => {
  afterEach(() => vi.useRealTimers());

  it("carry who asks and what they do, the card's title and exact action, and when the ask was made", async () => {
    vi.useFakeTimers();
    const store = createStore(new MockRuntime(new MockHost()), { firstRoster: "all", hiddenBots: () => [], resume: () => null });
    await store.actions.init();
    await store.actions.selectBot("nam");
    const sent = store.actions.send("/approve");
    await vi.advanceTimersByTimeAsync(2_000);
    await sent;
    expect(selectAsks(store.getState())).toHaveLength(1);
    const [r] = needRows(store.getSnapshot(), Date.now());
    expect(r).toMatchObject({ who: "Nam", role: "Sales chat", kind: "approval", title: APPROVAL_SEED.title, action: APPROVAL_SEED.command });
    expect(r.asked).toMatch(/^\d{2}:\d{2}$/);
    const html = renderToString(<NeedsView rows={[r]} />);
    expect(words(html)).toContain(`Nam · Sales chat · Waiting since ${r.asked}`);
  });
});
