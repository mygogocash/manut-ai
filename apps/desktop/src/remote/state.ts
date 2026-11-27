// "Reach this Mac from your phone" for the whole app: one RemoteMac (host.ts), built switched off, the person's consent
// and the switch kept on this computer, and the Settings page's view of it.
//
// The switch turns on only after the consent sheet was accepted, at the version of its words the person read
// (`CONSENT_VERSION`, as GoSpark's `RemoteRelayConsent`): when the promise those words make changes, the version goes
// up and everyone is asked again. Until then no key is made and no socket opened. The choice is kept in
// `manut.remote` (the switch and when consent was given, nothing secret), so the app turns it back on at launch
// (`resumeRemote`, from main.tsx) only for a person who turned it on.
import { useSyncExternalStore } from "react";
import { readRuntimeSetting } from "../runtime/setting";
import { getStore } from "../state/store";
import { fromStore, storeActions } from "./fromStore";
import { healthProbe, pageSocket, shellKeyring } from "./fromShell";
import { RemoteMac, type RemoteMacDeps, type RemoteSnapshot } from "./host";
import { localPushStore } from "./push";
import { changes } from "../lib/changes";
import { inTauri } from "../lib/tauri";
import type { DoorEvent, DoorShell } from "./door";

export const REMOTE_KEY = "manut.remote";
/** The version of the consent sheet's words. Raise it whenever their promise changes. */
export const CONSENT_VERSION = 1;

export interface RemoteChoice {
  readonly on: boolean;
  readonly consent: { readonly at: number; readonly version: number } | null;
}

type Storage = Pick<globalThis.Storage, "getItem" | "setItem">;
const browserStore = (): Storage | undefined => (typeof localStorage === "undefined" ? undefined : localStorage);

/** The kept choice. Anything unreadable is off with no consent: the safe reading of "we do not know" is "ask". */
export function readChoice(store: Storage | undefined = browserStore()): RemoteChoice {
  try {
    const raw = store?.getItem(REMOTE_KEY);
    const saved = raw ? (JSON.parse(raw) as { on?: unknown; consent?: { at?: unknown; version?: unknown } | null }) : null;
    const consent = saved?.consent;
    const given = consent && typeof consent.at === "number" && typeof consent.version === "number" ? { at: consent.at, version: consent.version } : null;
    return { on: saved?.on === true, consent: given };
  } catch {
    return { on: false, consent: null };
  }
}

export function writeChoice(choice: RemoteChoice, store: Storage | undefined = browserStore()): void {
  try {
    store?.setItem(REMOTE_KEY, JSON.stringify(choice));
  } catch {
    // Not kept: the switch reads as off at the next launch, which asks nothing it should not.
  }
}

/** Whether the person accepted the sheet as it reads now. */
export function consentCovers(choice: RemoteChoice, version = CONSENT_VERSION): boolean {
  return choice.consent !== null && choice.consent.version >= version;
}

/** The Tailscale road's own choice (item 78f-2b): on or off, and the version of its consent sheet the person accepted. */
export const TAILSCALE_KEY = "manut.remote.tailscale";
/** Raise it whenever the Tailscale sheet's promise changes. */
export const TAILSCALE_CONSENT_VERSION = 1;

export function readTailscaleChoice(store: Storage | undefined = browserStore()): RemoteChoice {
  try {
    const raw = store?.getItem(TAILSCALE_KEY);
    const saved = raw ? (JSON.parse(raw) as { on?: unknown; consent?: { at?: unknown; version?: unknown } | null }) : null;
    const consent = saved?.consent;
    const given = consent && typeof consent.at === "number" && typeof consent.version === "number" ? { at: consent.at, version: consent.version } : null;
    return { on: saved?.on === true, consent: given };
  } catch {
    return { on: false, consent: null };
  }
}

function writeTailscaleChoice(choice: RemoteChoice, store: Storage | undefined = browserStore()): void {
  try {
    store?.setItem(TAILSCALE_KEY, JSON.stringify(choice));
  } catch {
    // Not kept: the road reads as off at the next launch, which opens nothing it should not.
  }
}

