// Tasks › Pull requests (item 100), against the mock bridge and the mock hosts (window.__manutTasks for the lists,
// window.__manutPullMerge for the Merge ask). Two projects, each a clone of one repository: a GitHub one and a GitLab one.
// 1. the list: every project's open requests under bands in readiness order, read once per repository;
// 2. a row opens the request in the app: title, description as plain text, checks, files and counts, Open on GitHub;
// 3. Merge goes through the lane's ask: only the methods the repository allows, the ask naming the repository, the branch and
//    the message, settled once, after which the list reads again;
// 4. a request that cannot merge says why and asks nothing, and a fork's request offers no Merge.
// Shots (MANUT_SHOTS=<dir>): the list, the detail and the ask, light and dark, at 1280 and 900.
import { expect, test, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { openCode } from "./start";

const MOCK = Number(process.env.MANUT_MOCK_PORT || 5308);
const SHOTS = process.env.MANUT_SHOTS || "";
const SITE = "/home/you/code/baanmali-site";
const APP = "/home/you/code/baanmali-app";

async function mock(op: string, params: Record<string, unknown> = {}): Promise<any> {
  const ws = new WebSocket(`ws://127.0.0.1:${MOCK}/?token=e2e`);
  await new Promise<void>((res, rej) => {
    ws.onopen = () => res();
    ws.onerror = () => rej(new Error("mock websocket error"));
  });
  const reply = await new Promise<any>((res) => {
    ws.onmessage = (m) => {
      const msg = JSON.parse(String(m.data));
      if (msg.id === "x1") res(msg);
    };
    ws.send(JSON.stringify({ id: "x1", op, ...params }));
  });
  ws.close();
  return reply.result;
}

const now = () => Math.floor(Date.now() / 1000);
const H = 3600;
function pull(number: number, title: string, over: Record<string, unknown> = {}) {
  return {
    number,
    title,
    state: "open",
    url: `https://github.com/baanmali/site/pull/${number}`,
    labels: [],
    author: "noi",
    created: now() - 30 * H,
    updated: now() - 2 * H,
    checks: { passed: 3, failed: 0, pending: 0, total: 3 },
    head: `change/${number}`,
    same: true,
    from: "baanmali/site",
    review: "",
    conflict: false,
    base: "main",
    ...over,
  };
}

function data() {
  return {
    status: { github: { installed: true, signed_in: true }, gitlab: { installed: true, signed_in: true } },
    remotes: { [SITE]: { source: "github", repo: "baanmali/site" }, [APP]: { source: "gitlab", repo: "baanmali/shop/app" } },
    boards: {
      "github:baanmali/site": [
        pull(41, "Make the QR code bigger on phones", { review: "approved", updated: now() - 3 * H }),
        pull(42, "Read the order total from the cart", { checks: { passed: 2, failed: 0, pending: 1, total: 3 }, updated: now() - H }),
        pull(43, "New delivery zones for Chiang Mai", { review: "changes", author: "fon" }),
        pull(44, "Try a darker header", { state: "draft", checks: { passed: 1, failed: 0, pending: 0, total: 1 } }),
        pull(46, "Fix a typo on the about page", { same: false, from: "stranger/site", head: "fix/typo", author: "stranger", checks: { passed: 0, failed: 1, pending: 0, total: 1 } }),
      ],
      "gitlab:baanmali/shop/app": [pull(9, "Pre-order page for the new menu", { url: "https://gitlab.com/baanmali/shop/app/-/merge_requests/9", review: "required", checks: { passed: 0, failed: 0, pending: 0, total: 0 } })],
    },
    pullDetails: {
      "github:baanmali/site:41": {
        body: "Makes the QR code 30% bigger on screens under 400px wide.\n\n- **Measured** on two phones\n- <b>Nothing</b> else changes",
        checks: [
          { name: "build", state: "passed", url: "" },
          { name: "test", state: "passed", url: "" },
          { name: "lint", state: "passed", url: "" },
        ],
        files: [
          { path: "src/checkout/qr.tsx", additions: 12, deletions: 3 },
          { path: "src/checkout/qr.test.tsx", additions: 20, deletions: 0 },
        ],
        additions: 32,
        deletions: 3,
        changed: 2,
      },
    },
    methods: { "github:baanmali/site": { merge: false, squash: true, rebase: false, read: true } },
  };
}

async function setup(page: Page, theme: "dark" | "light" = "light", over: Record<string, unknown> = {}) {
  // what the shell's ask would name for #41: its own title (the mock answers from this, as the shell reads the request)
  const merge = { "github:baanmali/site:41": { title: "Make the QR code bigger on phones" }, ...over };
  await page.addInitScript(
    ([theme, d, m, site, app]) => {
      localStorage.setItem("manut.theme", theme as string);
      localStorage.removeItem("manut.tasks");
      const w = window as unknown as Record<string, unknown> & { __opened: string[] };
      w.__manutTasks = d;
      w.__manutPullMerge = m;
      // two projects the person has: the app made a lane from each (its folder is still kept), so the Code page lists both
      w.__manutLanes = [
        { worktree: `${site}-lanes/qr`, dir: `${site}-lanes/qr`, branch: "kit/qr", base: "main", project: site, made: 1 },
        { worktree: `${app}-lanes/menu`, dir: `${app}-lanes/menu`, branch: "kit/menu", base: "main", project: app, made: 1 },
      ];
      w.__opened = [];
      window.open = ((u: string) => {
        w.__opened.push(String(u));
        return null;
      }) as typeof window.open;
    },
    [theme, data(), merge, SITE, APP] as const,
  );
  await page.goto("/");
}

async function openPulls(page: Page) {
  await openCode(page);
  await page.getByTestId("tasks-open").click();
  await expect(page.getByTestId("tasks-page")).toBeVisible();
  await page.getByTestId("tasks-scope-pulls").click();
  await expect(page.getByTestId("prs")).toBeVisible();
  await expect(page.getByTestId("prs-row")).toHaveCount(6);
}

const row = (page: Page, key: string) => page.locator(`[data-testid="prs-row"][data-pull="${key}"]`);
const calls = (page: Page, name: string) => page.evaluate((n) => (((window as any)[n] ?? []) as any[]), name);

async function shot(page: Page, name: string) {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  await page.waitForTimeout(250);
  await page.screenshot({ path: join(SHOTS, `${name}.png`), animations: "disabled", caret: "initial" });
}

test.beforeEach(async () => {
  await mock("mock.reset");
});

test("lists every project's open requests under bands, readiest first, reading each repository once", async ({ page }) => {
  await setup(page);
  await openPulls(page);
  const bands = await page.locator('[data-testid^="prs-group-"]').evaluateAll((els) => els.map((e) => e.getAttribute("data-testid")));
  expect(bands).toEqual(["prs-group-ready", "prs-group-checks", "prs-group-review", "prs-group-changes", "prs-group-failing", "prs-group-draft"]);
  const order = await page.getByTestId("prs-row").evaluateAll((els) => els.map((e) => e.getAttribute("data-pull")));
  expect(order).toEqual(["github:baanmali/site:41", "github:baanmali/site:42", "gitlab:baanmali/shop/app:9", "github:baanmali/site:43", "github:baanmali/site:46", "github:baanmali/site:44"]);
  await expect(row(page, "github:baanmali/site:41")).toContainText("baanmali/site #41 · noi");
  await expect(row(page, "github:baanmali/site:41").getByTestId("prs-checks")).toHaveText("Checks passed");
  await expect(row(page, "github:baanmali/site:41").getByTestId("prs-review")).toHaveText("Approved");
  await expect(row(page, "github:baanmali/site:42").getByTestId("prs-checks")).toHaveText("1 running");
  const boards = (await calls(page, "__manutTaskCalls")).filter((c) => c.op === "board");
  expect(boards.map((c) => `${c.source}:${c.repo}`).sort()).toEqual(["github:baanmali/site", "gitlab:baanmali/shop/app"]);
});

test("a row opens the request in the app: its description as plain text, checks, files and counts, and Open on GitHub", async ({ page }) => {
  await setup(page);
  await openPulls(page);
  await row(page, "github:baanmali/site:41").click();
  const d = page.getByTestId("prs-detail");
  await expect(d.getByTestId("prs-detail-title")).toHaveText("Make the QR code bigger on phones");
  await expect(d.getByTestId("prs-detail-body")).toContainText("- **Measured** on two phones");
  await expect(d.getByTestId("prs-detail-body")).toContainText("<b>Nothing</b> else changes");
  await expect(d.locator("strong, b")).toHaveCount(0);
  await expect(d.getByTestId("prs-detail-checks")).toContainText("lint");
  await expect(d.getByTestId("prs-counts")).toHaveText("2 files, 32 lines added, 3 removed");
  await expect(d.getByTestId("prs-detail-files")).toContainText("src/checkout/qr.tsx");
  await d.getByTestId("prs-open-host").click();
  expect(await page.evaluate(() => (window as unknown as { __opened: string[] }).__opened)).toEqual(["https://github.com/baanmali/site/pull/41"]);
  // nothing was asked to write
  expect((await calls(page, "__manutSessionCalls")).filter((c) => String(c.op).startsWith("review."))).toEqual([]);
});

test("Merge asks the lane's ask with the methods the repository allows, settles once, and reads the list again", async ({ page }) => {
  await setup(page);
  await openPulls(page);
  await row(page, "github:baanmali/site:41").click();
  const d = page.getByTestId("prs-detail");
  await d.getByTestId("pr-merge-start").click();
  const pick = d.getByTestId("review-method-pick");
  await expect(pick.locator("option")).toHaveText(["Squash and merge"]);
  await d.getByTestId("review-merge-ask").click();
  const ask = d.getByTestId("review-ask");
  await expect(ask).toHaveAttribute("data-kind", "merge");
  await expect(ask.getByTestId("review-repo")).toContainText("baanmali/site");
  await expect(ask.getByTestId("review-branch")).toContainText("change/41");
  await expect(ask.getByTestId("review-method")).toHaveAttribute("data-method", "squash");
  await expect(ask.getByTestId("review-subject")).toHaveText("Make the QR code bigger on phones (#41)");
  const before = (await calls(page, "__manutTaskCalls")).filter((c) => c.op === "board").length;
  await ask.getByTestId("review-yes").click();
  await expect(d.getByTestId("review-done")).toHaveAttribute("data-outcome", "merged");
  const settled = (await calls(page, "__manutSessionCalls")).filter((c) => c.op === "review.settle");
  expect(settled).toEqual([{ op: "review.settle", path: "change/41", yes: true, title: "Make the QR code bigger on phones (#41)", body: "Make the QR code bigger on phones" }]);
  await expect.poll(async () => (await calls(page, "__manutTaskCalls")).filter((c) => c.op === "board").length).toBeGreaterThan(before);
  await expect(d.getByTestId("pr-merge-start")).toHaveCount(0);
});

test("a request that cannot merge says why and asks nothing; a fork's request offers no Merge", async ({ page }) => {
  await setup(page, "light", { "github:baanmali/site:42": { cannot: "checking" } });
  await openPulls(page);
  await row(page, "github:baanmali/site:42").click();
  const d = page.getByTestId("prs-detail");
  await d.getByTestId("pr-merge-start").click();
  await d.getByTestId("review-merge-ask").click();
  await expect(d.getByTestId("review-why")).toBeVisible();
  await expect(d.getByTestId("review-ask")).toHaveCount(0);
  await row(page, "github:baanmali/site:46").click();
  await expect(d.getByTestId("prs-fork")).toContainText("stranger/site");
  await expect(d.getByTestId("pr-merge-start")).toHaveCount(0);
  expect((await calls(page, "__manutSessionCalls")).filter((c) => c.op === "review.settle")).toEqual([]);
});

test("another host's requests are listed read only, with Open on the host and nothing to merge (item 100b)", async ({ page }) => {
  const AZ = "/home/you/code/baanmali-az";
  // after setup's own script (init scripts run in the order they were added, again on the reload): a third project, on Azure DevOps
  await setup(page);
  await page.addInitScript((az) => {
    const w = window as unknown as Record<string, any>;
    w.__manutTasks.others = {
      [az]: {
        host: "azure",
        name: "Azure DevOps",
        repo: "Shop Site/site",
        items: [
          { number: 31, title: "PromptPay QR at checkout", state: "open", url: "https://dev.azure.com/baanmali/Shop%20Site/_git/site/pullrequest/31", labels: [], author: "Noi Saetang", created: Math.floor(Date.now() / 1000) - 7200, updated: Math.floor(Date.now() / 1000) - 7200, checks: { passed: 0, failed: 0, pending: 0, total: 0 }, head: "kit/promptpay-qr", same: true, from: "", review: "approved", conflict: false, base: "main" },
        ],
      },
    };
    w.__manutLanes.push({ worktree: `${az}-lanes/qr`, dir: `${az}-lanes/qr`, branch: "kit/qr", base: "main", project: az, made: 1 });
  }, AZ);
  await page.reload();
  await openCode(page);
  await page.getByTestId("tasks-open").click();
  await page.getByTestId("tasks-scope-pulls").click();
  const other = page.getByTestId("prs-other-row");
  await expect(other).toHaveCount(1);
  await expect(other).toHaveAttribute("data-readiness", "ready");
  await expect(other.getByTestId("prs-other-host")).toHaveText("Azure DevOps");
  await other.getByTestId("prs-other-open").click();
  expect(await page.evaluate(() => (window as unknown as { __opened: string[] }).__opened)).toEqual(["https://dev.azure.com/baanmali/Shop%20Site/_git/site/pullrequest/31"]);
  // it opens nothing in the app: no detail, no Merge, and nothing was asked to write
  await expect(page.getByTestId("prs-detail")).toHaveCount(0);
  expect((await calls(page, "__manutSessionCalls")).filter((c) => String(c.op).startsWith("review."))).toEqual([]);
  // the other hosts' reader was asked only for the folder on no GitHub or GitLab remote
  const asked = (await calls(page, "__manutTaskCalls")).filter((c) => c.op === "otherRemote").map((c) => c.cwd);
  expect(asked).toEqual([AZ]);
  if (SHOTS) {
    await page.mouse.move(2, 2);
    await shot(page, "prs-other-light-1280");
  }
});

test.describe("shots", () => {
  test.skip(!SHOTS, "MANUT_SHOTS unset");
  for (const theme of ["light", "dark"] as const)
    for (const width of [1280, 900])
      test(`pull requests ${theme} ${width}`, async ({ page }) => {
        await page.setViewportSize({ width, height: 820 });
        await setup(page, theme);
        await openPulls(page);
        await page.mouse.move(2, 2);
        await shot(page, `prs-list-${theme}-${width}`);
        await row(page, "github:baanmali/site:41").click();
        await expect(page.getByTestId("prs-detail-files")).toBeVisible();
        await shot(page, `prs-detail-${theme}-${width}`);
        await page.getByTestId("pr-merge-start").click();
        await page.getByTestId("review-merge-ask").click();
        await expect(page.getByTestId("review-ask")).toBeVisible();
        await shot(page, `prs-ask-${theme}-${width}`);
      });
});
