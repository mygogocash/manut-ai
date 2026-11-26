// The preview of a lane (src/code/LanePreview.tsx, previewStore.ts; the design canvas's Code board, "What to look at", Preview), walked
// in a browser. A plain browser has no shell, so the mock host (src/code/previewHost.ts) runs a fake preview: it prints a dev server's
// lines and its address, lists itself with what keeps running, and records every call in `window.__manutPreviewCalls`; a spec says what
// a folder holds and how the run goes through `window.__manutMockPreview`. The lane runs as a chat started through the sessions store,
// as lane-pane.spec.ts starts it, in a project the mock calls a repository, so it works in a folder of its own under ~/.manut/lanes.
import { expect, test, type Page } from "@playwright/test";
import { openCode } from "./start";

const ROOT = "/home/you/code/baanmali-preorder";
/** A folder the mock does not call a repository: a session there works in the developer's own folder. */
const PLAIN = "/home/you/code/notes";
const URL = "http://localhost:5173/";

type Call = { op: string; dir?: string; argv?: string[]; env?: [string, string][]; url?: string; id?: number };

/** A Claude Code session in `root`, running as a chat, started with `first`. */
async function startIn(page: Page, first: string, root = ROOT): Promise<string> {
  return page.evaluate(
    async ([folder, text]) => {
      const s = (window as any).__manutSessions;
      await s.loadAgents();
      const id = s.draft("claude");
      s.setDraft(id, { cwd: folder });
      await s.start(id, text);
      return id as string;
    },
    [root, first],
  );
}

/** The session fills the main column, as a notification would open it, without going through its row in the Lanes band. */
const openSession = (page: Page, id: string) =>
  page.evaluate(async (i) => {
    const store = (await import(/* @vite-ignore */ "/src/state/store.ts" as string)) as { getStore(): { actions: { openSession(id: string): void } } };
    store.getStore().actions.openSession(i);
  }, id);
const calls = (page: Page) => page.evaluate(() => ((window as any).__manutPreviewCalls ?? []) as Call[]);
const ops = async (page: Page) => (await calls(page)).map((c) => c.op);
/** The folder the mock shell made for the lane (its record, as lane.rs writes one). */
const laneDir = (page: Page) => page.evaluate(() => ((window as any).__manutLanes ?? [])[0]?.dir as string | undefined);
const control = (page: Page, o: Record<string, unknown>) => page.evaluate((v) => Object.assign((window as any).__manutMockPreview, v), o);

/** A lane open beside its chat on Preview, with the command it would run read. */
async function previewOf(page: Page, first = "Add a PromptPay QR to the checkout.", root = ROOT): Promise<string> {
  const id = await startIn(page, first, root);
  await openSession(page, id);
  await page.getByTestId("lane-chip-preview").click();
  await expect(page.getByTestId("lane-chip-preview")).toHaveAttribute("aria-pressed", "true");
  return id;
}

/** Nothing on the page is wider than the window, and every part of the preview is inside it. */
async function fits(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  const width = await page.evaluate(() => window.innerWidth);
  for (const box of await page.locator('[data-testid^="lane-preview"]').all()) {
    const b = await box.boundingBox();
    if (b) expect(b.x + b.width, (await box.getAttribute("data-testid")) ?? "").toBeLessThanOrEqual(width + 1);
  }
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript((root) => {
    localStorage.removeItem("manut.kit.projects");
    (window as any).__manutBranches = { [root]: "main" };
    (window as any).__manutMockTaken = [];
    // the fake preview's settings, there before the page reads any: a start that takes long enough to be seen starting
    (window as any).__manutMockPreview = { projects: {}, mode: "serve", delay: 1_200, readError: null, startWait: 60_000 };
  }, ROOT);
  await page.goto("/");
  // the app is up once its menu answers: a session started before that can miss its start (running.spec.ts waits the same way)
  await openCode(page);
});

