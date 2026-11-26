/// Practice mode's pretend Mac (docs/web-app.md, "Practice mode"): the Your Mac tab with no relay, no camera and no
/// passkey. Any pasted text pairs, the four digits are 4821 and the person presses "Type them for me" in place of typing
/// them at a Mac, the passkey is pretend (the browser is never asked for one), and the Mac's three chats answer Allow
/// once, No, an answer and Stop as the real Mac's serve.ts does, with events numbered as its journal numbers them. The
/// phone goes "offline" with the browser, so the greyed view can be seen. Nothing leaves the page and nothing is kept:
/// the pairing lives in memory and goes with a reload.
import { importSharedSecret } from "@manut/remote-channel";
import type { PairStep } from "./pair";
import type { Passkeys } from "./passkeys";
import { type Timers, systemTimers } from "./relay";
import type { MacBackend } from "./remote";
import type { MacLink, Message, SessionEnd } from "./session";
import { memoryVault } from "./vault";
import type { AskView, ChatEvent, ChatView } from "./wire";

export const PRACTICE_DIGITS = "4821";
/// `/app/?demo=mac-off` shows the tab as it is wherever the relay is off.
export const PRACTICE_MAC_OFF = "demo=mac-off";

/// The pretend Mac's chats, as the real Mac would show them, timed a little before `now` (seconds, as the Mac's are).
function sampleChats(now: number): ChatView[] {
  const ago = (minutes: number) => Math.floor(now / 1000) - minutes * 60;
  return [
    {
      chat: "launch",
      title: "Shop launch plan",
      state: "needs_you",
      step: "Waiting for your answer",
      messages: [
        { id: "l1", role: "user", text: "Plan the October sale and tell every customer on LINE.", ts: ago(14) },
        {
          id: "l2",
          role: "assistant",
          text: "I drafted the LINE broadcast. It goes to all 412 customers once you allow it. The sale page is at https://baanmali.example/sale.",
          ts: ago(12),
        },
      ],
      asks: [
        {
          kind: "approval",
          id: "broadcast",
          revision: 1,
          open: true,
          ts: ago(12),
          title: "Send a LINE broadcast",
          command: 'line broadcast --to all-customers --text "October sale: 20% off everything, Friday to Sunday. Show this message at the till."',
          cwd: "/Users/fon/shop",
          offers: ["once", "deny"],
        },
        {
          kind: "question",
          id: "day",
          revision: 1,
          open: true,
          ts: ago(11),
          question: "Which day should the sale start?",
          choices: ["Friday", "Saturday"],
        },
      ],
    },
    {
      chat: "prices",
      title: "Price list for October",
      state: "working",
      step: "Comparing the suppliers' prices",
      messages: [{ id: "p1", role: "user", text: "Update the price list from the new supplier sheets.", ts: ago(40) }],
      asks: [],
    },
    {
      chat: "site",
      title: "Tidy the shop's website",
      state: "done",
      step: null,
      messages: [
        { id: "s1", role: "user", text: "Fix the opening hours on the website.", ts: ago(190) },
        { id: "s2", role: "assistant", text: "Done. The website now says 9:00 to 18:00, every day but Monday.", ts: ago(185) },
      ],
      asks: [],
    },
  ];
}

const isOpen = (view: ChatView) => view.asks.some((a) => a.open);

/// The pretend Mac's session: the six requests, and an event for each change to a chat the phone opened.
class PracticeLink implements MacLink {
  onEvent: ((message: Message) => void) | null = null;
  onEnd: ((end: SessionEnd) => void) | null = null;
  readonly #chats: ChatView[];
  readonly #journal = `practice-${Math.random().toString(36).slice(2)}`;
  readonly #seq = new Map<string, number>();
  readonly #timers: Timers;
  #closed = false;
  readonly #offline = () => this.#end({ why: "lost" });

