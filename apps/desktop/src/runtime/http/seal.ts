// Sealing the kept read of the shop (cache.ts), so the file on disk can be read only with a key the keychain holds: a
// copy of it (a backup, a sync folder, another account on a shared Mac) shows none of the drafts, customers' LINE ids or
// open requests it keeps (docs/runtime-adapter.md, "The offline cache").
//
// Rules this module keeps:
// - AES-GCM through the webview's own Web Crypto, with a 256-bit key, a fresh random 96-bit nonce for every write and
//   GCM's full 128-bit tag. The file's version, origin and tenant are bound in as associated data, so a file opens only
//   as the version and the shop it was written for, even with the right key. Web Crypto, rather than macOS's
//   CommonCrypto in the shell, because its AES-GCM is a public, standard interface where CommonCrypto's is private
//   (CommonCryptorSPI.h), because the page alone knows the origin and tenant (the shell sees only the file's hashed
//   name), and because the tests run the same interface in Node (docs/decisions.md).
// - The key comes from the shell (src-tauri/src/shop_cache_key.rs) as 64 hex digits, as the session does, and is imported
//   at once as a key script can use but never read back (`extractable: false`); the bytes it came in are zeroed.
// - The file is one line that says its own version before anything is opened, `{"v":6,"iv":…,"sealed":…}`, with the
//   nonce and the sealed bytes (GCM's tag at their end) in base64url. Its whole shape is checked with one pattern and no
//   JSON parser, so a file that is not one (above all an earlier version's, which kept the read in plain text) is never
//   parsed, let alone shown.
// - Opening answers null for any file that does not open: another version, a changed byte, a file cut short, another
//   key, another origin or tenant. A webview with no Web Crypto raises instead, so a good file is never taken for a bad
//   one and deleted.

/** Bytes in a nonce: 96 bits, as GCM is meant to be used. */
const NONCE_BYTES = 12;
/** Bytes in GCM's tag, at the end of the sealed bytes. */
const TAG_BYTES = 16;
/** Bytes in a key: AES-256. */
const KEY_BYTES = 32;

/** The whole file, and nothing else: its version, then its nonce (16 base64url characters are 12 bytes), then the
 *  sealed bytes (at least the tag). */
const FILE = /^\{"v":([0-9]{1,9}),"iv":"([A-Za-z0-9_-]{16})","sealed":"([A-Za-z0-9_-]{22,})"\}$/;

/** The webview's Web Crypto. It exists only in a secure context, which the packaged app's page is (`tauri://localhost`,
 *  checked on this Mac in a throwaway Tauri program on the app's Tauri and CSP), as is the development server's
 *  `http://localhost`. */
function subtle(): SubtleCrypto {
  const s = globalThis.crypto?.subtle;
  if (!s) throw new Error("no Web Crypto");
  return s;
}

/** What a file is bound to besides its key: the file's version, origin and tenant, as a list, so no part of one can be
 *  read as part of another, under a name that says what they are for. */
function boundTo(version: number, origin: string, tenant: string): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(JSON.stringify(["manut.shop-cache", version, origin, tenant]));
}

/** The key the shell gave, as Web Crypto holds it; null when what it gave is not 64 lowercase hex digits. */
export async function importSealKey(hex: string): Promise<CryptoKey | null> {
  if (!/^[0-9a-f]{64}$/.test(hex)) return null;
  const bytes = new Uint8Array(KEY_BYTES);
  for (let i = 0; i < KEY_BYTES; i += 1) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  try {
    return await subtle().importKey("raw", bytes, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
  } finally {
    bytes.fill(0);
  }
}

/** `plain` sealed for `version`, `origin` and `tenant`, as the file holds it. */
export async function seal(plain: string, key: CryptoKey, version: number, origin: string, tenant: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(NONCE_BYTES));
  const params = { name: "AES-GCM", iv, additionalData: boundTo(version, origin, tenant), tagLength: TAG_BYTES * 8 };
  const sealed = new Uint8Array(await subtle().encrypt(params, key, new TextEncoder().encode(plain)));
  return `{"v":${version},"iv":"${toBase64Url(iv)}","sealed":"${toBase64Url(sealed)}"}`;
}

/** What `text` holds, when it is a file sealed with `key` for exactly this `version`, `origin` and `tenant` and not a
 *  byte of it has changed; else null. */
export async function open(text: string, key: CryptoKey, version: number, origin: string, tenant: string): Promise<string | null> {
  const m = FILE.exec(text);
  // Another version's file is not opened at all: what it holds is not what this build reads.
  if (!m || Number(m[1]) !== version) return null;
  // The pattern fixes the nonce at 12 bytes and the sealed bytes at 16 or more, but lets through a length that base64
  // cannot have.
  const iv = fromBase64Url(m[2]);
  const sealed = fromBase64Url(m[3]);
  if (!iv || !sealed) return null;
  const s = subtle();
  let plain: ArrayBuffer;
  try {
    plain = await s.decrypt({ name: "AES-GCM", iv, additionalData: boundTo(version, origin, tenant), tagLength: TAG_BYTES * 8 }, key, sealed);
  } catch (e) {
    // GCM's check failed: the file was changed, cut short, or sealed with another key or for another file. Anything else
    // is not the file's doing.
    if ((e as { name?: unknown } | null)?.name === "OperationError") return null;
    throw e;
  }
  return new TextDecoder().decode(plain);
}

// ---- base64url, without padding ---------------------------------------------------------------------------------------

/** Bytes per call to `String.fromCharCode`, well under any engine's limit on a call's arguments. */
const CHUNK = 0x2000;

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHUNK) binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** The bytes `text` (base64url, without padding) stands for, or null when it stands for none. */
function fromBase64Url(text: string): Uint8Array<ArrayBuffer> | null {
  if (text.length % 4 === 1) return null;
  let binary: string;
  try {
    binary = atob(text.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((text.length + 3) % 4));
  } catch {
    return null;
  }
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}
