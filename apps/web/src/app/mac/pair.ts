/// Pairing, the phone's side (docs/remote-access.md, "What a person does", steps 3 and 4), on the package's
/// `startPairing` and the Mac's messages (apps/desktop/src/remote/pairing.ts). The phone's duties from
/// packages/remote-channel/README.md, "What the callers must do", are kept here, each with a test:
///
/// - A code is one try. Its door is written to the vault as spent before anything is dialled, so a reload, a second tab
///   or a press of Pair again refuses it (`used`), and nothing here ever starts again on its own after a failure. The
///   offer's secret is zeroed whatever happens.
/// - The phone shows its four digits only once the Mac's proof checked out, and sends nothing on the pairing channel
///   until the grant arrives on it.
/// - The passkey is made after the grant, from the person's own tap, and registered over the same channel. Only the
///   Mac's `paired` makes this phone paired, and only then is anything kept: the host id, the device id, the door token,
///   K as a key that cannot be read back, and the passkey's id.
/// - A passkey request for another relying party than this page's host is refused: the passkey must be tied to the
///   exact host, so one made on dev never answers in production.
import {
  RemoteChannelError,
  decodePairingGrant,
  fromBase64Url,
  importSharedSecret,
  readPairingLink,
  startPairing,
  toBase64Url,
  type Channel,
  type PairingOffer,
} from "@manut/remote-channel";
import { PasskeyCancelled, type Passkeys, type Registration } from "./passkeys";
import { type PhoneConnect, type RelayPipe, type Timers, relayUrl, systemTimers, tailnetUrl, TAILNET_PORT } from "./relay";
import { dialDoor } from "./session";
import type { PairedMac, PhoneVault } from "./vault";

export type PairStep =
  | { readonly step: "connecting" }
  | { readonly step: "digits"; readonly digits: string }
  /// The Mac took the digits: the person makes the passkey. `make` calls the browser's prompt at once, so it must be
  /// called straight from the tap. `cancelled` says the last prompt was closed and may be pressed again.
  | { readonly step: "passkey"; readonly make: () => void; readonly cancelled: boolean }
  | { readonly step: "finishing" };

export type PairFailure =
  /// Not a pairing code.
  | "bad_link"
  /// A link to another Manut AI address than this one.
  | "other_site"
  /// This phone already started this code.
  | "used"
  /// The phone could not note the code as spent, or could not keep the pairing.
  | "storage"
  /// This browser cannot make a passkey.
  | "no_passkeys"
  /// The relay does not know the code's door: it ran out, or was used.
  | "door"
  | "relay_off"
  | "unreachable"
  /// The Mac's socket is down, or its switch is off.
  | "mac_away"
  /// A step did not check out, or the Mac ended the pairing (a wrong or late code ends it there).
  | "ended"
  | "taken"
  | "full"
  | "passkey_failed";

export type PairResult = { readonly ok: true; readonly mac: PairedMac } | { readonly ok: false; readonly why: PairFailure };

export interface PairDeps {
  /// This page's origin, whose relay the phone dials.
  readonly origin: string;
  /// This page's host: the only relying party a passkey is made for.
  readonly rpId: string;
  readonly connect: PhoneConnect;
  readonly vault: PhoneVault;
  readonly passkeys: Passkeys;
  /// This phone's name as the Mac lists it ("iPhone, Safari").
  readonly name: string;
  /// The passkey's name in the phone's passwords.
  readonly label: string;
  now(): number;
  readonly timers?: Timers;
}

/// How long each step waits for the Mac. The digits wait as long as a code can last, and the passkey as long as the Mac
/// gives the person to make it (pairing.ts `REGISTRATION_TTL_MS`); the Mac ends the stream when its own time runs out.
export const STEP_MS = 15_000;
export const DIGITS_MS = 150_000;
export const PASSKEY_MS = 130_000;

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

