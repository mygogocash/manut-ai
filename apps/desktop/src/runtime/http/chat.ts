// Buddy's chat on the connected runtime (item 102l-2; docs/connected-chat.md, B; the routes are docs/pilot-api.md, "Chat"): a message
// to Buddy, in its main chat or in one of its conversations, posted with the owner's session of the shop the chat is of, and Buddy's
// answer shown as one turn; the shop's conversations listed beside its tasks, opened and made. Removing one is left out: no screen
// offers it (the thread tree with its x is no longer drawn), so `thread.remove` stays `not_yet` (host.ts).
//
// Rules this module keeps:
// - Only the owner chats. A message and a conversation's messages go with the owner session of the shop the chat is of:
//   for Buddy's main chat the shop the switcher showed when the chat was opened (`opened`), for a conversation the shop it was listed
//   or made for, and never the shop the switcher shows by the time the person presses Send, as the owner's other changes go to the
//   shop their list was read for. A shop the person helps at is refused here (`owner_only`) with nothing sent, as the API refuses a
//   helper's session: a helper's message would spend the owner's money. A person in no shop has no chat (`no_shop`): the API answers
//   a person's own sign-in 404, since a chat is a shop's.
// - What the API would refuse for a message's words is refused here first, with nothing sent: a blank message, and one of more than
//   8,000 characters once trimmed, counted by character as the API counts them (Thai as any other).
// - A message is posted once. A refusal, and a request that got no answer, mark the message not sent with the reason, in the
//   person's words; nothing is queued, retried or sent again from here (the store keeps the row with its reason, as for any send that
//   failed). The messages of one chat go one at a time, in the order they were sent, so a second message to a conversation the first
//   is still making goes to the conversation the API made, never to a second new one.
// - Buddy's answer is shown as one turn of the chat (`turn.start`, its `message`, `turn.end`), and only once the API answered. A turn
//   that started before the API let the message through would end Failed for a refusal (a Failed line, a sound, a notification),
//   where a refused message is a message not sent.
// - Buddy only talks: the only write here is a message to Buddy. Nothing here starts, sends, posts, pays, deletes or decides anything
//   of the shop's; approvals still settle only through the decide route (CLAUDE.md).
// - Nothing typed or answered is kept on disk or in the read of the shop kept for offline use: what this module holds (the
//   conversations' ids, titles and counts) is in memory for this run, and goes when the person signs out. While only a kept read is
//   shown, nothing here is sent or read: the kept read holds no chat.
import { dayTime } from "../../app/time";
import { t } from "../../i18n";
import { isObj } from "../../lib/guards";
import type { BridgeEvent, ShopRole, ShopRow } from "../../lib/protocol";
import type { ThreadEvent, ThreadOpenResult, ThreadRow } from "../../threads/types";
import { OpError } from "../mock/host";
import type { Departure, ShopAnswer } from "./shops";
import { TEAM } from "./view";

/** A message to Buddy (`POST`, exactly `{ text }` for a new conversation or `{ thread, text }`). */
export const CHAT_MESSAGES_PATH = "/v1/chat/messages";
/** The shop's conversations (`GET`), newest written first, at most 50. */
export const CHAT_THREADS_PATH = "/v1/chat/threads";
/** One conversation and its newest messages (`GET`), oldest first. */
export const chatThreadPath = (id: string) => `${CHAT_THREADS_PATH}/${encodeURIComponent(id)}`;

/** The API's limits (apps/api chat-store.ts), said in the refusals when its answer does not carry them. */
export const MAX_CHAT_TEXT = 8_000;
const MAX_THREADS = 50;
const MAX_THREAD_MESSAGES = 1_000;
const PER_HOUR = 60;

/** The API's conversation ids are `cht-` and its own characters. A shape this loose is enough to tell a conversation from a task,
 *  whose ids the API never starts so, and the API checks the id exactly. */
