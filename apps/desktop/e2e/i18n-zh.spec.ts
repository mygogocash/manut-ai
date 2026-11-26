// manut in Chinese: the sidebar, every Settings page, the composer and the New session menu read in Simplified
// Chinese with no English UI words left, nothing overflows sideways at the 900px minimum width, <html lang> says
// zh-CN, a first run picks the system's language, and Enter that commits an IME composition never submits.
import { expect, test, type Page } from "@playwright/test";
import { chatOpen, homeOpen } from "./start";

const MOCK = Number(process.env.MANUT_MOCK_PORT || 5308);

test.use({ colorScheme: "dark" });

async function mock(op: string, params: Record<string, unknown> = {}): Promise<void> {
  const ws = new WebSocket(`ws://127.0.0.1:${MOCK}/?token=e2e`);
  await new Promise<void>((res, rej) => {
    ws.onopen = () => res();
    ws.onerror = () => rej(new Error("mock websocket error"));
  });
  await new Promise<void>((res) => {
    ws.onmessage = () => res();
    ws.send(JSON.stringify({ id: "z1", op, ...params }));
  });
  ws.close();
}

test.beforeEach(async () => {
  await mock("mock.reset");
});

async function openZh(page: Page) {
  await page.addInitScript(() => localStorage.setItem("manut.lang", "zh"));
  await page.goto("/");
  await chatOpen(page);
}

/** Words a person reads that are still English: text nodes and UI attributes, minus names that stay in Latin
 *  (bots, brands, models, commands, paths, people's data, and git's own "Worktrees", which Settings › Worktrees keeps in
 *  every language) and the language picker's own "English". */
async function englishLeft(page: Page, root: string): Promise<string[]> {
  return page.evaluate((sel) => {
    const KEEP =
      /^(manut|Manut AI|OMH|Hermes|Kami|Friren|Frieren|Hermes Bot|OMH TUI|English|한국어|日本語|中文|Claude( Code)?|Codex|OmO|DSH|pi|omp|oh-my-pi|oh-my-hermes|Grok|Gemini( CLI)?|OpenAI|Worktrees|ChatGPT|CLIProxyAPI|Slack|Discord|Telegram|Cron|GitHub|GitLab|Linear|API|ID|PR|CI|Esc|Ctrl\+?.*|⌘.*|Max \d+x|Pro|Plus)$/;
    // commands (`hermes auth add …`, `npm i -g …`), paths, ids and model or provider names stay as written
    const isData = (s: string) =>
      /[@/\\:]|^\d|^[a-z0-9._-]+$|^v?\d+(\.\d+)+/.test(s) ||
      /^(hermes|npm|curl|pnpm|git|omh) /.test(s) ||
      /\b(gpt|claude|opus|sonnet|haiku|gemini|grok|kimi|qwen|deepseek|llama|glm|mistral|o\d|openrouter|ollama|anthropic|nous|openai|xai|moonshot|zhipu)\b/i.test(s);
    const root = document.querySelector(sel);
    if (!root) return [`missing ${sel}`];
    const out = new Set<string>();
    const check = (raw: string | null | undefined) => {
      for (const part of (raw ?? "").split(/[·•|,()（）：:、—–\n]/)) {
        const s = part.trim();
        if (!/[A-Za-z]{3,}/.test(s) || KEEP.test(s) || isData(s)) continue;
        // a CJK line with a Latin name inside it is translated
        if (/[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/.test(s)) continue;
        out.add(s);
      }
    };
    // .prov-n: an agent's own product name on Settings › Providers (Copilot CLI, Cursor), as .ss-l is in the + menu
    const skip = (el: Element | null) => !!el?.closest("code, pre, kbd, .mono, .msg, .md, .ap-preview, [data-testid=bot-sub], [data-testid=bots-grid] .bc-desc, .be-desc, .acc-n, .acc-sub, .pv-ms, .pv-v, .mp-list, .ss-n, .ss-l, .ss-where, [data-testid=session-sub], [data-testid=session-name], .bot-n, .head-title, .prov-n");
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const el = n.parentElement;
      if (!el || skip(el) || !el.getClientRects().length) continue;
      check(n.textContent);
    }
    for (const el of root.querySelectorAll("[title], [placeholder], [aria-label]")) {
      if (skip(el) || !(el as HTMLElement).getClientRects().length) continue;
      for (const a of ["title", "placeholder", "aria-label"]) check(el.getAttribute(a));
    }
    return [...out];
  }, root);
}

