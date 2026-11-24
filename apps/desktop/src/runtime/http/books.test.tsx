// Ton's append of a month of the books to the owner's Google Sheet, as the app reads it (books.ts; docs/pilot-api.md, "Asking for a
// month, and sending it"). The API's request is of the kind `command`, which only the owner may decide. The owner's card, Home and
// Needs you show its whole text, every line of it, and offer Approve only where that text is shown, as for a browser write; a
// helper's view keeps what the API gives a helper, that it waits for the owner for which month and sheet, with no rows or totals,
// and offers to pass it on; and a notification, which no command may approve from, says it in one line. The first part builds the
// ask from the API's own record through the runtime's view; the second runs the app's own store over a fake API.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToString } from "react-dom/server";
import { LANGS, setLang, t } from "../../i18n";
import { decodeApprovals, detailOf, shownRecord } from "./approvals";
import { monthLabel } from "../google";
import { booksText, booksTitle, decodeBooksDetail, earlierWords, SHEETS_APPEND, type OwnerBooks } from "./books";
import type { ShopSnapshot } from "./shop";
import { approvalJson, iso } from "./testkit";
import { pendingAsks } from "./view";

/** When the month was sent before: noon on 3 November on this computer's clock, so its day reads the same wherever the test runs. */
const SENT = new Date(2026, 10, 3, 12, 0).toISOString();
const NOW = new Date(2026, 10, 24, 10, 0).getTime();

/** A books request's detail as the API sends it for the owner (`BooksDetail` in docs/pilot-api.md), rows and all. */
function ownerDetail(over: Record<string, unknown> = {}) {
  return {
    actionId: "append-1",
    operationType: SHEETS_APPEND,
    sheet: { id: "sheet1", title: "Manut AI books: Baan Mali", tab: "Books" },
    month: "2026-10",
    rows: 41,
    totals: { sales: "฿12,300", salesCount: 30, refunds: "฿0", refundsCount: 0, expenses: "฿0", expensesCount: 0, net: "฿12,300" },
    flags: 0,
    earlier: null,
    lines: [{ date: "2026-10-10", ref: "SP-2291", kind: "sale", channelOrCategory: "line", amountSatang: 129033, beforeVatSatang: null, vatSatang: null }],
    text: "Append the books for 2026-10 to the Google Sheet \"Manut AI books: Baan Mali\", tab \"Books\": a header row, then 41 rows. Sales ฿12,300 (30 entries), refunds ฿0 (0), expenses ฿0 (0), net sales ฿12,300.",
    payloadHash: "hash-1",
    ...over,
  };
}

/** What the API shows a helper of it instead (`HelperBooksDetail`): that it waits for the owner, for which month and sheet. */
const helperDetail = () => ({
  actionId: "append-1",
  operationType: SHEETS_APPEND,
  month: "2026-10",
  sheet: { title: "Manut AI books: Baan Mali" },
  ownerOnly: true,
  text: "Ton asks to append the books for 2026-10 to the owner's Google Sheet. Only the owner sees the books and can approve it.",
});

const append = (detail: unknown = ownerDetail()) => approvalJson({ id: "append-1", kind: "command", detail });
const owner = { id: "pilot:a", name: "Baan Mali", owner: "Fon", role: "owner" as const };
const helper = { id: "pilot:b", name: "Ran Pa Noi", owner: "Noi", role: "helper" as const };

const snap = (over: Partial<ShopSnapshot> = {}): ShopSnapshot => ({ tasks: [], approvals: [], schedules: [], attention: [], attentionOff: false, unreadable: [], readAt: 0, ...over });
const asksAt = (role: typeof owner | typeof helper, detail: unknown) => pendingAsks(snap({ shops: [{ shop: role, approvals: decodeApprovals({ approvals: [append(detail)] }, []) }] }));

const EN = [
  "Add the books for October 2026 to the Google Sheet “Manut AI books: Baan Mali”, tab “Books”.",
  "41 rows, after the header row.",
  "Sales ฿12,300 (30)",
  "Refunds ฿0 (0)",
  "Expenses ฿0 (0)",
  "Net sales ฿12,300",
].join("\n");

beforeEach(() => setLang("en"));
afterEach(() => setLang("en"));

