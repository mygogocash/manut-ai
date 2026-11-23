import { formatMoney } from "@manut/format";
import {
  ApiError,
  MODEL_CAP_MAX_SATANG,
  type ApprovalState,
  type AuditActor,
  type AuditEntry,
  type AuditMissed,
  type DeletedShop,
  type DeletionRequest,
  type GateStatus,
  type ModelCap,
  type ModelCounts,
  type ModelUsage,
  type PilotGate,
  type Shop,
} from "../api";
import { dayOffset, formatBaht, formatClock, formatDate, formatStamp } from "../format";

/// The console's status words. Operators read them; the owner never does.
export function stateTag(state: ApprovalState, ownerName: string): { label: string; className: string } {
  switch (state) {
    case "proposed":
      return { label: `Waiting for ${ownerName}`, className: "tag warn" };
    case "approved":
      return { label: "Approved", className: "tag run" };
    case "dispatching":
      return { label: "Sending", className: "tag run" };
    case "confirmed":
      return { label: "Sent", className: "tag ok" };
    case "rejected":
      return { label: "Declined", className: "tag" };
    case "expired":
      return { label: "Expired", className: "tag" };
    case "failed":
      return { label: "Failed", className: "tag err" };
    case "unknown":
      return { label: "Not sure it was sent", className: "tag warn" };
  }
}

/// What the operator should do next, for the states that need anything.
export function stateAdvice(state: ApprovalState, ownerName: string): string | null {
  switch (state) {
    case "proposed":
      return `Send the approval link to ${ownerName} on LINE.`;
    case "failed":
      return "LINE did not take it, so nothing was sent. Propose it again for a new link.";
    case "unknown":
      return "Check the chat in LINE before sending anything again.";
    case "expired":
      return "Nobody answered in 24 hours. Propose it again if the customer still needs an answer.";
    default:
      return null;
  }
}

export function isAuthError(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    (error.status === 401 || error.status === 403 || error.code === "operator_key_missing")
  );
}

export function errorText(error: unknown): string {
  if (isAuthError(error)) {
    return "The API refused the operator key. Check the key, and that this browser is signed in to Cloudflare Access.";
  }
  if (error instanceof ApiError) {
    if (error.status === 0) return "Could not reach the API. Check the connection and try again.";
    if (error.status === 404) return `Not found (${error.code}). It may have been removed.`;
    if (error.status === 400) return `The API did not accept this (${error.code}).`;
    return `The API answered with an error (${error.code}).`;
  }
  return "Something unexpected went wrong. Try again.";
}

/// The shop data tab: exporting or deleting everything stored for a shop, at the shop's request. The wording
/// follows the canvas's Settings and Privacy boards: say what goes, what is not touched, and that it can't
/// be undone. Sentences that hold a name are functions.
export const shopDataWords = {
  tab: "Shop data",
  title: "Export or delete",
  when: "Only when the shop asks",
  intro: (shop: string) =>
    `The export is one file with everything stored for ${shop}, except the LINE keys. Deleting asks for the shop's name first.`,
  exportButton: "Export shop data",
  exporting: "Exporting",
  exported: (file: string, owner: string) =>
    `Exported as ${file}. It holds customer messages, so give it only to ${owner}.`,
  deleteButton: "Delete this shop",
  deleteTitle: (shop: string) => `Delete ${shop}?`,
  undone: "It can't be undone. If the shop wants a copy, export it first.",
  confirmLabel: "Type the shop's name to confirm:",
  confirmHelp: "It must match exactly, capitals and spaces included.",
  deleteForGood: "Delete for good",
  deleting: "Deleting",
  keep: "Keep the shop",
  finish: "Finish deleting",
  runAgain: "Run it again",
  // A live shop's deletion waits for its owner's yes, given through a link the operator sends on LINE.
  askOwner: (owner: string) => `Ask ${owner} to confirm`,
  asking: "Asking",
  ownerStep: (shop: string, owner: string) =>
    `${shop} is live, so ${owner} confirms the deletion. You get a link to send ${owner} on LINE, and nothing is deleted until ${owner} says yes.`,
  linkTitle: (owner: string) => `Deletion link for ${owner}`,
  linkLabel: "Deletion link",
  waitingTag: (owner: string) => `Deletion waiting for ${owner}`,
  unfinishedTag: "Deletion not finished",
} as const;

