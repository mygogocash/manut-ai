/// Buddy's chat with the shop's owner on the API (docs/connected-chat.md, A; docs/pilot-api.md, "Chat"): the one route that
/// makes a model call from outside the Worker's own code, and the owner's reads and deletion of what it kept.
///
/// - `POST /v1/chat/messages` with `{ thread?, text, note?, sentOnFrom? }`: one message to Buddy, answered by one call through
///   the model gateway (model-gateway.ts, `callModel`), priced, held against the shop's monthly cap and settled at what the
///   provider bills, exactly as a worker's call is. The model gateway's rule was that no route makes a model call, because a
///   route would let anyone holding the operator key spend from outside. This route keeps what that rule protected: only the
///   shop's owner, from their own session, spends, only on their own shop, inside its own cap, and the operator key, a helper,
///   a link and an outpost are each refused before the gateway is asked. Its own switch (`buddyChat`) is off by default.
/// - `GET /v1/chat/threads`, `GET /v1/chat/threads/{id}` and `POST /v1/chat/threads/remove` with `{ id }`: the owner's
///   threads, one thread's messages a page at a time, and the owner's deletion of a thread (a POST with a JSON body, as the
///   owner's other changes are, Forget and an artifact link's removal among them). These stay open with the switch off: the
///   owner can always read and delete what was kept.
///
/// Buddy only talks. Nothing here starts a task, a dispatch or a decision, or sends, posts, pays or deletes anything of
/// the shop's: the route's only writes are the chat's own records and the gateway's ledger, and its imports name no module
/// that reaches a task or an approval. Anything that acts stays where it is, in the team's job flow and its approvals
/// (`packages/approval-core`). A message that says "Approve the reply" is words to Buddy and nothing else.
///
/// What reaches the model is built by @manut/agent-prompts (`buildBuddyChat`): Buddy's short instructions, the shop's
/// usable facts fenced and marked (a customer's words as a customer's, never instructions), the thread's latest turns and
/// the owner's message, all masked by the app's one masker. The owner's message and Buddy's answer are kept masked too, so
/// a key the owner pastes is never kept or sent. Nothing about a message is logged, and the audit log names only ids.
///
/// Manut AI's own lines are fields of the request, never part of the owner's words (item 102l-5). `note` is Manut AI's note
/// to Buddy for this one message (which conversations Buddy may reach, and that the note is not the owner speaking): it is
/// accepted only as a whole note, given to the model after the words and never kept, so the record says only `noted: true`.
/// `sentOnFrom` is the title of the conversation whose words Buddy wrote there and the owner sent on to this one: the
/// model is given the mark after those words, and, because it is kept on the message, in every later turn too, so words
/// that came from another conversation never read as the owner speaking (rule R10 of docs/several-agents.md). The kept
/// text, the thread's title and the export hold the owner's words alone.

import { buildBuddyChat } from "@manut/agent-prompts";
// The app's one masker for keys (item 113 and item 121), the package the desktop and its shell's twin read too, so a key is
// masked the same way on every surface.
import { maskSecrets } from "@manut/mask-secrets";
import { emptyState } from "@manut/shop-memory";
import { readJsonBody } from "./body";
import {
  isSentOnFrom,
  MAX_ANSWER_CHARS,
  MAX_FROM_CHARS,
  MAX_TEXT_CHARS,
  MESSAGE_ID,
  PAGE_MAX,
  THREAD_ID,
  type MessageView,
  type ThreadView,
} from "./chat-store";
import { usableFacts } from "./memory";
import { callModel, type ModelCallResult, type ModelGatewayEnv } from "./model-gateway";
import type { ModelProvider } from "./model-provider";
import { callerOf, hasExactly, ownerActor, queryNamesSession, readShop, type Caller, type PeopleEnv } from "./people";
import { tenantCall } from "./tenant-data";

export type ChatEnv = PeopleEnv & ModelGatewayEnv;
export type ChatFlags = () => Promise<{ buddyChat: boolean }>;
/// The gateway's call and the clock, for tests, as `callModel` takes them. The Worker passes neither.
export type ChatOptions = { provider?: ModelProvider; now?: () => number };

