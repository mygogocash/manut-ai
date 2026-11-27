// Home, drawn with react-dom/server as smoke.test.tsx draws the first screen. The view is drawn from the data it is
// given; the last tests build its rows from the app's own store on the demo runtime, approve from Home and look first.
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToString } from "react-dom/server";
import { setLang } from "../i18n";
import { createStore, selectAsks, type ApprovalItem } from "../state/store";
import { MockHost, MockRuntime } from "../runtime/mock";
import { APPROVAL_SEED, CLARIFY_SEED } from "../runtime/mock/seed";
import { settleApproval } from "../chat/cards/respond";
import { HomeView, needsYouRows, workingRows, type HomeAskRow, type HomeViewProps, type WorkingRow } from "./HomePage";
import { DraftsView, draftWords, type DraftRow } from "./HomeDrafts";

/** The text a person would read: tags and attribute values removed, entities decoded where tests compare them. */
const words = (html: string) =>
  html
    .replace(/<[^>]*>/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");
const count = (html: string, needle: string) => html.split(needle).length - 1;
const noop = () => {};

const need = (over: Partial<HomeAskRow> = {}): HomeAskRow => ({
  key: "nam:a1",
  title: "Send a reply to a customer",
  action: 'Reply to Khun Mali on LINE: "Your order ships tomorrow morning."',
  who: "Nam",
  age: "3m",
  face: null,
  settled: null,
  look: noop,
  ...over,
});
const worker = (over: Partial<WorkingRow> = {}): WorkingRow => ({
  name: "pim",
  displayName: "Pim",
  description: "Content",
  status: "Drafting the post",
  elapsed: "38s",
  open: noop,
  ...over,
});

function draw(over: Partial<HomeViewProps> = {}) {
  setLang("en");
  return renderToString(
    <HomeView
      mode="team"
      modes={["chat", "team", "code"]}
      text=""
      canSend={false}
      onMode={noop}
      onText={noop}
      onSubmit={noop}
      onChip={noop}
      asks={[]}
      waiting={0}
      onSeeAll={noop}
      working={[]}
      onSeeTeam={noop}
      {...over}
    />,
  );
}

describe("Home's ask box", () => {
  it("is the canvas's: the brand with the mode's word, the box with its placeholder, the three modes and Send", () => {
    const html = draw();
    const text = words(html);
    expect(html).toContain('data-testid="page-home"');
    expect(html).toMatch(/<h1[^>]*>Home<\/h1>/);
    expect(text).toContain("Manut AI team");
    expect(html).toMatch(/<input[^>]*placeholder="What should the team work on next\?"[^>]*data-testid="home-ask"/);
    // the box is named for what it does
    expect(html).toMatch(/<label[^>]*for="home-ask"[^>]*>Give the team a job<\/label>/);
    // the mode at the top left, as ChatGPT names its model there: the brand and the mode in use, a menu behind it
    expect(html).toMatch(/aria-haspopup="menu"[^>]*aria-expanded="false"[^>]*aria-label="Mode: Team. Change the mode"[^>]*data-testid="home-mode-pick"/);
    expect(html).toMatch(/data-testid="home-mode-now"[^>]*>Team</);
    // the title stays for screen readers
    expect(html).toMatch(/<h1[^>]*class="vh"[^>]*>Home<\/h1>/);
    expect(html).toMatch(/<button type="submit"[^>]*aria-label="Send"[^>]*disabled=""[^>]*data-testid="home-send"/);
  });

  it("names the shop under the brand once the first-run setup took its name, and nothing before", () => {
    const html = draw({ shop: "Baan Mali" });
    expect(html).toMatch(/<div class="lockup">.*?<\/div><p class="for" data-testid="home-shop">For Baan Mali<\/p>/s);
    expect(draw()).not.toContain('data-testid="home-shop"');
    expect(draw({ shop: "" })).not.toContain('data-testid="home-shop"');
  });

  it("says each mode's words and suggests the mode's four jobs", () => {
    const team = words(draw({ mode: "team" }));
    expect(team).toContain("Give the team a job");
    expect(team).toMatch(/Reply to waiting customers Draft a 12.12 post Send today’s sales summary Set a routine/);
    const chat = draw({ mode: "chat" });
    expect(words(chat)).toContain("Manut AI chat");
    expect(chat).toContain('placeholder="Ask anything, in Thai or English"');
    expect(words(chat)).toMatch(/Write a reply to a customer Explain yesterday’s sales Translate a message Plan the 12.12 sale/);
    const code = draw({ mode: "code" });
    expect(code).toContain('placeholder="What should Kit build?"');
    expect(words(code)).toMatch(/Ask Kit to build something Build a pre-order page Fix the stock sync Make a booking form Add PromptPay to checkout/);
    expect(count(code, 'data-testid="home-chip"')).toBe(4);
  });

  it("after a send that stayed on Home, one quiet line under the box says where it went, with Open (item 95)", () => {
    const open = vi.fn();
    const html = draw({ started: { name: "Buddy", words: "Translate a message", open } });
    expect(html).toMatch(/<\/form><p class="started mo-rise" role="status" data-testid="home-started">/);
    expect(words(html)).toContain("Sent to Buddy: Translate a message Open");
    expect(html).toMatch(/<button type="button" class="lk" data-testid="home-started-open">Open<\/button>/);
    expect(draw()).not.toContain('data-testid="home-started"');
  });

  it("Send's tooltip says what it does here, and what Cmd+Enter does instead", () => {
    expect(draw()).toMatch(/title="Send and open the chat \((⌘|Ctrl\+)Enter sends and stays here\)"/);
    expect(draw({ stays: true })).toMatch(/title="Send and stay here \((⌘|Ctrl\+)Enter sends and opens the chat\)"/);
  });

  it("says why an ask did not go, under the box that still holds its words", () => {
    const html = draw({ text: "Translate a message", sendError: "Kit is not connected" });
    expect(html).toContain('value="Translate a message"');
    expect(html).toMatch(/role="alert"[^>]*data-testid="home-send-error"[^>]*>Not sent · Kit is not connected</);
    expect(draw()).not.toContain('data-testid="home-send-error"');
  });

  it("offers only the modes it is given, and lets Send go once there is someone to send to and words to send", () => {
    const html = draw({ modes: ["chat", "team"] });
    expect(html).not.toContain('data-testid="home-mode-code"');
    expect(draw({ canSend: true, text: "Hello" })).toMatch(/<button type="submit"[^>]*aria-label="Send"(?![^>]*disabled)[^>]*data-testid="home-send"/);
    expect(draw({ text: "Reply to waiting customers" })).toContain('value="Reply to waiting customers"');
  });

  it("leaves out what the runtime has no data or setting for: the budget, the quick links, Updates, Careful, files and speech", () => {
    const html = draw();
    const text = words(html);
    expect(html).not.toContain("฿");
    expect(html).not.toContain("planp");
    for (const w of ["Sales", "Content", "Books", "Stock", "Updates", "Careful", "Routines"]) expect(text, w).not.toContain(w);
    expect(html).not.toContain('aria-label="Add a file"');
    expect(html).not.toContain('aria-label="Speak"');
  });

  it("shows Automations with how many jobs there are, only when the runtime has them", () => {
    expect(draw()).not.toContain('data-testid="home-automations"');
    const html = draw({ automations: { count: 5, open: noop } });
    expect(html).toContain('data-testid="home-automations"');
    expect(words(html)).toMatch(/Routines 5/);
    expect(words(draw({ automations: { count: 0, open: noop } }))).not.toMatch(/Routines 0/);
  });
});

describe("Home's Needs you", () => {
  it("lists each ask in its card's words, with who asks and how long ago, Look first on each and Approve only where offered", () => {
    const html = draw({
      waiting: 4,
      asks: [
        need({ key: "nam:a1", approve: noop }),
        need({ key: "pim:c1", title: "Which page should the post go on?", action: null, who: "Pim", age: "now" }),
      ],
    });
    const text = words(html);
    expect(count(html, 'data-testid="home-need"')).toBe(2);
    expect(text).toContain("Send a reply to a customer");
    // the exact action, as the card shows it
    expect(html).toContain('<code class="act">Reply to Khun Mali on LINE: &quot;Your order ships tomorrow morning.&quot;</code>');
    expect(text).toContain("Which page should the post go on?");
    expect(text).toMatch(/Nam · 3m/);
    expect(text).toMatch(/Pim · now/);
    expect(count(html, 'data-testid="home-approve"')).toBe(1);
    expect(count(html, 'data-testid="home-look"')).toBe(2);
    expect(text).toContain("Approve");
    expect(text).toContain("Look first");
    // the count of every open ask, and the way to them all
    expect(html).toMatch(/data-testid="home-see-all"[^>]*>See all 4</);
    expect(text).not.toContain("Nothing needs you yet");
  });

  it("turns an ask approved here into its settled line, in its place", () => {
    const html = draw({ waiting: 1, asks: [need({ key: "nam:a1", settled: "Allowed once" }), need({ key: "pim:a2", title: "Post the weekend sale" })] });
    const text = words(html);
    expect(count(html, 'data-testid="home-settled"')).toBe(1);
    expect(html).toMatch(/data-testid="home-settled"[^>]*>.*Allowed once/);
    expect(text.indexOf("Allowed once")).toBeLessThan(text.indexOf("Post the weekend sale"));
    expect(count(html, 'data-testid="home-need"')).toBe(1);
  });

  it("says why an approval was not taken, on its row", () => {
    expect(words(draw({ waiting: 1, asks: [need({ approve: noop, error: "offline" })] }))).toContain("Not sent · offline");
  });

  it("holds the row's buttons while its approval is on its way", () => {
    expect(draw({ waiting: 1, asks: [need({ approve: noop, busy: true })] })).toMatch(/<button[^>]*disabled=""[^>]*data-testid="home-approve"/);
  });

  it("says nothing waits, in the canvas's words, when no ask is open", () => {
    const html = draw();
    const text = words(html);
    expect(text).toContain("Needs you Nothing waiting");
    expect(text).toContain("Nothing needs you yet");
    expect(text).toContain("When the team wants to send, post or pay, the request waits here for your approval.");
    expect(html).not.toContain('data-testid="home-see-all"');
  });
});

describe("Home's Working now", () => {
  it("lists each member at work with what the turn says and for how long, and leads to the team", () => {
    const html = draw({ working: [worker(), worker({ name: "nam", displayName: "Nam", description: "Sales chat", status: "", elapsed: null })] });
    const text = words(html);
    expect(count(html, 'data-testid="home-worker"')).toBe(2);
    expect(text).toMatch(/Pim Content Drafting the post 38s/);
    // a turn that says nothing yet reads as Working
    expect(text).toMatch(/Nam Sales chat Working/);
    expect(html).toMatch(/data-testid="home-see-team"[^>]*>See the team</);
    expect(count(html, 'class="ui-av"')).toBe(2);
  });

  it("says nothing is running while nobody works", () => {
    const text = words(draw());
    expect(text).toContain("Working now See the team");
    expect(text).toContain("Nothing is running right now.");
  });
});

/** A store of its own on a fresh demo runtime, listing the whole team as the app does. */
async function demoStore() {
  const store = createStore(new MockRuntime(new MockHost()), { firstRoster: "all", hiddenBots: () => [], resume: () => null });
  await store.actions.init();
  return store;
}

describe("Home on the demo runtime", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("lists Nam's real ask with its exact action, offers Approve beside Look first, and Look first opens Nam's chat on it", async () => {
    vi.useFakeTimers();
    setLang("en");
    const store = await demoStore();
    await store.actions.selectBot("nam");
    const sent = store.actions.send("/approve");
    await vi.advanceTimersByTimeAsync(2_000);
    await sent;
    const [ask] = selectAsks(store.getState());
    const approved: string[] = [];
    const rows = needsYouRows(store.getSnapshot(), [], {}, Date.now(), (a) => approved.push(a.item.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ title: APPROVAL_SEED.title, action: APPROVAL_SEED.command, who: "Nam", settled: null });
    // Approve hands the ask to the page, which settles it through the card's own path
    rows[0].approve!();
    expect(approved).toEqual([ask.item.id]);
    store.actions.openPage("home");
    rows[0].look();
    await vi.advanceTimersByTimeAsync(10);
    expect(store.getState().ui).toMatchObject({ view: "chat", thread: null, focusAsk: { bot: "nam", id: ask.item.id } });
    expect(store.getState().selectedBot).toBe("nam");
  });

  it("shows an approval settled here as its settled line, and a question with Look first only", async () => {
    vi.useFakeTimers();
    setLang("en");
    const store = await demoStore();
    await store.actions.selectBot("nam");
    const a = store.actions.send("/approve");
    await vi.advanceTimersByTimeAsync(2_000);
    await a;
    await store.actions.selectBot("pim");
    const q = store.actions.send("/clarify");
    await vi.advanceTimersByTimeAsync(2_000);
    await q;
    const approval = selectAsks(store.getState()).find((x) => x.bot === "nam")!;
    expect(await settleApproval(store, "nam", approval.item as ApprovalItem, "once")).toBeNull();
    const rows = needsYouRows(store.getSnapshot(), [{ bot: "nam", id: approval.item.id }], {}, Date.now(), noop);
    expect(rows.map((r) => [r.who, r.settled, !!r.approve])).toEqual([
      ["Pim", null, false],
      ["Nam", "Allowed once", false],
    ]);
    expect(rows[0].title).toBe(CLARIFY_SEED.question);
    const html = draw({ asks: rows, waiting: selectAsks(store.getState()).length });
    expect(words(html)).toMatch(/Allowed once/);
    expect(html).toMatch(/data-testid="home-see-all"[^>]*>See all 1</);
  });

  it("lists a member whose turn runs under Working now, with what the turn says, and the row opens their chat", async () => {
    vi.useFakeTimers();
    setLang("en");
    const store = await demoStore();
    await store.actions.selectBot("pim");
    const sent = store.actions.send("Draft the weekend post");
    await vi.advanceTimersByTimeAsync(100);
    await sent;
    const rows = workingRows(store.getSnapshot(), Date.now());
    expect(rows.map((r) => [r.displayName, r.description, r.status])).toEqual([["Pim", "Content", "Looking into it…"]]);
    expect(rows[0].elapsed).toBe("0s");
    store.actions.openPage("home");
    rows[0].open();
    expect(store.getState().ui.view).toBe("chat");
    expect(store.getState().selectedBot).toBe("pim");
    // once the turn ends, nobody is working
    await vi.advanceTimersByTimeAsync(3_000);
    expect(workingRows(store.getSnapshot(), Date.now())).toEqual([]);
  });
});

