/// Sending a sign-in code by email (email-code.ts; docs/pilot-api.md, "Signing in by email"). Sending is a small port
/// with two implementations, so the routes and their tests never depend on which one runs:
///
/// - Cloudflare Email Service, through its Worker binding. Its API is the one Cloudflare documents on
///   https://developers.cloudflare.com/email-service/api/send-emails/workers-api/ (read 24 Nov 2026): a `send_email`
///   binding in the Wrangler config (`"send_email": [{ "name": "EMAIL" }]`), and `env.EMAIL.send({ to, from, subject,
///   text })`, where `from` may be `{ email, name }`, resolving with `{ messageId }` and throwing an Error whose `code`
///   says why (`E_SENDER_NOT_VERIFIED`, `E_RECIPIENT_SUPPRESSED`, `E_DAILY_LIMIT_EXCEEDED` and so on). No environment
///   binds it yet: sending needs the Workers Paid plan and a sending domain the owner controls.
/// - A test-only outbox that the workerd tests read the code from. Only `TEST_EMAIL_OUTBOX`, which wrangler.test.json
///   sets and no deploy config may (.github/scripts/check-dev-deploys.mjs refuses every `TEST_` var), reaches it, as
///   `TEST_JWKS_JSON` is the only way to the test Apple key.

import { normalizeEmail } from "./auth";

/// One email: a plain subject and body to one address.
export type CodeEmail = { to: string; subject: string; text: string };

/// Who the email comes from, as the person's mail app shows it.
export type Sender = { email: string; name: string };

export interface EmailSender {
  /// Hands one email to the service. It throws when the service refuses it; `deliver` below decides what anyone learns.
  send(email: CodeEmail): Promise<void>;
}

export type SenderEnv = {
  /// Cloudflare Email Service's `send_email` binding. Unbound in every environment until the owner sets up sending.
  EMAIL?: SendEmail;
  /// The address and name codes come from: Worker vars the owner fills in, both unset today. The address must be on a
  /// domain onboarded to Email Service; without it nothing is sent.
  EMAIL_FROM_ADDRESS?: string;
  EMAIL_FROM_NAME?: string;
  /// TEST-ONLY: "on" sends every email to the in-memory outbox below. Only wrangler.test.json sets it.
  TEST_EMAIL_OUTBOX?: string;
};

/// The name an email comes from when the owner sets an address but no name: the product's own.
const DEFAULT_SENDER_NAME = "Manut AI";
const SENDER_NAME_MAX = 64;

/// Who codes come from, or null until the owner's address is an address. An unset name is the product's; a name that is
/// too long or holds a control character (a line break would end a mail header) leaves sending unconfigured rather than
/// sending under a name nobody chose.
export function senderOf(env: SenderEnv): Sender | null {
  const email = normalizeEmail(env.EMAIL_FROM_ADDRESS);
  if (!email) return null;
  if (env.EMAIL_FROM_NAME === undefined) return { email, name: DEFAULT_SENDER_NAME };
  const name = env.EMAIL_FROM_NAME.trim();
  if (!name || name.length > SENDER_NAME_MAX || /[\u0000-\u001f\u007f]/.test(name)) return null;
  return { email, name };
}

/// Cloudflare Email Service through its Worker binding, with the call the docs page above names.
export function cloudflareSender(binding: SendEmail, from: Sender): EmailSender {
  return {
    async send(email) {
      await binding.send({ to: email.to, from, subject: email.subject, text: email.text });
    },
  };
}

/// TEST-ONLY. What the outbox sender has been handed, newest last, so a workerd test can read the code it sent. It lives
/// in this module's memory, never in storage, and keeps the newest 200 emails, so a long run cannot grow it.
const outbox: (CodeEmail & { from: Sender })[] = [];
const OUTBOX_MAX = 200;

/// TEST-ONLY. The emails the outbox holds. Nothing outside the tests reads it: no route returns it.
export function testOutbox(): readonly (CodeEmail & { from: Sender })[] {
  return outbox;
}

function outboxSender(from: Sender): EmailSender {
  return {
    // The email is in the outbox when `send` returns, before any await, so a test that has its answer can read it.
    send(email) {
      outbox.push({ from, ...email });
      if (outbox.length > OUTBOX_MAX) outbox.splice(0, outbox.length - OUTBOX_MAX);
      return Promise.resolve();
    },
  };
}

/// The sender email sign-in uses, or null when none is bound. A configuration that names the test outbox gets it even
/// beside a real binding, as the test Apple key wins over Apple's endpoint, so a test run can never send real mail.
export function senderFor(env: SenderEnv): EmailSender | null {
  const from = senderOf(env);
  if (!from) return null;
  if (env.TEST_EMAIL_OUTBOX === "on") return outboxSender(from);
  return env.EMAIL ? cloudflareSender(env.EMAIL, from) : null;
}

/// Sends one email and keeps every failure to itself. The person's answer never depends on the send: a refusal such as
/// `E_RECIPIENT_SUPPRESSED` is about the address, and telling it apart would say the address had mail from Manut AI
/// before. The log line names only the service's error code (Cloudflare's are `E_` and capitals), never the error's
/// message, which may name the address, and never the email, which holds the code.
export async function deliver(sender: EmailSender, email: CodeEmail): Promise<void> {
  try {
    await sender.send(email);
  } catch (error) {
    const code = error !== null && typeof error === "object" ? (error as { code?: unknown }).code : undefined;
    console.error("email code not sent", typeof code === "string" && /^E_[A-Z_]{1,64}$/.test(code) ? code : "unknown");
  }
}