describe("the owner's ask", () => {
  it("is the whole text: the sheet, the month, how many rows and every total as the API worded it, never the operation and its sheet", () => {
    const [ask] = asksAt(owner, ownerDetail());
    expect(ask).toMatchObject({ command: EN, whole: true, kind: "command", choices: ["once", "deny"], title: "Ton asks to add the books for October 2026 to Google Sheets" });
    expect(ask).not.toHaveProperty("outdated");
    expect(ask.command).not.toContain("google.sheets.append");
    // The amounts are the API's own words, written as they came; the rows themselves are not shown.
    expect(ask.command).not.toContain("SP-2291");
    expect(ask.command).not.toContain("129033");
    // With no one shop in view, the same text, and the same title.
    const single = pendingAsks(snap({ approvals: decodeApprovals({ approvals: [append()] }, []) }));
    expect(single[0]).toMatchObject({ command: EN, whole: true, kind: "command", choices: ["once", "deny"], title: ask.title });
  });

  it("says a month that was sent before first, the day, how many rows, and what approving does, and a VAT shop's figures and the flags", () => {
    const sent = { count: 1, at: SENT, rows: 41, outcome: "confirmed" };
    expect(asksAt(owner, ownerDetail({ earlier: sent }))[0]!.command).toBe(
      "Already sent: this month went to the sheet on 3 November (41 rows) and Google confirmed it. Approving adds its rows a second time.\n\n" + EN,
    );
    expect(asksAt(owner, ownerDetail({ earlier: { ...sent, count: 3, rows: 1, outcome: "unknown" } }))[0]!.command.split("\n")[0]).toBe(
      "Maybe already sent: this month went to the sheet 3 times, the last on 3 November (1 row), but Google did not say whether the rows arrived. " +
        "Look in the sheet first: approving adds its rows again, so they would be there twice if they had arrived.",
    );
    const vat = { ...ownerDetail().totals, beforeVat: "฿11,495.33", vat: "฿804.67" };
    const lines = asksAt(owner, ownerDetail({ totals: vat, flags: 2 }))[0]!.command.split("\n");
    expect(lines.slice(-3)).toEqual(["Net sales ฿12,300", "Net sales before VAT ฿11,495.33, VAT ฿804.67", "Ton flagged 2 entries for you to check."]);
    expect(asksAt(owner, ownerDetail({ flags: 1 }))[0]!.command.split("\n").at(-1)).toBe("Ton flagged 1 entry for you to check.");
    expect(asksAt(owner, ownerDetail({ rows: 1 }))[0]!.command.split("\n")[1]).toBe("1 row, after the header row.");
  });

  it("is in each language, with the API's amounts, sheet and month label as they are, and no English left over", () => {
    const sent = { count: 2, at: SENT, rows: 41, outcome: "unknown" };
    for (const lang of LANGS) {
      setLang(lang);
      const [ask] = asksAt(owner, ownerDetail({ earlier: sent }));
      const [open, close] = lang === "ja" ? ["「", "」"] : ["“", "”"];
      expect(ask!.command, lang).toContain("฿12,300");
      expect(ask!.command, lang).toContain(`${open}Manut AI books: Baan Mali${close}`);
      expect(ask!.command, lang).toContain(monthLabel("2026-10"));
      expect(ask!.command, lang).toBe(booksText(decodeBooksDetail(ownerDetail({ earlier: sent }))!));
      if (lang !== "en") {
        for (const word of ["Sales", "Refunds", "Expenses", "Net sales", "Already sent", "Maybe already sent", "after the header row"]) expect(ask!.command, `${lang} ${word}`).not.toContain(word);
        expect(ask!.title, lang).not.toContain("Ton asks");
      }
      expect(ask!.title, lang).toBe(booksTitle(decodeBooksDetail(ownerDetail())!));
    }
  });

  it("is not answerable here when this build cannot read the whole of it, and says to update the app", () => {
    for (const bad of [
      ownerDetail({ totals: undefined }),
      ownerDetail({ totals: { ...ownerDetail().totals, net: "12300" } }),
      ownerDetail({ totals: { ...ownerDetail().totals, beforeVat: "฿1" } }),
      ownerDetail({ rows: -1 }),
      ownerDetail({ sheet: { id: "s", title: "", tab: "Books" } }),
      ownerDetail({ earlier: { count: 0, at: SENT, rows: 1, outcome: "confirmed" } }),
      ownerDetail({ earlier: { count: 1, at: "last week", rows: 1, outcome: "confirmed" } }),
      ownerDetail({ earlier: { count: 1, at: SENT, rows: 1, outcome: "sending" } }),
      ownerDetail({ month: "October" }),
      { ...ownerDetail(), flags: "none" },
    ]) {
      for (const [ask] of [asksAt(owner, bad), pendingAsks(snap({ approvals: decodeApprovals({ approvals: [append(bad)] }, []) }))]) {
        expect(ask, JSON.stringify(bad).slice(0, 80)).toMatchObject({ choices: [], outdated: true, kind: "command" });
        expect(ask).not.toHaveProperty("whole");
        expect(ask).not.toHaveProperty("brief");
      }
    }
  });

  it("says it in a line for a notification, which shows no command whole and approves none", () => {
    const [ask] = asksAt(owner, ownerDetail());
    expect(ask!.brief).toBe("Ton asks to add the books for October 2026 to Google Sheets");
    // Every other request has none, and so is worded as it was.
    const line = pendingAsks(snap({ approvals: decodeApprovals({ approvals: [approvalJson({ id: "a" })] }, []) }));
    expect(line[0]).not.toHaveProperty("brief");
  });
});

