// The asks before an artifact link is published or removed (item 83). A link can be opened by anyone who has it, so publishing
// one is asked first, every time, as approval-core's kind `public_post`, which only the owner may decide; removing one cannot be
// undone, so it is asked too, as kind `command` (it changes the shop's own records). Each ask is opened here as an approval-core
// request whose detail is exactly what it shows: the shop, the title, the kind, the size and, for a publish, the text itself.
//
// approval-core settles each request once (`packages/approval-core`: a request leaves waiting once, only an option it offered can
// be chosen, an id is never reused). The runtime's `artifacts.publish` and `artifacts.remove` take nothing but an ask's id, and
// `takeSettled` hands them the ask's own detail only when approval-core settled it with a yes, and only once: an ask declined,
// withdrawn, expired, still waiting or already used publishes nothing. So there is no other way to a public link from this app.
// An agent that asks to share a file is shown this same ask, with the file's text in it, and nothing is published until the
// person says yes to that.
//
// On this Mac the person is the owner of the shop whose links they manage: the runtime refuses a shop they only help at before
// anything is asked.
import { InMemoryApprovalStore, type ApprovalOption, type ApprovalRecord } from "@manut/approval-core";
import type { RemovePlan, SharePlan } from "./artifacts";

/** What every ask offers: yes, this once, or no. approval-core has no standing yes, so neither does the ask. */
export const ARTIFACT_OPTIONS: readonly ApprovalOption[] = [
  { id: "yes", label: "yes", effect: "approve" },
  { id: "no", label: "no", effect: "decline" },
];

/** Who decides on this Mac, as approval-core records it. */
export const DECIDED_BY = "this-mac";

/** How long an ask waits for its answer. One left open longer is refused as expired and asked again. */
export const ASK_WAITS_MS = 15 * 60 * 1000;

type Detail = { what: "publish"; plan: SharePlan } | { what: "remove"; plan: RemovePlan };

let clock: () => number = () => Date.now();
let store = new InMemoryApprovalStore({ now: () => clock() });
/** The asks a runtime has already acted on. An ask is used once, whatever came of the request it allowed. */
let spent = new Set<string>();
let seq = 0;

/** Tests: start from no asks, with a clock of their own. */
export function resetArtifactAsks(now: () => number = () => Date.now()): void {
  clock = now;
  store = new InMemoryApprovalStore({ now: () => clock() });
  spent = new Set();
}

async function open(kind: "public_post" | "command", detail: Detail): Promise<string> {
  const id = `artifact-${detail.what}-${clock().toString(36)}-${(seq += 1)}`;
  const opened = await store.open({ id, kind, options: ARTIFACT_OPTIONS, detail, expiresAt: clock() + ASK_WAITS_MS });
  if (!opened.ok) throw new Error(opened.refused);
  return id;
}

/** Opens the ask to publish `plan`, and answers its id. Nothing is sent. */
export const askToShare = (plan: SharePlan): Promise<string> => open("public_post", { what: "publish", plan: { ...plan } });

/** Opens the ask to remove the link `plan` names, and answers its id. Nothing is sent. */
export const askToRemove = (plan: RemovePlan): Promise<string> => open("command", { what: "remove", plan: { ...plan } });

/** What answering an ask did: settled with a yes or a no, or refused by approval-core (`already_decided`, `expired`, `not_found`...),
 *  when nothing may follow it. */
export type ArtifactAnswer = { ok: true; yes: boolean } | { ok: false; refused: string };

/** The person's Yes or No to ask `id`, settled by approval-core's rules. Sends nothing: on a yes, the page then asks the runtime to
 *  act on the ask by its id. */
export async function answerArtifactAsk(id: string, yes: boolean): Promise<ArtifactAnswer> {
  const decided = await store.decide({ requestId: id, optionId: yes ? "yes" : "no", seenRevision: 1, decidedBy: DECIDED_BY, role: "owner" },
    { running: {} });
  return decided.ok ? { ok: true, yes } : { ok: false, refused: decided.refused };
}

/** Takes back a waiting ask (the person closed it, or chose another file), so a later answer settles nothing. */
export async function withdrawArtifactAsk(id: string): Promise<void> {
  await store.withdraw(id);
}

/** Where ask `id` stands in approval-core (tests, and a surface that wants to know before it draws its buttons). */
export function artifactAskRecord(id: string): Promise<ApprovalRecord | undefined> {
  return store.get(id);
}

/** The plan ask `id` allows, for the one runtime op that acts on it: its own detail, when approval-core settled it with a yes, it is an
 *  ask of this kind, and it was not used before. It is then used, so a second call answers null whatever the first one did. */
export async function takeSettled(id: unknown, what: "publish"): Promise<SharePlan | null>;
export async function takeSettled(id: unknown, what: "remove"): Promise<RemovePlan | null>;
export async function takeSettled(id: unknown, what: "publish" | "remove"): Promise<SharePlan | RemovePlan | null> {
  if (typeof id !== "string") return null;
  const record = await store.get(id);
  // From here to the end nothing waits, so two calls for one ask cannot both find it unused.
  if (!record || record.status !== "decided" || spent.has(id)) return null;
  const chosen = record.request.options.find((option) => option.id === record.decision.optionId);
  const detail = record.request.detail as Detail | undefined;
  if (chosen?.effect !== "approve" || detail?.what !== what) return null;
  if (record.request.kind !== (what === "publish" ? "public_post" : "command")) return null;
  spent.add(id);
  return detail.plan;
}
