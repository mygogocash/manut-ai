// Which runtime this computer chose in Settings › Developer: Practice, the in-process demo (`src/runtime/mock`), or
// Connected, the read-only runtime over `apps/api` at one origin (`src/runtime/http`). Practice is the default, so a
// fresh install never reaches a network, and Practice never shows real shop data.
//
// The choice is kept in `manut.runtime` on this computer. It holds the mode and the origin and never a token: the
// session lives in the operating system's keychain through the desktop shell (`src/runtime/http/shell.ts`). The app
// reads the choice once at start, because the store is built around one runtime; Settings restarts the page to apply
// a new one.

export const RUNTIME_KEY = "manut.runtime";

export type RuntimeSetting = { mode: "practice" } | { mode: "connected"; origin: string };

export type OriginRefusal = "empty" | "not_url" | "not_https" | "has_path" | "has_credentials";

/** The hosts plain http may name: this computer, where `wrangler dev` serves the API. Anything that leaves the
 *  computer must be https, so a session token never crosses a network in the clear. */
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** `text` as an API origin (`https://host[:port]`), or why it is not one. A bare host is read as https. */
export function parseOrigin(text: string): { ok: true; origin: string } | { ok: false; reason: OriginRefusal } {
  const raw = text.trim();
  if (!raw) return { ok: false, reason: "empty" };
  let url: URL;
  try {
    url = new URL(raw.includes("://") ? raw : `https://${raw}`);
  } catch {
    return { ok: false, reason: "not_url" };
  }
  if (!url.hostname) return { ok: false, reason: "not_url" };
  // A user name before the host makes an address read as one place and go to another, so none is accepted.
  if (url.username || url.password) return { ok: false, reason: "has_credentials" };
  if (url.protocol !== "https:" && !(url.protocol === "http:" && LOOPBACK.has(url.hostname))) return { ok: false, reason: "not_https" };
  // The runtime adds `/v1/...` itself, so an origin with a path, a query or a fragment would send requests elsewhere.
  if (url.pathname !== "/" || url.search || url.hash || raw.endsWith("?") || raw.endsWith("#")) return { ok: false, reason: "has_path" };
  return { ok: true, origin: `${url.protocol}//${url.host}` };
}

/** The host and port of an origin, as the mode line names it ("dev.manut.xyz"). */
export function hostOf(origin: string): string {
  try {
    return new URL(origin).host;
  } catch {
    return origin;
  }
}

type Readable = Pick<Storage, "getItem">;
type Writable = Pick<Storage, "setItem">;
const browserStore = (): Storage | undefined => (typeof localStorage === "undefined" ? undefined : localStorage);

/** The saved choice; Practice when nothing usable is saved. An origin is checked again on every read, so a value
 *  edited by hand can never point the runtime somewhere `parseOrigin` would refuse. */
export function readRuntimeSetting(store: Readable | undefined = browserStore()): RuntimeSetting {
  let saved: unknown;
  try {
    const raw = store?.getItem(RUNTIME_KEY);
    saved = raw ? JSON.parse(raw) : null;
  } catch {
    return { mode: "practice" };
  }
  if (!saved || typeof saved !== "object" || Array.isArray(saved)) return { mode: "practice" };
  const { mode, origin } = saved as { mode?: unknown; origin?: unknown };
  if (mode !== "connected" || typeof origin !== "string") return { mode: "practice" };
  const parsed = parseOrigin(origin);
  return parsed.ok ? { mode: "connected", origin: parsed.origin } : { mode: "practice" };
}

/** Saves the choice. Throws for an origin `readRuntimeSetting` would not read back, so a bad value is never stored. */
export function writeRuntimeSetting(setting: RuntimeSetting, store: Writable | undefined = browserStore()): void {
  let value: RuntimeSetting = { mode: "practice" };
  if (setting.mode === "connected") {
    const parsed = parseOrigin(setting.origin);
    if (!parsed.ok) throw new Error(`not an API origin: ${parsed.reason}`);
    value = { mode: "connected", origin: parsed.origin };
  }
  store?.setItem(RUNTIME_KEY, JSON.stringify(value));
}