describe("a helper's view", () => {
  it("keeps what the API gives a helper: that it waits for the owner, for which month, and no rows or totals, with a way to pass it on", () => {
    const [ask] = asksAt(helper, helperDetail());
    expect(ask).toMatchObject({
      command: "Ton asks to add the books for October 2026 to the owner's Google Sheet. Only the owner sees the books and can approve it.",
      kind: "command",
      choices: [],
      pass_on: true,
      title: "Ton asks to add the books for October 2026 to Google Sheets",
    });
    expect(ask).not.toHaveProperty("outdated");
    expect(ask!.command).not.toContain("฿");
    expect(ask!.command).not.toContain("Manut AI books");
    // The sheet's title is the API's to show, and the helper's words do not use it: nothing of the books is on the ask.
    expect(JSON.stringify(ask)).not.toContain("SP-2291");
  });

  it("is in each language", () => {
    setLang("ko");
    expect(asksAt(helper, helperDetail())[0]!.command).toBe("Ton이 2026년 10월 장부를 주인의 Google 스프레드시트에 추가하려고 해요. 장부는 주인만 볼 수 있고, 승인도 주인만 할 수 있어요.");
    setLang("ja");
    expect(asksAt(helper, helperDetail())[0]!.command).toContain("オーナー");
    setLang("zh");
    expect(asksAt(helper, helperDetail())[0]!.command).toContain("店主");
  });

  it("offers no answer for a request it cannot read either, and offers no pass on for one it cannot show", () => {
    const [ask] = asksAt(helper, { ...helperDetail(), month: "soon" });
    expect(ask).toMatchObject({ choices: [], outdated: true });
    expect(ask).not.toHaveProperty("pass_on");
  });
});

describe("what is kept of it", () => {
  it("keeps the words' fields in the API's own shape and never the rows, so reading it again reads the same", () => {
    const [entry] = decodeApprovals({ approvals: [append(ownerDetail({ earlier: { count: 1, at: SENT, rows: 41, outcome: "confirmed" } }))] }, []);
    const kept = shownRecord(entry!.record).request.detail;
    const detail = detailOf(entry!.record.request);
    expect(detail.books).toEqual({
      operationType: SHEETS_APPEND,
      month: "2026-10",
      sheet: { title: "Manut AI books: Baan Mali", tab: "Books" },
      rows: 41,
      totals: ownerDetail().totals,
      flags: 0,
      earlier: { count: 1, at: SENT, rows: 41, outcome: "confirmed" },
    });
    for (const gone of ["lines", "SP-2291", "129033", "payloadHash", "hash-1", "sheet1"]) expect(JSON.stringify(kept), gone).not.toContain(gone);
    // Read again from what was kept (as the offline cache reads it), it is the same, and says the same words.
    expect(detailOf({ ...entry!.record.request, detail: kept } as never).books).toEqual(detail.books);
    expect(booksText(detail.books!, NOW)).toBe(booksText(decodeBooksDetail((kept as { books: unknown }).books)!, NOW));
  });

  it("reads an API that does not name an earlier send, and reads each field strictly", () => {
    const { earlier: _left, ...old } = ownerDetail();
    expect((decodeBooksDetail(old) as OwnerBooks).earlier).toBeNull();
    for (const bad of ["฿1,290.3", "1,290.33", "฿", "฿12 300", "-฿", " ฿5", "฿5\n", "฿".repeat(40)]) {
      expect(decodeBooksDetail(ownerDetail({ totals: { ...ownerDetail().totals, net: bad } })), JSON.stringify(bad)).toBeNull();
    }
    for (const good of ["฿0", "฿500", "-฿20.05", "฿1,234,567.89"]) {
      expect(decodeBooksDetail(ownerDetail({ totals: { ...ownerDetail().totals, net: good } })), good).not.toBeNull();
    }
    expect(decodeBooksDetail({ ...ownerDetail(), operationType: "line.message.push" })).toBeNull();
    expect(decodeBooksDetail(null)).toBeNull();
    expect(decodeBooksDetail({ ...ownerDetail(), sheet: { id: "s", title: "line\nbreak", tab: "Books" } })).toBeNull();
    expect(decodeBooksDetail({ ...ownerDetail(), totals: { ...ownerDetail().totals, vat: "฿1" } })).toBeNull();
    expect(earlierWords({ count: 1, at: iso(Date.parse(SENT)), rows: 1, outcome: "confirmed" }, NOW)).toContain("(1 row)");
  });
});

