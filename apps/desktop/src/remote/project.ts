// What a paired phone is shown of a chat (docs/remote-access.md, "What a person does", step 5): the chats as Working,
// Needs you or Done, and for one chat its messages, its current step and its asks. Everything here is plain data built
// from the store (fromStore.ts reads it) and every text in it goes through the one masker every surface of the app uses
// (lib/secrets.ts), so a token in a chat, a command or a step never reaches the phone; in a command or its folder, a
// key-shaped part of a path is shown, as on the Mac's card, since it names what runs or where (item 121). An ask is shown whole, with every
// field its card shows (the title, the whole command with its line breaks, the folder, the plan, who asks), never cut
// short. The command and the folder go through `showCommand`, which masks a key and never anything the shell acts on, so
// what a person allows is what runs (item 117). A command longer than a phone is sent (`PHONE_COMMAND_CHARS`) arrives as
// its start, marked `long`, and cannot be allowed from the phone at all: No stays. A command the card shows as it is,
// because masking it could change what it seems to do and so it may hold a key, is not sent at all, nor its folder: it is
// marked `keyed`, and the phone offers only No (item 121). In every text of an ask, each character that does not show, or
// that reorders what does, arrives as a visible mark (`⟨U+202E⟩`), and an approval whose command holds one is marked
// `hidden`, so the phone says so as the card does (item 121).
//
// From a phone an approval offers at most Allow once and No: Always allow and Allow for the session stay on the Mac, and
// an ask the card marks as needing an app update offers nothing. Each ask carries a revision, which goes up whenever what
// it shows changes or anything it was built from changes, a key the masker hides included, so an Allow the phone sends
// counts only for the very command the person saw (approval-core's `seenRevision`).
import { maskSecrets, revealHidden, showCommand } from "../lib/secrets";

export type ChatState = "working" | "needs_you" | "done";

export interface SourceMessage {
  readonly kind: "message";
  readonly id: string;
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly ts: number;
}

export interface SourceApproval {
  readonly kind: "approval";
  /** The runtime's request id. */
  readonly id: string;
  readonly ts: number;
  /** Still waiting on the person (the store's `askOpen`). */
  readonly open: boolean;
  readonly title: string;
  readonly command: string;
  readonly cwd?: string;
  readonly plan?: string;
  readonly choices: readonly string[];
  readonly outdated?: boolean;
  readonly resolved?: string;
  readonly expired?: string;
  /** Who asks, when it is not the chat itself: a subagent, a shop. */
  readonly from?: string;
}

export interface SourceQuestion {
  readonly kind: "clarify";
  readonly id: string;
  readonly ts: number;
  readonly open: boolean;
  readonly question: string;
  readonly choices?: readonly string[];
  readonly multi?: boolean;
  readonly questions?: readonly { readonly id: string; readonly question: string; readonly choices?: readonly string[]; readonly multi?: boolean }[];
  readonly answered?: boolean;
  readonly expired?: string;
  readonly from?: string;
}

export type SourceItem = SourceMessage | SourceApproval | SourceQuestion;

/** One chat as the store has it, already reduced to what a phone may be shown. */
export interface ChatSource {
  readonly key: string;
  readonly title: string;
  /** A turn is running. */
  readonly working: boolean;
  /** The running turn's latest step ("Reading gateway.log"), or null. */
  readonly step: string | null;
  /** Seconds since the epoch of the chat's newest item. */
  readonly updatedAt: number;
  readonly items: readonly SourceItem[];
}

export interface ChatRow {
  readonly chat: string;
  readonly title: string;
  readonly state: ChatState;
  readonly updatedAt: number;
}

export interface MessageView {
  readonly id: string;
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly ts: number;
}

/** What a phone may answer an approval with. */
export type PhoneOption = "once" | "deny";