/// How to send the owner the deletion link, and until when it works.
export function deletionLinkHelp(owner: string, expiresAt: string, now: number = Date.now()): string {
  return `Send it to ${owner} on LINE. Nothing is deleted until ${owner} says yes. It works until ${formatStamp(expiresAt, now)}.`;
}

/// What became of a deletion put to the shop's owner, for every state but the waiting one, which shows its link,
/// and the deleted one, whose shop has left the list.
export function deletionRequestText(request: DeletionRequest, shop: Shop, now: number = Date.now()): string {
  const when = request.decidedAt && !Number.isNaN(Date.parse(request.decidedAt)) ? ` ${whenText(request.decidedAt, now)}` : "";
  switch (request.state) {
    case "declined":
      return `${shop.ownerName} chose to keep ${shop.name}'s data${when}. Nothing was deleted.`;
    case "expired":
      return `${shop.ownerName} did not answer within 24 hours, so nothing was deleted. Delete again for a new link.`;
    case "deleting":
      return `${shop.ownerName} said yes${when}, but deleting ${shop.name} did not finish. Part of its data is still stored. Run it again to finish the job.`;
    case "awaiting_owner":
      return `Waiting for ${shop.ownerName} to confirm deleting ${shop.name}.`;
    case "deleted":
      return `${shop.name} is deleted.`;
  }
}

/// What a deletion removes, naming only what the shop has: a shop with no LINE account has no connection to
/// lose, and an owner who never allowed sending has no permission to take back.
export function deleteWhatText(shop: Shop): string {
  const parts = ["customer messages", "replies", "recorded payments"];
  if (shop.lineConnectionId) parts.push("the LINE connection");
  if (shop.consent) parts.push(`${shop.ownerName}'s permission to send`);
  return `This removes everything stored for ${shop.name}: ${listOf(parts)}.`;
}

/// What stops working once the data is gone, and what a deletion never reaches.
export function deleteAfterText(shop: Shop): string {
  const links = `${shop.ownerName}'s approval links stop working`;
  return shop.lineConnectionId
    ? `${links}, and new messages to the shop's LINE account stop arriving here. The chats in LINE itself are not touched.`
    : `${links}.`;
}

/// The API's own count of what it removed, leaving out what there was none of. Messages and payments have no
/// count in the answer, but a deletion that succeeded took them too. `result` is null when the shop was
/// already gone, which is how a retry learns that an earlier, unanswered attempt finished.
export function deletedText(name: string, result: DeletedShop | null, now: number = Date.now()): string {
  if (!result) return `${name} is already deleted. Nothing of it was left to delete.`;
  const parts: string[] = [];
  if (result.tasksWiped) parts.push(countOf(result.tasksWiped, "task with its replies", "tasks with their replies"));
  if (result.connectionsWiped) parts.push(countOf(result.connectionsWiped, "LINE connection", "LINE connections"));
  if (result.schedulesWiped) parts.push(countOf(result.schedulesWiped, "schedule", "schedules"));
  if (result.occurrencesWiped) parts.push(countOf(result.occurrencesWiped, "scheduled run", "scheduled runs"));
  if (result.sessionsWiped) parts.push(countOf(result.sessionsWiped, "sign-in session", "sign-in sessions"));
  parts.push("the shop's messages and payments");
  const when = Number.isNaN(Date.parse(result.deletedAt)) ? "" : ` ${whenText(result.deletedAt, now)}`;
  return `Deleted ${name}${when}. Removed ${listOf(parts)}.`;
}

/// A deletion that stopped part way (`partial`, from the API's wipe_incomplete) or whose answer never
/// arrived. Either way the same request, sent again, finishes the job, so that is what the words offer.
export function unfinishedText(deletion: { name: string; partial: boolean; tries: number; error: unknown }): string {
  const { name, partial, tries, error } = deletion;
  if (partial) {
    const head =
      tries > 1 ? `Deleting ${name} still did not finish after ${tries} tries.` : `Deleting ${name} did not finish.`;
    const latest = isWipeIncomplete(error) ? "" : ` ${deleteAnswerText(error)}`;
    return `${head} Part of its data is deleted and the rest is still stored.${latest} Run it again to finish the job.`;
  }
  const head =
    tries > 1
      ? `After ${tries} tries, it is still not clear whether ${name} was deleted.`
      : `It is not clear whether ${name} was deleted.`;
  return `${head} ${deleteAnswerText(error)} Running it again is safe, and finishes the job if anything is left.`;
}

