/// Where the test-only settings work (24 Nov 2026). `TEST_JWKS_JSON` (the test Apple key, whose private half is committed
/// in test/people-fixtures.ts, so with it anyone could sign in as anyone), `TEST_EMAIL_OUTBOX` (sign-in codes kept in
/// memory instead of sent) and `TEST_GOOGLE_ORIGIN` (Google's hosts, faked by the tests) are set in wrangler.test.json
/// alone, and the deploy check refuses a config that sets any `TEST_` var in any block
/// (.github/scripts/check-dev-deploys.mjs). That check cannot see a secret, nor a var set some other way, so each of them
/// also works only where it names, or this Worker's own public origin is, an https origin under `.test`: a name no network
/// resolves, so a value set by mistake anywhere real people sign in does nothing.

/// An https origin under `.test`, with no path, port or trailing slash.
export const TEST_ORIGIN = /^https:\/\/[a-z0-9-]+(\.[a-z0-9-]+)*\.test$/;

/// Whether this Worker is a test one: its public origin (`PUBLIC_API_ORIGIN`, which wrangler.test.json sets to
/// https://api.manut.test) is an https origin under `.test`. Every real environment's is a real host, or unset.
export function testWorker(env: { PUBLIC_API_ORIGIN?: string }): boolean {
  return typeof env.PUBLIC_API_ORIGIN === "string" && TEST_ORIGIN.test(env.PUBLIC_API_ORIGIN);
}
