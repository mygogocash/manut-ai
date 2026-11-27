// The owner's web app's service worker, as its rules (src/app/swRules.ts): it answers from its cache only the app's own
// page and files, and never touches the API, the relay, the pages the owner's links open or the console; and the app's
// page, manifest and offline page as built (public/app, app/index.html).
import { describe, expect, it } from "vitest";
import appPage from "../app/index.html?raw";
import manifestText from "../public/app/manifest.webmanifest?raw";
import offlinePage from "../public/app/offline.html?raw";
import { WORKER } from "../src/app/register";
import workerSource from "../src/app/sw.ts?raw";
import { en } from "../src/app/strings";
import { MAC_URL, PUSH_TITLE, pushNotice, windowToOpen } from "../src/app/swPush";
import {
  APP_FILES,
  builtFilesIn,
  CACHE_NAME,
  isOldCache,
  mayKeep,
  OFFLINE_URL,
  SHELL_URL,
  staleFiles,
  SW_SCOPE,
  SW_URL,
  swRoute,
} from "../src/app/swRules";

const ORIGIN = "https://dev.manut.xyz";
const get = (path: string, mode = "cors") => ({ url: `${ORIGIN}${path}`, method: "GET", mode });

describe("what the worker may answer", () => {
  it("answers the app's page from the network first, and its own files and the build's from the cache first", () => {
    expect(swRoute(get("/app/", "navigate"), ORIGIN)).toBe("shell");
    expect(swRoute(get("/app/?demo=sign-in-off", "navigate"), ORIGIN)).toBe("shell");
    expect(swRoute(get("/app/index.html", "navigate"), ORIGIN)).toBe("shell");
    for (const path of APP_FILES) expect(swRoute(get(path, "no-cors"), ORIGIN), path).toBe("file");
    expect(swRoute(get("/assets/app-BnR3Rny9.js"), ORIGIN)).toBe("file");
    expect(swRoute(get("/assets/strings-COoj1UZq.css"), ORIGIN)).toBe("file");
  });

  it("never touches the API, the relay, the links' pages or the console, whatever the request is", () => {
    const never = ["/v1/web/shops", "/v1/web/approvals?shop=pilot%3Aa&state=open", "/v1/web/approvals/req-1/decision",
      "/v1/approvals?state=open", "/v1/pilot/approvals/token-1", "/v1", "/relay/v1/hosts/h/phone", "/approve/token-1",
      "/approve", "/delete/token-2", "/join/token-3", "/ops", "/ops/", "/app/../v1/web/shops", "/assets/../v1/approvals",
      "/assets/%2e%2e/v1/approvals"];
    for (const path of never) {
      for (const mode of ["navigate", "cors", "no-cors", "same-origin"]) {
        expect(swRoute(get(path, mode), ORIGIN), `${mode} ${path}`).toBe("network");
      }
    }
  });

  it("leaves to the network every change, every other origin, and every other page or file", () => {
    for (const method of ["POST", "PUT", "DELETE", "HEAD"]) {
      expect(swRoute({ url: `${ORIGIN}/app/`, method, mode: "navigate" }, ORIGIN), method).toBe("network");
      expect(swRoute({ url: `${ORIGIN}/assets/app.js`, method, mode: "cors" }, ORIGIN), method).toBe("network");
    }
    expect(swRoute(get("/app/"), "https://other.example")).toBe("network");
    expect(swRoute({ url: "https://fonts.googleapis.com/css2?family=Geist", method: "GET", mode: "no-cors" }, ORIGIN)).toBe("network");
    expect(swRoute(get("/app/elsewhere", "navigate"), ORIGIN)).toBe("network");
    expect(swRoute(get("/", "navigate"), ORIGIN)).toBe("network");
    expect(swRoute(get("/app/sw.js"), ORIGIN)).toBe("network");
    expect(swRoute(get("/assets/nested/file.js"), ORIGIN)).toBe("network");
    expect(swRoute({ url: "not a url", method: "GET", mode: "cors" }, ORIGIN)).toBe("network");
  });

  it("keeps only a whole answer from this origin that was not redirected or marked no-store", () => {
    const answer = (over: Partial<Parameters<typeof mayKeep>[0]> = {}, cacheControl: string | null = null) =>
      ({ ok: true, status: 200, type: "basic", redirected: false, headers: { get: () => cacheControl }, ...over });
    expect(mayKeep(answer())).toBe(true);
    expect(mayKeep(answer({}, "public, max-age=0, must-revalidate"))).toBe(true);
    expect(mayKeep(answer({}, "no-store"))).toBe(false);
    expect(mayKeep(answer({}, "private, No-Store"))).toBe(false);
    expect(mayKeep(answer({ type: "opaque" }))).toBe(false);
    expect(mayKeep(answer({ type: "cors" }))).toBe(false);
    expect(mayKeep(answer({ redirected: true }))).toBe(false);
    expect(mayKeep(answer({ ok: false, status: 404 }))).toBe(false);
    expect(mayKeep(answer({ status: 206 }))).toBe(false);
  });

  it("keeps the build's files the page names, and drops the ones a newer page no longer names", () => {
    const html = '<script type="module" crossorigin src="/assets/app-1.js"></script><link rel="modulepreload" href="/assets/s-2.js">' +
      '<link rel="stylesheet" href="/assets/s-3.css"><link rel="manifest" href="/app/manifest.webmanifest"><img src="https://x.example/assets/y.png">';
    expect(builtFilesIn(html)).toEqual(["/assets/app-1.js", "/assets/s-2.js", "/assets/s-3.css"]);
    expect(staleFiles(["/app/", "/assets/app-0.js", "/assets/s-2.js", OFFLINE_URL], ["/assets/app-1.js", "/assets/s-2.js"]))
      .toEqual(["/assets/app-0.js"]);
    expect(isOldCache("manut-app-shell-v0")).toBe(true);
    expect(isOldCache(CACHE_NAME)).toBe(false);
    expect(isOldCache("someone-else")).toBe(false);
  });

  it("is registered where its rules say, controlling the app and nothing else", () => {
    expect(WORKER).toEqual({ url: SW_URL, scope: SW_SCOPE });
    expect(SW_SCOPE).toBe("/app/");
    expect(SHELL_URL).toBe(SW_SCOPE);
    expect(SW_URL.startsWith(SW_SCOPE)).toBe(true);
  });
});

