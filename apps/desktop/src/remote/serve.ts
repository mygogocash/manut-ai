// The only code that turns a paired phone's request into something the Mac does (docs/remote-access.md, "The first
// version"). A phone may ask for exactly six things, and anything else is refused by name:
//
//   list      the chats, each Working, Needs you or Done
//   open      one chat: its messages, its current step and its asks, with a cursor into its journal
//   catchup   what a chat did since a cursor, or the whole chat again when the journal no longer holds the range
//   allow     Allow once, in two steps: the Mac issues a one-use challenge bound to the device, the ask, its revision and
//             the choice, and the phone answers it with a passkey (Face ID or the passcode). Only an answer
//             `DecisionChallenges.verify` says `ok` to reaches `settleApproval`, with the phone's device id as who decided.
//   reply     No to an approval, or the answer to a question: no challenge, as the package's README says
//   stop      stop the chat's running turn
//
// Always allow, Allow for the session, Kit's dial, pairing, Unpair and the switch stay on the Mac whatever a phone sends
// (`STAYS_ON_MAC`), and an ask the card marks as needing an app update is answered by nothing. Who is speaking is always
// the channel's own device id (the package's `channel.deviceId`), never anything the relay or the request says.
//
// Messages in the channel are JSON. Every request carries a number `id` the phone chose, and every answer names it:
//   Mac -> phone   {"t":"chats","id",chats} | {"t":"chat","id",view,cursor} | {"t":"events","id",chat,events,cursor}
//                  {"t":"challenge","id",chat,ask,revision,option,nonce,expiresAt} | {"t":"done","id"}
//                  {"t":"refused","id",request,reason}
//   and, unasked, {"t":"event",chat,event,cursor} for each change to a chat the phone has open.
import {
  type DecisionAnswer,
  type DecisionChallenges,
  type RelyingParty,
  type StoredPasskey,
  RemoteChannelError,
  fromBase64Url,
  toBase64Url,
} from "@manut/remote-channel";
import { type Cursor, EventJournal } from "./journal";
import { type AskView, type ChatEvent, type ChatSource, type ChatView, Projector, askBinding, chatEvents, chatRow } from "./project";

/** The six requests a phone may make. */
export const REQUESTS = ["list", "open", "catchup", "allow", "reply", "stop"] as const;
export type RequestName = (typeof REQUESTS)[number];

/** Asked for by name from a phone, and refused as staying on the Mac. */
export const STAYS_ON_MAC: ReadonlySet<string> = new Set([
  "always",
  "allow_always",
  "session",
  "allow_session",
  "folder",
  "dial",
  "pair",
  "unpair",
  "switch",
  "consent",
]);

/** Why a request was refused. `stays_on_mac` and `unknown_request` name a request the phone may never make; the rest
 *  say why this one was not done; and every `DecisionChallenges.verify` refusal is passed on by its own name. */
export type Refusal = string;

/** What the Mac does for a phone, each through the same store action its own buttons use (fromStore.ts). Each answers
 *  null once the runtime took it, or a reason. */
export interface MacActions {
  allowOnce(chat: string, ask: string, by: string): Promise<string | null>;
  decline(chat: string, ask: string, by: string): Promise<string | null>;
  answer(chat: string, ask: string, answer: string | Record<string, string | null>, by: string): Promise<string | null>;
  stop(chat: string): Promise<string | null>;
}

/** The chats as the store has them now, reduced for a phone (fromStore.ts). */
export interface ChatSources {
  list(): ChatSource[];
  get(chat: string): ChatSource | null;
}

/** What serving needs of the paired phones: each one's passkey and a place to note it was seen. */
export interface PhoneRecords {
  has(id: string): boolean;
  passkey(id: string): StoredPasskey | undefined;
  seen(id: string, at: number, signCount?: number): Promise<void>;
}

export interface ServeDeps {
  readonly chats: ChatSources;
  readonly actions: MacActions;
  readonly challenges: DecisionChallenges;
  readonly phones: PhoneRecords;
  readonly rp: RelyingParty;
  now(): number;
  /** Sends an unasked message to every channel of a device. */
  push(deviceId: string, message: Record<string, unknown>): void;
  readonly journal?: EventJournal<ChatEvent>;
}

type Message = Record<string, unknown>;

const MAX_ANSWER_CHARS = 8_000;
const MAX_ID_CHARS = 1_024;
const decoder = new TextDecoder("utf-8", { fatal: true });

