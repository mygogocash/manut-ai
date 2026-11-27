// The reach cards over Buddy's chats on the Connected runtime (item 102l-3; docs/connected-chat.md, C), over a stubbed desktop shell
// against an API that answers its chat routes as apps/api does (docs/pilot-api.md, "Chat"). The person owns Baan Mali, which already
// has one conversation with Buddy, "Price list for March". In Buddy's main chat the person lists it under the box, and Buddy, told the
// list with the message, asks to read it: the card shows exactly the text Buddy would get and says the press is billed, and nothing
// is posted until Let Buddy read, which posts that text once. Then Buddy asks to send that conversation a message: the card shows it
// whole, nothing is posted until Send there, which posts it once to that conversation, its words as the text and the asking chat's name
// as `sentOnFrom`. Manut AI's own lines are fields of the message (item 102l-5): Buddy's note is the message's `note`, never part of
// its words, and the API keeps the words alone, so a conversation is named by them. Every request is kept on `window.__calls`, so
// "nothing posted before the press" is checked against the wire. It runs on the app's own runtime (`__MANUT_IN_PROCESS__`,
// src/lib/bridge.ts), as connected-chat.spec.ts does.
// A second test starts a conversation from a card: the brief is the first message's words and names the conversation, and the
// conversation says where its first message came from.
// Shots: MANUT_SHOTS=<dir> -> connected-reach-{read,send,sent-on,start}.png
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
/** The conversation Baan Mali already has, the one the main chat's first message makes, and the one a Start card makes. */
const PRICES = "cht-000000001-abc-00000001";
const MADE = "cht-000000002-abc-00000002";
const STARTED = "cht-000000003-abc-00000003";
const NOTE_HEAD = "[Manut AI: a note to Buddy]";

type Call = { method?: string; path?: string; bearer?: string | null; body?: { thread?: string; text?: string; note?: string; sentOnFrom?: string } | null };

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    (window as unknown as { __MANUT_IN_PROCESS__: boolean }).__MANUT_IN_PROCESS__ = true;
  });
});

async function shot(page: Page, name: string): Promise<void> {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: join(SHOTS, `connected-reach-${name}.png`) });
}

/** The desktop shell stood in the page, with Baan Mali's chat on and one conversation in it. The chat answers as apps/api's does: a body
 *  is `{ text }` or `{ thread, text }` with `note` and `sentOnFrom` if it has them and no other key; the words are kept alone, with the
 *  title and that a note went with them, and the note itself is kept nowhere. Buddy answers as the stand-in provider would: a message
 *  that comes with the note and asks about rice prices is answered with a read block, one that asks to tell the price list is answered
 *  with a send block, item 97's text of another conversation with what it says, and anything else with a plain line. */