/// An answer that deleted nothing. A name mismatch can only mean the server's name differs from the one on
/// screen, because the button stays disabled until the typed name matches it.
export function deleteRefusalText(error: unknown): string {
  if (error instanceof ApiError && error.code === "name_mismatch") {
    return "Nothing was deleted. The name did not match the shop's name exactly. Check the name and type it again.";
  }
  return `Nothing was deleted. ${deleteAnswerText(error)}`;
}

/// The console's usual words for an answer, with the one only a deletion gets: the API records every deletion
/// before it starts the wipe, and starts none it cannot record.
function deleteAnswerText(error: unknown): string {
  if (error instanceof ApiError && error.code === "audit_unavailable") {
    return "The API could not record the deletion, so it did not start. It is safe to try again.";
  }
  return errorText(error);
}

export function isWipeIncomplete(error: unknown): boolean {
  return error instanceof ApiError && error.code === "wipe_incomplete";
}

/// The Pilot gate view: the roadmap's Phase 1 gate, measured from the shops' own records (docs/pilot-api.md, "The
/// pilot gate"). Every number in a sentence comes from the API's answer, its rules and its lines, so the words can
/// never disagree with what was measured.
export const gateWords = {
  nav: "Pilot gate",
  title: "Pilot gate",
  refresh: "Refresh",
  tryAgain: "Try again",
  anotherKey: "Enter another key",
  loading: "Loading the pilot gate",
  sideLabel: "Subscription payments",
  noShops: "No shops yet.",
  measured: (iso: string, now: number = Date.now()) => `Measured ${formatStamp(iso, now)}`,
  intro: (gate: PilotGate) => {
    const days = gate.rules.trialDays;
    return `Phase 1 passes when at least ${gate.cohort.paid.thresholdPercent}% of shops pay ${formatBaht(gate.rules.priceSatang)} after their ${days} free days, and at least ${gate.cohort.active.thresholdPercent}% are still active on day ${days}. A shop is counted once its day ${days} has passed.`;
  },
  status: {
    not_enough_data: "Not enough data yet",
    on_track: "On track",
    below_line: "Below the line",
  } satisfies Record<GateStatus, string>,
  /// Why the status is what it is, naming the share that is under its line.
  statusText: (gate: PilotGate): string => {
    const { counted, paid, active, status } = gate.cohort;
    const day = gate.rules.trialDays;
    if (status === "not_enough_data") return `No shop has reached the end of day ${day} yet, so nothing is counted.`;
    const shops = `counting ${counted} ${counted === 1 ? "shop" : "shops"}`;
    if (status === "on_track") return `Both shares are at or above their lines, ${shops}.`;
    if (!paid.met && !active.met) {
      return `Paying shops are under ${paid.thresholdPercent}% and shops active on day ${day} under ${active.thresholdPercent}%, ${shops}.`;
    }
    if (!paid.met) return `Paying shops are under ${paid.thresholdPercent}%, ${shops}.`;
    return `Shops active on day ${day} are under ${active.thresholdPercent}%, ${shops}.`;
  },
  unavailable:
    "The API could not read every shop's records, so it did not measure the gate rather than leave a shop out. Try again.",

  // The two shares
  paidTitle: (priceSatang: number) => `Paid ${formatBaht(priceSatang)}`,
  paidHelp: (priceSatang: number) => `The shop's payments to Manut AI add up to ${formatBaht(priceSatang)}.`,
  activeTitle: (day: number) => `Active on day ${day}`,
  activeHelp: (windowDays: number, day: number) =>
    `The owner decided a reply in the ${windowDays} days up to and including day ${day}.`,
  noShare: "No shops yet",
  shareOf: (count: number, counted: number) =>
    counted === 0 ? "No shop has finished its free days." : `${count} of ${counted} ${counted === 1 ? "shop" : "shops"}.`,
  meets: (linePercent: number) => `At or above ${linePercent}%`,
  under: (linePercent: number) => `Under ${linePercent}%`,

  // The cohort table
  shopsTitle: "Shops",
  shopsNote: (counted: number, total: number) => `${counted} of ${total} counted`,
  columns: {
    shop: "Shop",
    started: "Trial started",
    today: "Today",
    paid: "Paid",
    active: (day: number) => `Active on day ${day}`,
    lastDecision: "Owner's last decision",
  },
  notStarted: "Not started",
  startsWhen: "Starts when LINE is connected",
  dayOf: (day: number, trialDays: number) => `Day ${day} of ${trialDays}`,
  dayAfter: (day: number) => `Day ${day}`,
  trialEnded: "Trial ended",
  paidTag: "Paid",
  partly: (paidSatang: number, priceSatang: number) => `${formatBaht(paidSatang)} of ${formatBaht(priceSatang)}`,
  notYet: "Not yet",
  active: { yes: "Yes", no: "No", not_yet: "Not yet" },
  noDecision: "None yet",

  // Recording the shop's payment to Manut AI
  formTitle: "Record a subscription payment",
  formHint:
    "The shop paying Manut AI, not a customer's order. Record it only after you see the money arrive in Manut AI's bank account. A slip photo alone is not proof.",
  shopLabel: "Shop",
  amountLabel: "Amount in baht",
  slipLabel: "Slip reference",
  slipHelp: "The reference number printed on the bank slip. Each slip is recorded once.",
  noteLabel: "Note (optional)",
  submit: "Record payment",
  submitting: "Recording",
  badAmount: "Write the amount in baht, like 499 or 499.50.",
  noSlip: "Write the reference printed on the slip.",
  recorded: (amountSatang: number, shop: string, slipRef: string) =>
    `Recorded ${formatBaht(amountSatang)} from ${shop}, slip ${slipRef}.`,
  alreadyRecorded: (shop: string) => `This slip is already recorded for ${shop}. Nothing was recorded again.`,
  listTitle: (shop: string) => `${shop}'s payments to Manut AI`,
  newestFirst: "Newest first",
  listLoading: "Loading payments",
  listEmpty: "None recorded yet.",
  listItem: (amountSatang: number, slipRef: string) => `${formatBaht(amountSatang)}, slip ${slipRef}`,
  listWhen: (iso: string, now: number = Date.now()) => `Recorded ${formatStamp(iso, now)}.`,
} as const;

