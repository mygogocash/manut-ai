/// The Your Mac tab's state, apart from how it is drawn (MacTab.tsx), so the API's tests can drive the same code
/// against the real relay and the desktop's own Mac (apps/api/test/remote-phone.test.ts). It pairs, keeps one session
/// open while the tab is in use, lists the chats, shows one, and does the four things a phone may do: Allow once, No,
/// answer a question, and stop the turn (docs/remote-access.md, "What a person does", step 5). Nothing else is offered:
/// no messages are sent, and Always allow, the dial and the rest stay on the Mac.
///
/// The rules it keeps:
/// - **Allow once leaves only as a passkey answer, and so does an answer to a question once the Mac asks for one.** The
///   Mac issues a one-use challenge for this phone, this ask, the revision on the screen and the choice; the phone
///   recomputes the challenge from what its own screen shows (`decisionChallenge`), asks the passkey to sign it, and
///   sends the signature. A challenge for anything else than what the screen shows is refused here before any prompt.
///   Both go through one function (`#decide`), with their fields in decision.ts.
/// - **Catch-up.** Every event carries the journal's cursor (apps/desktop/src/remote/journal.ts). The open chat keeps
///   the cursor of the last event it holds; after a reconnect, or an event that skips a number, it asks the Mac for
///   what came after, and takes the whole chat again when the Mac says the range is gone.
/// - **The greyed view.** While the Mac is not connected, what the phone last had stays on screen greyed, with no
///   answer offered, and is cleared from memory 15 minutes after the Mac last confirmed it (GoSpark's `docs/remote.md`).
/// - **Nothing of a chat is kept.** Chats, asks and messages are in this object only: never in storage, the address, a
///   log or a notification.
import { decisionChallenge, fromBase64Url } from "@manut/remote-channel";
import { type SignedDecision, allowDecision, answerDecision, proofOf } from "./decision";
import type { PairFailure, PairResult, PairStep } from "./pair";
import { PasskeyCancelled, type Passkeys } from "./passkeys";
import type { Timers } from "./relay";
import type { MacLink, Message, SessionEnd } from "./session";
import type { PairedMac, PhoneVault } from "./vault";
import {
  type AskView,
  type ChatRow,
  type ChatView,
  type Cursor,
  applyEvent,
  askBinding,
  readCursor,
  readEvent,
  readRow,
  readView,
} from "./wire";

/// How long a view the Mac no longer confirms stays on the phone, greyed.
export const CLEAR_MS = 15 * 60_000;
/// How often the list is read again while it is shown and the Mac is connected: the Mac sends events only for a chat
/// the phone has open.
export const LIST_MS = 20_000;
/// The wait before dialling again after a drop, doubling from the first to the last.
export const RETRY_FIRST_MS = 1_000;
export const RETRY_MAX_MS = 60_000;

/// What the tab needs from where it runs: the relay's switch, the vault, the passkey, pairing and sessions. The real
/// ones are the relay on this page's origin (setup.ts); practice mode has a pretend Mac (practice.ts).
export interface MacBackend {
  relay(): Promise<"on" | "off" | "unknown">;
  readonly vault: PhoneVault;
  readonly passkeys: Passkeys;
  pair(text: string, onStep: (step: PairStep) => void): Promise<PairResult>;
  connect(mac: PairedMac): Promise<{ ok: true; link: MacLink } | { ok: false; end: SessionEnd }>;
  now(): number;
  readonly timers: Timers;
}

/// What became of the person's answer to one ask, or why it waits on them. The tab says each in words.
export type AskNote =
  | "allowed"
  | "declined"
  | "answered"
  | "stopped"
  /// The passkey prompt was closed, or did not open: the person presses Confirm.
  | "confirm"
  | "passkey_failed"
  | "changed"
  | "closed"
  | "gone"
  | "not_offered"
  | "needs_update"
  | "busy"
  | "late"
  | "not_taken"
  | "no_turn"
  | "passkey_refused"
  | "forgotten"
  | "no_answer";

export interface AskState {
  readonly busy: "allow" | "no" | "answer" | null;
  readonly note: AskNote | null;
  /// Set while a challenge waits for the person's Face ID: calls the passkey prompt at once, so it must be called
  /// straight from a tap.
  readonly confirm: (() => void) | null;
}

export type LinkState = "connecting" | "live" | "down";

/// Why the Mac is not connected now.
export type DownWhy = SessionEnd["why"] | "offline";