test("names the command first; Start runs it in the lane's own folder on samples; it is Running at its address with Open and Stop", async ({ page }) => {
  await previewOf(page);
  await expect(page.getByTestId("lane-preview")).toHaveAttribute("data-phase", "idle");
  await expect(page.getByTestId("lane-preview")).toContainText("Start runs this in the lane's own folder, with a sample for each secret:");
  await expect(page.getByTestId("lane-preview-command")).toHaveText("$ pnpm run dev");
  // the script's name says nothing of what it runs: its text from package.json is under it
  await expect(page.getByTestId("lane-preview-script")).toHaveText("The dev script runs: vite");
  await expect(page.getByTestId("lane-preview-start")).toHaveText("Start");
  // the folder's .env.example names the shop ID and a Stripe key: their names, never a value
  await expect(page.getByTestId("lane-preview-samples")).toHaveText("Secrets run on samples: PROMPTPAY_SHOP_ID and STRIPE_SECRET_KEY.");
  // nothing runs before Start
  expect(await ops(page)).not.toContain("start");

  await page.getByTestId("lane-preview-start").click();
  await expect(page.getByTestId("lane-preview-state")).toHaveText("Starting…");
  await expect(page.getByTestId("lane-preview-state")).toHaveText(`Running at ${URL}`);
  const dir = await laneDir(page);
  expect(dir).toMatch(/^\/home\/you\/\.manut\/lanes\/baanmali-preorder\//);
  const start = (await calls(page)).find((c) => c.op === "start")!;
  // the folder read again right before the start, the command as words, in the lane's own folder, and each secret on its sample
  expect((await ops(page)).slice(-2)).toEqual(["read", "start"]);
  expect(start).toMatchObject({ dir, argv: ["pnpm", "run", "dev"] });
  expect(start.env).toEqual([
    ["PROMPTPAY_SHOP_ID", "0000000000"],
    ["STRIPE_SECRET_KEY", "sample-value"],
  ]);
  // no sample's value is on the page, and the one page of the project drawn in the app is its preview's own address, in the
  // pane's sandboxed frame (preview-frame.spec.ts walks it)
  const text = await page.evaluate(() => document.body.innerText);
  expect(text).not.toContain("0000000000");
  expect(text).not.toContain("sample-value");
  await expect(page.locator("webview")).toHaveCount(0);
  expect(await page.locator("iframe").evaluateAll((els) => els.map((e) => [(e as HTMLIFrameElement).src, e.getAttribute("sandbox")]))).toEqual([[URL, "allow-scripts allow-same-origin allow-forms"]]);

  await page.getByTestId("lane-preview-open").click();
  await expect.poll(async () => (await calls(page)).filter((c) => c.op === "open")).toEqual([{ op: "open", url: URL }]);

  await page.getByTestId("lane-preview-stop").click();
  await expect(page.getByTestId("lane-preview-state")).toHaveText("Stopped.");
  expect(await ops(page)).toContain("stop");
  // and again, once it has ended
  await expect(page.getByTestId("lane-preview-start")).toHaveText("Start again");
  await page.getByTestId("lane-preview-start").click();
  await expect(page.getByTestId("lane-preview-state")).toHaveText(`Running at ${URL}`);
  await page.getByTestId("lane-preview-stop").click();
  await expect(page.getByTestId("lane-preview-state")).toHaveText("Stopped.");
});

test("What keeps running lists the preview as a Preview, with its port and its lane, and its Stop stops the preview", async ({ page }) => {
  const id = await previewOf(page);
  await page.getByTestId("lane-preview-start").click();
  await expect(page.getByTestId("lane-preview-state")).toHaveText(`Running at ${URL}`);
  await openCode(page);
  const row = page.getByTestId("running-row");
  // a command is listed once it has run a few seconds
  await expect(row).toHaveCount(1, { timeout: 15_000 });
  await expect(row.getByTestId("running-tag")).toHaveText("Preview");
  await expect(row.getByTestId("running-command")).toHaveText("pnpm run dev");
  await expect(row.getByTestId("running-meta")).toContainText("port 5173");
  await expect(row.getByTestId("running-lane")).toBeVisible();
  await row.getByTestId("running-stop").click();
  await expect(row).toHaveCount(0);
  // the preview was stopped, not ended: its pane says so
  await openSession(page, id);
  await page.getByTestId("lane-chip-preview").click();
  await expect(page.getByTestId("lane-preview-state")).toHaveText("Stopped.");
});

test("one that ends by itself says its exit code and its last lines, with the key in them hidden, and offers Start again", async ({ page }) => {
  await previewOf(page);
  await control(page, { mode: "crash" });
  await page.getByTestId("lane-preview-start").click();
  await expect(page.getByTestId("lane-preview-state")).toHaveText("It ended by itself (exit 1).");
  const lines = page.getByTestId("lane-preview-lines");
  await expect(lines).toContainText("Error: Cannot find module 'vite'");
  await expect(lines).toContainText("••••");
  expect(await page.evaluate(() => document.body.innerText.includes("sk-FAKE"))).toBe(false);
  await expect(page.getByTestId("lane-preview-start")).toHaveText("Start again");
});

test("one that prints no address in its first minute says so, with its last lines and Stop", async ({ page }) => {
  await previewOf(page);
  // the minute is shortened for the spec
  await control(page, { mode: "quiet", startWait: 1_500 });
  await page.getByTestId("lane-preview-start").click();
  await expect(page.getByTestId("lane-preview-state")).toHaveText("Starting…");
  await expect(page.getByTestId("lane-preview-state")).toHaveText("It is running, but has not printed an address the app can open.", { timeout: 10_000 });
  await expect(page.getByTestId("lane-preview-lines")).toContainText("Still compiling…");
  await expect(page.getByTestId("lane-preview-open")).toHaveCount(0);
  await page.getByTestId("lane-preview-stop").click();
  await expect(page.getByTestId("lane-preview-state")).toHaveText("Stopped.");
});

test("one the shell will not start says why, and Start again tries again", async ({ page }) => {
  await previewOf(page);
  await control(page, { mode: "refuse:missing:pnpm" });
  await page.getByTestId("lane-preview-start").click();
  await expect(page.getByTestId("lane-preview-state")).toHaveText("Could not start: pnpm is not installed on this computer.");
  await control(page, { mode: "serve" });
  await page.getByTestId("lane-preview-start").click();
  await expect(page.getByTestId("lane-preview-state")).toHaveText(`Running at ${URL}`);
});

test("says in plain words why there is no command, and offers no Start", async ({ page }) => {
  await page.evaluate(() => {
    // every lane folder of this spec holds the same: scripts that publish, then none at all
    (window as any).__manutMockPreview.projects = new Proxy({}, { get: () => ({ packageJson: JSON.stringify({ scripts: { dev: "vite", predev: "vercel deploy --prod" } }), files: ["package.json"], envExample: null }) });
  });
  await previewOf(page);
  await expect(page.getByTestId("lane-preview-none")).toHaveText("Its start scripts look like they publish or deploy, so the app does not run them.");
  await expect(page.getByTestId("lane-preview-start")).toHaveCount(0);
  await page.evaluate(() => {
    (window as any).__manutMockPreview.projects = new Proxy({}, { get: () => ({ packageJson: null, files: ["index.html"], envExample: null }) });
  });
  // looked at again, the folder is read again
  await page.getByTestId("lane-chip-diff").click();
  await page.getByTestId("lane-chip-preview").click();
  await expect(page.getByTestId("lane-preview-none")).toHaveText("This folder has no package.json, so there is nothing to start.");
  await expect(page.getByTestId("lane-preview-start")).toHaveCount(0);
  expect(await ops(page)).not.toContain("start");
});

test("a session that works in the developer's own folder gets no Start, and the preview says why", async ({ page }) => {
  await previewOf(page, "Tidy the notes.", PLAIN);
  await expect(page.getByTestId("lane-preview-only")).toHaveText(
    "The preview runs only in a lane's own folder. This session works in your own folder, which can hold your real .env.local, so nothing is started here.",
  );
  await expect(page.getByTestId("lane-preview-start")).toHaveCount(0);
  // its folder is not even read
  expect(await ops(page)).toEqual([]);
});

test("closing the lane's session stops its preview", async ({ page }) => {
  const id = await previewOf(page);
  await page.getByTestId("lane-preview-start").click();
  await expect(page.getByTestId("lane-preview-state")).toHaveText(`Running at ${URL}`);
  const started = (await calls(page)).find((c) => c.op === "start")!;
  await page.evaluate((i) => (window as any).__manutSessions.close(i), id);
  await expect.poll(async () => (await calls(page)).filter((c) => c.op === "stop")).toEqual([{ op: "stop", id: started.id }]);
});

for (const theme of ["light", "dark"] as const) {
  test(`in the ${theme} theme, wide and narrow, it is drawn whole and nothing is wider than the window`, async ({ page }) => {
    await page.evaluate((t) => localStorage.setItem("manut.theme", t), theme);
    await page.reload();
    await openCode(page);
    await previewOf(page);
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    await fits(page);
    await page.getByTestId("lane-preview-start").click();
    await expect(page.getByTestId("lane-preview-state")).toHaveText(`Running at ${URL}`);
    await expect(page.getByTestId("lane-preview-open")).toBeVisible();
    await fits(page);
    // Open stands out from Stop as the canvas's dark button does, in either theme
    const bg = (id: string) => page.getByTestId(id).evaluate((e) => getComputedStyle(e).backgroundColor);
    expect(await bg("lane-preview-open")).not.toBe(await bg("lane-preview-stop"));

    await page.setViewportSize({ width: 900, height: 760 });
    // under the chat now, and still whole
    const chat = await page.getByTestId("session-chat").boundingBox();
    const pane = await page.getByTestId("lane-pane").boundingBox();
    expect(chat && pane && pane.y >= chat.y + chat.height - 2).toBe(true);
    await page.getByTestId("lane-preview-state").scrollIntoViewIfNeeded();
    await expect(page.getByTestId("lane-preview-state")).toBeVisible();
    await fits(page);
    await page.getByTestId("lane-preview-stop").click();
    await expect(page.getByTestId("lane-preview-state")).toHaveText("Stopped.");
    await fits(page);
  });
}

for (const [lang, start, running, stopped] of [
  ["ko", "시작", `${URL}에서 실행 중`, "멈췄어요."],
  ["ja", "開始", `${URL} で実行中`, "停止しました。"],
  ["zh", "开始", `正在 ${URL} 运行`, "已停止。"],
] as const) {
  test(`speaks ${lang}`, async ({ page }) => {
    await page.evaluate((l) => localStorage.setItem("manut.lang", l), lang);
    await page.reload();
    await openCode(page);
    await previewOf(page);
    await expect(page.getByTestId("lane-preview-start")).toHaveText(start);
    await page.getByTestId("lane-preview-start").click();
    await expect(page.getByTestId("lane-preview-state")).toHaveText(running);
    await fits(page);
    await page.getByTestId("lane-preview-stop").click();
    await expect(page.getByTestId("lane-preview-state")).toHaveText(stopped);
  });
}
