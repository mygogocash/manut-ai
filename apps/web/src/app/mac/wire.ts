/// What the Mac sends a paired phone inside the channel, as the desktop's side writes it (apps/desktop/src/remote/
/// project.ts and serve.ts, item 78b). The shapes are mirrored here, not imported: the desktop's files belong to another
/// app, and the phone reads only what it is sent. Every reader below takes the Mac's JSON as `unknown` and keeps only
/// fields of the expected shape, so a message from a newer Mac with more in it still reads, and one with less is dropped
/// rather than drawn half.
///
/// Nothing here is ever written anywhere: a chat lives in the page's memory only (docs/web-app.md, "Your Mac").

export type ChatState = "working" | "needs_you" | "done";

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

/// What a phone may answer an approval with (project.ts `PhoneOption`).
export type PhoneOption = "once" | "deny";

export interface ApprovalAsk {
  readonly kind: "approval";
  readonly id: string;
  readonly revision: number;
  readonly open: boolean;
  readonly ts: number;
  readonly title: string;
  readonly command: string;
  /// The command is longer than the Mac sends a phone: `command` is its start, and it is allowed only on the Mac.
  readonly long?: true;
  readonly cwd?: string;
  readonly plan?: string;
  readonly from?: string;
  readonly offers: readonly PhoneOption[];
  readonly needsUpdate?: true;
  readonly outcome?: "allowed" | "declined" | "expired";
}

export interface AskQuestion {
  readonly id: string;
  readonly question: string;
  readonly choices?: readonly string[];
  readonly multi?: true;
}

export interface QuestionAsk {
  readonly kind: "question";
  readonly id: string;
  readonly revision: number;
  readonly open: boolean;
  readonly ts: number;
  readonly question: string;
  readonly choices?: readonly string[];
  readonly multi?: true;
  readonly questions?: readonly AskQuestion[];
  readonly from?: string;
  readonly outcome?: "answered" | "expired";
}

export type AskView = ApprovalAsk | QuestionAsk;

export interface ChatView {
  readonly chat: string;
  readonly title: string;
  readonly state: ChatState;
  readonly step: string | null;
  readonly messages: readonly MessageView[];
  readonly asks: readonly AskView[];
}

/// Where the phone stands in a chat's journal (journal.ts).
export interface Cursor {
  readonly journal: string;
  readonly seq: number;
}

export type ChatEvent =
  | { readonly k: "state"; readonly state: ChatState; readonly step: string | null; readonly title: string }
  | { readonly k: "message"; readonly message: MessageView }
  | { readonly k: "ask"; readonly ask: AskView };

/// The newest messages a view keeps, as the Mac's snapshot does (project.ts `MAX_MESSAGES`).
export const MAX_MESSAGES = 100;

/// The text the Mac binds an Allow's challenge to (project.ts `askBinding`): the chat and the ask, as a JSON pair. The
/// phone computes it from what its own screen shows, never from the challenge it was sent.
export function askBinding(chat: string, ask: string): string {
  return JSON.stringify([chat, ask]);
}

type Raw = Record<string, unknown>;

const obj = (value: unknown): Raw | null => (value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Raw) : null);
const str = (value: unknown): string | null => (typeof value === "string" ? value : null);
const num = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);
const strs = (value: unknown): string[] | null => (Array.isArray(value) && value.every((v) => typeof v === "string") ? (value as string[]) : null);
const STATES: readonly string[] = ["working", "needs_you", "done"];
const state = (value: unknown): ChatState | null => (typeof value === "string" && STATES.includes(value) ? (value as ChatState) : null);

export function readRow(value: unknown): ChatRow | null {
  const o = obj(value);
  const chat = str(o?.chat);
  const title = str(o?.title);
  const st = state(o?.state);
  const updatedAt = num(o?.updatedAt);
  return o && chat !== null && title !== null && st && updatedAt !== null ? { chat, title, state: st, updatedAt } : null;
}

export function readMessage(value: unknown): MessageView | null {
  const o = obj(value);
  const id = str(o?.id);
  const text = str(o?.text);
  const ts = num(o?.ts);
  const role = o?.role === "user" || o?.role === "assistant" ? o.role : null;
  return o && id !== null && text !== null && ts !== null && role ? { id, role, text, ts } : null;
}

function optional<K extends string, V>(key: K, value: V | null | undefined): { [P in K]?: V } {
  return (value === null || value === undefined ? {} : { [key]: value }) as { [P in K]?: V };
}