/// "iPhone, Safari", from what the browser says it is, for the Mac's list of phones. Only the kind of phone and the
/// browser: never a model number or a version.
export function phoneName(userAgent: string): string {
  const device = /iPhone/.test(userAgent)
    ? "iPhone"
    : /iPad/.test(userAgent)
      ? "iPad"
      : /Android/.test(userAgent)
        ? "Android phone"
        : /Macintosh/.test(userAgent)
          ? "Mac"
          : /Windows/.test(userAgent)
            ? "Windows computer"
            : "Phone";
  const browser = /EdgA?\//.test(userAgent)
    ? "Edge"
    : /SamsungBrowser\//.test(userAgent)
      ? "Samsung Internet"
      : /(CriOS|Chrome)\//.test(userAgent)
        ? "Chrome"
        : /(FxiOS|Firefox)\//.test(userAgent)
          ? "Firefox"
          : /Safari\//.test(userAgent)
            ? "Safari"
            : "browser";
  return `${device}, ${browser}`;
}

/// Reads a scanned or pasted code. A whole link must be for this page's own origin: a code made for another address
/// would dial a relay that has never heard of it.
export function readCode(text: string, origin: string): PairingOffer | "bad_link" | "other_site" {
  const trimmed = text.trim();
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
    try {
      if (new URL(trimmed).origin !== origin) return "other_site";
    } catch {
      return "bad_link";
    }
  }
  try {
    return readPairingLink(trimmed);
  } catch {
    return "bad_link";
  }
}

/// The next whole message on a channel, or null when the socket ended or `ms` passed.
async function nextMessage(pipe: RelayPipe, channel: Channel, ms: number): Promise<Uint8Array | null> {
  for (;;) {
    const frame = await pipe.next(ms);
    if (!frame) return null;
    const opened = await channel.open(frame);
    if (opened !== null) return opened;
  }
}

