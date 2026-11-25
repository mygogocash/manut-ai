// For tests: a stand-in for the shell's Buddy chat (src-tauri/src/buddy_chat.rs). It says which agents are installed,
// keeps what the runtime started and sent, and its Claude Code answers each message with the events the shell's Claude
// adapter sends for a plain answer (`turn.start`, `delta`, `message`, `turn.end`). A test that needs an ask, a question,
// a refusal or an exit sends the agent's own events with `emit`.
import type { AgentInfo } from "../../sessions/agents";
import type { BuddyChatInput, BuddyHost, ChatEvent } from "../../sessions/host";

export class StandInBuddyHost implements BuddyHost {
  readonly starts: { id: number; agent: string; prompt: string }[] = [];
  readonly inputs: { id: number; input: BuddyChatInput }[] = [];
  readonly closed: number[] = [];
  /** The files the runtime handed over to keep, with the path each was given (the shell's `buddy_file_save`). */
  readonly files: { name: string; size: number; path: string }[] = [];
  closedAll = 0;
  /** What the agent answers to a message by itself, `answerMs` after it; null: it answers nothing, and the test emits. */
  answer: ((text: string) => string) | null = (text) => `Answered: ${text}`;
  private readonly sinks = new Map<number, (ev: ChatEvent) => void>();
  private next = 0;

  constructor(
    public installed: string[] = ["claude"],
    public answerMs = 1_000,
  ) {}

  async agents(): Promise<AgentInfo[]> {
    return ["claude", "codex", "omo"].map((id) => ({ id, label: id, mode: "chat" as const, path: this.installed.includes(id) ? `/usr/local/bin/${id}` : null }));
  }

  async buddyStart(agent: string, prompt: string, onEvent: (ev: ChatEvent) => void): Promise<number> {
    if (!this.installed.includes(agent)) throw new Error(`${agent} is not installed (no \`${agent}\` found)`);
    const id = ++this.next;
    this.starts.push({ id, agent, prompt });
    this.sinks.set(id, onEvent);
    return id;
  }

  async buddyInput(id: number, input: BuddyChatInput): Promise<void> {
    if (!this.sinks.has(id)) throw new Error("no such session");
    this.inputs.push({ id, input });
    const answer = this.answer;
    if (input.kind !== "send" || !answer) return;
    const said = answer(input.text);
    setTimeout(() => {
      this.emit(id, { event: "turn.start" });
      this.emit(id, { event: "delta", text: said.slice(0, 4) });
      this.emit(id, { event: "delta", text: said.slice(4) });
      this.emit(id, { event: "message", id: `m${id}`, text: said });
      this.emit(id, { event: "turn.end", outcome: "done" });
    }, this.answerMs);
  }

  async buddyClose(id: number): Promise<void> {
    this.closed.push(id);
    this.sinks.delete(id);
  }

  async buddyCloseAll(): Promise<void> {
    this.closedAll += 1;
    this.sinks.clear();
  }

  async buddySaveFile(name: string, data: Uint8Array): Promise<string> {
    const path = `/home/you/.manut/buddy/files/${this.files.length + 1}-${name}`;
    this.files.push({ name, size: data.length, path });
    return path;
  }

  /** The agent of chat `id` (the newest when none is named) sends `ev`. */
  emit(id: number | undefined, ev: ChatEvent): void {
    this.sinks.get(id ?? this.next)?.(ev);
  }

  /** The messages the runtime sent the agent of chat `id`, in order. */
  sent(id?: number): string[] {
    return this.inputs.filter((x) => (id === undefined || x.id === id) && x.input.kind === "send").map((x) => (x.input.kind === "send" ? x.input.text : ""));
  }
}