describe("Drafts at the top of Home (item 95)", () => {
  const row = (over: Partial<DraftRow> = {}): DraftRow => ({
    id: "d1",
    words: "Plan the 12.12 sale",
    meta: "From Home · 3m",
    back: noop,
    backTo: "Home",
    places: [{ key: "nam", label: "Nam's chat", pick: noop }],
    remove: noop,
    ...over,
  });
  const drawDrafts = (rows: DraftRow[], dropped: string | null = null) => {
    setLang("en");
    return renderToString(<DraftsView rows={rows} dropped={dropped} onUndo={noop} />);
  };

  it("draws nothing without drafts, and a band over the rows with them, each with Move to and ×", () => {
    expect(drawDrafts([])).toBe("");
    const html = drawDrafts([row(), row({ id: "d2", words: "Reply to Khun Mali", meta: "1 file · From Kami · now" })]);
    expect(html).toMatch(/role="region" aria-labelledby="home-drafts-h" data-testid="home-drafts"/);
    expect(words(html)).toContain("Drafts 2 of 5");
    expect(count(html, 'data-testid="home-draft"')).toBe(2);
    expect(words(html)).toContain("Reply to Khun Mali 1 file · From Kami · now");
    expect(html).toMatch(/title="Put it back into Home"/);
    expect(count(html, 'data-testid="home-draft-move"')).toBe(2);
    expect(html).toMatch(/aria-label="Delete the draft “Plan the 12.12 sale”"/);
  });

  it("says which draft went when a sixth let the oldest go, with Undo", () => {
    const html = drawDrafts([row()], "the oldest one");
    expect(words(html)).toContain("Drafts keeps 5, so the oldest went: the oldest one Undo");
    expect(html).toMatch(/role="status" data-testid="home-draft-dropped"/);
  });

  it("puts a draft's first line with words on one line, cut where a row would cut it", () => {
    expect(draftWords("\n\n  first   line \nsecond")).toBe("first line");
    expect(draftWords("x".repeat(100))).toHaveLength(90);
  });
});