async function stubShell(page: Page) {
  await page.addInitScript(
    ({ owner, prices, made, started, noteHead }) => {
      localStorage.setItem("manut.runtime", JSON.stringify({ mode: "connected", origin: "https://dev.manut.xyz" }));
      const w = window as unknown as { __calls: Call[] };
      w.__calls = [];
      const now = Date.now();
      const iso = (ms: number) => new Date(ms).toISOString();
      const reply = (status: number, json: unknown) => ({ status, body: JSON.stringify(json) });
      const mali = { id: "pilot:shop-a", name: "Baan Mali", ownerName: "Fon" };
      type Msg = { id: string; from: string; text: string; at: string; stopReason?: string; sentOnFrom?: string; noted?: true };
      const threads: { id: string; title: string; createdAt: string; updatedAt: string; messages: Msg[] }[] = [
        {
          id: prices,
          title: "Price list for March",
          createdAt: iso(now - 86_400_000),
          updatedAt: iso(now - 86_000_000),
          messages: [
            { id: "m1", from: "owner", text: "Price list for March", at: iso(now - 86_400_000) },
            { id: "m2", from: "buddy", text: "Rice is ฿45 a bag and eggs ฿4 each this month.", at: iso(now - 86_000_000), stopReason: "end_turn" },
          ],
        },
      ];
      const view = (c: (typeof threads)[number]) => ({ id: c.id, title: c.title, createdAt: c.createdAt, updatedAt: c.updatedAt, messageCount: c.messages.length });
      const answer = (text: string, noted: boolean): string => {
        if (noted && text.startsWith("What did we say about rice")) return 'I will look at that conversation.\n\n```manut-read\n{"chat":"1"}\n```';
        if (noted && text.startsWith("Can we plan a sale")) return 'Yes, I will start one.\n\n```manut-open\n{"brief":"Plan the Songkran sale"}\n```';
        if (noted && text.startsWith("Tell the price list")) return 'I will tell it.\n\n```manut-send\n{"chat":"1","message":"Rice is now ฿48 a bag."}\n```';
        if (text.startsWith("Context from the chat")) return "In March rice was ฿45 a bag.";
        return "Noted.";
      };
      // the ids of the conversations the chat makes, in order
      const fresh = [made, started];
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
          if (key === "GET /v1/tasks") return reply(200, { tasks: [], next: null });
          if (key === "GET /v1/schedules") return reply(200, { schedules: [] });
          if (key === "GET /v1/inbound/attention") return reply(200, { items: [] });
          if (key === "GET /v1/routines") return reply(200, { tenant: mali.id, team: { paused: false, since: null, members: ["nam", "pim", "ton"] }, routines: [] });
          if (key === "POST /v1/chat/messages") {
            // exactly the keys the API takes: `text` always, and `thread`, `note` and `sentOnFrom` when there are any
            if (!body || !("text" in body) || !Object.keys(body).every((k) => ["thread", "text", "note", "sentOnFrom"].includes(k))) return reply(400, { error: "invalid_request" });
            const text = String(body.text ?? "").trim();
            let c = threads.find((x) => x.id === body.thread);
            if (body.thread && !c) return reply(404, { error: "thread_not_found" });
            if (!c) {
              // a new conversation is named by the words: nothing else is in the text
              c = { id: fresh.shift() ?? made, title: text.replace(/\s+/g, " ").slice(0, 60), createdAt: iso(Date.now()), updatedAt: iso(Date.now()), messages: [] };
              threads.push(c);
            }
            const at = iso(Date.now());
            const noted = typeof body.note === "string" && body.note.startsWith(noteHead);
            const message = { id: `m${c.messages.length + 1}`, from: "owner", text, at, ...(typeof body.sentOnFrom === "string" ? { sentOnFrom: body.sentOnFrom } : {}), ...(noted ? { noted: true } : {}) };
            const said = { id: `m${c.messages.length + 2}`, from: "buddy", text: answer(text, noted), at, stopReason: "end_turn" };
            c.messages.push(message, said);
            c.updatedAt = at;
            return reply(200, { thread: view(c), message, answer: said, costSatang: 3 });
          }
          if (key === "GET /v1/chat/threads") return reply(200, { threads: [...threads].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt)).map(view) });
          const one = /^\/v1\/chat\/threads\/([^/]+)$/.exec(url.pathname);
          if (args.method === "GET" && one) {
            const c = threads.find((x) => x.id === decodeURIComponent(one[1]));
            return c ? reply(200, { thread: view(c), messages: c.messages, next: null }) : reply(404, { error: "thread_not_found" });
          }
          return reply(404, { error: "not_found" });
        },
      };
    },
    { owner: OWNER_MALI, prices: PRICES, made: MADE, started: STARTED, noteHead: NOTE_HEAD },
  );
}

const calls = (page: Page) => page.evaluate(() => (window as unknown as { __calls: Call[] }).__calls);
/** Every write the app sent to the API's chat, each a message to Buddy (the live feed's ticket and the shop's session are reads). */
const writes = async (page: Page) => (await calls(page)).filter((c) => c.method !== "GET" && !!c.path?.startsWith("/v1/chat"));