/// The Audit page: one shop's audit log (docs/pilot-api.md, "Audit log"), newest first. Each entry reads as one
/// sentence, who and then what, with its outcome as a tag; under it, when, and the ids it is about for looking the
/// records up. A code this console does not know yet is shown as it is, never dropped.
export const auditWords = {
  nav: "Audit",
  title: "Audit",
  intro:
    "Who did what for this shop, and when, newest first. The log keeps who and what only: never a customer's words, a reply's text or a key.",
  shopLabel: "Shop",
  refresh: "Refresh",
  tryAgain: "Try again",
  anotherKey: "Enter another key",
  loading: "Loading the audit log",
  empty: "Nothing recorded for this shop yet.",
  noShops: "No shops yet.",
  older: "Show older entries",
  loadingOlder: "Loading older entries",
  listLabel: (shop: string) => `${shop}'s audit log`,
  unavailable: "The API could not read the audit log. Try again.",
  /// The API counts every entry it could not write, so a gap is never read as nothing having happened.
  missed: (missed: AuditMissed, now: number = Date.now()) =>
    `${missed.count} ${missed.count === 1 ? "entry" : "entries"} could not be written, so this log is not complete. The last was at ${formatStamp(missed.lastAt, now)} (${missed.lastAction}).`,
} as const;

/// Who did it, the way an operator knows them: an operator by their Access email, the owner by name.
export function auditActorText(actor: AuditActor, ownerName: string): string {
  switch (actor.kind) {
    case "operator":
      return actor.email ?? "An operator (no Access identity)";
    case "owner":
      return actor.id ? `${ownerName} (${actor.id})` : ownerName;
    case "helper":
      return `Helper ${actor.id}`;
    case "worker":
      return `Worker attempt ${actor.attemptId.slice(0, 8)}`;
    case "system":
      return "Manut AI";
    default:
      return "Someone";
  }
}

