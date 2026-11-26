/// What the phone keeps about the Mac it paired with, and the one exception to the web app's "nothing kept" rule
/// (docs/web-app.md, "What Your Mac keeps"). It lives in this origin's IndexedDB, in one database, `manut-mac`:
///
/// - `mac`: the paired Mac's host id, this phone's device id, its relay door token, K, the passkey's credential id, the
///   passkey's relying party and when it paired. K is a Web Crypto HKDF key made with `extractable: false`
///   (`importSharedSecret`), so IndexedDB keeps it as a key object and no script, ours included, can read its bytes
///   back: it can only derive a session's keys with it. The door token cannot be such a key, because the relay's hello
///   carries it as text; it opens only the relay's door for this phone, never a session (docs/remote-access.md, "A lost
///   or stolen phone").
/// - `spent`: the door ids of the last pairing codes this phone started, so a code is one try on the phone also after a
///   reload (packages/remote-channel/README.md, "What the callers must do"). A door id is random and names nothing.
///
/// Nothing of a chat is ever kept here or anywhere: chats, asks, messages and the Mac's name live in the page's memory.
/// "Forget this Mac" deletes `mac`. The passkey itself stays in the phone's passwords until the person deletes it there:
/// a page cannot delete one, and without K and the Mac's record it answers nothing.

export interface PairedMac {
  readonly hostId: string;
  readonly deviceId: string;
  /// The relay door token, 32 bytes.
  readonly doorToken: Uint8Array;
  /// K, as a key that cannot be exported.
  readonly k: CryptoKey;
  readonly credentialId: Uint8Array;
  /// The passkey's relying party: this page's host when it paired.
  readonly rpId: string;
  readonly pairedAt: number;
}

export interface PhoneVault {
  load(): Promise<PairedMac | null>;
  save(mac: PairedMac): Promise<void>;
  forget(): Promise<void>;
  /// Marks a code's door as started on this phone, and says whether it was new. False means it was started before, so
  /// the code is spent here.
  spend(doorId: string): Promise<boolean>;
}

/// How many spent doors are kept. A code lasts two minutes on the Mac, so a few are plenty.
export const MAX_SPENT = 32;

const DB = "manut-mac";
const STORE = "kept";

function isPaired(value: unknown): value is PairedMac {
  if (value === null || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.hostId === "string" &&
    typeof v.deviceId === "string" &&
    v.doorToken instanceof Uint8Array &&
    v.doorToken.length === 32 &&
    typeof CryptoKey !== "undefined" &&
    v.k instanceof CryptoKey &&
    !v.k.extractable &&
    v.credentialId instanceof Uint8Array &&
    typeof v.rpId === "string" &&
    typeof v.pairedAt === "number"
  );
}

/// In memory only: for tests, and for practice mode, whose pretend Mac is forgotten when the page reloads.
export function memoryVault(): PhoneVault & { readonly spent: readonly string[] } {
  let kept: PairedMac | null = null;
  const spent: string[] = [];
  return {
    spent,
    load: async () => kept,
    save: async (mac) => {
      kept = mac;
    },
    forget: async () => {
      kept = null;
    },
    spend: async (doorId) => {
      if (spent.includes(doorId)) return false;
      spent.push(doorId);
      if (spent.length > MAX_SPENT) spent.splice(0, spent.length - MAX_SPENT);
      return true;
    },
  };
}

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("indexeddb"));
  });
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error ?? new Error("indexeddb"));
    tx.onerror = () => reject(tx.error ?? new Error("indexeddb"));
  });
}

/// The phone's own vault, in this origin's IndexedDB. Every call opens the database afresh and closes it, so nothing
/// holds it open while the app sits in the background.
export function indexedDbVault(factory: IDBFactory = indexedDB): PhoneVault {
  const open = (): Promise<IDBDatabase> =>
    new Promise((resolve, reject) => {
      const req = factory.open(DB, 1);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error ?? new Error("indexeddb"));
      req.onblocked = () => reject(new Error("indexeddb blocked"));
    });
  const run = async <T>(mode: IDBTransactionMode, work: (store: IDBObjectStore) => Promise<T>): Promise<T> => {
    const db = await open();
    try {
      const tx = db.transaction(STORE, mode);
      const finished = done(tx);
      const result = await work(tx.objectStore(STORE));
      await finished;
      return result;
    } finally {
      db.close();
    }
  };
  return {
    load: () => run("readonly", async (store) => {
      const value: unknown = await request(store.get("mac"));
      return isPaired(value) ? value : null;
    }),
    save: (mac) => run("readwrite", async (store) => {
      if (mac.k.extractable) throw new Error("K must not be extractable");
      await request(store.put({ ...mac }, "mac"));
    }),
    forget: () => run("readwrite", async (store) => {
      await request(store.delete("mac"));
    }),
    // One read-write transaction: two tabs starting the same code at once are serialised by IndexedDB, so only one wins.
    spend: (doorId) => run("readwrite", async (store) => {
      const kept: unknown = await request(store.get("spent"));
      const spent = Array.isArray(kept) ? kept.filter((x): x is string => typeof x === "string") : [];
      if (spent.includes(doorId)) return false;
      await request(store.put([...spent, doorId].slice(-MAX_SPENT), "spent"));
      return true;
    }),
  };
}