/// Buddy's model on the API: the gateway's cheapest (docs/model-gateway.md, "The price table").
export const CHAT_MODEL = "claude-haiku-5-5";
/// A chat answer is a few short sentences; this is room for a long one, and what the gateway holds for it.
export const CHAT_MAX_OUTPUT_TOKENS = 1_024;

export const CHAT_MESSAGES_PATH = "/v1/chat/messages";
export const CHAT_THREADS_PATH = "/v1/chat/threads";
export const CHAT_REMOVE_PATH = "/v1/chat/threads/remove";
const THREAD_PATH = /^\/v1\/chat\/threads\/([^/]+)$/;
/// The words are at most MAX_TEXT_CHARS characters, a note at most NOTE_MAX_CHARS and a title MAX_FROM_CHARS, and JSON can
/// write one character as six bytes: 8,000, 2,000 and 120 of them come to 60,720 bytes, so the three fit with the rest.
const MAX_BODY_BYTES = 64 * 1024;
/// The keys a message may carry: `text` always, and any of the others.
const MESSAGE_KEYS = ["thread", "text", "note", "sentOnFrom"];
/// The first line of a whole note starts with this, and its last line is exactly the end line: the lines Manut AI writes
/// (the desktop's `buddyNote`, apps/desktop/src/jobs/reachMarks.ts). No other line may begin a second note, a mark, or any
/// line that says Manut AI wrote it, so a note is one whole note and nothing else.
const NOTE_HEAD = "[Manut AI: a note to Buddy]";
const NOTE_END = "[End of the Manut AI note]";
const NOTE_LINE = "[Manut AI:";
/// The longest note, in characters (code points). The desktop's own is shorter (1,900).
export const NOTE_MAX_CHARS = 2_000;
/// Every way a reader could take a line to end: the line feed, the carriage return and the two together, the vertical tab
/// and form feed, the next line character, and the line and paragraph separators.
const LINE_BREAK = /\r\n|[\n\r\v\f\u0085\u2028\u2029]/;
/// What the shop's object answers to a chat write it understood. Anything else is the object failing.
const ANSWERED = new Set([200, 404, 409, 429]);
/// Every chat answer holds the owner's words or Buddy's, so no browser or proxy keeps a copy.
const NO_STORE = { "cache-control": "no-store" };

function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return Response.json(data, { status, headers: { ...NO_STORE, ...headers } });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/// Whether `note` is one whole note: text of at most NOTE_MAX_CHARS characters whose first line starts with NOTE_HEAD, whose
/// last line is exactly NOTE_END, and with no line between that starts with `[Manut AI:` or is the end line (leading blanks
/// do not hide either). Anything else is refused, so what rides with a message is never more or less than a note.
function isWholeNote(note: unknown): note is string {
  if (typeof note !== "string" || [...note].length > NOTE_MAX_CHARS) return false;
  const lines = note.split(LINE_BREAK);
  if (lines.length < 2 || !lines[0]!.startsWith(NOTE_HEAD) || lines[lines.length - 1] !== NOTE_END) return false;
  return lines.slice(1, -1).every((line) => !line.trimStart().startsWith(NOTE_LINE) && line.trim() !== NOTE_END);
}

/// The title of the conversation a message was sent on from, as it is kept and given to the model: the request's own title
/// trimmed, checked (`isSentOnFrom`: 1 to MAX_FROM_CHARS characters, one line, no double quote), masked by the app's one
/// masker, and cut to MAX_FROM_CHARS again, since a mask can be longer than what it hides. Null for a title that is none, so
/// the request is refused before anything is counted or called.
function sentOnFromOf(value: unknown): string | null {
  if (typeof value !== "string" || !isSentOnFrom(value.trim())) return null;
  const masked = [...maskSecrets(value.trim())].slice(0, MAX_FROM_CHARS).join("").trim();
  return isSentOnFrom(masked) ? masked : null;
}

function chatWrite(env: Pick<ChatEnv, "TENANT">, tenant: string, path: string, body: Record<string, unknown>): Promise<Response> {
  return tenantCall(env, tenant, path, {
    method: "POST",
    headers: { "content-type": "application/json", "x-chat": "1" },
    body: JSON.stringify({ tenant, ...body }),
  });
}

