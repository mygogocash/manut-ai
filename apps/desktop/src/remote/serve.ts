// The only code that turns a paired phone's request into something the Mac does (docs/remote-access.md, "The first
// version"). A phone may ask for exactly seven things, and anything else is refused by name:
//
//   list      the chats, each Working, Needs you or Done
//   open      one chat: its messages, its current step and its asks, with a cursor into its journal
//   catchup   what a chat did since a cursor, or the whole chat again when the journal no longer holds the range
//   allow     Allow once, in two steps: the Mac issues a one-use challenge bound to the device, the ask, its revision and
//             the choice, and the phone answers it with a passkey (Face ID or the passcode). Only an answer
//             `DecisionChallenges.verify` says `ok` to reaches `settleApproval`, with the phone's device id as who decided.
//   reply     No to an approval, with no challenge; or the answer to a question, in the same two steps as Allow, the
//             challenge bound to the exact answer (the package's `answerOption`), since an answer steers the agent as much
//             as an Allow does. A stolen unlocked phone can say No and Stop, and nothing else.
//   stop      stop the chat's running turn
//   notify    this phone's push address, or null to take it away (item 78d): the relay may then wake this same phone
//             with a push that carries nothing. It needs no passkey: it acts on nothing of the Mac's and reaches no one
//             but the phone that asked, and only an address on a known push service is taken (`push_address`).
//
// Always allow, Allow for the session, Kit's dial, pairing, Unpair and the switch stay on the Mac whatever a phone sends
// (`STAYS_ON_MAC`), and an ask the card marks as needing an app update is answered by nothing. Who is speaking is always
// the channel's own device id (the package's `channel.deviceId`), never anything the relay or the request says.
//
// Messages in the channel are JSON. Every request carries a number `id` the phone chose, and every answer names it:
//   phone -> Mac   {"t":"allow","id",chat,ask,revision}, then again with "option":"once" and "answer":<passkey answer>
//                  {"t":"reply","id",chat,ask,revision,"no":true}
//                  {"t":"reply","id",chat,ask,revision,"answer":<text>} or with "answers":{<question id>:<text or null>}
//                  for an interview, then again with the same answer and "passkey":<passkey answer>
//                  {"t":"notify","id","endpoint":<push address or null>}
//                  where a passkey answer is {challengeId,credentialId,clientDataJSON,authenticatorData,signature}
//                  (base64url, challengeId being the challenge's nonce)
//   Mac -> phone   {"t":"chats","id",chats} | {"t":"chat","id",view,cursor} | {"t":"events","id",chat,events,cursor}
//                  {"t":"challenge","id",chat,ask,revision,option,nonce,expiresAt} | {"t":"done","id"}
//                  {"t":"refused","id",request,reason}
//   and, unasked, {"t":"event",chat,event,cursor} for each change to a chat the phone has open. A challenge's `option` is
//   `once` for an Allow and `answerOption(answer)` for an answer; the phone computes it itself from what it shows.
import {
  type DecisionChallenges,
  type QuestionAnswer,
  type RelyingParty,
  type StoredPasskey,
  RemoteChannelError,
  answerOption,
  fromBase64Url,
  toBase64Url,
} from "@manut/remote-channel";
import { type Cursor, EventJournal } from "./journal";
import { type AskView, type ChatEvent, type ChatSource, type ChatView, Projector, askBinding, chatEvents, chatRow } from "./project";

/** The seven requests a phone may make. */
export const REQUESTS = ["list", "open", "catchup", "allow", "reply", "stop", "notify"] as const;
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
  /** The revisions and what each phone was shown, kept by the RemoteMac across this server's life (project.ts). */
  readonly projector?: Projector;
  /** Keeps a device's push address, or forgets it with null (item 78d, host.ts); null when taken, otherwise why not.
   *  Without it `notify` is not offered. */
  notify?(deviceId: string, endpoint: string | null): Refusal | null;
}

type Message = Record<string, unknown>;

const MAX_ANSWER_CHARS = 8_000;

