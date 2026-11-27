// The phone's roads to this Mac, as one link (item 78f-2b, docs/remote-access.md, "The second road: Tailscale"): the
// relay's (`link.ts`) and, while the person has it on, the tailnet's (`door.ts`). The host and the pairing door talk to this
// as they talked to the relay's link alone, so a phone is served the same whichever road it came by: one pairing, one K,
// one challenge for each ask.
//
// - Which devices may come in, and what a new phone hears about the Mac, go to every road, and to a road added later as
//   they are then.
// - Each road numbers its own streams, so two roads can use the same number. The host sees one number space: a stream
//   keeps its own number when no other stream has it, and otherwise is given one that is free. A frame or a close the host
//   sends goes back down the road its stream came by, under that road's own number.
// - A road taken away closes every stream that came by it, as its phones see their socket close.
import type { LinkEvents, RelayPresence } from "./link";
import type { RoadEvents } from "./door";

/** What a road does for the host: the relay's link and the door both. */
export interface Road {
  start(): void;
  stop(): void;
  allowDevice(id: string, tokenHash: string): void;
  revokeDevice(id: string): void;
  setPresence(state: RelayPresence, at: number): void;
  sendFrame(stream: number, payload: Uint8Array): boolean;
  closeStream(stream: number): void;
  /** Push (item 78d) is the relay's alone: the door has neither. */
  setWebPush?(id: string, endpoint: string | null): void;
  push?(devices: readonly string[]): boolean;
}

export type RoadName = "relay" | "door";

export class Roads {
  readonly #events: RoadEvents;
  readonly #roads = new Map<RoadName, Road>();
  readonly #devices = new Map<string, string>();
  readonly #webPush = new Map<string, string>();
  #presence: [RelayPresence, number] | null = null;
  /** The host's number for each road's stream, and the way back. */
  readonly #local = new Map<string, number>();
  readonly #remote = new Map<number, { road: RoadName; stream: number }>();
  readonly #random: () => number;

  constructor(events: RoadEvents, random: () => number = () => Math.floor(Math.random() * 0x1_0000_0000)) {
    this.#events = events;
    this.#random = random;
  }

  /** The events a road is built with: its streams, under the host's numbers. */
  eventsFor(road: RoadName): Pick<LinkEvents, "onOpen" | "onFrame" | "onClose"> {
    return {
      onOpen: (stream, device) => {
        const local = this.#take(road, stream);
        this.#events.onOpen(local, device);
      },
      onFrame: (stream, payload) => {
        const local = this.#local.get(`${road}:${stream}`);
        if (local !== undefined) this.#events.onFrame(local, payload);
      },
      onClose: (stream, reason) => {
        const key = `${road}:${stream}`;
        const local = this.#local.get(key);
        if (local === undefined) return;
        this.#local.delete(key);
        this.#remote.delete(local);
        this.#events.onClose(local, reason);
      },
    };
  }

  /** The host's number for `road`'s new `stream`: its own when free, else a free one. */
  #take(road: RoadName, stream: number): number {
    const key = `${road}:${stream}`;
    const had = this.#local.get(key);
    if (had !== undefined) {
      // a road that opens a number it already has open: the old stream is gone, as a replaced socket's is
      this.#remote.delete(had);
    }
    let local = stream;
    while (this.#remote.has(local)) local = this.#random() >>> 0;
    this.#local.set(key, local);
    this.#remote.set(local, { road, stream });
    return local;
  }

  /** Adds `road` (or puts it in place of the one of that name), telling it the devices and the Mac's state as they are. */
  setRoad(name: RoadName, road: Road): void {
    if (this.#roads.has(name)) this.removeRoad(name);
    this.#roads.set(name, road);
    for (const [id, hash] of this.#devices) road.allowDevice(id, hash);
    for (const [id, endpoint] of this.#webPush) road.setWebPush?.(id, endpoint);
    if (this.#presence) road.setPresence(...this.#presence);
  }

  /** Takes `name` away: every stream that came by it is closed to the host, then the road stops. */
  removeRoad(name: RoadName, reason = "closed"): void {
    const road = this.#roads.get(name);
    if (!road) return;
    this.#roads.delete(name);
    for (const [local, at] of [...this.#remote]) {
      if (at.road !== name) continue;
      this.#remote.delete(local);
      this.#local.delete(`${name}:${at.stream}`);
      this.#events.onClose(local, reason);
    }
    road.stop();
  }

  has(name: RoadName): boolean {
    return this.#roads.has(name);
  }

  start(): void {
    for (const r of this.#roads.values()) r.start();
  }

  stop(): void {
    for (const name of [...this.#roads.keys()]) this.removeRoad(name);
  }

  allowDevice(id: string, tokenHash: string): void {
    this.#devices.set(id, tokenHash);
    for (const r of this.#roads.values()) r.allowDevice(id, tokenHash);
  }

  revokeDevice(id: string): void {
    this.#devices.delete(id);
    this.#webPush.delete(id);
    for (const r of this.#roads.values()) r.revokeDevice(id);
  }

  /** A phone's push address, to every road that pushes (the relay's), and to one added later. */
  setWebPush(id: string, endpoint: string | null): void {
    if (endpoint === null) this.#webPush.delete(id);
    else this.#webPush.set(id, endpoint);
    for (const r of this.#roads.values()) r.setWebPush?.(id, endpoint);
  }

  /** Asks every road that pushes to wake `devices`; true when one took it. */
  push(devices: readonly string[]): boolean {
    let sent = false;
    for (const r of this.#roads.values()) sent = (r.push?.(devices) ?? false) || sent;
    return sent;
  }

  setPresence(state: RelayPresence, at: number): void {
    this.#presence = [state, at];
    for (const r of this.#roads.values()) r.setPresence(state, at);
  }

  /** A frame down the road `stream` came by, under that road's number. */
  sendFrame(stream: number, payload: Uint8Array): boolean {
    const at = this.#remote.get(stream);
    const road = at && this.#roads.get(at.road);
    return !!(at && road && road.sendFrame(at.stream, payload));
  }

  /** The host closes `stream`: its road closes it, and the host hears nothing back for it. */
  closeStream(stream: number): void {
    const at = this.#remote.get(stream);
    if (!at) return;
    this.#remote.delete(stream);
    this.#local.delete(`${at.road}:${at.stream}`);
    this.#roads.get(at.road)?.closeStream(at.stream);
  }
}
