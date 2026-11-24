/// Every word of the owner's web app (`/app/`), in one table, as the other pages keep theirs (approve/strings.ts,
/// join/strings.ts). English for now; a Thai table is a second object of the same type, written by the owner's writer.
/// Sentences that hold a name, a number or a time are functions, because Thai puts them in a different place. Copy rules
/// from the canvas: plain words, sentence case, no exclamation marks, no emoji, no em dashes. The phone board ("Manut AI
/// on the phone") gives the greeting, "{n} need you", Buddy's morning brief and the tabs; a request's card says what it
/// does and shows its exact words, as the approval page does. Signing in uses the join page's words (join/strings.ts).

export type AppStrings = {
  locale: string;
  brand: string;
  documentTitle: string;
  practiceMode: string;
  practiceReload: string;
  opening: string;

  signInTitle: string;
  signInBody: string;
  offTitle: string;
  offBody: string;
  signedOutTitle: string;
  signedOutBody: string;
  startFailedTitle: string;
  startFailedBody: string;
  tryAgain: string;

  needYou: (n: number) => string;
  tabs: { today: string; needs: string; chat: string; shops: string };
  sections: string;
  greeting: (part: "morning" | "afternoon" | "evening", name: string | null) => string;

  briefTitle: string;
  briefWaits: string;
  waitingCount: (n: number) => string;
  openNeeds: string;

  chatTitle: string;
  chatBody: string;

  shopsTitle: string;
  youOwn: string;
  youHelp: (owner: string) => string;
  helperRule: (owner: string) => string;
  shopNotReady: string;
  signOut: string;
  signingOut: string;
  signOutOffline: string;
  signOutFailed: string;

  needsTitle: string;
  loadingNeeds: string;
  nothingWaitsTitle: string;
  nothingWaitsBody: string;
  shopUnreadable: (shop: string) => string;
  shopLeft: (shop: string, why: "removed" | "unlinked", date: string | null) => string;
  unreadable: (n: number) => string;

  /// What kind of thing a request is, on its tag.
  kindTag: (kind: string, operation: string | undefined) => string;
  /// What approving it does, in one sentence.
  consequence: (kind: string, operation: string | undefined) => string;
  replyLabel: string;
  sentenceLabel: string;
  otherAction: (operation: string, target: string) => string;
  askedIn: (shop: string, when: string) => string;
  expiresHint: (when: string) => string;
  whenToday: (clock: string) => string;
  whenTomorrow: (clock: string) => string;
  whenOn: (clock: string, date: string) => string;
  passedOn: (name: string, note: string) => string;
  approve: string;
  approving: string;
  decline: string;
  declining: string;
  /// Who may decide what, as approval-core's `mayDecide` says: a helper sees why a request waits for the owner.
  ownerOnly: (kind: string) => string;
  waitsFor: (owner: string) => string;
  outdated: string;

  sent: string;
  sending: string;
  sendFailed: (line: boolean) => string;
  sendUnknown: string;
  declined: string;
  already: (who: Who, approved: boolean, when: string | null) => string;
  nothingSentTwice: string;
  changed: string;
  superseded: (reason: string) => string;
  expired: (when: string | null) => string;
  notOffered: string;
  consentRequired: (shop: string) => string;
  switchedOff: string;
  gone: string;
  unclear: string;

  recentTitle: string;
  recentNone: string;
  answeredBy: (who: Who, approved: boolean, when: string | null) => string;
  ranOut: (when: string | null) => string;
  noLongerAsked: string;

  offlineTitle: string;
  offlineBody: string;
  offlineHeld: (when: string) => string;
  backOnline: string;
};

/// Who decided, as the app can tell: the person, the shop's owner (from the LINE link or another way), a helper whose
/// name the app is not told, or someone in a role this build does not know.
export type Who =
  | { kind: "you"; link: boolean }
  | { kind: "owner"; name: string; link: boolean }
  | { kind: "helper" }
  | { kind: "someone" };

/// " from the LINE link" when the owner's link decided it.
const fromLink = (who: Who) => ((who.kind === "you" || who.kind === "owner") && who.link ? " from the LINE link" : "");

const plural = (n: number, one: string, many: string) => (n === 1 ? `1 ${one}` : `${n} ${many}`);

