/// Deleting your own account from the app (item 124; docs/pilot-api.md, "Deleting your own account").
///
/// App Review Guideline 5.1.1(v): "If your app supports account creation, you must also offer account deletion within the
/// app." Apple's page on it adds that a person may be asked to confirm, "to ensure the account isn't deleted by accident or
/// by someone other than the account holder", and that an app with Sign in with Apple "should use the Sign in with Apple
/// REST API to revoke user tokens". Until this item only an operator could start deleting a shop, with its owner's yes
/// through a link; the app had no way to.
///
/// `POST /v1/account/deletion`, with the person's own signed-in session (Apple's or a code's by email) and exactly
/// `{ owned: [{ shop, name }] }`:
///
/// - **Only the signed-in person, only their own account.** The session is the only credential taken: none, a shop session
///   and the operator key are answered 401 before anything is read. Nothing in the body names the person, a role or an
///   account; the session decides whose account it is, and each shop's own people record decides what they are there.
/// - **The owner's shops, by name.** `owned` lists every shop the person owns, each with its name as they typed it in the
///   app's second step. It must be exactly the shops their account owns now, or 409 `owned_changed` with the list as it now
///   is; a name that is not the shop's is 409 `name_mismatch`. Either way nothing is deleted. So a deletion never takes a
///   shop the person was not shown by name, and a link the operator made meanwhile is never deleted unseen. A helper only
///   sends `{ owned: [] }`.
/// - **What goes.** For each shop they own: the shop's whole data, through the same deletion record and wipe as the
///   operator's request and the owner's link (pilot.ts, `ownerDeletesShop`). For each shop they help at: their place there
///   and every session of theirs (`helper.left`), and nothing of the shop's. A shop they began to make and never finished
///   goes too. Then their own sign-in's data: their index of shops, their link code and every session, on every device
///   (tenant-data.ts, `tenantDelete`, as `DELETE /v1/tenant/data` runs it). For an account made with Sign in with Apple,
///   the Apple token a sign-in kept is revoked at Apple (account-store.ts); a failure there never stops the deletion: it
///   is recorded and retried.
/// - **The record.** AuthObject keeps who asked (the account, by the hash of its subject) and when, what it covers and what
///   became of the Apple token, written before anything is deleted (account-store.ts). A request that cannot write it
///   deletes nothing (503 `audit_unavailable`). Each shop's own deletion record says the owner asked (`askedBy`).
/// - **A stop part way.** The steps run in a fixed order, and each answers again after its own work: a shop already
///   deleted is done, a helper already gone is done. A stop answers 500 `deletion_incomplete` naming the step, keeps the
///   record, and the same request finishes the same deletion. The person's sessions go last of all, so until the very end
///   they can press again; a stop after that (only the sign-in's own empty records left) is finished by signing in again
///   and asking again. While a request runs a second answers 409 `deletion_running`.
/// - **A shop that is not theirs now** (item 140). A shop the record covers is deleted only while the account owns it now,
///   or finished once it is gone. One an operator unlinked from the account after a stop, or linked to someone else, is
///   answered 409 `not_owner_now` naming it: it is left as it is, with nothing decided in the account's name, and the
///   record stops covering it, so the person can still delete their account without it.
///
/// Every try counts against the address's limit on deleting one's own data (`TENANT_DELETE_LIMITER`, index.ts) before the
/// session is read.

import { sameIdentity, type Identity } from "@manut/people-rules";
import type { AccountDeletionRecord, AppleRevokeState } from "./account-store";
import { readJsonBody } from "./body";
import { isValidTenant } from "./companies";
import { bearer, hasExactly, peopleCall, readPeople, readShop, signedInPerson, type PeopleEnv, type SignedInPerson } from "./people";
import { deleteUnfinishedMake, ownerDeletesShop, type OwnerShopDeletion, type PilotEnv } from "./pilot";
import { readIdentityShops } from "./shops-store";
import { authCall, tenantDelete } from "./tenant-data";

export const ACCOUNT_DELETION_PATH = "/v1/account/deletion";

export type AccountEnv = PeopleEnv & PilotEnv;

const MAX_BODY_BYTES = 32 * 1024;
const MAX_SHOPS = 64;

type Owned = { shop: string; name: string; account: string };
type Helping = { shop: string; name: string; helper: string };

/// What the app gets when the deletion finished. `shops` are the shops deleted with it and `left` the ones the person no
/// longer helps at, each by its name, for the line that says it is done. `apple` is only for an account made with Sign in
/// with Apple.
export type AccountDeleted = {
  deleted: true;
  shops: { id: string; name: string }[];
  left: { id: string; name: string }[];
  apple?: AppleRevokeState;
};

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/// A typed name and a stored one are the same name when they differ only in outer spaces or in how an accented letter was
/// composed, as the operator's `confirmName` is read (pilot.ts).
function sameName(typed: string, stored: string): boolean {
  return typed.normalize("NFC").trim() === stored.normalize("NFC").trim();
}

