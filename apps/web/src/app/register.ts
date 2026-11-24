/// Where the owner's web app's service worker is, what it controls, and registering it (docs/web-app.md).
///
/// These are named here rather than imported from the worker's rules (swRules.ts, `SW_URL` and `SW_SCOPE`, which a test
/// holds them to): a module both the page and the worker imported would be built as a chunk of its own, and the worker,
/// a classic script, could not import it.
export const WORKER = { url: "/app/sw.js", scope: "/app/" } as const;

/// Registers the worker, when the browser has workers. `updateViaCache: "none"` makes the browser read the worker's file
/// from the network each time it checks for a new one. A registration that fails leaves the app working, uncached.
export function registerWorker(container: ServiceWorkerContainer | undefined = navigator.serviceWorker): void {
  if (!container) return;
  void container.register(WORKER.url, { scope: WORKER.scope, updateViaCache: "none" }).catch(() => undefined);
}