test("a read card and a send card over Buddy's conversations post nothing before their press, then exactly what they showed, once", async ({ page }) => {
  await stubShell(page);
  await page.goto("/");
  await expect(page.getByTestId("page-home")).toBeVisible();
  await openChat(page, "buddy", "Buddy");

  // the list under the box: the shop's other conversation, added at the person's own press
  const list = page.getByTestId("reach-list");
  await expect(list.getByTestId("reach-add")).toHaveText("Let Buddy reach another conversation…");
  await list.getByTestId("reach-add").click();
  await page.getByTestId("bring-option").filter({ hasText: "Price list for March" }).click();
  await expect(list.getByTestId("reach-chip")).toHaveText(/1\s*Price list for March/);
  await expect(list).toContainText("Buddy may reach");
  expect(await writes(page)).toEqual([]);

  // Buddy, told the list after the owner's words, asks to read it: a card, and nothing more is posted
  await page.getByTestId("composer").fill("What did we say about rice prices?");
  await page.getByTestId("send").click();
  const read = page.getByTestId("reach-card").filter({ hasText: "Buddy asks to read “Price list for March”" });
  await expect(read).toBeVisible();
  await expect(read.getByTestId("reach-text")).toContainText("Rice is ฿45 a bag and eggs ฿4 each this month.");
  await expect(read.getByTestId("reach-cost")).toHaveText("Let Buddy read sends this to Buddy as your next message here: one message, billed to the shop's monthly limit.");
  // the block is the card's: the bubble keeps Buddy's words alone
  await expect(page.getByTestId("bubble-bot").filter({ hasText: "I will look at that conversation." })).toBeVisible();
  await expect(page.getByTestId("bubble-bot").filter({ hasText: "manut-read" })).toHaveCount(0);
  let sent = await writes(page);
  expect(sent).toHaveLength(1);
  expect(sent[0].bearer).toBe(OWNER_MALI);
  // the words alone are the text, and Buddy's note is the message's own field
  expect(sent[0].body?.text).toBe("What did we say about rice prices?");
  expect(sent[0].body?.note?.startsWith(NOTE_HEAD)).toBe(true);
  expect(sent[0].body?.sentOnFrom).toBeUndefined();
  expect(sent[0].body?.thread).toBeUndefined();
  await page.waitForTimeout(500);
  expect(await writes(page)).toHaveLength(1);
  await shot(page, "read");

  await read.getByTestId("reach-yes").click();
  await expect(page.getByTestId("reach-line").filter({ hasText: "Buddy read “Price list for March”." })).toBeVisible();
  await expect(page.getByTestId("bubble-bot").filter({ hasText: "In March rice was ฿45 a bag." })).toBeVisible();
  sent = await writes(page);
  expect(sent).toHaveLength(2);
  // exactly the text the card showed, as the asking chat's next message, to its own conversation
  expect(sent[1].body?.thread).toBe(MADE);
  expect(sent[1].body?.text?.startsWith('Context from the chat "Price list for March":')).toBe(true);
  expect(sent[1].body?.text).toContain("Rice is ฿45 a bag and eggs ฿4 each this month.");
  // the asking chat's list still holds the conversation, so the note goes beside item 97's text, apart from it
  expect(sent[1].body?.note?.startsWith(NOTE_HEAD)).toBe(true);
  expect(sent[1].body?.text).not.toContain(NOTE_HEAD);

  // Buddy asks to send the price list a message: the card shows it whole, and nothing more is posted until Send there
  await page.getByTestId("composer").fill("Tell the price list conversation that rice went up");
  await page.getByTestId("send").click();
  const send = page.getByTestId("reach-card").filter({ hasText: "Send this to “Price list for March”?" });
  await expect(send).toBeVisible();
  await expect(send.getByTestId("reach-text")).toHaveText("Rice is now ฿48 a bag.");
  await expect(send.getByTestId("reach-cost")).toContainText("billed to the shop's monthly limit");
  expect(await writes(page)).toHaveLength(3);
  await page.waitForTimeout(500);
  expect(await writes(page)).toHaveLength(3);
  await shot(page, "send");

  await send.getByTestId("reach-yes").click();
  await expect(page.getByTestId("reach-line").filter({ hasText: "Sent to “Price list for March”, marked as from this conversation." })).toBeVisible();
  // the card settles as it is pressed, and its one post follows
  await expect.poll(async () => (await writes(page)).length).toBe(4);
  sent = await writes(page);
  expect(sent[3]).toMatchObject({ bearer: OWNER_MALI, path: "/v1/chat/messages" });
  // the words as the text, and the asking chat's name as its own field, for the API to give the model as the mark: no line of ours is in the text
  expect(sent[3].body).toEqual({ thread: PRICES, text: "Rice is now ฿48 a bag.", sentOnFrom: "What did we say about rice prices?" });
  // nothing reached an approval, and nothing was posted twice
  expect((await calls(page)).filter((c) => c.path?.startsWith("/v1/approvals") && c.method !== "GET")).toEqual([]);

  // the conversation the main chat made is named by the owner's words alone, not by the start of a note after them
  await page.getByTestId("menu-history").click();
  await expect(page.getByTestId("history-row").filter({ hasText: "What did we say about rice prices?" })).toBeVisible();
  await expect(page.getByTestId("history-row").filter({ hasText: "Manut AI" })).toHaveCount(0);
  // the conversation it reached says where the message came from, above its words
  await page.getByTestId("history-row").filter({ hasText: "Price list for March" }).click();
  await expect(page.getByTestId("thread-chat")).toBeVisible();
  await expect(page.getByTestId("thread-chat").getByTestId("bubble-reached-from")).toHaveText(/From “What did we say about rice prices\?”, sent on by you/);
  await shot(page, "sent-on");
});

