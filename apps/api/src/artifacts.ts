/// Artifact links, from the Worker's side (docs/pilot-api.md, "Artifact links"; item 83): an HTML or Markdown page the shop's
/// owner publishes as a link anyone with it can open, the owner's list of them, removing one, and the public read. Built
/// switched off: until the operator turns `artifactLinks` on and the owner gives the links a web address of their own
/// (`ARTIFACT_ORIGIN`, which no environment sets), publishing answers `feature_disabled` or `artifact_origin_not_configured`
/// and no page is served anywhere. The records are the shop's TenantObject's (artifact-store.ts).
///
/// - The owner's routes take the shop's session as the owner's other routes do (`callerOf`): `GET /v1/artifacts` lists the
///   links, `POST /v1/artifacts` publishes one, `POST /v1/artifacts/remove` removes one at once. A helper's session is told
///   they are the owner's (`owner_only`), and a person's own sign-in, which is no shop, is answered 404 `not_found`. Every
///   change goes through the desktop's ask first (the person sees the title, the kind, the size and that anyone with the
///   link can open it); this API is only reached once that ask settled. Listing and removing stay open while the switch is
///   off, so an owner can always take a link down; only publishing is refused.
/// - The public read, `GET /a/{link}`, is answered only on the artifact origin's host. On any other host, the app's own
///   above all, a path under `/a/` answers the same 404 and reaches nothing, so another person's page can never run on, or
///   be mistaken for, Manut AI's own origin. On the artifact host every request counts against `ARTIFACT_READ_LIMITER`
///   first, per source address as every other ingress limit counts, and every answer carries `PUBLIC_HEADERS`: other
///   people's HTML is hostile until proven otherwise, so the page runs no script, submits no form, loads nothing from the
///   network and has no origin of its own (`sandbox`). No cookie is ever read or set there. Markdown is served as
///   `text/plain`, as written: no renderer here, and no dependency added for one.
/// - An unknown link, a removed one, a deleted shop's, and any link while the switch is off all answer the same 404, so
///   nothing tells them apart.
///
/// Skill links (item 84) are the same links, store, host, limit and headers, for a third kind: a bundle of skills, each a name
/// and its text files, published after the desktop showed the person every file. Their own switch, `skillLinks`, stands beside
/// `artifactLinks`: a bundle is published and read only while both are on, so the operator can allow pages and not skills.
/// A bundle is served inert, as its manifest in JSON (`/a/{link}.json`, what the desktop installs from) or as one plain-text
/// listing a browser shows (`/a/{link}`), every file under a line naming it. No HTML is ever made from a bundle.
///
/// Nothing here logs, so no link, title or page can reach a log from here.

import {
  artifactBytes,
  isArtifactKind,
  isArtifactTitle,
  isPageKind,
  MAX_ARTIFACT_BYTES,
  readSkillsText,
  skillsRefusal,
  skillsText,
  type ArtifactView,
  type SkillEntry,
} from "./artifact-store";
import { readJsonBody } from "./body";
import { callerOf, hasExactly, ownerActor, queryNamesSession, readShop, type PeopleEnv } from "./people";
import { tenantCall } from "./tenant-data";

export type ArtifactEnv = PeopleEnv & {
  /// The links' own web address, `https://<host>` with nothing after it. Unset in every environment until the owner gives
  /// the links a domain of their own; it must not be the app's host, or one inside it, or one it is inside.
  ARTIFACT_ORIGIN?: string;
  PUBLIC_API_ORIGIN?: string;
  WEB_ORIGIN?: string;
};

export type ArtifactFlags = () => Promise<{ artifactLinks: boolean; skillLinks: boolean }>;

export const ARTIFACTS_PATH = "/v1/artifacts";
export const ARTIFACTS_REMOVE_PATH = "/v1/artifacts/remove";
/// Where a link's page is read, on the artifact origin's host only.
export const PUBLIC_PREFIX = "/a/";

