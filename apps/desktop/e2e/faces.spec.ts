// The brand's team faces (src/ui/Avatar.tsx, face.ts and face.css; the canvas's KitFaces and States: team faces boards),
// in the app as a person sees them. In Practice, the app's own runtime (`__MANUT_IN_PROCESS__`, src/lib/bridge.ts), whose
// team is the canvas's: Buddy, Nam, Pim, Ton and Kit.
//
// It checks that each member's face is the kit's SVG on the member's own colour, with the state the word beside it says
// (Nam asks before sending, the others are idle, and Pause everyone pauses them all), that a face keeps the footprint of
// the picture it replaced wherever it shows, and that with reduced motion no face moves.
//
// With FACES_SHOTS set to a folder it also photographs the pages that show members (Home, Team, a chat, Needs you,
// Settings, History) and a strip of every kit state at the kit's four sizes as the app draws them, in light and dark.
// With FACES_BOARD set as well, to the StatesFaces board expanded to plain HTML by the canvas's own tool
// (`python3 -I <canvas>/tools/expand_boards.py <canvas>/app-screens/project <dir>`, then <dir>/StatesFaces.html), it
// photographs that board's "Every state" beside them. The tool draws the board with every move off, so the app's strip is
// drawn so too, and the two show the same still frame. Screenshots never go in the repository.
import { expect, test, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const PORT = Number(process.env.MANUT_PORT || 5307);
const SHOTS = process.env.FACES_SHOTS;
const BOARD = process.env.FACES_BOARD;
const TAG = process.env.FACES_TAG || "after";

/** The canvas's team and their colours (the Colour board; src/ui/face.ts TEAM_LOOKS). */
const TEAM: Record<string, string> = { nam: "#CDDDEB", pim: "#DBD6EC", ton: "#CEDFCE", kit: "#E6D9C2" };
/** Every state the kit draws, in its board's order. */
const STATES = ["idle", "listen", "think", "do", "solve", "write", "ask", "done", "stuck", "pause", "practice", "rest"];
/** The kit's four sizes: its class and the footprint it keeps. */
const SIZES = [
  { cls: "", size: 24 },
  { cls: "md", size: 32 },
  { cls: "lg", size: 40 },
  { cls: "xl", size: 96 },
];

test.use({
  timezoneId: "Asia/Bangkok",
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

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    (window as unknown as { __MANUT_IN_PROCESS__: boolean }).__MANUT_IN_PROCESS__ = true;
  });
});

async function shoot(page: Page, name: string, theme: string): Promise<void> {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  await page.mouse.move(1, 1);
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(SHOTS, `${name}-${TAG}-${theme}.png`) });
}

/** Practice's own demo: Nam asks before sending, so Team, Home and Needs you show a member waiting on the person. */
async function namAsks(page: Page): Promise<void> {
  await page.getByTestId("menu-team").click();
  await page.getByTestId("team-nam").click();
  await expect(page.getByTestId("who")).toBeVisible();
  await page.getByTestId("composer").fill("/approve");
  await page.getByTestId("composer").press("Enter");
  await expect(page.getByTestId("menu-needs-count")).toBeVisible({ timeout: 10_000 });
}

const face = (page: Page, row: string, member: string) => page.getByTestId(row).locator(`.ui-av[data-face="${member}"]`);