export interface OpenChat {
  readonly view: ChatView;
  readonly asks: ReadonlyMap<string, AskState>;
  readonly stopping: boolean;
  readonly stopNote: AskNote | null;
}

export type MacView =
  | { readonly phase: "checking" }
  /// The relay is switched off, or this page cannot reach one.
  | { readonly phase: "unavailable" }
  | { readonly phase: "unpaired"; readonly failed: PairFailure | null }
  | { readonly phase: "pairing"; readonly step: PairStep }
  | {
      readonly phase: "paired";
      readonly link: LinkState;
      readonly down: DownWhy | null;
      /// When the Mac last confirmed what is shown, in ms; null before anything arrived.
      readonly confirmedAt: number | null;
      /// The view was cleared after 15 minutes without the Mac.
      readonly cleared: boolean;
      /// The Mac unpaired this phone.
      readonly forgotten: boolean;
      readonly chats: readonly ChatRow[] | null;
      readonly open: OpenChat | null;
      readonly forgetting: boolean;
    };

type Paired = Extract<MacView, { phase: "paired" }>;

const IDLE: AskState = { busy: null, note: null, confirm: null };

/// The Mac's refusal reasons (serve.ts, and every `DecisionChallenges.verify` refusal), as what the phone says.
export function noteFor(reason: unknown): AskNote {
  switch (reason) {
    case "changed":
      return "changed";
    case "ask_closed":
      return "closed";
    case "no_ask":
    case "no_chat":
      return "gone";
    case "not_offered":
    case "stays_on_mac":
    case "unknown_request":
      return "not_offered";
    case "needs_update":
      return "needs_update";
    case "busy":
      return "busy";
    case "expired":
    case "unknown":
      return "late";
    case "not_taken":
      return "not_taken";
    case "no_turn":
      return "no_turn";
    case "unknown_device":
      return "forgotten";
    case "malformed":
      return "no_answer";
    default:
      // Every passkey refusal (wrong_credential, no_verification, counter, bad_signature, ...).
      return "passkey_refused";
  }
}

export class MacRemote {
  readonly #backend: MacBackend;
  readonly #listeners = new Set<(view: MacView) => void>();
  #view: MacView = { phase: "checking" };
  #mac: PairedMac | null = null;
  #link: MacLink | null = null;
  #cursor: Cursor | null = null;
  #retry: unknown = null;
  #retryMs = RETRY_FIRST_MS;
  #clearTimer: unknown = null;
  #listTimer: unknown = null;
  #handshakeRefusals = 0;
  #visible = true;
  #online = true;
  #disposed = false;
  #generation = 0;

  constructor(backend: MacBackend) {
    this.#backend = backend;
  }

  get view(): MacView {
    return this.#view;
  }

