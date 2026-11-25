/// A task object telling its shop's TenantObject that one of its own changes reached what the shop's screens read, for the
/// shop's live feed (feed.ts; docs/pilot-api.md, "The shop's live feed"). It lives apart from feed.ts so that the task object,
/// which half the Worker's modules import, takes none of the feed's own imports with it.

import { isValidTenant } from "./companies";
import { tenantCall, type TenantDataEnv } from "./tenant-data";

/// How long a task object stays quiet after its shop said nobody follows it. A desktop that connects meanwhile sees that
/// task's changes at its next one-minute read, as it would without the feed; while the switch is off nobody ever follows,
/// so a busy task tells its shop at most once a minute, and a task written once, once.
export const FEED_QUIET_MS = 60_000;

/// One call to the shop's object, which pings its sockets within a second (feed.ts `ShopFeed.touch`). Answers how many
/// sockets the shop has open, or null when the object could not be told. Nothing waits on it and nothing fails with it,
/// since the desktop's one-minute read stands whatever the feed does.
export async function touchFeed(env: Pick<TenantDataEnv, "TENANT">, tenant: string): Promise<number | null> {
  if (!isValidTenant(tenant)) return null;
  try {
    const response = await tenantCall(env, tenant, "/feed/touch", { method: "POST", headers: { "x-feed": "1" } });
    if (!response.ok) {
      await response.body?.cancel();
      return null;
    }
    const body = (await response.json()) as { listening?: unknown };
    return typeof body.listening === "number" ? body.listening : null;
  } catch {
    return null;
  }
}