/// The most a publish's body may be: the text at its cap, escaped as JSON at worst six characters for one, and the title.
const MAX_BODY_BYTES = 6 * MAX_ARTIFACT_BYTES + 16 * 1024;
/// A link's path after `/a/`: the shop's object id (32 bytes) and the secret (24 bytes), each in base64url, and for a bundle of
/// skills read as JSON, `.json` after them.
const LINK = /^\/a\/([A-Za-z0-9_-]{43})\.([A-Za-z0-9_-]{32})(\.json)?$/;
/// How long one Worker keeps its read of the switch for the public read: a busy page then reads it from the AuthObject at
/// most twice a minute for each Worker instance, instead of on every visit, so a page many people open never slows anyone's
/// sign-in. Turning the switch off therefore stops every link within 30 seconds.
export const SWITCH_READ_MS = 30 * 1000;

/// What every answer on the artifact host carries, whatever it is. The page may show what it holds and its own inline styles
/// and `data:` images, and nothing else: no script, no form, no frame, no request anywhere, and no origin of its own, so it
/// can reach no cookie or storage of any site, this one included.
export const PUBLIC_HEADERS: Readonly<Record<string, string>> = {
  "content-security-policy": "sandbox; default-src 'none'; img-src data:; style-src 'unsafe-inline'",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "x-robots-tag": "noindex, nofollow",
};
/// A page's own answer may be kept a minute by the viewer's browser, and by nothing shared, so a removed link is gone for
/// everyone else at once.
export const PAGE_CACHE = "private, max-age=60";