test("a Start conversation card posts the brief alone as the words, the conversation is named by it, and it says where its first message came from", async ({ page }) => {
  await stubShell(page);
  await page.goto("/");
  await expect(page.getByTestId("page-home")).toBeVisible();
  await openChat(page, "buddy", "Buddy");
  const list = page.getByTestId("reach-list");
  await list.getByTestId("reach-add").click();
  await page.getByTestId("bring-option").filter({ hasText: "Price list for March" }).click();
  await expect(list.getByTestId("reach-chip")).toHaveText(/1\s*Price list for March/);

  // Buddy asks to start a conversation: the card shows the brief whole, and only the owner's own message has gone
  await page.getByTestId("composer").fill("Can we plan a sale?");
  await page.getByTestId("send").click();
  const start = page.getByTestId("reach-card").filter({ hasText: "Buddy asks to start a new conversation" });
  await expect(start).toBeVisible();
  await expect(start.getByTestId("reach-text")).toHaveText("Plan the Songkran sale");
  expect(await writes(page)).toHaveLength(1);
  await page.waitForTimeout(500);
  expect(await writes(page)).toHaveLength(1);

  await start.getByTestId("reach-yes").click();
  await expect(page.getByTestId("reach-line").filter({ hasText: "Conversation started" })).toBeVisible();
  await expect.poll(async () => (await writes(page)).length).toBe(2);
  // the brief is the whole text, and the asking chat's name is the field beside it: nothing of ours is in the words, so nothing leaks into the name
  expect((await writes(page))[1].body).toEqual({ text: "Plan the Songkran sale", sentOnFrom: "Can we plan a sale?" });

  // the API names the conversation by the words it was given, and a brief this short is all of them: no start of a mark follows it
  await page.getByTestId("menu-history").click();
  const row = page.getByTestId("history-row").filter({ hasText: "Plan the Songkran sale" });
  await expect(row).toBeVisible();
  await expect(page.getByTestId("history-row").filter({ hasText: "Manut AI" })).toHaveCount(0);
  await row.click();
  await expect(page.getByTestId("thread-chat")).toBeVisible();
  await expect(page.getByTestId("thread-chat").getByTestId("bubble-reached-from")).toHaveText(/From “Can we plan a sale\?”, sent on by you/);
  await expect(page.getByTestId("thread-chat").getByTestId("bubble-user").filter({ hasText: "Plan the Songkran sale" })).toBeVisible();
  await shot(page, "start");
});
