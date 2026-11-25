// The desktop shell's side of reaching this Mac from a phone: the `remote` keychain item through remote_keys.rs's five
// commands, the page's own WebSocket for the relay (the app's content policy lets it reach `wss://*.manut.xyz`), and the
// API's public health answer, read through the shell's request command, for whether the relay is switched on.
import { type FetchLike, shellFetch } from "../runtime/http/shell";
import type { KeyDoc, Keyring } from "./keys";
import { type RelayProbe, type RelaySocket, type SocketFactory, relayFromHealth } from "./link";

const inShell = () => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (!inShell()) throw new Error("unavailable");
  const core = await import("@tauri-apps/api/core");
  return core.invoke<T>(cmd, args);
}

/** The document the shell gave, when it is one this build reads; the shell has already checked every field. */
export function readKeyDoc(text: string | null): KeyDoc | null {
  if (!text) return null;
  try {
    const doc = JSON.parse(text) as KeyDoc;
    return doc && doc.v === 1 && Array.isArray(doc.devices) ? doc : null;
  } catch {
    return null;
  }
}

/** The `remote` keychain item. Outside the desktop app every call fails, and the page keeps nothing. */
export function shellKeyring(): Keyring {
  return {
    read: async () => readKeyDoc(await invoke<string | null>("remote_keys_read")),
    setHost: (host) => invoke<void>("remote_keys_set_host", { host }),
    addDevice: (device) => invoke<void>("remote_keys_add_device", { device }),
    touchDevice: (id, lastSeen, signCount) => invoke<void>("remote_keys_touch_device", { id, lastSeen, signCount }),
    removeDevice: (id) => invoke<void>("remote_keys_remove_device", { id }),
  };
}

/** The page's WebSocket. */
export const pageSocket: SocketFactory = (url) => new WebSocket(url) as unknown as RelaySocket;

/** Whether the API at `origin` has its relay on, from its public health answer. Anything unreadable is `unknown`, which
 *  the link treats as a relay that may be on. */
export function healthProbe(origin: string, fetch: FetchLike = shellFetch()): RelayProbe {
  return async () => {
    try {
      const answer = await fetch(`${origin}/v1/health`, { method: "GET", headers: {} });
      if (answer.status !== 200) return "unknown";
      return relayFromHealth(JSON.parse(await answer.text()) as unknown);
    } catch {
      return "unknown";
    }
  };
}
