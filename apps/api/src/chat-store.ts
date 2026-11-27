/// Buddy's chat with the shop's owner (docs/connected-chat.md, A; docs/pilot-api.md, "Chat"), kept in the shop's
/// TenantObject (`t:${tenant}`) beside its other records, so the tenant export reads it and every tenant wipe removes it.
/// The routes, the model call and the masking are chat.ts's: this file only keeps threads and messages, counts the shop's
/// messages in the hour, and records each change.
///
/// What is kept, per shop:
///
/// - `chat-threads:<tenant>`: the shop's threads, newest first, at most MAX_THREADS. Each knows its title (the owner's
///   first words), when it was made and last written, how many messages it holds and the number of its next message.
/// - `chat-msg:<tenant>:<thread>:<number>`: one record per message, the owner's or Buddy's, numbered from 1 in each thread
///   and never reused. A thread is many keys rather than one record because a Durable Object keeps a value of at most a
///   couple of megabytes, and a thread can hold MAX_THREAD_MESSAGES messages of up to 8,000 characters.
/// - `chat-hour:<tenant>`: when each of the last hour's messages was let through to the model gateway, at most
///   MESSAGES_PER_HOUR times.
///
/// Full is refused, never trimmed. A shop with MAX_THREADS threads is refused a new one (409 `threads_full`), and a thread
/// that cannot take two more messages is refused the next (409 `thread_full`): nothing the owner said is ever dropped to
/// make room, because deleting a conversation is the owner's to do (and the export promises what was said is kept until
/// then). The owner deletes a thread, or starts a new one.
///
/// Atomicity. As in memory-store.ts, each change runs in `transactionSync` with the synchronous KV API, so the checks, the
/// writes and the audit entry commit together and no other request runs in between. A message is let through (`admit`:
/// the thread is there and has room, and the hour has room, which is counted) before the model is called, and kept
/// (`commit`: both messages, the thread's record and the audit entry) only once the model has answered, so a refusal from
/// the gateway leaves nothing in the thread. The checks run again at the commit, since the owner may have deleted the
/// thread while Buddy answered.
///
/// What is never stored or logged. A message's words live only in its record and a thread's title in the thread's record;
/// the audit entries name the thread and the owner's message by their ids (audit-log.ts). chat.ts masks keys before any
/// text reaches here.
///
/// Only the Worker reaches these paths, and writes also need its `x-chat` header, the same defence in depth as
/// `x-memory` and `x-model`.

import { actorOr, auditPutSync, type AuditActor } from "./audit-log";
import { readJsonBody } from "./body";
import { isValidTenant } from "./companies";
import { keyPages, sortableId } from "./pilot-store";

/// The most threads a shop keeps, and messages a thread keeps, the owner's and Buddy's both counted.
export const MAX_THREADS = 50;
export const MAX_THREAD_MESSAGES = 1_000;
/// The most messages a shop may send Buddy in any hour: the abuse limit. The gateway's monthly cap is the money limit.
export const MESSAGES_PER_HOUR = 60;
export const HOUR_MS = 60 * 60 * 1000;
/// The longest message the owner may send, in characters (code points, Thai counted as any other).
export const MAX_TEXT_CHARS = 8_000;
/// The longest answer of Buddy's kept. The call asks for at most 1,024 tokens, so a real answer is far shorter: this only
/// bounds the record.
export const MAX_ANSWER_CHARS = 32_000;
/// The messages `admit` hands back for the model's context, the newest. The prompt keeps as many of them as its limit allows.
const HISTORY_READ = 100;
/// A page of a thread's messages: the default and the most.
export const PAGE_DEFAULT = 50;
export const PAGE_MAX = 200;
/// A thread's title: its first message's first words, on one line.
const TITLE_CHARS = 60;
/// The owner's text as the Worker sends it, masked, is at most 8,000 characters, and Buddy's at most MAX_ANSWER_CHARS:
/// JSON can write a character as six bytes, so this is room for both with the rest of the body.
const MAX_BODY_BYTES = 256 * 1024;
/// Durable Object storage takes at most 128 keys per delete call.
const STORAGE_BATCH = 128;
const STOP_REASON = /^[a-z_]{1,32}$/;

/// A thread's id, as `sortableId` mints it.
export const THREAD_ID = /^cht-[0-9a-z]{9}-[0-9a-z]{3}-[0-9a-f]{8}$/;
/// A message's id within its thread: `m` and its number.
export const MESSAGE_ID = /^m([1-9][0-9]{0,5})$/;

export type ThreadRecord = { id: string; title: string; createdAt: number; updatedAt: number; count: number; next: number };
export type MessageRecord = { id: string; from: "owner" | "buddy"; text: string; at: number; stopReason?: string };

