/// Every word on the owner's deletion page, in one table, as the approval page keeps its own. English for now; a
/// Thai table is a second object of the same type. Sentences that hold a name or a number are functions, because
/// Thai puts them in a different place. Copy rules from the canvas: plain words, sentence case, no exclamation
/// marks, no emoji, no em dashes. The page never says "maybe" about deletion: it says what is deleted, what is
/// not, and that it cannot be undone.

export type DeleteStrings = {
  /// For dates written by Intl, such as "24 November".
  locale: string;
  documentTitle: string;
  brand: string;
  practiceMode: string;
  loading: string;

  kindTag: string;
  title: (shop: string) => string;
  intro: string;
  whatGoes: string;
  goesDetails: string;
  goesMessages: (count: number) => string;
  goesReplies: (count: number) => string;
  goesPayments: (count: number) => string;
  goesLine: string;
  cantUndo: string;
  deleteAll: string;
  deleting: string;
  keep: string;
  keeping: string;
  expiresHint: (when: string) => string;
  whenToday: (clock: string) => string;
  whenTomorrow: (clock: string) => string;
  whenOn: (clock: string, date: string) => string;
  decisionFailed: string;
  decisionUnclear: string;

  deletingTag: string;
  deletingTitle: (shop: string) => string;
  deletingHint: string;
  deletedTag: string;
  deletedTitle: (shop: string) => string;
  deletedBody: string;
  answeredAt: (clock: string) => string;
  keptTag: string;
  keptTitle: string;
  keptHint: string;
  expiredTag: string;
  expiredTitle: string;
  expiredHint: string;
  alreadyAnswered: (clock: string | null) => string;

  linkExpiredTitle: string;
  linkExpiredBody: string;
  linkInvalidTitle: string;
  linkInvalidBody: string;
  loadErrorTitle: string;
  loadErrorBody: string;
  tryAgain: string;
};

function count(n: number, one: string, many: string): string {
  return `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;
}

export const en: DeleteStrings = {
  locale: "en-GB",
  documentTitle: "Delete your shop's data",
  brand: "Manut AI",
  practiceMode: "Practice mode. This page uses sample data and deletes nothing real.",
  loading: "Loading the request",

  kindTag: "Delete data",
  title: (shop) => `Delete everything Manut AI stores for ${shop}?`,
  intro: "The Manut AI team asked to delete your shop's data. Nothing is deleted unless you say yes here.",
  whatGoes: "This deletes:",
  goesDetails: "Your shop's details",
  goesMessages: (n) => count(n, "customer message", "customer messages"),
  goesReplies: (n) => count(n, "reply", "replies"),
  goesPayments: (n) => count(n, "payment record", "payment records"),
  goesLine: "The connection to your LINE account, so new messages stop arriving at Manut AI",
  cantUndo: "It can't be undone. Your chats in LINE itself are not touched.",
  deleteAll: "Delete everything",
  deleting: "Deleting",
  keep: "Keep my data",
  keeping: "Keeping",
  expiresHint: (when) => `If you do not answer by ${when}, nothing is deleted.`,
  whenToday: (clock) => `${clock} today`,
  whenTomorrow: (clock) => `${clock} tomorrow`,
  whenOn: (clock, date) => `${clock} on ${date}`,
  decisionFailed: "Your answer did not get through. Nothing was deleted. Try again.",
  decisionUnclear: "We could not reach Manut AI to check your answer. Try again.",

  deletingTag: "Deleting",
  deletingTitle: (shop) => `You said yes. Deleting ${shop}'s data.`,
  deletingHint: "Manut AI finishes it even if you close this page.",
  deletedTag: "Deleted",
  deletedTitle: (shop) => `Done. ${shop}'s data is deleted.`,
  deletedBody:
    "Manut AI no longer stores your shop's customer messages, replies or payments. Your chats in LINE itself are not touched.",
  answeredAt: (clock) => `Answered at ${clock}.`,
  keptTag: "Kept",
  keptTitle: "You kept your data. Nothing was deleted.",
  keptHint: "The Manut AI team can see your answer.",
  expiredTag: "Expired",
  expiredTitle: "Nobody answered in 24 hours, so nothing was deleted.",
  expiredHint: "To delete your data, ask the Manut AI team for a new link.",
  alreadyAnswered: (clock) =>
    clock
      ? `This request was already answered at ${clock}, so your answer was not used.`
      : "This request was already answered, so your answer was not used.",

  linkExpiredTitle: "This link has expired",
  linkExpiredBody:
    "Links work for 24 hours, and this one has run out. If you answered before then, your answer stands. To delete your data now, ask the Manut AI team for a new link.",
  linkInvalidTitle: "This link does not work",
  linkInvalidBody: "It may be cut short or changed. Open it again from the LINE message. Nothing was deleted from it.",
  loadErrorTitle: "Could not load this request",
  loadErrorBody: "Check your internet connection and try again.",
  tryAgain: "Try again",
};

export function deleteStrings(): DeleteStrings {
  return en;
}