const CHAT_ID = /^cht-[0-9a-z-]{1,60}$/;
export const isChatId = (v: unknown): v is string => typeof v === "string" && CHAT_ID.test(v);
/** An id of the API's, to send back: short and plain. */
const API_ID = /^[A-Za-z0-9._-]{1,64}$/;

/** One conversation, as the API answers it (`Thread`), its times in ms. */
export interface ChatThreadView {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
}

/** One message of a conversation (`Message`), its time in ms. `stopReason` is on Buddy's, as the provider gave it. */
export interface ChatMessageView {
  id: string;
  from: "owner" | "buddy";
  text: string;
  at: number;
  stopReason?: string;
}

const msOf = (v: unknown): number | null => {
  const ms = typeof v === "string" ? Date.parse(v) : NaN;
  return Number.isNaN(ms) ? null : ms;
};
const count = (v: unknown): number | null => (typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : null);

export function decodeChatThread(v: unknown): ChatThreadView | null {
  if (!isObj(v) || typeof v.id !== "string" || !API_ID.test(v.id) || typeof v.title !== "string") return null;
  const createdAt = msOf(v.createdAt);
  const updatedAt = msOf(v.updatedAt);
  const messageCount = count(v.messageCount);
  if (createdAt === null || updatedAt === null || messageCount === null) return null;
  return { id: v.id, title: v.title, createdAt, updatedAt, messageCount };
}

export function decodeChatMessage(v: unknown): ChatMessageView | null {
  if (!isObj(v) || typeof v.id !== "string" || !API_ID.test(v.id) || (v.from !== "owner" && v.from !== "buddy") || typeof v.text !== "string") return null;
  const at = msOf(v.at);
  if (at === null || (v.stopReason !== undefined && typeof v.stopReason !== "string")) return null;
  return { id: v.id, from: v.from, text: v.text, at, ...(typeof v.stopReason === "string" ? { stopReason: v.stopReason } : {}) };
}

/** The shop's conversations (`GET /v1/chat/threads`), each one this build can read, in the API's order; null when the answer is no
 *  list. One it cannot read is left out rather than guessed, as a sign-in the vault lists is. */
export function decodeChatThreads(json: unknown): ChatThreadView[] | null {
  if (!isObj(json) || !Array.isArray(json.threads)) return null;
  return json.threads.map(decodeChatThread).filter((x): x is ChatThreadView => x !== null);
}

/** What a message came to (`POST /v1/chat/messages`): the conversation, the owner's message as kept and Buddy's answer; null when
 *  this build cannot read it whole. */
export function decodeExchange(json: unknown): { thread: ChatThreadView; message: ChatMessageView; answer: ChatMessageView } | null {
  if (!isObj(json)) return null;
  const thread = decodeChatThread(json.thread);
  const message = decodeChatMessage(json.message);
  const answer = decodeChatMessage(json.answer);
  if (!thread || !message || !answer || message.from !== "owner" || answer.from !== "buddy") return null;
  return { thread, message, answer };
}

/** One conversation and its messages (`GET /v1/chat/threads/{id}`), or null when any of it cannot be read: a conversation with a
 *  message left out would not be the conversation. */
export function decodeChatPage(json: unknown): { thread: ChatThreadView; messages: ChatMessageView[] } | null {
  if (!isObj(json) || !Array.isArray(json.messages)) return null;
  const thread = decodeChatThread(json.thread);
  const messages = json.messages.map(decodeChatMessage);
  if (!thread || !messages.every((m): m is ChatMessageView => m !== null)) return null;
  return { thread, messages };
}

/** Buddy's words as the chat shows them: an answer the provider refused with nothing said says so, and one cut at its length says
 *  that too, so a short or empty answer is never taken for Buddy's whole word. */
export function answerText(m: Pick<ChatMessageView, "text" | "stopReason">): string {
  if (m.stopReason === "refusal" && m.text.trim() === "") return t("rt.chat.answerRefused");
  return m.stopReason === "max_tokens" ? `${m.text}\n\n${t("rt.chat.answerCut")}` : m.text;
}

