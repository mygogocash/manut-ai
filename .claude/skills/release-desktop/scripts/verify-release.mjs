// Checks a downloaded release folder against the app's pinned updater key: every `.sig` must be a minisign signature
// by that key over the file beside it, and latest.json must name both Mac chips with those same signatures.
// Usage: node verify-release.mjs <downloads dir> <path to tauri.conf.json> [<assets.json>]
// assets.json is `gh release view <tag> --repo mygogocash/manut-ai --json assets`, needed for a release made by
// tauri-action 1.0 or later, whose latest.json names each file by its asset id (release-assets.mjs).
import { createHash, createPublicKey, verify } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { updateFileName } from "./release-assets.mjs";

const [dir, conf, assetsFile] = process.argv.slice(2);
const assets = assetsFile ? JSON.parse(readFileSync(assetsFile, "utf8")).assets : undefined;
const pinned = JSON.parse(readFileSync(conf, "utf8")).plugins.updater.pubkey;
const keyLine = Buffer.from(pinned, "base64").toString("utf8").trim().split("\n")[1];
const keyBytes = Buffer.from(keyLine, "base64"); // "Ed", the key's id (8 bytes), the key (32 bytes)
const keyId = keyBytes.subarray(2, 10);
const publicKey = createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), keyBytes.subarray(10)]), format: "der", type: "spki" });
const idHex = Buffer.from(keyId).reverse().toString("hex").toUpperCase();
console.log("pinned key id:", idHex);

let failed = 0;
const check = (ok, what) => { console.log(ok ? "ok  " : "FAIL", what); if (!ok) failed++; };

const verifySig = (sigText, file, what) => {
  const lines = Buffer.from(sigText.trim(), "base64").toString("utf8").split("\n");
  const sig = Buffer.from(lines[1], "base64"); // the algorithm (2 bytes), the key's id (8), the signature (64)
  const alg = sig.subarray(0, 2).toString("latin1");
  const data = readFileSync(file);
  const signed = alg === "ED" ? createHash("blake2b512").update(data).digest() : data;
  check(sig.subarray(2, 10).equals(keyId), `${what}: signed with the pinned key's id`);
  check(verify(null, signed, publicKey, sig.subarray(10)), `${what}: the signature verifies (${alg === "ED" ? "prehashed" : "legacy"})`);
  const trusted = lines[2].replace(/^trusted comment: /, "");
  const global = Buffer.from(lines[3], "base64");
  check(verify(null, Buffer.concat([sig.subarray(10), Buffer.from(trusted, "utf8")]), publicKey, global), `${what}: the trusted comment verifies`);
};

const files = readdirSync(dir);
for (const name of files.filter((f) => f.endsWith(".sig"))) {
  const target = name.slice(0, -4);
  check(files.includes(target), `${name}: the file it signs is here`);
  if (files.includes(target)) verifySig(readFileSync(join(dir, name), "utf8"), join(dir, target), target);
}
if (files.includes("latest.json")) {
  const latest = JSON.parse(readFileSync(join(dir, "latest.json"), "utf8"));
  console.log("latest.json version:", latest.version, "platforms:", Object.keys(latest.platforms).join(", "));
  for (const chip of ["darwin-aarch64", "darwin-x86_64"]) {
    const entry = latest.platforms[chip];
    check(!!entry, `latest.json names ${chip}`);
    if (!entry) continue;
    const { name, error } = updateFileName(entry.url, assets);
    check(!!name, `${chip}: its address is this repository's release (${name ?? error})`);
    if (!name) continue;
    const local = files.find((f) => f === name || f === name.replace(/ /g, ".") || f.replace(/\./g, " ") === name.replace(/\./g, " "));
    check(!!local, `${chip}: that file is in the release`);
    if (local) verifySig(entry.signature, join(dir, local), `${chip} as latest.json signs it`);
  }
} else check(false, "latest.json is in the release");
console.log(failed ? `${failed} check(s) FAILED` : "every check passed");
process.exit(failed ? 1 : 0);