function text(value: unknown, max = MAX_ID_CHARS): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= max ? value : null;
}

function bytes(value: unknown): Uint8Array | null {
  if (typeof value !== "string" || value.length > 24_000) return null;
  try {
    return fromBase64Url(value);
  } catch {
    return null;
  }
}

function cursorOf(value: unknown): Cursor | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const { journal, seq } = value as Record<string, unknown>;
  return typeof journal === "string" && journal.length <= 64 && typeof seq === "number" && Number.isSafeInteger(seq) ? { journal, seq } : null;
}

export class Server {
  readonly #deps: ServeDeps;
  readonly #projector = new Projector();
  readonly #journal: EventJournal<ChatEvent>;
  /** Per chat a phone has open: what it was last sent, and which devices watch it. */
  readonly #watched = new Map<string, { view: ChatView; devices: Set<string> }>();
  /** One device's Allow answers are checked one at a time, so its passkey counters are stored in the order checked. */
  readonly #allowChains = new Map<string, Promise<unknown>>();
  /** Set when the switch goes off: nothing that was awaiting acts after it. */
  #closed = false;

  constructor(deps: ServeDeps) {
    this.#deps = deps;
    this.#journal = deps.journal ?? new EventJournal<ChatEvent>();
  }

  get journal(): EventJournal<ChatEvent> {
    return this.#journal;
  }

  /** Answers one message from `deviceId`, the device the channel's handshake proved. */
  async handle(deviceId: string, message: Uint8Array): Promise<Message[]> {
    let request: Message;
    try {
      const value: unknown = JSON.parse(decoder.decode(message));
      if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("not an object");
      request = value as Message;
    } catch {
      return [{ t: "refused", id: null, request: null, reason: "malformed" }];
    }
    const id = typeof request.id === "number" && Number.isSafeInteger(request.id) && request.id >= 0 ? request.id : null;
    const name = typeof request.t === "string" ? request.t : null;
    const refuse = (reason: Refusal): Message[] => [{ t: "refused", id, request: name !== null && /^[a-z_.]{1,32}$/.test(name) ? name : null, reason }];
    if (name === null || id === null) return refuse("malformed");
    if (!(REQUESTS as readonly string[]).includes(name)) return refuse(STAYS_ON_MAC.has(name) ? "stays_on_mac" : "unknown_request");
    // A phone unpaired while its session was open is answered by nothing: the host closes its channels too.
    if (!this.#deps.phones.has(deviceId)) return refuse("unknown_device");
    switch (name as RequestName) {
      case "list":
        return [{ t: "chats", id, chats: this.#deps.chats.list().map(chatRow) }];
      case "open":
        return this.#open(deviceId, id, request, refuse);
      case "catchup":
        return this.#catchUp(deviceId, id, request, refuse);
      case "allow":
        return this.#allow(deviceId, id, request, refuse);
      case "reply":
        return this.#reply(deviceId, id, request, refuse);
      case "stop":
        return this.#stop(deviceId, id, request, refuse);
    }
  }

  #watch(deviceId: string, source: ChatSource): { view: ChatView; cursor: Cursor } {
    const view = this.#projector.view(source);
    const watched = this.#watched.get(source.key);
    if (watched) {
      // Bring the journal up to now first, so the snapshot's cursor and the events after it meet exactly.
      this.#advance(source.key, watched, view);
      watched.devices.add(deviceId);
    } else {
      this.#watched.set(source.key, { view, devices: new Set([deviceId]) });
    }
    return { view, cursor: this.#journal.open(source.key) };
  }

  #open(deviceId: string, id: number, request: Message, refuse: (r: Refusal) => Message[]): Message[] {
    const chat = text(request.chat);
    const source = chat === null ? null : this.#deps.chats.get(chat);
    if (!source) return refuse("no_chat");
    const { view, cursor } = this.#watch(deviceId, source);
    return [{ t: "chat", id, view, cursor }];
  }

  #catchUp(deviceId: string, id: number, request: Message, refuse: (r: Refusal) => Message[]): Message[] {
    const chat = text(request.chat);
    const source = chat === null ? null : this.#deps.chats.get(chat);
    if (!source) return refuse("no_chat");
    const after = cursorOf(request.cursor);
    // Bring the journal up to now before reading it.
    const watched = this.#watched.get(source.key);
    if (watched) this.#advance(source.key, watched, this.#projector.view(source));
    const caught = this.#journal.catchUp(source.key, after);
    if (caught.kind === "snapshot" || !watched) {
      const { view, cursor } = this.#watch(deviceId, source);
      return [{ t: "chat", id, view, cursor }];
    }
    watched.devices.add(deviceId);
    const cursor = this.#journal.cursor(source.key);
    return [{ t: "events", id, chat: source.key, events: caught.events, cursor }];
  }

  /** Where an Allow or a No may go: the ask open, the revision the person saw, an option the phone may choose. */
  #approval(chat: string | null, askId: string | null): { source: ChatSource; ask: Extract<AskView, { kind: "approval" }> } | Refusal {
    const source = chat === null ? null : this.#deps.chats.get(chat);
    if (!source) return "no_chat";
    const ask = askId === null ? null : this.#projector.ask(source, askId);
    if (!ask || ask.kind !== "approval") return "no_ask";
    if (ask.needsUpdate) return "needs_update";
    if (!ask.open) return "ask_closed";
    return { source, ask };
  }