/** What the module needs of the host: the shops of the latest read, each shop's own session, and the host's events. */
export interface ChatLink {
  /** Throws `offline` while only a kept read of the shop is shown. */
  live(): void;
  /** Whether the person is in any shop. */
  inShops(): boolean;
  /** The shop the switcher shows, or null while the person is in none. */
  viewing(): string | null;
  /** One of the person's shops, as the latest read lists it; undefined when it is not one of theirs. */
  shopRow(shop: string): ShopRow | undefined;
  /** The person's role at `shop` now. */
  roleAt(shop: string): ShopRole | undefined;
  read(shop: string, path: string): Promise<ShopAnswer>;
  write(shop: string, path: string, body: unknown): Promise<ShopAnswer>;
  /** The person's place in `shop` ended: the host says so, and this is what the op is refused with. */
  departed(shop: string, departure: Departure): OpError;
  emit(ev: BridgeEvent | ThreadEvent): void;
  now(): number;
}

/** A conversation this run knows: what the screens call it (`id`: the API's own id, or for one `thread.create` prepared, an id of
 *  this run's that names it until the app starts again), the shop it is of, and the API's id once a message made it. */
interface Conversation {
  id: string;
  shop: string;
  api: string | null;
  title: string;
  /** ms */
  createdAt: number;
  updatedAt: number;
  count: number;
  /** the store's own key for a conversation it asked to make, so asking twice gives the same one */
  key: string | null;
}

/** Buddy's main chat: the shop it was opened for (null while the person was in none) and the conversation its messages go to, which
 *  its first message makes. `opened` is false for a chat the person sent to without opening it (Home's ask box), which follows the shop
 *  the switcher shows until it is opened. */
interface MainChat {
  shop: string | null;
  api: string | null;
  opened: boolean;
}

/** Where a message goes: Buddy's main chat, or one conversation. */
type Target = { main: MainChat; conv?: undefined } | { conv: Conversation; main?: undefined };

type Refused = Exclude<ShopAnswer, { kind: "ok" }>;
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null);

/** Buddy's chat over `link`: one per host. */
export class BuddyChat {
  private main: MainChat | null = null;
  /** Every conversation this run knows, by the id the screens call it. */
  private readonly convs = new Map<string, Conversation>();
  /** The id the screens call a conversation, by the API's id. */
  private readonly byApi = new Map<string, string>();
  /** The last message of each chat on its way, so the next one waits for it (`inTurn`). */
  private readonly turns = new WeakMap<object, Promise<unknown>>();
  private made = 0;

  constructor(private readonly link: ChatLink) {}

  /** Whether `id` names a conversation this run knows. */
  knows(id: unknown): id is string {
    return typeof id === "string" && this.convs.has(id);
  }

  /** Buddy's main chat was opened, for the shop the switcher shows now: its next message starts a new conversation there, as the chat
   *  the person sees holds none of an earlier one (its earlier conversation is listed with the others). */
  opened(): void {
    this.main = { shop: this.link.viewing(), api: null, opened: true };
  }

  /** Forgets everything: the person signed out, or the host stopped. */
  forget(): void {
    this.main = null;
    this.convs.clear();
    this.byApi.clear();
  }

  /** `chat.send` to Buddy: one message, posted once with the owner session of the chat's shop, and Buddy's answer as one turn. */
  async send(p: { text?: unknown; session?: unknown }): Promise<{ input_id: string }> {
    this.link.live();
    const target = this.target(p.session);
    const shop = this.owned(target.main ? target.main.shop : target.conv.shop);
    const text = this.words(p.text);
    return this.inTurn(target.main ?? target.conv, () => this.post(shop, target, text));
  }