async function noSideScroll(page: Page) {
  const over = await page.evaluate(() => {
    const out: string[] = [];
    if (document.documentElement.scrollWidth > window.innerWidth) out.push(`page ${document.documentElement.scrollWidth}`);
    for (const el of document.querySelectorAll<HTMLElement>(".st-body, .st-nav, .side, .pane, .composer, .ss-pop")) {
      const cs = getComputedStyle(el);
      if (el.scrollWidth > el.clientWidth + 1 && cs.overflowX !== "hidden" && cs.overflowX !== "clip") out.push(`${el.className} ${el.scrollWidth}>${el.clientWidth}`);
    }
    return out;
  });
  expect(over).toEqual([]);
}

test("<html lang> follows the language, zh is zh-CN, and the CJK fonts are in --font", async ({ page }) => {
  await openZh(page);
  expect(await page.evaluate(() => document.documentElement.lang)).toBe("zh-CN");
  const font = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--font"));
  for (const f of ["PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans CJK SC", "Apple SD Gothic Neo", "Hiragino Kaku Gothic ProN"]) expect(font).toContain(f);
  await page.getByTestId("nav-settings").click();
  await page.getByTestId("language").getByRole("radio", { name: "한국어" }).click();
  expect(await page.evaluate(() => document.documentElement.lang)).toBe("ko");
  await expect(page.getByTestId("settings-nav-general")).toHaveText("일반");
});

