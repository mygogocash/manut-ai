import { MAX_FACTS, MAX_TEXT } from "@manut/shop-memory";
import {
  ApiError,
  type ApprovalState,
  type AuditActor,
  type AuditEntry,
  type AuditMissed,
  type DeletedShop,
  type DeletionRequest,
  type FactSource,
  type GateStatus,
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
  "memory.remembered": () => "told the team something to remember",
  "memory.proposed": () => "added something the team learned",
  "memory.confirmed": () => "confirmed a fact as true",
  "memory.corrected": () => "corrected a fact",
  "memory.forgotten": () => "made the team forget a fact",
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
  ["factId", "fact"],
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

/// The Memory page: what Buddy's team knows about one shop, laid out as the design canvas's "Customize: memory and
/// routines" board. The headings are the board's own words. The operator acts for the owner, so the words that say what
/// an action does name the owner, and a fact is never shown again once it is forgotten.
export const memoryWords = {
  nav: "Memory",
  title: "Memory",
  intro: (owner: string) =>
    `What Buddy's team knows about this shop, and where each fact came from. Correct or forget a fact only when ${owner} asks you to. What a customer said is not used until ${owner} says it is true.`,
  shopLabel: "Shop",
  refresh: "Refresh",
  tryAgain: "Try again",
  anotherKey: "Enter another key",
  loading: "Loading what the team knows",
  noShops: "No shops yet.",
  unavailable: "The API could not read what the team knows. Try again.",

  // The board's three groups
  knownTitle: "What your team knows",
  knownEmpty: "Nothing yet. Tell Buddy something to remember below.",
  knownCount: (n: number) => (n === 0 ? "No facts" : n === 1 ? "1 fact" : `${n.toLocaleString("en-US")} facts`),
  waitingTitle: "Waiting for your OK: not used until you confirm",
  waitingCount: (n: number) => `${n.toLocaleString("en-US")} waiting`,
  tellTitle: "Tell Buddy something to remember",

  // One fact
  sourceLabel: "Where it came from:",
  corrected: "Corrected",
  confirm: "It's true",
  correct: "Correct",
  forget: "Forget",
  correctLabel: "Corrected words",
  saveCorrection: "Save correction",
  saving: "Saving",
  cancel: "Cancel",
  forgetAsk: (owner: string) =>
    `Forget this fact? The team stops using it and will not learn it again unless ${owner} says it again.`,
  forgetYes: "Yes, forget it",
  forgetNo: "Keep it",
  forgottenNote: (n: number) =>
    n === 1
      ? "1 text was forgotten. Only a fingerprint of it is kept, so the team does not learn it again."
      : `${n.toLocaleString("en-US")} texts were forgotten. Only a fingerprint of each is kept, so the team does not learn them again.`,

  // Telling the team something new
  tellLabel: "What should the team remember?",
  tellHelp: (n: number) =>
    `${n.toLocaleString("en-US")} of ${MAX_TEXT} characters. The team uses it as soon as you save it.`,
  remember: "Remember this",

  // What an action did, and why one did not
  remembered: "Remembered.",
  confirmed: "Confirmed.",
  correctedDone: "Corrected.",
  forgotten: "Forgotten.",
  alreadyKnown: "The team already knows this: a fact says the same.",
  full: `The team already holds ${MAX_FACTS} facts. Forget one to make room.`,
  invalidText: `Write between 1 and ${MAX_TEXT} characters.`,
  gone: "That fact is already gone. The list was refreshed.",
  saveUnavailable: "The API could not read or save what the team knows. Try again.",
} as const;

const UNKNOWN_SOURCE = "From somewhere this console does not know yet";

/// A fact's source as the board says it: "From your price list, 3 November", "Learned from 12 of your edits", "From your
/// cost sheet in Google Sheets". It never fails on what it cannot read: a date that is not one is left out, and a kind
/// this console does not know yet is shown as it is.
export function factSourceText(source: FactSource, ownerName: string): string {
  if (typeof source !== "object" || source === null) return UNKNOWN_SOURCE;
  switch (source.kind) {
    case "owner":
      return `Told to the team by ${ownerName}`;
    case "document": {
      const date = new Date(source.date);
      return Number.isNaN(date.getTime()) ? `From ${source.name}` : `From ${source.name}, ${formatDate(date.toISOString())}`;
    }
    case "edits":
      return `Learned from ${source.count} of your edits`;
    case "orders":
      return `Learned from ${source.days} ${source.days === 1 ? "day" : "days"} of your orders`;
    case "connection": {
      const detail = source.detail.trim();
      return detail ? `From your ${detail} in ${source.name}` : `From ${source.name}`;
    }
    case "customer":
      return `A customer said it, in chat ${source.chat}`;
    default: {
      const kind: unknown = (source as { kind?: unknown }).kind;
      return typeof kind === "string" && kind ? `From ${kind}` : UNKNOWN_SOURCE;
    }
  }
}

/// What the API said to a change in the team's memory that changed nothing: its own refusals in the board's words, and
/// the console's usual words for the rest.
export function memoryErrorText(error: unknown): string {
  if (error instanceof ApiError && !isAuthError(error)) {
    switch (error.code) {
      case "already_known":
        return memoryWords.alreadyKnown;
      case "full":
        return memoryWords.full;
      case "invalid_text":
        return memoryWords.invalidText;
      case "not_found":
        return memoryWords.gone;
      case "memory_unavailable":
        return memoryWords.saveUnavailable;
    }
  }
  return errorText(error);
}