  /** `thread.create` for Buddy: a conversation prepared here, for the shop the switcher shows, with nothing sent. The API makes a
   *  conversation only with its first message (there is no route that makes an empty one, and a model call needs a message), and
   *  the store asks for the conversation before the person has typed anything, so its first message makes it (`post`). */
  create(p: { title?: unknown; key?: unknown }): ThreadRow & { model: string; provider: string; reasoning: string } {
    this.link.live();
    const shop = this.owned(this.link.viewing());
    const key = typeof p.key === "string" ? p.key : null;
    let conv = key === null ? undefined : [...this.convs.values()].find((c) => c.key === key && c.shop === shop.id);
    if (!conv) {
      const now = this.link.now();
      this.made += 1;
      conv = { id: `chat-new-${now.toString(36)}-${this.made}`, shop: shop.id, api: null, title: typeof p.title === "string" ? p.title.trim() : "", createdAt: now, updatedAt: now, count: 0, key };
      this.convs.set(conv.id, conv);
    }
    return { ...rowOf(conv), model: "", provider: "", reasoning: "" };
  }

  /** The conversations of the shop the switcher shows, as Buddy's threads beside its tasks, for a shop the person owns: read from
   *  the API each time the list is asked for, with the prepared ones not sent to yet. A read that fails lists what this run last
   *  knew of them, so a slow or failing chat never hides a conversation; nothing is listed while only a kept read is shown. */
  async rows(): Promise<ThreadRow[]> {
    const shop = this.link.viewing();
    if (shop === null || this.link.roleAt(shop) !== "owner") return [];
    try {
      this.link.live();
    } catch {
      return [];
    }
    // The conversations the API had made before this read went out: only these can be gone from what it lists. One a message made
    // while the read was on its way may be missing from an answer the API gave before it, and is kept.
    const before = new Set([...this.convs.values()].filter((c) => c.shop === shop && c.api !== null).map((c) => c.api));
    const answer = await this.link.read(shop, CHAT_THREADS_PATH);
    const views = answer.kind === "ok" ? decodeChatThreads(answer.json) : null;
    if (answer.kind === "left") {
      this.link.departed(shop, answer.departure);
      return [];
    }
    if (views) {
      const listed = new Set(views.map((v) => v.id));
      // one removed elsewhere is gone here too; a prepared one has nothing to be listed yet
      // (a Map's own iteration goes on safely past an entry deleted under it)
      for (const conv of this.convs.values()) if (conv.shop === shop && conv.api !== null && before.has(conv.api) && !listed.has(conv.api)) this.drop(conv);
      for (const view of views) {
        // what a message answered while the read was on its way said of a conversation is newer than the read, and stays
        const known = this.convs.get(this.byApi.get(view.id) ?? view.id);
        if (!known || known.updatedAt <= view.updatedAt) this.remember(shop, view);
      }
    }
    return [...this.convs.values()].filter((c) => c.shop === shop).map(rowOf);
  }

  /** `thread.open` of a conversation: its newest messages, oldest first, read with the owner session of its shop. A prepared one has
   *  none yet, and nothing is read for it. */
  async open(id: string): Promise<ThreadOpenResult> {
    this.link.live();
    const known = this.convs.get(id);
    const shop = this.owned(known ? known.shop : this.link.viewing());
    const api = known ? known.api : id;
    if (api === null) return openOf(known!, []);
    const answer = await this.link.read(shop.id, chatThreadPath(api));
    if (answer.kind !== "ok") {
      if (answer.kind === "refused" && answer.code === "thread_not_found" && known) this.drop(known);
      throw this.refusal(answer, shop, "read");
    }
    const page = decodeChatPage(answer.json);
    if (!page) throw new OpError("unavailable", t("rt.chat.unreadable"));
    const conv = this.remember(shop.id, page.thread, known?.id);
    return openOf(conv, page.messages);
  }

  // ---- inside ------------------------------------------------------------------------------------------------------

  /** Where a message with `session` goes: no session is Buddy's main chat, and any other must be a conversation this run knows. */
  private target(session: unknown): Target {
    if (session === undefined || session === null) {
      const viewing = this.link.viewing();
      // A chat never opened is the one the person sees: the shop the switcher shows. Once opened, it is the shop it was opened for.
      if (!this.main || (!this.main.opened && this.main.shop !== viewing)) this.main = { shop: viewing, api: null, opened: false };
      return { main: this.main };
    }
    const conv = typeof session === "string" ? this.convs.get(session) : undefined;
    if (!conv) throw new OpError("not_found", t("rt.notFound"));
    return { conv };
  }