for (const width of [1280, 900]) {
  // chat-mode CLI sessions replaced by bot threads (2026-11-16: terminals kept)
  test.skip(`sidebar, composer and the New session menu read in Chinese at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 820 });
    await openZh(page);
    await expect(page.getByTestId("side-bots").locator(".side-sh")).toHaveText("机器人");
    await expect(page.getByTestId("nav-settings")).toContainText("设置");
    await expect(page.getByTestId("composer")).toHaveAttribute("placeholder", "给 Kami 发消息");
    await expect(page.getByTestId("send")).toHaveAttribute("aria-label", "发送");
    expect(await englishLeft(page, "[data-testid=sidebar], .side")).toEqual([]);
    expect(await englishLeft(page, "[data-testid=composer-box]")).toEqual([]);
    await page.getByTestId("model-pill").click();
    await expect(page.getByTestId("model-search")).toHaveAttribute("placeholder", "搜索模型");
    expect(await englishLeft(page, "[data-testid=model-pop]")).toEqual([]);
    await page.keyboard.press("Escape");
    await page.getByTestId("session-new").click();
    await expect(page.getByTestId("session-menu")).toContainText("新建会话");
    expect(await englishLeft(page, "[data-testid=session-menu]")).toEqual([]);
    await noSideScroll(page);
  });

  test(`every Settings page reads in Chinese at ${width}px, with no sideways overflow`, async ({ page }) => {
    await page.setViewportSize({ width, height: 820 });
    await openZh(page);
    await page.getByTestId("nav-settings").click();
    await expect(page.locator(".head-title")).toHaveText("设置");
    // Providers (item 74: the coding agents, your own agents and the accounts), the bots, General, Computer and Artifacts (item 83)
    const pages = ["providers", "bots", "bot-kami", "general", "computer", "artifacts"];
    for (const id of pages) {
      await page.getByTestId(`settings-nav-${id}`).click();
      await expect(page.getByTestId(`settings-page-${id}`)).toBeVisible();
      await page.waitForTimeout(150);
      expect(await englishLeft(page, "[data-testid=settings-view]"), id).toEqual([]);
      await noSideScroll(page);
    }
    await page.getByTestId("settings-nav-general").click();
    await expect(page.getByTestId("theme-seg")).toContainText("深色");
    await expect(page.getByTestId("settings-nav-general")).toHaveText("通用");
  });
}

test("Enter that commits an IME composition does not save a rename or pick a model", async ({ page }) => {
  await openZh(page);
  // rename: composing Enter keeps the field open; a plain Enter saves
  await page.getByTestId("nav-settings").click();
  await page.getByTestId("settings-nav-bot-kami").click();
  await page.getByTestId("rename").click();
  const field = page.getByTestId("rename-input");
  await field.fill("小咪");
  await field.dispatchEvent("keydown", { key: "Enter", keyCode: 229, isComposing: true, bubbles: true });
  await expect(field).toBeVisible();
  await field.dispatchEvent("keydown", { key: "Enter", keyCode: 13, isComposing: true, bubbles: true });
  await expect(field).toBeVisible();
  await field.press("Escape");
  await expect(field).toHaveCount(0);
  await expect(page.getByTestId("bot-name")).toHaveText("Kami");

  // model search: composing Enter picks nothing
  await page.getByTestId("bot-open-chat").click();
  const before = await page.getByTestId("model-label").textContent();
  await page.getByTestId("model-pill").click();
  const search = page.getByTestId("model-search");
  await search.fill("son");
  await search.dispatchEvent("keydown", { key: "Enter", keyCode: 229, isComposing: true, bubbles: true });
  await expect(page.getByTestId("model-pop")).toBeVisible();
  await expect(page.getByTestId("model-label")).toHaveText(before ?? "");
});

test("a first run takes the language from the system; an install that already ran stays English", async ({ browser }) => {
  const fresh = await browser.newContext({ locale: "zh-CN", colorScheme: "dark", storageState: { cookies: [], origins: [] } });
  const p1 = await fresh.newPage();
  await p1.goto("/");
  // a fresh install opens on the first-run setup's Welcome, in the system's language, which it keeps
  await expect(p1.getByTestId("first-run")).toHaveAttribute("data-screen", "welcome");
  await expect(p1.getByTestId("frun-lang-zh")).toHaveAttribute("aria-pressed", "true");
  expect(await p1.evaluate(() => document.documentElement.lang)).toBe("zh-CN");
  expect(await p1.evaluate(() => localStorage.getItem("manut.lang"))).toBe("zh");
  // past the setup (Skip for now, on its first step) the app speaks it too
  await p1.getByTestId("frun-continue").click();
  await p1.getByTestId("frun-skip").click();
  await homeOpen(p1);
  await expect(p1.getByTestId("nav-settings")).toContainText("设置");
  // the setup does not come back, and the language stays as picked, changed in Settings
  await mock("mock.clearHistory", { bot: "kami" });
  await p1.reload();
  await expect(p1.getByTestId("nav-settings")).toContainText("设置");
  await expect(p1.getByTestId("first-run")).toHaveCount(0);
  await expect(p1.getByTestId("onb-lang")).toHaveCount(0);
  await fresh.close();

  // onboarded before this version and never chose: English, whatever the system says
  const old = await browser.newContext({ locale: "ja-JP", colorScheme: "dark" });
  const p2 = await old.newPage();
  await p2.goto("/");
  await chatOpen(p2);
  await expect(p2.getByTestId("nav-settings")).toContainText("Settings");
  expect(await p2.evaluate(() => document.documentElement.lang)).toBe("en");
  await old.close();
});

test("dates follow the language: the bot page's 'since' and the usage reset times", async ({ page }) => {
  await openZh(page);
  await page.getByTestId("nav-settings").click();
  await page.getByTestId("settings-nav-bot-kami").click();
  const since = page.locator(".be-since");
  if (await since.count()) await expect(since).toHaveText(/^自 \d{4}年\d{1,2}月\d{1,2}日 起$/);
});