  async #allow(deviceId: string, id: number, request: Message, refuse: (r: Refusal) => Message[]): Promise<Message[]> {
    const option = request.option ?? "once";
    if (option !== "once") return refuse(typeof option === "string" && STAYS_ON_MAC.has(option) ? "stays_on_mac" : "not_offered");
    const chat = text(request.chat);
    const askId = text(request.ask);
    const revision = request.revision;
    if (chat === null || askId === null || typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 1) return refuse("malformed");
    if (request.answer === undefined) {
      // Step one: a challenge for this device, this ask, the revision it saw and Allow once.
      const found = this.#approval(chat, askId);
      if (typeof found === "string") return refuse(found);
      if (found.ask.revision !== revision) return refuse("changed");
      if (!found.ask.offers.includes("once")) return refuse("not_offered");
      try {
        const issued = await this.#deps.challenges.issue({ deviceId, requestId: askBinding(chat, askId), revision, optionId: "once" }, this.#deps.now());
        return [{ t: "challenge", id, chat, ask: askId, revision, option: "once", nonce: toBase64Url(issued.nonce), expiresAt: issued.expiresAt }];
      } catch (error) {
        return refuse(error instanceof RemoteChannelError && error.problem === "busy" ? "busy" : "malformed");
      }
    }
    // Step two, one at a time for this device.
    const previous = this.#allowChains.get(deviceId) ?? Promise.resolve();
    const run = previous.then(() => this.#settleAllow(deviceId, id, chat, askId, revision, request.answer, refuse));
    this.#allowChains.set(deviceId, run.catch(() => undefined));
    return run;
  }

  async #settleAllow(deviceId: string, id: number, chat: string, askId: string, revision: number, raw: unknown, refuse: (r: Refusal) => Message[]): Promise<Message[]> {
    const body = raw !== null && typeof raw === "object" && !Array.isArray(raw) ? (raw as Message) : null;
    const credentialId = bytes(body?.credentialId);
    const clientDataJSON = bytes(body?.clientDataJSON);
    const authenticatorData = bytes(body?.authenticatorData);
    const signature = bytes(body?.signature);
    const challengeId = text(body?.challengeId, 64);
    if (!credentialId || !clientDataJSON || !authenticatorData || !signature || challengeId === null) return refuse("malformed");
    const passkey = this.#deps.phones.passkey(deviceId);
    if (!passkey) return refuse("unknown_device");
    const answer: DecisionAnswer = { challengeId, requestId: askBinding(chat, askId), revision, optionId: "once", credentialId, clientDataJSON, authenticatorData, signature };
    const now = this.#deps.now();
    // The challenge is spent here, before anything else, whatever the answer brings.
    const checked = await this.#deps.challenges.verify(answer, { deviceId, passkey, rp: this.#deps.rp, now });
    if (!checked.ok) return refuse(checked.refused);
    try {
      await this.#deps.phones.seen(deviceId, now, checked.signCount);
    } catch {
      // A counter the keychain would not take is not acted on.
      return refuse("counter");
    }
    // The ask may have moved on while the person looked at Face ID: what is allowed must be what they saw.
    if (!this.#mayAct(deviceId)) return refuse("unknown_device");
    const found = this.#approval(chat, askId);
    if (typeof found === "string") return refuse(found);
    if (found.ask.revision !== revision) return refuse("changed");
    const why = await this.#deps.actions.allowOnce(chat, askId, deviceId);
    return why === null ? [{ t: "done", id }] : refuse("not_taken");
  }

