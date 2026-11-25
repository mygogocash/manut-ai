// What a paired phone is shown of a chat (docs/remote-access.md, "What a person does", step 5): the chats as Working,
// Needs you or Done, and for one chat its messages, its current step and its asks. Everything here is plain data built
// from the store (fromStore.ts reads it) and every text in it goes through `maskSecrets` (lib/secrets.ts), the one masker
// every surface of the app uses, so a token in a chat, a command or a step never reaches the phone. An ask is shown whole,
// with every field its card shows (the title, the whole command, the folder, the plan, who asks), never cut short.
//
// From a phone an approval offers at most Allow once and No: Always allow and Allow for the session stay on the Mac, and
// an ask the card marks as needing an app update offers nothing. Each ask carries a revision, which goes up whenever what
// it shows changes, so an Allow the phone sends counts only for what the person saw (approval-core's `seenRevision`).
import { maskSecrets } from "../lib/secrets";

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

const mask = (text: string | undefined): string | undefined => (text === undefined ? undefined : maskSecrets(text));

function approvalView(item: SourceApproval): Omit<Extract<AskView, { kind: "approval" }>, "revision"> {
  const offers: PhoneOption[] = item.outdated ? [] : (["once", "deny"] as const).filter((o) => item.choices.includes(o));
  const outcome = item.resolved ? (item.resolved === "deny" ? "declined" : "allowed") : item.expired ? "expired" : undefined;
  const cwd = mask(item.cwd);
  const plan = mask(item.plan);
  const from = mask(item.from);
  return {
    kind: "approval",
    id: item.id,
    open: item.open,
    ts: item.ts,
    title: maskSecrets(item.title),
    command: maskSecrets(item.command),
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
    question: maskSecrets(item.question),
    ...(item.choices?.length ? { choices: item.choices.map(maskSecrets) } : {}),
    ...(item.multi ? { multi: true as const } : {}),
    ...(item.questions?.length
      ? {
          questions: item.questions.map((q) => ({
            id: q.id,
            question: maskSecrets(q.question),
            ...(q.choices?.length ? { choices: q.choices.map(maskSecrets) } : {}),
            ...(q.multi ? { multi: true as const } : {}),
          })),
        }
      : {}),
    ...(from ? { from } : {}),
    ...(outcome ? { outcome } : {}),
  };
}

/** What makes up an ask's revision: everything it shows, and nothing about whether it is still open. */
function printOf(ask: Omit<AskView, "revision">): string {
  const { open: _open, outcome: _outcome, ts: _ts, ...shown } = ask as Record<string, unknown>;
  return JSON.stringify(shown);
}

/** Builds chat views and keeps each ask's revision: 1 when first shown, one more each time what it shows changes. */
export class Projector {
  readonly #revisions = new Map<string, { print: string; revision: number }>();

  #revision(chat: string, ask: Omit<AskView, "revision">): number {
    const key = askBinding(chat, ask.id);
    const print = printOf(ask);
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
        return { ...shown, revision: this.#revision(source.key, shown) } as AskView;
      });
    return { chat: source.key, title: maskSecrets(source.title), state: chatState(source), step: mask(source.step ?? undefined) ?? null, messages, asks };
  }

  /** The ask `ask` of `chat` as the phone would be shown it now, with its revision. */
  ask(source: ChatSource, ask: string): AskView | null {
    const item = source.items.find((i): i is SourceApproval | SourceQuestion => i.kind !== "message" && i.id === ask);
    if (!item) return null;
    const shown = item.kind === "approval" ? approvalView(item) : questionView(item);
    return { ...shown, revision: this.#revision(source.key, shown) } as AskView;
  }

  /** Forgets the revisions of a chat's asks that are gone. */
  forget(chat: string): void {
    const prefix = JSON.stringify([chat]).slice(0, -1);
    for (const key of this.#revisions.keys()) if (key.startsWith(`${prefix},`)) this.#revisions.delete(key);
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
