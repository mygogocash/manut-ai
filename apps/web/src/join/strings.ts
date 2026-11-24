/// Every word on the join page, in one table, as the owner's pages keep theirs (approve/strings.ts). English for now; a
/// Thai table is a second object of the same type. Sentences that hold a name or a number are functions, because Thai
/// puts them in a different place. Copy rules from the canvas: plain words, sentence case, no exclamation marks, no emoji,
/// no em dashes. The sign-in words are the canvas's ("States: sign-in, files and forms"), and the invite's are its people
/// board's, without the names the page cannot know: the API names the shop and its owner only after a signed-in accept,
/// and never the account an invite is for.

export type JoinStrings = {
  locale: string;
  documentTitle: string;
  brand: string;
  practiceMode: string;
  /// Practice sends no email, so the page says the code aloud.
  practiceCode: (code: string) => string;

  inviteTitle: string;
  inviteBody: string;
  emailLabel: string;
  emailHelp: string;
  sendCode: string;
  sendingCode: string;

  codeTitle: string;
  /// The address partly hidden, and how long the code works.
  codeSentTo: (masked: string, life: string) => string;
  newCodeSent: string;
  codeLabel: string;
  signIn: string;
  signingIn: string;
  resendIn: (clock: string) => string;
  resend: string;
  resending: string;
  anotherEmail: string;

  /// A wrong code, with the tries it has left, or null when the answer did not say. At 0 it has ended.
  wrongCode: (triesLeft: number | null) => string;
  codeEnded: string;
  /// The address had a code in the last minute, or ten in a day.
  tooManyCodes: (wait: string) => string;
  /// Too many asks from one network.
  tooManyTries: (wait: string) => string;
  offline: string;
  badAddress: string;
  badCode: string;
  failed: string;
  minutes: (n: number) => string;
  hours: (n: number) => string;

  offTitle: string;
  offBody: string;

  signedInAs: (email: string) => string;
  joining: string;
  sessionEnded: string;
  joinFailedTitle: string;
  joinFailed: string;
  tryAgain: string;
  trying: string;

  joinedTag: string;
  joinedTitle: (shop: string) => string;
  joinedBody: (owner: string) => string;
  nextTitle: string;
  nextBody: (email: string, shop: string) => string;
  joinedHint: string;

  wrongEmailTitle: (shop: string, email: string) => string;
  wrongEmailHint: (owner: string) => string;
  wrongLineTitle: (shop: string, email: string) => string;
  wrongLineHint: (owner: string) => string;
  switchAccount: string;

  expiredTitle: string;
  expiredBody: string;
  revokedTitle: string;
  revokedBody: string;
  usedTitle: string;
  usedBody: string;
  unknownTitle: string;
  unknownBody: string;
};

export const en: JoinStrings = {
  locale: "en-GB",
  documentTitle: "Join a shop",
  brand: "Manut AI",
  practiceMode: "Practice mode. This page uses sample data and sends no email.",
  practiceCode: (code) => `Practice mode: no email was sent. Your code is ${code}.`,

  inviteTitle: "You've been invited to help with a shop on Manut AI",
  inviteBody: "Sign in with the email address the invite was sent to. Then you'll see whose shop it is.",
  emailLabel: "Email",
  emailHelp: "We email you a 6-digit code. There is no password.",
  sendCode: "Send code",
  sendingCode: "Sending code",

  codeTitle: "Check your email",
  codeSentTo: (masked, life) => `We sent a code to ${masked}. It works for ${life}.`,
  newCodeSent: "We sent a new code. The one before no longer works.",
  codeLabel: "6-digit code",
  signIn: "Sign in",
  signingIn: "Signing in",
  resendIn: (clock) => `You can ask for a new code in ${clock}.`,
  resend: "Send a new code",
  resending: "Sending a new code",
  anotherEmail: "Use another email",

  wrongCode: (triesLeft) =>
    triesLeft === null
      ? "That code does not match. Check the newest email from Manut AI."
      : triesLeft <= 0
        ? "That code does not match, and it can't be tried again. Send a new code."
        : `That code does not match. ${triesLeft === 1 ? "1 try" : `${triesLeft} tries`} left. Check the newest email from Manut AI.`,
  codeEnded: "This code no longer works. Codes last 10 minutes, and five wrong tries end one. Send a new code.",
  tooManyCodes: (wait) => `Too many codes for this address. Try again in ${wait}.`,
  tooManyTries: (wait) => `Too many tries from this network. Try again in ${wait}.`,
  offline: "You're offline, or Manut AI can't be reached. Check your connection and try again.",
  badAddress: "Manut AI did not accept that address. Check it and try again.",
  badCode: "Manut AI did not accept that code. Check it and try again.",
  failed: "Something went wrong at Manut AI. Try again in a moment.",
  minutes: (n) => (n === 1 ? "1 minute" : `${n} minutes`),
  hours: (n) => (n === 1 ? "1 hour" : `${n} hours`),

  offTitle: "Joining by email isn't on yet",
  offBody: "Manut AI can't sign you in with an email code yet, so this invite can't be used today. Ask the shop's owner to try again later.",

  signedInAs: (email) => `Signed in as ${email}`,
  joining: "Joining the shop",
  sessionEnded: "Your sign-in ended before you joined. Sign in again.",
  joinFailedTitle: "You have not joined yet",
  joinFailed: "We could not reach Manut AI to answer the invite. Check your connection and try again.",
  tryAgain: "Try again",
  trying: "Trying again",

  joinedTag: "Joined",
  joinedTitle: (shop) => `You've joined ${shop}.`,
  joinedBody: (owner) =>
    `${owner} invited you to help. You can approve messages and replies to customers. Money, public posts and everything else still wait for ${owner}.`,
  nextTitle: "What comes next",
  nextBody: (email, shop) => `Open Manut AI on a Mac and sign in with ${email}. ${shop} is listed there, ready to open.`,
  joinedHint: "This page has signed you out, so you can close it.",

  wrongEmailTitle: (shop, email) => `This invite to ${shop} is for another email address. You signed in as ${email}.`,
  wrongEmailHint: (owner) => `Sign in with the address ${owner} sent the invite to, or ask ${owner} for a new one.`,
  wrongLineTitle: (shop, email) => `This invite to ${shop} is for a LINE account. You signed in as ${email}.`,
  wrongLineHint: (owner) => `Manut AI can't sign you in with LINE yet. Ask ${owner} to invite your email address instead.`,
  switchAccount: "Switch account",

  expiredTitle: "This invite has expired",
  expiredBody: "Ask the shop's owner for a new one. Invites work for 7 days.",
  revokedTitle: "This invite was cancelled",
  revokedBody: "The shop's owner cancelled it. Ask them for a new one if you still need it.",
  usedTitle: "This invite has already been used",
  usedBody:
    "Each invite works once. If you joined with it, open Manut AI on a Mac and sign in with that email. If not, ask the shop's owner for a new one.",
  unknownTitle: "This invite link does not work",
  unknownBody: "It may be cut short or changed. Ask the shop's owner to send it again.",
};

export function joinStrings(): JoinStrings {
  return en;
}
