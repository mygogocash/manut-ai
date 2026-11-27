// Item 102i (docs/several-agents.md, "4. Helper lanes a lane asks for", rule R8): each helper lane's work lands in its lead's folder as it
// reports, and its row in the Helpers card says how. Kit's chat runs on the stand-in coding agent of src/sessions/host.mock.ts, whose
// `/helpers three` answer asks for three helper lanes; the mock shell reads this Mac as 32 GB, so all three run at once, and answers each
// helper lane's landing as `__manutMockLandings` says: helper 1 lands cleanly with a key in one file, helper 2 lands with a conflict, and
// helper 3's patch would not apply and is kept, its text in `__manutMockPatches`. Take back of helper 2's landing is refused because
// Kit's folder changed since. The safety rule is pinned as in the app: a helper that reports while Kit's turn runs waits on its row, and
// the mock shell is asked to land nothing until that turn ends.
// Pictures of the Helpers card with a landed, a conflicted and a kept row, and of Show patch, light and dark, go to LANDINGS_SHOTS (else
// Playwright's ignored test-results).
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";

const ROOT = "/home/you/code/baanmali-preorder";
const MOCK = Number(process.env.MANUT_MOCK_PORT || 5308);
const SHOTS = process.env.LANDINGS_SHOTS || "test-results";

/** The mock bridge's own reset, as helper-runs.spec.ts does: an account a spec before this one limited would keep a helper lane from
 *  starting here. */
async function resetMock(): Promise<void> {
  const ws = new WebSocket(`ws://127.0.0.1:${MOCK}/?token=e2e`);
  await new Promise<void>((res, rej) => {
    ws.onopen = () => res();
    ws.onerror = () => rej(new Error("mock websocket error"));
  });
  await new Promise<void>((res) => {
    ws.onmessage = (m) => {
      if (JSON.parse(String(m.data)).id === "hl1") res();
    };
    ws.send(JSON.stringify({ id: "hl1", op: "mock.reset" }));
  });
  ws.close();
}

type Call = { op: string; path?: string };
const calls = (page: Page) => page.evaluate(() => ((window as unknown as { __manutSessionCalls?: Call[] }).__manutSessionCalls ?? []));
const ops = async (page: Page, op: string) => (await calls(page)).filter((c) => c.op === op);

const theme = (page: Page, th: "light" | "dark") =>
  page.evaluate(async (t) => {
    const m = await import(/* @vite-ignore */ "/src/state/store.ts" as string);
    m.getStore().actions.setTheme(t);
  }, th);

/** The shell's `Landed` answer, as its serde writes it. */
const landedAs = (o: Record<string, unknown>) => ({ outcome: "landed", files: [], files_total: 0, conflicts: [], cut: [], cut_total: 0, keys: [], patch: "", why: "", outside: [], error: "", ...o });

const PATCH = [
  "diff --git a/src/share/line.ts b/src/share/line.ts",
  "new file mode 100644",
  "index 0000000000000000000000000000000000000000..8c1d2b7a6e3f4a5b6c7d8e9f0a1b2c3d4e5f6a7b",
  "--- /dev/null",
  "+++ b/src/share/line.ts",
  "@@ -0,0 +1,4 @@",
  "+// Share an order to LINE with LINE's own share link.",
  "+export function lineShareUrl(text: string): string {",
  "+  return `https://line.me/R/share?text=${encodeURIComponent(text)}`;",
  "+}",
  "diff --git a/src/checkout/Checkout.tsx b/src/checkout/Checkout.tsx",
  "index 1f2e3d4c5b6a79881726354453627180918a7b6c..2a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d 100644",
  "--- a/src/checkout/Checkout.tsx",
  "+++ b/src/checkout/Checkout.tsx",
  "@@ -12,6 +12,9 @@ export function Checkout({ order }: Props) {",
  "   return (",
  '     <section className="checkout">',
  "       <QrCode payload={promptPayQR(order.shopId, order.total)} />",
  '+      <a className="share-line" href={lineShareUrl(orderText(order))}>',
  "+        Share to LINE",
  "+      </a>",
  "     </section>",
  "   );",
  " }",
  "",
].join("\n");