const amountOf = (entry: AuditEntry) => (entry.amountSatang === undefined ? "" : ` of ${formatBaht(entry.amountSatang)}`);

/// What each action did, said after who did it.
const AUDIT_ACTIONS: Readonly<Record<string, (entry: AuditEntry) => string>> = {
  "shop.created": () => "created the shop",
  "line.connected": (entry) =>
    entry.subject.previousConnectionId ? "connected a new LINE account in place of the old one" : "connected the shop's LINE account",
  "reply.proposed": () => "proposed a reply",
  "payment.recorded": (entry) => `recorded an order payment${amountOf(entry)}`,
  "subscription_payment.recorded": (entry) => `recorded a subscription payment${amountOf(entry)}`,
  "model.cap_set": (entry) =>
    `set the monthly model cap${entry.amountSatang === undefined ? "" : ` to ${formatBaht(entry.amountSatang)}`}`,
  "model.cap_cleared": () => "cleared the model cap, so the default applies again",
  "deletion.requested": () => "asked to delete the shop's data",
  "reply.decided": () => "decided a reply",
  "deletion.decided": () => "answered the request to delete the shop's data",
  "consent.given": () => "allowed Manut AI to send for the shop",
  "consent.withdrawn": () => "withdrew permission to send for the shop",
  "dispatch.started": () => "started sending an approved action",
  "dispatch.settled": () => "finished sending an approved action",
  "attempt.started": () => "started a worker attempt",
  "attempt.ended": (entry) => (entry.actor.kind === "worker" ? "finished its attempt" : "ended a worker attempt"),
  "approval.requested": () => "asked for approval of an action",
  "approval.decided": () => "decided an approval request",
  "approval.superseded": () => "closed an approval request",
};

/// The entry as one sentence: "ops@manut.test recorded an order payment of ฿1,290."
export function auditSentence(entry: AuditEntry, ownerName: string): string {
  const said = Object.hasOwn(AUDIT_ACTIONS, entry.action) ? AUDIT_ACTIONS[entry.action]!(entry) : `did ${entry.action}`;
  return `${auditActorText(entry.actor, ownerName)} ${said}.`;
}

/// The outcome as a tag, or nothing for an action simply done as asked.
export function auditOutcomeTag(outcome: string, ownerName: string): { label: string; className: string } | null {
  switch (outcome) {
    case "ok":
      return null;
    case "approved":
      return { label: "Approved", className: "tag ok" };
    case "declined":
      return { label: "Declined", className: "tag" };
    case "refused":
      return { label: "Refused", className: "tag warn" };
    case "awaiting_owner":
      return { label: `Waiting for ${ownerName}`, className: "tag warn" };
    case "confirmed":
      return { label: "Sent", className: "tag ok" };
    case "failed":
      return { label: "Failed", className: "tag err" };
    case "unknown":
      return { label: "Not sure it was sent", className: "tag warn" };
    case "done":
      return { label: "Done", className: "tag ok" };
    case "cancelled":
      return { label: "Cancelled", className: "tag" };
    case "superseded":
      return { label: "No longer open", className: "tag" };
    default:
      return { label: outcome, className: "tag" };
  }
}

/// Why, for an attempt that ended or a decision that was refused.
const AUDIT_REASONS: Readonly<Record<string, string>> = {
  budget: "The shop's model budget ran out.",
  silent: "The worker stopped reporting.",
  deadline: "The attempt ran out of time.",
  attempt_ended: "Its attempt had already ended.",
  turn_ended: "Its turn had already ended.",
  withdrawn: "It had been taken back.",
  already_decided: "It was already decided.",
  not_permitted: "That role may not decide it.",
  expired: "It had expired.",
  changed: "It had changed since it was shown.",
  not_offered: "That choice was not offered.",
  not_found: "There was no such request.",
};

export function auditReasonText(reason: string): string {
  return Object.hasOwn(AUDIT_REASONS, reason) ? AUDIT_REASONS[reason]! : `Reason: ${reason}.`;
}