/// `{ owned: [{ shop, name }] }`, exactly, or null.
function askedOwned(value: unknown): { shop: string; name: string }[] | null {
  if (!isRecord(value) || !hasExactly(value, ["owned"]) || !Array.isArray(value.owned) || value.owned.length > MAX_SHOPS) {
    return null;
  }
  const out: { shop: string; name: string }[] = [];
  for (const one of value.owned) {
    if (!isRecord(one) || !hasExactly(one, ["shop", "name"]) || !isValidTenant(one.shop) || typeof one.name !== "string" ||
        one.name.length > 200 || out.some((kept) => kept.shop === one.shop)) return null;
    out.push({ shop: one.shop, name: one.name });
  }
  return out;
}

/// The shops the person owns and helps at now, from each shop's own people record, as `GET /v1/shops` reads them
/// (shops.ts): the owner while their account is the one linked, else a helper while a current helper has the address they
/// signed in with. Null when anything cannot be read, so no answer takes a failed read for a shop that is not theirs.
async function standingOf(env: AccountEnv, person: SignedInPerson): Promise<{ owned: Owned[]; helping: Helping[] } | null> {
  const rows = await readIdentityShops(env, person.tenant);
  if (!rows) return null;
  const owned: Owned[] = [];
  const helping: Helping[] = [];
  const account: Identity | null = person.email ? { kind: "email", address: person.email } : null;
  try {
    for (const tenant of [...new Set(rows.map((row) => row.shop))].filter(isValidTenant)) {
      const shop = await readShop(env, tenant);
      if (!shop) continue;
      const people = await readPeople(env, tenant);
      if (!people) return null;
      if (people.ownerAccount?.subject === person.tenant) {
        owned.push({ shop: tenant, name: shop.name, account: people.ownerAccount.id });
        continue;
      }
      const helper = account ? people.state.helpers.find((one) => sameIdentity(one.identity, account)) : undefined;
      if (helper) helping.push({ shop: tenant, name: shop.name, helper: helper.id });
    }
  } catch {
    return null;
  }
  return { owned, helping };
}

async function authWrite(env: AccountEnv, path: string, body: Record<string, unknown>): Promise<Response | null> {
  try {
    return await authCall(env, path, { method: "POST", headers: { "content-type": "application/json", "x-admin": "1" },
      body: JSON.stringify(body) });
  } catch {
    return null;
  }
}

/// The record of this person's deletion, or undefined when it cannot be read.
async function readRecord(env: AccountEnv, subject: string): Promise<AccountDeletionRecord | null | undefined> {
  try {
    const response = await authCall(env, `/account-deletion?subject=${encodeURIComponent(subject)}`);
    if (!response.ok) return undefined;
    return ((await response.json()) as { record: AccountDeletionRecord | null }).record;
  } catch {
    return undefined;
  }
}

/// `POST /v1/account/deletion` (above). Answers null for any other path.
export async function accountRoute(request: Request, url: URL, env: AccountEnv): Promise<Response | null> {
  if (url.pathname !== ACCOUNT_DELETION_PATH) return null;
  // Who is asking comes first, as on every session route: someone with no signed-in session learns nothing, not even the
  // method.
  const person = await signedInPerson(bearer(request), env);
  if (!person) return json({ error: "unauthorized" }, 401);
  if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  const parsed = await readJsonBody<unknown>(request, MAX_BODY_BYTES);
  if (!parsed.ok) return json({ error: parsed.error }, parsed.status);
  const asked = askedOwned(parsed.value);
  if (!asked) return json({ error: "invalid_request" }, 400);
  return deleteAccount(env, person, asked);
}

