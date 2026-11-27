import { describe, expect, it } from "vitest";
import {
  MAX_FRAME_BYTES,
  decodePairingGrant,
  decodePairingOffer,
  doorTokenHash,
  encodePairingGrant,
  encodePairingOffer,
  fromBase64Url,
  newPairingGrant,
  newPairingOffer,
  pairingLink,
  readPairingLink,
  toBase64Url,
} from "../src/index";
import relayVectors from "../../../apps/api/test/fixtures/relay-v1-vectors.json";
import { HOST_ID, refusal, seededRandom } from "./support";

/// What the QR code carries, and the grant the Mac hands the phone after Allow. Ported from
/// GoSpark's `RemotePairingInvitation` (`Shared/Remote/RemoteHandshake.swift`) and its test
/// "pairing links require private literal addresses and an exact 256-bit key": here the code
/// names a relay host and a one-use door instead of LAN addresses, and its secret travels in the
/// link's fragment, which a browser never sends to a server.

const APP = "https://manut.xyz/app/";

describe("the pairing offer", () => {
  it("draws its door and secret from the random source it is given", () => {
    const offer = newPairingOffer(HOST_ID, seededRandom(1));
    expect(offer.hostId).toBe(HOST_ID);
    expect(offer.doorId).toMatch(/^[0-9A-F]{8}-[0-9A-F]{4}-4[0-9A-F]{3}-[89AB][0-9A-F]{3}-[0-9A-F]{12}$/);
    expect(offer.doorToken).toEqual(Uint8Array.from({ length: 32 }, (_, i) => 17 + i));
    expect(offer.secret).toEqual(Uint8Array.from({ length: 32 }, (_, i) => 49 + i));
    // Two offers never share a secret when the source is random.
    expect(newPairingOffer(HOST_ID).secret).not.toEqual(newPairingOffer(HOST_ID).secret);
  });

  it("encodes to 113 bytes of base64url and back", () => {
    const offer = newPairingOffer(HOST_ID, seededRandom(1));
    const text = encodePairingOffer(offer);
    expect(text).toMatch(/^[A-Za-z0-9_-]{151}$/);
    expect(fromBase64Url(text)).toHaveLength(113);
    expect(decodePairingOffer(text)).toEqual(offer);
  });

  it("puts the secret in the link's fragment, never in its path or query", () => {
    const offer = newPairingOffer(HOST_ID, seededRandom(1));
    const link = pairingLink(APP, offer);
    const url = new URL(link);
    expect(url.origin + url.pathname).toBe(APP);
    expect(url.search).toBe("");
    expect(url.hash).toBe(`#pair=${encodePairingOffer(offer)}`);
    expect(readPairingLink(link)).toEqual(offer);
    // Pasted with the whitespace a copy picks up, or as the bare code.
    expect(readPairingLink(`  ${link}\n`)).toEqual(offer);
    expect(readPairingLink(encodePairingOffer(offer))).toEqual(offer);
  });

  it("refuses an app address that is not https, or that already has a query or fragment", () => {
    const offer = newPairingOffer(HOST_ID, seededRandom(1));
    expect(() => pairingLink("http://manut.xyz/app/", offer)).toThrow();
    expect(() => pairingLink("https://manut.xyz/app/?x=1", offer)).toThrow();
    expect(() => pairingLink("https://manut.xyz/app/#x", offer)).toThrow();
    expect(() => pairingLink("not a url", offer)).toThrow();
    // A page served from this Mac during development is the one plain-HTTP exception.
    expect(pairingLink("http://localhost:5173/app/", offer)).toMatch(/^http:\/\/localhost:5173\/app\/#pair=/);
  });

  it("refuses a code with the wrong version, length or alphabet, or a secret put in the query", async () => {
    const offer = newPairingOffer(HOST_ID, seededRandom(1));
    const bytes = fromBase64Url(encodePairingOffer(offer));
    const versioned = bytes.slice();
    versioned[0] = 2;
    const cases = [
      toBase64Url(versioned),
      toBase64Url(bytes.slice(0, 112)),
      toBase64Url(Uint8Array.from([...bytes, 0])),
      `${encodePairingOffer(offer)}=`,
      `${APP}?pair=${encodePairingOffer(offer)}`,
      `${APP}?pair=${encodePairingOffer(offer)}#pair=${encodePairingOffer(offer)}`,
      `${APP}#pair=${encodePairingOffer(offer)}&next=1`,
      `${APP}#code=${encodePairingOffer(offer)}`,
      "x".repeat(5000),
      "",
    ];
    for (const text of cases) expect(await refusal(async () => readPairingLink(text)), text.slice(0, 60)).toBe("malformed");
  });

  it("refuses a host id that is not the relay's form", () => {
    expect(() => newPairingOffer("not-a-host", seededRandom(1))).toThrow();
  });
});

describe("the grant", () => {
  it("holds the phone's device id, its relay door token and K, in 82 bytes", () => {
    const grant = newPairingGrant(seededRandom(7));
    expect(grant.deviceId).toMatch(/^[0-9A-F]{8}-[0-9A-F]{4}-4[0-9A-F]{3}-[89AB][0-9A-F]{3}-[0-9A-F]{12}$/);
    const bytes = encodePairingGrant(grant);
    expect(bytes).toHaveLength(82);
    expect(decodePairingGrant(bytes)).toEqual(grant);
  });

  it("refuses a grant of another length, type or version", async () => {
    const bytes = encodePairingGrant(newPairingGrant(seededRandom(7)));
    expect(await refusal(async () => decodePairingGrant(bytes.slice(0, 81)))).toBe("malformed");
    expect(await refusal(async () => decodePairingGrant(Uint8Array.from([...bytes, 0])))).toBe("malformed");
    expect(await refusal(async () => decodePairingGrant(Uint8Array.from([0x41, ...bytes.slice(1)])))).toBe("malformed");
    expect(await refusal(async () => decodePairingGrant(Uint8Array.from([0x40, 0x02, ...bytes.slice(2)])))).toBe("malformed");
  });

  it("hashes a door token as the relay checks it, against the relay's own vectors", async () => {
    const { token, tokenHash } = relayVectors.deviceToken;
    expect(await doorTokenHash(fromBase64Url(token))).toBe(tokenHash);
    expect(await refusal(() => doorTokenHash(new Uint8Array(31)))).toBe("invalid");
  });

  it("splits records to the relay's payload limit, as the relay's vectors state it", () => {
    expect(MAX_FRAME_BYTES).toBe(relayVectors.wire.maxPayloadBytes);
  });
});

describe("version 2: the Mac's tailnet name (item 78f-2d)", () => {
  const NAME = "mac.tail1234.ts.net";

  it("carries the tailnet name after version 1's bytes, and reads back exactly", () => {
    const offer = newPairingOffer("A".repeat(43), undefined, NAME);
    const text = encodePairingOffer(offer);
    const bytes = fromBase64Url(text);
    expect(bytes[0]).toBe(2);
    expect(bytes).toHaveLength(113 + 1 + NAME.length);
    expect(bytes[113]).toBe(NAME.length);
    expect(decodePairingOffer(text)).toEqual(offer);
    expect(readPairingLink(pairingLink("https://dev.manut.xyz/app/", offer)).tailnet).toBe(NAME);
  });

  it("leaves a code without a tailnet as version 1, byte for byte", () => {
    const offer = newPairingOffer("A".repeat(43));
    expect(fromBase64Url(encodePairingOffer(offer))[0]).toBe(1);
    expect(decodePairingOffer(encodePairingOffer(offer)).tailnet).toBeUndefined();
  });

  it("refuses a name the desktop would not accept, at either end", () => {
    for (const bad of ["evil.example.com", "x.ts.net.evil.com", "MAC.tail1234.ts.net", "ts.net", "-mac.tail1234.ts.net"]) {
      expect(() => newPairingOffer("A".repeat(43), undefined, bad), bad).toThrow();
    }
    const good = fromBase64Url(encodePairingOffer(newPairingOffer("A".repeat(43), undefined, NAME)));
    const forge = (name: string, len = name.length) => {
      const raw = new TextEncoder().encode(name);
      const out = new Uint8Array(114 + raw.length);
      out.set(good.subarray(0, 113));
      out[113] = len;
      out.set(raw, 114);
      return toBase64Url(out);
    };
    expect(() => decodePairingOffer(forge("evil.example.com"))).toThrow();
    expect(() => decodePairingOffer(forge(NAME, NAME.length + 1))).toThrow();
    expect(() => decodePairingOffer(forge(NAME, 0))).toThrow();
    expect(() => decodePairingOffer(forge("mäc.tail1234.ts.net"))).toThrow();
    expect(() => decodePairingOffer(toBase64Url(good.subarray(0, 113)))).toThrow();
    expect(() => decodePairingOffer(forge(NAME) + "AA")).toThrow();
  });

  it("prints its secrets redacted, the name in the clear", () => {
    const printed = JSON.stringify(newPairingOffer("A".repeat(43), undefined, NAME));
    expect(printed).toContain(NAME);
    expect(printed).not.toMatch(/"secret":\{|"secret":"[A-Za-z0-9_-]{20}/);
  });
});
