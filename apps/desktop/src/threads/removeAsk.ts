// The question before a conversation with Buddy is removed (item 102l-6): which conversation it is about, and what each press does.
// On the connected runtime a removal deletes the conversation and every message in it, for good, so no row removes anything by itself:
// its menu's Remove only asks (`ask`), and nothing is sent until the person presses the destructive button (`confirm`). Cancel, Escape
// and a press outside send nothing. One question is open at a time, over whatever is showing (RemoveConversation.tsx draws it), so it
// outlives the row it came from: a conversation the API says is gone leaves its row at once, and the question stays to say so.
//
// A refusal is said in the runtime's own words (src/runtime/http/chat.ts words each in the person's language) and the question stays
// open with them, its button usable again: a removal that got no answer may have gone through, and pressing again is safe (a
// conversation already gone is refused `thread_not_found`, which leaves the list).
import { isBridgeError } from "../lib/protocol";
import { t } from "../i18n";

/** The conversation a question is about: the member whose thread it is, its id, and the name the question gives it ("" until a message
 *  named it). */
export interface ConversationRef {
  bot: string;
  thread: string;
  title: string;
}

export interface RemoveState {
  asked: ConversationRef | null;
  /** The removal is on its way: nothing else can be pressed. */
  busy: boolean;
  /** Why the last press did not remove it, in the runtime's words; null otherwise. */
  error: string | null;
}

const IDLE: RemoveState = { asked: null, busy: false, error: null };

/** A refusal as the question says it: the runtime's own sentence, or a plain one for a failure that has none. */
function words(e: unknown): string {
  if (isBridgeError(e) && typeof e.message === "string" && e.message) return e.message;
  return e instanceof Error && e.message ? e.message : t("rt.chat.removeRefused");
}

/** The one question, over `remove` (the store's `removeThread`: it forgets the conversation's chat and row once the runtime has
 *  removed it). Tests make their own; the app has one (`removeAsk`). */
export class RemoveAsk {
  private state: RemoveState = IDLE;
  private readonly subs = new Set<() => void>();

  constructor(private readonly remove: (bot: string, thread: string) => Promise<void>) {}

  readonly get = (): RemoveState => this.state;

  readonly subscribe = (fn: () => void): (() => void) => {
    this.subs.add(fn);
    return () => void this.subs.delete(fn);
  };

  private set(next: RemoveState): void {
    this.state = next;
    for (const fn of [...this.subs]) fn();
  }

  /** A row's Remove: the question opens, and nothing is sent. One already open is not replaced, so a second press elsewhere cannot
   *  swap the conversation under a person who is reading the question. */
  ask(c: ConversationRef): void {
    if (this.state.asked) return;
    this.set({ asked: c, busy: false, error: null });
  }

  /** Cancel, Escape or a press outside: the question closes and nothing is sent. Not while the removal is on its way, which a
   *  cancel could no longer stop. */
  cancel(): void {
    if (!this.state.busy) this.set(IDLE);
  }

  /** The destructive button: the removal, once. A press while it is on its way does nothing. It ends the question when it went
   *  through; a refusal keeps the question open with the reason. */
  async confirm(): Promise<void> {
    const { asked, busy } = this.state;
    if (!asked || busy) return;
    this.set({ asked, busy: true, error: null });
    try {
      await this.remove(asked.bot, asked.thread);
      this.set(IDLE);
    } catch (e) {
      this.set({ asked, busy: false, error: words(e) });
    }
  }
}
