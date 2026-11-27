// The phone's second road on the page's side (item 78f-2b, docs/remote-access.md, "The second road: Tailscale"): the
// shell's door (`src-tauri/src/remote_door.rs`, 127.0.0.1 behind `tailscale serve`) seen as a link, with the same methods
// the relay's link has, so the host serves a phone that came by the tailnet exactly as one that came by the relay.
//
// The shell holds the door and decides nothing of the session: it is told which devices may come in (the same ids and
// token hashes the relay is told) and what a new phone hears about the Mac, and it hands over each stream's `open`, frames
// and `close`. The frames are `@manut/remote-channel`'s sealed records, which the shell cannot read; only this page and the
// phone hold the keys. A frame crosses the Tauri channel in standard base64.
//
// `DoorShell` is the shell's side behind one interface, so the tests drive the link with a stand-in.
import type { LinkEvents, RelayPresence } from "./link";

/** What the shell hands the page over the door's channel. */
export type DoorEvent =
  | { t: "open"; stream: number; device: string }
  | { t: "frame"; stream: number; data: string }
  | { t: "close"; stream: number; reason: string };

/** The shell's door commands (`tailscale_door_on` and the rest). */
export interface DoorShell {
  /** Starts the door and has Tailscale serve it; the Mac's tailnet name and the door's port. Rejects with why it did not. */
  on(hostId: string, origin: string, onEvent: (e: DoorEvent) => void): Promise<{ name: string; port: number }>;
  off(): Promise<void>;
  devices(list: { id: string; tokenHash: string }[]): Promise<boolean>;
  status(state: RelayPresence): Promise<boolean>;
  send(stream: number, data: string): Promise<boolean>;
  close(stream: number): Promise<boolean>;
}

export const toBase64 = (b: Uint8Array): string => {
  let s = "";
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s);
};

export const fromBase64 = (s: string): Uint8Array | null => {
  try {
    const bin = atob(s);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
};

/** The events the host hands a road: a stream opened, a frame on it, and its close. */
export type RoadEvents = Pick<LinkEvents, "onOpen" | "onFrame" | "onClose">;

export class DoorLink {
  readonly #shell: DoorShell;
  readonly #hostId: string;
  readonly #origin: string;
  readonly #events: RoadEvents;
  readonly #devices = new Map<string, string>();
  #presence: RelayPresence = "available";
  #open = false;

  constructor(p: { shell: DoorShell; hostId: string; origin: string; events: RoadEvents }) {
    this.#shell = p.shell;
    this.#hostId = p.hostId;
    this.#origin = p.origin;
    this.#events = p.events;
  }

  /** Starts the door and Tailscale's serving of it, then tells it the devices and the Mac's state as they are now. */
  async open(): Promise<{ name: string; port: number }> {
    const served = await this.#shell.on(this.#hostId, this.#origin, (e) => this.#heard(e));
    this.#open = true;
    await this.#shell.devices(this.#list());
    await this.#shell.status(this.#presence);
    return served;
  }

  #heard(e: DoorEvent): void {
    if (!this.#open && e.t !== "open") return;
    if (e.t === "open" && typeof e.stream === "number" && typeof e.device === "string") this.#events.onOpen(e.stream, e.device);
    else if (e.t === "frame" && typeof e.stream === "number") {
      const bytes = fromBase64(e.data);
      if (bytes) this.#events.onFrame(e.stream, bytes);
    } else if (e.t === "close" && typeof e.stream === "number") this.#events.onClose(e.stream, typeof e.reason === "string" ? e.reason : "closed");
  }

  #list(): { id: string; tokenHash: string }[] {
    return [...this.#devices].map(([id, tokenHash]) => ({ id, tokenHash }));
  }

  start(): void {}

  /** Tailscale stops serving the door, and the door closes every phone. */
  stop(): void {
    this.#open = false;
    void this.#shell.off().catch(() => undefined);
  }

  allowDevice(id: string, tokenHash: string): void {
    this.#devices.set(id, tokenHash);
    if (this.#open) void this.#shell.devices(this.#list()).catch(() => undefined);
  }

  revokeDevice(id: string): void {
    this.#devices.delete(id);
    if (this.#open) void this.#shell.devices(this.#list()).catch(() => undefined);
  }

  setPresence(state: RelayPresence, _at: number): void {
    this.#presence = state;
    if (this.#open) void this.#shell.status(state).catch(() => undefined);
  }

  sendFrame(stream: number, payload: Uint8Array): boolean {
    if (!this.#open) return false;
    void this.#shell.send(stream, toBase64(payload)).catch(() => undefined);
    return true;
  }

  closeStream(stream: number): void {
    if (this.#open) void this.#shell.close(stream).catch(() => undefined);
  }
}