/// Whether the shop has the owner's consent to cloud work: the record job-flow.ts's `consented` reads, read here so the
/// chat's imports name nothing of the job flow. What goes to the model holds the shop's facts and a customer's words, so it
/// needs the consent the team's work needs.
async function shopConsented(env: Pick<ChatEnv, "TENANT">, tenant: string): Promise<boolean | null> {
  const response = await tenantCall(env, tenant, `/consent?tenant=${encodeURIComponent(tenant)}`).catch(() => null);
  if (!response?.ok) {
    await response?.body?.cancel();
    return null;
  }
  const record = (await response.json().catch(() => null)) as { cloudWork?: unknown } | null;
  return record?.cloudWork === true;
}

/// `/v1/chat/*`. Answers null for any other path. Every route keeps the order the owner's routes keep: who is asking (401
/// or 503), the role (403 `owner_only`), the method (405), the query and the body (400 or 413), then for a message the
/// switch (403 `feature_disabled`), and only then the shop's record (404 for a person's own sign-in, which is no shop), so
/// nothing is read, counted or sent for a request any of those refuse.
export async function chatRoute(request: Request, url: URL, env: ChatEnv, flags: ChatFlags, options: ChatOptions = {}):
  Promise<Response | null> {
  if (url.pathname !== "/v1/chat" && !url.pathname.startsWith("/v1/chat/")) return null;
  const removing = url.pathname === CHAT_REMOVE_PATH;
  const threadMatch = removing ? null : THREAD_PATH.exec(url.pathname);
  if (url.pathname !== CHAT_MESSAGES_PATH && url.pathname !== CHAT_THREADS_PATH && !removing && !threadMatch) {
    return json({ error: "not_found" }, 404);
  }
  const caller = await callerOf(request, env);
  if (caller instanceof Response) return caller;
  if (caller.role !== "owner") return json({ error: "owner_only" }, 403);
  if (url.pathname === CHAT_MESSAGES_PATH) return sendMessage(request, url, env, flags, caller, options);
  if (url.pathname === CHAT_THREADS_PATH) return listThreads(request, url, env, caller.shop);
  if (removing) return removeThread(request, url, env, caller);
  return readThread(request, url, env, caller.shop, threadMatch![1]!);
}

type Owner = Extract<Caller, { role: "owner" }>;

/// The shop's record, for the routes that need it: null for a person's own sign-in, whose tenant is no shop (404), and a
/// refusal when the object cannot be read.
async function shopOf(env: ChatEnv, shop: string): Promise<{ name: string } | null | Response> {
  try {
    const record = await readShop(env, shop);
    return record ? { name: record.name } : null;
  } catch {
    return json({ error: "chat_unavailable" }, 503);
  }
}

