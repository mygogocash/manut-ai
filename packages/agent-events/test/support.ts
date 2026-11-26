import {
  type DecodeContext,
  type ISODate,
  type ProviderEvent,
  type ReducerOptions,
  type TimelineContent,
  type TimelineState,
  type ToolCall,
  type UUID,
  emptyTimeline,
  isoDate,
  markTurnSent,
  openTurn,
  reduceTimeline,
  toolCall,
  userMessage,
} from "../src/index";

/// The em dash, by code point, so no editor or tool can swap the test's subject for a hyphen.
export const EM_DASH = String.fromCodePoint(0x2014);
export const ELLIPSIS = String.fromCodePoint(0x2026);

/// A whole second, because GoSpark's storage writes dates as ISO 8601 without fractions.
export const AT: ISODate = "2026-11-23T05:00:00Z";

/// The nth UUID of a test, so every id a test sees is one it can name.
export function uuid(n: number): UUID {
  return `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
}

/// A decode context with a fixed clock and counted ids.
export function fixedContext(): DecodeContext {
  let made = 0;
  return { newID: () => uuid(0xd000 + made++), now: () => AT };
}

/// What a value reads back as after a trip through JSON text, which is the wire.
export function overTheWire(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value)) as unknown;
}

export function command(title: string, at: ISODate = AT): ToolCall {
  return toolCall({ kind: "command", title, startedAt: at });
}

/// A thread driven the way GoSpark's tests drive a `ThreadRuntime`: `rehearseTurn` opens a turn
/// with no provider behind it and `rehearse` feeds one event through the reducer. Every event
/// arrives one second after the last and brings a fresh id, as a live caller's would.
export class Thread {
  state: TimelineState = emptyTimeline();
  private seconds = 0;
  private ids = 0;

  constructor(private readonly options: ReducerOptions = {}) {}

  private tick(): ISODate {
    this.seconds += 1;
    return isoDate(new Date(Date.parse(AT) + this.seconds * 1000));
  }

  /// Opens a turn and marks it sent, as `rehearseTurn` starts one already running. Returns its id.
  rehearseTurn(text?: string, attemptID?: UUID): UUID {
    const turnID = uuid(0xa000 + this.ids++);
    const at = this.tick();
    this.state = markTurnSent(
      openTurn(this.state, {
        turnID,
        at,
        ...(text === undefined ? {} : { userMessage: userMessage(text) }),
        ...(attemptID === undefined ? {} : { attemptID }),
      }),
    );
    return turnID;
  }

  /// Opens a turn that has not been sent yet, as a real send leaves it until the provider has it.
  openUnsent(text: string): UUID {
    const turnID = uuid(0xa000 + this.ids++);
    this.state = openTurn(this.state, { turnID, at: this.tick(), userMessage: userMessage(text) });
    return turnID;
  }

  rehearse(event: ProviderEvent): this {
    this.state = reduceTimeline(this.state, event, { at: this.tick(), freshID: uuid(0xf000 + this.ids++) }, this.options);
    return this;
  }

  content(id: string): TimelineContent | undefined {
    return this.state.items.find((item) => item.id === id)?.content;
  }

  /// The text of a row, whichever kind of text it holds.
  text(id: string): string | undefined {
    const content = this.content(id);
    switch (content?.type) {
      case "assistant":
        return content.message.text;
      case "reasoning":
        return content.block.text;
      case "plan":
        return content.plan.markdown;
      case "tool":
        return content.call.output;
      default:
        return undefined;
    }
  }

  call(id: string): ToolCall | undefined {
    const content = this.content(id);
    return content?.type === "tool" ? content.call : undefined;
  }

  rowIDs(): string[] {
    return this.state.items.map((item) => item.id);
  }

  hasUniqueIDs(): boolean {
    return new Set(this.rowIDs()).size === this.state.items.length;
  }
}
