import { createExecutionContext, runInDurableObject, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MAX_ARTIFACT_BYTES, MAX_SKILL_FILES, MAX_SKILLS, skillPathRefusal, skillsRefusal } from "../src/artifact-store";
import { forgetArtifactSwitch, PAGE_CACHE, PUBLIC_HEADERS } from "../src/artifacts";
import worker, { type Env } from "../src/index";
import { tenantExport, tenantStub } from "../src/tenant-data";
import { bindings, joinHelper, linkedOwner, setFlags, setupShop, type Shop } from "./people-fixtures";

/// Skill links (item 84; artifacts.ts, artifact-store.ts; docs/pilot-api.md, "Skill links"): a bundle of skills published as an
/// artifact link of its own kind. The safety rules are the point: a path with `..`, an absolute path and a dot-file are refused
/// before anything is stored, a binary file is refused by name, the bundle is held to the pages' size, its own switch keeps it
/// off while pages stay on, and its public read is inert (JSON or plain text, never HTML) with the same 404 for every link that
/// opens nothing. Sessions are minted through the real routes; the artifact origin is the test's own.

const ORIGIN = "https://links.manut-pages.test";
const withOrigin = { ...bindings, ARTIFACT_ORIGIN: ORIGIN } as Env;

type Answer = { status: number; headers: Headers; body: Record<string, unknown> };

async function send(path: string, init: RequestInit = {}, host = "api.manut.test"): Promise<Response> {
  const request = new Request(`https://${host}${path}`, init);
  request.headers.set("cf-connecting-ip", `2001:db8:${crypto.randomUUID().replaceAll("-", "").slice(0, 24).match(/.{4}/g)!.join(":")}`);
  const context = createExecutionContext();
  const response = await worker.fetch(request, withOrigin, context);
  await waitOnExecutionContext(context);
  return response;
}