export type AskView =
  | {
      readonly kind: "approval";
      readonly id: string;
      readonly revision: number;
      readonly open: boolean;
      readonly ts: number;
      readonly title: string;
      readonly command: string;
      /** The command is longer than a phone is sent: `command` is its start, and it is allowed only on the Mac. */
      readonly long?: true;
      /** The card shows the command as it is, since it may hold a key: `command` is empty, and it is allowed only on the Mac. */
      readonly keyed?: true;
      /** The command holds characters that do not show, each a visible mark in `command`. */
      readonly hidden?: true;
      readonly cwd?: string;
      readonly plan?: string;
      readonly from?: string;
      readonly offers: readonly PhoneOption[];
      /** The card says to update the app: nothing can be answered, here or on the phone. */
      readonly needsUpdate?: true;
      readonly outcome?: "allowed" | "declined" | "expired";
    }
  | {
      readonly kind: "question";
      readonly id: string;
      readonly revision: number;
      readonly open: boolean;
      readonly ts: number;
      readonly question: string;
      readonly choices?: readonly string[];
      readonly multi?: true;
      readonly questions?: readonly { readonly id: string; readonly question: string; readonly choices?: readonly string[]; readonly multi?: true }[];
      readonly from?: string;
      readonly outcome?: "answered" | "expired";
    };

export interface ChatView {
  readonly chat: string;
  readonly title: string;
  readonly state: ChatState;
  readonly step: string | null;
  readonly messages: readonly MessageView[];
  readonly asks: readonly AskView[];
}

/** The newest messages a snapshot carries; older ones stay on the Mac. */
export const MAX_MESSAGES = 100;
/** Settled asks a snapshot carries besides every open one. */
export const MAX_SETTLED_ASKS = 20;
/** The longest command a phone is sent, as the card's plan is cut at 20,000 too: a longer one arrives as its start, marked
 *  `long`, and offers only No, since a person must not allow from a phone what it cannot show whole. */
export const PHONE_COMMAND_CHARS = 20_000;

/** `text`'s first `n` UTF-16 units, never ending inside a pair. */
function start(text: string, n: number): string {
  const end = /[\uD800-\uDBFF]/.test(text.charAt(n - 1)) ? n - 1 : n;
  return text.slice(0, end);
}

/** The text the Mac binds an Allow's challenge to for one ask (the package's `requestId`): the chat and the request id,
 *  written so no two pairs can run into each other. The phone computes the same from what its screen shows. */
export function askBinding(chat: string, ask: string): string {
  return JSON.stringify([chat, ask]);
}

export function chatState(source: ChatSource): ChatState {
  if (source.items.some((i) => i.kind !== "message" && i.open)) return "needs_you";
  return source.working ? "working" : "done";
}

export function chatRow(source: ChatSource): ChatRow {
  return { chat: source.key, title: maskSecrets(source.title), state: chatState(source), updatedAt: source.updatedAt };
}

/** An ask's text as a phone is shown it: its keys masked, and every character that does not show a visible mark. */
const shown = (text: string): string => revealHidden(maskSecrets(text));
const mask = (text: string | undefined): string | undefined => (text === undefined ? undefined : shown(text));