function whoName(who: Who, start: boolean): string {
  switch (who.kind) {
    case "you":
      return start ? "You" : "you";
    case "owner":
      return who.name;
    case "helper":
      return start ? "A helper" : "a helper";
    case "someone":
      return start ? "Someone" : "someone";
  }
}

const KIND_TAGS: Readonly<Record<string, string>> = {
  message: "Message",
  reply: "Reply",
  money: "Money",
  public_post: "Public post",
  payment_confirmation: "Payment",
  command: "Shop records",
};

const OPERATION_TAGS: Readonly<Record<string, string>> = {
  "line.message.push": "LINE reply",
  "google.sheets.append": "Books",
  "browser.submit": "Website form",
};

const CONSEQUENCES: Readonly<Record<string, string>> = {
  "line.message.push": "Sends a reply to a customer on LINE. It can't be unsent.",
  "google.sheets.append": "Adds a month of the shop's books to the owner's Google Sheet.",
  "browser.submit": "Fills in a form on a website and sends it for the shop.",
  message: "Sends a message. It can't be unsent.",
  reply: "Sends a reply. It can't be unsent.",
  money: "Moves the shop's money.",
  public_post: "Posts where anyone can see it.",
  payment_confirmation: "Tells a customer their payment arrived, which releases the goods.",
  command: "Changes the shop's own records.",
};

const OWNER_ONLY: Readonly<Record<string, string>> = {
  money: "Only the owner can approve money.",
  public_post: "Only the owner can approve public posts.",
  payment_confirmation: "Only the owner can confirm that a payment arrived.",
  command: "Only the owner can approve changes to the shop's own records.",
};

