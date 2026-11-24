import {
  APP_FILES,
  builtFilesIn,
  CACHE_NAME,
  isOldCache,
  mayKeep,
  OFFLINE_URL,
  SHELL_URL,
  staleFiles,
  swRoute,
} from "./swRules";

/// The owner's web app's service worker, built to `/app/sw.js` as a classic script of its own (vite.config.ts) and
/// registered with the scope `/app/` (main.tsx). Its rules are swRules.ts's; this file only wires them to the worker's
/// events. It caches the app's shell so the app opens offline and says so, and nothing else: a request it does not answer
/// goes to the network exactly as it would with no worker, which is what every request to the API does.

/// The worker's events and globals this file uses, typed here rather than with TypeScript's worker library, which cannot
/// sit beside the DOM library the rest of the app is checked with.
type Waits = Event & { waitUntil(work: Promise<unknown>): void };
type Fetching = Waits & { request: Request; respondWith(answer: Promise<Response>): void };
type Worker = {
  location: Location;
  skipWaiting(): Promise<void>;
  clients: { claim(): Promise<void> };
  addEventListener(type: "install" | "activate", listener: (event: Waits) => void): void;
  addEventListener(type: "fetch", listener: (event: Fetching) => void): void;
};
const worker = self as unknown as Worker;

/// Keeps the page, the build's files it names and the app's own files, so the app opens offline from its first install.
async function install(): Promise<void> {
  const cache = await caches.open(CACHE_NAME);
  const page = await fetch(SHELL_URL, { cache: "reload" });
  if (!mayKeep(page)) throw new Error("the app's page could not be kept");
  const named = builtFilesIn(await page.clone().text());
  await cache.put(SHELL_URL, page);
  await cache.addAll([...APP_FILES, ...named]);
}

/// Drops the caches of older versions of this worker.
async function activate(): Promise<void> {
  for (const name of await caches.keys()) if (isOldCache(name)) await caches.delete(name);
}

/// The app's page: from the network, kept for when the phone is offline; offline, the kept page, or the offline page.
async function shell(request: Request): Promise<Response> {
  const cache = await caches.open(CACHE_NAME);
  try {
    const page = await fetch(request);
    if (mayKeep(page)) {
      const named = builtFilesIn(await page.clone().text());
      await cache.put(SHELL_URL, page.clone());
      // A newer page names newer files: keep those, and drop the ones it no longer names.
      const kept = (await cache.keys()).map((key) => new URL(key.url).pathname);
      for (const stale of staleFiles(kept, named)) await cache.delete(stale);
      await Promise.all(named.filter((path) => !kept.includes(path)).map(async (path) => {
        const file = await fetch(path).catch(() => null);
        if (file && mayKeep(file)) await cache.put(path, file);
      }));
    }
    return page;
  } catch {
    return (await cache.match(SHELL_URL)) ?? (await cache.match(OFFLINE_URL)) ??
      new Response("Manut AI is offline.", { status: 503, headers: { "content-type": "text/plain; charset=utf-8" } });
  }
}

/// One of the app's files: from the cache, else from the network and kept.
async function file(request: Request): Promise<Response> {
  const cache = await caches.open(CACHE_NAME);
  const kept = await cache.match(request);
  if (kept) return kept;
  const fetched = await fetch(request);
  if (mayKeep(fetched)) await cache.put(request, fetched.clone());
  return fetched;
}

worker.addEventListener("install", (event) => {
  event.waitUntil(install().then(() => worker.skipWaiting()));
});

worker.addEventListener("activate", (event) => {
  event.waitUntil(activate().then(() => worker.clients.claim()));
});

worker.addEventListener("fetch", (event) => {
  const { request } = event;
  const route = swRoute({ url: request.url, method: request.method, mode: request.mode }, worker.location.origin);
  if (route === "shell") event.respondWith(shell(request));
  else if (route === "file") event.respondWith(file(request));
  // Anything else is not answered here, so the browser asks the network as if there were no worker.
});
