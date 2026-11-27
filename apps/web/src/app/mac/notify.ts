/// "Tell me when my Mac needs me" (item 78d, docs/remote-access.md, "Push"): the browser's own notifications and Web Push,
/// for the Your Mac tab. The phone subscribes with the push key the API offers (`webPush` in its public health answer,
/// live.ts), and the subscription's endpoint, its push address, goes to the Mac inside the encrypted channel (remote.ts,
/// `notify`), never to the API in the clear. The Mac hands it to the relay, which wakes this phone with a push that
/// carries nothing; the app's service worker then shows "Your Mac needs you" and nothing else (sw.ts, swPush.ts).
///
/// Safari asks for notification permission only from a person's tap, so `subscribe` asks before it awaits anything, and
/// the tab calls it straight from the switch's tap. On an iPhone the Push API exists only in the app opened from the
/// Home Screen (iOS 16.4 and later), so Safari's own tab reads as not supported.
import { fromBase64Url } from "@manut/remote-channel";
import { WORKER } from "../register";

export type SubscribeResult = { readonly ok: true; readonly endpoint: string } | { readonly ok: false; readonly why: "denied" | "failed" };

export interface PhonePush {
  /// Whether this browser can be told at all: a service worker, the Push API and notifications.
  supported(): boolean;
  /// The push address of this app's subscription now, or null when there is none.
  current(): Promise<string | null>;
  /// Asks for permission (call it straight from a tap) and subscribes with the API's push key.
  subscribe(key: string): Promise<SubscribeResult>;
  /// Ends this app's subscription, so its push address no longer reaches this phone.
  unsubscribe(): Promise<void>;
}

/// Whether two keys are the same bytes.
function sameKey(a: ArrayBuffer | null | undefined, b: Uint8Array): boolean {
  if (!a || a.byteLength !== b.length) return false;
  const bytes = new Uint8Array(a);
  return bytes.every((byte, i) => byte === b[i]);
}

/// The browser's own: the app's service worker registration (`/app/`, register.ts) and its push manager.
export function browserPush(): PhonePush {
  const registration = async (): Promise<ServiceWorkerRegistration | null> =>
    (await navigator.serviceWorker.getRegistration(WORKER.scope).catch(() => undefined)) ?? null;
  return {
    supported: () =>
      typeof window !== "undefined" && typeof navigator !== "undefined" && "serviceWorker" in navigator && "PushManager" in window && "Notification" in window,
    current: async () => {
      const subscription = await (await registration())?.pushManager.getSubscription().catch(() => null);
      return subscription?.endpoint ?? null;
    },
    subscribe: async (key) => {
      // First, before any await, so Safari takes it as coming from the tap.
      const permission = Notification.requestPermission();
      try {
        if ((await permission) !== "granted") return { ok: false, why: "denied" };
        const found = await registration();
        if (!found) return { ok: false, why: "failed" };
        const serverKey = fromBase64Url(key);
        const existing = await found.pushManager.getSubscription();
        // A subscription made with another key (the API's key changed) cannot be reused, and a new one is refused while it
        // stands, so it goes first.
        if (existing && !sameKey(existing.options.applicationServerKey, serverKey)) await existing.unsubscribe();
        else if (existing) return { ok: true, endpoint: existing.endpoint };
        const subscription = await found.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: serverKey as Uint8Array<ArrayBuffer> });
        return { ok: true, endpoint: subscription.endpoint };
      } catch {
        return { ok: false, why: "failed" };
      }
    },
    unsubscribe: async () => {
      const subscription = await (await registration())?.pushManager.getSubscription().catch(() => null);
      await subscription?.unsubscribe().catch(() => false);
    },
  };
}
