// Every kind of ask card, in each of its states, in light and in dark (item 85g, docs/design-audit.md findings 8 and
// 16): the design canvas's decision (KitApproval, StatesApproval, StatesAsks, StatesCodeDev) as the kit's box with one
// black main button and every other choice quiet, no tinted button and no red rail. The main choice is the board's:
// Allow once on an approval, Send to the owner while a note is written, Answer and Submit on a question. A card with
// none (one this version cannot answer, a helper's ask only the owner may decide, a question whose rows answer it) has
// no black button at all. Needs you is one card a decision with its amber mark and no black button, since nothing is
// approved there. The keys stay as they were: Deny is the first stop of Tab, Enter on the card answers nothing, and
// Escape answers nothing.
//
// ASK_SHOTS=<dir> keeps a picture of each card as a PNG (<theme>-<kind>.png). Without it the spec still checks every card.
import { expect, test, type Locator, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { chatOpen, openChat, startDone } from "./start";

const MOCK = Number(process.env.MANUT_MOCK_PORT || 5308);
const DIR = process.env.ASK_SHOTS || "";
const THEMES = ["light", "dark"] as const;
type Theme = (typeof THEMES)[number];

async function mock(op: string, params: Record<string, unknown> = {}): Promise<any> {
  const ws = new WebSocket(`ws://127.0.0.1:${MOCK}/?token=e2e`);
  await new Promise<void>((res, rej) => {
    ws.onopen = () => res();
    ws.onerror = () => rej(new Error("mock websocket error"));
  });
  const reply = await new Promise<any>((res) => {
    ws.onmessage = (m) => {
      const msg = JSON.parse(String(m.data));
      if (msg.id === "ak1") res(msg);
    };
    ws.send(JSON.stringify({ id: "ak1", op, ...params }));
  });
  ws.close();
  expect(reply.ok, JSON.stringify(reply)).toBe(true);
  return reply.result;
}

const calls = async (op: string) => (await mock("mock.calls")).calls.filter((c: any) => c.op === op);

async function open(page: Page, theme: Theme) {
  await page.addInitScript((t) => localStorage.setItem("manut.theme", t), theme);
  await page.goto("/");
  await chatOpen(page);
  await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
  await startDone(page);
}

/** A picture of `el`, when ASK_SHOTS names a folder. */
async function shot(el: Locator, theme: Theme, name: string) {
  if (!DIR) return;
  mkdirSync(DIR, { recursive: true });
  await el.screenshot({ path: join(DIR, `${theme}-${name}.png`), animations: "disabled" });
}

interface Look {
  text: string;
  filled: boolean;
  bg: string;
  color: string;
  height: number;
}

/** Each button of `root` as it is drawn: filled when its ground is the primary's black (white in dark). */
const looks = (root: Locator): Promise<Look[]> =>
  root.locator("button").evaluateAll((bs) => {
    const probe = document.createElement("span");
    probe.style.color = "var(--aui-primary)";
    document.body.append(probe);
    const primary = getComputedStyle(probe).color;
    probe.remove();
    return bs.map((b) => {
      const cs = getComputedStyle(b);
      return { text: (b.textContent ?? "").trim(), filled: cs.backgroundColor === primary, bg: cs.backgroundColor, color: cs.color, height: b.getBoundingClientRect().height };
    });
  });

/** No tint: a ground with no alpha, or a grey whose channels lie within a few steps of each other. */
const grey = (rgb: string) => {
  const [r, g, b, a] = (rgb.match(/[\d.]+/g) ?? []).map(Number);
  return a === 0 || Math.max(r, g, b) - Math.min(r, g, b) < 24;
};

/** The card's main choice is its only filled button (none when `main` is null); every other button is a quiet grey, and
 *  every answer is the kit's 34px. */
async function oneMain(card: Locator, main: string | null) {
  const all = await looks(card);
  expect(all.filter((l) => l.filled).map((l) => l.text)).toEqual(main ? [main] : []);
  for (const l of all.filter((x) => !x.filled)) expect(grey(l.bg), `${l.text}: ${l.bg}`).toBe(true);
  const answers = await card.locator(".card-btn").evaluateAll((bs) => bs.map((b) => b.getBoundingClientRect().height));
  for (const h of answers) expect(h).toBeGreaterThanOrEqual(34);
  // no red rail down the card's side (a focused card's calm ring is not inset)
  expect(await card.evaluate((el) => getComputedStyle(el).boxShadow)).not.toContain("inset");
}

const PICTURE =
  "iVBORw0KGgoAAAANSUhEUgAAAEgAAAAcCAIAAABNkG7xAAAAS0lEQVR42u3YsQkAIBAEQesSyzL4go3EIswNxcRnYBuY6OBKRE9ZSQ5bc6QJDAwMDAwM7Ki1eh0YGBhYPpgdAwMDAwMDewjzBH/TBqaVhQ9geFVwAAAAAElFTkSuQmCC";
const HELPED = { id: "pilot:b", name: "Ran Pa Noi", owner: "Noi", role: "helper" };
const OWNED = { id: "pilot:a", name: "Baan Mali", owner: "Fon", role: "owner" };

/** Every open kind of approval the runtime can raise, one per card: its event, the name its picture takes, and its main choice. */
const APPROVALS: { name: string; main: string | null; ev: Record<string, unknown> }[] = [
  { name: "approval", main: "Allow once", ev: { title: "Run shell command", command: "git status --short", choices: ["once", "session", "deny"] } },
  { name: "risky", main: "Allow once", ev: { title: "Run shell command", command: "rm -rf ./build", choices: ["once", "session", "deny"] } },
  {
    name: "subagent-cwd",
    main: "Allow once",
    ev: { title: "Write c.txt", command: "echo gamma > c.txt", choices: ["once", "session", "deny"], cwd: "/home/you/code/web-app/packages/checkout/src/components/payment", subagent: { id: "s-ask", name: "Write gamma to c.txt" } },
  },
  { name: "plan", main: "Allow once", ev: { title: "", command: "", choices: ["once", "deny"], plan: "1. Add a PromptPay QR to the checkout\n2. Run the tests\n3. Open a pull request" } },
  {
    name: "browser-write",
    main: "Allow once",
    ev: {
      title: "Reply to a customer on Shopee",
      command: "On seller.shopee.co.th, the chat with Khun Ploy: type “Your parcel left our shop this morning and should reach you on Tuesday.” into the message box, then press Send.",
      whole: true,
      choices: ["once", "deny"],
    },
  },
  {
    name: "computer",
    main: "Allow once",
    ev: {
      title: "Click button “Pay” in Safari?",
      command: "App: Safari\nWindow: Shopee\nControl: button “Pay”",
      whole: true,
      choices: ["deny", "once"],
      tool: { kind: "other", name: "mcp__manut-computer__click", server: "manut-computer", computer: { act: "click", app: "Safari", window: "Shopee", control: "button “Pay”", picture: PICTURE } },
    },
  },
  { name: "outdated", main: null, ev: { title: "Send on LINE", command: "Send on LINE: “Your order ships tomorrow morning.”", choices: [], outdated: true, shop: OWNED } },
  { name: "shop-helper", main: null, ev: { title: "", command: "Refund ฿120 for order RP-118", choices: [], shop: HELPED, kind: "money", pass_on: true } },
  {
    name: "shop-passed",
    main: "Allow once",
    ev: { title: "", command: "Send on LINE: “We open at nine tomorrow.”", choices: ["once", "deny"], shop: OWNED, kind: "reply", passed_on: { name: "Mint", note: "It looks right to me.", at: 1_795_396_200 } },
  },
];

/** The questions: one with choices its rows answer, one that picks several, one with a field, and several at once. */
const QUESTIONS: { name: string; main: string | null; ev: Record<string, unknown> }[] = [
  { name: "clarify", main: null, ev: { question: "Which environment should I deploy to?", choices: ["staging", "production"] } },
  { name: "clarify-multi", main: "Answer", ev: { question: "Which sections should the release note have?", choices: ["Highlights", "Fixes", "Thanks (Recommended)"], multi_select: true } },
  { name: "clarify-text", main: "Answer", ev: { question: "Which branch name?" } },
  {
    name: "interview",
    main: "Submit",
    ev: {
      question: "Who is the release note for?",
      questions: [
        { qid: "q1", question: "Who is the release note for?", choices: ["Users", "Developers", "Both"] },
        { qid: "q2", question: "Which sections should it have?", choices: ["Highlights", "Fixes", "Thanks"], multi_select: true },
        { qid: "q3", question: "Anything to leave out?" },
      ],
    },
  },
];

/** Raises every open kind in Kami's chat, inside one running turn, each a request the mock does not hold. */
async function raiseAll() {
  await mock("mock.emit", {
    events: [
      { event: "turn.start", bot: "kami" },
      ...APPROVALS.map((a, i) => ({ event: "approval.request", bot: "kami", request_id: `ak-${i}-${a.name}`, ...a.ev })),
      ...QUESTIONS.map((q, i) => ({ event: "clarify.request", bot: "kami", request_id: `aq-${i}-${q.name}`, ...q.ev })),
    ],
  });
}

test.beforeEach(async () => {
  await mock("mock.reset");
});

for (const theme of THEMES) {
  test(`${theme}: every open kind of card has the main choice as its one black button, and no tint`, async ({ page }) => {
    await open(page, theme);
    await raiseAll();
    const tl = page.getByTestId("timeline");
    const approvals = tl.getByTestId("card-approval");
    await expect(approvals).toHaveCount(APPROVALS.length);
    for (const [i, a] of APPROVALS.entries()) {
      const c = approvals.nth(i);
      await c.scrollIntoViewIfNeeded();
      await oneMain(c, a.main);
      await shot(c, theme, a.name);
    }
    // the parts each kind keeps: a command that cannot be undone in the red tag, the folder whole, the shop and who may decide
    const risky = approvals.nth(1);
    await expect(risky.getByTestId("card-risk")).toHaveText("Deletes files and folders");
    await expect(risky).toHaveClass(/\brisky\b/);
    expect(await risky.getByTestId("card-risk").evaluate((el) => getComputedStyle(el).color)).toBe(
      await page.evaluate(() => {
        const d = document.createElement("span");
        d.style.color = "var(--aui-danger)";
        document.body.append(d);
        const v = getComputedStyle(d).color;
        d.remove();
        return v;
      }),
    );
    const cwd = approvals.nth(2).getByTestId("card-cwd");
    await expect(cwd).toHaveText("in /home/you/code/web-app/packages/checkout/src/components/payment");
    expect(await cwd.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
    await expect(approvals.nth(6).getByTestId("card-outdated")).toBeVisible();
    await expect(approvals.nth(7).getByTestId("card-only")).toHaveText("Only Noi can approve money");
    await expect(approvals.nth(8).getByTestId("card-passed")).toContainText("Passed on by Mint");
    // the order of safety: Deny first, as before
    expect(await approvals.nth(0).locator(".card-btn").allInnerTexts()).toEqual(["Deny", "Allow once", "Allow for session"]);

    // a helper writing the note for the owner: Send to Noi is the card's one black button while the note is open
    const helper = approvals.nth(7);
    await helper.getByTestId("card-ask-owner").click();
    await expect(helper.getByTestId("card-pass-note")).toBeFocused();
    await helper.getByTestId("card-pass-note").fill("The jar arrived broken.");
    await oneMain(helper, "Send to Noi");
    await shot(helper, theme, "shop-helper-note");

    const clarifies = tl.locator('[data-testid="card-clarify"], [data-testid="card-interview"]');
    await expect(clarifies).toHaveCount(QUESTIONS.length);
    for (const [i, q] of QUESTIONS.entries()) {
      const c = clarifies.nth(i);
      await c.scrollIntoViewIfNeeded();
      await oneMain(c, q.main);
      await shot(c, theme, q.name);
    }
    // a picked row is grey, never filled black
    const multi = clarifies.nth(1);
    await multi.getByRole("checkbox", { name: /Fixes/ }).click();
    await oneMain(multi, "Answer");
    await shot(multi, theme, "clarify-multi-picked");

    // an answer the runtime did not take says so in red, and the card stays open with its buttons
    const plain = approvals.nth(0);
    await plain.getByRole("button", { name: "Allow once", exact: true }).click();
    await expect(plain.locator(".card-err")).toContainText("Not sent");
    await oneMain(plain, "Allow once");
    await shot(plain, theme, "approval-not-sent");
  });

  test(`${theme}: settled, refused and expired cards are one quiet line, and an Allow's tick is the green of done`, async ({ page }) => {
    await open(page, theme);
    const tl = page.getByTestId("timeline");
    const green = await page.evaluate(() => {
      const d = document.createElement("span");
      d.style.color = "var(--aui-success)";
      document.body.append(d);
      const v = getComputedStyle(d).color;
      d.remove();
      return v;
    });
    await mock("mock.ask", { bot: "kami", kind: "approval" });
    await tl.getByTestId("card-approval").getByRole("button", { name: "Allow once", exact: true }).click();
    const allowed = tl.getByTestId("card-line").filter({ hasText: "Allowed once" });
    await expect(allowed).toBeVisible();
    // the mock asks only between turns: the next ask waits for this turn's end
    await expect(page.getByTestId("stop")).toHaveCount(0);
    expect(await allowed.locator(".line-ic").evaluate((el) => getComputedStyle(el).color)).toBe(green);
    await shot(allowed, theme, "settled-allowed");

    await mock("mock.ask", { bot: "kami", kind: "approval" });
    await tl.getByTestId("card-approval").getByRole("button", { name: "Deny", exact: true }).click();
    const denied = tl.getByTestId("card-line").filter({ hasText: "Denied" });
    await expect(denied).toBeVisible();
    await expect(page.getByTestId("stop")).toHaveCount(0);
    expect(await denied.locator(".line-ic").evaluate((el) => getComputedStyle(el).color)).not.toBe(green);
    await shot(denied, theme, "settled-denied");

    await mock("mock.ask", { bot: "kami", kind: "approval", timeout_ms: 800 });
    const expired = tl.getByTestId("card-line").filter({ hasText: "Timed out" });
    await expect(expired).toBeVisible({ timeout: 6_000 });
    await expect(page.getByTestId("stop")).toHaveCount(0);
    await shot(expired, theme, "expired");

    await mock("mock.ask", { bot: "kami", kind: "clarify" });
    await tl.getByTestId("card-clarify").getByRole("button", { name: "staging" }).click();
    const answered = tl.getByTestId("card-line").filter({ hasText: "Answered: staging" });
    await expect(answered).toBeVisible();
    expect(await answered.locator(".line-ic").evaluate((el) => getComputedStyle(el).color)).toBe(green);
    await shot(answered, theme, "settled-answered");
  });

  test(`${theme}: Needs you is one card a decision with its amber mark, one time, and no black button`, async ({ page }) => {
    await open(page, theme);
    await mock("mock.ask", { bot: "friren", kind: "approval" });
    await mock("mock.ask", { bot: "default", kind: "interview" });
    await page.getByTestId("menu-needs").click();
    const rows = page.getByTestId("needs-row");
    await expect(rows).toHaveCount(2);
    const friren = rows.filter({ hasText: "Friren" });
    await expect(friren.locator(".l1")).toHaveText("Run shell command");
    expect(await friren.locator(".l1").evaluate((el) => getComputedStyle(el).fontSize)).toBe("17px");
    await expect(friren.locator("code.act")).toHaveText("rm -rf build/");
    // one time: since when it waits, and no "how long ago" beside it
    await expect(friren.locator(".need-who")).toHaveText(/^Friren · .*Waiting since \d{2}:\d{2}$/);
    await expect(friren.locator(".when")).toHaveCount(0);
    // the kind is the amber of waiting for a person, a mark and not a button, named with a noun as the Approvals board tags a
    // card (item 85i): a verb on a tag reads as a button
    const tag = friren.locator(".tag");
    await expect(tag).toHaveText("Approval");
    expect(await tag.evaluate((el) => el.closest("button")?.getAttribute("data-testid"))).toBe("needs-open");
    const warn = await page.evaluate(() => {
      const d = document.createElement("span");
      d.style.backgroundColor = "var(--warnbg)";
      document.body.append(d);
      const v = getComputedStyle(d).backgroundColor;
      d.remove();
      return v;
    });
    expect(await tag.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe(warn);
    // nothing is approved here: Look first is each card's one action, quiet
    for (const r of await rows.all()) {
      const ls = await looks(r.locator(".need-acts"));
      expect(ls.map((l) => [l.text, l.filled])).toEqual([["Look first", false]]);
      expect(ls[0].height).toBeGreaterThanOrEqual(34);
    }
    await expect(page.getByTestId("needs-approve")).toHaveCount(0);
    await shot(page.getByTestId("page-needs"), theme, "needs-you");
    // a press anywhere on the card opens its ask, as the row did
    const box = (await friren.boundingBox())!;
    await page.mouse.click(box.x + box.width - 24, box.y + box.height - 12);
    await chatOpen(page, "friren");
    await expect(page.getByTestId("timeline").getByTestId("card-approval")).toBeFocused();
  });

  test(`${theme}: Home's Needs you is the board's compact rows, Approve the one black button where Home may settle the ask`, async ({ page }) => {
    await open(page, theme);
    // a plain command Home may approve, and a risky one it may not (its card in the chat is the one place for that)
    await mock("mock.emit", {
      events: [
        { event: "turn.start", bot: "omh-tui" },
        { event: "approval.request", bot: "omh-tui", request_id: "home-plain", title: "Run shell command", command: "git status --short", choices: ["once", "deny"] },
      ],
    });
    await mock("mock.ask", { bot: "friren", kind: "approval" });
    await page.getByTestId("menu-home").click();
    const rows = page.getByTestId("home-need");
    await expect(rows).toHaveCount(2);
    const plain = rows.filter({ hasText: "git status --short" });
    const risky = rows.filter({ hasText: "rm -rf build/" });
    expect((await looks(plain)).map((l) => [l.text, l.filled])).toEqual([
      ["Approve", true],
      ["Look first", false],
    ]);
    expect((await looks(risky)).map((l) => [l.text, l.filled])).toEqual([["Look first", false]]);
    for (const l of [...(await looks(plain)), ...(await looks(risky))]) expect(l.height).toBeGreaterThanOrEqual(34);
    expect(await plain.evaluate((el) => el.getBoundingClientRect().height)).toBeGreaterThanOrEqual(44);
    await shot(page.getByTestId("home-needs"), theme, "home-needs");
  });

  test(`${theme}: Kit's card has Allow once as its one black button, and No still comes first`, async ({ page }) => {
    await page.addInitScript((t) => {
      localStorage.setItem("manut.theme", t);
      localStorage.removeItem("manut.kit.projects");
    }, theme);
    await page.goto("/");
    await page.getByTestId("menu-code").click();
    await page.evaluate(async (root) => {
      const s = (window as any).__manutSessions;
      await s.loadAgents();
      const id = s.draft("claude");
      s.setDraft(id, { cwd: root });
      await s.start(id, "/kit install");
    }, "/home/you/code/baanmali-preorder");
    const c = page.getByTestId("card-approval");
    await expect(c.locator("button")).toHaveText(["No", "Allow once", "Always allow in this project"]);
    await expect(page.getByTestId("card-kit-say")).toHaveText("Adds 1 package to the project.");
    await oneMain(c, "Allow once");
    await shot(c, theme, "kit");
  });
}

test("keys: Deny is the first stop of Tab, and Enter or Escape on the card answers nothing", async ({ page }) => {
  await open(page, "light");
  await mock("mock.ask", { bot: "friren", kind: "approval" });
  await openChat(page, "friren");
  const c = page.getByTestId("timeline").getByTestId("card-approval");
  await expect(c).toBeVisible();
  await c.focus();
  await page.keyboard.press("Enter");
  await page.waitForTimeout(300);
  expect(await calls("approval.respond")).toEqual([]);
  await expect(c).toBeVisible();
  // Tab walks the answers in their order, the safe one first
  const focused = () => page.evaluate(() => (document.activeElement?.textContent ?? "").trim());
  await page.keyboard.press("Tab");
  expect(await focused()).toBe("Deny");
  await page.keyboard.press("Tab");
  expect(await focused()).toBe("Allow once");
  await page.keyboard.press("Tab");
  expect(await focused()).toBe("Allow for session");
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Shift+Tab");
  expect(await focused()).toBe("Deny");
  // Escape is the app's Stop, as it was: it may stop the turn, and it never answers the ask
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);
  expect(await calls("approval.respond")).toEqual([]);
  // Enter on a focused answer is that answer, as a click is
  await mock("mock.ask", { bot: "friren", kind: "approval" });
  const next = page.getByTestId("timeline").getByTestId("card-approval");
  await next.getByRole("button", { name: "Deny", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect.poll(async () => (await calls("approval.respond")).map((x: any) => x.params.choice)).toEqual(["deny"]);
});
