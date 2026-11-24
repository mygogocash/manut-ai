// A browser write is approved only where its whole text shows (docs/browser-control.md, "Submitting through a browser").
// Its request's `detail.text` is the control plane's own sentence, naming the site, the page, the form and every value
// exactly as the outpost will type it. A `send_reply` write is approval-core kind `reply`, which a helper and a
// notification may approve, so every surface that can approve one must show that sentence whole: the chat's card, Home and
// Needs you show it word for word with nothing cut or scrolled away, and a notification, which the system may cut short,
// offers Approve only when its body is that text, unchanged and short enough to be seen (notify-rules' `shownWhole`).
//
// The first part builds the ask from the API's own record through the runtime's view; the second runs the app's own store
// over a fake API, as the desktop shell does, and reads every surface from what the store holds.
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToString } from "react-dom/server";
import { setLang } from "../../i18n";
import { decodeApprovals } from "./approvals";
import type { ShopAction, ShopSnapshot, ShopTask } from "./shop";
import { approvalJson, replyDetail } from "./testkit";
import { pendingAsks } from "./view";

const ORIGIN = "https://seller.shopee.co.th";
const PAGE = `${ORIGIN}/portal/chat/2291`;
/** The API's sentence for a reply typed into a chat (`submitText` in apps/api/src/browser-writes.ts): each value quoted as
 *  JSON, so its line break reads `\n` and its two spaces stay two. */
const TEXT =
  `Send a reply on Shopee Seller Centre (${ORIGIN}). On ${PAGE}, set textarea[name="reply"] to "สวัสดีค่ะ  the parcel ships today\\nThank you", ` +
  `set input#order_ref to "RP-118_b", then submit form#chat.`;

/** A browser write's request detail as the API sends it (`SubmitDetail`). */
function submitDetail(id = "write-1", text = TEXT) {
  return {
    actionId: id,
    operationType: "browser.submit",
    action: "send_reply",
    site: "Shopee Seller Centre",
    signInId: "6f1c2b9e-0a43-4f7e-9d55-1b2c3d4e5f60",
    origin: ORIGIN,
    url: PAGE,
    form: "form#chat",
    values: [
      { field: 'textarea[name="reply"]', value: "สวัสดีค่ะ  the parcel ships today\nThank you" },
      { field: "input#order_ref", value: "RP-118_b" },
    ],
    text,
    payloadHash: "hash",
  };
}

const write = (over: Parameters<typeof approvalJson>[0] = {}) => approvalJson({ id: "write-1", kind: "reply", detail: submitDetail(), ...over });

/** The write's action as the task's export lists it: what the desktop read its words from before. */
function action(): ShopAction {
  return {
    id: "write-1",
    taskId: "task-1",
    operationType: "browser.submit",
    targetResourceId: ORIGIN,
    recipients: [],
    payload: {},
    state: "proposed",
    proposedAt: 0,
    expiresAt: 86_400_000,
    approvedAt: null,
    approvedBy: "",
    dispatchedAt: null,
    raw: {},
  };
}

function snap(over: Partial<ShopSnapshot> = {}): ShopSnapshot {
  const task: ShopTask = { id: "task-1", title: "Answer Khun Mali in the shop's chat", objective: "", state: "waitingForAuthorization", createdAt: 0, updatedAt: 0, events: 1, actions: [action()], attempts: [], draft: null, raw: {} };
  return { tasks: [task], approvals: decodeApprovals({ approvals: [write()] }, []), schedules: [], attention: [], attentionOff: false, unreadable: [], readAt: 0, ...over };
}