test.beforeEach(async ({ page }) => {
  await resetMock();
  await page.addInitScript(
    ({ root, landings, patch }) => {
      localStorage.removeItem("manut.kit.projects");
      const w = window as any;
      w.__manutBranches = { [root]: "main" };
      w.__manutMockTaken = [];
      w.__manutMemory = 32 * 1024 ** 3;
      w.__manutMockLandings = landings;
      w.__manutMockPatches = { 3: patch };
      w.__manutMockTakeBack = { 2: "changed" };
    },
    {
      root: ROOT,
      landings: {
        1: landedAs({ files: ["src/qr.test.ts"], files_total: 1, keys: ["src/qr.test.ts"] }),
        2: landedAs({ files: ["src/receipt.tsx", "src/qr.ts"], files_total: 2, conflicts: ["src/qr.ts"] }),
        3: landedAs({
          outcome: "kept",
          files: ["src/share/line.ts", "src/checkout/Checkout.tsx"],
          files_total: 2,
          patch: "/home/you/.manut/patches/jlanding/add-a-promptpay-qr-help-3.patch",
          why: "would_not_apply",
          error: "error: patch failed: src/checkout/Checkout.tsx:12",
        }),
      },
      patch: PATCH,
    },
  );
  await page.goto("/");
});

/** A Claude Code lane in the project with Helpers on, open in the main column, whose answer to `/helpers <word>` asked for helper
 *  lanes, and the person's Start helpers on its card. */
async function round(page: Page, word = "three"): Promise<string> {
  const id = await page.evaluate(async (root) => {
    const s = (window as any).__manutSessions;
    await s.loadAgents();
    const id = s.draft("claude");
    s.setDraft(id, { cwd: root });
    await s.start(id, "Add a PromptPay QR to the checkout");
    return id as string;
  }, ROOT);
  await openSession(page, id);
  await expect(page.getByTestId("bubble-bot").last()).toContainText("You said: Add a PromptPay QR to the checkout");
  await page.getByTestId("helpers-switch").click();
  await page.getByTestId("composer").fill(`/helpers ${word}`);
  await page.getByTestId("composer").press("Enter");
  const card = page.getByTestId("helpers-card");
  await expect(card).toBeVisible();
  await card.getByTestId("helpers-start").click();
  await expect(page.getByTestId("helpers-line")).toHaveText(/You approved this round\. Its helper lanes start below\./);
  return id;
}

const openSession = (page: Page, id: string) =>
  page.evaluate(async (i) => {
    const store = (await import(/* @vite-ignore */ "/src/state/store.ts" as string)) as { getStore(): { actions: { openSession(id: string): void } } };
    store.getStore().actions.openSession(i);
  }, id);