  subscribe(listener: (view: MacView) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #show(view: MacView): void {
    this.#view = view;
    for (const listener of this.#listeners) listener(view);
  }

  #paired(change: (view: Paired) => Paired): void {
    if (this.#view.phase === "paired") this.#show(change(this.#view));
  }

  /// Opens the tab: whether the relay is on, and whether this phone has paired.
  async start(): Promise<void> {
    const generation = this.#generation;
    const relay = await this.#backend.relay().catch(() => "unknown" as const);
    if (generation !== this.#generation || this.#disposed) return;
    if (relay !== "on") return this.#show({ phase: "unavailable" });
    let mac: PairedMac | null = null;
    try {
      mac = await this.#backend.vault.load();
    } catch {
      mac = null;
    }
    if (generation !== this.#generation || this.#disposed) return;
    if (!mac) return this.#show({ phase: "unpaired", failed: null });
    this.#mac = mac;
    this.#show(this.#fresh());
    void this.#connect();
  }

  #fresh(): Paired {
    return { phase: "paired", link: "connecting", down: null, confirmedAt: null, cleared: false, forgotten: false, chats: null, open: null, forgetting: false };
  }

  /// Pairs with the code the person scanned or pasted. One try: whatever happens, this code is not used again.
  async pair(text: string): Promise<void> {
    if (this.#view.phase !== "unpaired") return;
    this.#show({ phase: "pairing", step: { step: "connecting" } });
    const result = await this.#backend.pair(text, (step) => {
      if (this.#view.phase === "pairing") this.#show({ phase: "pairing", step });
    });
    if (this.#disposed) return;
    if (!result.ok) return this.#show({ phase: "unpaired", failed: result.why });
    this.#mac = result.mac;
    this.#show(this.#fresh());
    void this.#connect();
  }

  /// Back to the code form after a failed pairing.
  again(): void {
    if (this.#view.phase === "unpaired" && this.#view.failed !== null) this.#show({ phase: "unpaired", failed: null });
  }

  async #connect(): Promise<void> {
    const mac = this.#mac;
    if (!mac || this.#link || this.#disposed || this.#view.phase !== "paired") return;
    if (this.#retry !== null) {
      this.#backend.timers.clear(this.#retry);
      this.#retry = null;
    }
    if (!this.#online) return this.#paired((v) => ({ ...v, link: "down", down: "offline" }));
    const generation = ++this.#generation;
    this.#paired((v) => ({ ...v, link: "connecting" }));
    const opened = await this.#backend.connect(mac);
    if (generation !== this.#generation || this.#disposed || this.#mac !== mac) {
      if (opened.ok) opened.link.close();
      return;
    }
    if (!opened.ok) {
      if (opened.end.why === "refused") this.#handshakeRefusals += 1;
      return this.#down(opened.end.why === "refused" && this.#handshakeRefusals < 2 ? "lost" : opened.end.why);
    }
    this.#handshakeRefusals = 0;
    this.#retryMs = RETRY_FIRST_MS;
    const link = opened.link;
    this.#link = link;
    link.onEvent = (message) => this.#onEvent(message);
    link.onEnd = (end) => {
      if (this.#link !== link) return;
      this.#link = null;
      this.#down(end.why);
    };
    this.#paired((v) => ({ ...v, link: "live", down: null, cleared: false, forgotten: false }));
    this.#confirmed();
    await this.#refresh();
  }

  /// The Mac answered: what is shown is current now.
  #confirmed(): void {
    if (this.#clearTimer !== null) {
      this.#backend.timers.clear(this.#clearTimer);
      this.#clearTimer = null;
    }
    this.#paired((v) => ({ ...v, confirmedAt: this.#backend.now() }));
  }

  /// The session ended: the view greys, is cleared 15 minutes after the Mac last confirmed it, and the phone dials
  /// again after a wait. A phone the relay or the Mac no longer knows (Unpair on the Mac revokes its door, and the
  /// relay refuses it from then on) says so, and dials only once a minute: the relay also forgets a Mac it has not seen
  /// for 30 days, and that Mac registers its phones again when it comes back.
  #down(why: DownWhy): void {
    if (this.#view.phase !== "paired") return;
    const forgotten = why === "revoked" || why === "unknown_door" || (why === "refused" && this.#handshakeRefusals >= 2);
    this.#paired((v) => ({
      ...v,
      link: "down",
      down: why,
      forgotten,
      open: v.open ? { ...v.open, asks: new Map([...v.open.asks].map(([id, a]) => [id, { ...a, busy: null, confirm: null }])), stopping: false } : null,
    }));
    this.#armClear();
    if (this.#listTimer !== null) {
      this.#backend.timers.clear(this.#listTimer);
      this.#listTimer = null;
    }
    if (!this.#visible || !this.#online) return;
    const wait = forgotten || why === "replaced" ? RETRY_MAX_MS : this.#retryMs;
    this.#retryMs = Math.min(RETRY_MAX_MS, this.#retryMs * 2);
    this.#retry = this.#backend.timers.set(() => {
      this.#retry = null;
      void this.#connect();
    }, wait);
  }

  #armClear(): void {
    if (this.#clearTimer !== null || this.#view.phase !== "paired") return;
    const at = this.#view.confirmedAt;
    if (at === null || this.#view.cleared) return;
    this.#clearTimer = this.#backend.timers.set(() => {
      this.#clearTimer = null;
      this.#checkClear();
    }, Math.max(0, at + CLEAR_MS - this.#backend.now()));
  }

  /// Clears what the Mac has not confirmed for 15 minutes. Also run when the app comes back into view, since a phone may
  /// not have run the timer while it slept.
  #checkClear(): void {
    const v = this.#view;
    if (v.phase !== "paired" || v.link === "live" || v.cleared || v.confirmedAt === null) return;
    if (this.#backend.now() - v.confirmedAt < CLEAR_MS) return this.#armClear();
    this.#cursor = null;
    this.#show({ ...v, cleared: true, chats: null, open: null });
  }

  /// The app came into view or went out of it. In view, a dropped session is dialled again at once.
  setVisible(visible: boolean): void {
    this.#visible = visible;
    if (!visible) return;
    this.#checkClear();
    if (this.#view.phase === "paired" && !this.#link) void this.#connect();
  }

  /// The phone said it went offline or came back.
  setOnline(online: boolean): void {
    this.#online = online;
    if (!online) {
      const link = this.#link;
      this.#link = null;
      link?.close();
      if (this.#view.phase === "paired") this.#down("offline");
      return;
    }
    if (this.#view.phase === "paired" && !this.#link) void this.#connect();
  }

  async #ask(message: Message): Promise<Message | null> {
    const link = this.#link;
    if (!link) return null;
    const answer = await link.request(message);
    if (answer && this.#link === link) this.#confirmed();
    return answer;
  }

  /// Reads the list, and catches the open chat up: just what it missed when the Mac still holds it, the whole chat
  /// again when not.
  async #refresh(): Promise<void> {
    const open = this.#view.phase === "paired" ? this.#view.open : null;
    if (open) await this.#catchUp(open.view.chat);
    await this.#readList();
  }

  async #readList(): Promise<void> {
    if (this.#listTimer !== null) {
      this.#backend.timers.clear(this.#listTimer);
      this.#listTimer = null;
    }
    const answer = await this.#ask({ t: "list" });
    if (answer?.t === "chats" && Array.isArray(answer.chats)) {
      const chats = answer.chats.map(readRow).filter((r): r is ChatRow => r !== null);
      this.#paired((v) => ({ ...v, chats }));
    }
    if (this.#link && this.#view.phase === "paired" && this.#view.open === null && this.#visible) {
      this.#listTimer = this.#backend.timers.set(() => {
        this.#listTimer = null;
        void this.#readList();
      }, LIST_MS);
    }
  }

  async #catchUp(chat: string): Promise<void> {
    const answer = await this.#ask({ t: "catchup", chat, cursor: this.#cursor });
    this.#take(chat, answer);
  }

  /// Takes the Mac's answer to `open` or `catchup`: a whole view with its cursor, or the events since the cursor held.
  #take(chat: string, answer: Message | null): void {
    if (!answer || this.#view.phase !== "paired") return;
    const open = this.#view.open;
    if (answer.t === "chat") {
      const view = readView(answer.view);
      const cursor = readCursor(answer.cursor);
      // Taken only while that chat is still the one on screen: the person may have gone back meanwhile.
      if (!view || !cursor || view.chat !== chat || open?.view.chat !== chat) return;
      this.#cursor = cursor;
      this.#paired((v) => (v.open?.view.chat === chat ? { ...v, open: { ...v.open, view } } : v));
      this.#row(view);
      return;
    }
    if (answer.t === "events" && Array.isArray(answer.events) && open?.view.chat === chat) {
      for (const item of answer.events) {
        const entry = item as { event?: unknown; cursor?: unknown } | null;
        this.#apply(chat, readEvent(entry?.event), readCursor(entry?.cursor));
      }
      return;
    }
    if (answer.t === "refused" && answer.reason === "no_chat") this.#paired((v) => ({ ...v, open: v.open?.view.chat === chat ? null : v.open }));
  }

  #row(view: ChatView): void {
    this.#paired((v) => ({ ...v, chats: v.chats?.map((r) => (r.chat === view.chat ? { ...r, title: view.title, state: view.state } : r)) ?? null }));
  }