export const en: AppStrings = {
  locale: "en-GB",
  brand: "Manut AI",
  documentTitle: "Manut AI",
  practiceMode: "Practice mode. This app uses sample data and sends nothing.",
  practiceReload: "Practice keeps you signed in until the page reloads. The real app stays signed in.",
  opening: "Opening Manut AI",

  signInTitle: "Sign in to Manut AI",
  signInBody: "Sign in with your email address to see what waits for you in your shops.",
  offTitle: "Signing in isn't on yet",
  offBody:
    "Manut AI can't sign you in with an email code yet, so this app can't open your shops today. The approval links Manut AI sends you on LINE still work.",
  signedOutTitle: "You're signed out",
  signedOutBody: "Your sign-in on this phone ended. Sign in again to see what waits for you.",
  startFailedTitle: "Manut AI did not answer",
  startFailedBody: "Check your connection and try again in a moment.",
  tryAgain: "Try again",

  needYou: (n) => `${n} need you`,
  tabs: { today: "Today", needs: "Needs you", chat: "Chat", shops: "Shops" },
  sections: "Sections",
  greeting: (part, name) => `Good ${part}${name ? `, ${name}` : ""}`,

  briefTitle: "Buddy's morning brief",
  briefWaits: "Buddy writes a brief each morning once the team's AI model is switched on. It isn't on yet.",
  waitingCount: (n) => (n === 0 ? "Nothing waits for you right now." : `${plural(n, "request waits", "requests wait")} for you.`),
  openNeeds: "Open Needs you",

  chatTitle: "Chat with Buddy",
  chatBody:
    "Chatting with Buddy comes once the team's AI model is switched on. Until then, the team asks before anything public, costly or final, and you answer in Needs you.",

  shopsTitle: "Your shops",
  youOwn: "You own this shop",
  youHelp: (owner) => `You help ${owner}`,
  helperRule: (owner) => `You can approve messages and replies. Money, public posts and everything else wait for ${owner}.`,
  shopNotReady: "Manut AI could not open this shop just now. Its requests show once it can.",
  signOut: "Sign out",
  signingOut: "Signing out",
  signOutOffline: "You're offline. Sign out when you're back online, so this phone keeps nothing.",
  signOutFailed: "Manut AI did not answer, so you're still signed in. Try again.",

  needsTitle: "Needs you",
  loadingNeeds: "Loading what waits for you",
  nothingWaitsTitle: "Nothing waits for you",
  nothingWaitsBody: "When the team asks before something public, costly or final, it shows here.",
  shopUnreadable: (shop) => `Could not read ${shop} just now. What waits there shows once it can.`,
  shopLeft: (shop, why, date) =>
    why === "removed"
      ? `The owner removed you from ${shop}${date ? ` on ${date}` : ""}. Ask them if this is a mistake.`
      : `This account was unlinked from ${shop}${date ? ` on ${date}` : ""}. Ask the Manut AI team if this is a mistake.`,
  unreadable: (n) => `${plural(n, "request", "requests")} could not be read. Open Manut AI on the Mac to see ${n === 1 ? "it" : "them"}.`,

  kindTag: (kind, operation) => (operation && OPERATION_TAGS[operation]) ?? KIND_TAGS[kind] ?? kind,
  consequence: (kind, operation) =>
    (operation && CONSEQUENCES[operation]) ?? CONSEQUENCES[kind] ?? "Does something for the shop.",
  replyLabel: "The reply, exactly as it will be sent",
  sentenceLabel: "Exactly what will be done",
  otherAction: (operation, target) => `${operation} on ${target}`,
  askedIn: (shop, when) => `${shop}, asked ${when}`,
  expiresHint: (when) => `If nobody answers by ${when}, nothing is done.`,
  whenToday: (clock) => `${clock} today`,
  whenTomorrow: (clock) => `${clock} tomorrow`,
  whenOn: (clock, date) => `${clock} on ${date}`,
  passedOn: (name, note) => `${name} passed this on: “${note}”`,
  approve: "Approve",
  approving: "Approving",
  decline: "Decline",
  declining: "Declining",
  ownerOnly: (kind) => OWNER_ONLY[kind] ?? "Only the owner can decide this.",
  waitsFor: (owner) => `It waits for ${owner}.`,
  outdated: "This needs a newer Manut AI to answer. Open Manut AI on the Mac.",

  sent: "Approved and sent.",
  sending: "Approved. It's being sent now, once.",
  sendFailed: (line) =>
    line ? "You approved, but LINE did not accept the reply. Nothing was sent." : "You approved, but it could not be done. Nothing was sent.",
  sendUnknown: "We are not sure it was sent. Do not send it again; we will check.",
  declined: "You said no. Nothing was sent.",
  already: (who, approved, when) =>
    `${whoName(who, true)} already ${approved ? "approved" : "declined"} this${fromLink(who)}${when ? ` at ${when}` : ""}, so your answer was not used.`,
  nothingSentTwice: "Nothing was sent twice.",
  changed: "It changed since you saw it. Read it again before you answer.",
  superseded: (reason) =>
    reason === "withdrawn"
      ? "The team took this back. Nothing was decided."
      : reason === "attempt_ended" || reason === "turn_ended"
        ? "No longer asked: the work it was for has stopped. Nothing was decided."
        : "This no longer waits for an answer. Nothing was decided.",
  expired: (when) => `Nobody answered in time${when ? `: it ran out at ${when}` : ""}, so nothing was done.`,
  notOffered: "That answer isn't offered for this request. Nothing was decided.",
  consentRequired: (shop) => `${shop} hasn't agreed yet to let Manut AI send for it. Nothing was decided.`,
  switchedOff: "Answering is switched off for now. Nothing was decided.",
  gone: "This request is no longer here. Nothing was decided.",
  unclear: "We could not tell whether your answer arrived. Checking again before you can answer; nothing is ever sent twice.",

  recentTitle: "Answered lately",
  recentNone: "Nothing answered lately.",
  answeredBy: (who, approved, when) =>
    `${approved ? "Approved" : "Declined"} by ${whoName(who, false)}${fromLink(who)}${when ? ` at ${when}` : ""}.`,
  ranOut: (when) => `Nobody answered in time${when ? `. It ran out at ${when}` : ""}.`,
  noLongerAsked: "No longer asked.",

  offlineTitle: "You're offline",
  offlineBody: "What waits for you can't be shown or answered offline. It shows again when you're back online.",
  offlineHeld: (when) => `Read at ${when}. These may have changed, so they can't be answered until you're back online.`,
  backOnline: "Back online. Reading what waits for you again.",
};

export function appStrings(): AppStrings {
  return en;
}