/** The asks among some events, for noting what a phone was sent. */
function asksOf(events: readonly ChatEvent[]): AskView[] {
  return events.flatMap((event) => (event.k === "ask" ? [event.ask] : []));
}
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
  readonly #projector: Projector;
  readonly #journal: EventJournal<ChatEvent>;
  /** Per chat a phone has open: what it was last sent, and which devices watch it. */
  readonly #watched = new Map<string, { view: ChatView; devices: Set<string> }>();
  /** One device's passkey answers (Allow and answers to questions) are checked one at a time, so its passkey counters
   *  are stored in the order checked. */
  readonly #decisionChains = new Map<string, Promise<unknown>>();
  /** Set when the switch goes off: nothing that was awaiting acts after it. */
  #closed = false;

  constructor(deps: ServeDeps) {
    this.#deps = deps;
    this.#journal = deps.journal ?? new EventJournal<ChatEvent>();
    this.#projector = deps.projector ?? new Projector();
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
      case "notify":
        return this.#notify(deviceId, id, request, refuse);
    }
  }

  /** This phone's push address, or null to take it away: only ever for the device the channel proved. */
  #notify(deviceId: string, id: number, request: Message, refuse: (r: Refusal) => Message[]): Message[] {
    const endpoint = request.endpoint;
    if (endpoint !== null && typeof endpoint !== "string") return refuse("malformed");
    if (!this.#deps.notify) return refuse("not_offered");
    if (!this.#mayAct(deviceId)) return refuse("unknown_device");
    const why = this.#deps.notify(deviceId, endpoint);
    return why === null ? [{ t: "done", id }] : refuse(why);
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
    this.#projector.sent(deviceId, source.key, view.asks);
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
    this.#projector.sent(deviceId, source.key, asksOf(caught.events.map((e) => e.event)));
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
      if (found.ask.revision !== revision || !this.#projector.wasShown(deviceId, chat, askId, revision)) return refuse("changed");
      if (!found.ask.offers.includes("once")) return refuse("not_offered");
      try {
        const issued = await this.#deps.challenges.issue({ deviceId, requestId: askBinding(chat, askId), revision, optionId: "once" }, this.#deps.now());
        return [{ t: "challenge", id, chat, ask: askId, revision, option: "once", nonce: toBase64Url(issued.nonce), expiresAt: issued.expiresAt }];
      } catch (error) {
        return refuse(error instanceof RemoteChannelError && error.problem === "busy" ? "busy" : "malformed");
      }
    }
    // Step two, one at a time for this device.
    return this.#oneAtATime(deviceId, async () => {
      const why = await this.#checkPasskey(deviceId, { chat, askId, revision, optionId: "once" }, request.answer);
      if (why !== null) return refuse(why);
      // The ask may have moved on while the person looked at Face ID: what is allowed must be what they saw.
      if (!this.#mayAct(deviceId)) return refuse("unknown_device");
      const found = this.#approval(chat, askId);
      if (typeof found === "string") return refuse(found);
      if (found.ask.revision !== revision) return refuse("changed");
      const taken = await this.#deps.actions.allowOnce(chat, askId, deviceId);
      return taken === null ? [{ t: "done", id }] : refuse("not_taken");
    });
  }

  /** Runs one device's step two after its earlier ones, so its passkey counters are stored in the order checked. */
  #oneAtATime(deviceId: string, step: () => Promise<Message[]>): Promise<Message[]> {
    const previous = this.#decisionChains.get(deviceId) ?? Promise.resolve();
    const run = previous.then(step);
    this.#decisionChains.set(deviceId, run.catch(() => undefined));
    return run;
  }

  /** Checks a phone's passkey answer to the challenge issued for exactly this device, ask, revision and choice, and stores
   *  its counter. Null when it holds; otherwise why not. The challenge is spent whatever the answer brings. */
  async #checkPasskey(deviceId: string, bound: { chat: string; askId: string; revision: number; optionId: string }, raw: unknown): Promise<Refusal | null> {
    const body = raw !== null && typeof raw === "object" && !Array.isArray(raw) ? (raw as Message) : null;
    const credentialId = bytes(body?.credentialId);
    const clientDataJSON = bytes(body?.clientDataJSON);
    const authenticatorData = bytes(body?.authenticatorData);
    const signature = bytes(body?.signature);
    const challengeId = text(body?.challengeId, 64);
    if (!credentialId || !clientDataJSON || !authenticatorData || !signature || challengeId === null) return "malformed";
    const passkey = this.#deps.phones.passkey(deviceId);
    if (!passkey) return "unknown_device";
    const answer = { challengeId, requestId: askBinding(bound.chat, bound.askId), revision: bound.revision, optionId: bound.optionId, credentialId, clientDataJSON, authenticatorData, signature };
    const now = this.#deps.now();
    const checked = await this.#deps.challenges.verify(answer, { deviceId, passkey, rp: this.#deps.rp, now });
    if (!checked.ok) return checked.refused;
    try {
      await this.#deps.phones.seen(deviceId, now, checked.signCount);
    } catch {
      // A counter the keychain would not take is not acted on.
      return "counter";
    }
    return null;
  }

  /** Where an answer may go: a question that is open. */
  #question(chat: string, askId: string): Extract<AskView, { kind: "question" }> | Refusal {
    const source = this.#deps.chats.get(chat);
    if (!source) return "no_chat";
    const ask = this.#projector.ask(source, askId);
    if (!ask || ask.kind !== "question") return "no_ask";
    if (!ask.open) return "ask_closed";
    return ask;
  }

  /** The answer a request carries for `ask`, in the form the store takes and the form the challenge binds; null when it
   *  is not exactly one text, or for an interview a text or null for each of its questions and nothing else. */
  #readAnswer(ask: Extract<AskView, { kind: "question" }>, request: Message): { answer: string | Record<string, string | null>; bound: QuestionAnswer } | null {
    if (ask.questions?.length) {
      const given = request.answers;
      if (given === null || typeof given !== "object" || Array.isArray(given)) return null;
      const entries = Object.entries(given as Record<string, unknown>);
      const ids = new Set(ask.questions.map((q) => q.id));
      if (entries.length !== ids.size || entries.some(([qid, value]) => !ids.has(qid) || (value !== null && text(value, MAX_ANSWER_CHARS) === null))) return null;
      const values = new Map(entries as [string, string | null][]);
      // In the order the ask lists its questions, which the phone shows too, never the order the phone sent them in.
      const bound = [...ids].map((qid) => [qid, values.get(qid) ?? null] as const);
      return { answer: Object.fromEntries(bound), bound };
    }
    const given = text(request.answer, MAX_ANSWER_CHARS);
    return given === null ? null : { answer: given, bound: given };
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
      // No stays free: it can only stop something, never start it.
      if (request.no !== true) return refuse("malformed");
      const found = this.#approval(chat, askId);
      if (typeof found === "string") return refuse(found);
      if (request.revision !== found.ask.revision || !this.#projector.wasShown(deviceId, chat, askId, found.ask.revision)) return refuse("changed");
      if (!found.ask.offers.includes("deny")) return refuse("not_offered");
      if (!this.#mayAct(deviceId)) return refuse("unknown_device");
      const why = await this.#deps.actions.decline(chat, askId, deviceId);
      return why === null ? [{ t: "done", id }] : refuse("not_taken");
    }
    // An answer steers the agent as much as an Allow, so it takes the same challenge, bound to the exact words.
    if (!ask.open) return refuse("ask_closed");
    const revision = request.revision;
    if (typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 1) return refuse("malformed");
    if (revision !== ask.revision || !this.#projector.wasShown(deviceId, chat, askId, revision)) return refuse("changed");
    const read = this.#readAnswer(ask, request);
    if (read === null) return refuse("malformed");
    const optionId = await answerOption(read.bound);
    if (request.passkey === undefined) {
      // Step one: a challenge for this device, this question, the revision it saw and these words.
      try {
        const issued = await this.#deps.challenges.issue({ deviceId, requestId: askBinding(chat, askId), revision, optionId }, this.#deps.now());
        return [{ t: "challenge", id, chat, ask: askId, revision, option: optionId, nonce: toBase64Url(issued.nonce), expiresAt: issued.expiresAt }];
      } catch (error) {
        return refuse(error instanceof RemoteChannelError && error.problem === "busy" ? "busy" : "malformed");
      }
    }
    // Step two, one at a time for this device: the words sent now must be the ones challenged and signed.
    return this.#oneAtATime(deviceId, async () => {
      const why = await this.#checkPasskey(deviceId, { chat, askId, revision, optionId }, request.passkey);
      if (why !== null) return refuse(why);
      if (!this.#mayAct(deviceId)) return refuse("unknown_device");
      const found = this.#question(chat, askId);
      if (typeof found === "string") return refuse(found);
      if (found.revision !== revision) return refuse("changed");
      const taken = await this.#deps.actions.answer(chat, askId, read.answer, deviceId);
      return taken === null ? [{ t: "done", id }] : refuse("not_taken");
    });
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
        for (const device of watched.devices) {
          this.#projector.sent(device, chat, asksOf([event]));
          this.#deps.push(device, { t: "event", chat, event, cursor });
        }
      }
    }
  }

  /** A device has no channel open any more: it stops watching, and a chat no one watches has its journal closed. The
   *  revisions stay (only asks gone from the store let go of what they showed), so a phone that comes back cannot answer
   *  an ask that changed while it was away at the revision it saw before. */
  left(deviceId: string): void {
    for (const [chat, watched] of this.#watched) {
      watched.devices.delete(deviceId);
      if (watched.devices.size === 0) {
        this.#watched.delete(chat);
        this.#journal.close(chat);
        this.#projector.retire(chat, this.#deps.chats.get(chat));
      }
    }
  }

  /** Everything ends: the switch went off. */
  clear(): void {
    this.#closed = true;
    this.#watched.clear();
    this.#journal.clear();
    this.#decisionChains.clear();
  }

  /** The chats a device watches, for tests. */
  watching(deviceId: string): string[] {
    return [...this.#watched.entries()].filter(([, w]) => w.devices.has(deviceId)).map(([chat]) => chat);
  }
}