test("each member's face is the kit's SVG on their own colour, with the state the word beside it says", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("page-home")).toBeVisible();
  await namAsks(page);
  await page.getByTestId("menu-team").click();
  await expect(page.getByTestId("page-team")).toBeVisible();

  for (const [m, fill] of Object.entries(TEAM)) {
    const av = face(page, `team-${m}`, m);
    const f = av.locator("span.face.lg");
    await expect(f.locator("svg rect.fg")).toHaveAttribute("fill", fill);
    await expect(f.locator("svg path.fs")).toHaveCount(1);
    await expect(f).toHaveAttribute("data-st", m === "nam" ? "ask" : "idle");
    await expect(page.getByTestId(`team-row-${m}`).locator(".tag")).toHaveText(m === "nam" ? "Needs you" : "Idle");
  }
  // Buddy keeps the blue face, with no frame
  await expect(face(page, "team-buddy", "buddy").locator('svg circle[fill="#4DA3FF"]')).toHaveCount(1);
  await expect(face(page, "team-buddy", "buddy").locator("span.face")).toHaveCount(0);

  // the face keeps the 40px footprint of the picture it replaced; the kit's lg face spills 6.5px past each edge
  const box = (await face(page, "team-nam", "nam").boundingBox())!;
  const drawn = (await face(page, "team-nam", "nam").locator("span.face").boundingBox())!;
  expect([box.width, box.height]).toEqual([40, 40]);
  expect([drawn.width, drawn.x - box.x, drawn.y - box.y]).toEqual([53, -6.5, -6.5]);

  // Home and Needs you show Nam waiting there too; a message's face shows no state, as no word is beside it
  await page.getByTestId("menu-home").click();
  await expect(page.locator('[data-testid="page-home"] .ui-av[data-face="nam"] span.face')).toHaveAttribute("data-st", "ask");
  await page.getByTestId("menu-needs").click();
  await expect(page.locator('[data-testid="page-needs"] .ui-av[data-face="nam"] span.face').first()).toHaveAttribute("data-st", "ask");
  await page.getByTestId("menu-team").click();
  await page.getByTestId("team-nam").click();
  const msgFace = page.locator('[data-testid="bubble-bot"] .msg-face span.face').first();
  await expect(msgFace.locator("rect.fg")).toHaveAttribute("fill", TEAM.nam);
  await expect(msgFace).not.toHaveAttribute("data-st", /.+/);

  // Pause everyone pauses every face, and the word beside each says so
  await page.getByTestId("menu-team").click();
  await page.getByTestId("pause-open").click();
  await page.getByTestId("pause-confirm").click();
  for (const m of Object.keys(TEAM)) {
    await expect(face(page, `team-${m}`, m).locator("span.face")).toHaveAttribute("data-st", "pause");
    await expect(page.getByTestId(`team-row-${m}`).locator(".tag")).toHaveText("Paused");
  }
  await page.getByTestId("pause-resume").click();
  await expect(face(page, "team-pim", "pim").locator("span.face")).toHaveAttribute("data-st", "idle");
});

test("a face keeps the footprint its place asked for: chat header, a message, Home, Settings", async ({ page }) => {
  await page.goto("/");
  await namAsks(page);
  const size = async (sel: string) => {
    const el = page.locator(sel).first();
    const b = (await el.boundingBox())!;
    const f = (await el.locator("span.face").boundingBox())!;
    return { box: [b.width, b.height], spill: Math.round((f.width - b.width) * 100) / 100 };
  };
  // Each size is read until it settles: a page that has just opened may still be playing its entrance, and on a CI
  // runner the Settings page's 64px face once measured 63.99999 twice in a row (26 Nov 2026). The sizes must still
  // be exact once it has.
  // the header's 26 and a message's 28 are not the kit's sizes: drawn in its proportions, a third larger than the box
  await expect.poll(() => size('[data-testid="who"] .ui-av')).toEqual({ box: [26, 26], spill: 8.5 });
  await expect.poll(() => size('[data-testid="bubble-bot"] .msg-face')).toEqual({ box: [28, 28], spill: 9.5 });
  await page.getByTestId("menu-home").click();
  await expect.poll(() => size('[data-testid="page-home"] .ui-av[data-face="nam"]')).toEqual({ box: [32, 32], spill: 11 });
  await page.getByTestId("nav-settings").click();
  await page.getByTestId("settings-nav-bot-nam").click();
  await expect.poll(() => size('[data-testid="settings-nav-bot-nam"] .ui-av')).toEqual({ box: [18, 18], spill: 6 });
  await expect.poll(() => size('[data-testid="avatar-edit"] .ui-av')).toEqual({ box: [64, 64], spill: 21.5 });
});

test("with reduced motion no face moves; without it the face that waits for the person does", async ({ page }) => {
  const moving = () =>
    page.evaluate(() => {
      const faces = [...document.querySelectorAll("span.face")];
      return faces.flatMap((f) => f.getAnimations({ subtree: true })).filter((a) => a.playState === "running").length;
    });
  await page.goto("/");
  await namAsks(page);
  await page.getByTestId("menu-team").click();
  await expect(face(page, "team-nam", "nam").locator("span.face")).toHaveAttribute("data-st", "ask");
  expect(await moving()).toBeGreaterThan(0);

  // turned on while the page is open, as a person does in System Settings: every face's move ends where it stands
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect.poll(moving).toBe(0);
  // and a face drawn after it ends its moves at once (motion.css: 0.01 ms, one run), within the frame it is drawn in
  await page.getByTestId("menu-home").click();
  await page.getByTestId("menu-team").click();
  await expect(face(page, "team-nam", "nam").locator("span.face")).toHaveAttribute("data-st", "ask");
  await expect.poll(moving, { intervals: [50, 50, 100] }).toBe(0);
  await page.waitForTimeout(500);
  expect(await moving()).toBe(0);
  // still the state: the amber frame and the question badge stay
  await expect(face(page, "team-nam", "nam").locator(".fb")).toBeVisible();
});

