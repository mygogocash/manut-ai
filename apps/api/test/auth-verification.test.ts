import { beforeAll, describe, expect, it, vi } from "vitest";
import { sha256Hex, verifyAppleToken } from "../src/auth";

// Ephemeral fixture keys stay inside this test process. No provider credentials are read.
let rsa: CryptoKeyPair;
let ec: CryptoKeyPair;
type FixtureJwk = JsonWebKey & { kid: string };
let rsaPublic: FixtureJwk;
let ecPublic: FixtureJwk;
const nonce = "verification-fixture-nonce";
const now = 2_000_000_000;

beforeAll(async () => {
  const rsaKeys = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true, ["sign", "verify"],
  );
  const ecKeys = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  if (!("privateKey" in rsaKeys) || !("privateKey" in ecKeys)) throw new Error("fixture_keypair_missing");
  rsa = rsaKeys;
  ec = ecKeys;
  const rsaJwk = await crypto.subtle.exportKey("jwk", rsa.publicKey);
  const ecJwk = await crypto.subtle.exportKey("jwk", ec.publicKey);
  if (!("kty" in rsaJwk) || !("kty" in ecJwk)) throw new Error("fixture_public_jwk_missing");
  rsaPublic = { ...rsaJwk, kid: "rsa-fixture", alg: "RS256", use: "sig" };
  ecPublic = { ...ecJwk, kid: "ec-fixture", alg: "ES256", use: "sig" };
});

function encode(data: Uint8Array | string): string {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function token(algorithm: "RS256" | "ES256", nonceClaim?: string): Promise<string> {
  const header = encode(JSON.stringify({ alg: algorithm, kid: algorithm === "RS256" ? "rsa-fixture" : "ec-fixture" }));
  const payload = encode(JSON.stringify({ iss: "https://appleid.apple.com", aud: "test-client", sub: "rsa-fixture-sub",
    iat: now - 60, exp: now + 600, nonce: nonceClaim ?? await sha256Hex(nonce) }));
  const signature = await crypto.subtle.sign(
    algorithm === "RS256" ? { name: "RSASSA-PKCS1-v1_5" } : { name: "ECDSA", hash: "SHA-256" },
    algorithm === "RS256" ? rsa.privateKey : ec.privateKey,
    new TextEncoder().encode(`${header}.${payload}`),
  );
  return `${header}.${payload}.${encode(new Uint8Array(signature))}`;
}

const config = (key: FixtureJwk) => ({ clientId: "test-client", nowSeconds: now, jwksJson: JSON.stringify({ keys: [key] }) });

describe("Apple identity verification boundaries", { concurrent: false }, () => {
  it("accepts an Apple-shaped RS256 identity against its RSA key", async () => {
    await expect(verifyAppleToken(await token("RS256"), nonce, config(rsaPublic)))
      .resolves.toMatchObject({ tenant: "apple:rsa-fixture-sub", provider: "apple" });
  });

  it("pins the header algorithm to the selected key", async () => {
    await expect(verifyAppleToken(await token("ES256"), nonce, config({ ...ecPublic, alg: "RS256" })))
      .rejects.toThrow("algorithm");
  });

  it("refuses alternate encodings of the same RSA signature", async () => {
    const identity = await token("RS256");
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    const last = alphabet.indexOf(identity.at(-1)!);
    // RSA-2048 has a one-byte final group. Nonzero unused pad bits decode to
    // the same signature bytes, but would create a different replay digest.
    const alternate = identity.slice(0, -1) + alphabet[last + 1];
    await expect(verifyAppleToken(identity, nonce, config(rsaPublic))).resolves.toMatchObject({ provider: "apple" });
    await expect(verifyAppleToken(`${identity}==`, nonce, config(rsaPublic))).rejects.toThrow("malformed");
    await expect(verifyAppleToken(alternate, nonce, config(rsaPublic))).rejects.toThrow("malformed");
  });

  it("keeps ES256 available only for an explicit test key source", async () => {
    const identity = await token("ES256");
    await expect(verifyAppleToken(identity, nonce, config(ecPublic))).resolves.toMatchObject({ provider: "apple" });
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ keys: [ecPublic] }));
    try {
      await expect(verifyAppleToken(identity, nonce, { clientId: "test-client", nowSeconds: now,
        jwksUrl: "https://fixture-apple-ec.example.test/keys" })).rejects.toThrow("algorithm");
    } finally { fetch.mockRestore(); }
  });

  it("verifies the production RSA JWKS loading path", async () => {
    const identity = await token("RS256");
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ keys: [rsaPublic] }));
    try {
      await expect(verifyAppleToken(identity, nonce, { clientId: "test-client", nowSeconds: now,
        jwksUrl: "https://fixture-apple-rsa.example.test/keys" })).resolves.toMatchObject({ tenant: "apple:rsa-fixture-sub" });
    } finally { fetch.mockRestore(); }
  });

  it("refuses a raw nonce claim even when the signature is valid", async () => {
    await expect(verifyAppleToken(await token("ES256", nonce), nonce, config(ecPublic))).rejects.toThrow("nonce");
  });
});
