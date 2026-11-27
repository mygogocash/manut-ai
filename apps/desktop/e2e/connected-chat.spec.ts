// Buddy's chat on the Connected runtime (item 102l-2; docs/runtime-adapter.md, "Buddy's chat on Connected"), over a stubbed desktop shell
// against an API that answers its chat routes as apps/api does (docs/pilot-api.md, "Chat"). The person owns Baan Mali. A message in
// Buddy's main chat goes to `POST /v1/chat/messages` with the shop's owner session, exactly `{ text }`, and Buddy's answer shows under it;
// the next goes to the conversation the first made; a refused one (60 an hour) is marked "Not sent" with the reason, and no answer shows.
// History lists the conversation, and opening it shows both messages, its header saying it is a conversation, not the team's work. It
// runs on the app's own runtime, so the page asks for it (`__MANUT_IN_PROCESS__`, src/lib/bridge.ts): the suite's server is built for the
// mock bridge, which has no Connected.
// Shots: MANUT_SHOTS=<dir> -> connected-chat-{main,thread}.png
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

type Call = { method?: string; path?: string; bearer?: string | null; body?: unknown };

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
 *  Every request is kept on `window.__calls`. */
async function stubShell(page: Page) {
  await page.addInitScript(
    ({ owner, chatId }) => {
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
      const threads: { id: string; title: string; createdAt: string; updatedAt: string; messages: { id: string; from: string; text: string; at: string; stopReason?: string }[] }[] = [];
      const view = (c: (typeof threads)[number]) => ({ id: c.id, title: c.title, createdAt: c.createdAt, updatedAt: c.updatedAt, messageCount: c.messages.length });
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
          w.__calls.push({ method: args.method, path: url.pathname, bearer: args.bearer ?? null, body });
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
            const text = String(body?.text ?? "").trim();
            if (/again/i.test(text)) return reply(429, { error: "rate_limited", retryAfter: 1_500, perHour: 60 });
            let c = threads.find((x) => x.id === body?.thread);
            if (!c) {
              c = { id: chatId, title: text.slice(0, 60), createdAt: iso(Date.now()), updatedAt: iso(Date.now()), messages: [] };
              threads.push(c);
            }
            const at = iso(Date.now());
            const message = { id: `m${c.messages.length + 1}`, from: "owner", text, at };
            const answer = { id: `m${c.messages.length + 2}`, from: "buddy", text: "Sales were ฿4,250 from 12 orders today.", at, stopReason: "end_turn" };
            c.messages.push(message, answer);
            c.updatedAt = at;
            return reply(200, { thread: view(c), message, answer, costSatang: 3 });
          }
          if (key === "GET /v1/chat/threads") return reply(200, { threads: threads.map(view) });
          const one = /^\/v1\/chat\/threads\/([^/]+)$/.exec(url.pathname);
          if (args.method === "GET" && one) {
            const c = threads.find((x) => x.id === decodeURIComponent(one[1]));
            return c ? reply(200, { thread: view(c), messages: c.messages, next: null }) : reply(404, { error: "thread_not_found" });
          }
          return reply(404, { error: "not_found" });
        },
      };
    },
    { owner: OWNER_MALI, chatId: CHAT_ID },
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
