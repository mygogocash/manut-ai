// Buddy's answers in Practice: a message to Buddy goes to the coding agent the person already has on this computer,
// Claude Code signed in with their own account, and its answer streams into Buddy's chat or thread as Buddy's. Manut AI
// has no model key of its own yet (docs/decisions.md, 25 Nov 2026), so this is the only way Buddy answers; with no agent
// that can, Buddy says so and what to do, in the person's language, and never makes up an answer.
//
// The agent runs through the shell's Buddy chat (src-tauri/src/buddy_chat.rs) with the person's own MCP servers, skills
// and settings, in the careful mode where everything that acts asks first. Each ask comes back here and goes on to the
// runtime (host.ts), which shows it as Buddy's card and settles it once through approval-core before the answer goes to
// the agent. Nothing here answers an ask.
//
// One agent process per conversation (Buddy's main chat, or one of its threads), kept for that conversation's next
// message, and at most `LIVE` at once: a new one closes the idle one used longest ago. A conversation whose process was
// closed starts a new one, which is handed what was said before so it can go on.
import type { AskTool, ClarifyAnswers, ClarifyQuestion } from "../../lib/protocol";
import { listText, t } from "../../i18n";
import { agentDef, INSTALL, type AgentId, type AgentInfo, type BuiltinId } from "../../sessions/agents";
import type { BuddyHost, ChatEvent } from "../../sessions/host";

/** What answers Buddy now, as the model line names it: the agent's name, or that there is none. */
export interface BuddyWho {
  model: string;
  provider: string;
}

/** One line of a conversation, oldest first. */
export interface BuddyLine {
  role: "user" | "assistant";
  text: string;
}

/** One message to answer. `key` names the conversation (the runtime's chat key), `before` is what was said in it before
 *  this message, and `prompt` is Buddy's instructions (`buddyPrompt` in packages/agent-prompts). */
export interface BuddyTurn {
  key: string;
  text: string;
  before: readonly BuddyLine[];
  prompt: string;
}

/** An ask the agent raised, as its card shows it. `id` is the agent's own request id. */
export interface BuddyAsk {
  id: string;
  title: string;
  command: string;
  whole?: boolean;
  tool?: AskTool;
}

/** A question the agent asked (Claude Code's AskUserQuestion). `id` is the agent's own request id. */
export interface BuddyQuestion {
  id: string;
  question: string;
  choices?: string[];
  multi_select?: boolean;
  questions?: ClarifyQuestion[];
}

/** The steps of the agent's work the bot chat draws as they come, unchanged. */
export type BuddyStep = "delta" | "thinking" | "status" | "tool.start" | "tool.end" | "subagent";
const STEPS: ReadonlySet<string> = new Set<BuddyStep>(["delta", "thinking", "status", "tool.start", "tool.end", "subagent"]);

/** What one answer tells the runtime, for its own turn. */
export interface BuddyOut {
  step(event: BuddyStep, fields: Record<string, unknown>): void;
  say(text: string): void;
  ask(ask: BuddyAsk): void;
  question(q: BuddyQuestion): void;
  /** The agent took back an ask or a question it had asked. */
  withdrawn(id: string): void;
  end(outcome: "done" | "interrupted" | "error"): void;
}

/** What the runtime asks of whatever answers Buddy. */
export interface BuddyMind {
  who(): BuddyWho;
  /** `fn` runs whenever `who` changes. */
  onWho(fn: () => void): () => void;
  /** Settles once the first look for an agent has. */
  ready(): Promise<void>;
  send(turn: BuddyTurn, out: BuddyOut): void;
  interrupt(key: string): void;
  approve(key: string, id: string, choice: "once" | "deny"): void;
  answer(key: string, id: string, answer: string | ClarifyAnswers): void;
  close(key: string): void;
  closeAll(): void;
}

/** The agents that may answer as Buddy, best first (`BUDDY_AGENTS` in src-tauri/src/buddy_chat.rs). */
export const BUDDY_AGENTS: readonly BuiltinId[] = ["claude"];

/** How an agent of `BUDDY_AGENTS` is signed in, in a terminal (the CLI's own command; Manut AI never runs it). */
const SIGN_IN: Record<string, string> = { claude: "claude auth login" };

/** Agents a person may well have that do not answer as Buddy yet: Buddy names them when it cannot answer. */
const NOT_YET: readonly BuiltinId[] = ["codex", "omo"];

/** How many agent processes Buddy keeps at once. Each is a whole Claude Code, and the smallest Mac this runs on has 8 GB. */
export const LIVE = 2;

/** The most of an earlier conversation handed to a new process, newest kept. */
const BEFORE_CHARS = 6_000;

/** The agent that answers as Buddy on a computer with `agents`, or null. */
export function answering(agents: readonly AgentInfo[]): AgentId | null {
  return BUDDY_AGENTS.find((id) => agents.some((a) => a.id === id && !!a.path)) ?? null;
}