  /** The shop a chat is of, checked here with nothing sent: one of the person's shops, which they own. */
  private owned(shop: string | null): ShopRow {
    if (shop === null || !this.link.inShops()) throw new OpError("no_shop", t("rt.chat.noShop"));
    const row = this.link.shopRow(shop);
    if (!row) throw new OpError("not_found", t("rt.notFound"));
    if (this.link.roleAt(shop) !== "owner") throw new OpError("owner_only", t("rt.chat.ownerOnly", { owner: row.owner, shop: row.name }));
    return row;
  }

  /** A message's words, trimmed as the API keeps them; what the API would refuse is refused here first. */
  private words(v: unknown): string {
    const text = typeof v === "string" ? v.trim() : "";
    if (!text) throw new OpError("invalid_text", t("rt.chat.empty"));
    if ([...text].length > MAX_CHAT_TEXT) throw new OpError("text_too_long", t("rt.chat.tooLong", { max: MAX_CHAT_TEXT }));
    return text;
  }

  /** Runs `fn` after the message of the same chat before it, whatever that came to. */
  private inTurn<T>(chat: object, fn: () => Promise<T>): Promise<T> {
    const before = this.turns.get(chat) ?? Promise.resolve();
    const mine = before.then(fn);
    this.turns.set(chat, mine.catch(() => undefined));
    return mine;
  }

  private async post(shop: ShopRow, target: Target, text: string): Promise<{ input_id: string }> {
    const api = target.main ? target.main.api : target.conv.api;
    const answer = await this.link.write(shop.id, CHAT_MESSAGES_PATH, api === null ? { text } : { thread: api, text });
    if (answer.kind !== "ok") {
      // a conversation removed elsewhere: the next message to the main chat starts a new one
      if (answer.kind === "refused" && answer.code === "thread_not_found" && target.main) target.main.api = null;
      throw this.refusal(answer, shop, "send");
    }
    const exchange = decodeExchange(answer.json);
    if (!exchange) throw new OpError("unavailable", t("rt.chat.unreadable"));
    const conv = this.remember(shop.id, exchange.thread, target.conv?.id);
    if (target.main) target.main.api = exchange.thread.id;
    const at = { bot: TEAM, ...(target.conv ? { session: target.conv.id } : {}) };
    this.link.emit({ event: "turn.start", ...at });
    this.link.emit({ event: "message", ...at, id: `${exchange.thread.id}/${exchange.answer.id}`, text: answerText(exchange.answer) });
    this.link.emit({ event: "turn.end", ...at, outcome: "done" });
    // The main chat's first message made a conversation: it is listed with the others from now on.
    if (target.main && api === null) this.link.emit({ event: "thread.added", bot: TEAM, thread: conv.id, title: conv.title });
    return { input_id: `${exchange.thread.id}/${exchange.message.id}` };
  }

  /** Keeps what the API said of a conversation of `shop`, under the id the screens already call it (`id`), else the one they called
   *  it by before, else its own. A conversation already known is updated in place: a message waiting behind the one that made it
   *  holds that same record (`inTurn`), and must see the API's id. */
  private remember(shop: string, view: ChatThreadView, id = this.byApi.get(view.id) ?? view.id): Conversation {
    const said = { shop, api: view.id, title: view.title, createdAt: view.createdAt, updatedAt: view.updatedAt, count: view.messageCount };
    const was = this.convs.get(id);
    const conv: Conversation = was ? Object.assign(was, said) : { id, key: null, ...said };
    this.convs.set(id, conv);
    this.byApi.set(view.id, id);
    return conv;
  }

  private drop(conv: Conversation): void {
    this.convs.delete(conv.id);
    if (conv.api !== null) this.byApi.delete(conv.api);
    if (this.main && conv.api !== null && this.main.api === conv.api) this.main.api = null;
  }