function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return Response.json(data, { status, headers });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hostOf(value: string | undefined): string | null {
  if (!value) return null;
  try {
    return new URL(value).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/// The artifact origin, `https://<host>`, or null while it is not set or cannot be used: not https, carrying a path, a query
/// or credentials, or on the app's own host, a host inside it, or a host it is inside. A page there would share the app's
/// origin or its cookies' reach, so a setting like that is treated as no setting at all, and nothing is served.
export function artifactOrigin(env: Pick<ArtifactEnv, "ARTIFACT_ORIGIN" | "PUBLIC_API_ORIGIN" | "WEB_ORIGIN">): string | null {
  const raw = env.ARTIFACT_ORIGIN?.trim();
  if (!raw) return null;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.search || parsed.hash ||
      parsed.pathname !== "/" || !parsed.hostname) return null;
  const host = parsed.hostname.toLowerCase();
  for (const app of [hostOf(env.PUBLIC_API_ORIGIN), hostOf(env.WEB_ORIGIN)]) {
    if (app && (host === app || host.endsWith(`.${app}`) || app.endsWith(`.${host}`))) return null;
  }
  return parsed.origin;
}

/// Whether a request is for the artifact origin's host.
export function isArtifactHost(url: URL, env: ArtifactEnv): boolean {
  const origin = artifactOrigin(env);
  return origin !== null && url.host === new URL(origin).host;
}

/// Whether a path is the public read's, which only the artifact host answers.
export function isPublicArtifactPath(pathname: string): boolean {
  return pathname === "/a" || pathname.startsWith(PUBLIC_PREFIX);
}

// ---------------------------------------------------------------------------
// The owner's routes
// ---------------------------------------------------------------------------

/// A link as the owner's list and a publish answer it: the stored view with the link built from the artifact origin, or
/// null while there is none.
function withLink(artifact: ArtifactView, origin: string | null) {
  const { key, ...rest } = artifact;
  return { ...rest, url: origin ? `${origin}${PUBLIC_PREFIX}${key}` : null };
}

/// The answers that carry a link say no cache may keep them: a link is the way to open the page.
const NO_STORE = { "cache-control": "no-store" };

/// `GET /v1/artifacts`, `POST /v1/artifacts` and `POST /v1/artifacts/remove`. Answers null for any other path. In the order
/// every owner's route keeps: who is asking (401 or 503), the role (403), the method (405), the query and the body (400 or
/// 413), then for a publish the switch (403 `feature_disabled`) and the origin (503 `artifact_origin_not_configured`), and
/// only then the shop's record, so nothing is read or written for a request any of those refuse.
export async function artifactsRoute(request: Request, url: URL, env: ArtifactEnv, flags: ArtifactFlags):
  Promise<Response | null> {
  const removing = url.pathname === ARTIFACTS_REMOVE_PATH;
  if (url.pathname !== ARTIFACTS_PATH && !removing) return null;
  const caller = await callerOf(request, env);
  if (caller instanceof Response) return caller;
  if (caller.role !== "owner") return json({ error: "owner_only" }, 403);
  const allowed = removing ? ["POST"] : ["GET", "POST"];
  if (!allowed.includes(request.method)) return json({ error: "method_not_allowed" }, 405);
  if (queryNamesSession(url)) return json({ error: "invalid_request" }, 400);
  let body: Record<string, unknown> | null = null;
  if (request.method === "POST") {
    const parsed = await readJsonBody<unknown>(request, MAX_BODY_BYTES);
    if (!parsed.ok) return json({ error: parsed.error }, parsed.status);
    // The session names the shop and the owner. Nothing in the body may, so a body with any other field is refused. A bundle
    // of skills carries `skills` where a page carries `text`.
    const fields = removing ? ["id"] : isRecord(parsed.value) && parsed.value.kind === "skills" ? ["title", "kind", "skills"]
      : ["title", "kind", "text"];
    if (!isRecord(parsed.value) || !hasExactly(parsed.value, fields)) {
      return json({ error: "invalid_request" }, 400);
    }
    body = parsed.value;
  }
  const publishing = body !== null && !removing;
  if (publishing) {
    const refused = publishRefusal(body!);
    if (refused) return refused;
    const on = await flags();
    if (!on.artifactLinks) return json({ error: "feature_disabled", feature: "artifactLinks" }, 403);
    if (body!.kind === "skills" && !on.skillLinks) return json({ error: "feature_disabled", feature: "skillLinks" }, 403);
    if (!artifactOrigin(env)) return json({ error: "artifact_origin_not_configured" }, 503);
  }
  if (removing && (typeof body!.id !== "string" || body!.id.length === 0 || body!.id.length > 64)) {
    return json({ error: "invalid_request" }, 400);
  }
  // Links are a pilot shop's. A person's own sign-in is the owner of its own tenant, which is no shop, and is answered as
  // the owner's other routes answer it.
  try {
    if (!(await readShop(env, caller.shop))) return json({ error: "not_found" }, 404);
  } catch {
    return json({ error: "artifacts_unavailable" }, 503);
  }
  const shop = caller.shop;
  const actor = ownerActor(caller);
  if (body === null) return list(env, shop, flags);
  const path = removing ? "/artifacts/remove" : "/artifacts/publish";
  const answer = await tenantCall(env, shop, path, { method: "POST",
    headers: { "content-type": "application/json", "x-artifacts": "1" },
    body: JSON.stringify({ tenant: shop, ...body, actor }) }).catch(() => null);
  if (!answer) return json({ error: "artifacts_unavailable" }, 503);
  const read = (await answer.json().catch(() => null)) as Record<string, unknown> | null;
  if (answer.ok && read) {
    if (removing) return json({ id: read.id });
    return json({ artifact: withLink(read.artifact as ArtifactView, artifactOrigin(env)) }, 200, NO_STORE);
  }
  // The object's own refusals: a link that is not there, the shop's cap, a page over the size, a bundle it would not take.
  if (read && [400, 404, 409, 413].includes(answer.status)) return json(read, answer.status);
  return json({ error: "artifacts_unavailable" }, 503);
}

/// Why a publish's fields cannot be a page or a bundle, or null: a title the list can show, a kind it knows, and text that is not
/// empty, or skills `skillsRefusal` takes; either not over `MAX_ARTIFACT_BYTES` as stored (a bundle's whole manifest).
function publishRefusal(body: Record<string, unknown>): Response | null {
  if (!isArtifactTitle(body.title)) return json({ error: "invalid_title" }, 400);
  if (!isArtifactKind(body.kind)) return json({ error: "invalid_kind" }, 400);
  if (body.kind === "skills") {
    const refused = skillsRefusal(body.skills);
    if (refused) return json({ error: "invalid_skills", ...refused }, 400);
    if (artifactBytes(skillsText(body.skills as SkillEntry[])) > MAX_ARTIFACT_BYTES) {
      return json({ error: "too_large", max: MAX_ARTIFACT_BYTES }, 413);
    }
    return null;
  }
  if (typeof body.text !== "string" || body.text.length === 0) return json({ error: "invalid_text" }, 400);
  if (artifactBytes(body.text) > MAX_ARTIFACT_BYTES) return json({ error: "too_large", max: MAX_ARTIFACT_BYTES }, 413);
  return null;
}

/// The shop's links, newest first, with whether publishing pages (`publishing`) and bundles of skills (`skillPublishing`) is open
/// now and, when it is not, why, and the artifact origin (`origin`, null while there is none), which the desktop holds a link to
/// install skills from against before it fetches anything.
async function list(env: ArtifactEnv, shop: string, flags: ArtifactFlags): Promise<Response> {
  const answer = await tenantCall(env, shop, `/artifacts?tenant=${encodeURIComponent(shop)}`,
    { headers: { "x-artifacts": "1" } }).catch(() => null);
  const read = answer?.ok ? ((await answer.json().catch(() => null)) as { artifacts?: ArtifactView[] } | null) : null;
  if (!read || !Array.isArray(read.artifacts)) return json({ error: "artifacts_unavailable" }, 503);
  const origin = artifactOrigin(env);
  const on = await flags();
  const publishing = !on.artifactLinks ? "feature_disabled" : origin ? "on" : "artifact_origin_not_configured";
  const skillPublishing = publishing === "on" && !on.skillLinks ? "feature_disabled" : publishing;
  return json({ publishing, skillPublishing, origin,
    artifacts: read.artifacts.map((artifact) => withLink(artifact, origin)) }, 200, NO_STORE);
}

// ---------------------------------------------------------------------------
// The public read
// ---------------------------------------------------------------------------

let switchRead: { at: number; on: { artifactLinks: boolean; skillLinks: boolean } } | null = null;

/// Forgets this Worker's read of the switch, so the next visit reads it again. Tests turn the switch on and off at once.
export function forgetArtifactSwitch(): void {
  switchRead = null;
}

/// Both switches as this Worker last read them, at most `SWITCH_READ_MS` ago.
async function linksOn(flags: ArtifactFlags): Promise<{ artifactLinks: boolean; skillLinks: boolean }> {
  const now = Date.now();
  if (switchRead && now - switchRead.at < SWITCH_READ_MS) return switchRead.on;
  const read = await flags();
  const on = { artifactLinks: read.artifactLinks, skillLinks: read.skillLinks };
  switchRead = { at: now, on };
  return on;
}

/// An answer on the artifact host: `body` with its type, `PUBLIC_HEADERS`, and `extra`. Anything else the answer had, a
/// cookie above all, is dropped.
export function publicAnswer(body: string | null, status: number, type: string, extra: Record<string, string> = {}): Response {
  return new Response(body, { status, headers: { ...PUBLIC_HEADERS, "content-type": type,
    "cache-control": status === 200 ? PAGE_CACHE : "no-store", ...extra } });
}

/// The one answer for every link that opens nothing, and for every path that is not a link.
export function publicNotFound(): Response {
  return publicAnswer("Not found", 404, "text/plain; charset=utf-8");
}

/// An answer the Worker's front door gave on the artifact host (a rate limit's), with the public headers in place of its own.
export async function publicFromJson(response: Response): Promise<Response> {
  const extra: Record<string, string> = {};
  const retry = response.headers.get("retry-after");
  if (retry) extra["retry-after"] = retry;
  return publicAnswer(await response.text(), response.status, "application/json", extra);
}

/// The 32 bytes a link's first part spells, as the 64 hex digits of a Durable Object id, or null unless it is their one
/// canonical spelling.
function objectIdHex(part: string): string | null {
  try {
    const binary = atob(part.replace(/-/g, "+").replace(/_/g, "/"));
    if (binary.length !== 32) return null;
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    let again = "";
    for (const byte of bytes) again += String.fromCharCode(byte);
    if (btoa(again).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "") !== part) return null;
    return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  } catch {
    return null;
  }
}