export function readAsk(value: unknown): AskView | null {
  const o = obj(value);
  const id = str(o?.id);
  const revision = num(o?.revision);
  const ts = num(o?.ts);
  if (!o || id === null || revision === null || !Number.isSafeInteger(revision) || revision < 1 || ts === null || typeof o.open !== "boolean") return null;
  const from = str(o.from);
  if (o.kind === "approval") {
    const title = str(o.title);
    const command = str(o.command);
    // A command the Mac could not send whole is never allowed from here, whatever the offers say.
    const long = o.long === true;
    const offers = strs(o.offers)?.filter((x): x is PhoneOption => x === "deny" || (x === "once" && !long));
    if (title === null || command === null || !offers) return null;
    const outcome: ApprovalAsk["outcome"] | null = o.outcome === "allowed" || o.outcome === "declined" || o.outcome === "expired" ? o.outcome : null;
    return {
      kind: "approval",
      id,
      revision,
      open: o.open,
      ts,
      title,
      command,
      ...(long ? { long: true as const } : {}),
      ...optional("cwd", str(o.cwd)),
      ...optional("plan", str(o.plan)),
      ...optional("from", from),
      offers,
      ...(o.needsUpdate === true ? { needsUpdate: true as const } : {}),
      ...optional("outcome", outcome),
    };
  }
  if (o.kind === "question") {
    const question = str(o.question);
    if (question === null) return null;
    const questions = Array.isArray(o.questions)
      ? o.questions.map((q): AskQuestion | null => {
          const qo = obj(q);
          const qid = str(qo?.id);
          const qtext = str(qo?.question);
          if (!qo || qid === null || qtext === null) return null;
          return { id: qid, question: qtext, ...optional("choices", strs(qo.choices)), ...(qo.multi === true ? { multi: true as const } : {}) };
        })
      : null;
    if (questions?.some((q) => q === null)) return null;
    const outcome: QuestionAsk["outcome"] | null = o.outcome === "answered" || o.outcome === "expired" ? o.outcome : null;
    return {
      kind: "question",
      id,
      revision,
      open: o.open,
      ts,
      question,
      ...optional("choices", strs(o.choices)),
      ...(o.multi === true ? { multi: true as const } : {}),
      ...(questions && questions.length > 0 ? { questions: questions as AskQuestion[] } : {}),
      ...optional("from", from),
      ...optional("outcome", outcome),
    };
  }
  return null;
}

export function readView(value: unknown): ChatView | null {
  const o = obj(value);
  const chat = str(o?.chat);
  const title = str(o?.title);
  const st = state(o?.state);
  if (!o || chat === null || title === null || !st || !Array.isArray(o.messages) || !Array.isArray(o.asks)) return null;
  const step = o.step === null ? null : str(o.step);
  if (step === null && o.step !== null) return null;
  const messages = o.messages.map(readMessage);
  const asks = o.asks.map(readAsk);
  if (messages.some((m) => m === null) || asks.some((a) => a === null)) return null;
  return { chat, title, state: st, step, messages: messages as MessageView[], asks: asks as AskView[] };
}

export function readCursor(value: unknown): Cursor | null {
  const o = obj(value);
  const journal = str(o?.journal);
  const seq = num(o?.seq);
  return o && journal !== null && journal.length <= 64 && seq !== null && Number.isSafeInteger(seq) && seq >= 0 ? { journal, seq } : null;
}

export function readEvent(value: unknown): ChatEvent | null {
  const o = obj(value);
  if (o?.k === "state") {
    const st = state(o.state);
    const title = str(o.title);
    const step = o.step === null ? null : str(o.step);
    return st && title !== null && (step !== null || o.step === null) ? { k: "state", state: st, step, title } : null;
  }
  if (o?.k === "message") {
    const message = readMessage(o.message);
    return message ? { k: "message", message } : null;
  }
  if (o?.k === "ask") {
    const ask = readAsk(o.ask);
    return ask ? { k: "ask", ask } : null;
  }
  return null;
}

/// A view with one event applied: what the Mac's own `chatEvents` took it from and to (project.ts).
export function applyEvent(view: ChatView, event: ChatEvent): ChatView {
  switch (event.k) {
    case "state":
      return { ...view, state: event.state, step: event.step, title: event.title };
    case "message": {
      const at = view.messages.findIndex((m) => m.id === event.message.id);
      const messages = at === -1 ? [...view.messages, event.message] : view.messages.map((m, i) => (i === at ? event.message : m));
      return { ...view, messages: messages.slice(-MAX_MESSAGES) };
    }
    case "ask": {
      const at = view.asks.findIndex((a) => a.id === event.ask.id);
      const asks = at === -1 ? [...view.asks, event.ask] : view.asks.map((a, i) => (i === at ? event.ask : a));
      return { ...view, asks };
    }
  }
}
