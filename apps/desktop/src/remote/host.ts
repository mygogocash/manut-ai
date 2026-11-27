// The Mac's side of reaching it from a phone, put together (docs/remote-access.md, item 78b): the relay link (link.ts),
// one pairing at a time (pairing.ts), each paired phone's sessions on the package's handshake, and serving their
// requests (serve.ts). It is built switched off: nothing here opens a socket or makes a key until `turnOn`, which the page
// calls only after the person accepted the consent sheet and turned the switch on.
//
// The package's caller duties that are the Mac's are kept here (packages/remote-channel/README.md):
// - A session's device is the one its handshake proved (`channel.deviceId`), and a hello naming a device the Mac does not
//   hold is refused before anything is sent. The relay's `open` decides only which stream it is.
// - Any refusal on a stream closes its channel and the stream, and a stream the relay closes closes its channel.
// - Unpair forgets the phone's K and passkey in the page before anything awaits, closes every stream of that phone on the
//   Mac itself (open or still in its handshake), drops its waiting decision challenges (`DecisionChallenges.revoke`),
//   tells the relay `revoke` (at once while the socket is up, otherwise at the next `ready`), and then deletes K and the
//   passkey from the keychain. It needs no relay to take effect, and a relay that ignores the revoke gets that phone no
//   session, while the keychain write waits or after. Nothing is sent to a phone no longer paired, checked at the moment
//   of sending.
// - Turning the switch off ends everything: the pairing, every channel, every challenge, every journal and the socket.
//
// A phone reaches the Mac by one of two roads (roads.ts): the relay's link, and, while the person has it on, the tailnet's
// door (door.ts, item 78f-2b). Both carry the same sessions under the same pairing, K and challenges; turning the Tailscale
// road off, or the whole switch off, closes every stream that came by it.
import {
  type Channel,
  type MacSessionHandshake,
  type RandomBytes,
  type RelyingParty,
  DecisionChallenges,
  acceptSession,
} from "@manut/remote-channel";
import { type Keyring, type PairedPhone, RemoteVault } from "./keys";
import { type LinkState, type RelayProbe, type SocketFactory, type Timers, RelayLink, relaySocketUrl } from "./link";
import { PairingDoor, type PairingView } from "./pairing";
import { DoorLink, type DoorShell } from "./door";
import { Roads } from "./roads";
import { Projector } from "./project";
import { type ChatSources, type MacActions, Server } from "./serve";

export interface RemoteMacDeps {
  readonly keyring: Keyring;
  /** The API origin the app is connected to, or null in Practice. */
  readonly origin: string | null;
  readonly connect: SocketFactory;
  /** Asks the API whether its relay is switched on (its public health answer, fromShell.ts). */
  readonly probe: RelayProbe;
  readonly chats: ChatSources;
  readonly actions: MacActions;
  now(): number;
  readonly timers?: Timers;
  readonly random?: RandomBytes;
  /** The shell's Tailscale door (item 78f); absent where there is none (a browser, the tests that do not use it). */
  readonly door?: DoorShell;
}

/** The Tailscale road, as Settings shows it: off; starting; on under the Mac's tailnet name; or failed, with why. */
export type TailscaleRoad = { state: "off" } | { state: "starting" } | { state: "on"; name: string; port: number } | { state: "failed"; why: string };

/** What the Settings page shows. */
export interface RemoteSnapshot {
  readonly on: boolean;
  /** `no_origin`: the app is not connected to an API the page may open a socket to (Practice, or another host). */
  readonly link: LinkState | "no_origin" | "no_keychain";
  readonly pairing: PairingView;
  readonly phones: readonly (PairedPhone & { readonly connected: boolean })[];
  readonly tailscale: TailscaleRoad;
}

const encoder = new TextEncoder();

type StreamState =
  | { kind: "door" }
  | { kind: "hello" }
  | { kind: "finish"; handshake: MacSessionHandshake }
  | { kind: "open"; channel: Channel; deviceId: string }
  | { kind: "dead" };