test("each helper's work lands as it reports: landed, landed with a conflict, kept as a patch; Show patch and Take back", async ({ page }) => {
  await round(page);
  const card = page.getByTestId("helper-run-card");
  const rows = card.getByTestId("helper-run-row");
  await expect(rows).toHaveCount(3);
  await expect(card.getByTestId("helper-landing-line")).toHaveText(["Landed 1 file", "Landed 2 files, 1 with conflicts: src/qr.ts", "Kept as a patch: it would not apply"]);
  // the key is named by its file, never shown
  await expect(rows.nth(0).getByTestId("helper-landing-keys")).toHaveText("A key is in src/qr.test.ts. It is hidden here, and Kit's next commit or push asks you first.");
  await expect(rows.nth(2).getByTestId("helper-landing-detail")).toHaveText("error: patch failed: src/checkout/Checkout.tsx:12");
  // Take back on a landing in Kit's folder, Show patch on the kept one
  await expect(rows.nth(0).getByTestId("helper-landing-take-back")).toBeEnabled();
  await expect(rows.nth(1).getByTestId("helper-landing-take-back")).toBeEnabled();
  await expect(rows.nth(2).getByTestId("helper-landing-take-back")).toHaveCount(0);
  await expect(rows.nth(2).getByTestId("helper-landing-patch")).toHaveText("Show patch");
  // the shell was asked once for each, one helper lane each
  const lands = await ops(page, "lane.land");
  expect(lands).toHaveLength(3);
  expect(new Set(lands.map((c) => c.path)).size).toBe(3);

  // pictures: the card with a landed, a conflicted and a kept row, light and dark
  await page.setViewportSize({ width: 1280, height: 1000 });
  await page.getByTestId("timeline").evaluate((el) => (el.scrollTop = el.scrollHeight));
  for (const th of ["light", "dark"] as const) {
    await theme(page, th);
    await card.screenshot({ path: join(SHOTS, `helper-landings-card-${th}.png`), animations: "disabled" });
  }

  // Show patch: the kept patch's text, read-only, one file per block
  await rows.nth(2).getByTestId("helper-landing-patch").click();
  const patch = rows.nth(2).getByTestId("landing-patch");
  await expect(patch).toHaveAttribute("data-state", "shown");
  await expect(patch.getByTestId("landing-patch-file")).toHaveCount(2);
  await expect(patch.locator(".dv-path")).toHaveText(["src/share/line.ts", "src/checkout/Checkout.tsx"]);
  await expect(patch.getByTestId("landing-patch-at")).toHaveText("Kept at /home/you/.manut/patches/jlanding/add-a-promptpay-qr-help-3.patch");
  await expect(patch.locator("textarea, input, [contenteditable=true]")).toHaveCount(0);
  await expect(rows.nth(2).getByTestId("helper-landing-patch")).toHaveText("Hide patch");
  expect(await ops(page, "lane.patch")).toHaveLength(1);
  for (const th of ["light", "dark"] as const) {
    await theme(page, th);
    await rows.nth(2).screenshot({ path: join(SHOTS, `helper-landings-patch-${th}.png`), animations: "disabled" });
  }
  await rows.nth(2).getByTestId("helper-landing-patch").click();
  await expect(rows.nth(2).getByTestId("landing-patch")).toHaveCount(0);

  // Take back: helper 1's landing goes; helper 2's is refused with the shell's reason
  await rows.nth(0).getByTestId("helper-landing-take-back").click();
  await expect(rows.nth(0).getByTestId("helper-landing-line")).toHaveText("Taken back: Kit's folder is as it was before this landing");
  await expect(rows.nth(0).getByTestId("helper-landing-take-back")).toHaveCount(0);
  await rows.nth(1).getByTestId("helper-landing-take-back").click();
  await expect(rows.nth(1).getByTestId("helper-landing-take-back-error")).toHaveText("Not taken back: Kit's folder changed since this landing.");
  await expect(rows.nth(1).getByTestId("helper-landing-line")).toHaveText("Landed 2 files, 1 with conflicts: src/qr.ts");
  expect((await ops(page, "lane.takeBack")).map((c) => c.path)).toEqual([lands.find((c) => c.path!.endsWith("-help-1"))!.path, lands.find((c) => c.path!.endsWith("-help-2"))!.path]);
});

test("safety: no landing starts while Kit's turn runs; the helper that reported meanwhile waits on its row and lands once the turn ends", async ({ page }) => {
  // helper 1 asks the person a question first; helper 2 does its brief at once
  await page.addInitScript(() => {
    (window as any).__manutMockHelpers = { 1: "/ask" };
  });
  await page.reload();
  const lead = await round(page, "two");
  const card = page.getByTestId("helper-run-card");
  const rows = card.getByTestId("helper-run-row");
  await expect(rows.nth(1).getByTestId("helper-landing-line")).toHaveText("Landed 2 files, 1 with conflicts: src/qr.ts");
  await expect(rows.nth(0)).toHaveAttribute("data-state", "asking");
  // Kit's own next turn runs and holds
  await page.getByTestId("composer").fill("/work hold");
  await page.getByTestId("composer").press("Enter");
  await expect(page.getByTestId("stop")).toBeVisible();
  // the person answers helper 1's question in its own chat; it finishes and reports while Kit works
  await rows.nth(0).getByTestId("helper-run-answer").click();
  const question = page.getByTestId("card-clarify");
  await expect(question).toContainText("Which greeting should go in greet.txt?");
  await question.getByRole("button", { name: "hi", exact: true }).click();
  await expect(page.getByTestId("bubble-bot").last()).toHaveText("Wrote hi to greet.txt.");
  await openSession(page, lead);
  await expect(rows.nth(0)).toHaveAttribute("data-state", "done");
  await expect(rows.nth(0).getByTestId("helper-landing-line")).toHaveText("Lands once Kit is idle");
  // Take back waits too while Kit works
  await expect(rows.nth(1).getByTestId("helper-landing-take-back")).toBeDisabled();
  expect((await ops(page, "lane.land")).map((c) => c.path!.slice(-7))).toEqual(["-help-2"]);
  // Kit's turn ends: helper 1 lands now
  await page.getByTestId("stop").click();
  await expect(page.getByTestId("stop")).toHaveCount(0);
  await expect(rows.nth(0).getByTestId("helper-landing-line")).toHaveText("Landed 1 file");
  expect((await ops(page, "lane.land")).map((c) => c.path!.slice(-7))).toEqual(["-help-2", "-help-1"]);
  await expect(rows.nth(1).getByTestId("helper-landing-take-back")).toBeEnabled();
});