/// The ids an entry is about, in one order whatever order they came in. A worker's request shares its action's id,
/// so the id is listed once, as the action.
const SUBJECT_LABELS: readonly (readonly [string, string])[] = [
  ["taskId", "task"],
  ["attemptId", "attempt"],
  ["requestId", "request"],
  ["actionId", "action"],
  ["messageId", "message"],
  ["paymentId", "payment"],
  ["connectionId", "LINE connection"],
  ["previousConnectionId", "replacing"],
  ["confirmationId", "confirmation"],
];

export function auditSubjectText(subject: Record<string, string>): string {
  const known = new Set(SUBJECT_LABELS.map(([key]) => key));
  const parts = SUBJECT_LABELS.flatMap(([key, label]) => {
    const id = subject[key];
    if (!id || (key === "requestId" && subject.actionId === id)) return [];
    return [`${label} ${id}`];
  });
  for (const [key, id] of Object.entries(subject)) if (!known.has(key) && id) parts.push(`${key} ${id}`);
  return parts.join(" · ");
}

/// What the API said to recording a subscription payment that recorded nothing.
export function subscriptionErrorText(error: unknown, shop: string): string {
  if (error instanceof ApiError && error.code === "slip_already_recorded") return gateWords.alreadyRecorded(shop);
  return errorText(error);
}

/// The Model spend page: one shop's model spend for one Bangkok month against its monthly cap (docs/model-gateway.md,
/// "Operator routes"). Money is whole satang, written with `formatMoney` and read with `parseMoney` from @manut/format and
/// never through a float. Spend is shown as the API rounds it, up, and what is left rounded down, so the page never shows
/// a shop more room than it has. Sentences that hold a figure or a name are functions.

const UNKNOWN_AMOUNT = "unknown";
const NO_IDENTITY = "an operator (no Access identity)";

/// An amount of satang as baht: ฿186, ฿113.41. A figure that is not a whole, non-negative number of satang, which the API
/// never sends, is shown as "unknown" rather than crashing the page or showing a wrong amount.
export function moneyText(satang: number): string {
  return Number.isSafeInteger(satang) && satang >= 0 ? formatMoney(satang) : UNKNOWN_AMOUNT;
}

export type SpendLevel = "empty" | "ok" | "half" | "cap";

/// Where a month stands against the cap. At the cap when nothing is left, however it came about: spend, calls in progress,
/// a cap lowered under the spend, or a zero cap. Over half when spend and holds together are more than half of it. Empty
/// when nothing was spent, held, called or refused; a failed call costs nothing but still means calls were made.
export function spendLevel(usage: ModelUsage): SpendLevel {
  if (usage.remainingSatang === 0) return "cap";
  const { ok, failed, unreadable, abandoned, refused } = usage.counts;
  if (usage.spentSatang === 0 && usage.heldSatang === 0 && ok + failed + unreadable + abandoned + refused === 0) {
    return "empty";
  }
  return (usage.spentSatang + usage.heldSatang) * 2 > usage.capSatang ? "half" : "ok";
}

/// Whole percent of the cap that spend and holds take, rounded down and never past 100. The remainder is taken first,
/// so the division is exact. A zero cap is all used.
export function percentUsed(usage: ModelUsage): number {
  if (usage.capSatang <= 0) return 100;
  const scaled = (usage.spentSatang + usage.heldSatang) * 100;
  const percent = (scaled - (scaled % usage.capSatang)) / usage.capSatang;
  return percent > 100 ? 100 : percent;
}

const MONTH = /^(\d{4})-(0[1-9]|1[0-2])$/;
const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October",
  "November", "December"] as const;

/// "2026-11" as "November 2026"; anything that is not a month is shown as it is.
export function monthName(month: string): string {
  const match = MONTH.exec(month);
  return match ? `${MONTH_NAMES[Number(match[2]) - 1]} ${match[1]}` : month;
}

/// The `count` months before `month`, newest first: 2026-02 gives 2026-01, 2025-12, 2025-11.
export function monthsBack(month: string, count: number): string[] {
  const match = MONTH.exec(month);
  if (!match) return [];
  const index = Number(match[1]) * 12 + Number(match[2]) - 1;
  return Array.from({ length: count }, (_, i) => {
    const earlier = index - (i + 1);
    return `${String(Math.floor(earlier / 12)).padStart(4, "0")}-${String((earlier % 12) + 1).padStart(2, "0")}`;
  });
}

