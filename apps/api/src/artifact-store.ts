/// A shop's artifact links (docs/pilot-api.md, "Artifact links"), kept in that shop's TenantObject (`t:${tenant}`) beside its
/// other records, so tenant export reads them and tenant deletion wipes them. No other Cloudflare product holds any of it: a
/// page's text is a value in the object's own SQLite storage, as a fact or a routine is.
///
/// Three kinds of key, each with the tenant in it as every other store here has (memory-store.ts):
///
/// - `artifact:${tenant}:${id}`, the record the owner's list reads: its id, title, kind, size, when it was made, the link's
///   key, and the SHA-256 of the link's secret. The id is a sortable id minted here (`art-…`), never the link's secret, so the
///   audit log and a removal can name it without either being a way to open the page.
/// - `artifact-text:${tenant}:${id}`, the page's text, read only by the public read and the export.
/// - `artifact-link:${hash}`, the public read's way in: the SHA-256 of the link's secret, naming the tenant and the id.
///
/// A link is `<origin>/a/<shop>.<secret>`. `<shop>` is this object's own Durable Object id, the 32 bytes of its 64 hex digits
/// in base64url, so the Worker can reach the object without a lookup anywhere global (no AuthObject, so a busy page never
/// slows anyone's sign-in) and without the tenant's name in a public URL: an object's id is a one-way hash of its name, which
/// only Cloudflare can make. Two links of one shop share that part, so they show they are the same shop's, and nothing more.
/// `<secret>` is 24 random bytes (192 bits) in base64url; only its hash is looked up.
///
/// Atomicity. A publish and a removal each run inside `transactionSync` with the synchronous KV API: the count against the
/// cap, the three keys and the audit entry are written together or not at all, so two publishes at once can never pass the
/// cap and a removal never leaves a link that still opens. The public read only reads: no stranger's visit ever writes to
/// the shop's storage, which is also why opens are not counted.
///
/// Only the Worker reaches these paths, with its `x-artifacts` header, the same defence in depth as `x-memory` and `x-feed`.

import { actorOr, auditPutSync, type AuditActor } from "./audit-log";
import { sha256Hex } from "./auth";
import { readJsonBody } from "./body";
import { isValidTenant } from "./companies";
import { sortableId } from "./pilot-store";
import { base64url } from "./relay";

/// The most text one page holds, in UTF-8 bytes: 128 KiB, a long page with a few small inline images. The desktop sends a
/// body of at most 256 KiB (its shell's request command, src-tauri/src/api_link.rs), and JSON escaping can double a page made
/// of quotes and line breaks, so a page under this fits (the desktop checks the whole body as well). The Worker refuses more before anything is woken; this object
/// refuses it again.
export const MAX_ARTIFACT_BYTES = 128 * 1024;
/// The most links one shop holds at a time. With the size above, at most 6.25 MiB of one shop's storage.
export const MAX_ARTIFACTS = 50;
/// The longest title, in characters as JavaScript counts them.
export const MAX_TITLE = 120;
export const ARTIFACT_KINDS = ["html", "markdown"] as const;
export type ArtifactKind = (typeof ARTIFACT_KINDS)[number];

/// What the Worker forwards: the text at its cap, escaped as JSON at worst six characters for one, and the rest.
const MAX_BODY_BYTES = 6 * MAX_ARTIFACT_BYTES + 16 * 1024;
/// A link's secret: 24 random bytes in base64url.
const SECRET = /^[A-Za-z0-9_-]{32}$/;
const SYSTEM: AuditActor = { kind: "system" };

/// One link as this object keeps it. `key` is the link's path after `/a/`; `linkHash` the SHA-256 of its secret.
type StoredArtifact = {
  id: string;
  title: string;
  kind: ArtifactKind;
  bytes: number;
  createdAt: number;
  key: string;
  linkHash: string;
};

/// One link as the owner's list shows it: everything but the secret's hash.
export type ArtifactView = Omit<StoredArtifact, "linkHash">;