  /// One event for the open chat, in order: a repeat is skipped, and a gap asks the Mac for what was missed.
  #apply(chat: string, event: ReturnType<typeof readEvent>, cursor: Cursor | null): boolean {
    const open = this.#view.phase === "paired" ? this.#view.open : null;
    if (!event || !cursor || !open || open.view.chat !== chat) return false;
    const held = this.#cursor;
    if (held && cursor.journal === held.journal && cursor.seq <= held.seq) return true;
    if (!held || cursor.journal !== held.journal || cursor.seq !== held.seq + 1) {
      void this.#catchUp(chat);
      return false;
    }
    this.#cursor = cursor;
    const view = applyEvent(open.view, event);
    this.#paired((v) => (v.open?.view.chat === chat ? { ...v, open: { ...v.open, view } } : v));
    if (event.k === "state") this.#row(view);
    return true;
  }

  #onEvent(message: Message): void {
    this.#confirmed();
    const chat = typeof message.chat === "string" ? message.chat : null;
    const event = readEvent(message.event);
    if (!chat || !event) return;
    const open = this.#view.phase === "paired" ? this.#view.open : null;
    if (open?.view.chat === chat) this.#apply(chat, event, readCursor(message.cursor));
    else if (event.k === "state") {
      // A chat opened earlier in this session is still watched; its row follows it.
      this.#paired((v) => ({ ...v, chats: v.chats?.map((r) => (r.chat === chat ? { ...r, title: event.title, state: event.state } : r)) ?? null }));
    }
  }

  /// Shows one chat: its messages, its current step and its asks.
  async openChat(chat: string): Promise<void> {
    if (this.#view.phase !== "paired") return;
    if (this.#listTimer !== null) {
      this.#backend.timers.clear(this.#listTimer);
      this.#listTimer = null;
    }
    const row = this.#view.chats?.find((r) => r.chat === chat);
    const placeholder: ChatView = { chat, title: row?.title ?? "", state: row?.state ?? "done", step: null, messages: [], asks: [] };
    this.#cursor = null;
    this.#paired((v) => ({ ...v, open: { view: placeholder, asks: new Map(), stopping: false, stopNote: null } }));
    const answer = await this.#ask({ t: "open", chat });
    this.#take(chat, answer);
  }

  /// Back to the list.
  closeChat(): void {
    if (this.#view.phase !== "paired" || !this.#view.open) return;
    this.#cursor = null;
    this.#paired((v) => ({ ...v, open: null }));
    void this.#readList();
  }

  #askState(id: string): AskState {
    return (this.#view.phase === "paired" && this.#view.open?.asks.get(id)) || IDLE;
  }

  #setAsk(chat: string, id: string, change: Partial<AskState>): void {
    this.#paired((v) => {
      if (v.open?.view.chat !== chat) return v;
      const asks = new Map(v.open.asks);
      asks.set(id, { ...(asks.get(id) ?? IDLE), ...change });
      return { ...v, open: { ...v.open, asks } };
    });
  }

  /// The ask as the screen shows it now, if it may be answered from here.
  #shown(id: string): { chat: string; ask: AskView } | null {
    const v = this.#view;
    if (v.phase !== "paired" || v.link !== "live" || !v.open) return null;
    const ask = v.open.view.asks.find((a) => a.id === id);
    return ask && ask.open ? { chat: v.open.view.chat, ask } : null;
  }

  /// Allow once: the Mac's challenge for this phone, this ask, the revision shown and Allow once, signed with the
  /// passkey. Nothing but that signature allows.
  async allowOnce(id: string): Promise<void> {
    const shown = this.#shown(id);
    if (!shown || shown.ask.kind !== "approval" || !shown.ask.offers.includes("once") || shown.ask.needsUpdate) return;
    await this.#decide(shown.chat, id, allowDecision(shown.chat, id, shown.ask.revision));
  }

  /// No: needs no passkey, as the package's README says.
  async no(id: string): Promise<void> {
    const shown = this.#shown(id);
    if (!shown || shown.ask.kind !== "approval" || !shown.ask.offers.includes("deny") || this.#askState(id).busy) return;
    const { chat, ask } = shown;
    this.#setAsk(chat, id, { busy: "no", note: null, confirm: null });
    const answer = await this.#ask({ t: "reply", chat, ask: id, revision: ask.revision, no: true });
    this.#setAsk(chat, id, { busy: null, note: !answer ? "no_answer" : answer.t === "done" ? "declined" : noteFor(answer.reason) });
  }

  /// The answer to a question: one text, or one per question of an interview (null for one skipped). It goes through
  /// the same challenge and passkey as Allow once, bound to the exact answer (decision.ts).
  async answer(id: string, given: string | Record<string, string | null>): Promise<void> {
    const shown = this.#shown(id);
    if (!shown || shown.ask.kind !== "question") return;
    const interview = !!shown.ask.questions?.length;
    if (interview !== (typeof given !== "string")) return;
    await this.#decide(shown.chat, id, await answerDecision(shown.chat, id, shown.ask.revision, given, shown.ask.questions?.map((q) => q.id) ?? []));
  }

  /// The one path for an answer the passkey signs (Allow once, and an answer to a question): step one asks; a Mac that
  /// needs no signature for it answers `done`; otherwise its challenge must be for exactly what the screen shows (this
  /// chat, this ask, the revision shown and this choice), or no prompt opens. The phone computes what the passkey signs
  /// from its own screen, never from the challenge, and sends the signature in step two.
  async #decide(chat: string, id: string, decision: SignedDecision): Promise<void> {
    const mac = this.#mac;
    const revision = decision.request.revision;
    if (!mac || this.#askState(id).busy || typeof revision !== "number") return;
    this.#setAsk(chat, id, { busy: decision.busy, note: null, confirm: null });
    const first = await this.#ask(decision.request);
    if (!first) return this.#setAsk(chat, id, { busy: null, note: "no_answer" });
    if (first.t === "done") return this.#setAsk(chat, id, { busy: null, note: decision.done });
    if (first.t === "refused") return this.#setAsk(chat, id, { busy: null, note: noteFor(first.reason) });
    const nonce = typeof first.nonce === "string" ? first.nonce : null;
    let nonceBytes: Uint8Array | null = null;
    try {
      nonceBytes = nonce ? fromBase64Url(nonce) : null;
    } catch {
      nonceBytes = null;
    }
    if (
      first.t !== "challenge" ||
      first.chat !== chat ||
      first.ask !== id ||
      first.revision !== revision ||
      first.option !== decision.optionId ||
      !nonce ||
      !nonceBytes ||
      nonceBytes.length !== 32
    ) {
      return this.#setAsk(chat, id, { busy: null, note: "no_answer" });
    }
    const signed = await decisionChallenge(nonceBytes, { deviceId: mac.deviceId, requestId: askBinding(chat, id), revision, optionId: decision.optionId });
    const settle = (answer: Message | null) =>
      this.#setAsk(chat, id, { busy: null, confirm: null, note: !answer ? "no_answer" : answer.t === "done" ? decision.done : noteFor(answer.reason) });
    const prompt = (): void => {
      // Started inside the person's tap when it comes from Confirm: the prompt opens before anything awaits.
      const asked = this.#backend.passkeys.get({ rpId: mac.rpId, challenge: signed, credentialId: mac.credentialId });
      this.#setAsk(chat, id, { busy: decision.busy, confirm: null });
      asked.then(
        async (passkey) => settle(await this.#ask({ ...decision.request, ...decision.second, [decision.proofField]: proofOf(nonce, passkey) })),
        (error: unknown) => {
          // A closed prompt, or one the browser would not open without a fresh tap: the challenge still holds, so the
          // person can confirm again while it lasts. The Mac refuses it once it ran out.
          if (error instanceof PasskeyCancelled) this.#setAsk(chat, id, { busy: null, note: "confirm", confirm: prompt });
          else this.#setAsk(chat, id, { busy: null, note: "passkey_failed", confirm: null });
        },
      );
    };
    prompt();
  }

  /// Stops the open chat's running turn.
  async stop(): Promise<void> {
    const v = this.#view;
    if (v.phase !== "paired" || v.link !== "live" || !v.open || v.open.stopping || v.open.view.state === "done") return;
    const chat = v.open.view.chat;
    this.#paired((p) => (p.open?.view.chat === chat ? { ...p, open: { ...p.open, stopping: true, stopNote: null } } : p));
    const answer = await this.#ask({ t: "stop", chat });
    const note: AskNote = !answer ? "no_answer" : answer.t === "done" ? "stopped" : noteFor(answer.reason);
    this.#paired((p) => (p.open?.view.chat === chat ? { ...p, open: { ...p.open, stopping: false, stopNote: note } } : p));
  }

  /// Forget this Mac: the session closes, the vault's record goes (K, the door token and the ids), and what was shown
  /// goes from memory. The Mac still lists this phone until it is unpaired there.
  async forget(): Promise<boolean> {
    if (this.#view.phase !== "paired" || this.#view.forgetting) return false;
    this.#paired((v) => ({ ...v, forgetting: true }));
    try {
      await this.#backend.vault.forget();
    } catch {
      this.#paired((v) => ({ ...v, forgetting: false }));
      return false;
    }
    this.#stopAll();
    this.#mac = null;
    this.#cursor = null;
    this.#show({ phase: "unpaired", failed: null });
    return true;
  }

  #stopAll(): void {
    this.#generation += 1;
    const link = this.#link;
    this.#link = null;
    link?.close();
    for (const timer of [this.#retry, this.#clearTimer, this.#listTimer]) if (timer !== null) this.#backend.timers.clear(timer);
    this.#retry = null;
    this.#clearTimer = null;
    this.#listTimer = null;
  }

  /// The tab went away: the session closes and nothing is kept.
  dispose(): void {
    this.#disposed = true;
    this.#stopAll();
    this.#listeners.clear();
  }
}