/// `POST /v1/chat/messages` with `{ text }` or `{ thread, text }`, each with `note` and `sentOnFrom` if it has them. After
/// the checks every route makes: the switch, the shop, its consent and what the team knows; then the shop's object lets the
/// message through (the thread is there and has room, the hour has room) and counts it; then one call through the gateway;
/// then the exchange is kept. The request's own shape is checked first of all, so a note that is not a whole note and a title
/// that is none are refused before the switch, and nothing is counted or called for them.
async function sendMessage(request: Request, url: URL, env: ChatEnv, flags: ChatFlags, caller: Owner, options: ChatOptions):
  Promise<Response> {
  if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  if (queryNamesSession(url) || url.search !== "") return json({ error: "invalid_request" }, 400);
  const parsed = await readJsonBody<unknown>(request, MAX_BODY_BYTES);
  if (!parsed.ok) return json({ error: parsed.error }, parsed.status);
  const body = parsed.value;
  if (!isRecord(body) || !Object.keys(body).every((key) => MESSAGE_KEYS.includes(key)) || !("text" in body)) {
    return json({ error: "invalid_request" }, 400);
  }
  const thread = body.thread === undefined || body.thread === null ? null : body.thread;
  if (thread !== null && (typeof thread !== "string" || !THREAD_ID.test(thread))) return json({ error: "invalid_request" }, 400);
  // `note` and `sentOnFrom` are left out when there is none, never null: a field that is there must be a whole note, or a title.
  if (body.note !== undefined && !isWholeNote(body.note)) return json({ error: "invalid_request" }, 400);
  const sentOnFrom = body.sentOnFrom === undefined ? undefined : sentOnFromOf(body.sentOnFrom);
  if (sentOnFrom === null) return json({ error: "invalid_request" }, 400);
  if (typeof body.text !== "string" || body.text.trim() === "") return json({ error: "invalid_text" }, 400);
  const text = body.text.trim();
  if ([...text].length > MAX_TEXT_CHARS) return json({ error: "text_too_long", maxChars: MAX_TEXT_CHARS }, 400);
  if (!(await flags()).buddyChat) return json({ error: "feature_disabled", feature: "buddyChat" }, 403);

  const shop = await shopOf(env, caller.shop);
  if (shop instanceof Response) return shop;
  if (!shop) return json({ error: "not_found" }, 404);
  const consented = await shopConsented(env, caller.shop);
  if (consented === null) return json({ error: "chat_unavailable" }, 503);
  if (!consented) return json({ error: "consent_required" }, 403);
  const facts = await usableFacts(env, caller.shop);
  if (!facts.ok) return json({ error: "chat_unavailable" }, 503);

  const now = options.now ?? Date.now;
  const sentAtMs = now();
  const admitted = await chatWrite(env, caller.shop, "/chat/admit", { thread, nowMs: sentAtMs }).catch(() => null);
  if (!admitted || !ANSWERED.has(admitted.status)) {
    await admitted?.body?.cancel();
    return json({ error: "chat_unavailable" }, 503);
  }
  if (admitted.status !== 200) {
    const retryAfter = admitted.headers.get("retry-after");
    return json(await admitted.json(), admitted.status, retryAfter ? { "retry-after": retryAfter } : {});
  }
  const { history } = (await admitted.json()) as { history: { from: "owner" | "buddy"; text: string; sentOnFrom?: string }[] };
  const built = buildBuddyChat({
    shop: { name: shop.name },
    memory: { ...emptyState(), facts: facts.facts },
    history,
    newest: text,
    ...(sentOnFrom !== undefined ? { sentOnFrom } : {}),
    ...(body.note !== undefined ? { note: body.note } : {}),
    model: CHAT_MODEL,
    maxOutputTokens: CHAT_MAX_OUTPUT_TOKENS,
    mask: maskSecrets,
  });
  // The owner's message is capped far below the request's limit, so this is the builder refusing input it was never meant
  // to be given, not anything the owner did.
  if (!built.ok) return json({ error: "chat_unavailable" }, 503);
  const answered = await callModel(env, caller.shop, built.request, options);
  if (!answered.ok) return gatewayRefusal(answered);

  // What is kept of the message: the owner's words alone, masked, with the title of the conversation they were sent on from if
  // they were, and, if a note went with it, only that it did. The note is not kept anywhere.
  const kept = await chatWrite(env, caller.shop, "/chat/commit", {
    thread,
    owner: maskSecrets(text),
    ...(sentOnFrom !== undefined ? { sentOnFrom } : {}),
    ...(body.note !== undefined ? { noted: true } : {}),
    sentAtMs,
    answer: [...maskSecrets(answered.text)].slice(0, MAX_ANSWER_CHARS).join(""),
    stopReason: answered.stopReason,
    nowMs: Math.max(now(), sentAtMs),
    actor: ownerActor(caller),
  }).catch(() => null);
  if (!kept || !ANSWERED.has(kept.status)) {
    await kept?.body?.cancel();
    return json({ error: "chat_unavailable", callId: answered.callId }, 503);
  }
  // The thread went or filled while Buddy answered: the call is in the ledger, and the answer was not kept.
  if (kept.status !== 200) return json({ ...((await kept.json()) as object), callId: answered.callId }, kept.status);
  const exchange = (await kept.json()) as { thread: ThreadView; message: MessageView; answer: MessageView };
  return json({ ...exchange, costSatang: answered.costSatang });
}

/// The gateway's own answer when it made no call, or the call failed, in the shapes it gives them
/// (docs/model-gateway.md, "Calling a model from code"): 402 `budget_exceeded` with the month's figures, 403
/// `not_counted_in`, 503 `not_configured` naming the setting, 503 `meter_unavailable`, and 502 or 503 `provider_error`
/// with `retryable` and the call's id. A 400 can only be a request this route built wrongly, so it is the chat's failure.
function gatewayRefusal(result: Exclude<ModelCallResult, { ok: true }>): Response {
  if (result.status === 400) return json({ error: "chat_unavailable" }, 503);
  const { ok: _ok, status, ...answer } = result;
  return json(answer, status);
}