describe("the app as a phone installs it", () => {
  it("names Manut AI, opens standalone at its own scope, and draws its icons from the brand's mark", () => {
    const manifest = JSON.parse(manifestText) as Record<string, unknown> & { icons: { src: string; purpose: string; sizes: string }[] };
    expect(manifest).toMatchObject({ name: "Manut AI", short_name: "Manut AI", id: "/app/", start_url: "/app/", scope: "/app/",
      display: "standalone", background_color: "#FBFAF7", theme_color: "#FBFAF7" });
    expect(manifest.icons.map((icon) => [icon.src, icon.sizes, icon.purpose])).toEqual([
      ["/app/icons/icon.svg", "any", "any"],
      ["/app/icons/icon-192.png", "192x192", "any"],
      ["/app/icons/icon-512.png", "512x512", "any"],
      ["/app/icons/maskable-512.png", "512x512", "maskable"],
    ]);
    for (const icon of manifest.icons) expect(APP_FILES).toContain(icon.src);
  });

  it("names its manifest, icons and theme on its own page, and nothing on another origin", () => {
    expect(appPage).toContain('<link rel="manifest" href="/app/manifest.webmanifest">');
    expect(appPage).toContain('<link rel="apple-touch-icon" href="/app/icons/apple-touch-icon.png">');
    expect(appPage).toContain('<meta name="theme-color" content="#FBFAF7" media="(prefers-color-scheme: light)">');
    expect(appPage).toContain('<meta name="theme-color" content="#171716" media="(prefers-color-scheme: dark)">');
    expect(appPage).toContain('<div id="root"></div>');
    for (const page of [appPage, offlinePage]) expect(page).not.toMatch(/(?:href|src)="(?:https?:)?\/\//);
    // The offline page stands alone: no script and nothing it would have to fetch, but the app it links back to.
    expect(offlinePage).not.toMatch(/<script|<link/);
    expect([...offlinePage.matchAll(/(?:href|src)="([^"]+)"/g)].map((match) => match[1])).toEqual(["/app/"]);
  });
});

describe("what a push shows (item 78d)", () => {
  it("is always the same few words, the strings table's own, with nothing from the push and no body", () => {
    expect(PUSH_TITLE).toBe(en.mac.pushTitle);
    expect(PUSH_TITLE).toBe("Your Mac needs you");
    const notice = pushNotice();
    expect(notice).toEqual({ tag: "manut-mac", renotify: true, icon: "/app/icons/icon-192.png" });
    expect(Object.keys(notice)).not.toContain("body");
    expect(Object.keys(notice)).not.toContain("data");
    // Its icon is one of the app's own files, kept for offline.
    expect(APP_FILES).toContain(notice.icon);
  });

  it("opens the Your Mac tab, in a window of the app when one is open", () => {
    expect(MAC_URL).toBe(`${SW_SCOPE}#mac`);
    expect(windowToOpen([`${ORIGIN}/ops`, `${ORIGIN}/app/#today`, `${ORIGIN}/app/`], ORIGIN)).toBe(1);
    expect(windowToOpen([`${ORIGIN}/approve/x`, "https://other.example/app/", "not a url"], ORIGIN)).toBe(-1);
    expect(windowToOpen([], ORIGIN)).toBe(-1);
  });

  it("is wired in the worker to the push and the click, and reads nothing a push carries", () => {
    expect(workerSource).toContain('addEventListener("push"');
    expect(workerSource).toContain('addEventListener("notificationclick"');
    expect(workerSource).toContain("showNotification(PUSH_TITLE, pushNotice())");
    expect(workerSource).not.toMatch(/\.data\b/);
  });
});