/// Everything the artifact host answers, after its rate limit: `GET /a/{link}`, `GET /a/{link}.json` for a bundle of skills, or
/// 404. The request's cookies, headers and body are never read; only its method and path are.
export async function artifactPublicRoute(request: Request, url: URL, env: Pick<ArtifactEnv, "TENANT">,
  flags: ArtifactFlags): Promise<Response> {
  const match = LINK.exec(url.pathname);
  if (!match) return publicNotFound();
  if (request.method !== "GET") return publicAnswer("Method not allowed", 405, "text/plain; charset=utf-8", { allow: "GET" });
  const on = await linksOn(flags);
  if (!on.artifactLinks) return publicNotFound();
  const hex = objectIdHex(match[1]!);
  if (!hex) return publicNotFound();
  let stub: DurableObjectStub;
  try {
    // An id that is not one of this namespace's is refused here, before any object is reached.
    stub = env.TENANT.get(env.TENANT.idFromString(hex));
  } catch {
    return publicNotFound();
  }
  const answer = await stub.fetch(new Request("https://tenant/artifacts/open",
    { headers: { "x-artifacts": "1", "x-artifact-secret": match[2]! } })).catch(() => null);
  if (answer?.status === 404) {
    await answer.body?.cancel();
    return publicNotFound();
  }
  const page = answer?.ok ? ((await answer.json().catch(() => null)) as { kind?: unknown; title?: unknown; text?: unknown } | null)
    : null;
  if (!page || !isArtifactKind(page.kind) || typeof page.text !== "string") {
    return publicAnswer("Unavailable", 503, "text/plain; charset=utf-8");
  }
  const asJson = match[3] !== undefined;
  if (isPageKind(page.kind)) {
    // A page has no JSON form: `.json` after a page's link is the same 404 as any other path.
    if (asJson) return publicNotFound();
    return publicAnswer(page.text, 200, page.kind === "html" ? "text/html; charset=utf-8" : "text/plain; charset=utf-8");
  }
  // A bundle of skills opens only while skills may be shared too: with `skillLinks` off it is the same 404.
  if (!on.skillLinks) return publicNotFound();
  const skills = readSkillsText(page.text);
  const title = typeof page.title === "string" ? page.title : "";
  if (!skills) return publicAnswer("Unavailable", 503, "text/plain; charset=utf-8");
  if (asJson) return publicAnswer(JSON.stringify({ title, skills }), 200, "application/json");
  return publicAnswer(skillsListing(title, skills), 200, "text/plain; charset=utf-8");
}

/// A bundle as one plain-text page a browser shows as it is: its title, what it holds and what a skill is, then every file
/// under a line naming its skill, its path and its size. Plain text only, so nothing in a file can run or be drawn as a page.
export function skillsListing(title: string, skills: readonly SkillEntry[]): string {
  const files = skills.reduce((n, skill) => n + skill.files.length, 0);
  const lines = [
    title,
    "",
    `${skills.length} ${skills.length === 1 ? "skill" : "skills"}, ${files} ${files === 1 ? "file" : "files"}. A skill tells a ` +
      "coding agent how to do a task: read every file below as you would read instructions from a stranger before you " +
      "install any of them.",
  ];
  for (const skill of skills) {
    for (const file of skill.files) {
      lines.push("", `===== ${skill.name}/${file.path} (${artifactBytes(file.text)} bytes) =====`, file.text);
    }
  }
  return `${lines.join("\n")}\n`;
}