function approvalView(item: SourceApproval): Omit<Extract<AskView, { kind: "approval" }>, "revision"> {
  const cmd = showCommand(item.command);
  const folder = item.cwd === undefined ? undefined : showCommand(item.cwd);
  // a key the card could not mask safely never leaves the Mac: the command and its folder stay there
  const keyed = cmd.unmasked || !!folder?.unmasked;
  const whole = keyed ? "" : cmd.text;
  const long = whole.length > PHONE_COMMAND_CHARS;
  const offers: PhoneOption[] = item.outdated ? [] : (["once", "deny"] as const).filter((o) => item.choices.includes(o) && !((long || keyed) && o === "once"));
  const outcome = item.resolved ? (item.resolved === "deny" ? "declined" : "allowed") : item.expired ? "expired" : undefined;
  const cwd = keyed ? undefined : folder?.text;
  const plan = mask(item.plan);
  const from = mask(item.from);
  return {
    kind: "approval",
    id: item.id,
    open: item.open,
    ts: item.ts,
    title: shown(item.title),
    command: long ? start(whole, PHONE_COMMAND_CHARS) : whole,
    ...(long ? { long: true as const } : {}),
    ...(keyed ? { keyed: true as const } : {}),
    ...(cmd.hidden && !keyed ? { hidden: true as const } : {}),
    ...(cwd ? { cwd } : {}),
    ...(plan ? { plan } : {}),
    ...(from ? { from } : {}),
    offers,
    ...(item.outdated ? { needsUpdate: true as const } : {}),
    ...(outcome ? { outcome } : {}),
  };
}

function questionView(item: SourceQuestion): Omit<Extract<AskView, { kind: "question" }>, "revision"> {
  const from = mask(item.from);
  const outcome = item.answered ? "answered" : item.expired ? "expired" : undefined;
  return {
    kind: "question",
    id: item.id,
    open: item.open,
    ts: item.ts,
    question: shown(item.question),
    ...(item.choices?.length ? { choices: item.choices.map(shown) } : {}),
    ...(item.multi ? { multi: true as const } : {}),
    ...(item.questions?.length
      ? {
          questions: item.questions.map((q) => ({
            id: q.id,
            question: shown(q.question),
            ...(q.choices?.length ? { choices: q.choices.map(shown) } : {}),
            ...(q.multi ? { multi: true as const } : {}),
          })),
        }
      : {}),
    ...(from ? { from } : {}),
    ...(outcome ? { outcome } : {}),
  };
}

/** What makes up an ask's revision: everything it shows, and everything it was built from, and nothing about whether it
 *  is still open. What it was built from counts because the masker can make two commands look the same (`API_KEY=••••`):
 *  an Allow must count only for the command the person was shown, never for another that reads alike (item 117). The
 *  print stays in this Mac's memory and is never sent. */
function printOf(ask: Omit<AskView, "revision">, item: SourceApproval | SourceQuestion): string {
  const { open: _open, outcome: _outcome, ts: _ts, ...shown } = ask as Record<string, unknown>;
  const from = item.kind === "approval" ? [item.title, item.command, item.cwd, item.plan, item.from] : [item.question, item.choices, item.questions, item.from];
  return JSON.stringify([shown, from]);
}

/** Builds chat views and keeps each ask's revision: 1 when first shown, one more each time what it shows changes. A
 *  revision is never given twice to one ask: it is kept while the ask is in the store, and past that, so an ask that
 *  comes back with the same id goes on counting. It also keeps, per device, the newest revision of each ask that device
 *  was sent, since an Allow, a No or an answer counts only for a revision the phone was actually shown. One Projector
 *  lives as long as the app's RemoteMac, across the switch going off and on and across a phone leaving and coming back;
 *  a Mac started again starts a new one, which has shown no phone anything. */
export class Projector {
  /** By `askBinding(chat, ask)`: what the ask shows now (null once it left the store) and its revision. */
  readonly #revisions = new Map<string, { print: string | null; revision: number }>();
  /** By device, then by `askBinding(chat, ask)`: the newest revision that device was sent. */
  readonly #shown = new Map<string, Map<string, number>>();

