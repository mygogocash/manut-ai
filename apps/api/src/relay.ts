import { base64UrlDecode } from "./auth";

/// Relay protocol v1, the Worker's side of the door (docs/relay-protocol-v1.md). The Worker
/// answers everything it can before an object wakes: the upgrade gate (`ingressRateGate` in
/// index.ts), the kill switch, the route, the host id and the upgrade. Only then does it hand the
/// upgrade to the Mac's own RelayObject, which checks the door itself.

/// base64url of a SHA-256 digest, always 43 characters: a host id or a token hash.
export const RELAY_DIGEST = /^[A-Za-z0-9_-]{43}$/;

export type RelayRole = "socket" | "phone";

const RELAY_PATH = /^\/relay\/v1\/hosts\/([^/]*)\/(socket|phone)$/;

/// Only exactly "1" opens the relay. Unset, empty or anything else keeps every route closed.
export function relayEnabled(env: { RELAY_ENABLED?: string }): boolean {
  return env.RELAY_ENABLED === "1";
}

/// RFC 4648 section 5, without padding, as every binary value in a relay message is written.
export function base64url(bytes: ArrayBuffer | Uint8Array): string {
  let binary = "";
  for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

/// `/relay/v1/hosts/<hostID>/socket` (the Mac) or `/phone`, with the host id not yet checked.
export function relayPath(pathname: string): { hostID: string; role: RelayRole } | null {
  const match = RELAY_PATH.exec(pathname);
  return match ? { hostID: match[1] ?? "", role: match[2] as RelayRole } : null;
}

/// The bucket an upgrade counts against: an IPv4 address, or an IPv6 /64 and never a whole IPv6
/// address, so rotating addresses inside one prefix gains nothing (threat model RT-1). An
/// IPv4-mapped IPv6 address counts as its IPv4 address. Anything unreadable is null, and the
/// caller fails closed.
export function relaySourceGroup(address: string | null | undefined): string | null {
  const text = address?.trim() ?? "";
  const quad = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(text);
  if (quad) {
    const parts = quad.slice(1).map(Number);
    return parts.every((part) => part <= 255) ? parts.join(".") : null;
  }
  // Hex digits, colons and an embedded IPv4 only, so nothing can close the bracket below early.
  if (!text.includes(":") || !/^[0-9A-Fa-f:.]+$/.test(text)) return null;
  let host: string;
  try {
    host = new URL(`http://[${text}]/`).hostname;
  } catch {
    return null;
  }
  // The URL parser writes the canonical form: lower case, no leading zeros, hex groups only and
  // at most one "::".
  const [head = "", tail] = host.slice(1, -1).split("::");
  const left = head ? head.split(":") : [];
  const right = tail ? tail.split(":") : [];
  const groups = tail === undefined
    ? left
    : [...left, ...Array<string>(8 - left.length - right.length).fill("0"), ...right];
  if (groups.slice(0, 5).every((group) => group === "0") && groups[5] === "ffff") {
    const [high = 0, low = 0] = groups.slice(6).map((group) => parseInt(group, 16));
    return `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;
  }
  return `${groups.slice(0, 4).join(":")}::/64`;
}

/// What the object learns about an upgrade's source group: a digest, never the address, because
/// the relay keeps no address in its object (threat model section 6). It names the host too, so
/// one address cannot be followed from one Mac's object to another's.
async function relaySourceDigest(hostID: string, group: string): Promise<string> {
  const text = `gospark-relay-v1|source|${hostID}|${group}`;
  return base64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
}

/// A Mac's hello opens its door when its X9.63 key hashes to the host id in the path and its raw
/// P-256 signature verifies over `gospark-relay-v1|host|<hostID>|<nonce>`, with the nonce this
/// socket was sent. Nothing in it carries a time, so clock skew cannot break it, and a hello
/// recorded on one socket fails on the next (RT-3, RT-8). Anything unreadable is a refusal.
export async function verifyHostHello(hostID: string, nonce: string, key: string, sig: string): Promise<boolean> {
  try {
    const keyBytes = base64UrlDecode(key);
    if (base64url(await crypto.subtle.digest("SHA-256", keyBytes)) !== hostID) return false;
    const publicKey = await crypto.subtle.importKey("raw", keyBytes, { name: "ECDSA", namedCurve: "P-256" }, false,
      ["verify"]);
    return await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, publicKey, base64UrlDecode(sig),
      new TextEncoder().encode(`gospark-relay-v1|host|${hostID}|${nonce}`));
  } catch {
    return false;
  }
}

type RelayRouteEnv = { RELAY: DurableObjectNamespace; RELAY_ENABLED?: string };

/// Answers every request under `/relay/`, or returns null for any other path. The upgrade gate has
/// already run, so a spent gate answers 429 even while the relay is off (spec section 3).
export async function relayRoute(request: Request, url: URL, env: RelayRouteEnv): Promise<Response | null> {
  if (!url.pathname.startsWith("/relay/")) return null;
  if (!relayEnabled(env)) return Response.json({ error: "relay_disabled" }, { status: 503 });
  const route = relayPath(url.pathname);
  if (!route) return Response.json({ error: "not_found" }, { status: 404 });
  if (!RELAY_DIGEST.test(route.hostID)) return Response.json({ error: "invalid_host_id" }, { status: 400 });
  if (request.method !== "GET" || request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
    return Response.json({ error: "upgrade_required" }, { status: 426 });
  }
  // The gate refuses a request without a readable source; this keeps the route shut on its own.
  const group = relaySourceGroup(request.headers.get("cf-connecting-ip"));
  if (!group) return Response.json({ error: "rate_limit_unavailable" }, { status: 503 });
  const relay = env.RELAY.get(env.RELAY.idFromName(`relay:${route.hostID}`));
  // A fresh request: nothing the client sent, its address included, reaches the object.
  return relay.fetch(new Request(`https://relay/${route.role === "socket" ? "host" : "phone"}`, {
    headers: {
      upgrade: "websocket",
      "x-relay-host-id": route.hostID,
      "x-relay-source": await relaySourceDigest(route.hostID, group),
    },
  }));
}
