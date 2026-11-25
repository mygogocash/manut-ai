// The cases for the preview's page drawn in the pane beside a lane (src/code/LanePreview.tsx, previewFrame.ts; the design canvas's
// Code board, Preview), run by preview-frame.spec.ts (Chromium, as CI runs the suite) and preview-frame-webkit.spec.ts (WebKit, the
// macOS webview's engine, on a Mac that has it). A plain browser has no shell, so the preview is the mock host's fake run (src/code/previewHost.ts),
// told to print the address of a stand-in dev server; or, for the stubbed shell, the desktop's own host against a stand-in for the
// shell's preview commands (`window.__manutPreviewShell`). The stand-in dev server is this spec: every request to its address, an
// address of this computer that nothing listens on, is answered here (page.route), as outpost-scripts.ts answers its pages, and so
// is the other site its link leads to, so a load that got through would show. The app's page is served with the app's own
// `frame-src` (read from tauri.conf.json), so the browser bounds the frame as the app's webview does; what the desktop's WKWebView
// does with the app's own scheme was checked with a scratch Tauri program (docs/code-editor.md, "The page in the pane").
import { readFileSync } from "node:fs";
import { expect, test, type Page, type Route } from "@playwright/test";
import { openCode } from "./start";

const ROOT = "/home/you/code/baanmali-preorder";
/** The stand-in dev server: its page, as the preview prints its address. */
const STAND = "http://localhost:5373/";
/** Another site: a link in the page leads here, and a pop-up and the top frame are sent here. */
const AWAY = "https://example.com/";
const conf = JSON.parse(readFileSync(new URL("../src-tauri/tauri.conf.json", import.meta.url), "utf8")) as { app: { security: { csp: Record<string, string> } } };
const FRAME_SRC = conf.app.security.csp["frame-src"];
const SANDBOX = "allow-scripts allow-same-origin allow-forms";

type Call = { op: string; dir?: string; argv?: string[]; url?: string; id?: number };

const html = (title: string, body: string) =>
  `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title><style>body{font:15px system-ui;margin:24px;color:#1f2022}</style></head><body>${body}</body></html>`;
/** The stand-in's own page: the canvas's pre-order page, and what it can reach of the app, written into itself. */
const STAND_PAGE = html(
  "Baan Mali pre-order",
  `<h1>New Year gift set</h1>
  <div role="img" aria-label="QR code" style="width:140px;height:140px;border:1px solid #ccc;display:flex;align-items:center;justify-content:center">[QR CODE]</div>
  <p>Scan to pay with PromptPay</p><p id="price">฿590</p>
  <p id="tauri"></p><p id="top"></p><p id="popup"></p><p id="moved"></p>
  <button id="go-top" type="button">Leave the app</button>
  <button id="open" type="button">Open a window</button>
  <a id="away" href="${AWAY}away">Another site</a>
  <a id="about" href="/about">About the shop</a>
  <form id="pay" action="/thanks" method="post"><input name="amount" value="590"><button type="submit">Pay</button></form>
  <script>
    const say = (id, text) => { document.getElementById(id).textContent = text; };
    say("tauri", "Tauri here: " + typeof window.__TAURI_INTERNALS__);
    try { say("top", "Top frame: " + top.location.href); } catch (e) { say("top", "Top frame: " + e.name); }
    document.getElementById("go-top").onclick = () => {
      try { top.location.href = "${AWAY}hijack"; say("moved", "Moved the app"); } catch (e) { say("moved", "Refused: " + e.name); }
    };
    document.getElementById("open").onclick = () => say("popup", "Window: " + String(window.open("${AWAY}popup")));
  </script>`,
);

/** What the spec's servers were asked for, by address. */
async function serve(page: Page): Promise<string[]> {
  const asked: string[] = [];
  await page.route(`${STAND}**`, (route: Route) => {
    const url = new URL(route.request().url());
    asked.push(`${route.request().method()} ${url.pathname}`);
    const page = url.pathname === "/" ? STAND_PAGE : url.pathname === "/about" ? html("About", "<h1>About the shop</h1>") : url.pathname === "/thanks" ? html("Thanks", `<h1>Thank you</h1><p>${route.request().postData() ?? ""}</p>`) : null;
    return route.fulfill({ status: page ? 200 : 404, contentType: "text/html; charset=utf-8", body: page ?? html("Not found", "<p>Not here</p>") });
  });
  await page.route(`${AWAY}**`, (route: Route) => {
    asked.push(`AWAY ${route.request().url()}`);
    return route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: html("Another site", "<h1>Another site</h1>") });
  });
  return asked;
}

