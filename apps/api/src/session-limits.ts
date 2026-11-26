/// How fast one person may open shop sessions (docs/pilot-api.md, "Opening a shop session"): `POST /v1/shops/session` and
/// `POST /v1/people/session`, and the web app's `POST /v1/web/shops`, which opens its sessions through the first. Each
/// opening writes a session into a shop's one people record and, for a helper, a sign-in the owner's app tells them of as
/// a new device. So it is counted per person, by the verified subject of their sign-in, whatever address they come from:
/// one bucket for both routes, checked once the person is known and before any shop is read. The limits per address stay
/// where they are (index.ts); this one is the person's own.
///
/// It is a Workers rate limit, `SHOP_SESSION_LIMITER` (20 a minute, wrangler.jsonc). Like the ingress limits it counts per
/// Cloudflare location, which is abuse control, not accounting, and it fails closed: without the binding, or when it
/// fails, nothing opens.

export type SessionLimitEnv = {
  /// Opening a shop session, counted per signed-in person.
  SHOP_SESSION_LIMITER?: RateLimit;
};

/// The refusal for one more shop session opened by `subject`, or null when it may go on: 429 `rate_limited` with
/// `retry-after: 60` past the limit, and 503 `rate_limit_unavailable` without the binding or when it fails, as the ingress
/// limits answer (index.ts).
export async function sessionOpenRefusal(env: SessionLimitEnv, subject: string): Promise<Response | null> {
  const binding = env.SHOP_SESSION_LIMITER;
  if (binding) {
    try {
      const { success } = await binding.limit({ key: subject });
      if (success === true) return null;
      if (success === false) {
        return Response.json({ error: "rate_limited" }, { status: 429, headers: { "retry-after": "60" } });
      }
    } catch {
      // Nothing about the request or the failure is logged: a limiter that fails refuses, as the ingress gate's does.
    }
  }
  return Response.json({ error: "rate_limit_unavailable" }, { status: 503 });
}
