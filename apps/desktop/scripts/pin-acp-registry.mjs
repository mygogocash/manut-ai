#!/usr/bin/env node
// Pins one release of the Agent Client Protocol's agent registry (agentclientprotocol/registry, Apache-2.0) into the
// app, by hand. The app itself never fetches the registry: Settings › Providers reads only the copy this script writes
// (src-tauri/acp-registry/, compiled into the shell by src-tauri/src/acp_registry.rs). Run it from apps/desktop when a
// newer registry is wanted, read what it prints and `git diff`, and commit only what you mean to keep:
//
//   node scripts/pin-acp-registry.mjs                        # the registry's newest release
//   node scripts/pin-acp-registry.mjs v2026.11.26-3667256    # one release, by its tag
//
// It writes two files and nothing else:
//
// - `registry.json`: the release's `registry.json` asset, byte for byte, as the registry's own CI published it.
// - `pin.json`: where that file came from (the asset's address, the release's tag and date, the commit the tag names) and
//   its SHA-256, which a Rust test holds the committed file to; the registry's own `quarantine.json` at that commit (the
//   agents its CI has set aside, with its reason); and, for each npm package the registry runs through `npx`, the command
//   that package installs, read from the package's own manifest on registry.npmjs.org at the pinned version and chosen as
//   `npm exec` chooses it (`npm help exec`: the one `bin` entry, or the entries that all name one file, or the one named
//   after the package without its scope). Manut AI never runs `npx`: it shows `npm install -g <package>` for the person to
//   run and then starts that command.
//
// Nothing here runs anything the registry names. Read-only requests: GitHub's API and release download, raw.githubusercontent.com
// and registry.npmjs.org.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = "agentclientprotocol/registry";
const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, "..", "src-tauri", "acp-registry");
const TAG = /^v\d{4}\.\d{2}\.\d{2}-[0-9a-f]{7,40}$/;

async function get(url, json = true) {
  const res = await fetch(url, { headers: { "user-agent": "manut-pin-acp-registry", accept: json ? "application/json" : "*/*" }, redirect: "follow" });
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  return json ? res.json() : new Uint8Array(await res.arrayBuffer());
}

/** `@scope/name@1.2.3` -> [`@scope/name`, `1.2.3`]; `name@1.2.3` -> [`name`, `1.2.3`]; no version -> [spec, ""]. */
function splitSpec(spec) {
  const at = spec.lastIndexOf("@");
  return at > 0 ? [spec.slice(0, at), spec.slice(at + 1)] : [spec, ""];
}

/** The command `npm exec <package>` runs (npm help exec), or null when npm itself would refuse to pick one. */
function npmBin(manifest) {
  let bin = manifest.bin ?? {};
  const bare = String(manifest.name ?? "").replace(/^@[^/]+\//, "");
  if (typeof bin === "string") bin = { [bare]: bin };
  const names = Object.keys(bin);
  if (names.length === 0) return null;
  if (names.length === 1) return names[0];
  // several names for one file are one command: the one named after the package, else the first
  if (new Set(Object.values(bin)).size === 1) return names.includes(bare) ? bare : names[0];
  return names.includes(bare) ? bare : null;
}

const want = process.argv[2];
if (want && !TAG.test(want)) throw new Error(`not a registry release tag: ${want}`);
const release = await get(`https://api.github.com/repos/${REPO}/releases/${want ? `tags/${want}` : "latest"}`);
const tag = release.tag_name;
if (!TAG.test(tag)) throw new Error(`unexpected tag ${tag}`);
let ref = (await get(`https://api.github.com/repos/${REPO}/git/ref/tags/${tag}`)).object;
if (ref.type === "tag") ref = (await get(ref.url)).object;
const commit = ref.sha;
if (!commit.startsWith(tag.split("-").pop())) throw new Error(`tag ${tag} names commit ${commit}`);

const source = `https://github.com/${REPO}/releases/download/${tag}/registry.json`;
const bytes = await get(source, false);
const registry = JSON.parse(new TextDecoder().decode(bytes));
const sha256 = createHash("sha256").update(bytes).digest("hex");
let quarantine = {};
try {
  quarantine = await get(`https://raw.githubusercontent.com/${REPO}/${commit}/quarantine.json`);
} catch (e) {
  console.warn(`no quarantine.json at ${commit}: ${e.message}`);
}

const bins = {};
for (const agent of registry.agents ?? []) {
  const spec = agent?.distribution?.npx?.package;
  if (typeof spec !== "string" || bins[spec] !== undefined) continue;
  const [name, version] = splitSpec(spec);
  try {
    const manifest = await get(`https://registry.npmjs.org/${name.replace("/", "%2f")}/${version || "latest"}`);
    const bin = npmBin(manifest);
    if (bin) bins[spec] = bin;
    else console.warn(`${agent.id}: npm would not pick one command from ${spec}; it is not offered`);
  } catch (e) {
    console.warn(`${agent.id}: ${spec}: ${e.message}; it is not offered`);
  }
}

// what changed since the copy in the repository, so nothing is kept unread
const before = existsSync(join(OUT, "registry.json")) ? JSON.parse(readFileSync(join(OUT, "registry.json"), "utf8")) : { agents: [] };
const was = new Map((before.agents ?? []).map((a) => [a.id, a]));
const now = new Map((registry.agents ?? []).map((a) => [a.id, a]));
for (const [id, a] of now) {
  const old = was.get(id);
  if (!old) console.log(`+ ${id} ${a.version}`);
  else if (JSON.stringify(old) !== JSON.stringify(a)) console.log(`~ ${id} ${old.version} -> ${a.version}`);
}
for (const id of was.keys()) if (!now.has(id)) console.log(`- ${id}`);

writeFileSync(join(OUT, "registry.json"), bytes);
const pin = {
  source,
  tag,
  commit,
  published: release.published_at,
  sha256,
  license: "Apache-2.0",
  quarantine,
  bins,
};
writeFileSync(join(OUT, "pin.json"), `${JSON.stringify(pin, null, 2)}\n`);
console.log(`pinned ${tag} (${commit.slice(0, 7)}, ${release.published_at}), ${now.size} agents, sha256 ${sha256}`);
console.log("Then: UPDATE_ACP_REGISTRY_MOCK=1 cargo test acp_registry (the mock host's copy), and read `git diff`.");