/** The shell's door (src-tauri/src/remote_door.rs), in the desktop app only. */
function shellDoor(): DoorShell | undefined {
  if (!inTauri()) return undefined;
  const invoke = async <T>(cmd: string, args?: Record<string, unknown>) => (await import("@tauri-apps/api/core")).invoke<T>(cmd, args);
  return {
    async on(hostId, origin, onEvent) {
      const { Channel } = await import("@tauri-apps/api/core");
      const channel = new Channel<DoorEvent>();
      channel.onmessage = onEvent;
      return invoke<{ name: string; port: number }>("tailscale_door_on", { hostId, origin, onEvent: channel });
    },
    off: () => invoke<void>("tailscale_door_off"),
    devices: (devices) => invoke<boolean>("door_devices", { devices }),
    status: (state) => invoke<boolean>("door_status", { state }),
    send: (stream, data) => invoke<boolean>("door_send", { stream, data }),
    close: (stream) => invoke<boolean>("door_close", { stream }),
  };
}

let remote: RemoteMac | null = null;
let snapshot: RemoteSnapshot | null = null;
const listeners = changes();

/** The app's RemoteMac, made the first time it is asked for. Making it opens nothing. */
export function remoteMac(deps?: RemoteMacDeps): RemoteMac {
  if (remote) return remote;
  let made: RemoteMac;
  if (deps) made = new RemoteMac(deps);
  else {
    const setting = readRuntimeSetting();
    const origin = setting.mode === "connected" ? setting.origin : null;
    const store = getStore();
    made = new RemoteMac({
      keyring: shellKeyring(),
      origin,
      connect: pageSocket,
      probe: origin ? healthProbe(origin) : async () => "unknown",
      chats: fromStore(store),
      actions: storeActions(store),
      now: () => Date.now(),
      door: shellDoor(),
      pushes: localPushStore(),
    });
    // Phones watching a chat hear what moved, a quarter of a second at most after the store changed.
    let pending: ReturnType<typeof setTimeout> | null = null;
    store.subscribe(() => {
      if (pending !== null || !made.isOn) return;
      pending = setTimeout(() => {
        pending = null;
        made.publish();
      }, 250);
    });
  }
  remote = made;
  snapshot = made.snapshot();
  made.subscribe((next) => {
    snapshot = next;
    listeners.emit();
  });
  return made;
}

/** For tests: forget the app's RemoteMac. */
export function resetRemoteForTests(): void {
  remote?.turnOff();
  remote = null;
  snapshot = null;
}

/** The person accepted the sheet and turned the switch on. */
export async function acceptAndTurnOn(now = Date.now()): Promise<void> {
  writeChoice({ on: true, consent: { at: now, version: CONSENT_VERSION } });
  await remoteMac().turnOn();
}

/** The switch went on with consent already given. Refused (false) without it: the page shows the sheet instead. */
export async function turnOn(): Promise<boolean> {
  const choice = readChoice();
  if (!consentCovers(choice)) return false;
  writeChoice({ ...choice, on: true });
  await remoteMac().turnOn();
  return true;
}

export function turnOff(): void {
  writeChoice({ ...readChoice(), on: false });
  remote?.turnOff();
}

/** The person accepted the Tailscale sheet and turned the road on. */
export async function acceptTailscaleAndTurnOn(now = Date.now()): Promise<boolean> {
  writeTailscaleChoice({ on: true, consent: { at: now, version: TAILSCALE_CONSENT_VERSION } });
  return remoteMac().turnTailscaleOn();
}

/** The Tailscale road went on with its consent already given; refused (false) without it, and the page shows the sheet. */
export async function turnTailscaleOn(): Promise<boolean> {
  const choice = readTailscaleChoice();
  if (!consentCovers(choice, TAILSCALE_CONSENT_VERSION)) return false;
  writeTailscaleChoice({ ...choice, on: true });
  return remoteMac().turnTailscaleOn();
}

export function turnTailscaleOff(): void {
  writeTailscaleChoice({ ...readTailscaleChoice(), on: false });
  remote?.turnTailscaleOff();
}

/** At launch: turns the switch back on only for a person who turned it on, under the sheet as it reads now, and then the
 *  Tailscale road only for a person who turned that on too, under its own sheet. */
export function resumeRemote(): void {
  const choice = readChoice();
  if (!(choice.on && consentCovers(choice))) return;
  const ts = readTailscaleChoice();
  void remoteMac()
    .turnOn()
    .then(() => (ts.on && consentCovers(ts, TAILSCALE_CONSENT_VERSION) ? remoteMac().turnTailscaleOn() : false))
    .catch(() => undefined);
}

function subscribe(listener: () => void): () => void {
  return listeners.subscribe(listener);
}

/** The Settings page's view, kept the same object until something changes. */
export function useRemote(): RemoteSnapshot {
  return useSyncExternalStore(subscribe, () => {
    if (!snapshot) remoteMac();
    return snapshot as RemoteSnapshot;
  });
}