for (const theme of ["light", "dark"] as const) {
  test(`pages with faces, and every state beside the board, ${theme}`, async ({ page }) => {
    test.skip(!SHOTS, "FACES_SHOTS not set");
    await page.addInitScript((th) => localStorage.setItem("manut.theme", th), theme);
    await page.goto("/");
    await expect(page.getByTestId("page-home")).toBeVisible();
    await namAsks(page);
    await page.waitForTimeout(500);
    await shoot(page, "chat-nam", theme);
    await page.getByTestId("menu-home").click();
    await expect(page.getByTestId("page-home")).toBeVisible();
    await page.waitForTimeout(800);
    await shoot(page, "home", theme);
    await page.getByTestId("menu-team").click();
    await expect(page.getByTestId("page-team")).toBeVisible();
    await page.waitForTimeout(500);
    await shoot(page, "team", theme);
    await page.getByTestId("menu-needs").click();
    await expect(page.getByTestId("page-needs")).toBeVisible();
    await page.waitForTimeout(500);
    await shoot(page, "needs", theme);
    await page.getByTestId("menu-team").click();
    await page.getByTestId("team-buddy").click();
    await expect(page.getByTestId("who")).toBeVisible();
    await page.waitForTimeout(500);
    await shoot(page, "chat-buddy", theme);
    await page.getByTestId("nav-settings").click();
    await page.getByTestId("settings-nav-bot-nam").click();
    await page.waitForTimeout(500);
    await shoot(page, "settings", theme);
    await page.getByTestId("menu-history").click();
    await page.waitForTimeout(500);
    await shoot(page, "history", theme);

    // Every kit state at its four sizes, as the app's own markup and face.css draw them: Nam's face from Team, copied
    // once for each state and size onto the page's ground, the members' order and colours as the board's cards.
    await page.getByTestId("menu-team").click();
    await page.setViewportSize({ width: 1360, height: 820 });
    const src = face(page, "team-nam", "nam").locator("span.face");
    await expect(src).toBeVisible();
    await page.evaluate(
      ({ states, sizes, looks }) => {
        const strip = document.createElement("div");
        strip.id = "face-strip";
        strip.style.cssText = "position:fixed;inset:0;z-index:9999;overflow:auto;background:var(--bg);padding:24px;display:grid;grid-template-columns:repeat(3,1fr);align-content:start;gap:8px 24px";
        const from = document.querySelectorAll<HTMLElement>(".ui-av[data-face] span.face");
        const byMember = new Map([...from].map((f) => [f.closest<HTMLElement>(".ui-av")!.dataset.face!, f]));
        states.forEach((st, i) => {
          const cell = document.createElement("div");
          cell.style.cssText = "display:flex;align-items:flex-end;gap:30px;padding:16px 8px;color:var(--muted);font:12px var(--font)";
          const who = byMember.get(looks[i % looks.length])!;
          for (const { cls } of sizes) {
            const f = who.cloneNode(true) as HTMLElement;
            f.className = cls ? `face ${cls}` : "face";
            f.removeAttribute("style");
            f.dataset.st = st;
            cell.appendChild(f);
          }
          const word = document.createElement("span");
          word.textContent = st;
          cell.appendChild(word);
          strip.appendChild(cell);
        });
        document.body.appendChild(strip);
      },
      // the board's members per card: Pim, Nam, Pim, Nam, Kit, Nam, Ton, Nam, Kit, Pim, Kit, Ton
      { states: STATES, sizes: SIZES, looks: ["pim", "nam", "pim", "nam", "kit", "nam", "ton", "nam", "kit", "pim", "kit", "ton"] },
    );
    // every move off, as the expanded board is drawn
    await page.addStyleTag({ content: "#face-strip *{animation:none!important}" });
    await page.locator("#face-strip").screenshot({ path: join(SHOTS!, `states-app-${TAG}-${theme}.png`) });

    if (!BOARD) return;
    // The board as the canvas's tool expands it. Its dark twin imports it with the dark theme on; the theme here is set
    // the same way, on the sheet itself.
    await page.goto(`file://${BOARD}`);
    await expect(page.locator("span.face.xl").nth(11)).toBeVisible({ timeout: 15_000 });
    if (theme === "dark") await page.evaluate(() => document.querySelectorAll(".r").forEach((r) => r.setAttribute("data-t", "dark")));
    const every = page.locator("section", { has: page.locator("h2", { hasText: "Every state" }) });
    await every.screenshot({ path: join(SHOTS!, `states-board-${theme}.png`) });
  });
}
