// Buddy's chat on the connected runtime (item 102l-2; docs/connected-chat.md, B; the routes are docs/pilot-api.md, "Chat"): a message
// to Buddy, in its main chat or in one of its conversations, posted with the owner's session of the shop the chat is of, and Buddy's
// answer shown as one turn; the shop's conversations listed beside its tasks, opened, made, read further back (`older`, item 102l-6) and
// removed (`remove`, item 102l-6: the one write here that deletes, which the screens ask about first and which cannot be taken back).
//
// Rules this module keeps:
// - Only the owner chats. A message and a conversation's messages go with the owner session of the shop the chat is of:
//   for Buddy's main chat the shop the switcher showed when the chat was opened (`opened`), for a conversation the shop it was listed
//   or made for, and never the shop the switcher shows by the time the person presses Send, as the owner's other changes go to the
//   shop their list was read for. A shop the person helps at is refused here (`owner_only`) with nothing sent, as the API refuses a
//   helper's session: a helper's message would spend the owner's money. A person in no shop has no chat (`no_shop`): the API answers
//   a person's own sign-in 404, since a chat is a shop's.
// - What the API would refuse for a message is refused here first, with nothing sent: a blank message, one of more than 8,000
//   characters once trimmed, counted by character as the API counts them (Thai as any other), a note that is not a whole note, and a
//   title for the conversation the words were sent on from that the API would not keep.
// - A message is posted once. A refusal, and a request that got no answer, mark the message not sent with the reason, in the
//   person's words; nothing is queued, retried or sent again from here (the store keeps the row with its reason, as for any send that
//   failed). The messages of one chat go one at a time, in the order they were sent, so a second message to a conversation the first
//   is still making goes to the conversation the API made, never to a second new one.
// - Buddy's answer is shown as one turn of the chat (`turn.start`, its `message`, `turn.end`), and only once the API answered. A turn
//   that started before the API let the message through would end Failed for a refusal (a Failed line, a sound, a notification),
//   where a refused message is a message not sent.
// - Buddy only talks: the only writes here are a message to Buddy and the removal of one of Buddy's own conversations. Nothing here
//   starts, sends, posts, pays or decides anything of the shop's, and nothing else of the shop's is deleted; approvals still settle only
//   through the decide route (CLAUDE.md).
// - A removal (item 102l-6) goes with the owner session of the shop the conversation was listed or made for, exactly `{ id }`, once, and
//   never with the shop the switcher shows by the time it is pressed: the person asked about a conversation of the shop they saw. It
//   waits for the messages of that conversation already on their way, so a message sent just before is kept and then removed with the
//   rest, never left to make the conversation again. A conversation not yet made (no message sent) is just dropped, with nothing sent.
//   Any refusal leaves the conversation where it was, but for `thread_not_found`, which drops it as the next read of the list would.
//   The screens ask the person first (src/threads/RemoveConversation.tsx): this module does not decide that, and cannot be asked twice
//   for one conversation, since a removed one is no longer known here.
// - Older messages (item 102l-6) are read a page at a time with the owner session of the conversation's shop, from the cursor the
//   screens hand back (the API's `next`, which `open` and each older page give), and nothing read is kept on disk.
// - Nothing typed or answered is kept on disk or in the read of the shop kept for offline use: what this module holds (the
//   conversations' ids, titles and counts) is in memory for this run, and goes when the person signs out. While only a kept read is
//   shown, nothing here is sent or read: the kept read holds no chat.
// - The reach cards' lines (items 102l-3 and 102l-5, docs/connected-chat.md, C; src/jobs/reachMarks.ts) are fields of the message, never
//   part of its words: a message may carry Buddy's note naming the conversations Buddy may reach (`note`, a whole note and nothing
//   else), and words sent on from another conversation carry that conversation's title (`sent_on_from`, posted as `sentOnFrom`). The API
//   gives the model both and keeps the words alone, so it names a new conversation by them and the export holds nothing of ours; the
//   words have all of the 8,000 characters. Reading a conversation back draws a message sent on with its mark in front, from its
//   `sentOnFrom`, and hides the reach block of an answer to a message that carried the note (`noted`), since its card was the place for it.
import { dayTime } from "../../app/time";
import { t } from "../../i18n";
import { isObj } from "../../lib/guards";
import type { BridgeEvent, ShopRole, ShopRow } from "../../lib/protocol";
import type { ThreadEvent, ThreadOpenResult, ThreadRow } from "../../threads/types";
import { hideReachBlocks } from "../../jobs/reachBlocks";
import { fromChatText, isBuddyNote, isMarkTitle } from "../../jobs/reachMarks";
import { OpError } from "../mock/host";
import type { Departure, ShopAnswer } from "./shops";
import { TEAM } from "./view";