describe("a browser write's ask", () => {
  afterEach(() => setLang("en"));

  it("is the request's own sentence, whole, never the operation and its site", () => {
    for (const lang of ["en", "ko", "ja", "zh"] as const) {
      setLang(lang);
      const [ask] = pendingAsks(snap());
      // the control plane's sentence is the same in every language: it names selectors and values, which no dictionary may
      // change
      expect(ask, lang).toMatchObject({ command: TEXT, whole: true, kind: "reply", choices: ["once", "deny"] });
      expect(ask.command, lang).not.toContain("browser.submit");
    }
    // with no task to read an action from, as a shop session reads, the same sentence
    expect(pendingAsks(snap({ tasks: [] }))[0]).toMatchObject({ command: TEXT, whole: true });
  });

  it("is the same sentence in an ask from one of several shops", () => {
    const approvals = decodeApprovals({ approvals: [write()] }, []);
    const [ask] = pendingAsks(snap({ tasks: [], approvals: [], shops: [{ shop: { id: "pilot:a", name: "Baan Mali", owner: "Fon", role: "helper" }, approvals }] }));
    // a helper may decide a reply, so the card offers yes once and no
    expect(ask).toMatchObject({ command: TEXT, whole: true, kind: "reply", choices: ["once", "deny"] });
  });

  it("leaves every other request in the words it had", () => {
    const line = decodeApprovals({ approvals: [approvalJson({ id: "action-1", detail: replyDetail("action-1", "See you soon") })] }, []);
    const [ask] = pendingAsks(snap({ tasks: [], approvals: line }));
    expect(ask.command).toBe("Send on LINE: “See you soon”");
    expect(ask).not.toHaveProperty("whole");
    // a browser write whose sentence did not come is shown as before, and not taken for one shown whole
    const bare = decodeApprovals({ approvals: [write({ detail: { ...submitDetail(), text: undefined } })] }, []);
    expect(pendingAsks(snap({ approvals: bare }))[0]).toMatchObject({ command: `browser.submit on ${ORIGIN}` });
    expect(pendingAsks(snap({ approvals: bare }))[0]).not.toHaveProperty("whole");
  });
});

// ---- every surface, from the app's own store ------------------------------------------------------------------------------

const h = vi.hoisted(() => ({ sent: [] as Record<string, unknown>[] }));
vi.mock("@tauri-apps/plugin-notification", () => ({
  isPermissionGranted: async () => true,
  requestPermission: async () => "granted",
  registerActionTypes: async () => {},
  onAction: async () => ({ unregister: async () => {} }),
  sendNotification: (options: Record<string, unknown>) => void h.sent.push(options),
}));

const NOW = Date.UTC(2026, 10, 23, 1, 0, 0) + 600_000; // 08:10 in Bangkok: quiet hours have ended

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
async function settled() {
  for (let i = 0; i < 12; i += 1) {
    await vi.advanceTimersByTimeAsync(5);
    await tick();
  }
}

/** The page as the desktop shell runs it: the connected runtime over a fake API listing `approvals`, the store with
 *  notifications on, and a fresh copy of every module, since what notify.ts keeps is per page. */
async function opened(approvals: unknown[]) {
  vi.resetModules();
  vi.stubGlobal("window", { __TAURI_INTERNALS__: {}, addEventListener: () => {} });
  vi.stubGlobal("navigator", { platform: "MacIntel" });
  const data: Record<string, string> = {};
  vi.stubGlobal("localStorage", { getItem: (k: string) => (k in data ? data[k] : null), setItem: (k: string, v: string) => void (data[k] = v), removeItem: (k: string) => void delete data[k] });
  const kit = await import("./testkit");
  const { createStore, notifySessionEvent, selectAsks } = await import("../../state/store");
  const { HttpHost } = await import("./host");
  const { HttpRuntime } = await import(".");
  const { ApiSession } = await import("./session");
  const i18n = await import("../../i18n");
  i18n.setLang("en");
  const api = kit.serveShop(kit.fakeApi(), { approvals, tasks: [] });
  const session = new ApiSession({ origin: kit.ORIGIN, fetch: api.fetch as never, vault: kit.memoryVault(kit.storedSession(NOW)) });
  const store: import("../../state/store").Store = createStore(new HttpRuntime(new HttpHost({ session })), {
    firstRoster: "all",
    watchSeen: { get: () => null, set: () => {} },
    onEvent: (ev, state) => notifySessionEvent(ev, state, store),
  });
  await store.actions.init();
  await settled();
  const card = store.getState().chats.buddy?.items.find((i) => i.kind === "approval") as import("../../state/store").ApprovalItem | undefined;
  return { store, card, selectAsks, i18n };
}

/** `text` as react-dom/server writes it inside an element. */
const escaped = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#x27;");