/// How one call ended, as a tag. A code this console does not know yet is shown as it is, never dropped.
export function callOutcomeTag(outcome: string): { label: string; className: string } {
  switch (outcome) {
    case "ok":
      return { label: "Done", className: "tag ok" };
    case "failed":
      return { label: "Failed, not charged", className: "tag" };
    case "unreadable":
      return { label: "Worst case charged", className: "tag warn" };
    case "abandoned":
      return { label: "Never finished, worst case charged", className: "tag warn" };
    default:
      return { label: outcome, className: "tag" };
  }
}

/// What went wrong with one of the two model routes. `write` is setting or clearing a cap, where a 503 `meter_unavailable`
/// does not say whether the cap was written, so the words say so. Anything else is the console's usual words.
export function modelErrorText(error: unknown, action: "read" | "write"): string {
  if (error instanceof ApiError) {
    if (error.code === "not_configured") return modelSpendWords.notConfigured(error.setting);
    if (error.code === "meter_unavailable") {
      return action === "read" ? modelSpendWords.unavailable : modelSpendWords.capUnconfirmed;
    }
  }
  return errorText(error);
}

export const modelSpendWords = {
  nav: "Model spend",
  title: "Model spend",
  intro:
    "What each shop's AI team has spent on language models in a month, against the shop's monthly cap. Every call is priced and held against the cap before it is made, and a call that would pass the cap is refused. Spend is shown rounded up and what is left rounded down, so a shop never looks to have more room than it has.",
  shopLabel: "Shop",
  monthLabel: "Month",
  thisMonth: "This month",
  refresh: "Refresh",
  tryAgain: "Try again",
  anotherKey: "Enter another key",
  loading: "Loading model spend",
  noShops: "No shops yet.",
  /// The API names the setting it cannot read: a model setting it was given that is not a whole number, or one it needs.
  notConfigured: (setting?: string) =>
    `The model gateway is not set up: ${setting ? `the API setting ${setting}` : "one of the API's model settings"} is missing or cannot be read. Ask whoever deploys the API to fix it, then try again.`,
  unavailable: "The API could not read this shop's model meter, so no spend is shown. Try again.",
  capUnconfirmed: "The API could not confirm the cap, so it may not have changed. Check the cap shown, then try again.",

  // Where the month stands
  level: {
    empty: { label: "No spend yet", className: "tag" },
    ok: { label: "Under half of the cap", className: "tag ok" },
    half: { label: "Over half of the cap", className: "tag warn" },
    cap: { label: "At the cap", className: "tag err" },
  } satisfies Record<SpendLevel, { label: string; className: string }>,
  usedText: (percent: number) => `${percent}% of the cap is used`,
  emptyText: (month: string, current: boolean) =>
    current ? "No model calls yet this month." : `No model calls in ${monthName(month)}.`,
  atCapText: (current: boolean, capSatang: number) =>
    capSatang === 0
      ? `The cap is ${moneyText(0)}, so every call is refused.`
      : current
        ? "New calls are refused until the cap is raised or the month turns."
        : "That month's spend and holds reached the cap.",
  /// The API keeps one cap per shop, not one per month, so an earlier month is read against the cap as it is now.
  pastNote:
    "The cap and what is left use the shop's cap as it is now. The API does not keep what the cap was in an earlier month.",

  // The four figures
  spentLabel: "Spent",
  spentHelp: (tokens: { input: number; output: number }) =>
    `${tokens.input.toLocaleString("en-US")} tokens in, ${tokens.output.toLocaleString("en-US")} out.`,
  heldLabel: "Held for calls in progress",
  heldHelp: (count: number | null) =>
    count === null
      ? "Calls in progress, counted at their worst case."
      : count === 0
        ? "No calls in progress."
        : `${count} ${count === 1 ? "call" : "calls"} in progress, counted at ${count === 1 ? "its" : "their"} worst case.`,
  leftLabel: "Left",
  leftHelp: "The cap less what is spent and held.",
  capLabel: "Monthly cap",
  capSource: (usage: Pick<ModelUsage, "capSource" | "capOverride">, now: number = Date.now()) => {
    if (usage.capSource !== "override") return "The default. No operator has set one for this shop.";
    const set = usage.capOverride;
    return set ? `Set by ${set.setBy ?? NO_IDENTITY}${whenAfter(set.setAt, now)}.` : "Set by an operator.";
  },

  // The calls
  callsText: (counts: ModelCounts) =>
    `${countOf(counts.ok + counts.failed + counts.unreadable + counts.abandoned, "call", "calls")} made, ${counts.refused.toLocaleString("en-US")} refused at the cap.`,
  /// What became of the calls that did not simply finish, naming what each one cost; empty when every call finished.
  outcomesText: (counts: ModelCounts) => {
    const parts: string[] = [];
    if (counts.failed) parts.push(`${counts.failed.toLocaleString("en-US")} failed (not charged)`);
    if (counts.unreadable) {
      parts.push(`${counts.unreadable.toLocaleString("en-US")} answered without a usable token count (charged at the worst case)`);
    }
    if (counts.abandoned) parts.push(`${counts.abandoned.toLocaleString("en-US")} never finished (charged at the worst case)`);
    return parts.length === 0 ? "" : `Of these, ${listOf(parts)}.`;
  },
  callsTitle: "Calls",
  callsLabel: (shop: string, month: string) => `${shop}'s model calls in ${monthName(month)}`,
  columns: { when: "When", model: "Model", tokens: "Tokens", cost: "Cost", outcome: "How it ended" },
  tokensText: (input: number, output: number) =>
    `${input.toLocaleString("en-US")} in, ${output.toLocaleString("en-US")} out`,
  /// The API lists a month's newest 200 records. Refused calls have no record, so only calls made count against the list.
  newestNote: (shown: number, counts: ModelCounts) => {
    const made = counts.ok + counts.failed + counts.unreadable + counts.abandoned;
    return shown < made ? `Showing the newest ${shown.toLocaleString("en-US")} of ${made.toLocaleString("en-US")} calls.` : null;
  },
  roundingNote:
    "Each cost is rounded up to a whole satang, so the rows can add up to a little more than the month's spend.",

  // Changing the cap
  formTitle: "Change the cap",
  capInputLabel: "New monthly cap in baht",
  capInputHelp: `Like 300 or 300.50, up to ${moneyText(MODEL_CAP_MAX_SATANG)}. A new cap applies from the next call; calls already in progress keep the budget they hold.`,
  setButton: "Set cap",
  setting: "Setting",
  clearButton: "Use the default cap",
  clearing: "Clearing",
  clearHelp: (hasOverride: boolean) =>
    hasOverride ? "Removes this shop's own cap, so the default applies again." : "This shop already uses the default cap.",
  badCap: "Write the cap in baht, like 300 or 300.50. It must be more than ฿0.",
  tooBigCap: `The cap can be at most ${moneyText(MODEL_CAP_MAX_SATANG)}.`,
  /// The cap as the API's answer says it now stands, so what the page confirms is what was written, not what was typed.
  capAnswer: (shop: string, answer: ModelCap, now: number = Date.now()) => {
    const cap = moneyText(answer.capSatang);
    if (answer.capSource !== "override") return `The cap for ${shop} is now ${cap}, the default. The override is cleared.`;
    const set = answer.capOverride;
    const by = set ? `, set by ${set.setBy ?? NO_IDENTITY}${whenAfter(set.setAt, now)}` : "";
    return `The cap for ${shop} is now ${cap}${by}. It applies from the next call; calls already in progress keep the budget they hold.`;
  },
} as const;

/// " at 10:00" or " on 23 November at 10:00", or nothing for a time that is not one.
function whenAfter(iso: string, now: number): string {
  return Number.isNaN(Date.parse(iso)) ? "" : ` ${whenText(iso, now)}`;
}

/// "at 10:00" today, "on 23 November at 10:00" on any other day of the shop's calendar.
function whenText(iso: string, now: number): string {
  const clock = formatClock(iso);
  return dayOffset(iso, now) === 0 ? `at ${clock}` : `on ${formatDate(iso)} at ${clock}`;
}

function countOf(n: number, one: string, many: string): string {
  return `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;
}

/// "a, b and c", without the serial comma, as the canvas writes lists.
function listOf(parts: string[]): string {
  if (parts.length <= 1) return parts.join("");
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}