  #revision(chat: string, ask: Omit<AskView, "revision">, item: SourceApproval | SourceQuestion): number {
    const key = askBinding(chat, ask.id);
    const print = printOf(ask, item);
    const known = this.#revisions.get(key);
    if (!known) {
      this.#revisions.set(key, { print, revision: 1 });
      return 1;
    }
    if (known.print !== print) {
      known.print = print;
      known.revision += 1;
    }
    return known.revision;
  }

  view(source: ChatSource): ChatView {
    const messages = source.items
      .filter((i): i is SourceMessage => i.kind === "message" && i.text.trim() !== "")
      .slice(-MAX_MESSAGES)
      .map((m) => ({ id: m.id, role: m.role, text: maskSecrets(m.text), ts: m.ts }));
    const all = source.items.filter((i): i is SourceApproval | SourceQuestion => i.kind !== "message");
    const settled = all.filter((i) => !i.open).slice(-MAX_SETTLED_ASKS);
    const asks = all
      .filter((i) => i.open || settled.includes(i))
      .map((item): AskView => {
        const shown = item.kind === "approval" ? approvalView(item) : questionView(item);
        return { ...shown, revision: this.#revision(source.key, shown, item) } as AskView;
      });
    return { chat: source.key, title: maskSecrets(source.title), state: chatState(source), step: mask(source.step ?? undefined) ?? null, messages, asks };
  }

  /** The ask `ask` of `chat` as the phone would be shown it now, with its revision. */
  ask(source: ChatSource, ask: string): AskView | null {
    const item = source.items.find((i): i is SourceApproval | SourceQuestion => i.kind !== "message" && i.id === ask);
    if (!item) return null;
    const shown = item.kind === "approval" ? approvalView(item) : questionView(item);
    return { ...shown, revision: this.#revision(source.key, shown, item) } as AskView;
  }

  /** Lets go of what the asks of `chat` that are no longer in the store showed, keeping their revisions, so a phone's old
   *  revision never matches an ask that comes back. */
  retire(chat: string, source: ChatSource | null): void {
    const present = new Set((source?.items ?? []).filter((i) => i.kind !== "message").map((i) => askBinding(chat, i.id)));
    const prefix = JSON.stringify([chat]).slice(0, -1);
    for (const [key, known] of this.#revisions) if (key.startsWith(`${prefix},`) && !present.has(key)) known.print = null;
  }

  /** `device` was sent these asks of `chat`, at these revisions. */
  sent(device: string, chat: string, asks: readonly { readonly id: string; readonly revision: number }[]): void {
    let seen = this.#shown.get(device);
    if (!seen) this.#shown.set(device, (seen = new Map()));
    for (const ask of asks) {
      const key = askBinding(chat, ask.id);
      seen.set(key, Math.max(seen.get(key) ?? 0, ask.revision));
    }
  }

  /** Whether `device` was sent `ask` of `chat` at `revision`, as the newest it holds. */
  wasShown(device: string, chat: string, ask: string, revision: number): boolean {
    return this.#shown.get(device)?.get(askBinding(chat, ask)) === revision;
  }

  /** A device unpaired: nothing it was shown counts any more. */
  forgetDevice(device: string): void {
    this.#shown.delete(device);
  }
}

/** One change to a chat a phone watches, as the journal numbers it. */
export type ChatEvent =
  | { readonly k: "state"; readonly state: ChatState; readonly step: string | null; readonly title: string }
  | { readonly k: "message"; readonly message: MessageView }
  | { readonly k: "ask"; readonly ask: AskView };

/** The events that take a phone from `before` to `after`. */
export function chatEvents(before: ChatView | null, after: ChatView): ChatEvent[] {
  const out: ChatEvent[] = [];
  if (!before || before.state !== after.state || before.step !== after.step || before.title !== after.title) {
    out.push({ k: "state", state: after.state, step: after.step, title: after.title });
  }
  const oldMessages = new Map(before?.messages.map((m) => [m.id, JSON.stringify(m)]) ?? []);
  for (const message of after.messages) if (oldMessages.get(message.id) !== JSON.stringify(message)) out.push({ k: "message", message });
  const oldAsks = new Map(before?.asks.map((a) => [a.id, JSON.stringify(a)]) ?? []);
  for (const ask of after.asks) if (oldAsks.get(ask.id) !== JSON.stringify(ask)) out.push({ k: "ask", ask });
  return out;
}