function json(bytes: Uint8Array | null): Record<string, unknown> | null {
  if (!bytes) return null;
  try {
    const value: unknown = JSON.parse(decoder.decode(bytes));
    return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

async function say(pipe: RelayPipe, channel: Channel, message: Record<string, unknown>): Promise<void> {
  for (const frame of await channel.seal(encoder.encode(JSON.stringify(message)))) pipe.send(frame);
}

/// Pairs this phone with the Mac whose code `text` is, telling `onStep` what to show. It never tries again by itself:
/// every failure ends the pairing, and the person starts again on the Mac.
export async function pairWithMac(deps: PairDeps, text: string, onStep: (step: PairStep) => void): Promise<PairResult> {
  const read = readCode(text, deps.origin);
  if (typeof read === "string") return { ok: false, why: read };
  const offer = read;
  const fail = (why: PairFailure): PairResult => {
    offer.secret.fill(0);
    offer.doorToken.fill(0);
    return { ok: false, why };
  };
  if (!deps.passkeys.available) return fail("no_passkeys");
  // a version 2 code names the Mac's tailnet too (item 78f-2d): its door is tried first, so pairing works with the relay off
  const tailnet = offer.tailnet ? { name: offer.tailnet, port: TAILNET_PORT } : undefined;
  if (!relayUrl(deps.origin, offer.hostId) && !(tailnet && tailnetUrl(tailnet, offer.hostId))) return fail("unreachable");
  // Spent before anything is dialled: whatever follows, this code is not started again on this phone.
  let fresh: boolean;
  try {
    fresh = await deps.vault.spend(offer.doorId);
  } catch {
    return fail("storage");
  }
  if (!fresh) return fail("used");
  onStep({ step: "connecting" });
  const timers = deps.timers ?? systemTimers;
  const dialled = await dialDoor({ origin: deps.origin, connect: deps.connect }, { hostId: offer.hostId, device: offer.doorId, token: toBase64Url(offer.doorToken), ...(tailnet ? { tailnet } : {}) }, timers);
  offer.doorToken.fill(0);
  if (!dialled.ok) {
    const end = dialled.end.why;
    return fail(end === "unknown_door" || end === "revoked" ? "door" : end === "relay_off" ? "relay_off" : end === "mac_away" ? "mac_away" : "unreachable");
  }
  const pipe = dialled.pipe;
  let channel: Channel | null = null;
  let grant: { deviceId: string; doorToken: Uint8Array; secret: Uint8Array } | null = null;
  try {
    let started: Awaited<ReturnType<typeof startPairing>>;
    try {
      started = await startPairing(offer);
    } catch (error) {
      return fail(error instanceof RemoteChannelError && error.problem === "used" ? "used" : "ended");
    }
    pipe.send(started.commit);
    const key = await pipe.next(STEP_MS);
    if (!key) return fail(pipe.ended?.why === "lost" ? "unreachable" : "ended");
    pipe.send(await started.phone.receiveKey(key));
    const confirm = await pipe.next(STEP_MS);
    if (!confirm) return fail(pipe.ended?.why === "lost" ? "unreachable" : "ended");
    const confirmed = await started.phone.receiveConfirm(confirm);
    channel = confirmed.channel;
    onStep({ step: "digits", digits: confirmed.checkCode });

    // The person types the digits at the Mac. Nothing is sent here until the grant arrives.
    const granted = await nextMessage(pipe, channel, DIGITS_MS);
    if (!granted) return fail("ended");
    grant = decodePairingGrant(granted);
    const request = json(await nextMessage(pipe, channel, STEP_MS));
    const challenge = typeof request?.challenge === "string" ? fromBase64Url(request.challenge) : null;
    const rp = request?.rp as { id?: unknown } | undefined;
    if (request?.t !== "passkey" || !challenge || challenge.length !== 32 || rp?.id !== deps.rpId || request.user !== grant.deviceId) {
      return fail("ended");
    }
    // K becomes a key that cannot be read back, and its bytes go.
    const k = await importSharedSecret(grant.secret);
    grant.secret.fill(0);

    const registration = await makePasskey(deps, pipe, onStep, { rpId: deps.rpId, challenge, userId: grant.deviceId, label: deps.label });
    if (registration === "ended") return fail("ended");
    if (registration === "failed") return fail("passkey_failed");
    onStep({ step: "finishing" });
    await say(pipe, channel, {
      t: "registered",
      name: deps.name,
      credentialId: toBase64Url(registration.credentialId),
      clientDataJSON: toBase64Url(registration.clientDataJSON),
      authenticatorData: toBase64Url(registration.authenticatorData),
    });
    const outcome = json(await nextMessage(pipe, channel, STEP_MS * 2));
    if (outcome?.t !== "paired") {
      const reason = outcome?.reason;
      return fail(reason === "taken" ? "taken" : reason === "full" ? "full" : "ended");
    }
    const mac: PairedMac = {
      hostId: offer.hostId,
      deviceId: grant.deviceId,
      doorToken: grant.doorToken.slice(),
      k,
      credentialId: registration.credentialId.slice(),
      rpId: deps.rpId,
      pairedAt: deps.now(),
      ...(tailnet ? { tailnet } : {}),
    };
    try {
      await deps.vault.save(mac);
    } catch {
      mac.doorToken.fill(0);
      return fail("storage");
    }
    offer.secret.fill(0);
    return { ok: true, mac };
  } catch {
    return fail("ended");
  } finally {
    channel?.close();
    if (grant) {
      grant.secret.fill(0);
      grant.doorToken.fill(0);
    }
    pipe.close();
  }
}

/// Waits for the person's tap and makes the passkey then, as often as they close the prompt, until the Mac's window
/// for it ends (the socket closes). Each `make` calls the browser at once, inside the tap.
function makePasskey(
  deps: PairDeps,
  pipe: RelayPipe,
  onStep: (step: PairStep) => void,
  request: Parameters<Passkeys["create"]>[0],
): Promise<Registration | "ended" | "failed"> {
  return new Promise((resolve) => {
    let busy = false;
    let settled = false;
    const timers = deps.timers ?? systemTimers;
    const finish = (value: Registration | "ended" | "failed") => {
      if (settled) return;
      settled = true;
      timers.clear(timer);
      pipe.onEnd = null;
      resolve(value);
    };
    const timer = timers.set(() => finish("ended"), PASSKEY_MS);
    pipe.onEnd = () => finish("ended");
    if (pipe.ended) return finish("ended");
    const make = () => {
      if (busy || settled) return;
      busy = true;
      // Called inside the tap: the prompt starts before anything awaits.
      deps.passkeys.create(request).then(
        (registration) => finish(registration),
        (error: unknown) => {
          busy = false;
          if (error instanceof PasskeyCancelled && !settled) onStep({ step: "passkey", make, cancelled: true });
          else finish("failed");
        },
      );
    };
    onStep({ step: "passkey", make, cancelled: false });
  });
}