// ---- every surface, from the app's own store -----------------------------------------------------------------------------------

const h = vi.hoisted(() => ({ sent: [] as Record<string, unknown>[] }));
vi.mock("@tauri-apps/plugin-notification", () => ({
  isPermissionGranted: async () => true,
  requestPermission: async () => "granted",
  registerActionTypes: async () => {},
  onAction: async () => ({ unregister: async () => {} }),
  sendNotification: (options: Record<string, unknown>) => void h.sent.push(options),
}));

const START = Date.UTC(2026, 10, 23, 1, 0, 0) + 600_000; // 08:10 in Bangkok: quiet hours have ended

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
async function settled() {
  for (let i = 0; i < 12; i += 1) {
    await vi.advanceTimersByTimeAsync(5);
    await tick();
  }
}

/** The page as the desktop shell runs it, for a person in the shop `at` (owned or helped): the connected runtime over a fake API
 *  listing `approvals` there, the store with notifications on, and a fresh copy of every module. */
async function opened(approvals: unknown[], at: "owner" | "helper" = "owner") {
  vi.resetModules();
  vi.stubGlobal("window", { __TAURI_INTERNALS__: {}, addEventListener: () => {} });
  vi.stubGlobal("navigator", { platform: "MacIntel" });
  const data: Record<string, string> = {};
  vi.stubGlobal("localStorage", { getItem: (k: string) => (k in data ? data[k] : null), setItem: (k: string, v: string) => void (data[k] = v), removeItem: (k: string) => void delete data[k] });
  const kit = await import("./testkit");
  const { createStore, notifySessionEvent } = await import("../../state/store");
  const { HttpHost } = await import("./host");
  const { HttpRuntime } = await import(".");
  const { ApiSession } = await import("./session");
  const i18n = await import("../../i18n");
  i18n.setLang("en");
  const shop = at === "owner" ? kit.SHOP_A : kit.SHOP_B;
  const api = kit.fakeApi();
  kit.serveShops(api, [shop], { [shop.id]: approvals });
  const session = new ApiSession({ origin: kit.ORIGIN, fetch: api.fetch as never, vault: kit.memoryVault(kit.storedSession(START)) });
  const store: import("../../state/store").Store = createStore(new HttpRuntime(new HttpHost({ session })), {
    firstRoster: "all",
    watchSeen: { get: () => null, set: () => {} },
    onEvent: (ev, state) => notifySessionEvent(ev, state, store),
  });
  await store.actions.init();
  await settled();
  const card = store.getState().chats.buddy?.items.find((i) => i.kind === "approval") as import("../../state/store").ApprovalItem | undefined;
  return { store, card };
}

/** `text` as react-dom/server writes it inside an element. */
const escaped = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#x27;");

