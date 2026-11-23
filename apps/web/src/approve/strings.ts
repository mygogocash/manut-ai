/// Every word on the owner's page, in one table. English for now; a Thai table is a second object of the
/// same type, so nothing else changes when it arrives. Sentences that hold a name are functions, because
/// Thai puts the name in a different place. Copy rules from the canvas: plain words, sentence case, no
/// exclamation marks, no emoji, no em dashes.

export type OwnerStrings = {
  /// For dates written by Intl, such as "24 November".
  locale: string;
  documentTitle: string;
  brand: string;
  practiceMode: string;
  loading: string;

  kindLineReply: string;
  memberLine: (member: string, role: string) => string;
  consequence: (customer: string) => string;
  customerWrote: (customer: string) => string;
  replyLabel: (member: string) => string;
  approve: string;
  approving: string;
  no: string;
  declining: string;
  expiresHint: (when: string) => string;
  whenToday: (clock: string) => string;
  whenTomorrow: (clock: string) => string;
  whenOn: (clock: string, date: string) => string;
  decisionFailed: string;
  decisionUnclear: string;

  consentTitle: (shop: string) => string;
  consentIntro: (member: string, shop: string) => string;
  consentPoints: (shop: string) => string[];
  consentAllow: string;
  consentAllowing: string;
  consentNotNow: string;
  consentNeeded: string;
  consentFailed: string;

  sendingTag: string;
  sendingTitle: (customer: string) => string;
  sendingHint: string;
  sentTag: string;
  sentTitle: (member: string, customer: string) => string;
  sentLabel: string;
  answeredAt: (clock: string) => string;
  declinedTag: string;
  declinedTitle: (customer: string) => string;
  declinedHint: (member: string) => string;
  expiredTag: string;
  expiredTitle: (member: string, customer: string) => string;
  failedTag: string;
  failedTitle: (customer: string) => string;
  failedHint: (member: string) => string;
  unknownTag: string;
  unknownTitle: string;
  alreadyAnswered: (clock: string | null) => string;
  nothingSentTwice: string;

  linkExpiredTitle: string;
  linkExpiredBody: string;
  linkInvalidTitle: string;
  linkInvalidBody: string;
  loadErrorTitle: string;
  loadErrorBody: string;
  tryAgain: string;
};

/// "a customer" opens a sentence as "A customer". Thai has no capitals, so only the English table uses it.
function cap(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export const en: OwnerStrings = {
  locale: "en-GB",
  documentTitle: "Approve a reply",
  brand: "Manut AI",
  practiceMode: "Practice mode. This page uses sample data and sends nothing.",
  loading: "Loading the request",

  kindLineReply: "LINE reply",
  memberLine: (member, role) => `${member}, ${role}`,
  consequence: (customer) => `Sends a reply to ${customer} on LINE. It can't be unsent.`,
  customerWrote: (customer) => `${cap(customer)} wrote`,
  replyLabel: (member) => `${member}'s reply, exactly as it will be sent`,
  approve: "Approve",
  approving: "Approving",
  no: "No",
  declining: "Saying no",
  expiresHint: (when) => `If nobody answers by ${when}, nothing is sent.`,
  whenToday: (clock) => `${clock} today`,
  whenTomorrow: (clock) => `${clock} tomorrow`,
  whenOn: (clock, date) => `${clock} on ${date}`,
  decisionFailed: "Your answer did not get through. Nothing was sent. Try again.",
  decisionUnclear: "We could not reach Manut AI to check your answer. Try again.",

  consentTitle: (shop) => `Allow Manut AI to send messages for ${shop} on LINE`,
  consentIntro: (member, shop) =>
    `${member} writes replies to ${shop}'s customers. Before the first one goes out, Manut AI needs your permission to send messages from your LINE account.`,
  consentPoints: (shop) => [
    `Only replies you approve are sent, from ${shop}'s LINE account.`,
    "Each link shows one reply and stops working after 24 hours.",
    "You give this permission once. To take it back, tell the Manut AI team.",
  ],
  consentAllow: "Allow and send this reply",
  consentAllowing: "Allowing",
  consentNotNow: "Not now",
  consentNeeded: "Manut AI needs your permission before it can send this reply.",
  consentFailed: "Your permission did not get through. Nothing was sent. Try again.",

  sendingTag: "Sending",
  sendingTitle: (customer) => `Approved. Sending the reply to ${customer}.`,
  sendingHint: "This page updates by itself. You can close it and the reply is still sent.",
  sentTag: "Sent",
  sentTitle: (member, customer) => `Approved. ${member} sent the reply to ${customer}.`,
  sentLabel: "What was sent",
  answeredAt: (clock) => `Answered at ${clock}.`,
  declinedTag: "Declined",
  declinedTitle: (customer) => `You said no. Nothing was sent to ${customer}.`,
  declinedHint: (member) => `${member} can see your answer.`,
  expiredTag: "Expired",
  expiredTitle: (member, customer) =>
    `${member} asked to send a reply to ${customer}. Nobody answered in 24 hours, so nothing was sent.`,
  failedTag: "Failed",
  failedTitle: (customer) => `You approved, but LINE did not accept the reply. Nothing was sent to ${customer}.`,
  failedHint: (member) => `${member} can see that it failed.`,
  unknownTag: "Not sure",
  unknownTitle: "We are not sure it was sent. Do not send it again; we will check.",
  alreadyAnswered: (clock) =>
    clock
      ? `This request was already answered at ${clock}, so your answer was not used.`
      : "This request was already answered, so your answer was not used.",
  nothingSentTwice: "Nothing was sent twice.",

  linkExpiredTitle: "This link has expired",
  linkExpiredBody: "Links work for 24 hours, and this one has run out. Nothing was sent from it.",
  linkInvalidTitle: "This link does not work",
  linkInvalidBody: "It may be cut short or changed. Open it again from the LINE message. Nothing was sent from it.",
  loadErrorTitle: "Could not load this request",
  loadErrorBody: "Check your internet connection and try again.",
  tryAgain: "Try again",
};

export function ownerStrings(): OwnerStrings {
  return en;
}
