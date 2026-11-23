import {
  ApiError,
  type ApprovalState,
  type DeletedShop,
  type DeletionRequest,
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
