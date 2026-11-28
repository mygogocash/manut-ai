// Buddy's chat on the Connected runtime (item 102l-2; docs/runtime-adapter.md, "Buddy's chat on Connected"), over a stubbed desktop shell
// against an API that answers its chat routes as apps/api does (docs/pilot-api.md, "Chat"). The person owns Baan Mali. A message in
// Buddy's main chat goes to `POST /v1/chat/messages` with the shop's owner session, exactly `{ text }` (a body with any key beyond
// `thread`, `text`, `note` and `sentOnFrom` is refused, as the API refuses it), and Buddy's answer shows under it;
// the next goes to the conversation the first made; a refused one (60 an hour) is marked "Not sent" with the reason, and no answer shows.
// History lists the conversation, and opening it shows both messages, its header saying it is a conversation, not the team's work. It
// runs on the app's own runtime, so the page asks for it (`__MANUT_IN_PROCESS__`, src/lib/bridge.ts): the suite's server is built for the
// mock bridge, which has no Connected.
// Item 102l-6: a conversation's row menu ends with Remove, which asks (naming the conversation and saying it deletes every message in it
// for good): Cancel keeps it and sends nothing, Remove sends `POST /v1/chat/threads/remove` once with exactly `{ id }` and the owner's
// session, a refusal is said in the question and leaves the row. And a conversation of 120 messages opens with the newest 50 and
// Show older, which reads the 50 before the oldest shown, twice, keeping the view where it was.
// Shots: MANUT_SHOTS=<dir> -> connected-chat-{main,answering,thread,remove-menu,remove,remove-refused,older}.png
import { expect, test, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { openChat } from "./start";

const PORT = Number(process.env.MANUT_PORT || 5307);
const SHOTS = process.env.MANUT_SHOTS || "";

test.use({
  storageState: {
    cookies: [],
    origins: [
      {
        origin: `http://127.0.0.1:${PORT}`,
        localStorage: [
          { name: "manut.onboarded", value: "1" },
          { name: "manut.lang", value: "en" },
          { name: "manut.notify.quiet", value: "00:00-00:00" },
        ],
      },
    ],
  },
});

/** The owner session the stubbed API gives Baan Mali. */
const OWNER_MALI = "mos1.pilot-shop-a";
const CHAT_ID = "cht-000000001-abc-00000001";
/** A conversation the API already holds, of 60 exchanges (120 messages), for Show older. */
const LONG_ID = "cht-000000002-abc-00000002";

type Call = { method?: string; path?: string; search?: string; bearer?: string | null; body?: unknown };

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    (window as unknown as { __MANUT_IN_PROCESS__: boolean }).__MANUT_IN_PROCESS__ = true;
  });
});

async function shot(page: Page, name: string): Promise<void> {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: join(SHOTS, `connected-chat-${name}.png`) });
}

/** The desktop shell stood in the page. Baan Mali has one task, the team's work, and Buddy's chat on: a message is answered and kept
 *  in a conversation the first message makes, and a message that says "again" is refused as the 61st of the hour, keeping nothing.
 *  `long`: Baan Mali also holds a conversation of that many exchanges, m1 to m<2n>, "Question k" and "Answer k". A conversation is read a
 *  page at a time as the API reads it (`before`, `limit`, `next`), and removed by `POST /v1/chat/threads/remove` with exactly `{ id }`,
 *  unless the test sets `window.__removal` to the answer to give instead. Every request is kept on `window.__calls`. */
