/// The Your Mac tab's backend where the page runs on the API's own origin: the relay there, the vault in this origin's
/// IndexedDB, and the browser's passkeys. The API's tests build the same backend with a socket into workerd, a vault in
/// memory and a stand-in passkey (apps/api/test/remote-phone.test.ts), so the code they drive is this code.
import { pairWithMac } from "./pair";
import type { PhonePush } from "./notify";
import type { Passkeys } from "./passkeys";
import { type PhoneConnect, type Timers, systemTimers } from "./relay";
import type { MacBackend } from "./remote";
import { openSession } from "./session";
import type { PhoneVault } from "./vault";

export interface LiveParams {
  /// This page's origin, whose relay is dialled and whose host the passkey is made for.
  readonly origin: string;
  readonly connect: PhoneConnect;
  readonly vault: PhoneVault;
  readonly passkeys: Passkeys;
  /// Whether the relay is switched on: the API's public health answer (`relay: "on" | "off"`).
  relay(): Promise<"on" | "off" | "unknown">;
  /// The push key the API offers (item 78d), and the browser's notifications, when there are both.
  pushKey?(): Promise<string | null>;
  readonly push?: PhonePush;
  /// This phone's name for the Mac's list, and the passkey's name in the phone's passwords.
  readonly name: string;
  readonly label: string;
  readonly now?: () => number;
  readonly timers?: Timers;
}

export function liveBackend(params: LiveParams): MacBackend {
  const now = params.now ?? (() => Date.now());
  const timers = params.timers ?? systemTimers;
  const rpId = new URL(params.origin).hostname;
  return {
    relay: params.relay,
    ...(params.pushKey ? { pushKey: params.pushKey } : {}),
    ...(params.push ? { push: params.push } : {}),
    vault: params.vault,
    passkeys: params.passkeys,
    now,
    timers,
    pair: (text, onStep) =>
      pairWithMac(
        { origin: params.origin, rpId, connect: params.connect, vault: params.vault, passkeys: params.passkeys, name: params.name, label: params.label, now, timers },
        text,
        onStep,
      ),
    connect: async (mac) => {
      const opened = await openSession({ origin: params.origin, connect: params.connect, timers }, mac);
      return opened.ok ? { ok: true, link: opened.session } : opened;
    },
  };
}

/// What the API's public health answer on this origin says for the Your Mac tab: the relay's switch, and the push key a
/// phone subscribes with (item 78d), offered only while the relay is on and its key is set. Anything unreadable is
/// unknown, which the tab treats as off, and no key.
export async function healthOf(origin: string, fetcher: typeof fetch = fetch): Promise<{ relay: "on" | "off" | "unknown"; webPush: string | null }> {
  try {
    const response = await fetcher(`${origin}/v1/health`, { headers: { accept: "application/json" }, cache: "no-store" });
    if (!response.ok) return { relay: "unknown", webPush: null };
    const body = (await response.json()) as { relay?: unknown; webPush?: unknown };
    const relay = body.relay === "on" || body.relay === "off" ? body.relay : "unknown";
    // An uncompressed P-256 point, base64url: 65 bytes are 87 characters.
    const webPush = relay === "on" && typeof body.webPush === "string" && /^[A-Za-z0-9_-]{87}$/.test(body.webPush) ? body.webPush : null;
    return { relay, webPush };
  } catch {
    return { relay: "unknown", webPush: null };
  }
}