async function asOwner(headers: { authorization?: string }, method: string, path: string, body?: unknown): Promise<Answer> {
  const response = await send(path, { method, headers: { ...headers, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, headers: response.headers, body: (await response.json()) as Record<string, unknown> };
}

const publish = (headers: { authorization?: string }, body: unknown) => asOwner(headers, "POST", "/v1/artifacts", body);

function visit(url: string): Promise<Response> {
  const parsed = new URL(url);
  return send(parsed.pathname, {}, parsed.host);
}

function storedKeys(shop: Shop): Promise<string[]> {
  return runInDurableObject(tenantStub(bindings, shop.tenant), async (_instance, state) =>
    [...(await state.storage.list()).keys()].filter((key) => key.startsWith("artifact")));
}

async function ownedShop(): Promise<{ shop: Shop; owner: { authorization: string } }> {
  const shop = await setupShop("Baan Mali");
  return { shop, owner: (await linkedOwner(shop)).headers };
}

const SKILL_MD = "---\nname: promptpay-qr\ndescription: Make a PromptPay QR for an order\n---\nRun scripts/qr.py with the amount.\n";
const SCRIPT = "#!/usr/bin/env python3\nprint('qr')\n";
/// A bundle as the desktop sends one: two skills, one with a script in a folder.
const SKILLS = [
  { name: "promptpay-qr", files: [{ path: "SKILL.md", text: SKILL_MD }, { path: "scripts/qr.py", text: SCRIPT }] },
  { name: "stock", files: [{ path: "SKILL.md", text: "---\nname: stock\n---\nCount the stock.\n" }] },
];
const bundle = (skills: unknown = SKILLS) => ({ title: "Shop skills", kind: "skills", skills });
const one = (files: unknown[]) => [{ name: "one", files: [{ path: "SKILL.md", text: "x" }, ...files] }];

const NOT_FOUND_HEADERS = { ...PUBLIC_HEADERS, "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" };
const headersOf = (response: Response) =>
  Object.fromEntries([...response.headers].filter(([name]) => name !== "content-length"));

beforeEach(() => forgetArtifactSwitch());

afterEach(async () => {
  expect((await setFlags({ artifactLinks: false, skillLinks: false })).status).toBe(200);
  forgetArtifactSwitch();
});

describe("a bundle's rules", () => {
  it("takes plain relative paths only: no .., no absolute path, no dot-file, nothing a disk would read otherwise", () => {
    for (const ok of ["SKILL.md", "scripts/qr.py", "a/b/c.txt", "notes v2.md", "ไทย.md"]) expect(skillPathRefusal(ok), ok).toBeNull();
    for (const bad of ["../x", "a/../../x", "a/..", "/etc/passwd", "./x", "a//b", "", "a/", "a\\b", "C:/x", "a:b", "x\ny",
      "x".repeat(201)]) {
      expect(skillPathRefusal(bad), JSON.stringify(bad)).toBe("bad_path");
    }
    for (const dot of [".env", "a/.git/config", ".claude/settings.json", "scripts/.secret"]) {
      expect(skillPathRefusal(dot), dot).toBe("dot_file");
    }
  });

  it("refuses a binary file, a skill with no SKILL.md, and names or paths that clash, by name", () => {
    expect(skillsRefusal(SKILLS)).toBeNull();
    expect(skillsRefusal([])).toEqual({ reason: "no_skills" });
    expect(skillsRefusal(one([{ path: "logo.png", text: "\u0089PNG\u0000\u0000" }])))
      .toEqual({ reason: "binary_file", skill: "one", path: "logo.png" });
    expect(skillsRefusal(one([{ path: "bad.txt", text: "\uD800" }]))).toMatchObject({ reason: "binary_file", path: "bad.txt" });
    expect(skillsRefusal([{ name: "none", files: [{ path: "README.md", text: "x" }] }])).toEqual({ reason: "no_skill_md", skill: "none" });
    expect(skillsRefusal(one([{ path: "skill.MD", text: "x" }]))).toMatchObject({ reason: "duplicate_path" });
    expect(skillsRefusal(one([{ path: "a", text: "x" }, { path: "a/b", text: "y" }]))).toMatchObject({ reason: "duplicate_path", path: "a" });
    expect(skillsRefusal([...one([]), { name: "ONE", files: [{ path: "SKILL.md", text: "x" }] }]))
      .toEqual({ reason: "duplicate_name", skill: "ONE" });
    for (const name of ["..", ".hidden", "a/b", "", "x".repeat(65), "a..b"]) {
      expect(skillsRefusal([{ name, files: [{ path: "SKILL.md", text: "x" }] }]), name).toEqual({ reason: "bad_name" });
    }
    expect(skillsRefusal(Array.from({ length: MAX_SKILLS + 1 }, (_, i) => ({ name: `s${i}`, files: [{ path: "SKILL.md", text: "x" }] }))))
      .toEqual({ reason: "too_many_skills" });
    expect(skillsRefusal(one(Array.from({ length: MAX_SKILL_FILES }, (_, i) => ({ path: `f${i}.md`, text: "x" })))))
      .toEqual({ reason: "too_many_files" });
    // Only a name and files, and only a path and text: a mode, a link target or anything else is not a bundle.
    expect(skillsRefusal([{ name: "one", files: [{ path: "SKILL.md", text: "x", mode: 0o755 }] }])).toMatchObject({ reason: "invalid_skills" });
    expect(skillsRefusal([{ name: "one", files: [{ path: "SKILL.md", text: "x" }], link: "/etc" }])).toMatchObject({ reason: "invalid_skills" });
  });
});

describe("publishing a bundle", () => {
  it("is refused feature_disabled while skillLinks is off, even with pages on, and stores nothing", async () => {
    const { shop, owner } = await ownedShop();
    expect((await publish(owner, bundle())).body).toEqual({ error: "feature_disabled", feature: "artifactLinks" });
    expect((await setFlags({ artifactLinks: true })).status).toBe(200);
    expect(await publish(owner, bundle())).toMatchObject({ status: 403, body: { error: "feature_disabled", feature: "skillLinks" } });
    expect(await storedKeys(shop)).toEqual([]);
    // Pages still publish, and the list says skills cannot be shared yet.
    expect((await publish(owner, { title: "Menu", kind: "markdown", text: "# Menu" })).status).toBe(200);
    const list = await asOwner(owner, "GET", "/v1/artifacts");
    expect(list.body).toMatchObject({ publishing: "on", skillPublishing: "feature_disabled", origin: ORIGIN });
  });

  it("refuses every unsafe bundle with its reason before anything is stored", async () => {
    const { shop, owner } = await ownedShop();
    expect((await setFlags({ artifactLinks: true, skillLinks: true })).status).toBe(200);
    const cases: [unknown, Record<string, unknown>][] = [
      [one([{ path: "../escape.sh", text: "x" }]), { reason: "bad_path", skill: "one", path: "../escape.sh" }],
      [one([{ path: "/etc/cron.d/x", text: "x" }]), { reason: "bad_path", path: "/etc/cron.d/x" }],
      [one([{ path: ".env", text: "KEY=1" }]), { reason: "dot_file", path: ".env" }],
      [one([{ path: "img.png", text: "\u0000" }]), { reason: "binary_file", path: "img.png" }],
      [[{ name: "../up", files: [{ path: "SKILL.md", text: "x" }] }], { reason: "bad_name" }],
    ];
    for (const [skills, refused] of cases) {
      expect(await publish(owner, bundle(skills)), JSON.stringify(skills)).toMatchObject({ status: 400,
        body: { error: "invalid_skills", ...refused } });
    }
    // A bundle carries skills, never text, and a page never skills.
    expect(await publish(owner, { ...bundle(), text: "x" })).toMatchObject({ status: 400, body: { error: "invalid_request" } });
    expect(await publish(owner, { title: "x", kind: "skills", text: "x" })).toMatchObject({ status: 400, body: { error: "invalid_request" } });
    expect(await publish(owner, { title: "x", kind: "html", skills: SKILLS })).toMatchObject({ status: 400, body: { error: "invalid_request" } });
    // The whole manifest counts against the pages' size.
    const big = one([{ path: "big.md", text: "a".repeat(MAX_ARTIFACT_BYTES) }]);
    expect(await publish(owner, bundle(big))).toMatchObject({ status: 413, body: { error: "too_large", max: MAX_ARTIFACT_BYTES } });
    // A helper is told the links are the owner's.
    const helper = await joinHelper(shop);
    expect(await publish(helper.headers, bundle())).toMatchObject({ status: 403, body: { error: "owner_only" } });
    expect(await storedKeys(shop)).toEqual([]);
  });
});

describe("a bundle's public read", () => {
  async function published() {
    const { shop, owner } = await ownedShop();
    expect((await setFlags({ artifactLinks: true, skillLinks: true })).status).toBe(200);
    const made = await publish(owner, bundle());
    expect(made.status).toBe(200);
    return { shop, owner, artifact: made.body.artifact as { id: string; url: string; kind: string; bytes: number } };
  }

  it("serves the manifest as JSON and every file as one plain-text listing, with the public headers and never HTML", async () => {
    const { artifact } = await published();
    expect(artifact.kind).toBe("skills");
    const asJson = await visit(`${artifact.url}.json`);
    expect(asJson.status).toBe(200);
    expect(headersOf(asJson)).toEqual({ ...PUBLIC_HEADERS, "content-type": "application/json", "cache-control": PAGE_CACHE });
    expect(await asJson.json()).toEqual({ title: "Shop skills", skills: SKILLS });

    const listing = await visit(artifact.url);
    expect(listing.status).toBe(200);
    expect(headersOf(listing)).toEqual({ ...PUBLIC_HEADERS, "content-type": "text/plain; charset=utf-8", "cache-control": PAGE_CACHE });
    const text = await listing.text();
    expect(text.split("\n")[0]).toBe("Shop skills");
    expect(text).toContain("2 skills, 3 files.");
    expect(text).toContain(`===== promptpay-qr/scripts/qr.py (${new TextEncoder().encode(SCRIPT).length} bytes) =====\n${SCRIPT}`);
    expect(text).toContain("===== stock/SKILL.md (");
  });

  it("answers the same 404 for a page's .json, and for every bundle once either switch is off", async () => {
    const { owner, artifact } = await published();
    const page = (await publish(owner, { title: "Menu", kind: "html", text: "<h1>Menu</h1>" })).body.artifact as { url: string };
    const pageJson = await visit(`${page.url}.json`);
    expect(pageJson.status).toBe(404);
    expect(headersOf(pageJson)).toEqual(NOT_FOUND_HEADERS);

    expect((await setFlags({ skillLinks: false })).status).toBe(200);
    forgetArtifactSwitch();
    for (const url of [artifact.url, `${artifact.url}.json`]) {
      const off = await visit(url);
      expect(off.status, url).toBe(404);
      expect(headersOf(off), url).toEqual(NOT_FOUND_HEADERS);
      expect(await off.text()).toBe("Not found");
    }
    // Pages are still served.
    expect((await visit(page.url)).status).toBe(200);
    expect((await setFlags({ skillLinks: true, artifactLinks: false })).status).toBe(200);
    forgetArtifactSwitch();
    expect((await visit(`${artifact.url}.json`)).status).toBe(404);
    // The owner can still list and remove the link.
    const list = await asOwner(owner, "GET", "/v1/artifacts");
    expect((list.body.artifacts as { id: string }[]).map((link) => link.id)).toContain(artifact.id);
    expect((await asOwner(owner, "POST", "/v1/artifacts/remove", { id: artifact.id })).status).toBe(200);
  });

  it("answers a removed bundle as one that never was, and exports it with its manifest and without its link", async () => {
    const { shop, owner, artifact } = await published();
    const exported = (await (await tenantExport(bindings, shop.tenant)).json()) as { artifacts: Record<string, unknown>[] };
    expect(exported.artifacts).toEqual([{ id: artifact.id, title: "Shop skills", kind: "skills", bytes: artifact.bytes,
      createdAt: expect.any(Number), text: JSON.stringify({ skills: SKILLS }) }]);
    expect(JSON.stringify(exported)).not.toContain(artifact.url.split("/a/")[1]!.split(".")[1]);
    expect((await asOwner(owner, "POST", "/v1/artifacts/remove", { id: artifact.id })).status).toBe(200);
    for (const url of [artifact.url, `${artifact.url}.json`]) {
      const gone = await visit(url);
      expect(gone.status).toBe(404);
      expect(headersOf(gone)).toEqual(NOT_FOUND_HEADERS);
    }
    expect(await storedKeys(shop)).toEqual([]);
  });
});