async function deleteAccount(env: AccountEnv, person: SignedInPerson, asked: { shop: string; name: string }[]):
  Promise<Response> {
  const standing = await standingOf(env, person);
  const kept = await readRecord(env, person.tenant);
  if (!standing || kept === undefined) return json({ error: "account_unavailable" }, 503);
  // A deletion that stopped part way covers the shops it already deleted, which the person's list no longer shows: the
  // same request, sent again, names them still, and finishes the same deletion.
  const unfinished = kept && !kept.finishedAt ? kept : null;
  const covered: Owned[] = [...standing.owned, ...(unfinished?.owned ?? []).filter((one) =>
    !standing.owned.some((now) => now.shop === one.shop))];
  const sameShops = covered.length === asked.length && covered.every((one) => asked.some((typed) => typed.shop === one.shop));
  if (!sameShops) return json({ error: "owned_changed", owned: covered.map((one) => ({ id: one.shop, name: one.name })) }, 409);
  const wrong = covered.find((one) => !sameName(asked.find((typed) => typed.shop === one.shop)!.name, one.name));
  if (wrong) return json({ error: "name_mismatch", shop: wrong.shop }, 409);

  // The record first: what it covers, who asked and when, and the lease. Nothing is deleted without it.
  const begun = await authWrite(env, "/account-deletion/begin", { subject: person.tenant, owned: covered,
    helping: standing.helping });
  if (!begun) return json({ error: "audit_unavailable" }, 503);
  if (begun.status === 409) return json({ error: "deletion_running" }, 409);
  if (!begun.ok) return json({ error: "audit_unavailable" }, 503);
  const record = ((await begun.json()) as { record: AccountDeletionRecord }).record;

  const stop = async (step: "shops" | "helping" | "account", failed: unknown): Promise<Response> => {
    await authWrite(env, "/account-deletion/release", { subject: person.tenant });
    return json({ error: "deletion_incomplete", step, failed }, 500);
  };

  // 1. The shops they own, each through its own deletion record and wipe, and only while the account owns it now
  //    (pilot.ts, `ownerDeletesShop`; item 140). Each goes under the link the account has to it now: the record keeps the
  //    link it was first asked under, and an operator who unlinked the person and linked them again gave them a new one.
  //    The shops the record covers that the account no longer owns (gone already, or linked to nobody or to someone else
  //    since) come first, so a refusal comes before anything the account owns now is touched.
  const ownsNow = new Map(standing.owned.map((one) => [one.shop, one.account]));
  const shops = [...record.owned.filter((one) => !ownsNow.has(one.shop)),
    ...record.owned.filter((one) => ownsNow.has(one.shop))];
  for (const shop of shops) {
    const done: OwnerShopDeletion = await ownerDeletesShop(env, shop.shop, ownsNow.get(shop.shop) ?? shop.account)
      .catch(() => ({ ok: false, error: "shop_unavailable" }));
    if (!done.ok && done.error === "not_owner_now") {
      // Not theirs to delete now, and left as it is. The record stops covering it in the write that gives the lease back,
      // so the same request sent again is answered `owned_changed` with the list as it now is, and the person can go on
      // deleting their account without it.
      const released = await authWrite(env, "/account-deletion/release", { subject: person.tenant, notOwned: shop.shop });
      await released?.body?.cancel();
      return json({ error: "not_owner_now", shop: shop.shop }, 409);
    }
    if (!done.ok) return stop("shops", [shop.shop]);
  }
  // 2. Shops they began to make and never finished.
  for (const tenant of record.makes) {
    // The record names who asked by the account the make linked as the shop's owner, when its people record got so far.
    const people = await readPeople(env, tenant);
    const askedBy = people?.ownerAccount?.subject === person.tenant ? people.ownerAccount.id : "owner";
    const done = await deleteUnfinishedMake(env, tenant, askedBy).catch(() =>
      ({ ok: false, error: "shop_unavailable" }) as OwnerShopDeletion);
    if (!done.ok) return stop("shops", [tenant]);
  }
  // 3. The shops they help at: they leave, and nothing of the shop's goes.
  for (const place of record.helping) {
    const left = await peopleCall(env, place.shop, "/people/leave", { helperId: place.helper }).catch(() => null);
    // 404: they are no longer a helper there (an earlier try, or the owner removed them meanwhile), which is done too.
    const ok = left !== null && (left.ok || left.status === 404);
    await left?.body?.cancel();
    if (!ok) return stop("helping", [place.shop]);
  }
  // 4. Their index of shops and their link code, and their Apple token from kept to pending revoke, in one write; then one
  //    try at Apple. A failure at Apple is recorded and the alarm tries again: it never stops the deletion.
  const forgot = await authWrite(env, "/account-deletion/forget", { subject: person.tenant });
  if (!forgot?.ok) return stop("account", ["index"]);
  const { pending } = (await forgot.json()) as { pending: boolean };
  let apple: AppleRevokeState | undefined = person.tenant.startsWith("apple:") ? "no_token" : undefined;
  if (pending) {
    const tried = await authWrite(env, "/account-deletion/revoke", { subject: person.tenant });
    const said = tried?.ok ? ((await tried.json()) as { apple: AppleRevokeState | "none" }).apple : "retrying";
    // `none`: the alarm got to it first, and the record says how it went (below).
    apple = said === "none" ? "retrying" : said;
  }
  // 5. Their own sign-in's data, and every session of theirs, last: until here the same request finishes a stop.
  const wipe = await tenantDelete(env, person.tenant).catch(() => null);
  if (!wipe?.ok) {
    const body = (await wipe?.json().catch(() => null)) as { failed?: unknown } | null;
    return stop("account", body?.failed ?? ["sessions"]);
  }
  await wipe.body?.cancel();
  // The record says it finished, and what became of the Apple token by now (the alarm may have tried again meanwhile).
  // Its own write failing leaves nothing of the person's: the record only reads unfinished.
  const finished = await authWrite(env, "/account-deletion/finish", { subject: person.tenant });
  if (finished?.ok) apple = ((await finished.json()) as { record: AccountDeletionRecord }).record.apple ?? apple;
  else await finished?.body?.cancel();

  const answer: AccountDeleted = {
    deleted: true,
    shops: record.owned.map((one) => ({ id: one.shop, name: one.name })),
    left: record.helping.map((one) => ({ id: one.shop, name: one.name })),
    ...(apple ? { apple } : {}),
  };
  return json(answer);
}
