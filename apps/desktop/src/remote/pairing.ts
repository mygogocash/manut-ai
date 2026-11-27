// "Pair a phone", the Mac's side (docs/remote-access.md, "What a person does", steps 2 and 4), on the package's
// `macPairing` (packages/remote-channel/README.md, "What the callers must do"):
//
// - One code at a time. A second "Pair a phone" while one is open is refused; the page offers Cancel instead, so there is
//   never more than one door open on the relay.
// - The code is a one-use relay door (registered with `device` now, revoked with `revoke` when the pairing ends in any
//   way) and the QR code's link. The link is shown for at most two minutes and hidden at the first commit, which spends
//   the code; the page then asks for the four digits the phone shows, and `allow` is called once with what was typed.
// - Once the digits hold, the Mac sends the grant (the phone's device id, its own door token and K) and a passkey
//   request on the pairing channel. The phone counts as paired only when its passkey registration has come back on that
//   channel and checked out: that is the Mac's only sign the phone holds the grant. Its passkey must not belong to
//   another paired phone. Only then is it kept, and its own door registered.
//
// Messages on the pairing channel, after the grant (82 bytes, the package's layout), are JSON:
//   Mac -> phone   {"t":"passkey","challenge":<b64url 32 bytes>,"rp":{"id":<host>},"user":<device id>}
//   phone -> Mac   {"t":"registered","name":<the phone's name>,"credentialId","clientDataJSON","authenticatorData"} (b64url)
//   Mac -> phone   {"t":"paired"} or {"t":"refused","reason":<code>}, and the Mac closes the stream.
import {
  type Channel,
  type PairingGrant,
  type RandomBytes,
  type RelyingParty,
  type MacPairing,
  RemoteChannelError,
  doorTokenHash,
  encodePairingGrant,
  fromBase64Url,
  macPairing,
  newPairingGrant,
  newPairingOffer,
  pairingLink,
  systemRandom,
  toBase64Url,
  verifyPasskeyRegistration,
} from "@manut/remote-channel";
import { type RemoteVault, cleanName } from "./keys";
import type { Timers } from "./link";

/** How long the phone has to make its passkey once the digits were typed. */
export const REGISTRATION_TTL_MS = 120_000;

export type PairingFailure = "wrong_code" | "expired" | "refused" | "full" | "taken" | "cancelled";

/** What the page shows for the pairing: nothing, the code (QR and link) until its first commit, a short wait, the field
 *  for the four digits, the wait for the phone's passkey, then the outcome. */
export type PairingView =
  | { readonly phase: "idle" }
  | { readonly phase: "showing"; readonly link: string; readonly expiresAt: number }
  | { readonly phase: "checking"; readonly expiresAt: number }
  | { readonly phase: "code"; readonly expiresAt: number }
  | { readonly phase: "finishing" }
  | { readonly phase: "paired"; readonly name: string }
  | { readonly phase: "failed"; readonly reason: PairingFailure };

/** What pairing needs of the rest of the Mac: the relay link's door and stream calls, the vault, and the clock. */
export interface PairingDeps {
  readonly hostId: string;
  readonly appUrl: string;
  readonly rp: RelyingParty;
  readonly vault: RemoteVault;
  allowDevice(id: string, tokenHash: string): void;
  revokeDevice(id: string): void;
  sendFrame(stream: number, payload: Uint8Array): void;
  closeStream(stream: number): void;
  now(): number;
  readonly timers: Timers;
  readonly random?: RandomBytes;
  /** The Mac's tailnet name while its Tailscale road is on (item 78f-2d), put in each new code so a phone can reach the
   *  pairing door over the tailnet with the relay switched off; null otherwise, and the code is version 1 as before. */
  tailnet?(): string | null;
  /** Told whenever the view changes. */
  onView(view: PairingView): void;
  /** Told when a phone has paired, so its sessions can be taken. */
  onPaired(id: string): void;
}

const encoder = new TextEncoder();

type Step = "commit" | "proof" | "code" | "registration" | "done";

interface Open {
  readonly doorId: string;
  readonly mac: MacPairing;
  readonly expiresAt: number;
  step: Step;
  stream: number | null;
  channel: Channel | null;
  grant: PairingGrant | null;
  challenge: Uint8Array | null;
  timer: unknown;
  /** Frames are read one at a time, in order. */
  chain: Promise<void>;
}

export class PairingDoor {
  readonly #deps: PairingDeps;
  #open: Open | null = null;
  #view: PairingView = { phase: "idle" };

  constructor(deps: PairingDeps) {
    this.#deps = deps;
  }

  get view(): PairingView {
    return this.#view;
  }

  /** The relay device id of the open door, if one is open. */
  get doorId(): string | null {
    return this.#open?.doorId ?? null;
  }