const enc = encodeURIComponent;
const keys = {
  records: (tenant: string) => `artifact:${enc(tenant)}:`,
  record: (tenant: string, id: string) => `artifact:${enc(tenant)}:${id}`,
  text: (tenant: string, id: string) => `artifact-text:${enc(tenant)}:${id}`,
  link: (hash: string) => `artifact-link:${hash}`,
};

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function isArtifactKind(value: unknown): value is ArtifactKind {
  return typeof value === "string" && (ARTIFACT_KINDS as readonly string[]).includes(value);
}

/// A title the list can show on one line: 1 to `MAX_TITLE` characters once trimmed, with no control character, so nothing
/// can make a row of the owner's list read as two or hide what it is.
export function isArtifactTitle(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const title = value.trim();
  return title.length > 0 && title.length <= MAX_TITLE && !/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(title);
}

/// The size of a page's text as it is stored and counted against the cap.
export function artifactBytes(text: string): number {
  return new TextEncoder().encode(text).length;
}

const view = ({ linkHash: _hash, ...rest }: StoredArtifact): ArtifactView => rest;

function stored(kv: SyncKvStorage, tenant: string): StoredArtifact[] {
  return [...kv.list<StoredArtifact>({ prefix: keys.records(tenant) })].map(([, value]) => value);
}

/// This object's own id as a link's first part: its 32 bytes in base64url.
function shopPart(selfId: string): string {
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++) bytes[i] = parseInt(selfId.slice(i * 2, i * 2 + 2), 16);
  return base64url(bytes);
}

/// `/artifacts/*` on a TenantObject. `selfId` is the object's own id (`ctx.id.toString()`), which a new link names.
export async function artifactTenantRoute(storage: DurableObjectStorage, request: Request, url: URL, selfId: string):
  Promise<Response> {
  if (request.headers.get("x-artifacts") !== "1") return json({ error: "forbidden" }, 403);
  const route = `${request.method} ${url.pathname}`;
  if (route === "GET /artifacts/open") return open(storage.kv, request.headers.get("x-artifact-secret") ?? "");
  if (request.method === "GET") {
    const tenant = url.searchParams.get("tenant") ?? "";
    if (!isValidTenant(tenant)) return json({ error: "invalid_request" }, 400);
    // The owner's list, newest first. The ids sort by when they were made, so the newest is last in key order.
    if (route === "GET /artifacts") return json({ artifacts: stored(storage.kv, tenant).reverse().map(view) });
    // The export: every page with its text, and never a link's key or its hash. An export is a file the owner keeps and
    // may pass around, and a live link in it would open the page for whoever reads the file.
    if (route === "GET /artifacts/export") {
      return json({ artifacts: stored(storage.kv, tenant).map(({ id, title, kind, bytes, createdAt }) =>
        ({ id, title, kind, bytes, createdAt, text: storage.kv.get<string>(keys.text(tenant, id)) ?? "" })) });
    }
    return json({ error: "not_found" }, 404);
  }
  if (request.method !== "POST") return json({ error: "not_found" }, 404);
  const parsed = await readJsonBody<unknown>(request, MAX_BODY_BYTES);
  if (!parsed.ok) return json({ error: parsed.error }, parsed.status);
  const body = parsed.value;
  if (!isRecord(body) || !isValidTenant(body.tenant)) return json({ error: "invalid_request" }, 400);
  const actor = actorOr(body.actor, SYSTEM);
  if (route === "POST /artifacts/publish") return publish(storage, body.tenant, body, actor, selfId);
  if (route === "POST /artifacts/remove") return remove(storage, body.tenant, body.id, actor);
  return json({ error: "not_found" }, 404);
}

