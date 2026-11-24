/// Sealing a vault's secrets again under the current key, after an operator rotates it.
///
/// A rotation sets `CRED_KEY` to a new key and moves the old one to `CRED_KEY_PREVIOUS`. Every secret then still opens,
/// because `openSecret` (cred-crypto.ts) falls back to the previous key, but only for as long as that key is configured:
/// the next rotation would leave every secret sealed before it unreadable. Re-sealing opens each record still sealed
/// under another key and seals it again under the current one, so the previous key can be retired once nothing needs it.
///
/// One driver serves both of a shop's stores, its connections' secrets (cred-object.ts) and its site sign-ins'
/// passwords (sign-in-vault.ts), each through a small adapter that says which records are live and how one is read and
/// written. Nothing here logs, returns or keeps a secret: it lives in one local for the length of one record.

import { keyTag, openSecret, sealSecret, type SealedSecret } from "./cred-crypto";

/// What re-sealing one store did: how many records it sealed again under the current key, how many already were, the
/// ids of any whose seal neither configured key opens (a secret nobody can recover, which its owner must give again),
/// and how many live records still carry another key's seal once it finished. `remaining` 0 means this store no longer
/// needs the previous key.
export type ResealCount = { resealed: number; current: number; unreadable: string[]; remaining: number };

/// A record a vault keeps sealed: its id, and its seal.
type Sealed = { id: string; sealed: SealedSecret };

/// How the driver reaches one store's records.
export type ResealStore<T extends Sealed> = {
  /// Every live record of the shop, as stored now: a revoked connection or a removed sign-in is not live, and keeps no
  /// secret to seal.
  live: () => Promise<T[]>;
  /// One record read again, or undefined when it is gone or no longer live.
  reread: (id: string) => Promise<T | undefined>;
  write: (record: T) => Promise<void>;
};

/// The keys a re-seal works with: the current one, which every record ends sealed under, and the previous one, which
/// opens what was sealed before the rotation.
export type ResealKeys = { CRED_KEY: string; CRED_KEY_PREVIOUS?: string | undefined };

/// Whether two seals are the same one: the same key, the same IV and the same ciphertext.
export function sameSeal(a: SealedSecret, b: SealedSecret): boolean {
  return a.keyTag === b.keyTag && a.iv === b.iv && a.data === b.data;
}

/// Seals every live record of `store` that is not sealed under `keys.CRED_KEY` again under it.
///
/// Opening and sealing are crypto work, which lets other requests into the vault object while they run, so each record
/// is read again afterwards, and the new seal is written only if the record is still live and still holds the seal that
/// was opened. A secret replaced, revoked or removed meanwhile is left exactly as it now is, never brought back. The
/// read and the write that follow are storage calls only, so nothing else runs between them. `seal` is the sealing
/// function, `sealSecret` but for a test that needs something to happen while a secret is being sealed.
export async function resealStore<T extends Sealed>(
  store: ResealStore<T>,
  keys: ResealKeys,
  seal: (plaintext: string, hex: string) => Promise<SealedSecret> = sealSecret,
): Promise<ResealCount> {
  const current = await keyTag(keys.CRED_KEY);
  const count: ResealCount = { resealed: 0, current: 0, unreadable: [], remaining: 0 };
  for (const record of await store.live()) {
    if (record.sealed.keyTag === current) {
      count.current++;
      continue;
    }
    let secret: string;
    try {
      secret = await openSecret(record.sealed, keys.CRED_KEY, keys.CRED_KEY_PREVIOUS);
    } catch {
      // Sealed under a key that is configured no longer: nothing can open it, so it is named and left as it is.
      count.unreadable.push(record.id);
      continue;
    }
    const sealed = await seal(secret, keys.CRED_KEY);
    const now = await store.reread(record.id);
    if (!now || !sameSeal(now.sealed, record.sealed)) continue;
    await store.write({ ...now, sealed });
    count.resealed++;
  }
  // Counted from storage again, not from the work above, so a record added or changed meanwhile under the previous key
  // still shows as one that needs it.
  for (const record of await store.live()) if (record.sealed.keyTag !== current) count.remaining++;
  return count;
}