/** The rules of a stylesheet that name `selector`, as one string. */
function rules(file: string, selector: string): string {
  const css = readFileSync(new URL(file, import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  return [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)]
    .filter(([, head]) => head.split(",").some((s) => s.trim() === selector))
    .map(([, , body]) => body)
    .join(";");
}

describe("every surface that can approve a browser write shows its whole text", () => {
  beforeEach(() => {
    h.sent.length = 0;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("the chat's card, Home and Needs you, word for word and never cut or scrolled away", async () => {
    const { store, card } = await opened([write()]);
    expect(card).toMatchObject({ command: TEXT, whole: true, choices: ["once", "deny"] });

    // the chat's card: Allow once, under the whole sentence in a block that is never cut
    const { default: Cards } = await import("../../chat/cards/Cards.slot");
    const cardHtml = renderToString(<Cards bot="buddy" item={card!} />);
    expect(cardHtml).toMatch(/data-choice="once"/);
    expect(cardHtml).toContain(`<pre class="card-cmd whole">${escaped(TEXT)}</pre>`);

    // Home: Approve beside the whole sentence
    const { HomeView, needsYouRows } = await import("../../pages/HomePage");
    const [row] = needsYouRows(store.getSnapshot(), [], {}, NOW, () => {});
    expect(row).toMatchObject({ action: TEXT, whole: true });
    expect(row.approve).toBeTypeOf("function");
    const noop = () => {};
    const homeHtml = renderToString(
      <HomeView mode="team" modes={["chat", "team", "code"]} text="" canSend={false} onMode={noop} onText={noop} onSubmit={noop} onChip={noop} asks={[row]} waiting={1} onSeeAll={noop} working={[]} onSeeTeam={noop} />,
    );
    expect(homeHtml).toContain('data-testid="home-approve"');
    expect(homeHtml).toContain(`<code class="act whole">${escaped(TEXT)}</code>`);

    // Needs you: the whole sentence under what is asked
    const { NeedsView, needRows } = await import("../../pages/NeedsPage");
    const needs = needRows(store.getSnapshot(), NOW);
    expect(needs[0]).toMatchObject({ action: TEXT, whole: true });
    expect(renderToString(<NeedsView rows={needs} />)).toContain(`<code class="act whole">${escaped(TEXT)}</code>`);

    // A block marked whole grows with its words: no height it is cut at, nothing scrolled out of sight.
    for (const [file, selector] of [
      ["../../chat/cards/cards.css", ".card-cmd.whole"],
      ["../../pages/home.css", ".home .act.whole"],
      ["../../pages/menuPages.css", ".mpage .need code.act.whole"],
    ]) {
      const body = rules(file, selector);
      expect(body, selector).toMatch(/max-height:\s*none/);
      expect(body, selector).toMatch(/overflow(-y)?:\s*visible/);
    }
  });

  it("a notification, which offers no Approve for a sentence it cannot show whole", async () => {
    await opened([write()]);
    await vi.waitFor(() => expect(h.sent).toHaveLength(1), { timeout: 4000, interval: 5 });
    // kind reply, and the card offers Allow once, but the body is cut and its links shortened: Look first only
    expect(h.sent[0].actionTypeId).toBe("manut:look_first");
    expect(String(h.sent[0].body)).not.toBe(TEXT);
  });

  it("a notification for a short write, shown whole but for its links, offers no Approve either", async () => {
    const short = `Send a reply on S (${ORIGIN}). On ${PAGE}, submit f.`;
    await opened([write({ detail: submitDetail("write-1", short) })]);
    await vi.waitFor(() => expect(h.sent).toHaveLength(1), { timeout: 4000, interval: 5 });
    expect(h.sent[0].actionTypeId).toBe("manut:look_first");
  });

  it("while a LINE reply short enough to be seen whole still offers Approve, and a long one does not", async () => {
    await opened([approvalJson({ id: "action-1", detail: replyDetail("action-1", "Ships today. Thank you!") })]);
    await vi.waitFor(() => expect(h.sent).toHaveLength(1), { timeout: 4000, interval: 5 });
    expect(h.sent[0]).toMatchObject({ body: "Send on LINE: “Ships today. Thank you!”", actionTypeId: "manut:look_first+approve" });

    h.sent.length = 0;
    const long = "Your order ships tomorrow morning, and the courier will call before arriving. Thank you!";
    await opened([approvalJson({ id: "action-1", detail: replyDetail("action-1", long) })]);
    await vi.waitFor(() => expect(h.sent).toHaveLength(1), { timeout: 4000, interval: 5 });
    expect(h.sent[0].actionTypeId).toBe("manut:look_first");
  });
});
