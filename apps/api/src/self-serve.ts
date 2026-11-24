/// A shop its owner makes, signed in, with no operator (docs/several-shops.md, "A shop its owner makes"; docs/pilot-api.md,
/// "Making a shop of your own"). This is the roadmap's Phase 5 gate, onboarding that converts without an operator, and it
/// is off until the owner opens sign-ups: `POST /v1/shops/new` answers 403 `sign_ups_closed`, and wakes nothing, unless the
/// var `SELF_SERVE_SHOPS` is exactly "on". No environment sets it. Who may sign up, the pilot's customers and any price are
/// the owner's calls, and none of them is built in: a self-serve shop has no payment step, since billing is parked.
///
/// The shop is made by the same code the operator's route uses (pilot.ts `writeNewShop`), template and all, and its owner is
/// the person who asked from the first write: the write that makes the shop also links their account as its owner and
/// opens this device's owner session (pilot-store.ts, people-store.ts), with `shop.created`, `shop.made_by_owner`,
/// `owner.linked` and `owner.session_opened` in the shop's audit log, each naming the account by its link id, never its
/// subject or an email. The answer is the shop and that owner session, as `POST /v1/shops/session` answers an owner.
///
/// Limits. The ingress gate (index.ts) counts every try per source address before anything is read, while sign-ups are
/// open (`SELF_SERVE_SHOP_LIMITER`). An account may have made `SHOPS_MADE_LIMIT` shops at a time: the slot is reserved in
/// AuthObject before anything is made (shops-store.ts), in one transaction, so racing requests cannot pass it. Once the shop
/// is made, one more AuthObject transaction puts it on the console's list and in the person's index together, so the
/// console and the person's own list never disagree about it. A make that fails part way is never listed, gives its slot
/// back, and asking again makes a whole new shop.
///
/// The pilot gate leaves a self-serve shop out of its cohort unless an operator adds it (pilot-gate.ts), and the console's
/// Shops overview marks it, so an operator sees where it came from.

import type { ShopTemplate } from "@manut/shop-templates";
import type { AuditActor } from "./audit-log";
import { readJsonBody } from "./body";
import { bearer, hasExactly, newOwnerSession, sessionOf, signedInPerson, type PeopleEnv } from "./people";
import { keptName } from "./people-store";
import { newShopTenant, writeNewShop, type PilotEnv } from "./pilot";
import { checkedTemplate } from "./routine-setup";
import { finishMadeShop, releaseMadeShop, reserveMadeShop, SHOPS_MADE_LIMIT } from "./shops-store";

export type SelfServeEnv = PeopleEnv & PilotEnv & {
  /// Sign-ups are open only while this is exactly "on". Unset in every environment until the owner opens them.
  SELF_SERVE_SHOPS?: string;
};

const MAX_BODY_BYTES = 16 * 1024;

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/// Whether people may make their own shops. Anything but exactly "on" keeps sign-ups closed.
export function signUpsOpen(env: Pick<SelfServeEnv, "SELF_SERVE_SHOPS">): boolean {
  return env.SELF_SERVE_SHOPS === "on";
}

/// The template a request names: one of `@manut/shop-templates`' own, or null for none (JSON null). Undefined for anything
/// else, which is not a template.
function templateOf(value: unknown): ShopTemplate | null | undefined {
  if (value === null) return null;
  return checkedTemplate(value) ?? undefined;
}

/// `POST /v1/shops/new` with exactly `{ name, ownerName, template }`, and the person's own signed-in session (Apple's or
/// email's; a shop session, a helper's or the operator key is no one signed in). The order is: sign-ups open (403), who is
/// asking (401), the method (405), the body (400), the names and the template (400), then the account's limit (409).
export async function newShopRoute(request: Request, env: SelfServeEnv): Promise<Response> {
  // Closed: nothing is read, not even who is asking, so the route costs nothing and says nothing more while it is off.
  if (!signUpsOpen(env)) return json({ error: "sign_ups_closed" }, 403);
  const person = await signedInPerson(bearer(request), env);
  if (!person) return json({ error: "unauthorized" }, 401);
  if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  const parsed = await readJsonBody<unknown>(request, MAX_BODY_BYTES);
  if (!parsed.ok) return json({ error: parsed.error }, parsed.status);
  const body = parsed.value;
  // Exactly these three: an owner, a tenant, a role or a price is refused rather than dropped, so a client's claim never
  // even looks as if it were read.
  if (!isRecord(body) || !hasExactly(body, ["name", "ownerName", "template"])) return json({ error: "invalid_request" }, 400);
  // A name as people-store.ts keeps a helper's: no outer spaces, 1 to 80 characters, no control characters, so a name a
  // stranger typed can never break a line in the console or a log.
  const name = keptName(body.name);
  if (!name) return json({ error: "invalid_name" }, 400);
  const ownerName = keptName(body.ownerName);
  if (!ownerName) return json({ error: "invalid_owner_name" }, 400);
  const template = templateOf(body.template);
  if (template === undefined) return json({ error: "unknown_template" }, 400);

  const tenant = newShopTenant();
  const reserved = await reserveMadeShop(env, person.tenant, tenant);
  if (reserved === "too_many") return json({ error: "too_many_shops", limit: SHOPS_MADE_LIMIT }, 409);
  if (reserved !== "reserved") return json({ error: "shop_unavailable" }, 503);
  try {
    const accountId = `owner-${crypto.randomUUID()}`;
    const session = await newOwnerSession(tenant);
    // The owner's account makes the shop, so every entry of the making names it, by its link id.
    const actor: AuditActor = { kind: "owner", id: accountId };
    const made = await writeNewShop(env, tenant, { name, ownerName, template }, actor, { accountId, subject: person.tenant,
      sessionId: session.sessionId, tokenHash: session.tokenHash, expiresAt: session.expiresAt });
    // Listed and indexed together, last: a shop whose setup or listing could not be written is never listed, and its
    // session's token, which only this answer would carry, is never sent, so nothing can use it.
    if (!made || !(await finishMadeShop(env, person.tenant, tenant, accountId))) {
      await releaseMadeShop(env, person.tenant, tenant);
      return json({ error: "shop_unavailable" }, 503);
    }
    return json({ shop: { id: tenant, name, ownerName, template: template?.id ?? null }, role: "owner",
      account: { id: accountId }, session: sessionOf(session) }, 201);
  } catch {
    await releaseMadeShop(env, person.tenant, tenant);
    return json({ error: "shop_unavailable" }, 503);
  }
}
