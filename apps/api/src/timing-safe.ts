/// Constant-time comparison of two strings, so a guess at a key, a code's HMAC or a credential's digest learns nothing from
/// how long the comparison took. The length is checked first: none of these values keeps its length secret. The one copy
/// the Worker uses: index.ts compares the operator key with it, people.ts the cloud key, auth-object.ts an email code's
/// HMAC and sign-in-vault.ts an outpost's credential digest.
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