describe("every surface that can approve it shows its whole text", () => {
  beforeEach(() => {
    h.sent.length = 0;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    vi.setSystemTime(START);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("the owner's card, Home and Needs you, line for line, with Approve where the whole text is", async () => {
    const { store, card } = await opened([append()]);
    expect(card).toMatchObject({ command: EN, whole: true, choices: ["once", "deny"], approvalKind: "command", title: "Ton asks to add the books for October 2026 to Google Sheets" });

    const { default: Cards } = await import("../../chat/cards/Cards.slot");
    const cardHtml = renderToString(<Cards bot="buddy" item={card!} />);
    expect(cardHtml).toMatch(/data-choice="once"/);
    expect(cardHtml).toContain(`<pre class="card-cmd whole">${escaped(EN)}</pre>`);
    expect(cardHtml).toContain("Ton asks to add the books for October 2026 to Google Sheets");
    expect(cardHtml).not.toContain("data-testid=\"card-outdated\"");

    const { HomeView, needsYouRows } = await import("../../pages/HomePage");
    const [row] = needsYouRows(store.getSnapshot(), [], {}, START, () => {});
    expect(row).toMatchObject({ action: EN, whole: true });
    expect(row!.approve).toBeTypeOf("function");
    const noop = () => {};
    const homeHtml = renderToString(
      <HomeView mode="team" modes={["chat", "team", "code"]} text="" canSend={false} onMode={noop} onText={noop} onSubmit={noop} onChip={noop} asks={[row!]} waiting={1} onSeeAll={noop} working={[]} onSeeTeam={noop} />,
    );
    expect(homeHtml).toContain('data-testid="home-approve"');
    expect(homeHtml).toContain(`<code class="act whole">${escaped(EN)}</code>`);

    const { NeedsView, needRows } = await import("../../pages/NeedsPage");
    const needs = needRows(store.getSnapshot(), START);
    expect(needs[0]).toMatchObject({ action: EN, whole: true });
    expect(renderToString(<NeedsView rows={needs} />)).toContain(`<code class="act whole">${escaped(EN)}</code>`);
  });

  it("a request whose detail this build cannot read whole is shown with no Approve anywhere, and says to update the app", async () => {
    const { store, card } = await opened([append(ownerDetail({ totals: undefined }))]);
    expect(card).toMatchObject({ choices: [], outdated: true });
    const { default: Cards } = await import("../../chat/cards/Cards.slot");
    const html = renderToString(<Cards bot="buddy" item={card!} />);
    expect(html).toContain('data-testid="card-outdated"');
    expect(html).not.toContain("data-choice");
    const { needsYouRows } = await import("../../pages/HomePage");
    expect(needsYouRows(store.getSnapshot(), [], {}, START, () => {})[0]!.approve).toBeUndefined();
  });

  it("a notification says it in one line and offers Approve for no command, so the owner Looks first", async () => {
    await opened([append()]);
    await vi.waitFor(() => expect(h.sent).toHaveLength(1), { timeout: 4000, interval: 5 });
    // The body is the one line, not the whole text cut at the notification's width; a command is never approved from a notification.
    expect(h.sent[0]!.body).toBe("Ton asks to add the books for October 2026 to Google Sheets");
    expect(h.sent[0]!.actionTypeId).toBe("manut:look_first+later");
    expect(String(h.sent[0]!.body)).not.toContain("฿");
  });

  it("a helper's card says it waits for the owner, offers no answer, and offers to pass it on", async () => {
    const { card } = await opened([append(helperDetail())], "helper");
    expect(card).toMatchObject({ choices: [], passOn: true, approvalKind: "command", whole: true });
    expect(card!.command).toBe("Ton asks to add the books for October 2026 to the owner's Google Sheet. Only the owner sees the books and can approve it.");
    const { default: Cards } = await import("../../chat/cards/Cards.slot");
    const html = renderToString(<Cards bot="buddy" item={card!} />);
    expect(html).not.toContain("data-choice");
    expect(html).toContain('data-testid="card-ask-owner"');
    expect(html).not.toContain("฿");
    await vi.waitFor(() => expect(h.sent).toHaveLength(1), { timeout: 4000, interval: 5 });
    expect(h.sent[0]!.body).toBe("Ton asks to add the books for October 2026 to Google Sheets");
    expect(h.sent[0]!.actionTypeId).toBe("manut:look_first+later");
  });
});

describe("the words", () => {
  it("names the title in each language", () => {
    const books = decodeBooksDetail(ownerDetail())!;
    expect(booksTitle(books)).toBe("Ton asks to add the books for October 2026 to Google Sheets");
    setLang("ko");
    expect(booksTitle(books)).toBe("Ton이 2026년 10월 장부를 Google 스프레드시트에 추가하려고 해요");
    setLang("ja");
    expect(booksTitle(books)).toBe("Ton が2026年10月の帳簿を Google スプレッドシートに追加しようとしています");
    setLang("zh");
    expect(booksTitle(books)).toBe("Ton 想把 2026年10月 的账目添加到 Google 表格");
    expect(t("rt.books.title", { month: "x" }, "en")).toContain("x");
  });
});
