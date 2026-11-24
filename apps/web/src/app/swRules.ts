/// What the owner's web app's service worker (sw.ts, served as `/app/sw.js`) may answer from its cache, and what it must
/// leave to the network, as plain functions so the rules are tested on their own (docs/web-app.md, "What is cached").
///
/// It caches only the app's own shell: its page (`/app/`), the build's files that page names (`/assets/…`), the app's
/// manifest and icons, and a page that says the phone is offline. Its scope is `/app/`, so it controls no other page: the
/// console (`/ops`) and the pages a link opens (`/approve/`, `/delete/`, `/join/`) never come through it. A request the
/// app's own page makes to any of those, or to the API (`/v1/…`, `/relay/…`), is never answered here, and so never from
/// a cache: a request seen offline could otherwise be answered after it was decided, and an answer must reach the API to
/// count.
///
/// The app's page must not import this file (it names the worker's address itself, src/app/main.tsx): the worker is built
/// as a classic script of its own, and a module both shared would become a chunk the worker cannot import.

export const SW_URL = "/app/sw.js";
export const SW_SCOPE = "/app/";
export const SHELL_URL = "/app/";
export const OFFLINE_URL = "/app/offline.html";
/// The cache's name. A new name, with the worker's code changed, starts a new cache and drops the old one.
export const CACHE_NAME = "manut-app-shell-v1";
export const CACHE_PREFIX = "manut-app-";

/// The app's own files besides its page and the build's: each is cached when the worker is installed.
export const APP_FILES: readonly string[] = [
  OFFLINE_URL,
  "/app/manifest.webmanifest",
  "/app/icons/icon.svg",
  "/app/icons/icon-192.png",
  "/app/icons/icon-512.png",
  "/app/icons/maskable-512.png",
  "/app/icons/apple-touch-icon.png",
];

/// Paths that always go to the network, whatever else holds: the API, the relay, the pages the owner's links open, and
/// the console.
const ALWAYS_NETWORK: readonly RegExp[] = [/^\/v1(\/|$)/, /^\/relay(\/|$)/, /^\/approve(\/|$)/, /^\/delete(\/|$)/,
  /^\/join(\/|$)/, /^\/ops(\/|$)/];

/// The build's files: hashed names, so one never changes under its name.
const BUILT_FILE = /^\/assets\/[^/]+$/;

/// What the worker does with a request: leave it to the network untouched, answer the app's page from the network and
/// from the cache when offline, or answer one of the app's files from the cache first.
export type SwRoute = "network" | "shell" | "file";

/// The few parts of a request the rules read.
export type SwRequest = { url: string; method: string; mode: string };

export function swRoute(request: SwRequest, origin: string): SwRoute {
  if (request.method !== "GET") return "network";
  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    return "network";
  }
  if (url.origin !== origin) return "network";
  const path = url.pathname;
  if (ALWAYS_NETWORK.some((rule) => rule.test(path))) return "network";
  if (request.mode === "navigate") return path === SHELL_URL || path === "/app/index.html" ? "shell" : "network";
  if (APP_FILES.includes(path) || BUILT_FILE.test(path)) return "file";
  return "network";
}

/// The build's files a page names (`src="/assets/…"`, `href="/assets/…"`): its script, its styles and the modules it
/// preloads. What the worker keeps of the build is exactly these.
export function builtFilesIn(html: string): string[] {
  const found = new Set<string>();
  for (const match of html.matchAll(/\b(?:src|href)="(\/assets\/[^"?#]+)"/g)) if (match[1]) found.add(match[1]);
  return [...found];
}

/// The parts of a response the rules read.
export type SwResponse = { ok: boolean; status: number; type: string; redirected: boolean; headers: { get(name: string): string | null } };

/// Whether a response may be kept: a whole answer from this origin (not one that was redirected, which a page's
/// navigation cannot be answered with), and never one the server marked `no-store`.
export function mayKeep(response: SwResponse): boolean {
  return response.ok && response.status === 200 && response.type === "basic" && !response.redirected &&
    !/\bno-store\b/i.test(response.headers.get("cache-control") ?? "");
}

/// Which kept build files the page now names no longer: these are dropped when a newer page arrives.
export function staleFiles(kept: readonly string[], named: readonly string[]): string[] {
  return kept.filter((path) => BUILT_FILE.test(path) && !named.includes(path));
}

/// Whether a cache is one of this worker's, from an older version: dropped when the new one starts.
export function isOldCache(name: string): boolean {
  return name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME;
}