/// `GET /v1/chat/threads`: the shop's threads, newest first. There are at most 50, so there is no page.
async function listThreads(request: Request, url: URL, env: ChatEnv, tenant: string): Promise<Response> {
  if (request.method !== "GET") return json({ error: "method_not_allowed" }, 405);
  if (url.search !== "") return json({ error: "invalid_request" }, 400);
  const shop = await shopOf(env, tenant);
  if (shop instanceof Response) return shop;
  if (!shop) return json({ error: "not_found" }, 404);
  const response = await tenantCall(env, tenant, `/chat/threads?tenant=${encodeURIComponent(tenant)}`).catch(() => null);
  if (!response?.ok) {
    await response?.body?.cancel();
    return json({ error: "chat_unavailable" }, 503);
  }
  return json(await response.json());
}

/// `GET /v1/chat/threads/{id}[?before=&limit=]`: one thread and a page of its messages, oldest first, the newest page unless
/// `before` names the message it ends before.
async function readThread(request: Request, url: URL, env: ChatEnv, tenant: string, id: string): Promise<Response> {
  if (request.method !== "GET") return json({ error: "method_not_allowed" }, 405);
  const names = [...url.searchParams.keys()];
  const before = url.searchParams.get("before");
  const limit = url.searchParams.get("limit");
  if (queryNamesSession(url) || names.some((name) => name !== "before" && name !== "limit") ||
      new Set(names).size !== names.length || (before !== null && !MESSAGE_ID.test(before)) ||
      (limit !== null && (!/^\d{1,3}$/.test(limit) || Number(limit) < 1 || Number(limit) > PAGE_MAX))) {
    return json({ error: "invalid_request" }, 400);
  }
  const shop = await shopOf(env, tenant);
  if (shop instanceof Response) return shop;
  if (!shop) return json({ error: "not_found" }, 404);
  // An id of no thread's shape names no thread, and is answered as one that is gone.
  if (!THREAD_ID.test(id)) return json({ error: "thread_not_found" }, 404);
  const query = new URLSearchParams({ tenant, id });
  if (before !== null) query.set("before", before);
  if (limit !== null) query.set("limit", limit);
  return answered(await tenantCall(env, tenant, `/chat/thread?${query.toString()}`).catch(() => null));
}

/// `POST /v1/chat/threads/remove` with exactly `{ id }`: the owner's deletion of a thread, its record and every message at
/// once, with an audit entry naming the thread's id. Like Forget, it cannot be taken back, so the app asks before it sends.
async function removeThread(request: Request, url: URL, env: ChatEnv, caller: Owner): Promise<Response> {
  if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  if (url.search !== "") return json({ error: "invalid_request" }, 400);
  const parsed = await readJsonBody<unknown>(request, MAX_BODY_BYTES);
  if (!parsed.ok) return json({ error: parsed.error }, parsed.status);
  if (!isRecord(parsed.value) || !hasExactly(parsed.value, ["id"]) || typeof parsed.value.id !== "string" ||
      parsed.value.id.length === 0 || parsed.value.id.length > 64) {
    return json({ error: "invalid_request" }, 400);
  }
  const id = parsed.value.id;
  const shop = await shopOf(env, caller.shop);
  if (shop instanceof Response) return shop;
  if (!shop) return json({ error: "not_found" }, 404);
  if (!THREAD_ID.test(id)) return json({ error: "thread_not_found" }, 404);
  return answered(await chatWrite(env, caller.shop, "/chat/delete", { thread: id, actor: ownerActor(caller) })
    .catch(() => null));
}

/// What the shop's object answered to a read or a removal of one thread: the thread, or 404 `thread_not_found`. Anything
/// else is the object failing.
async function answered(response: Response | null): Promise<Response> {
  if (!response || (response.status !== 200 && response.status !== 404)) {
    await response?.body?.cancel();
    return json({ error: "chat_unavailable" }, 503);
  }
  return json(await response.json(), response.status);
}