  #show(view: PairingView): void {
    this.#view = view;
    this.#deps.onView(view);
  }

  /** Shows a new code. Refused (false) while another pairing is open, or when the Mac already has the most phones. */
  async start(): Promise<boolean> {
    if (this.#open) return false;
    if (this.#deps.vault.full) {
      this.#show({ phase: "failed", reason: "full" });
      return false;
    }
    // The shell takes a new phone only while it has a pairing open, so a script in the page cannot add one on its own.
    try {
      await this.#deps.vault.openPairing();
    } catch {
      return false;
    }
    const createdAt = this.#deps.now();
    const offer = newPairingOffer(this.#deps.hostId, this.#deps.random ?? systemRandom, this.#deps.tailnet?.() ?? undefined);
    let link: string;
    let mac: MacPairing;
    let tokenHash: string;
    try {
      mac = macPairing(offer, createdAt);
      link = pairingLink(this.#deps.appUrl, offer);
      tokenHash = await doorTokenHash(offer.doorToken);
    } finally {
      // The Mac drops the offer once the pairing and the link are made (the package's caller duty).
      offer.secret.fill(0);
      offer.doorToken.fill(0);
    }
    // Another pairing started meanwhile: the window the shell opened is that one's.
    if (this.#open) return false;
    const open: Open = {
      doorId: offer.doorId,
      mac,
      expiresAt: mac.expiresAt,
      step: "commit",
      stream: null,
      channel: null,
      grant: null,
      challenge: null,
      timer: null,
      chain: Promise.resolve(),
    };
    this.#open = open;
    open.timer = this.#deps.timers.set(() => this.#expire(open), Math.max(0, mac.expiresAt - createdAt));
    this.#deps.allowDevice(offer.doorId, tokenHash);
    this.#show({ phase: "showing", link, expiresAt: mac.expiresAt });
    return true;
  }

  /** Ends the open pairing, if any, and forgets its outcome. */
  cancel(): void {
    if (this.#open) this.#end(this.#open, "cancelled");
    this.#show({ phase: "idle" });
  }

  /** A stream the relay opened for the door. A later one replaces an earlier one, as the relay does. */
  takeStream(stream: number, device: string): boolean {
    const open = this.#open;
    if (!open || device !== open.doorId) return false;
    if (open.stream !== null && open.stream !== stream) this.#deps.closeStream(open.stream);
    open.stream = stream;
    return true;
  }

  ownsStream(stream: number): boolean {
    return this.#open?.stream === stream;
  }

  /** The door's stream ended. A pairing still waiting for the phone's passkey cannot finish without it. */
  streamClosed(stream: number): void {
    const open = this.#open;
    if (!open || open.stream !== stream) return;
    open.stream = null;
    if (open.step === "registration" || open.step === "proof") this.#end(open, "refused");
  }

  onFrame(stream: number, frame: Uint8Array): void {
    const open = this.#open;
    if (!open || open.stream !== stream) return;
    open.chain = open.chain.then(() => this.#read(open, stream, frame)).catch((error: unknown) => {
      const late = error instanceof RemoteChannelError && error.problem === "expired";
      if (this.#open === open) this.#end(open, late ? "expired" : "refused");
    });
  }

  async #read(open: Open, stream: number, frame: Uint8Array): Promise<void> {
    if (this.#open !== open) return;
    const now = this.#deps.now();
    switch (open.step) {
      case "commit": {
        // The code is spent at the first commit, whatever it brings: the QR code goes now.
        open.step = "proof";
        this.#show({ phase: "checking", expiresAt: open.expiresAt });
        const key = await open.mac.receiveCommit(frame, now);
        this.#deps.sendFrame(stream, key);
        return;
      }
      case "proof": {
        const { confirm } = await open.mac.receiveProof(frame, now);
        open.step = "code";
        this.#deps.sendFrame(stream, confirm);
        this.#show({ phase: "code", expiresAt: open.expiresAt });
        return;
      }
      case "registration": {
        const channel = open.channel;
        if (!channel) throw new RemoteChannelError("closed");
        const message = await channel.open(frame);
        if (message === null) return;
        await this.#register(open, stream, message);
        return;
      }
      default:
        // Nothing is read while the person types the digits, and nothing once done.
        throw new RemoteChannelError("malformed");
    }
  }

  /** The four digits the person typed from the phone. Taken once: a wrong or late code ends this pairing. */
  async typeCode(typed: string): Promise<boolean> {
    const open = this.#open;
    if (!open || open.step !== "code" || open.stream === null) return false;
    open.step = "registration";
    let channel: Channel;
    try {
      channel = open.mac.allow(typed, this.#deps.now());
    } catch (error) {
      const problem = error instanceof RemoteChannelError ? error.problem : "invalid";
      this.#end(open, problem === "wrong_code" ? "wrong_code" : problem === "expired" ? "expired" : "refused");
      return false;
    }
    open.channel = channel;
    open.grant = newPairingGrant(this.#deps.random ?? systemRandom);
    open.challenge = (this.#deps.random ?? systemRandom)(32).slice();
    this.#show({ phase: "finishing" });
    const stream = open.stream;
    // The registration has its own two minutes, from the digits on: the person makes a passkey on the phone.
    if (open.timer !== null) this.#deps.timers.clear(open.timer);
    open.timer = this.#deps.timers.set(() => this.#expire(open), REGISTRATION_TTL_MS);
    try {
      const request = { t: "passkey", challenge: toBase64Url(open.challenge), rp: { id: this.#deps.rp.id }, user: open.grant.deviceId };
      for (const frame of await channel.seal(encodePairingGrant(open.grant))) this.#deps.sendFrame(stream, frame);
      for (const frame of await channel.seal(encoder.encode(JSON.stringify(request)))) this.#deps.sendFrame(stream, frame);
    } catch {
      this.#end(open, "refused");
      return false;
    }
    return true;
  }

  async #register(open: Open, stream: number, message: Uint8Array): Promise<void> {
    const grant = open.grant;
    const challenge = open.challenge;
    if (!grant || !challenge) throw new RemoteChannelError("closed");
    let body: Record<string, unknown>;
    try {
      const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(message));
      if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("not an object");
      body = value as Record<string, unknown>;
    } catch {
      return this.#refuse(open, stream, "refused");
    }
    const bytes = (field: unknown): Uint8Array | null => {
      if (typeof field !== "string" || field.length > 24_000) return null;
      try {
        return fromBase64Url(field);
      } catch {
        return null;
      }
    };
    const credentialId = bytes(body.credentialId);
    const clientDataJSON = bytes(body.clientDataJSON);
    const authenticatorData = bytes(body.authenticatorData);
    const name = cleanName(body.name);
    if (body.t !== "registered" || !credentialId || !clientDataJSON || !authenticatorData || !name) return this.#refuse(open, stream, "refused");
    const checked = await verifyPasskeyRegistration({ credentialId, clientDataJSON, authenticatorData }, { challenge, rp: this.#deps.rp });
    if (this.#open !== open) return;
    if (!checked.ok) return this.#refuse(open, stream, "refused");
    if (this.#deps.vault.credentialTaken(checked.passkey.credentialId)) return this.#refuse(open, stream, "taken");
    if (this.#deps.vault.full) return this.#refuse(open, stream, "full");
    const tokenHash = await doorTokenHash(grant.doorToken);
    const deviceId = grant.deviceId;
    try {
      await this.#deps.vault.add({ id: deviceId, name, pairedAt: this.#deps.now(), k: grant.secret, tokenHash, passkey: checked.passkey });
    } catch {
      return this.#refuse(open, stream, "refused");
    }
    if (this.#open !== open) {
      // Cancelled or switched off while the keychain wrote: the phone is not kept.
      await this.#deps.vault.remove(deviceId).catch(() => undefined);
      return;
    }
    this.#deps.allowDevice(deviceId, tokenHash);
    await this.#say(open, stream, { t: "paired" });
    open.step = "done";
    this.#end(open, null);
    this.#show({ phase: "paired", name });
    this.#deps.onPaired(deviceId);
  }

  async #say(open: Open, stream: number, message: Record<string, unknown>): Promise<void> {
    try {
      for (const frame of (await open.channel?.seal(encoder.encode(JSON.stringify(message)))) ?? []) this.#deps.sendFrame(stream, frame);
    } catch {
      // The phone hears nothing more; the stream closes below either way.
    }
  }

  async #refuse(open: Open, stream: number, reason: PairingFailure): Promise<void> {
    await this.#say(open, stream, { t: "refused", reason });
    this.#end(open, reason);
  }

  #expire(open: Open): void {
    if (this.#open === open) this.#end(open, "expired");
  }

  /** Ends a pairing: its door is revoked and its stream closed, every secret it held is zeroed, and the page shows why
   *  (or nothing, for a pairing that succeeded and shows its own outcome). */
  #end(open: Open, reason: PairingFailure | null): void {
    if (this.#open !== open) return;
    this.#open = null;
    this.#deps.vault.closePairing();
    if (open.timer !== null) this.#deps.timers.clear(open.timer);
    this.#deps.revokeDevice(open.doorId);
    if (open.stream !== null) this.#deps.closeStream(open.stream);
    open.channel?.close();
    if (open.grant) {
      open.grant.secret.fill(0);
      open.grant.doorToken.fill(0);
    }
    open.challenge?.fill(0);
    if (reason !== null) this.#show({ phase: "failed", reason });
  }
}