/** The app's own page, served with the app's `frame-src` from tauri.conf.json (Vite's dev server sends no CSP of its own), and the
 *  CSP refusals it reports kept on the page. */
async function withAppCsp(page: Page) {
  // the suite serves the app at 127.0.0.1 (playwright.config.ts), and the stand-in is at localhost, another origin
  await page.route(
    (url) => url.hostname === "127.0.0.1" && url.pathname === "/",
    async (route) => {
      if (route.request().resourceType() !== "document") return route.continue();
      const response = await route.fetch();
      return route.fulfill({ response, headers: { ...response.headers(), "content-security-policy": `frame-src ${FRAME_SRC}` } });
    },
  );
  await page.addInitScript(() => {
    (window as any).__cspRefused = [];
    document.addEventListener("securitypolicyviolation", (e) => (window as any).__cspRefused.push(`${e.violatedDirective} ${e.blockedURI}`));
  });
}

/** A Claude Code session in the project, running as a chat, so it works in a lane's own folder. */
async function startIn(page: Page, first: string): Promise<string> {
  return page.evaluate(
    async ([folder, text]) => {
      const s = (window as any).__manutSessions;
      await s.loadAgents();
      const id = s.draft("claude");
      s.setDraft(id, { cwd: folder });
      await s.start(id, text);
      return id as string;
    },
    [ROOT, first],
  );
}
const openSession = (page: Page, id: string) =>
  page.evaluate(async (i) => {
    const store = (await import(/* @vite-ignore */ "/src/state/store.ts" as string)) as { getStore(): { actions: { openSession(id: string): void } } };
    store.getStore().actions.openSession(i);
  }, id);
const calls = (page: Page) => page.evaluate(() => ((window as any).__manutPreviewCalls ?? []) as Call[]);
const control = (page: Page, o: Record<string, unknown>) => page.evaluate((v) => Object.assign((window as any).__manutMockPreview, v), o);

/** A lane open beside its chat on Preview. */
async function previewOf(page: Page): Promise<string> {
  const id = await startIn(page, "Add a PromptPay QR to the checkout.");
  await openSession(page, id);
  await page.getByTestId("lane-chip-preview").click();
  await expect(page.getByTestId("lane-preview-start")).toBeVisible();
  return id;
}