  async #reply(deviceId: string, id: number, request: Message, refuse: (r: Refusal) => Message[]): Promise<Message[]> {
    const chat = text(request.chat);
    const askId = text(request.ask);
    const source = chat === null ? null : this.#deps.chats.get(chat);
    if (chat === null || askId === null) return refuse("malformed");
    if (!source) return refuse("no_chat");
    const ask = this.#projector.ask(source, askId);
    if (!ask) return refuse("no_ask");
    if (ask.kind === "approval") {
      if (request.no !== true) return refuse("malformed");
      const found = this.#approval(chat, askId);
      if (typeof found === "string") return refuse(found);
      if (request.revision !== found.ask.revision) return refuse("changed");
      if (!found.ask.offers.includes("deny")) return refuse("not_offered");
      if (!this.#mayAct(deviceId)) return refuse("unknown_device");
      const why = await this.#deps.actions.decline(chat, askId, deviceId);
      return why === null ? [{ t: "done", id }] : refuse("not_taken");
    }
    if (!ask.open) return refuse("ask_closed");
    if (request.revision !== ask.revision) return refuse("changed");
    let answer: string | Record<string, string | null>;
    if (ask.questions?.length) {
      const given = request.answers;
      if (given === null || typeof given !== "object" || Array.isArray(given)) return refuse("malformed");
      const entries = Object.entries(given as Record<string, unknown>);
      const ids = new Set(ask.questions.map((q) => q.id));
      if (entries.length !== ids.size || entries.some(([qid, value]) => !ids.has(qid) || (value !== null && text(value, MAX_ANSWER_CHARS) === null))) {
        return refuse("malformed");
      }
      answer = Object.fromEntries(entries) as Record<string, string | null>;
    } else {
      const given = text(request.answer, MAX_ANSWER_CHARS);
      if (given === null) return refuse("malformed");
      answer = given;
    }
    if (!this.#mayAct(deviceId)) return refuse("unknown_device");
    const why = await this.#deps.actions.answer(chat, askId, answer, deviceId);
    return why === null ? [{ t: "done", id }] : refuse("not_taken");
  }

  async #stop(deviceId: string, id: number, request: Message, refuse: (r: Refusal) => Message[]): Promise<Message[]> {
    const chat = text(request.chat);
    const source = chat === null ? null : this.#deps.chats.get(chat);
    if (!source) return refuse("no_chat");
    if (!source.working) return refuse("no_turn");
    if (!this.#mayAct(deviceId)) return refuse("unknown_device");
    const why = await this.#deps.actions.stop(source.key);
    return why === null ? [{ t: "done", id }] : refuse("not_taken");
  }

  /** Checked again right before acting: the phone may have been unpaired, or the switch turned off, while this waited. */
  #mayAct(deviceId: string): boolean {
    return !this.#closed && this.#deps.phones.has(deviceId);
  }

  #advance(chat: string, watched: { view: ChatView; devices: Set<string> }, view: ChatView): { event: ChatEvent; cursor: Cursor }[] {
    const out: { event: ChatEvent; cursor: Cursor }[] = [];
    for (const event of chatEvents(watched.view, view)) {
      const cursor = this.#journal.record(chat, event);
      if (cursor) out.push({ event, cursor });
    }
    watched.view = view;
    return out;
  }

  /** The store changed: each chat a phone has open is projected again, its changes numbered in the journal and sent, as
   *  they happen, to every device watching it. */
  publish(): void {
    for (const [chat, watched] of this.#watched) {
      const source = this.#deps.chats.get(chat);
      if (!source) continue;
      for (const { event, cursor } of this.#advance(chat, watched, this.#projector.view(source))) {
        for (const device of watched.devices) this.#deps.push(device, { t: "event", chat, event, cursor });
      }
    }
  }

  /** A device has no channel open any more: it stops watching, and a chat no one watches has its journal closed. */
  left(deviceId: string): void {
    for (const [chat, watched] of this.#watched) {
      watched.devices.delete(deviceId);
      if (watched.devices.size === 0) {
        this.#watched.delete(chat);
        this.#journal.close(chat);
        this.#projector.forget(chat);
      }
    }
  }

  /** Everything ends: the switch went off. */
  clear(): void {
    this.#closed = true;
    this.#watched.clear();
    this.#journal.clear();
    this.#allowChains.clear();
  }

  /** The chats a device watches, for tests. */
  watching(deviceId: string): string[] {
    return [...this.#watched.entries()].filter(([, w]) => w.devices.has(deviceId)).map(([chat]) => chat);
  }
}