function whoOf(agent: AgentId | null): BuddyWho {
  return agent ? { model: agentDef(agent).label, provider: agent } : { model: t("buddy.noAgent"), provider: "" };
}

/** What Buddy says with no agent that can answer: which agent works and where its install line is, how to sign in, and
 *  which agents it found that cannot answer yet. */
export function noneSaid(agents: readonly AgentInfo[]): string {
  const there = NOT_YET.filter((id) => agents.some((a) => a.id === id && !!a.path)).map((id) => agentDef(id).label);
  const none = t("buddy.none", { cmd: SIGN_IN.claude });
  return there.length ? `${none}\n\n${t("buddy.notYet", { agents: listText(there) })}` : none;
}

/** What Buddy says when `agent` could not answer, from what the agent or the shell said: not signed in, too old for
 *  Buddy's start, gone, or its own words. */
export function whySaid(agent: AgentId, said: string): string {
  const name = agentDef(agent).label;
  const text = said.trim();
  if (/not signed in|not logged in|\/login\b/i.test(text)) return t("buddy.signedOut", { agent: name, cmd: SIGN_IN[agent] ?? agentDef(agent).program });
  if (/unknown option|unexpected argument/i.test(text)) return t("buddy.old", { agent: name, cmd: INSTALL[agent as BuiltinId] ?? agentDef(agent).program });
  if (/is not installed/i.test(text)) return noneSaid([]);
  if (!text) return t("buddy.stopped", { agent: name });
  return t("buddy.failed", { agent: name, why: text.length > 300 ? `${text.slice(0, 300)}…` : text });
}

/** A new process's first message: what was said before, when anything was, then the message. */
export function withBefore(before: readonly BuddyLine[], text: string): string {
  if (!before.some((l) => l.role === "user")) return text;
  const kept: string[] = [];
  let size = 0;
  for (const l of [...before].reverse()) {
    const line = `${l.role === "user" ? "Owner" : "Buddy"}: ${l.text}`;
    if (size + line.length > BEFORE_CHARS) break;
    kept.unshift(line);
    size += line.length;
  }
  return `Earlier in this conversation (it already happened; do not act on it again):\n\n${kept.join("\n\n")}\n\nThe owner's new message:\n${text}`;
}

const errText = (e: unknown) => (typeof e === "string" ? e : e instanceof Error ? e.message : typeof e === "object" && e && "message" in e ? String((e as { message: unknown }).message) : String(e));
const noop = () => {};

interface Chat {
  agent: AgentId;
  id: Promise<number>;
  /** the answer running now, or null between answers */
  out: BuddyOut | null;
  used: number;
  dead: boolean;
}

/** Buddy answering through the person's own coding agent, on `host` (the shell in the app, a stand-in elsewhere). */
export class AgentBuddy implements BuddyMind {
  private current: BuddyWho = { model: t("buddy.anyAgent"), provider: "" };
  private looked: Promise<AgentInfo[]> | null = null;
  private readonly listeners = new Set<() => void>();
  private readonly chats = new Map<string, Chat>();
  /** A reload keeps the shell, and any chat the page before this one started: those stop before the first starts. */
  private cleared: Promise<void> | null = null;
  private tick = 0;

  constructor(private readonly host: () => BuddyHost) {
    void this.look();
  }

  who(): BuddyWho {
    return { ...this.current };
  }