/** A message to Buddy (`POST`, exactly `{ text }` for a new conversation or `{ thread, text }`). */
export const CHAT_MESSAGES_PATH = "/v1/chat/messages";
/** The shop's conversations (`GET`), newest written first, at most 50. */
export const CHAT_THREADS_PATH = "/v1/chat/threads";
/** One conversation and its newest messages (`GET`), oldest first. */
export const chatThreadPath = (id: string) => `${CHAT_THREADS_PATH}/${encodeURIComponent(id)}`;
/** Removes one conversation and every message in it, for good (`POST`, exactly `{ id }`). */
export const CHAT_REMOVE_PATH = "/v1/chat/threads/remove";
/** How many older messages a press of Show older reads: the API's own default page, written out so the request says it. */
export const OLDER_PAGE = 50;
/** The page of a conversation's messages before `before` (a message id), `GET`, oldest first. */
export const chatOlderPath = (id: string, before: string) => `${chatThreadPath(id)}?before=${encodeURIComponent(before)}&limit=${OLDER_PAGE}`;

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

/** One message of a conversation (`Message`), its time in ms. `stopReason` is on Buddy's, as the provider gave it. `sentOnFrom` and
 *  `noted` are on an owner's message only (item 102l-5): the title of the conversation its words were sent on from, and that it went
 *  with Buddy's note (the note itself is not kept). */