  /** The API's refusal of a message (`send`) or of a read of a conversation (`read`), in the person's words. */
  private refusal(answer: Refused, shop: ShopRow, what: "send" | "read"): OpError {
    if (answer.kind === "left") return this.link.departed(shop.id, answer.departure);
    if (answer.kind === "signed_out") return new OpError("signed_out", t("rt.signedOut"));
    if (answer.kind === "offline") return new OpError("offline", t("rt.offline"));
    if (answer.kind === "unavailable") {
      // The API's own 5xx answers (`not_configured`, `meter_unavailable`, `provider_error`, `chat_unavailable`) come before anything is
      // kept. Any other, and a request that got no answer, may have come after: it is said as no answer, and nothing is sent again.
      if (what === "read") return new OpError("unavailable", t("rt.unavailable"));
      if (answer.code === "not_configured" && what === "send") return new OpError("not_configured", t("rt.chat.notConfigured"));
      if (answer.code) return new OpError(answer.code, t("rt.chat.unavailable"));
      return new OpError("unavailable", t("rt.chat.noReply"));
    }
    const json = isObj(answer.json) ? answer.json : {};
    const said = (words: string) => new OpError(answer.code, words);
    switch (answer.code) {
      // an API from before the chat answers its routes 404 `not_found`, as one with the chat switched off would refuse it
      case "feature_disabled":
      case "not_found":
        return said(t("rt.chat.disabled"));
      case "budget_exceeded":
        return said(t("rt.chat.budget"));
      case "not_counted_in":
        return said(t("rt.chat.notCountedIn"));
      case "owner_only":
        return said(t("rt.chat.ownerOnly", { owner: shop.owner, shop: shop.name }));
      case "consent_required":
        return said(t("rt.chat.consent"));
      case "rate_limited": {
        const now = this.link.now();
        const wait = num(json.retryAfter) ?? 60;
        return said(t("rt.chat.rateLimited", { perHour: num(json.perHour) ?? PER_HOUR, time: dayTime(now + wait * 1000, now) }));
      }
      case "thread_full":
        return said(t("rt.chat.threadFull", { max: num(json.maxMessages) ?? MAX_THREAD_MESSAGES }));
      case "threads_full":
        return said(t("rt.chat.threadsFull", { max: num(json.maxThreads) ?? MAX_THREADS }));
      case "text_too_long":
        return said(t("rt.chat.tooLong", { max: num(json.maxChars) ?? MAX_CHAT_TEXT }));
      case "thread_not_found":
        return said(t("rt.chat.threadGone"));
      case "invalid_text":
        return said(t("rt.chat.empty"));
    }
    return new OpError(answer.code || "refused", what === "send" ? t("rt.chat.refused") : t("rt.unavailable"));
  }
}

/** A conversation as one of Buddy's threads: marked a conversation (`kind: "chat"`), so the screens never take it for the team's work.
 *  Its title is the owner's first words, so the row's second line says them as the owner's until its messages are read. */
function rowOf(conv: Conversation): ThreadRow {
  return {
    thread: conv.id,
    title: conv.title,
    cwd: "",
    started_at: conv.createdAt / 1000,
    last: conv.updatedAt / 1000,
    running: false,
    needs: false,
    message_count: conv.count,
    preview: conv.count > 0 ? conv.title : "",
    kind: "chat",
  };
}

function openOf(conv: Conversation, messages: ChatMessageView[]): ThreadOpenResult {
  const api = conv.api ?? conv.id;
  return {
    thread: conv.id,
    session_id: conv.id,
    title: conv.title,
    cwd: "",
    messages: messages.map((m) => ({ id: `${api}/${m.id}`, role: m.from === "owner" ? ("user" as const) : ("assistant" as const), text: m.from === "buddy" ? answerText(m) : m.text, ts: m.at / 1000 })),
    running: false,
    model: "",
    provider: "",
    reasoning: "",
  };
}