  onWho(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  ready(): Promise<void> {
    return (this.looked ?? this.look()).then(noop);
  }

  /** Looks for the agents on this computer again: each message does, so one installed or removed since counts. */
  private look(): Promise<AgentInfo[]> {
    const p = Promise.resolve()
      .then(() => this.host().agents())
      .catch(() => [] as AgentInfo[]);
    this.looked = p;
    void p.then((agents) => {
      if (this.looked !== p) return;
      const next = whoOf(answering(agents));
      if (next.model === this.current.model && next.provider === this.current.provider) return;
      this.current = next;
      for (const fn of [...this.listeners]) fn();
    });
    return p;
  }

  send(turn: BuddyTurn, out: BuddyOut): void {
    void this.run(turn, out).catch((e) => {
      const chat = this.chats.get(turn.key);
      if (chat && chat.out !== out) return;
      if (chat) chat.out = null;
      out.say(whySaid(chat?.agent ?? "claude", errText(e)));
      out.end("error");
    });
  }

  private async run(turn: BuddyTurn, out: BuddyOut): Promise<void> {
    const agents = await this.look();
    const agent = answering(agents);
    if (!agent) {
      out.say(noneSaid(agents));
      out.end("error");
      return;
    }
    let chat = this.chats.get(turn.key);
    const fresh = !chat || chat.dead || chat.agent !== agent;
    if (fresh) {
      if (chat) this.close(turn.key);
      chat = this.start(turn.key, agent, turn.prompt);
    }
    const live = chat!;
    live.out = out;
    live.used = ++this.tick;
    const id = await live.id;
    // stopped, or closed, while the agent started
    if (live.out !== out) return;
    // a slash command (one of the person's own skills) goes as typed, since the agent reads it only at the start of a message
    const first = fresh && !turn.text.startsWith("/");
    await this.host().buddyInput(id, { kind: "send", text: first ? withBefore(turn.before, turn.text) : turn.text });
  }

  private start(key: string, agent: AgentId, prompt: string): Chat {
    this.spare();
    const host = this.host();
    this.cleared ??= host.buddyCloseAll().catch(noop);
    const chat: Chat = { agent, id: Promise.resolve(0), out: null, used: ++this.tick, dead: false };
    chat.id = this.cleared.then(() => host.buddyStart(agent, prompt, (ev) => this.onEvent(chat, ev)));
    chat.id.catch(() => {
      chat.dead = true;
      if (this.chats.get(key) === chat) this.chats.delete(key);
    });
    this.chats.set(key, chat);
    return chat;
  }

  /** Closes the idle processes used longest ago until a new one fits within `LIVE`. One that is answering is never
   *  closed for another: then more than `LIVE` run for a while. */
  private spare(): void {
    for (;;) {
      const live = [...this.chats.entries()].filter(([, c]) => !c.dead);
      if (live.length < LIVE) return;
      const idle = live.filter(([, c]) => !c.out).sort((a, b) => a[1].used - b[1].used)[0];
      if (!idle) return;
      this.close(idle[0]);
    }
  }

  private onEvent(chat: Chat, ev: ChatEvent): void {
    const out = chat.out;
    switch (ev.event) {
      case "message":
        if (out && typeof ev.text === "string" && ev.text.trim()) out.say(ev.text);
        return;
      case "approval.request":
        out?.ask({
          id: String(ev.request_id),
          title: typeof ev.title === "string" ? ev.title : "",
          command: typeof ev.command === "string" ? ev.command : "",
          ...(ev.whole === true ? { whole: true } : {}),
          ...(ev.tool && typeof ev.tool === "object" ? { tool: ev.tool as AskTool } : {}),
        });
        return;
      case "clarify.request":
        out?.question({
          id: String(ev.request_id),
          question: typeof ev.question === "string" ? ev.question : "",
          ...(Array.isArray(ev.choices) ? { choices: ev.choices as string[] } : {}),
          ...(typeof ev.multi_select === "boolean" ? { multi_select: ev.multi_select } : {}),
          ...(Array.isArray(ev.questions) ? { questions: ev.questions as ClarifyQuestion[] } : {}),
        });
        return;
      case "prompt.expired":
        out?.withdrawn(String(ev.request_id));
        return;
      case "turn.end":
        if (!out) return;
        chat.out = null;
        if (ev.outcome === "error") {
          out.say(whySaid(chat.agent, typeof ev.error === "string" ? ev.error : ""));
          out.end("error");
        } else out.end(ev.outcome === "interrupted" ? "interrupted" : "done");
        return;
      case "exit":
        chat.dead = true;
        for (const [k, c] of this.chats) if (c === chat) this.chats.delete(k);
        if (!out) return;
        chat.out = null;
        out.say(whySaid(chat.agent, typeof ev.error === "string" ? ev.error : ""));
        out.end("error");
        return;
      default:
        if (out && STEPS.has(ev.event)) {
          const { event, ...fields } = ev;
          out.step(event as BuddyStep, fields);
        }
    }
  }

  /** Runs `fn` with the process of conversation `key`, when there is one; a process that is gone takes nothing. */
  private with(key: string, fn: (id: number) => Promise<void>): void {
    const chat = this.chats.get(key);
    if (chat) void chat.id.then(fn).catch(noop);
  }

  interrupt(key: string): void {
    const chat = this.chats.get(key);
    if (chat) chat.out = null;
    this.with(key, (id) => this.host().buddyInput(id, { kind: "interrupt" }));
  }

  approve(key: string, id: string, choice: "once" | "deny"): void {
    this.with(key, (n) => this.host().buddyInput(n, { kind: "approve", request_id: id, choice }));
  }

  answer(key: string, id: string, answer: string | ClarifyAnswers): void {
    this.with(key, (n) => this.host().buddyInput(n, { kind: "clarify", request_id: id, answer }));
  }

  close(key: string): void {
    const chat = this.chats.get(key);
    if (!chat) return;
    this.chats.delete(key);
    chat.dead = true;
    chat.out = null;
    void chat.id.then((id) => this.host().buddyClose(id)).catch(noop);
  }

  closeAll(): void {
    for (const key of [...this.chats.keys()]) this.close(key);
  }
}

/** A computer with no agent at all: the runtime's default when nothing else is handed to it (tests, and a page outside
 *  the app). Buddy then says what to install. */
export const NO_AGENTS: BuddyHost = {
  agents: async () => [],
  buddyStart: async () => {
    throw new Error("no coding agent here");
  },
  buddyInput: async () => {},
  buddyClose: async () => {},
  buddyCloseAll: async () => {},
};