/** Start, and wait until it runs at `url`. */
async function running(page: Page, url = STAND) {
  await page.getByTestId("lane-preview-start").click();
  await expect(page.getByTestId("lane-preview-state")).toHaveText(`Running at ${url}`);
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

const frame = (page: Page) => page.frameLocator('[data-testid="lane-preview-frame"]');

/** The walks, in the engine the spec runs. `layout` adds the themes, the narrow window and the languages, which are the app's own
 *  layout rather than the engine's rules for a frame. */
export function previewFrameCases({ layout }: { layout: boolean }): void {
  test.describe("in Practice's fake run", () => {
    let asked: string[] = [];

    test.beforeEach(async ({ page }) => {
      asked = await serve(page);
      await withAppCsp(page);
      await page.addInitScript(
        ([root, url]) => {
          localStorage.removeItem("manut.kit.projects");
          (window as any).__manutBranches = { [root]: "main" };
          (window as any).__manutMockTaken = [];
          // the fake dev server prints the stand-in's address
          (window as any).__manutMockPreview = { projects: {}, mode: "serve", delay: 600, readError: null, startWait: 60_000, url };
        },
        [ROOT, STAND],
      );
      await page.goto("/");
      await openCode(page);
    });

    test("draws the page at the preview's own address in a sandboxed frame that fills the view, with Reload and Open in browser; it goes when the preview stops", async ({ page }) => {
      await previewOf(page);
      await expect(page.locator("iframe")).toHaveCount(0);
      await running(page);
      const el = page.getByTestId("lane-preview-frame");
      await expect(el).toHaveAttribute("src", STAND);
      await expect(el).toHaveAttribute("sandbox", SANDBOX);
      await expect(el).toHaveAttribute("referrerpolicy", "no-referrer");
      await expect(el).toHaveAttribute("title", `The page at ${STAND}`);
      // the one frame on the page, and it shows the stand-in's page
      await expect(page.locator("iframe")).toHaveCount(1);
      await expect(frame(page).getByRole("heading", { name: "New Year gift set" })).toBeVisible();
      await expect(frame(page).locator("#price")).toHaveText("฿590");
      // the app's scripts are not in it, and the top frame is another origin's
      await expect(frame(page).locator("#tauri")).toHaveText("Tauri here: undefined");
      await expect(frame(page).locator("#top")).toHaveText("Top frame: SecurityError");
      // it fills the rest of the view: as wide as the pane's boxes, and down to the pane's foot but for the note under it
      const pane = (await page.getByTestId("lane-pane").boundingBox())!;
      const box = (await page.getByTestId("lane-preview").boundingBox())!;
      const shown = (await el.boundingBox())!;
      expect((await page.getByTestId("lane-preview-page").boundingBox())!.height).toBeGreaterThanOrEqual(320);
      expect(Math.abs(shown.width - box.width)).toBeLessThanOrEqual(4);
      expect(pane.y + pane.height - (shown.y + shown.height)).toBeLessThan(200);
      await expect(page.getByTestId("lane-preview-frame-note")).toHaveText("Pop-ups, downloads and links to other sites do not open here. Open in browser shows the whole page.");
      await fits(page);

      // Reload asks the stand-in for its page again, at the same address
      const loads = () => asked.filter((a) => a === "GET /").length;
      const before = loads();
      await page.getByTestId("lane-preview-reload").click();
      await expect.poll(loads).toBe(before + 1);
      await expect(frame(page).getByRole("heading", { name: "New Year gift set" })).toBeVisible();
      await expect(el).toHaveAttribute("src", STAND);

      await page.getByTestId("lane-preview-open").click();
      await expect(page.getByTestId("lane-preview-open")).toHaveText("Open in browser");
      await expect.poll(async () => (await calls(page)).filter((c) => c.op === "open")).toEqual([{ op: "open", url: STAND }]);

      await page.getByTestId("lane-preview-stop").click();
      await expect(page.locator("iframe")).toHaveCount(0);
      await expect(page.getByTestId("lane-preview-state")).toHaveText("Stopped.");
      await expect(page.getByTestId("lane-preview-reload")).toHaveCount(0);
    });

    test("the page cannot move the app's window or open a window, and a link to another site does not load in the app; its own pages and forms do", async ({ page }) => {
      await previewOf(page);
      await running(page);
      const app = page.url();
      let popups = 0;
      page.on("popup", () => popups++);

      // the top frame: refused by the sandbox, and the app stays where it was
      await frame(page).locator("#go-top").click();
      await expect(frame(page).locator("#moved")).toHaveText("Refused: SecurityError");
      expect(page.url()).toBe(app);
      // a window of its own: none opens
      await frame(page).locator("#open").click();
      await expect(frame(page).locator("#popup")).toHaveText("Window: null");
      expect(popups).toBe(0);

      // its own pages, and a form posted to its own server
      await frame(page).locator("#about").click();
      await expect(frame(page).getByRole("heading", { name: "About the shop" })).toBeVisible();
      await page.getByTestId("lane-preview-reload").click();
      await expect(frame(page).getByRole("heading", { name: "New Year gift set" })).toBeVisible();
      await frame(page).getByRole("button", { name: "Pay" }).click();
      await expect(frame(page).getByRole("heading", { name: "Thank you" })).toBeVisible();
      await expect(frame(page).locator("p")).toHaveText("amount=590");
      await page.getByTestId("lane-preview-reload").click();
      await expect(frame(page).getByRole("heading", { name: "New Year gift set" })).toBeVisible();

      // a link to another site: the app's frame-src refuses it, so it never loads in the app
      await frame(page).locator("#away").click();
      await expect.poll(() => page.evaluate(() => (window as any).__cspRefused as string[])).toContainEqual(expect.stringMatching(/^frame-src https:\/\/example\.com/));
      expect(page.frames().map((f) => f.url()).filter((u) => u.startsWith(AWAY))).toEqual([]);
      expect(asked.filter((a) => a.startsWith("AWAY"))).toEqual([]);
      expect(page.url()).toBe(app);
      expect(popups).toBe(0);
    });

    test("an address that is not this computer's is never put in the frame, nor one the app's CSP cannot name", async ({ page }) => {
      await previewOf(page);
      // only another computer's address printed: the preview never runs at it, and nothing is framed
      await control(page, { url: "http://192.168.1.5:5173/", startWait: 1_500 });
      await page.getByTestId("lane-preview-start").click();
      await expect(page.getByTestId("lane-preview-state")).toHaveText("It is running, but has not printed an address the app can open.", { timeout: 10_000 });
      await expect(page.locator("iframe")).toHaveCount(0);
      await page.getByTestId("lane-preview-stop").click();
      await expect(page.getByTestId("lane-preview-state")).toHaveText("Stopped.");

      // [::1]: an address of this computer, which no frame-src source can name: Open in browser only, and why
      await control(page, { url: "http://[::1]:5374/", startWait: 60_000 });
      await running(page, "http://[::1]:5374/");
      await expect(page.locator("iframe")).toHaveCount(0);
      await expect(page.getByTestId("lane-preview-noframe")).toHaveText("The app shows a page inside it only at localhost. Open this one in your browser.");
      await expect(page.getByTestId("lane-preview-noframe")).toHaveAttribute("data-why", "unnamed");
      await expect(page.getByTestId("lane-preview-reload")).toHaveCount(0);
      await page.getByTestId("lane-preview-open").click();
      await expect.poll(async () => (await calls(page)).filter((c) => c.op === "open").map((c) => c.url)).toEqual(["http://[::1]:5374/"]);
      await page.getByTestId("lane-preview-stop").click();

      // and the stand-in again: framed, at its address and nothing else
      await control(page, { url: STAND });
      await page.getByTestId("lane-preview-start").click();
      await expect(page.getByTestId("lane-preview-frame")).toHaveAttribute("src", STAND);
      const srcs = await page.locator("iframe").evaluateAll((els) => els.map((e) => (e as HTMLIFrameElement).src));
      expect(srcs).toEqual([STAND]);
    });

    test("closing the lane's session stops its preview, and the frame goes with it", async ({ page }) => {
      const id = await previewOf(page);
      await running(page);
      await expect(page.getByTestId("lane-preview-frame")).toBeVisible();
      await page.evaluate((i) => (window as any).__manutSessions.close(i), id);
      await expect(page.locator("iframe")).toHaveCount(0);
      await expect.poll(async () => (await calls(page)).some((c) => c.op === "stop")).toBe(true);
    });

    if (layout) {
      for (const theme of ["light", "dark"] as const) {
        test(`in the ${theme} theme, wide and narrow, the page is drawn whole and nothing is wider than the window`, async ({ page }, info) => {
          await page.evaluate((t) => localStorage.setItem("manut.theme", t), theme);
          await page.reload();
          await openCode(page);
          await previewOf(page);
          await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
          await running(page);
          await expect(frame(page).getByRole("heading", { name: "New Year gift set" })).toBeVisible();
          // the page keeps its own white, as a browser tab shows a page that sets no background
          expect(await page.getByTestId("lane-preview-frame").evaluate((e) => getComputedStyle(e).backgroundColor)).toBe("rgb(255, 255, 255)");
          await fits(page);
          await info.attach(`${theme}-wide`, { body: await page.screenshot(), contentType: "image/png" });

          await page.setViewportSize({ width: 900, height: 760 });
          // under the chat now: the page has a floor of its own, and the pane scrolls to it
          const chat = (await page.getByTestId("session-chat").boundingBox())!;
          const pane = (await page.getByTestId("lane-pane").boundingBox())!;
          expect(pane.y).toBeGreaterThanOrEqual(chat.y + chat.height - 2);
          await page.getByTestId("lane-preview-frame").scrollIntoViewIfNeeded();
          await expect(page.getByTestId("lane-preview-frame")).toBeVisible();
          // the box's floor, borders included
          expect((await page.getByTestId("lane-preview-page").boundingBox())!.height).toBeGreaterThanOrEqual(240);
          await expect(frame(page).getByRole("heading", { name: "New Year gift set" })).toBeVisible();
          await fits(page);
          // two frames, so the picture is of the page after the resize, the frame's own process included
          await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
          await info.attach(`${theme}-narrow`, { body: await page.screenshot(), contentType: "image/png" });
          await page.getByTestId("lane-preview-stop").click();
          await expect(page.locator("iframe")).toHaveCount(0);
        });
      }

      for (const [lang, reload, open, title, why] of [
        ["ko", "새로고침", "브라우저에서 열기", `${STAND} 페이지`, "앱 안에서는 localhost 주소의 페이지만 보여 줘요. 이 주소는 브라우저에서 여세요."],
        ["ja", "再読み込み", "ブラウザで開く", `${STAND} のページ`, "アプリの中に表示できるのは localhost のページだけです。このアドレスはブラウザで開いてください。"],
        ["zh", "重新加载", "在浏览器中打开", `${STAND} 的页面`, "应用里只显示 localhost 上的页面。请在浏览器中打开这个地址。"],
      ] as const) {
        test(`speaks ${lang}`, async ({ page }, info) => {
          await page.evaluate((l) => localStorage.setItem("manut.lang", l), lang);
          await page.reload();
          await openCode(page);
          await previewOf(page);
          await page.getByTestId("lane-preview-start").click();
          await expect(page.getByTestId("lane-preview-frame")).toHaveAttribute("title", title);
          await expect(page.getByTestId("lane-preview-reload")).toHaveText(reload);
          await expect(page.getByTestId("lane-preview-open")).toHaveText(open);
          await expect(frame(page).getByRole("heading", { name: "New Year gift set" })).toBeVisible();
          await fits(page);
          await info.attach(`${lang}`, { body: await page.screenshot(), contentType: "image/png" });
          await page.getByTestId("lane-preview-stop").click();
          await control(page, { url: "http://[::1]:5374/" });
          await page.getByTestId("lane-preview-start").click();
          await expect(page.getByTestId("lane-preview-noframe")).toHaveText(why);
          await expect(page.locator("iframe")).toHaveCount(0);
        });
      }
    }
  });

  test.describe("under a stubbed shell", () => {
    test("the desktop's own host draws the page at the address the shell's run printed, and the frame goes when it stops", async ({ page }) => {
      const asked = await serve(page);
      await withAppCsp(page);
      await page.addInitScript(
        ([root, url]) => {
          localStorage.removeItem("manut.kit.projects");
          (window as any).__manutBranches = { [root]: "main" };
          (window as any).__manutMockTaken = [];
          const sent: { cmd: string; args?: Record<string, unknown> }[] = [];
          (window as any).__shellSent = sent;
          class Channel {
            onmessage: (m: unknown) => void = () => {};
          }
          let run: Channel | null = null;
          const ESC = "\u001b";
          // the shell's four preview commands, as preview.rs answers them; everything the page sends is kept
          (window as any).__manutPreviewShell = {
            Channel,
            invoke: async (cmd: string, args?: Record<string, unknown>) => {
              sent.push({ cmd, args: args && Object.fromEntries(Object.entries(args).filter(([k]) => k !== "onEvent")) });
              if (cmd === "preview_read") return { packageJson: JSON.stringify({ scripts: { dev: "vite" } }), files: ["package.json", "pnpm-lock.yaml"], envExample: null };
              if (cmd === "preview_start") {
                run = args!.onEvent as Channel;
                setTimeout(() => run?.onmessage({ event: "lines", lines: [`  ${ESC}[32mVITE${ESC}[39m v7.1.2  ready in 300 ms`, `  ➜  Local:   ${ESC}[36m${url}${ESC}[39m`] }), 300);
                return 1;
              }
              if (cmd === "preview_stop") {
                setTimeout(() => run?.onmessage({ event: "exit", code: null, stopped: true }), 100);
                return "stopping";
              }
              if (cmd === "preview_open") return null;
              throw new Error(`command ${cmd} not found`);
            },
          };
        },
        [ROOT, STAND],
      );
      await page.goto("/");
      await openCode(page);
      await previewOf(page);
      await running(page);
      await expect(page.getByTestId("lane-preview-frame")).toHaveAttribute("src", STAND);
      await expect(page.getByTestId("lane-preview-frame")).toHaveAttribute("sandbox", SANDBOX);
      await expect(frame(page).getByRole("heading", { name: "New Year gift set" })).toBeVisible();
      expect(asked).toContain("GET /");
      await page.getByTestId("lane-preview-open").click();
      await expect
        .poll(() => page.evaluate(() => ((window as any).__shellSent as { cmd: string; args?: Record<string, unknown> }[]).filter((c) => c.cmd === "preview_open")))
        .toEqual([{ cmd: "preview_open", args: { url: STAND } }]);
      // the mock's fake run never ran: the shell was the stand-in's
      expect(await calls(page)).toEqual([]);
      await page.getByTestId("lane-preview-stop").click();
      await expect(page.getByTestId("lane-preview-state")).toHaveText("Stopped.");
      await expect(page.locator("iframe")).toHaveCount(0);
    });
  });
}