/// A new link for `title`, `kind` and `text`. Refused `too_many` once the shop holds `MAX_ARTIFACTS`.
async function publish(storage: DurableObjectStorage, tenant: string, body: Record<string, unknown>,
  actor: AuditActor | undefined, selfId: string): Promise<Response> {
  const { title, kind, text } = body;
  if (!isArtifactTitle(title) || !isArtifactKind(kind) || typeof text !== "string" || text.length === 0) {
    return json({ error: "invalid_request" }, 400);
  }
  const bytes = artifactBytes(text);
  if (bytes > MAX_ARTIFACT_BYTES) return json({ error: "too_large", max: MAX_ARTIFACT_BYTES }, 413);
  if (!/^[0-9a-f]{64}$/.test(selfId)) return json({ error: "artifacts_unavailable" }, 500);
  const secret = base64url(crypto.getRandomValues(new Uint8Array(24)));
  // Hashed before the transaction, which cannot wait for anything.
  const linkHash = await sha256Hex(secret);
  const answer = storage.transactionSync(() => {
    const kv = storage.kv;
    if ([...kv.list({ prefix: keys.records(tenant) })].length >= MAX_ARTIFACTS) {
      return { status: 409, body: { error: "too_many", max: MAX_ARTIFACTS } as unknown };
    }
    const nowMs = Date.now();
    const record: StoredArtifact = { id: sortableId("art", nowMs, 0), title: title.trim(), kind, bytes, createdAt: nowMs,
      key: `${shopPart(selfId)}.${secret}`, linkHash };
    kv.put(keys.record(tenant, record.id), record);
    kv.put(keys.text(tenant, record.id), text);
    kv.put(keys.link(linkHash), { tenant, id: record.id });
    auditPutSync(kv, tenant, actor ? { actor, action: "artifact.published", subject: { artifactId: record.id }, outcome: "ok" }
      : null, "artifact.published");
    return { status: 200, body: { artifact: view(record) } as unknown };
  });
  return json(answer.body, answer.status);
}

/// Removes link `id` at once: its record, its text and its way in, in one write, so the link answers 404 from then on.
function remove(storage: DurableObjectStorage, tenant: string, id: unknown, actor: AuditActor | undefined): Response {
  if (typeof id !== "string" || id.length === 0 || id.length > 64) return json({ error: "not_found" }, 404);
  const answer = storage.transactionSync(() => {
    const kv = storage.kv;
    const record = kv.get<StoredArtifact>(keys.record(tenant, id));
    if (!record) return { status: 404, body: { error: "not_found" } as unknown };
    kv.delete(keys.record(tenant, id));
    kv.delete(keys.text(tenant, id));
    kv.delete(keys.link(record.linkHash));
    auditPutSync(kv, tenant, actor ? { actor, action: "artifact.removed", subject: { artifactId: id }, outcome: "ok" } : null,
      "artifact.removed");
    return { status: 200, body: { id } as unknown };
  });
  return json(answer.body, answer.status);
}

/// The public read's lookup, by the link's secret: the page's kind and text, or 404 for a secret that names no link, which
/// is what a removed link's secret names. Nothing is written.
async function open(kv: SyncKvStorage, secret: string): Promise<Response> {
  if (!SECRET.test(secret)) return json({ error: "not_found" }, 404);
  const link = kv.get<{ tenant: string; id: string }>(keys.link(await sha256Hex(secret)));
  const record = link ? kv.get<StoredArtifact>(keys.record(link.tenant, link.id)) : undefined;
  const text = link ? kv.get<string>(keys.text(link.tenant, link.id)) : undefined;
  if (!link || !record || text === undefined) return json({ error: "not_found" }, 404);
  return json({ kind: record.kind, text });
}

/// Part of the TenantObject's tenant wipe: every record, every page's text and every link's way in, so no link of the shop
/// opens after its deletion.
export async function wipeArtifactsTenant(storage: DurableObjectStorage, tenant: string): Promise<void> {
  const records = await storage.list<StoredArtifact>({ prefix: keys.records(tenant) });
  const doomed: string[] = [];
  for (const [key, record] of records) doomed.push(key, keys.text(tenant, record.id), keys.link(record.linkHash));
  // Durable Object storage takes at most 128 keys per delete call.
  for (let i = 0; i < doomed.length; i += 128) await storage.delete(doomed.slice(i, i + 128));
}
