/// Broker-only credential cryptography. AES-GCM with a per-secret random IV;
/// the key itself lives in the operator secret store, never in code, logs,
/// or model context. Pure functions over explicit keys so rotation fallback
/// qualifies without touching a live store.

export type SealedSecret = {
  keyTag: string;
  iv: string;
  data: string;
};

function hexToBytes(hex: string): Uint8Array {
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) throw new Error("key");
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

function base64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function unbase64(input: string): Uint8Array {
  const binary = atob(input);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function importKey(hex: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", hexToBytes(hex), { name: "AES-GCM" }, false, [
    "encrypt",
    "decrypt",
  ]);
}

export async function keyTag(hex: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", hexToBytes(hex));
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 12);
}

export async function sealSecret(plaintext: string, hex: string): Promise<SealedSecret> {
  const iv = new Uint8Array(12);
  crypto.getRandomValues(iv);
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    await importKey(hex),
    new TextEncoder().encode(plaintext),
  );
  return { keyTag: await keyTag(hex), iv: base64(iv), data: base64(new Uint8Array(ciphertext)) };
}

/// Decrypts with whichever configured key matches the seal's tag: current
/// first, then the previous one after a rotation. An unknown tag fails
/// closed without attempting decryption.
export async function openSecret(
  sealed: SealedSecret,
  currentHex: string,
  previousHex?: string,
): Promise<string> {
  let hex: string | null = null;
  if (sealed.keyTag === (await keyTag(currentHex))) hex = currentHex;
  else if (previousHex && sealed.keyTag === (await keyTag(previousHex))) hex = previousHex;
  if (!hex) throw new Error("key");
  try {
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: unbase64(sealed.iv) },
      await importKey(hex),
      unbase64(sealed.data),
    );
    return new TextDecoder().decode(plaintext);
  } catch {
    throw new Error("decrypt");
  }
}
