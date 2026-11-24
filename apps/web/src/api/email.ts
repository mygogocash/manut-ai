/// How the API reads an email address and a sign-in code (apps/api/src/auth.ts, `normalizeEmail`, and
/// apps/api/src/email-code.ts), so the join page and the practice-mode fake agree with it about what is an address. The
/// two apps share no code, so a change to a rule there is made here as well.

/// The longest address an email can be (RFC 5321's path limit).
export const EMAIL_MAX = 254;
/// One `@` between two parts that hold no spaces: the shape `@manut/people-rules` accepts.
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+$/;

/// A sign-in code is exactly six digits.
export const CODE_LENGTH = 6;

/// An address as the API keeps it: trimmed and lower-cased, at most 254 characters, with one `@` between two parts that
/// hold no spaces. Null for anything else, which the API answers `invalid_request`.
export function normalizeEmail(value: string): string | null {
  const email = value.trim().toLowerCase();
  return email.length <= EMAIL_MAX && EMAIL_SHAPE.test(email) ? email : null;
}

/// Whether a code is one the API would try: exactly six digits. Anything else is not a try at all.
export function isCode(value: string): boolean {
  return /^\d{6}$/.test(value);
}