async function stubShell(page: Page, long = 0) {
  await page.addInitScript(
    ({ owner, chatId, longId, long }) => {
      localStorage.setItem("manut.runtime", JSON.stringify({ mode: "connected", origin: "https://dev.manut.xyz" }));
      const w = window as unknown as { __calls: Call[] };
      w.__calls = [];
      const now = Date.now();
      const iso = (ms: number) => new Date(ms).toISOString();
      const reply = (status: number, json: unknown) => ({ status, body: JSON.stringify(json) });
      const mali = { id: "pilot:shop-a", name: "Baan Mali", ownerName: "Fon" };
      const task = {
        task: { id: "task-1", title: "Reply to Khun Mali", objective: "Answer her question about delivery", state: "completed", location: "cloud", funding: "cloudBYOK", criteria: [], createdAt: iso(now - 3_600_000), updatedAt: iso(now - 3_000_000), tenantId: mali.id },
        events: [{ seq: 1, kind: "created", at: iso(now - 3_600_000), rev: 1, via: "put" }],
        actions: [],
        attempts: [],
        attemptsTruncated: false,
        drafts: [],
      };
      const threads: { id: string; title: string; createdAt: string; updatedAt: string; messages: { id: string; from: string; text: string; at: string; stopReason?: string; sentOnFrom?: string; noted?: true }[] }[] = [];
      const view = (c: (typeof threads)[number]) => ({ id: c.id, title: c.title, createdAt: c.createdAt, updatedAt: c.updatedAt, messageCount: c.messages.length });
      if (long) {
        const at = iso(now - 7_200_000);
        const messages = Array.from({ length: long * 2 }, (_, i) => ({ id: `m${i + 1}`, from: i % 2 ? "buddy" : "owner", text: `${i % 2 ? "Answer" : "Question"} ${Math.floor(i / 2) + 1}`, at, ...(i % 2 ? { stopReason: "end_turn" } : {}) }));
        threads.push({ id: longId, title: "Question 1", createdAt: at, updatedAt: at, messages });
      }
      let n = 0;
      (window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {
        metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main", windowLabel: "main" } },
        transformCallback: () => ++n,
        invoke: async (cmd: string, args: { url?: string; method?: string; bearer?: string | null; body?: string | null }) => {
          if (cmd === "api_session_read") {
            return JSON.stringify({ v: 1, origin: "https://dev.manut.xyz", tenant: "apple:owner-1", deviceId: "device-1", accessToken: "access-1", refreshToken: "refresh-1", accessExpiresAt: now + 3_600_000, signedInAt: now });
          }
          if (cmd === "shop_cache_write" || cmd === "shop_cache_read" || cmd === "shop_cache_clear") return null;
          if (cmd !== "api_request") return null;
          const url = new URL(String(args.url));
          const body = args.body ? JSON.parse(args.body) : null;
          w.__calls.push({ method: args.method, path: url.pathname, search: url.search, bearer: args.bearer ?? null, body });
          const key = `${args.method} ${url.pathname}`;
          if (key === "GET /v1/shops") return reply(200, { shops: [{ ...mali, role: "owner" }] });
          if (key === "POST /v1/shops/session") {
            if (body?.shop !== mali.id) return reply(404, { error: "not_found" });
            return reply(200, { shop: mali, role: "owner", account: { id: "owner-account-1" }, session: { accessToken: owner, expiresAt: iso(now + 30 * 86_400_000) } });
          }
          if (args.bearer !== owner) return reply(404, { error: "not_found" });
          if (key === "GET /v1/approvals") return reply(200, { state: url.searchParams.get("state"), approvals: [] });
          if (key === "GET /v1/tasks") return reply(200, { tasks: [task], next: null });
          if (key === "GET /v1/schedules") return reply(200, { schedules: [] });
          if (key === "GET /v1/inbound/attention") return reply(200, { items: [] });
          if (key === "GET /v1/routines") return reply(200, { tenant: mali.id, team: { paused: false, since: null, members: ["nam", "pim", "ton"] }, routines: [] });
          if (key === "POST /v1/chat/messages") {
            // the API takes this long over a message, when a test says so: a model call is seconds, not nothing
            const wait = (window as unknown as { __chatDelay?: number }).__chatDelay;
            if (wait) await new Promise((r) => setTimeout(r, wait));
            // exactly the keys the API takes: `text` always, and `thread`, `note` and `sentOnFrom` when there are any
            if (!body || !("text" in body) || !Object.keys(body).every((k) => ["thread", "text", "note", "sentOnFrom"].includes(k))) return reply(400, { error: "invalid_request" });
            const text = String(body.text ?? "").trim();
            if (/again/i.test(text)) return reply(429, { error: "rate_limited", retryAfter: 1_500, perHour: 60 });
            let c = threads.find((x) => x.id === body.thread);
            if (!c) {
              // a new conversation is named by the words
              c = { id: chatId, title: text.slice(0, 60), createdAt: iso(Date.now()), updatedAt: iso(Date.now()), messages: [] };
              threads.push(c);
            }
            const at = iso(Date.now());
            // kept: the words alone, with the title and that a note went with them
            const message = { id: `m${c.messages.length + 1}`, from: "owner", text, at, ...(typeof body.sentOnFrom === "string" ? { sentOnFrom: body.sentOnFrom } : {}), ...(typeof body.note === "string" ? { noted: true } : {}) };
            const answer = { id: `m${c.messages.length + 2}`, from: "buddy", text: "Sales were ฿4,250 from 12 orders today.", at, stopReason: "end_turn" };
            c.messages.push(message, answer);
            c.updatedAt = at;
            return reply(200, { thread: view(c), message, answer, costSatang: 3 });
          }
          if (key === "GET /v1/chat/threads") return reply(200, { threads: threads.map(view) });
          if (key === "POST /v1/chat/threads/remove") {
            // exactly `{ id }`
            if (!body || Object.keys(body).length !== 1 || typeof body.id !== "string") return reply(400, { error: "invalid_request" });
            const refusal = (window as unknown as { __removal?: { status: number; json: unknown } }).__removal;
            if (refusal) return reply(refusal.status, refusal.json);
            const at = threads.findIndex((x) => x.id === body.id);
            if (at < 0) return reply(404, { error: "thread_not_found" });
            threads.splice(at, 1);
            return reply(200, { id: body.id });
          }
          const one = /^\/v1\/chat\/threads\/([^/]+)$/.exec(url.pathname);
          if (args.method === "GET" && one) {
            const c = threads.find((x) => x.id === decodeURIComponent(one[1]));
            if (!c) return reply(404, { error: "thread_not_found" });
            // a page as the API gives it: the newest `limit` messages, or the `limit` before `before`, oldest first, and `next` is the id of the
            // oldest message in the page when older ones remain
            const before = url.searchParams.get("before");
            const limit = Number(url.searchParams.get("limit") ?? 50);
            const earlier = c.messages.filter((m) => before === null || Number(m.id.slice(1)) < Number(before.slice(1)));
            const shown = earlier.slice(-limit);
            return reply(200, { thread: view(c), messages: shown, next: earlier.length > limit ? shown[0].id : null });
          }
          return reply(404, { error: "not_found" });
        },
      };
    },
    { owner: OWNER_MALI, chatId: CHAT_ID, longId: LONG_ID, long },
  );
}

const calls = (page: Page) => page.evaluate(() => (window as unknown as { __calls: Call[] }).__calls);

test("a message to Buddy goes to the shop's chat with its owner session, Buddy answers, and a refused one is marked not sent", async ({ page }) => {
  await stubShell(page);
  await page.goto("/");
  await expect(page.getByTestId("page-home")).toBeVisible();
  await openChat(page, "buddy", "Buddy");
  // Connected answers with the API's model: the chat has no model menu, and never says a model is missing
  await expect(page.getByTestId("composer")).toBeVisible();
  await expect(page.getByTestId("model-pill")).toHaveCount(0);
  await expect(page.getByTestId("chat-no-model")).toHaveCount(0);

  await page.getByTestId("composer").fill("How were sales today?");
  await page.getByTestId("send").click();
  await expect(page.getByTestId("bubble-bot").filter({ hasText: "Sales were ฿4,250 from 12 orders today." })).toBeVisible();
  await expect(page.getByTestId("chat-no-model")).toHaveCount(0);

  await page.getByTestId("composer").fill("And again?");
  await page.getByTestId("send").click();
  const refused = page.getByTestId("bubble-user").filter({ hasText: "And again?" });
  await expect(refused.locator(".msg-err")).toContainText("Not sent · Buddy takes at most 60 messages an hour. Try again at");
  // no second answer came for it
  await expect(page.getByTestId("bubble-bot")).toHaveCount(1);
  await shot(page, "main");

  const sent = (await calls(page)).filter((c) => c.method === "POST" && c.path === "/v1/chat/messages");
  expect(sent.map((c) => [c.bearer, c.body])).toEqual([
    [OWNER_MALI, { text: "How were sales today?" }],
    [OWNER_MALI, { thread: CHAT_ID, text: "And again?" }],
  ]);
});

test("while the API works on an answer the chat shows Buddy writing, the line then says how long it took, and a refused message is no failed turn", async ({ page }) => {
  await stubShell(page);
  await page.goto("/");
  await expect(page.getByTestId("page-home")).toBeVisible();
  await openChat(page, "buddy", "Buddy");
  await page.evaluate(() => {
    (window as unknown as { __chatDelay: number }).__chatDelay = 1_500;
  });

  await page.getByTestId("composer").fill("How were sales today?");
  await page.getByTestId("send").click();
  // the message is on its way and no turn is said yet: Buddy's typing bubble shows, and no line says anything ran
  await expect(page.getByTestId("typing")).toBeVisible();
  await expect(page.getByTestId("activity")).toHaveCount(0);
  await expect(page.getByTestId("bubble-bot")).toHaveCount(0);
  // the person's own words are above it, in view
  await expect(page.getByTestId("bubble-user").filter({ hasText: "How were sales today?" })).toBeInViewport();
  // for the picture only: the message's own arrival has settled
  if (SHOTS) await page.waitForTimeout(500);
  await shot(page, "answering");
  await expect(page.getByTestId("bubble-bot").filter({ hasText: "Sales were ฿4,250 from 12 orders today." })).toBeVisible();
  await expect(page.getByTestId("typing")).toHaveCount(0);
  // the turn began when the message went, so its line counts the second and a half the API took
  await expect(page.getByTestId("activity")).toContainText(/Worked for [12]s/);

  await page.getByTestId("composer").fill("And again?");
  await page.getByTestId("send").click();
  await expect(page.getByTestId("typing")).toBeVisible();
  const refused = page.getByTestId("bubble-user").filter({ hasText: "And again?" });
  await expect(refused.locator(".msg-err")).toContainText("Not sent · Buddy takes at most 60 messages an hour.");
  // the bubble goes with the refusal, and nothing says a turn failed: the one line is the first answer's
  await expect(page.getByTestId("typing")).toHaveCount(0);
  await expect(page.getByTestId("activity")).toHaveCount(1);
  await expect(page.locator('[data-testid="activity"][data-state="error"]')).toHaveCount(0);
  await expect(page.getByTestId("bubble-bot")).toHaveCount(1);
});

test("History lists the conversation, which opens with both messages and says it is a conversation", async ({ page }) => {
  await stubShell(page);
  await page.goto("/");
  await expect(page.getByTestId("page-home")).toBeVisible();
  await openChat(page, "buddy", "Buddy");
  await page.getByTestId("composer").fill("How were sales today?");
  await page.getByTestId("send").click();
  await expect(page.getByTestId("bubble-bot")).toHaveCount(1);

  await page.getByTestId("menu-history").click();
  const row = page.getByTestId("history-row").filter({ hasText: "How were sales today?" });
  await expect(row).toBeVisible();
  // the team's work is listed once, as its job, apart from the conversation
  await expect(page.getByTestId("history-row").filter({ hasText: "Reply to Khun Mali" })).toBeVisible();
  await row.click();
  await expect(page.getByTestId("thread-chat")).toBeVisible();
  await expect(page.getByTestId("thread-kind")).toHaveText("Conversation");
  await expect(page.getByTestId("thread-chat").getByTestId("bubble-user").filter({ hasText: "How were sales today?" })).toBeVisible();
  await expect(page.getByTestId("thread-chat").getByTestId("bubble-bot").filter({ hasText: "Sales were ฿4,250 from 12 orders today." })).toBeVisible();
  await shot(page, "thread");

  const reads = (await calls(page)).filter((c) => c.method === "GET" && c.path === `/v1/chat/threads/${CHAT_ID}`);
  expect(reads.map((c) => c.bearer)).toEqual([OWNER_MALI]);
});

/** Opens the row of `title` in History. */
async function openFromHistory(page: Page, title: string) {
  await page.getByTestId("menu-history").click();
  await page.getByTestId("history-row").filter({ hasText: title }).click();
  await expect(page.getByTestId("thread-chat")).toBeVisible();
}

const removals = async (page: Page) => (await calls(page)).filter((c) => c.method === "POST" && c.path === "/v1/chat/threads/remove");

test("Remove asks first: Cancel keeps the conversation and sends nothing, and Remove deletes it with one request and closes it", async ({ page }) => {
  await stubShell(page);
  await page.goto("/");
  await expect(page.getByTestId("page-home")).toBeVisible();
  await openChat(page, "buddy", "Buddy");
  await page.getByTestId("composer").fill("How were sales today?");
  await page.getByTestId("send").click();
  await expect(page.getByTestId("bubble-bot")).toHaveCount(1);
  await openFromHistory(page, "How were sales today?");

  // the row in Recent: its menu has its own choices, then Remove
  const recent = page.getByTestId("sidebar").locator(".rec-li").filter({ hasText: "How were sales today?" });
  await recent.hover();
  await recent.getByTestId("row-more").click();
  const menu = page.getByTestId("row-menu");
  await expect(menu.getByTestId("row-pin")).toBeVisible();
  await expect(menu.getByTestId("row-remove")).toHaveText("Remove conversation…");
  if (SHOTS) await page.waitForTimeout(500);
  await shot(page, "remove-menu");
  await menu.getByTestId("row-remove").click();

  // the question names the conversation and says what a removal does; Cancel holds the focus
  const ask = page.getByTestId("remove-conversation");
  await expect(ask).toBeVisible();
  await expect(menu).toHaveCount(0);
  await expect(ask.getByTestId("remove-title")).toHaveText("Remove this conversation?");
  await expect(ask.getByTestId("remove-name")).toHaveText("“How were sales today?”");
  await expect(ask.getByTestId("remove-body")).toHaveText("This deletes every message in it for good. It cannot be taken back.");
  await expect(ask.getByTestId("remove-cancel")).toBeFocused();
  await expect(ask.getByTestId("remove-yes")).toHaveText("Remove conversation");
  // for the picture only: the question fades in, and the shot should be of the settled card
  if (SHOTS) await page.waitForTimeout(700);
  await shot(page, "remove");

  // Cancel, Escape and a press outside send nothing, and the conversation stays open
  await ask.getByTestId("remove-cancel").click();
  await expect(ask).toHaveCount(0);
  await recent.hover();
  await recent.getByTestId("row-more").click();
  await page.getByTestId("row-menu").getByTestId("row-remove").click();
  await expect(ask).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(ask).toHaveCount(0);
  await recent.hover();
  await recent.getByTestId("row-more").click();
  await page.getByTestId("row-menu").getByTestId("row-remove").click();
  await page.getByTestId("remove-veil").click({ position: { x: 4, y: 4 } });
  await expect(ask).toHaveCount(0);
  expect(await removals(page)).toEqual([]);
  await expect(page.getByTestId("thread-chat")).toBeVisible();
  await expect(recent).toBeVisible();

  // Remove: one request, with exactly { id } and the owner's session; the conversation closes and leaves Recent and History
  await recent.hover();
  await recent.getByTestId("row-more").click();
  await page.getByTestId("row-menu").getByTestId("row-remove").click();
  await ask.getByTestId("remove-yes").click();
  await expect(ask).toHaveCount(0);
  await expect(page.getByTestId("thread-chat")).toHaveCount(0);
  await expect(page.getByTestId("sidebar").locator(".rec-li").filter({ hasText: "How were sales today?" })).toHaveCount(0);
  expect((await removals(page)).map((c) => [c.bearer, c.body])).toEqual([[OWNER_MALI, { id: CHAT_ID }]]);
  await page.getByTestId("menu-history").click();
  await expect(page.getByTestId("history-row").filter({ hasText: "How were sales today?" })).toHaveCount(0);
  // the team's work is still listed, and nothing else was sent to the chat's removal
  await expect(page.getByTestId("history-row").filter({ hasText: "Reply to Khun Mali" })).toBeVisible();
  expect((await removals(page)).length).toBe(1);
});

test("a refused removal is said in the question and leaves the row; the team's work offers no Remove", async ({ page }) => {
  await stubShell(page);
  await page.goto("/");
  await expect(page.getByTestId("page-home")).toBeVisible();
  await openChat(page, "buddy", "Buddy");
  await page.getByTestId("composer").fill("How were sales today?");
  await page.getByTestId("send").click();
  await expect(page.getByTestId("bubble-bot")).toHaveCount(1);
  await page.getByTestId("menu-history").click();
  const row = page.locator(".hist-li").filter({ has: page.getByTestId("history-row").filter({ hasText: "How were sales today?" }) });
  await expect(row).toBeVisible();

  // the shop says only its owner may remove it, whatever the app thought
  await page.evaluate(() => {
    (window as unknown as { __removal: unknown }).__removal = { status: 403, json: { error: "owner_only" } };
  });
  await row.hover();
  await row.getByTestId("row-more").click();
  await page.getByTestId("row-menu").getByTestId("row-remove").click();
  const ask = page.getByTestId("remove-conversation");
  await ask.getByTestId("remove-yes").click();
  await expect(ask.getByTestId("remove-error")).toHaveText("Only Fon can remove conversations at Baan Mali.");
  await expect(ask).toBeVisible();
  if (SHOTS) await page.waitForTimeout(700);
  await shot(page, "remove-refused");
  expect((await removals(page)).length).toBe(1);
  await ask.getByTestId("remove-cancel").click();
  await expect(ask).toHaveCount(0);
  await expect(row).toBeVisible();

  // the team's work, a job of its own, has no row menu at all, so no Remove
  const work = page.locator(".hist-li").filter({ hasText: "Reply to Khun Mali" });
  await expect(work).toBeVisible();
  await expect(work.getByTestId("row-more")).toHaveCount(0);
});

test("a conversation of 120 messages opens with the newest 50, and Show older reads the 50 before, twice, keeping the view where it was", async ({ page }) => {
  await stubShell(page, 60);
  await page.goto("/");
  await expect(page.getByTestId("page-home")).toBeVisible();
  await openFromHistory(page, "Question 1");
  const chat = page.getByTestId("thread-chat");
  const bubbles = chat.getByTestId("bubble-user");
  // the newest 50 messages are 25 exchanges: Question 36 to 60
  await expect(bubbles).toHaveCount(25);
  await expect(chat.getByTestId("bubble-bot")).toHaveCount(25);
  await expect(bubbles.first()).toContainText("Question 36");
  const reads = async () => (await calls(page)).filter((c) => c.method === "GET" && c.path === `/v1/chat/threads/${LONG_ID}`);
  expect((await reads()).length).toBe(1);

  // Show older is the first thing in the column, which opens at its bottom
  const column = page.getByTestId("timeline");
  await column.evaluate((el) => (el.scrollTop = 0));
  const older = chat.getByTestId("chat-older");
  await expect(older.getByTestId("chat-older-show")).toHaveText("Show older");
  await expect(older).toBeInViewport();
  await shot(page, "older");
  const y = async () => (await bubbles.filter({ hasText: /^Question 36/ }).first().boundingBox())!.y;
  const before = await y();

  await older.getByTestId("chat-older-show").click();
  await expect(bubbles).toHaveCount(50);
  await expect(chat.getByTestId("bubble-bot")).toHaveCount(50);
  // the 50 before are above, in order, and what was at the top is where it was
  await expect(bubbles.first()).toContainText("Question 11");
  await expect(older).toBeVisible();
  expect(Math.abs((await y()) - before)).toBeLessThan(3);
  // older messages are not new ones: the pill that brings the person back to the bottom counts none
  await expect(page.getByTestId("jump-bottom")).toHaveAttribute("data-new", "0");

  // back at the top, where the button is (the press kept the first message in place, so the button is far above it now)
  await column.evaluate((el) => (el.scrollTop = 0));
  const again = await y();
  await older.getByTestId("chat-older-show").click();
  await expect(bubbles).toHaveCount(60);
  await expect(bubbles.first()).toContainText("Question 1");
  // the first message is shown: nothing is left to ask for, and its line is gone from above, yet the view is where it was
  await expect(older).toHaveCount(0);
  expect(Math.abs((await y()) - again)).toBeLessThan(3);

  // two reads after the open, each the page before the oldest shown, with the owner's session
  expect((await reads()).map((c) => [c.bearer, c.search])).toEqual([
    [OWNER_MALI, ""],
    [OWNER_MALI, "?before=m71&limit=50"],
    [OWNER_MALI, "?before=m21&limit=50"],
  ]);
});