  constructor(chats: ChatView[], timers: Timers) {
    this.#chats = chats;
    this.#timers = timers;
    if (typeof window !== "undefined") window.addEventListener("offline", this.#offline);
  }

  #end(end: SessionEnd): void {
    if (this.#closed) return;
    this.#closed = true;
    if (typeof window !== "undefined") window.removeEventListener("offline", this.#offline);
    this.onEnd?.(end);
  }

  close(): void {
    this.#end({ why: "closed" });
  }

  #cursor(chat: string) {
    return { journal: this.#journal, seq: this.#seq.get(chat) ?? 0 };
  }

  #change(chat: string, change: (view: ChatView) => { view: ChatView; events: ChatEvent[] }): void {
    const at = this.#chats.findIndex((c) => c.chat === chat);
    if (at === -1) return;
    const { view, events } = change(this.#chats[at]!);
    this.#chats[at] = view;
    if (!this.#seq.has(chat)) return;
    // As the real Mac's journal does, a little after the answer that caused them.
    this.#timers.set(() => {
      for (const event of events) {
        if (this.#closed) return;
        this.#seq.set(chat, (this.#seq.get(chat) ?? 0) + 1);
        this.onEvent?.({ t: "event", chat, event, cursor: this.#cursor(chat) });
      }
    }, 150);
  }

  #settleAsk(chat: string, id: string, outcome: "allowed" | "declined" | "answered"): void {
    this.#change(chat, (view) => {
      const asks = view.asks.map((a): AskView => (a.id !== id ? a : a.kind === "approval" ? { ...a, open: false, outcome: outcome === "declined" ? "declined" : "allowed" } : { ...a, open: false, outcome: "answered" }));
      const settled = asks.find((a) => a.id === id)!;
      const next: ChatView = { ...view, asks };
      const state: ChatView["state"] = isOpen(next) ? "needs_you" : outcome === "declined" ? "done" : "working";
      const step = state === "working" ? "Sending the broadcast" : state === "needs_you" ? view.step : null;
      return { view: { ...next, state, step }, events: [{ k: "ask", ask: settled }, { k: "state", state, step, title: view.title }] };
    });
  }

  async request(message: Message): Promise<Message | null> {
    await new Promise<void>((resolve) => this.#timers.set(resolve, 200));
    if (this.#closed) return null;
    const chat = typeof message.chat === "string" ? this.#chats.find((c) => c.chat === message.chat) : undefined;
    const refuse = (reason: string) => ({ t: "refused", request: message.t, reason });
    switch (message.t) {
      case "list":
        return { t: "chats", chats: this.#chats.map((c) => ({ chat: c.chat, title: c.title, state: c.state, updatedAt: Math.max(...c.messages.map((x) => x.ts), ...c.asks.map((x) => x.ts)) })) };
      case "open":
      case "catchup":
        if (!chat) return refuse("no_chat");
        this.#seq.set(chat.chat, this.#seq.get(chat.chat) ?? 0);
        return { t: "chat", view: chat, cursor: this.#cursor(chat.chat) };
      case "allow": {
        const ask = chat?.asks.find((a) => a.id === message.ask);
        if (!chat || ask?.kind !== "approval") return refuse("no_ask");
        if (!ask.open) return refuse("ask_closed");
        if (message.answer === undefined) {
          const nonce = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
          return { t: "challenge", chat: chat.chat, ask: ask.id, revision: ask.revision, option: "once", nonce, expiresAt: Date.now() + 60_000 };
        }
        this.#settleAsk(chat.chat, ask.id, "allowed");
        return { t: "done" };
      }
      case "reply": {
        const ask = chat?.asks.find((a) => a.id === message.ask);
        if (!chat || !ask) return refuse("no_ask");
        if (!ask.open) return refuse("ask_closed");
        this.#settleAsk(chat.chat, ask.id, ask.kind === "approval" ? "declined" : "answered");
        return { t: "done" };
      }
      case "stop":
        if (!chat) return refuse("no_chat");
        if (chat.state !== "working") return refuse("no_turn");
        this.#change(chat.chat, (view) => ({ view: { ...view, state: "done", step: null }, events: [{ k: "state", state: "done", step: null, title: view.title }] }));
        return { t: "done" };
      default:
        return refuse("unknown_request");
    }
  }
}

/// A passkey that is never the browser's: practice asks for no Face ID.
const practicePasskeys: Passkeys = {
  available: true,
  create: async () => ({ credentialId: new Uint8Array(16).fill(1), clientDataJSON: new Uint8Array(0), authenticatorData: new Uint8Array(0) }),
  get: async () => ({ credentialId: new Uint8Array(16).fill(1), clientDataJSON: new Uint8Array(0), authenticatorData: new Uint8Array(0), signature: new Uint8Array(0) }),
};

export interface PracticeBackend extends MacBackend {
  /// Stands for the person typing the four digits at the Mac.
  typeDigits(): void;
}

export function practiceBackend(options: { relay?: "on" | "off"; timers?: Timers } = {}): PracticeBackend {
  const timers = options.timers ?? systemTimers;
  const vault = memoryVault();
  const chats = sampleChats(Date.now());
  let typed: (() => void) | null = null;
  const wait = (ms: number) => new Promise<void>((resolve) => timers.set(resolve, ms));
  return {
    relay: async () => options.relay ?? "on",
    vault,
    passkeys: practicePasskeys,
    now: () => Date.now(),
    timers,
    typeDigits: () => typed?.(),
    pair: async (text, onStep: (step: PairStep) => void) => {
      if (text.trim() === "") return { ok: false, why: "bad_link" };
      onStep({ step: "connecting" });
      await wait(400);
      onStep({ step: "digits", digits: PRACTICE_DIGITS });
      await new Promise<void>((resolve) => (typed = resolve));
      typed = null;
      await new Promise<void>((resolve) => onStep({ step: "passkey", make: resolve, cancelled: false }));
      onStep({ step: "finishing" });
      await wait(300);
      const mac = {
        hostId: "P".repeat(43),
        deviceId: "0B6A2C1E-4D5F-4A6B-8C7D-9E0F1A2B3C4D",
        doorToken: new Uint8Array(32),
        k: await importSharedSecret(crypto.getRandomValues(new Uint8Array(32))),
        credentialId: new Uint8Array(16).fill(1),
        rpId: typeof location === "undefined" ? "localhost" : location.hostname,
        pairedAt: Date.now(),
      };
      await vault.save(mac);
      return { ok: true, mac };
    },
    connect: async () => {
      await wait(300);
      if (typeof navigator !== "undefined" && navigator.onLine === false) return { ok: false, end: { why: "lost" } };
      return { ok: true, link: new PracticeLink(chats, timers) };
    },
  };
}