interface Stream {
  state: StreamState;
  /** The device the relay's `open` named. Never who is speaking (that is the handshake's), only which streams to end at
   *  that device's Unpair while its handshake is still under way. */
  readonly claimed: string;
  /** Frames are read one at a time, in order. */
  reading: Promise<void>;
  /** Messages are sent one at a time, in order. */
  sending: Promise<void>;
}

const systemTimers: Timers = {
  set: (run, ms) => setTimeout(run, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** The relying party a phone's passkey is bound to: the exact host of the API origin, whose `/app/` the phone runs, so a
 *  passkey made on dev never answers in production (docs/remote-access.md, "Domain"). */
export function relyingParty(origin: string): RelyingParty {
  const url = new URL(origin);
  return { id: url.hostname, origin: `${url.protocol}//${url.host}` };
}

export class RemoteMac {
  readonly #deps: RemoteMacDeps;
  readonly #timers: Timers;
  readonly #listeners = new Set<(snapshot: RemoteSnapshot) => void>();
  readonly #streams = new Map<number, Stream>();
  #vault: RemoteVault | null = null;
  /** The roads a phone may take: the relay's link, and the tailnet's door while it is on. */
  #link: Roads | null = null;
  #rpOrigin: string | null = null;
  #tailscale: TailscaleRoad = { state: "off" };
  #pairing: PairingDoor | null = null;
  #server: Server | null = null;
  #challenges = new DecisionChallenges();
  /** Each ask's revision and what each phone was shown, for this app's life: kept across the switch going off and on,
   *  so a phone's revision binds across a reconnect (project.ts). */
  readonly #projector = new Projector();
  #on = false;
  #linkState: LinkState | "no_origin" | "no_keychain" = "stopped";
  #pairingView: PairingView = { phase: "idle" };
  /** Bumped by each turn on or off, so work that awaited across one stops there. */
  #generation = 0;

  constructor(deps: RemoteMacDeps) {
    this.#deps = deps;
    this.#timers = deps.timers ?? systemTimers;
  }

  get isOn(): boolean {
    return this.#on;
  }

  /** For tests: the challenges waiting now. */
  get challenges(): DecisionChallenges {
    return this.#challenges;
  }

  get server(): Server | null {
    return this.#server;
  }

  get hostId(): string | null {
    return this.#vault?.identity?.hostId ?? null;
  }

  snapshot(): RemoteSnapshot {
    const connected = new Set([...this.#streams.values()].flatMap((s) => (s.state.kind === "open" ? [s.state.deviceId] : [])));
    return {
      on: this.#on,
      link: this.#linkState,
      pairing: this.#pairingView,
      phones: (this.#vault?.phones() ?? []).map((p) => ({ ...p, connected: connected.has(p.id) })),
      tailscale: this.#tailscale,
    };
  }

  subscribe(listener: (snapshot: RemoteSnapshot) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #changed(): void {
    const snapshot = this.snapshot();
    for (const listener of this.#listeners) listener(snapshot);
  }

  /** Reads the paired phones without making anything, for the page while the switch is off. */
  async loadPhones(): Promise<void> {
    if (this.#on) return;
    this.#hold(await RemoteVault.open(this.#deps.keyring, false));
    this.#changed();
  }

  /** The switch went on, after consent: the relay key is made the first time, and the socket opens. */
  async turnOn(): Promise<void> {
    if (this.#on) return;
    this.#on = true;
    const generation = ++this.#generation;
    // Where the page may not reach the relay (Practice, another host), nothing could connect, so no key is made either.
    if (!this.#deps.origin || relaySocketUrl(this.#deps.origin, "A".repeat(43)) === null) {
      this.#linkState = "no_origin";
      this.#changed();
      return;
    }
    // The shell's own switch goes on first: until then it makes no key and gives no K.
    const vault = await this.#deps.keyring
      .setSwitch(true)
      .then(() => RemoteVault.open(this.#deps.keyring, true))
      .catch(() => null);
    if (generation !== this.#generation) return;
    if (!vault?.identity) {
      // No keychain (not macOS, the browser preview) or one that refused: nothing can be kept, so nothing is opened.
      this.#linkState = "no_keychain";
      this.#changed();
      return;
    }
    this.#hold(vault);
    const identity = vault.identity;
    const origin = this.#deps.origin;
    const url = identity && origin ? relaySocketUrl(origin, identity.hostId) : null;
    if (!origin || !url) {
      this.#linkState = "no_origin";
      this.#changed();
      return;
    }
    const rp = relyingParty(origin);
    this.#challenges = new DecisionChallenges(this.#deps.random ? { random: this.#deps.random } : {});
    const link = new Roads({
      onOpen: (stream, device) => this.#onOpen(stream, device),
      onFrame: (stream, payload) => this.#onFrame(stream, payload),
      onClose: (stream) => this.#onClose(stream),
    });
    link.setRoad(
      "relay",
      new RelayLink({
        url,
        identity,
        connect: this.#deps.connect,
        probe: this.#deps.probe,
        timers: this.#timers,
        events: {
          ...link.eventsFor("relay"),
          onState: (state) => {
            this.#linkState = state;
            this.#changed();
          },
        },
      }),
    );
    this.#link = link;
    this.#rpOrigin = rp.origin;
    for (const [id, hash] of vault.tokenHashes()) link.allowDevice(id, hash);
    this.#server = new Server({
      chats: this.#deps.chats,
      actions: this.#deps.actions,
      challenges: this.#challenges,
      phones: vault,
      rp,
      now: () => this.#deps.now(),
      push: (deviceId, message) => this.#push(deviceId, message),
      projector: this.#projector,
    });
    this.#pairing = new PairingDoor({
      hostId: identity.hostId,
      appUrl: `${rp.origin}/app/`,
      rp,
      vault,
      allowDevice: (id, hash) => link.allowDevice(id, hash),
      revokeDevice: (id) => link.revokeDevice(id),
      sendFrame: (stream, payload) => void link.sendFrame(stream, payload),
      closeStream: (stream) => this.#endStream(stream),
      now: () => this.#deps.now(),
      timers: this.#timers,
      ...(this.#deps.random ? { random: this.#deps.random } : {}),
      onView: (view) => {
        this.#pairingView = view;
        this.#changed();
      },
      onPaired: () => this.#changed(),
    });
    link.setPresence("available", Math.floor(this.#deps.now() / 1000));
    link.start();
    this.#changed();
  }

  /** The switch went off: the pairing ends, every channel and challenge with it, the journals are dropped and the socket
   *  closes. The paired phones stay paired, so turning it on again needs no new pairing. */
  turnOff(): void {
    if (!this.#on) return;
    this.#on = false;
    this.#generation += 1;
    this.#pairing?.cancel();
    this.#pairing = null;
    for (const stream of [...this.#streams.keys()]) this.#endStream(stream);
    this.#server?.clear();
    this.#server = null;
    this.#challenges = new DecisionChallenges();
    const link = this.#link;
    this.#link = null;
    if (link) {
      // The relay turns phones away with "off" rather than "offline" while the socket closes.
      link.setPresence("off", Math.floor(this.#deps.now() / 1000));
      link.stop();
    }
    this.#linkState = "stopped";
    this.#tailscale = { state: "off" };
    this.#pairingView = { phase: "idle" };
    // The shell's switch goes off too: no K, no signature and no new phone until it is turned on again.
    void this.#deps.keyring.setSwitch(false).catch(() => undefined);
    this.#changed();
  }

  /** The Tailscale road switched on, after its own consent: only while the main switch is on, the shell's door starts
   *  and Tailscale serves it, and it is told the same devices and state the relay is. A door that did not start says why. */
  async turnTailscaleOn(): Promise<boolean> {
    const roads = this.#link;
    const hostId = this.hostId;
    const origin = this.#rpOrigin;
    if (!this.#on || !roads || !hostId || !origin) return false;
    if (!this.#deps.door) {
      this.#tailscale = { state: "failed", why: "no door here" };
      this.#changed();
      return false;
    }
    if (roads.has("door")) return true;
    const generation = this.#generation;
    this.#tailscale = { state: "starting" };
    this.#changed();
    const door = new DoorLink({ shell: this.#deps.door, hostId, origin, events: roads.eventsFor("door") });
    try {
      const served = await door.open();
      if (generation !== this.#generation || this.#link !== roads) {
        door.stop();
        return false;
      }
      roads.setRoad("door", door);
      this.#tailscale = { state: "on", name: served.name, port: served.port };
      this.#announceRoad();
    } catch (e) {
      this.#tailscale = { state: "failed", why: e instanceof Error ? e.message : String(e) };
    }
    this.#changed();
    return this.#tailscale.state === "on";
  }

  /** The `road` message (item 78f-2c): the Mac's tailnet name and the door's port while the Tailscale road is on, else none,
   *  so a phone tries the tailnet first only while it can work. A tailnet name is no secret: turning on HTTPS for a tailnet
   *  publishes it in public certificate logs. */
  #road(): Record<string, unknown> {
    const road = this.#tailscale;
    return road.state === "on" ? { t: "road", name: road.name, port: road.port } : { t: "road", name: null };
  }

  /** Every open session hears the road as it is now. */
  #announceRoad(): void {
    const message = this.#road();
    for (const [stream, s] of this.#streams) if (s.state.kind === "open") this.#send(stream, s, message);
  }

  /** The Tailscale road switched off: every stream that came by it closes, Tailscale stops serving the door, and the
   *  relay's road goes on as it was. */
  turnTailscaleOff(): void {
    this.#link?.removeRoad("door");
    if (this.#tailscale.state !== "off") {
      // a door that failed to start may still have been left half made: off is asked of the shell either way
      if (!this.#link?.has("door")) void this.#deps.door?.off().catch(() => undefined);
    }
    const was = this.#tailscale.state;
    this.#tailscale = { state: "off" };
    if (was === "on") this.#announceRoad();
    this.#changed();
  }

  async startPairing(): Promise<boolean> {
    return (await this.#pairing?.start()) ?? false;
  }

  cancelPairing(): void {
    this.#pairing?.cancel();
  }

  typeCode(code: string): Promise<boolean> {
    return this.#pairing?.typeCode(code) ?? Promise.resolve(false);
  }

  /** Unpairs a phone, on the Mac's own side first and before anything awaits: its K and passkey go from the page (so no
   *  new session of it opens and nothing it asks is served), every stream of it closes, its challenges go, and the relay
   *  is told `revoke` now or at its next `ready`; then the keychain forgets it. A relay that ignores the revoke gets that
   *  phone nothing, even while the keychain write waits. */
  async unpair(id: string): Promise<void> {
    const vault = this.#vault ?? (await RemoteVault.open(this.#deps.keyring, false));
    if (!this.#vault) this.#hold(vault);
    // `remove` forgets the phone in the page before its first await, which ends its streams (`#dropDevice`).
    const removing = vault.remove(id);
    this.#dropDevice(id);
    this.#link?.revokeDevice(id);
    try {
      await removing;
    } finally {
      this.#changed();
    }
  }

  /** Keeps the vault the page reads its phones from, and ends a phone's sessions the moment the vault forgets it, by
   *  Unpair or by a pairing cancelled while the keychain wrote. */
  #hold(vault: RemoteVault): void {
    this.#vault = vault;
    vault.onRemoved = (id) => this.#dropDevice(id);
  }

  /** Ends everything of a device on the Mac's side: every stream it has open or under way, its challenges, what it
   *  watched. */
  #dropDevice(id: string): void {
    for (const [stream, s] of this.#streams) {
      if ((s.state.kind === "open" && s.state.deviceId === id) || s.claimed === id) this.#endStream(stream);
    }
    this.#challenges.revoke(id);
    this.#server?.left(id);
    this.#projector.forgetDevice(id);
  }

  /** The store changed: phones watching a chat hear what moved. */
  publish(): void {
    this.#server?.publish();
  }

  #onOpen(stream: number, device: string): void {
    const door = this.#pairing?.takeStream(stream, device) ?? false;
    this.#streams.set(stream, { state: door ? { kind: "door" } : { kind: "hello" }, claimed: device, reading: Promise.resolve(), sending: Promise.resolve() });
  }

  #onFrame(stream: number, payload: Uint8Array): void {
    const s = this.#streams.get(stream);
    if (!s) return;
    if (s.state.kind === "door") return this.#pairing?.onFrame(stream, payload);
    const generation = this.#generation;
    s.reading = s.reading
      .then(() => (generation === this.#generation ? this.#read(stream, s, payload) : undefined))
      .catch(() => this.#endStream(stream));
  }

  async #read(stream: number, s: Stream, payload: Uint8Array): Promise<void> {
    const state = s.state;
    const vault = this.#vault;
    const identity = vault?.identity;
    if (!vault || !identity) throw new Error("off");
    switch (state.kind) {
      case "hello": {
        s.state = { kind: "dead" };
        const { welcome, mac } = await acceptSession(payload, { hostId: identity.hostId, secretFor: (id) => vault.secretFor(id) });
        if (this.#streams.get(stream) !== s) return;
        s.state = { kind: "finish", handshake: mac };
        this.#link?.sendFrame(stream, welcome);
        return;
      }
      case "finish": {
        s.state = { kind: "dead" };
        const channel = await state.handshake.receiveFinish(payload);
        const deviceId = channel.deviceId;
        // Unpaired between the hello and the finish: the session is not taken.
        if (deviceId === null || !vault.has(deviceId) || this.#streams.get(stream) !== s) {
          channel.close();
          throw new Error("unpaired");
        }
        s.state = { kind: "open", channel, deviceId };
        // the phone learns, inside the channel, where this Mac's door over the tailnet is, or that it has none (78f-2c)
        this.#send(stream, s, this.#road());
        void vault.seen(deviceId, this.#deps.now()).catch(() => undefined);
        this.#changed();
        return;
      }
      case "open": {
        const message = await state.channel.open(payload);
        if (message === null) return;
        const server = this.#server;
        if (!server) throw new Error("off");
        for (const reply of await server.handle(state.deviceId, message)) this.#send(stream, s, reply);
        return;
      }
      default:
        throw new Error("closed");
    }
  }

  #send(stream: number, s: Stream, message: Record<string, unknown>): void {
    if (s.state.kind !== "open") return;
    const { channel, deviceId } = s.state;
    s.sending = s.sending
      .then(async () => {
        // Checked again at the moment of sending: a phone unpaired since this was queued is sent nothing more, and its
        // stream ends.
        if (s.state.kind !== "open" || !this.#vault?.has(deviceId)) throw new Error("unpaired");
        for (const frame of await channel.seal(encoder.encode(JSON.stringify(message)))) this.#link?.sendFrame(stream, frame);
      })
      .catch(() => this.#endStream(stream));
  }

  #push(deviceId: string, message: Record<string, unknown>): void {
    // A phone no longer paired is told nothing, and whatever of it is still open ends.
    if (!this.#vault?.has(deviceId)) return this.#dropDevice(deviceId);
    for (const [stream, s] of this.#streams) if (s.state.kind === "open" && s.state.deviceId === deviceId) this.#send(stream, s, message);
  }

  #onClose(stream: number): void {
    if (this.#pairing?.ownsStream(stream)) this.#pairing.streamClosed(stream);
    this.#forget(stream);
  }

  /** Ends a stream on the Mac's side and asks the relay to close it. */
  #endStream(stream: number): void {
    this.#link?.closeStream(stream);
    this.#forget(stream);
  }

  #forget(stream: number): void {
    const s = this.#streams.get(stream);
    if (!s) return;
    this.#streams.delete(stream);
    const state = s.state;
    s.state = { kind: "dead" };
    if (state.kind === "open") {
      state.channel.close();
      const still = [...this.#streams.values()].some((o) => o.state.kind === "open" && o.state.deviceId === state.deviceId);
      if (!still) this.#server?.left(state.deviceId);
      this.#changed();
    }
  }
}
