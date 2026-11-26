import { expect, test } from "./fixtures";

// What the Your Mac tab keeps (src/app/mac/vault.ts, docs/web-app.md "What Your Mac keeps"), in each phone's real
// browser engine, since jsdom has no IndexedDB: K survives a reload as a key no script can read back but can still use,
// a key that could be read back is refused, a code's door is spent across a reload, Forget removes the Mac's record and
// nothing else is written to the page's other storage. The module is loaded from the dev server as the page loads it.

test("keeps K unreadable across a reload, spends a code once across a reload, and forgets the Mac", async ({ page }) => {
  await page.goto("/app/#mac");
  // The page has started, so the dev server's first module load is done before the vault's module is asked for.
  await page.getByRole("heading", { name: "Your Mac", exact: true }).waitFor();
  const first = await page.evaluate(async () => {
    const path = "/src/app/mac/vault.ts";
    const { indexedDbVault } = (await import(path)) as typeof import("../src/app/mac/vault");
    const vault = indexedDbVault();
    const k = await crypto.subtle.importKey("raw", crypto.getRandomValues(new Uint8Array(32)), "HKDF", false, ["deriveBits"]);
    // Browsers never let an HKDF key be read back; a key that could be is refused by the vault all the same.
    const loose = await crypto.subtle.importKey("raw", crypto.getRandomValues(new Uint8Array(32)), "AES-GCM", true, ["encrypt"]);
    const record = {
      hostId: "H".repeat(43),
      deviceId: "0B6A2C1E-4D5F-4A6B-8C7D-9E0F1A2B3C4D",
      doorToken: new Uint8Array(32).fill(9),
      k,
      credentialId: new Uint8Array(16).fill(1),
      rpId: location.hostname,
      pairedAt: 1,
    };
    let looseRefused = false;
    try {
      await vault.save({ ...record, k: loose });
    } catch {
      looseRefused = true;
    }
    await vault.save(record);
    return { looseRefused, spent: [await vault.spend("door-1"), await vault.spend("door-1")] };
  });
  expect(first).toEqual({ looseRefused: true, spent: [true, false] });

  await page.reload();
  await page.getByRole("heading", { name: "Your Mac", exact: true }).waitFor();
  const after = await page.evaluate(async () => {
    const path = "/src/app/mac/vault.ts";
    const { indexedDbVault } = (await import(path)) as typeof import("../src/app/mac/vault");
    const vault = indexedDbVault();
    const mac = await vault.load();
    if (!mac) return null;
    let exported = "refused";
    try {
      await crypto.subtle.exportKey("raw", mac.k);
      exported = "exported";
    } catch {
      // A key made with extractable false stays so in IndexedDB.
    }
    const bits = await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: new Uint8Array(32), info: new Uint8Array(0) }, mac.k, 256);
    const spentAgain = await vault.spend("door-1");
    await vault.forget();
    return {
      extractable: mac.k.extractable,
      exported,
      derived: bits.byteLength,
      token: Array.from(mac.doorToken).every((b) => b === 9),
      spentAgain,
      forgotten: (await vault.load()) === null,
      // Forget leaves the spent doors: a code is still one try.
      stillSpent: (await vault.spend("door-1")) === false,
      other: localStorage.length + sessionStorage.length,
    };
  });
  expect(after).toEqual({ extractable: false, exported: "refused", derived: 32, token: true, spentAgain: false, forgotten: true, stillSpent: true, other: 0 });
});