export interface ChatMessageView {
  id: string;
  from: "owner" | "buddy";
  text: string;
  at: number;
  stopReason?: string;
  sentOnFrom?: string;
  noted?: true;
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

/** A message of a conversation, or null when its id, author, words or time cannot be read. `sentOnFrom` and `noted` are read strictly and
 *  only on an owner's message: a title that is not text with something in it, a `noted` that is not `true`, and either on Buddy's
 *  message, are left out and the message is still read, as an unknown thing about a message is no reason to lose the message. */
export function decodeChatMessage(v: unknown): ChatMessageView | null {
  if (!isObj(v) || typeof v.id !== "string" || !API_ID.test(v.id) || (v.from !== "owner" && v.from !== "buddy") || typeof v.text !== "string") return null;
  const at = msOf(v.at);
  if (at === null || (v.stopReason !== undefined && typeof v.stopReason !== "string")) return null;
  const mine = v.from === "owner";
  return {
    id: v.id,
    from: v.from,
    text: v.text,
    at,
    ...(typeof v.stopReason === "string" ? { stopReason: v.stopReason } : {}),
    ...(mine && typeof v.sentOnFrom === "string" && v.sentOnFrom.trim() !== "" ? { sentOnFrom: v.sentOnFrom } : {}),
    ...(mine && v.noted === true ? { noted: true as const } : {}),
  };
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

/** One conversation and a page of its messages (`GET /v1/chat/threads/{id}`), or null when any of it cannot be read: a conversation with a
 *  message left out would not be the conversation. `next` is the id the page before this one is asked with, null at the first message;
 *  an answer with no `next`, or one that is not a message id, is not read as the end of the conversation, which would hide its older
 *  messages without saying so. */
export function decodeChatPage(json: unknown): { thread: ChatThreadView; messages: ChatMessageView[]; next: string | null } | null {
  if (!isObj(json) || !Array.isArray(json.messages)) return null;
  const thread = decodeChatThread(json.thread);
  const messages = json.messages.map(decodeChatMessage);
  const next = json.next === null ? null : typeof json.next === "string" && API_ID.test(json.next) ? json.next : undefined;
  if (!thread || next === undefined || !messages.every((m): m is ChatMessageView => m !== null)) return null;
  return { thread, messages, next };
}

/** What a removal came to (`POST /v1/chat/threads/remove`): the API answers `{ id }`, the conversation it deleted. Anything else is
 *  not read as a removal, so the person is never told it worked on an answer that does not say so. */
export function removed(json: unknown, api: string): boolean {
  return isObj(json) && json.id === api;
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
/** How many characters `s` has as the API counts them: by code point, so Thai counts as any other and an emoji as one. */
function characters(s: string): number {
  let n = 0;
  for (const _ of s) n += 1;
  return n;
}

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
  /** How many messages Buddy's main chat has sent this run, so opening it can tell one sent while it was opening (`openingMark`). */
  private mainSent = 0;
  /** The API's ids of the conversations removed this run. A read of the list that was on its way when one was removed may still name
   *  it, and must not bring it back into the list; the ids are never reused, so keeping them for the run is safe. */
  private readonly gone = new Set<string>();

  constructor(private readonly link: ChatLink) {}

  /** Whether `id` names a conversation this run knows. */
  knows(id: unknown): id is string {
    return typeof id === "string" && this.convs.has(id);
  }

  /** Taken when `chat.open` of Buddy's main chat starts, and handed back to `opened` once the shop's read it waits for is done. */
  openingMark(): number {
    return this.mainSent;
  }

  /** Buddy's main chat was opened, for the shop the switcher shows now: its next message starts a new conversation there, as the chat
   *  the person sees holds none of an earlier one (its earlier conversation is listed with the others). `mark` (`openingMark`, taken
   *  when the opening started): a message the person sent while the chat was opening already went, or is going, to a conversation of
   *  the chat being opened, which goes on with it; starting another then would split what they wrote in two (item 102l-3 found it). */
  opened(mark?: number): void {
    if (mark !== undefined && mark !== this.mainSent && this.main) {
      this.main.opened = true;
      return;
    }
    this.main = { shop: this.link.viewing(), api: null, opened: true };
  }

  /** Forgets everything: the person signed out, or the host stopped. */
  forget(): void {
    this.main = null;
    this.convs.clear();
    this.byApi.clear();
    this.gone.clear();
  }

  /** `chat.send` to Buddy: one message, posted once with the owner session of the chat's shop, and Buddy's answer as one turn. `note`:
   *  Buddy's note naming the conversations it may reach (item 102l-3), and `sent_on_from`: the title of the conversation the words were
   *  sent on from (item 102l-5). Each is posted as a field of its own, `note` and `sentOnFrom`, and never joined to the words, which have
   *  all 8,000 characters; anything the API would refuse of either (a note that is not whole, a title it would not keep) is refused with
   *  nothing sent. */
  async send(p: { text?: unknown; session?: unknown; note?: unknown; sent_on_from?: unknown }): Promise<{ input_id: string }> {
    this.link.live();
    const target = this.target(p.session);
    const shop = this.owned(target.main ? target.main.shop : target.conv.shop);
    if (p.note !== undefined && !isBuddyNote(p.note)) throw new OpError("invalid_request", t("rt.chat.refused"));
    if (p.sent_on_from !== undefined && !isMarkTitle(p.sent_on_from)) throw new OpError("invalid_request", t("rt.chat.refused"));
    const lines = { ...(p.note !== undefined ? { note: p.note } : {}), ...(p.sent_on_from !== undefined ? { sentOnFrom: p.sent_on_from.trim() } : {}) };
    const text = this.words(p.text);
    if (target.main) this.mainSent += 1;
    return this.inTurn(target.main ?? target.conv, () => this.post(shop, target, text, lines));
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
        // one removed while the read was on its way is not brought back by an answer from before the removal
        if (this.gone.has(view.id)) continue;
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
    return openOf(conv, page.messages, page.next);
  }

  /** `thread.older` of a conversation: the messages before `before` (the cursor `open` or the last older page gave), a page of
   *  `OLDER_PAGE`, oldest first and drawn as `open` draws them, with the cursor for the page before them (null at the first message).
   *  Read with the owner session of the conversation's shop, the one it was listed or made for, whichever the switcher shows by now. A
   *  conversation this run does not know is refused: it was never opened here, so there is no cursor to read from. Nothing is kept. */
  async older(id: string, before: unknown): Promise<{ messages: ThreadOpenResult["messages"]; older: string | null }> {
    this.link.live();
    const known = this.convs.get(id);
    if (!known) throw new OpError("not_found", t("rt.notFound"));
    const shop = this.owned(known.shop);
    // a conversation not made yet has no messages, so no older ones: only a cursor this build was given is read from
    if (known.api === null || typeof before !== "string" || !API_ID.test(before)) throw new OpError("invalid_request", t("rt.unavailable"));
    const answer = await this.link.read(shop.id, chatOlderPath(known.api, before));
    if (answer.kind !== "ok") {
      if (answer.kind === "refused" && answer.code === "thread_not_found") this.drop(known);
      throw this.refusal(answer, shop, "read");
    }
    const page = decodeChatPage(answer.json);
    if (!page) throw new OpError("unavailable", t("rt.chat.unreadable"));
    return { messages: shownMessages(known.api, page.messages), older: page.next };
  }

  /** `thread.remove` of a conversation: deletes it and every message in it for good, `POST /v1/chat/threads/remove` with exactly
   *  `{ id }` and the owner session of the shop it was listed or made for (never the one the switcher shows by now), once, after the
   *  messages of the conversation already on their way. The screens have asked the person first. A conversation not made yet is just
   *  dropped, with nothing sent. A refusal is said in the person's words and leaves the conversation, but `thread_not_found`, which
   *  drops it as the list would on its next read; both ways nothing is sent again from here. */
  async remove(id: string): Promise<{ thread: string; archived: boolean }> {
    this.link.live();
    const conv = this.convs.get(id);
    if (!conv) throw new OpError("not_found", t("rt.notFound"));
    return this.inTurn(conv, () => this.erase(conv));
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

  /** The shop a chat is of, checked here with nothing sent: one of the person's shops, which they own. `words` is what a helper's
   *  shop is refused with: a message and a removal say it differently. */
  private owned(shop: string | null, words: "rt.chat.ownerOnly" | "rt.chat.removeOwnerOnly" = "rt.chat.ownerOnly"): ShopRow {
    if (shop === null || !this.link.inShops()) throw new OpError("no_shop", t("rt.chat.noShop"));
    const row = this.link.shopRow(shop);
    if (!row) throw new OpError("not_found", t("rt.notFound"));
    if (this.link.roleAt(shop) !== "owner") throw new OpError("owner_only", t(words, { owner: row.owner, shop: row.name }));
    return row;
  }

  /** A message's words, trimmed as the API keeps them; what the API would refuse is refused here first. The note and the mark's title are
   *  fields of their own and take no room from them. */
  private words(v: unknown): string {
    const text = typeof v === "string" ? v.trim() : "";
    if (!text) throw new OpError("invalid_text", t("rt.chat.empty"));
    if (characters(text) > MAX_CHAT_TEXT) throw new OpError("text_too_long", t("rt.chat.tooLong", { max: MAX_CHAT_TEXT }));
    return text;
  }

  /** Runs `fn` after the message of the same chat before it, whatever that came to. */
  private inTurn<T>(chat: object, fn: () => Promise<T>): Promise<T> {
    const before = this.turns.get(chat) ?? Promise.resolve();
    const mine = before.then(fn);
    this.turns.set(chat, mine.catch(() => undefined));
    return mine;
  }

  /** Posts the words once, with `note` and `sentOnFrom` beside them when there are any: the body is `{ text }` or `{ thread, text }`, and
   *  those two fields only when present, as the API takes them. */
  private async post(shop: ShopRow, target: Target, text: string, lines: { note?: string; sentOnFrom?: string }): Promise<{ input_id: string }> {
    const api = target.main ? target.main.api : target.conv.api;
    const asked = this.link.now();
    const answer = await this.link.write(shop.id, CHAT_MESSAGES_PATH, { ...(api === null ? {} : { thread: api }), text, ...lines });
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
    // the turn is said only now, and began when the message went: its line says how long Buddy took (`since`)
    this.link.emit({ event: "turn.start", ...at, since: asked });
    this.link.emit({ event: "message", ...at, id: `${exchange.thread.id}/${exchange.answer.id}`, text: answerText(exchange.answer) });
    this.link.emit({ event: "turn.end", ...at, outcome: "done" });
    // The main chat's first message made a conversation: it is listed with the others from now on.
    if (target.main && api === null) this.link.emit({ event: "thread.added", bot: TEAM, thread: conv.id, title: conv.title });
    return { input_id: `${exchange.thread.id}/${exchange.message.id}` };
  }

  /** The removal itself, once the conversation's own messages are done: the shop is checked again (the person may have stopped owning it
   *  while the removal waited), then the conversation is deleted on the API, or just dropped when no message ever made it there. */
  private async erase(conv: Conversation): Promise<{ thread: string; archived: boolean }> {
    const shop = this.owned(conv.shop, "rt.chat.removeOwnerOnly");
    if (conv.api !== null) {
      const answer = await this.link.write(shop.id, CHAT_REMOVE_PATH, { id: conv.api });
      if (answer.kind !== "ok") {
        // the API has no such conversation: it is gone, as the list would say on its next read
        if (answer.kind === "refused" && answer.code === "thread_not_found") this.dismiss(conv);
        throw this.refusal(answer, shop, "remove");
      }
      if (!removed(answer.json, conv.api)) throw new OpError("unavailable", t("rt.chat.unreadable"));
    }
    this.dismiss(conv);
    return { thread: conv.id, archived: false };
  }

  /** A conversation that is gone: no longer known here, never listed again by a read that began before it went, and the screens are
   *  told (`thread.removed`), so its row and its chat go from the store. */
  private dismiss(conv: Conversation): void {
    if (conv.api !== null) this.gone.add(conv.api);
    this.drop(conv);
    this.link.emit({ event: "thread.removed", bot: TEAM, thread: conv.id });
  }

  /** Keeps what the API said of a conversation of `shop`, under the id the screens already call it (`id`), else the one they called
   *  it by before, else its own. A conversation already known is updated in place: a message waiting behind the one that made it
   *  holds that same record (`inTurn`), and must see the API's id. Its name is the API's, the owner's first words (a started conversation's
   *  brief), since Manut AI's lines are fields of their own and never part of them (item 102l-5). */
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

  /** The API's refusal of a message (`send`), of a read of a conversation (`read`) or of its removal (`remove`), in the person's words. */
  private refusal(answer: Refused, shop: ShopRow, what: "send" | "read" | "remove"): OpError {
    if (answer.kind === "left") return this.link.departed(shop.id, answer.departure);
    if (answer.kind === "signed_out") return new OpError("signed_out", t("rt.signedOut"));
    if (answer.kind === "offline") return new OpError("offline", t("rt.offline"));
    if (answer.kind === "unavailable") {
      // The API's own 5xx answers (`not_configured`, `meter_unavailable`, `provider_error`, `chat_unavailable`) come before anything is
      // kept. Any other, and a request that got no answer, may have come after: it is said as no answer, and nothing is sent again.
      if (what === "read") return new OpError("unavailable", t("rt.unavailable"));
      // a removal that got no answer may have gone through, so it says that, and a second press is safe: a conversation already gone is
      // `thread_not_found`, which leaves the list
      if (what === "remove") return new OpError("unavailable", t("rt.chat.removeUnavailable"));
      if (answer.code === "not_configured" && what === "send") return new OpError("not_configured", t("rt.chat.notConfigured"));
      if (answer.code) return new OpError(answer.code, t("rt.chat.unavailable"));
      return new OpError("unavailable", t("rt.chat.noReply"));
    }
    const json = isObj(answer.json) ? answer.json : {};
    if (what === "remove") {
      // the removal route stays open with the chat switched off, so the chat's other refusals are not its own
      if (answer.code === "thread_not_found") return new OpError(answer.code, t("rt.chat.threadGone"));
      if (answer.code === "owner_only") return new OpError(answer.code, t("rt.chat.removeOwnerOnly", { owner: shop.owner, shop: shop.name }));
      return new OpError(answer.code || "refused", t("rt.chat.removeRefused"));
    }
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

/** A conversation's messages as the screens draw them (items 102l-3 and 102l-5): an owner's message that was sent on from another
 *  conversation with its mark in front, from its `sentOnFrom`, as on this Mac, and any other as the words it kept; Buddy's answer to a
 *  message that carried the note (`noted`) without its reach block, which its card stood for while the app ran (an answer that was only
 *  the block leaves no message, as it left no bubble then). Any other answer keeps every word Buddy wrote. */
function shownMessages(api: string, messages: ChatMessageView[]): ThreadOpenResult["messages"] {
  const out: ThreadOpenResult["messages"] = [];
  let noted = false;
  for (const m of messages) {
    const id = `${api}/${m.id}`;
    const ts = m.at / 1000;
    if (m.from === "owner") {
      noted = m.noted === true;
      out.push({ id, role: "user", text: m.sentOnFrom === undefined ? m.text : fromChatText(m.sentOnFrom, m.text), ts });
      continue;
    }
    const text = noted ? hideReachBlocks(answerText(m)) : answerText(m);
    noted = false;
    if (text.trim()) out.push({ id, role: "assistant", text, ts });
  }
  return out;
}

/** A conversation as `thread.open` gives it. `older` is the API's cursor for the messages before these, which Show older reads
 *  (`thread.older`); it is left out when these are the first messages, or none have been read. */
function openOf(conv: Conversation, messages: ChatMessageView[], older: string | null = null): ThreadOpenResult {
  const api = conv.api ?? conv.id;
  return {
    thread: conv.id,
    session_id: conv.id,
    title: conv.title,
    cwd: "",
    messages: shownMessages(api, messages),
    running: false,
    model: "",
    provider: "",
    reasoning: "",
    ...(older === null ? {} : { older }),
  };
}