/// What a route answers for a thread and a message: ISO times, as the rest of the API answers them.
export type ThreadView = { id: string; title: string; createdAt: string; updatedAt: string; messageCount: number };
export type MessageView = { id: string; from: "owner" | "buddy"; text: string; at: string; stopReason?: string };

const enc = encodeURIComponent;
const keys = {
  threads: (tenant: string) => `chat-threads:${enc(tenant)}`,
  hour: (tenant: string) => `chat-hour:${enc(tenant)}`,
  /// Every message of the shop, for the wipe.
  messages: (tenant: string) => `chat-msg:${enc(tenant)}:`,
  /// One thread's messages. The colon after the id keeps one thread's prefix from matching another's.
  thread: (tenant: string, id: string) => `chat-msg:${enc(tenant)}:${id}:`,
  message: (tenant: string, id: string, n: number) => `chat-msg:${enc(tenant)}:${id}:${String(n).padStart(6, "0")}`,
};

function json(data: unknown, status = 200, headers?: Record<string, string>): Response {
  return Response.json(data, { status, ...(headers ? { headers } : {}) });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isTime(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

const iso = (ms: number) => new Date(ms).toISOString();

export function threadView(thread: ThreadRecord): ThreadView {
  return { id: thread.id, title: thread.title, createdAt: iso(thread.createdAt), updatedAt: iso(thread.updatedAt),
    messageCount: thread.count };
}

export function messageView(message: MessageRecord): MessageView {
  return { id: message.id, from: message.from, text: message.text, at: iso(message.at),
    ...(message.stopReason !== undefined ? { stopReason: message.stopReason } : {}) };
}

/// A thread's title: the first words of the owner's first message, on one line, cut at TITLE_CHARS characters.
function titleOf(text: string): string {
  const line = [...text.replace(/\s+/g, " ").trim()];
  return line.length <= TITLE_CHARS ? line.join("") : `${line.slice(0, TITLE_CHARS - 1).join("").trimEnd()}…`;
}

function readThreads(kv: SyncKvStorage, tenant: string): ThreadRecord[] {
  return kv.get<ThreadRecord[]>(keys.threads(tenant)) ?? [];
}

/// The shop's admissions still inside the hour before `nowMs`, oldest first.
function hourOf(kv: SyncKvStorage, tenant: string, nowMs: number): number[] {
  return (kv.get<number[]>(keys.hour(tenant)) ?? []).filter((at) => at > nowMs - HOUR_MS);
}

/// The newest `count` messages of a thread, oldest first.
function lastMessages(kv: SyncKvStorage, tenant: string, id: string, count: number): MessageRecord[] {
  return [...kv.list<MessageRecord>({ prefix: keys.thread(tenant, id), reverse: true, limit: count })]
    .map(([, message]) => message).reverse();
}

/// `/chat/*` on a TenantObject:
/// - `GET /chat/threads?tenant=`: the shop's threads, newest first;
/// - `GET /chat/thread?tenant=&id=&before=&limit=`: one thread and a page of its messages, oldest first, the newest page
///   unless `before` names the message the page ends before, with the id to ask the next page before (`next`);
/// - `GET /chat/export?tenant=`: every thread with every message, for the tenant export;
/// - `POST /chat/admit`, `POST /chat/commit` and `POST /chat/delete`, the Worker's writes, with its `x-chat` header.
export async function chatTenantRoute(storage: DurableObjectStorage, request: Request, url: URL): Promise<Response> {
  if (request.method === "GET") {
    const tenant = url.searchParams.get("tenant") ?? "";
    if (!isValidTenant(tenant)) return json({ error: "invalid_request" }, 400);
    if (url.pathname === "/chat/threads") return json({ threads: readThreads(storage.kv, tenant).map(threadView) });
    if (url.pathname === "/chat/thread") return readThread(storage.kv, tenant, url);
    if (url.pathname === "/chat/export") return json(exportChat(storage.kv, tenant));
    return json({ error: "not_found" }, 404);
  }
  if (request.headers.get("x-chat") !== "1") return json({ error: "forbidden" }, 403);
  if (request.method !== "POST") return json({ error: "not_found" }, 404);
  const parsed = await readJsonBody<unknown>(request, MAX_BODY_BYTES);
  if (!parsed.ok) return json({ error: parsed.error }, parsed.status);
  const body = parsed.value;
  if (!isRecord(body) || !isValidTenant(body.tenant)) return json({ error: "invalid_request" }, 400);
  const tenant = body.tenant;
  const thread = body.thread === undefined || body.thread === null ? null : body.thread;
  if (thread !== null && (typeof thread !== "string" || !THREAD_ID.test(thread))) return json({ error: "invalid_request" }, 400);
  let answer: { status: number; body: unknown; headers?: Record<string, string> };
  switch (url.pathname) {
    case "/chat/admit": {
      if (!isTime(body.nowMs)) return json({ error: "invalid_request" }, 400);
      const nowMs = body.nowMs;
      answer = storage.transactionSync(() => admit(storage.kv, tenant, thread, nowMs));
      break;
    }
    case "/chat/commit": {
      const kept = keptExchange(body);
      if (!kept) return json({ error: "invalid_request" }, 400);
      const actor = actorOr(body.actor, { kind: "owner" });
      answer = storage.transactionSync(() => commit(storage.kv, tenant, thread, kept, actor));
      break;
    }
    case "/chat/delete": {
      if (thread === null) return json({ error: "invalid_request" }, 400);
      const actor = actorOr(body.actor, { kind: "owner" });
      answer = storage.transactionSync(() => remove(storage.kv, tenant, thread, actor));
      break;
    }
    default:
      return json({ error: "not_found" }, 404);
  }
  return json(answer.body, answer.status, answer.headers);
}

/// Whether one more message may go to the model: the thread named is there and can take two more messages (the owner's
/// and Buddy's), or, for a new thread, the shop has room for one; and the hour has room, in which case this message is
/// counted in it. Answers the thread's newest messages, for the model's context. A message refused here never reaches
/// the gateway and is not counted.
function admit(kv: SyncKvStorage, tenant: string, id: string | null, nowMs: number):
  { status: number; body: unknown; headers?: Record<string, string> } {
  const threads = readThreads(kv, tenant);
  const thread = id === null ? null : threads.find((one) => one.id === id) ?? null;
  if (id !== null && !thread) return { status: 404, body: { error: "thread_not_found" } };
  if (thread && thread.count + 2 > MAX_THREAD_MESSAGES) {
    return { status: 409, body: { error: "thread_full", maxMessages: MAX_THREAD_MESSAGES } };
  }
  if (!thread && threads.length >= MAX_THREADS) return { status: 409, body: { error: "threads_full", maxThreads: MAX_THREADS } };
  const hour = hourOf(kv, tenant, nowMs);
  if (hour.length >= MESSAGES_PER_HOUR) {
    // The hour has room again once its oldest message is an hour old.
    const retryAfter = Math.max(1, Math.ceil((hour[0]! + HOUR_MS - nowMs) / 1000));
    return { status: 429, body: { error: "rate_limited", retryAfter, perHour: MESSAGES_PER_HOUR },
      headers: { "retry-after": String(retryAfter) } };
  }
  kv.put(keys.hour(tenant), [...hour, nowMs]);
  const history = thread ? lastMessages(kv, tenant, thread.id, HISTORY_READ) : [];
  return { status: 200, body: { history: history.map((message) => ({ from: message.from, text: message.text })) } };
}

type Exchange = { owner: string; sentAtMs: number; answer: string; stopReason: string; nowMs: number };

/// The exchange a commit keeps, checked: the owner's words (1 to MAX_TEXT_CHARS characters), Buddy's (empty for a refusal
/// that said nothing, up to MAX_ANSWER_CHARS), the stop reason as a code, and the two times. Null for anything else.
function keptExchange(body: Record<string, unknown>): Exchange | null {
  const { owner, sentAtMs, answer, stopReason, nowMs } = body;
  if (typeof owner !== "string" || owner.trim() === "" || [...owner].length > MAX_TEXT_CHARS) return null;
  if (typeof answer !== "string" || [...answer].length > MAX_ANSWER_CHARS) return null;
  if (typeof stopReason !== "string" || !STOP_REASON.test(stopReason)) return null;
  if (!isTime(sentAtMs) || !isTime(nowMs) || sentAtMs > nowMs) return null;
  return { owner, sentAtMs, answer, stopReason, nowMs };
}

/// Keeps one exchange: the owner's message and Buddy's answer, in the thread named or a new one, with the thread's record
/// and the audit entry, in one transaction. The checks of `admit` run again, as the thread may have gone or filled while
/// Buddy answered.
function commit(kv: SyncKvStorage, tenant: string, id: string | null, kept: Exchange, actor: AuditActor | undefined):
  { status: number; body: unknown } {
  const threads = readThreads(kv, tenant);
  let thread = id === null ? null : threads.find((one) => one.id === id) ?? null;
  if (id !== null && !thread) return { status: 404, body: { error: "thread_not_found" } };
  if (thread && thread.count + 2 > MAX_THREAD_MESSAGES) {
    return { status: 409, body: { error: "thread_full", maxMessages: MAX_THREAD_MESSAGES } };
  }
  if (!thread) {
    if (threads.length >= MAX_THREADS) return { status: 409, body: { error: "threads_full", maxThreads: MAX_THREADS } };
    thread = { id: sortableId("cht", kept.sentAtMs, 0), title: titleOf(kept.owner), createdAt: kept.sentAtMs,
      updatedAt: kept.sentAtMs, count: 0, next: 1 };
  }
  const mine: MessageRecord = { id: `m${thread.next}`, from: "owner", text: kept.owner, at: kept.sentAtMs };
  const buddys: MessageRecord = { id: `m${thread.next + 1}`, from: "buddy", text: kept.answer, at: kept.nowMs,
    stopReason: kept.stopReason };
  kv.put(keys.message(tenant, thread.id, thread.next), mine);
  kv.put(keys.message(tenant, thread.id, thread.next + 1), buddys);
  const updated: ThreadRecord = { ...thread, count: thread.count + 2, next: thread.next + 2, updatedAt: kept.nowMs };
  kv.put(keys.threads(tenant), [updated, ...threads.filter((one) => one.id !== updated.id)]);
  auditPutSync(kv, tenant, actor ? { actor, action: "chat.message_sent",
    subject: { threadId: updated.id, messageId: mine.id }, outcome: "ok" } : null, "chat.message_sent");
  return { status: 200, body: { thread: threadView(updated), message: messageView(mine), answer: messageView(buddys) } };
}

/// The owner's deletion of one thread: its record and every message, with the audit entry, in one transaction. A thread
/// holds at most MAX_THREAD_MESSAGES keys, so one transaction takes it whole.
function remove(kv: SyncKvStorage, tenant: string, id: string, actor: AuditActor | undefined): { status: number; body: unknown } {
  const threads = readThreads(kv, tenant);
  if (!threads.some((one) => one.id === id)) return { status: 404, body: { error: "thread_not_found" } };
  const doomed = [...kv.list({ prefix: keys.thread(tenant, id) })].map(([key]) => key);
  for (const key of doomed) kv.delete(key);
  const rest = threads.filter((one) => one.id !== id);
  if (rest.length) kv.put(keys.threads(tenant), rest);
  else kv.delete(keys.threads(tenant));
  auditPutSync(kv, tenant, actor ? { actor, action: "chat.thread_deleted", subject: { threadId: id }, outcome: "ok" } : null,
    "chat.thread_deleted");
  return { status: 200, body: { id } };
}

/// One thread and a page of its messages, oldest first: the newest `limit`, or the `limit` before the message `before`
/// names. `next` is the id to ask the page before this one with, or null when this page reaches the first message.
function readThread(kv: SyncKvStorage, tenant: string, url: URL): Response {
  const id = url.searchParams.get("id") ?? "";
  if (!THREAD_ID.test(id)) return json({ error: "invalid_request" }, 400);
  const before = url.searchParams.get("before");
  const beforeN = before === null ? null : Number(MESSAGE_ID.exec(before)?.[1] ?? NaN);
  if (beforeN !== null && !Number.isSafeInteger(beforeN)) return json({ error: "invalid_request" }, 400);
  const limitText = url.searchParams.get("limit");
  const limit = limitText === null ? PAGE_DEFAULT : Number(limitText);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > PAGE_MAX || (limitText !== null && !/^\d+$/.test(limitText))) {
    return json({ error: "invalid_request" }, 400);
  }
  const thread = readThreads(kv, tenant).find((one) => one.id === id);
  if (!thread) return json({ error: "thread_not_found" }, 404);
  const page = [...kv.list<MessageRecord>({ prefix: keys.thread(tenant, id), reverse: true, limit: limit + 1,
    ...(beforeN !== null ? { end: keys.message(tenant, id, beforeN) } : {}) })].map(([, message]) => message);
  const more = page.length > limit;
  const shown = page.slice(0, limit).reverse();
  return json({ thread: threadView(thread), messages: shown.map(messageView), next: more ? shown[0]!.id : null });
}

/// Every thread, newest first, each with every message, oldest first: what the tenant export carries as `chat`.
function exportChat(kv: SyncKvStorage, tenant: string): { threads: (ThreadView & { messages: MessageView[] })[] } {
  return {
    threads: readThreads(kv, tenant).map((thread) => ({
      ...threadView(thread),
      messages: [...kv.list<MessageRecord>({ prefix: keys.thread(tenant, thread.id) })].map(([, message]) =>
        messageView(message)),
    })),
  };
}

/// Part of the TenantObject's tenant wipe: every thread, every message and the hour's count, a page of keys at a time.
export async function wipeChatTenant(storage: DurableObjectStorage, tenant: string): Promise<void> {
  const doomed = [keys.threads(tenant), keys.hour(tenant)];
  for await (const page of keyPages(storage, keys.messages(tenant))) doomed.push(...page);
  for (let i = 0; i < doomed.length; i += STORAGE_BATCH) await storage.delete(doomed.slice(i, i + STORAGE_BATCH));
}
