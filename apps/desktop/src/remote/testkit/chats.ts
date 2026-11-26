// Chats for tests, as fromStore.ts reduces the store's: a list a test changes by hand, and actions that record what was
// asked of the Mac and settle the ask the way the store would once the runtime took it.
import type { ChatSource, SourceApproval, SourceItem, SourceQuestion } from "../project";
import type { ChatSources, MacActions } from "../serve";

export type Done = { action: "allowOnce" | "decline" | "answer" | "stop"; chat: string; ask?: string; by?: string; answer?: unknown };

/** Words a test can look for in every frame the relay carried: none may be readable there. */
export const PLAIN = {
  title: "Shop launch plan",
  message: "The supplier price list for October is attached",
  reply: "I drafted the LINE broadcast to every customer",
  command: "line broadcast --to all-customers --text 'Sale starts Friday'",
  question: "Which day should the sale start",
} as const;

export function sampleChats(): ChatSource[] {
  const approval: SourceApproval = {
    kind: "approval",
    id: "req-1",
    ts: 1_800_000_100,
    open: true,
    title: "Send a LINE broadcast",
    command: PLAIN.command,
    cwd: "/Users/owner/shop",
    choices: ["once", "session", "always", "deny"],
  };
  const question: SourceQuestion = {
    kind: "clarify",
    id: "q-1",
    ts: 1_800_000_200,
    open: true,
    question: PLAIN.question,
    choices: ["Friday", "Saturday"],
  };
  return [
    {
      key: "buddy",
      title: PLAIN.title,
      working: true,
      step: "Reading the price list",
      updatedAt: 1_800_000_200,
      items: [
        { kind: "message", id: "m1", role: "user", text: PLAIN.message, ts: 1_800_000_000 },
        { kind: "message", id: "m2", role: "assistant", text: PLAIN.reply, ts: 1_800_000_050 },
        approval,
        question,
      ],
    },
    { key: "kit", title: "Kit", working: false, step: null, updatedAt: 1_700_000_000, items: [{ kind: "message", id: "k1", role: "assistant", text: "Done", ts: 1_700_000_000 }] },
  ];
}

export class FakeChats implements ChatSources {
  chats: ChatSource[];
  readonly done: Done[] = [];
  /** What the next action answers: null when the runtime takes it. */
  answerWith: string | null = null;

  constructor(chats: ChatSource[] = sampleChats()) {
    this.chats = chats;
  }

  list(): ChatSource[] {
    return this.chats;
  }

  get(chat: string): ChatSource | null {
    return this.chats.find((c) => c.key === chat) ?? null;
  }

  /** Changes one item of one chat, as a store update would. */
  update(chat: string, change: (items: SourceItem[]) => SourceItem[], more: Partial<ChatSource> = {}): void {
    this.chats = this.chats.map((c) => (c.key === chat ? { ...c, ...more, items: change([...c.items]) } : c));
  }

  #settle(chat: string, ask: string, patch: Partial<SourceApproval> & Partial<SourceQuestion>): void {
    this.update(chat, (items) => items.map((i) => (i.kind !== "message" && i.id === ask ? ({ ...i, ...patch, open: false } as SourceItem) : i)));
  }

  readonly actions: MacActions = {
    allowOnce: async (chat, ask, by) => {
      this.done.push({ action: "allowOnce", chat, ask, by });
      if (this.answerWith === null) this.#settle(chat, ask, { resolved: "once" });
      return this.answerWith;
    },
    decline: async (chat, ask, by) => {
      this.done.push({ action: "decline", chat, ask, by });
      if (this.answerWith === null) this.#settle(chat, ask, { resolved: "deny" });
      return this.answerWith;
    },
    answer: async (chat, ask, answer, by) => {
      this.done.push({ action: "answer", chat, ask, by, answer });
      if (this.answerWith === null) this.#settle(chat, ask, { answered: true });
      return this.answerWith;
    },
    stop: async (chat) => {
      this.done.push({ action: "stop", chat });
      if (this.answerWith === null) this.chats = this.chats.map((c) => (c.key === chat ? { ...c, working: false, step: null } : c));
      return this.answerWith;
    },
  };
}
