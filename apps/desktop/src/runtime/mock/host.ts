// The in-process runtime's state and answers: every op of the protocol (`src/lib/protocol.ts`, plus the thread ops in
// `src/threads/types.ts`), served from memory with scripted turns. It is a port of Oh My Hermes' test bridge
// (`e2e/mock-bridge.mjs`) from a Node WebSocket server to a plain class, with Manut AI's own staged data and without
// that file's test-control ops and Hermes fixtures. Nothing here talks to a network, a model or another process.
//
// The handler table is typed against the protocol's own op map, so an op added to the protocol does not compile
// until this runtime answers it. Features the runtime does not have (see `RuntimeCapabilities`) still answer: a read
// comes back empty and a write is refused with `unsupported`, so a stray call can never hang a screen.
import { createRoutine, describeTrigger, nextRun, type Routine, type RoutineRefusal } from "@manut/routine-rules";
import {
  MAX_FACTS,
  MAX_TEXT,
  confirm as confirmFact,
  correct as correctFact,
  emptyState,
  forget as forgetFact,
  propose,
  remember as rememberFact,
  type Fact,
  type FactSource,
  type MemoryState,
  type Refusal,
  type Result,
} from "@manut/shop-memory";
import type {
  ApprovalChoice,
  Bot,
  BridgeEvent,
  ClarifyQuestion,
  ModelCurrent,
  Msg,
  OpMap,
  ShopRow,
} from "../../lib/protocol";
import type { NodeSessionResult } from "../../harness/session";
import { firstWords, type ThreadEvent, type ThreadOps } from "../../threads/types";
import type { MemoryFact, MemorySource } from "../memory";
import type { ActivityEvent, Job, PausedJob, TeamState } from "../mission";
import type { RoutineRow } from "../routines";
import {
  ACTIVITY_KEPT_MONTHS,
  ACTIVITY_SEED,
  APPROVAL_SEED,
  BOT_SEED,
  CLARIFY_SEED,
  COMMAND_SEED,
  HISTORY_SEED,
  INTERVIEW_SEED,
  JOB_SEED,
  MEMORY_SEED,
  NORMAL_ANSWER,
  PROVIDERS,
  REASONING_LEVELS,
  ROUTINE_SEED,
  SKILL_SEED,
  type BotSeed,
} from "./seed";
import { HELPED_INTRO, HELPED_REFUSAL, HELPED_SHOP, OWN_SHOP, sampleAsks, sampleShops, SHOPS_SAID, type WaitingAsk } from "./shops";
import { PracticePeople, type PeopleResult } from "./people";
import { PracticeGoogle, readPracticeGoogleStart, type GoogleResult } from "./google";
import { isShopTemplateId, MADE_SHOPS_LIMIT, shopNameOf } from "../makeShop";
import { PracticeVault, type VaultResult } from "./vault";

/** A refusal, as the protocol's reply frame carries it. */
export class OpError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** Ops the app sends that are not in the protocol's op map (each lane kept its own beside it). */
interface ExtraOps {
  "runs.node_session": { params: { bot: string }; result: NodeSessionResult };
  "tasks.linear": { params: { bot: string }; result: { configured: boolean; server: string } };
}
type AllOps = OpMap & ThreadOps & ExtraOps;
type Handlers = { [K in keyof AllOps]: (p: AllOps[K]["params"]) => AllOps[K]["result"] };

export type MockEvent = BridgeEvent | ThreadEvent;

type Timer = ReturnType<typeof setTimeout>;
interface Turn {
  timers: Timer[];
  text: string;
}
interface Wait {
  /** The chat that asked: a bot's name, or `turnKey(bot, session)`. */
  key: string;
  kind: "approval" | "clarify";
  /** An interview's question ids. */
  qids?: string[];
}
interface Folder {
  bot: string;
  cwd: string;
  open: boolean;
  stored: string;
  thread: boolean;
  title: string;
  started: number;
  archived: boolean;
  /** `thread.create`'s own key, so the same request made twice opens one thread. */
  key: string | null;
}

const CHOICES: readonly ApprovalChoice[] = ["once", "session", "always", "deny"];
const UNSUPPORTED = "The demo runtime does not do this yet.";
const PAUSED = "The team is paused. Resume everyone first.";

/** A copy no caller can change the host's own state through, as a frame that crossed a socket would be. */
const copy = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

/** The words a memory refusal carries for a caller with none of its own. The Customize page says each one itself, in the
 *  owner's language, and keys on the code, which is the package's own reason. */
const MEMORY_REFUSAL: Record<Refusal, string> = {
  invalid_text: `A fact is 1 to ${MAX_TEXT} characters.`,
  invalid_source: "That is not somewhere a fact can come from.",
  already_known: "The team already knows this.",
  forgotten: "You asked the team to forget this.",
  not_found: "No such fact.",
  full: `The team already holds ${MAX_FACTS} facts. Forget one first.`,
};

/** Where a fact came from, with a document's date in seconds as the protocol counts them. The package writes milliseconds. */
function sourceView(s: FactSource): MemorySource {
  return s.kind === "document" ? { ...s, date: Math.floor(s.date / 1000) } : { ...s };
}

/** The words a routine refusal carries for a caller with none of its own. The form on the Customize page stops most of
 *  these before they are sent, and says the rest itself; the code is the package's own reason. */
const ROUTINE_REFUSAL: Record<RoutineRefusal, string> = {
  invalid_id: "A routine needs an id.",
  invalid_name: "A routine's name is 1 to 80 characters.",
  invalid_action: "That is not something a routine can do.",
  invalid_time_zone: "That is not a time zone.",
  invalid_trigger: "A routine needs to say when it runs.",
  invalid_time: "A time is written HH:MM, such as 08:00.",
  invalid_weekdays: "Pick at least one day of the week.",
  invalid_day: "A day of the month is 1 to 28, or the last day.",
  invalid_window: "A window needs two different times.",
  invalid_threshold: "The stock number is a whole number from 1.",
  must_ask_first: "A routine that replies, sends, pays or deletes always asks first.",
};

/** A routine and whether it is switched on. The routine is the package's own, so it can never be one that breaks its rules. */
interface StoredRoutine {
  routine: Routine;
  enabled: boolean;
}

/** A folder chat's or thread's turn runs under its own key; its events go out as the bot's, tagged `session`. */
const turnKey = (bot: string, session: string) => `${bot}\u0000${session}`;
const splitKey = (key: string): [string, string | undefined] => {
  const at = key.indexOf("\u0000");
  return at < 0 ? [key, undefined] : [key.slice(0, at), key.slice(at + 1)];
};

export interface MockHostOptions {
  /** Seconds since epoch; tests pin it. */
  now?: () => number;
  /** Scales every scripted wait (1 = as written, 0 = the next timer tick). */
  pace?: number;
}

export class MockHost {
  private readonly now: () => number;
  private readonly pace: number;
  private readonly listeners = new Set<(ev: MockEvent) => void>();
  private bots: Record<string, BotSeed & { running: boolean }> = {};
  private history: Record<string, Msg[]> = {};
  private models: Record<string, ModelCurrent> = {};
  private avatars: Record<string, { rev: number; data: string }> = {};
  private turns: Record<string, Turn> = {};
  private queues: Record<string, string[]> = {};
  private pending = new Map<string, Wait>();
  /** Every ask sent, by request id: `chat.open` sends the ones still waiting again, as a real runtime replays them. */
  private asked = new Map<string, MockEvent>();
  private folders = new Map<string, Folder>();
  private threadHistory = new Map<string, Msg[]>();
  private late = new Set<Timer>();
  private seq = 0;
  /** Mission Control: the staged jobs and activity log (times counted from the start), and Pause everyone. `stopped`
   *  is the jobs that were running when it began, which stay "paused" until Resume everyone. */
  private jobs: Job[] = [];
  private activity: ActivityEvent[] = [];
  private paused: { since: number; stopped: string[] } | null = null;
  /** What the team knows about the shop, in `@manut/shop-memory`'s own state: the package decides every change to it. */
  private memory: MemoryState = emptyState();
  /** The team's routines, in the order they were made. */
  private routines: StoredRoutine[] = [];
  /** Practice's sample shops (shops.ts): the one every page shows, and their requests still waiting, by request id. */
  private shop = OWN_SHOP;
  private shopAsks = new Map<string, WaitingAsk>();
  /** The shops the person made here with Make your shop (`shops.make`), oldest first. They live only as long as the page, as
   *  everything in Practice does, and nothing about them leaves it. */
  private made: ShopRow[] = [];
  /** The person's own shop's sample vault and outposts, for Customize › Connections (vault.ts). */
  private vault = new PracticeVault(0);
  /** The person's own shop's sample people, for Settings › People (people.ts). */
  private people = new PracticePeople(0);
  /** The person's own shop's sample Google Sheet, for Customize › Connections (google.ts). */
  private google = new PracticeGoogle(0);

  constructor(opts: MockHostOptions = {}) {
    this.now = opts.now ?? (() => Date.now() / 1000);
    this.pace = opts.pace ?? 1;
    this.reset();
  }

  /** Back to the staged start: every turn stops, every ask is forgotten. */
  reset(): void {
    for (const t of Object.values(this.turns)) t.timers.forEach(clearTimeout);
    for (const h of this.late) clearTimeout(h);
    this.late.clear();
    const boot = this.now();
    this.bots = Object.fromEntries(BOT_SEED.map((b) => [b.name, { ...b, running: false }]));
    this.history = Object.fromEntries(
      BOT_SEED.map((b) => [b.name, (HISTORY_SEED[b.name] ?? []).map(([role, text, ago], i) => ({ id: `seed-${b.name}-${i}`, role, text, ts: boot - ago }))]),
    );
    this.models = Object.fromEntries(BOT_SEED.map((b) => [b.name, { model: b.model, provider: b.provider, reasoning: b.reasoning }]));
    this.avatars = {};
    this.turns = {};
    this.queues = {};
    this.pending = new Map();
    this.asked = new Map();
    this.folders = new Map();
    this.threadHistory = new Map();
    this.seq = 0;
    this.paused = null;
    this.jobs = JOB_SEED.map((j) => {
      const steps = j.steps.map(([stage, ago]) => ({ stage, at: boot - ago }));
      const last = steps[steps.length - 1];
      return {
        id: j.id,
        title: j.title,
        bot: j.bot,
        stage: last.stage,
        at: last.at,
        goal: j.goal,
        again: j.again,
        steps,
        summary: j.summary,
        recipients: j.recipients.map((r) => ({ ...r })),
        costSatang: j.costSatang,
        tookSeconds: j.tookSeconds,
        trace: j.trace.map((t) => ({ ...t })),
      };
    });
    this.activity = ACTIVITY_SEED.map(({ ago, ...e }) => ({ ...e, text: e.text ? { ...e.text } : null, at: boot - ago }));
    this.memory = MEMORY_SEED.reduce((state, s) => {
      const learned = propose(state, s.text, s.source, Math.round((boot - s.ago) * 1000));
      if (!learned.ok) throw new Error(`the staged fact "${s.text}" was refused: ${learned.reason}`);
      return learned.state;
    }, emptyState());
    this.shop = OWN_SHOP;
    this.shopAsks = new Map();
    this.made = [];
    this.vault = new PracticeVault(boot);
    this.people = new PracticePeople(boot);
    this.google = new PracticeGoogle(boot, readPracticeGoogleStart());
    this.routines = ROUTINE_SEED.map((input) => {
      const made = createRoutine(input);
      if (!made.ok) throw new Error(`the staged routine "${input.name}" was refused: ${made.reason}`);
      return { routine: made.routine, enabled: true };
    });
  }

  subscribe(fn: (ev: MockEvent) => void): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  /** Answer one request, or throw the `OpError` that refuses it. */
  handle(op: string, params: Record<string, unknown> = {}): unknown {
    if (!Object.prototype.hasOwnProperty.call(this.ops, op)) throw new OpError("unknown_op", `no such op: ${op}`);
    if (this.shop === HELPED_SHOP) {
      const shown = this.helpedView(op, params);
      if (shown !== undefined) return shown;
    }
    return (this.ops[op as keyof AllOps] as (p: unknown) => unknown)(params);
  }

  /** While the person views Ran Pa Noi, the sample shop they help at: Buddy alone, with the requests, as a helper's shop
   *  shows on the connected runtime (its session reads only what waits there); the demo team's lists are empty, and its
   *  writes are refused in words. Undefined for an op answered as usual. */
  private helpedView(op: string, p: Record<string, unknown>): unknown {
    switch (op) {
      case "bots.list":
        return { bots: [this.publicBot(this.bots.buddy)] };
      case "chat.open": {
        if (p.bot !== "buddy") throw new OpError("unknown_bot", `no bot named ${String(p.bot)}`);
        const m = this.models.buddy;
        this.replayShopAsks();
        return { session_id: "main-buddy-ran-pa-noi", messages: [{ id: "ran-pa-noi-intro", role: "assistant", text: HELPED_INTRO, ts: this.now() }], running: false, model: m.model, provider: m.provider, reasoning: m.reasoning };
      }
      case "thread.list":
        return { threads: [] };
      case "routines.list":
      case "routine.list":
        return { routines: [] };
      case "automations.list":
        return { automations: [] };
      case "jobs.list":
        return { jobs: [] };
      case "activity.list":
        return { events: [], keptMonths: ACTIVITY_KEPT_MONTHS };
      case "memory.list":
        return { facts: [] };
      case "chat.send":
      case "chat.steer":
      case "thread.create":
      case "automations.add":
      case "routine.create":
      case "memory.remember":
      case "team.pause":
        throw new OpError("not_yet", HELPED_REFUSAL);
    }
    return undefined;
  }

  /** The sample shops' requests still waiting go out again after a reply, as a runtime replays its asks. */
  private replayShopAsks(): void {
    const waiting = [...this.shopAsks.values()].map((a) => a.ev);
    if (waiting.length) this.soon(() => waiting.forEach((e) => this.broadcast(e)));
  }

  /** /shops: the sample shops' requests arrive in Buddy's chat, and Needs you shows them, each naming its shop. */
  private scriptShops(key: string): void {
    this.schedule(key, [
      [
        150,
        () => {
          for (const a of sampleAsks("buddy", this.now())) {
            this.shopAsks.set(a.ev.request_id, a);
            this.broadcast(a.ev);
          }
        },
      ],
      [250, () => this.say(key, SHOPS_SAID)],
      [350, () => this.endTurn(key, "done")],
    ]);
  }

  /** An answer to a sample shop's request: taken once when the person's role there may decide its kind, as approval-core
   *  decides on the connected runtime; otherwise refused in the words its card says. */
  private answerShopAsk(id: string, choice: ApprovalChoice): Record<string, never> {
    const waiting = this.shopAsks.get(id);
    if (!waiting) throw new OpError("not_found", `no pending approval ${id}`);
    if (!waiting.ev.choices.includes(choice)) throw new OpError("not_permitted", `Only ${waiting.shop.owner} can decide this`);
    this.shopAsks.delete(id);
    return {};
  }

  /** A helper passing a sample request on to its owner, with a note: once, for a request only the owner decides. */
  private passOnShopAsk(id: string, note: unknown): { passed_on: { name: string; note: string; at: number } } {
    const waiting = this.shopAsks.get(id);
    if (!waiting) throw new OpError("not_found", `no pending approval ${id}`);
    // in the order the API refuses: only a helper passes a request on, one they may decide stays theirs, and once only
    if (waiting.shop.role !== "helper") throw new OpError("not_a_helper", "Only a helper passes a request on");
    if (waiting.ev.passed_on) throw new OpError("already_passed", `Already passed on to ${waiting.shop.owner}`);
    if (!waiting.ev.pass_on) throw new OpError("decide_yourself", "You can decide this one yourself");
    const text = typeof note === "string" ? note.trim() : "";
    if (!text || [...text].length > 500) throw new OpError("bad_note", "Write a note of 1 to 500 characters");
    const passed = { name: "", note: text, at: this.now() };
    const { pass_on: _gone, ...ev } = waiting.ev;
    this.shopAsks.set(id, { ...waiting, ev: { ...ev, passed_on: passed } });
    return { passed_on: passed };
  }

  // ---- helpers ----------------------------------------------------------------------------------------------

  private nextId(prefix: string): string {
    return `${prefix}-${++this.seq}`;
  }

  private broadcast(ev: MockEvent): void {
    for (const fn of [...this.listeners]) fn(ev);
  }

  /** An event of the chat `key` (a bot's main chat, or one of its folder chats or threads). */
  private ev(key: string, event: BridgeEvent["event"], fields: Record<string, unknown> = {}): void {
    const [bot, session] = splitKey(key);
    if (session !== undefined && event === "bot.status") return; // a thread never moves the bot's own status
    const out = (session !== undefined ? { event, bot, session, ...fields } : { event, bot, ...fields }) as unknown as BridgeEvent;
    if (out.event === "approval.request" || out.event === "clarify.request") this.asked.set(out.request_id, out);
    this.broadcast(out);
  }

  /** After the reply: an event a real runtime would send once the request has been answered. */
  private soon(fn: () => void): void {
    const h = setTimeout(() => {
      this.late.delete(h);
      fn();
    }, 0);
    this.late.add(h);
  }

  private needBot(p: { bot?: unknown }): BotSeed & { running: boolean } {
    if (typeof p.bot !== "string" || !p.bot) throw new OpError("bad_request", "missing bot");
    const b = this.bots[p.bot];
    if (!b) throw new OpError("unknown_bot", `no bot named ${p.bot}`);
    if (b.status === "offline") throw new OpError("bot_offline", `${p.bot} is offline`);
    return b;
  }

  private needFolder(session: unknown, bot: string): Folder {
    const f = typeof session === "string" ? this.folders.get(session) : undefined;
    if (!f || !f.open || f.bot !== bot) throw new OpError("not_found", "no such folder chat");
    return f;
  }

  private needThread(thread: unknown, bot: string): Folder {
    if (typeof thread !== "string" || !thread) throw new OpError("bad_request", "missing thread");
    const f = this.folders.get(thread);
    if (!f || !f.thread || f.archived || f.bot !== bot) throw new OpError("not_found", "no such thread");
    return f;
  }

  private needText(v: unknown, name: string): string {
    if (typeof v !== "string" || !v) throw new OpError("bad_request", `missing ${name}`);
    return v;
  }

  /** The chat an op acts on: the bot's main chat, or the folder chat or thread `session` names. */
  private target(p: { bot?: unknown; session?: unknown }): string {
    const b = this.needBot(p);
    if (p.session === undefined) return b.name;
    this.needFolder(p.session, b.name);
    return turnKey(b.name, p.session as string);
  }

  private publicBot(b: BotSeed & { running: boolean }): Bot {
    const m = this.models[b.name];
    return {
      name: b.name,
      display_name: b.display_name,
      is_default: b.is_default,
      description: b.description,
      status: b.status,
      running: b.running,
      model: m.model,
      provider: m.provider,
      avatar_rev: this.avatars[b.name]?.rev ?? null,
      ...(this.stoppedByPause(b.name) ? { paused: true } : {}),
    };
  }

  // ---- Mission Control -------------------------------------------------------------------------------------------

  /** Pause everyone stops every member but the lead, who keeps answering so the owner can ask why it is paused. */
  private stoppedByPause(bot: string): boolean {
    return !!this.paused && !!this.bots[bot] && !this.bots[bot].is_default;
  }

  private refusePaused(bot: string): void {
    if (this.stoppedByPause(bot)) throw new OpError("paused", PAUSED);
  }

  /** A job as the runtime reports it now: one that Pause everyone stopped reads "paused" from the moment of the pause. */
  private jobView(j: Job): Job {
    if (!this.paused || !this.paused.stopped.includes(j.id)) return copy(j);
    const since = this.paused.since;
    return copy({ ...j, stage: "paused" as const, at: since, steps: [...j.steps, { stage: "paused" as const, at: since }] });
  }

  /** The jobs running now, or while paused the ones that were running when it began. */
  private runningJobs(): Job[] {
    return this.jobs.filter((j) => (this.paused ? this.paused.stopped.includes(j.id) : j.stage === "working"));
  }

  private teamState(): TeamState {
    const running: PausedJob[] = this.runningJobs().map((j) => ({
      id: j.id,
      title: j.title,
      bot: j.bot,
      out: j.recipients.length ? { sent: j.recipients.filter((r) => r.status !== "waiting").length, total: j.recipients.length } : null,
    }));
    return {
      paused: !!this.paused,
      since: this.paused?.since ?? null,
      members: Object.values(this.bots).filter((b) => !b.is_default).map((b) => b.name),
      routines: this.routines.filter((r) => r.enabled).length,
      running,
    };
  }

  /** Every member the pause changed learns of it the way a real runtime would say a member changed. */
  private tellMembers(): void {
    for (const b of Object.values(this.bots)) if (!b.is_default) this.broadcast({ event: "bots.update", bot: b.name });
  }

  // ---- what the team knows -----------------------------------------------------------------------------------------

  /** The package counts milliseconds and the protocol seconds; this is the one place the clock crosses. */
  private nowMs(): number {
    return Math.round(this.now() * 1000);
  }

  private factView(f: Fact): MemoryFact {
    return {
      id: f.id,
      text: f.text,
      status: f.status,
      source: sourceView(f.source),
      at: f.updatedAt / 1000,
      correctedAt: f.correctedAt === undefined ? null : f.correctedAt / 1000,
    };
  }

  /** Keeps the state a package call came back with when it accepted the call. A refusal leaves the memory as it was (the
   *  package hands back the state it was given) and rejects with the package's reason as its code. */
  private applyMemory(r: Result): MemoryFact {
    if (!r.ok) throw new OpError(r.reason, MEMORY_REFUSAL[r.reason]);
    this.memory = r.state;
    return this.factView(r.fact);
  }

  // ---- the team's routines -----------------------------------------------------------------------------------------

  /** A routine as the runtime reports it now. A routine that is off has no next run, and the package gives none to an event
   *  (stock); it counts milliseconds and the protocol seconds. */
  private routineView({ routine, enabled }: StoredRoutine): RoutineRow {
    const next = enabled ? nextRun(routine, this.nowMs()) : null;
    return {
      id: routine.id,
      name: routine.name,
      when: describeTrigger(routine),
      action: routine.action,
      asksFirst: routine.asksFirst,
      enabled,
      next: next === null ? null : next / 1000,
      timeZone: routine.timeZone,
    };
  }

  private switchRoutine(id: unknown, enabled: boolean): RoutineRow {
    const key = this.needText(id, "routine");
    const stored = this.routines.find((r) => r.routine.id === key);
    if (!stored) throw new OpError("not_found", "No such routine.");
    stored.enabled = enabled;
    return this.routineView(stored);
  }

  // ---- scripted turns ---------------------------------------------------------------------------------------

  private schedule(key: string, steps: [number, () => void][]): void {
    const t = this.turns[key];
    if (!t) return;
    for (const [ms, fn] of steps) {
      t.timers.push(
        setTimeout(() => {
          if (this.turns[key] === t) fn();
        }, ms * this.pace),
      );
    }
  }

  private say(key: string, text: string): void {
    const id = this.nextId("a");
    const [bot, session] = splitKey(key);
    const rows = session === undefined ? this.history[bot] : this.threadHistory.get(session);
    rows?.push({ id, role: "assistant", text, ts: this.now() });
    this.ev(key, "message", { id, text });
  }

  private tool(key: string, tool_id: string, name: string, detail: string, startMs: number, endMs: number): [number, () => void][] {
    return [
      [startMs, () => this.ev(key, "tool.start", { tool_id, name, detail })],
      [endMs, () => this.ev(key, "tool.end", { tool_id, name, ok: true, ms: endMs - startMs })],
    ];
  }

  private startTurn(key: string, text: string): void {
    const [bot, session] = splitKey(key);
    this.turns[key] = { timers: [], text };
    if (session === undefined) this.bots[bot].running = true;
    this.ev(key, "bot.status", { status: this.bots[bot].status, running: true });
    this.ev(key, "turn.start");
    if (text.startsWith("/approve")) return this.scriptApproval(key);
    if (text.startsWith("/clarify")) return this.scriptClarify(key);
    if (text.startsWith("/interview")) return this.scriptInterview(key);
    if (text.startsWith("/delegate")) return this.scriptDelegate(key);
    if (text.startsWith("/shops")) return this.scriptShops(key);
    if (session !== undefined) return this.scriptThread(key, text);
    this.scriptNormal(key);
  }

  private endTurn(key: string, outcome: "done" | "interrupted", { drop = false } = {}): void {
    const t = this.turns[key];
    if (!t) return;
    t.timers.forEach(clearTimeout);
    for (const [id, w] of this.pending) if (w.key === key) this.pending.delete(id);
    delete this.turns[key];
    const [bot, session] = splitKey(key);
    if (session === undefined) this.bots[bot].running = false;
    if (drop) this.queues[key] = [];
    this.ev(key, "turn.end", { outcome });
    this.ev(key, "bot.status", { status: this.bots[bot].status, running: false });
    // A member Pause everyone stopped starts nothing, so a message that waited behind this turn keeps waiting for
    // Resume everyone (`startQueued` then sends it).
    if (!this.stoppedByPause(bot)) this.startQueued(key);
  }

  /** The next held message of a chat starts its turn, once the reply to the request that ended the last one is out. */
  private startQueued(key: string): void {
    if (this.turns[key]) return;
    const next = this.queues[key]?.shift();
    if (next !== undefined) this.soon(() => !this.turns[key] && this.startTurn(key, next));
  }

  private scriptNormal(key: string): void {
    const parts = [NORMAL_ANSWER.slice(0, 40), NORMAL_ANSWER.slice(40, 90), NORMAL_ANSWER.slice(90)];
    this.schedule(key, [
      [80, () => this.ev(key, "status", { text: "Looking into it…" })],
      [200, () => this.ev(key, "thinking")],
      ...this.tool(key, this.nextId("tool"), "read_orders", "today's orders", 350, 700),
      ...this.tool(key, this.nextId("tool"), "search_messages", "delivery", 750, 1150),
      [1200, () => this.ev(key, "thinking")],
      [1300, () => this.ev(key, "delta", { text: parts[0] })],
      [1450, () => this.ev(key, "delta", { text: parts[1] })],
      [1600, () => this.ev(key, "delta", { text: parts[2] })],
      [1700, () => this.say(key, NORMAL_ANSWER)],
      [1800, () => this.endTurn(key, "done")],
    ]);
  }

  private scriptThread(key: string, text: string): void {
    this.schedule(key, [
      ...this.tool(key, this.nextId("tool"), "read_notes", "this thread", 80, 300),
      [360, () => this.say(key, `Here is a sample answer in this thread. You said: ${text}`)],
      [460, () => this.endTurn(key, "done")],
    ]);
  }

  private scriptApproval(key: string): void {
    const request_id = this.nextId("approval");
    this.schedule(key, [
      [100, () => this.ev(key, "status", { text: APPROVAL_SEED.status })],
      [
        300,
        () => {
          this.pending.set(request_id, { key, kind: "approval" });
          this.ev(key, "approval.request", { request_id, title: APPROVAL_SEED.title, command: APPROVAL_SEED.command, choices: [...CHOICES] });
        },
      ],
    ]);
  }

  private resumeApproval(key: string, choice: ApprovalChoice): void {
    if (choice === "deny") return this.endTurn(key, "interrupted");
    this.schedule(key, [
      ...this.tool(key, this.nextId("tool"), "send_reply", APPROVAL_SEED.command, 100, 500),
      [600, () => this.say(key, APPROVAL_SEED.done(choice))],
      [700, () => this.endTurn(key, "done")],
    ]);
  }

  private scriptClarify(key: string): void {
    const request_id = this.nextId("clarify");
    this.schedule(key, [
      [100, () => this.ev(key, "status", { text: CLARIFY_SEED.status })],
      [
        250,
        () => {
          this.pending.set(request_id, { key, kind: "clarify" });
          this.ev(key, "clarify.request", { request_id, question: CLARIFY_SEED.question, choices: [...CLARIFY_SEED.choices] });
        },
      ],
    ]);
  }

  private scriptInterview(key: string): void {
    const request_id = this.nextId("interview");
    const questions: ClarifyQuestion[] = INTERVIEW_SEED.questions.map((q) => ({
      qid: q.qid,
      question: q.question,
      ...("choices" in q ? { choices: [...q.choices] } : {}),
      ...("multi_select" in q ? { multi_select: q.multi_select } : {}),
    }));
    this.schedule(key, [
      [
        150,
        () => {
          this.pending.set(request_id, { key, kind: "clarify", qids: questions.map((q) => q.qid) });
          this.ev(key, "status", { text: INTERVIEW_SEED.status });
          this.ev(key, "clarify.request", { request_id, question: questions[0].question, questions });
        },
      ],
    ]);
  }

  private resumeClarify(key: string, answer: string): void {
    this.schedule(key, [
      [100, () => this.say(key, `Got it, using ${answer}.`)],
      [200, () => this.endTurn(key, "done")],
    ]);
  }

  /** Two helpers that outlive the turn that started them, as a real background fan-out does: the turn ends first,
   *  then each helper reports back on its own (`/delegate fail` makes the second one fail). */
  private scriptDelegate(key: string): void {
    const fail = /\bfail\b/.test(this.turns[key]?.text ?? "");
    const delegation = this.nextId("deleg");
    const kids = [
      { id: this.nextId("sub"), goal: "Check stock for the weekend sale", step: "count_stock", out: "Every sale item is in stock." },
      { id: this.nextId("sub"), goal: "Draft the announcement", step: "write_draft", out: fail ? "The draft could not be saved." : "The draft is ready for you to read." },
    ];
    const tool_id = this.nextId("tool");
    const sub = (i: number, state: string, extra: Record<string, unknown> = {}) =>
      this.ev(key, "subagent", { id: kids[i].id, index: i, count: kids.length, goal: kids[i].goal, state, ...(state === "queued" ? {} : { delegation }), ...extra });
    this.schedule(key, [
      [80, () => this.ev(key, "tool.start", { tool_id, name: "delegate_task", detail: `${kids[0].goal} (+1 more)` })],
      [120, () => kids.forEach((_, i) => sub(i, "queued"))],
      [160, () => kids.forEach((_, i) => sub(i, "running"))],
      [220, () => this.ev(key, "tool.end", { tool_id, name: "delegate_task", ok: true, ms: 140 })],
      [420, () => kids.forEach((k, i) => sub(i, "running", { tool: "terminal", step: k.step }))],
      [500, () => this.say(key, "Both helpers are on it.")],
      [600, () => this.endTurn(key, "done")],
    ]);
    const later = (ms: number, fn: () => void) => {
      const h = setTimeout(() => {
        this.late.delete(h);
        fn();
      }, ms * this.pace);
      this.late.add(h);
    };
    later(1600, () => sub(0, "done", { summary: kids[0].out, seconds: 1.4 }));
    later(2600, () => sub(1, fail ? "failed" : "done", { summary: kids[1].out, seconds: 2.4 }));
  }

  // ---- ops --------------------------------------------------------------------------------------------------

  private readonly ops: Handlers = {
    hello: () => ({ bridge: "mock", version: "0.1.0", hermes: { home: "" } }),
    "bots.list": () => ({ bots: Object.values(this.bots).map((b) => this.publicBot(b)) }),
    "chat.open": (p) => {
      const b = this.needBot(p);
      const m = this.models[b.name];
      // asks still waiting on the person go out again after the reply
      const waiting = [...this.pending.keys()].map((id) => this.asked.get(id)).filter((e): e is MockEvent => !!e && e.bot === b.name && !("session" in e && e.session));
      if (waiting.length) this.soon(() => waiting.forEach((e) => this.broadcast(e)));
      if (b.name === "buddy") this.replayShopAsks();
      return { session_id: `main-${b.name}`, messages: [...this.history[b.name]], running: !!this.turns[b.name], model: m.model, provider: m.provider, reasoning: m.reasoning };
    },
    "chat.send": (p) => {
      const b = this.needBot(p);
      this.refusePaused(b.name);
      const text = this.needText(p.text, "text");
      const input_id = this.nextId("input");
      if (p.session !== undefined) {
        const f = this.needFolder(p.session, b.name);
        const key = turnKey(b.name, p.session);
        if (this.turns[key] && p.queued !== true) throw new OpError("busy", "a turn is running");
        if (f.thread) {
          this.threadHistory.get(p.session)?.push({ id: this.nextId("u"), role: "user", text, ts: this.now() });
          if (!f.title) {
            f.title = firstWords(text);
            const session = p.session;
            this.soon(() => this.broadcast({ event: "session.title", bot: b.name, session, title: f.title }));
          }
        }
        // a message the app held back waits behind a turn that is still running
        if (this.turns[key]) (this.queues[key] ??= []).push(text);
        else this.startTurn(key, text);
        return { input_id };
      }
      this.history[b.name].push({ id: this.nextId("u"), role: "user", text, ts: this.now() });
      if (this.turns[b.name]) (this.queues[b.name] ??= []).push(text);
      else this.startTurn(b.name, text);
      return { input_id };
    },
    // taken while that chat's turn runs, else rejected; never sent another way
    "chat.steer": (p) => {
      const key = this.target(p);
      this.needText(p.text, "text");
      return { status: this.turns[key] ? "queued" : "rejected" };
    },
    "chat.interrupt": (p) => {
      const key = this.target(p);
      if (this.turns[key]) this.endTurn(key, "interrupted", { drop: true });
      return {};
    },
    // An approval settles once: the first answer takes it out of `pending`, and any later answer is `not_found`.
    "approval.respond": (p) => {
      if (typeof p.request_id === "string" && this.shopAsks.has(p.request_id)) return this.answerShopAsk(p.request_id, p.choice);
      const key = this.target(p);
      this.refusePaused(splitKey(key)[0]);
      const id = this.needText(p.request_id, "request_id");
      if (!CHOICES.includes(p.choice)) throw new OpError("bad_request", "bad choice");
      const wait = this.pending.get(id);
      if (!wait || wait.key !== key || wait.kind !== "approval") throw new OpError("not_found", `no pending approval ${id}`);
      this.pending.delete(id);
      this.resumeApproval(key, p.choice);
      return {};
    },
    "approval.pass_on": (p) => (this.needBot(p), this.passOnShopAsk(this.needText(p.request_id, "request_id"), p.note)),
    "shops.list": () => ({ shops: this.shopRows(), current: this.shop, left: [] }),
    "shops.switch": (p) => {
      if (!this.shopRows().some((shop) => shop.id === p.shop)) throw new OpError("not_found", "no such shop");
      if (p.shop !== this.shop) {
        this.shop = p.shop;
        this.soon(() => this.broadcast({ event: "shops.update", bot: "buddy" }));
      }
      return {};
    },
    "shops.make": (p) => this.makeShop(p),
    "clarify.respond": (p) => {
      const key = this.target(p);
      this.refusePaused(splitKey(key)[0]);
      const id = this.needText(p.request_id, "request_id");
      const answers = p.answers;
      if (answers !== undefined) {
        if (!answers || typeof answers !== "object" || Array.isArray(answers) || !Object.values(answers).every((v) => v === null || typeof v === "string"))
          throw new OpError("bad_request", "answers must map question ids to text or null");
      } else if (typeof p.answer !== "string") throw new OpError("bad_request", "missing answer");
      const wait = this.pending.get(id);
      if (!wait || wait.key !== key || wait.kind !== "clarify") throw new OpError("not_found", `no pending clarification ${id}`);
      this.pending.delete(id);
      if (wait.qids) {
        const given = wait.qids.filter((q) => answers?.[q] != null).length;
        this.resumeClarify(key, `${given} of ${wait.qids.length} answers`);
      } else this.resumeClarify(key, p.answer ?? Object.values(answers ?? {}).find((v) => v !== null) ?? "");
      return {};
    },

    // ---- folder chats and threads: a chat of a member in a folder, its events tagged `session`
    "folder.open": (p) => {
      const b = this.needBot(p);
      const cwd = this.needText(p.cwd, "cwd");
      const session = this.nextId("f");
      const stored = this.nextId("stored-f");
      this.folders.set(session, { bot: b.name, cwd, open: true, stored, thread: false, title: "", started: this.now(), archived: false, key: null });
      return { session, stored, recorded: true, cwd, ...this.models[b.name] };
    },
    "folder.resume": (p) => {
      const b = this.needBot(p);
      const cwd = this.needText(p.cwd, "cwd");
      const stored = this.needText(p.stored, "stored");
      const was = [...this.folders.entries()].find(([, f]) => !f.thread && f.stored === stored && f.bot === b.name && f.cwd === cwd);
      if (!was) throw new OpError("not_found", "no such folder chat");
      was[1].open = true;
      return { session: was[0], stored, cwd, ...this.models[b.name], messages: [], running: false };
    },
    "folder.close": (p) => {
      const b = this.needBot(p);
      const f = this.folders.get(p.session);
      if (!f || !f.open || f.bot !== b.name) throw new OpError("not_found", "no such folder chat");
      f.open = false;
      const key = turnKey(f.bot, p.session);
      if (this.turns[key]) this.endTurn(key, "interrupted", { drop: true });
      return {};
    },
    "thread.create": (p) => {
      const b = this.needBot(p);
      this.refusePaused(b.name);
      if (p.title !== undefined && (typeof p.title !== "string" || !p.title.trim())) throw new OpError("bad_request", "title must be text");
      const ownKey = typeof p.key === "string" ? `${b.name}:${p.key}` : null;
      const old = ownKey ? [...this.folders.entries()].find(([, f]) => f.thread && f.key === ownKey) : undefined;
      const thread = old ? old[0] : this.nextId("thread");
      if (!old) {
        const title = p.title?.trim() ?? "";
        this.folders.set(thread, { bot: b.name, cwd: p.cwd ?? "", open: true, stored: thread, thread: true, title, started: this.now(), archived: false, key: ownKey });
        this.threadHistory.set(thread, []);
        this.soon(() => this.broadcast({ event: "thread.added", bot: b.name, thread, title }));
      }
      const f = this.folders.get(thread)!;
      return { thread, title: f.title, cwd: f.cwd, started_at: f.started, running: false, needs: false, message_count: 0, preview: "", ...this.models[b.name] };
    },
    "thread.list": (p) => {
      const b = this.needBot(p);
      const threads = [...this.folders.entries()]
        .filter(([, f]) => f.thread && f.bot === b.name && !f.archived)
        .map(([thread, f]) => {
          const key = turnKey(b.name, thread);
          const rows = this.threadHistory.get(thread) ?? [];
          return {
            thread,
            title: f.title,
            cwd: f.cwd,
            started_at: f.started,
            running: !!this.turns[key],
            needs: [...this.pending.values()].some((w) => w.key === key),
            message_count: rows.length,
            preview: rows.find((m) => m.role === "user")?.text ?? "",
          };
        })
        .sort((x, y) => y.started_at - x.started_at);
      return { threads };
    },
    "thread.open": (p) => {
      const b = this.needBot(p);
      const f = this.needThread(p.thread, b.name);
      return {
        thread: p.thread,
        session_id: p.thread,
        title: f.title,
        cwd: f.cwd,
        messages: [...(this.threadHistory.get(p.thread) ?? [])],
        running: !!this.turns[turnKey(b.name, p.thread)],
        ...this.models[b.name],
      };
    },
    "thread.remove": (p) => {
      const b = this.needBot(p);
      if (p.thread === `main-${b.name}`) throw new OpError("bad_request", "that is the main chat, not a thread");
      const f = this.needThread(p.thread, b.name);
      const key = turnKey(b.name, p.thread);
      for (const [id, w] of this.pending) {
        if (w.key !== key) continue;
        this.pending.delete(id);
        this.ev(key, "prompt.expired", { request_id: id, reason: "cancelled" });
      }
      if (this.turns[key]) this.endTurn(key, "interrupted", { drop: true });
      f.archived = true;
      f.open = false;
      const thread = p.thread;
      this.soon(() => this.broadcast({ event: "thread.removed", bot: b.name, thread }));
      return { thread, archived: true };
    },

    // ---- a member's own details
    "bots.rename": (p) => {
      const b = this.needBot(p);
      if (typeof p.name !== "string") throw new OpError("bad_request", "name must be text");
      const name = p.name.split(/\s+/).filter(Boolean).join(" ");
      if (name.length > 64) throw new OpError("bad_request", `name is too long (${name.length} characters, max 64)`);
      b.display_name = name || (BOT_SEED.find((x) => x.name === b.name)?.display_name ?? b.name);
      this.broadcast({ event: "bots.update", bot: b.name });
      return { display_name: b.display_name };
    },
    "bots.avatar": (p) => {
      const a = this.avatars[this.needBot(p).name];
      return { rev: a?.rev ?? null, data: a?.data ?? null };
    },
    "bots.set_avatar": (p) => {
      const b = this.needBot(p);
      if (p.clear === true) delete this.avatars[b.name];
      else {
        if (typeof p.data !== "string" || !/^data:image\/(png|jpeg|webp);base64,/.test(p.data)) throw new OpError("bad_request", "use a PNG, JPEG or WebP picture");
        if (p.data.length > 2_700_000) throw new OpError("bad_request", "picture is larger than 2 MB");
        this.avatars[b.name] = { rev: ++this.seq, data: p.data };
      }
      this.broadcast({ event: "bots.update", bot: b.name });
      return { avatar_rev: this.avatars[b.name]?.rev ?? null };
    },
    "bots.info": (p) => {
      this.needBot(p);
      return { places: {}, first_active: null, last_active: null, skills: SKILL_SEED.length, routines: 0 };
    },
    "bots.ready": (p) => {
      const b = this.needBot(p);
      return { ok: true, provider: this.models[b.name].provider, model: this.models[b.name].model, error: "" };
    },
    "models.options": (p) => {
      const b = this.needBot(p);
      return { providers: PROVIDERS.map((x) => ({ ...x, models: [...x.models] })), current: { ...this.models[b.name] }, reasoning_levels: [...REASONING_LEVELS] };
    },
    "chat.set_model": (p) => {
      const b = this.needBot(p);
      const cur = this.models[b.name];
      if (p.provider !== undefined && !PROVIDERS.some((x) => x.slug === p.provider)) throw new OpError("bad_request", `unknown provider ${p.provider}`);
      if (p.reasoning !== undefined && !REASONING_LEVELS.includes(p.reasoning)) throw new OpError("bad_request", `unknown reasoning level ${p.reasoning}`);
      if (p.model !== undefined && typeof p.model !== "string") throw new OpError("bad_request", "model must be a string");
      const next = { model: p.model ?? cur.model, provider: p.provider ?? cur.provider, reasoning: p.reasoning ?? cur.reasoning };
      if (p.session !== undefined) {
        this.needFolder(p.session, b.name); // a thread's model changes for that thread only, so the member keeps its own
        return next;
      }
      this.models[b.name] = next;
      return { ...next };
    },
    "skills.list": (p) => (this.needBot(p), { skills: SKILL_SEED.map((x) => ({ ...x })) }),
    "commands.list": (p) => (this.needBot(p), { commands: COMMAND_SEED.map((x) => ({ ...x })) }),
    // Stages a file for the next message. The demo keeps no bytes: it answers the line a real runtime would add.
    "chat.attach": (p) => {
      this.needBot(p);
      const name = this.needText(p.name, "name");
      this.needText(p.data_base64, "data_base64");
      if (p.kind === "image") return { kind: p.kind, name, text: `[User attached image: ${name}]`, ref_text: "" };
      if (p.kind === "pdf") return { kind: p.kind, name, text: `[User attached PDF: ${name}]`, ref_text: "" };
      if (p.kind === "file") return { kind: p.kind, name, text: "", ref_text: `@file:attachments/${name}` };
      throw new OpError("bad_request", "need kind image|pdf|file");
    },
    "media.read": () => {
      throw new OpError("not_found", "not a file this chat sent");
    },

    // ---- the side panel and Plans: nothing has run, so every list is empty
    "panel.terminal": (p) => (this.needBot(p), { runs: [] }),
    "panel.worktrees": (p) => (this.needBot(p), { worktrees: [] }),
    "panel.diff": () => {
      throw new OpError("not_found", "nothing to show yet");
    },
    "runs.list": (p) => (this.needBot(p), { runs: [] }),
    "runs.get": (p) => {
      throw new OpError("not_found", `no run ${p.run}`);
    },
    "runs.prs": () => ({ prs: {} }),
    "runs.cli": () => ({ runs: [], agents: { claude: "no_adapter", codex: "no_adapter", omo: "no_adapter", pi: "no_adapter", omp: "no_adapter", grok: "no_adapter" } }),
    "runs.node_session": (p) => (this.needBot(p), { session: null }),
    "cli.title": () => ({ title: "" }),
    "tasks.linear": (p) => (this.needBot(p), { configured: false, server: "" }),

    // ---- capabilities this runtime does not have: reads are empty, writes are refused
    "elsewhere.list": (p) => (this.needBot(p), { sessions: [] }),
    "elsewhere.peek": () => {
      throw new OpError("not_found", "no such session");
    },
    "links.places": (p) => (this.needBot(p), { places: { slack: {}, discord: {} } }),
    "routines.list": (p) => (this.needBot(p), { routines: [] }),
    "automations.list": () => ({ automations: [] }),
    "automations.add": () => this.unsupported(),
    "automations.pause": () => this.unsupported(),
    "automations.resume": () => this.unsupported(),
    "automations.remove": () => this.unsupported(),
    "plugins.list": (p) => (this.needBot(p), { plugins: [] }),
    "plugins.catalog": (p) => (this.needBot(p), { total: 0, matched: 0, entries: [], categories: {}, generated_at: null }),
    "plugins.inspect": () => this.unsupported(),
    "plugins.install": () => this.unsupported(),
    "plugins.toggle": () => this.unsupported(),
    "plugins.update": () => this.unsupported(),
    "plugins.reload": () => this.unsupported(),
    "plugins.remove": () => this.unsupported(),
    "bots.restart": () => ({ outcome: "failed", line: UNSUPPORTED }),
    "bots.restart_scope": (p) => {
      const b = this.needBot(p);
      return { gateway: b.name, bots: [{ name: b.name, display_name: b.display_name }] };
    },
    "peers.probe": () => this.unsupported(),
    "peers.attach": () => this.unsupported(),
    "peers.detach": () => ({}),
    "usage.read": () => ({ providers: [] }),
    "accounts.list": () => ({ groups: [] }),
    "accounts.add": () => this.unsupported(),
    "accounts.set_active": () => this.unsupported(),
    "accounts.remove": () => this.unsupported(),
    "accounts.label": () => this.unsupported(),
    "accounts.discard": () => this.unsupported(),

    // ---- Mission Control: jobs, the activity log and Pause everyone
    "jobs.list": () => ({
      jobs: this.jobs
        .map((j) => this.jobView(j))
        .map(({ id, title, bot, stage, at }) => ({ id, title, bot, stage, at }))
        .sort((x, y) => y.at - x.at),
    }),
    "jobs.get": (p) => {
      const id = this.needText(p.job, "job");
      const job = this.jobs.find((j) => j.id === id);
      if (!job) throw new OpError("not_found", `no job ${id}`);
      return this.jobView(job);
    },
    "activity.list": () => ({ events: copy([...this.activity].sort((x, y) => y.at - x.at)), keptMonths: ACTIVITY_KEPT_MONTHS }),
    "team.state": () => this.teamState(),
    // Pausing is the one op here that acts. Every member but the lead stops at once, except a turn that waits on the
    // owner's answer, which keeps waiting (nothing expires while paused). It touches nothing already done.
    "team.pause": () => {
      if (!this.paused) {
        this.paused = { since: this.now(), stopped: this.runningJobs().map((j) => j.id) };
        for (const key of Object.keys(this.turns)) {
          if (!this.stoppedByPause(splitKey(key)[0])) continue;
          if ([...this.pending.values()].some((w) => w.key === key)) continue;
          this.endTurn(key, "interrupted");
        }
        this.tellMembers();
      }
      return this.teamState();
    },
    "team.resume": () => {
      if (this.paused) {
        this.paused = null;
        this.tellMembers();
        for (const key of Object.keys(this.queues)) this.startQueued(key);
      }
      return this.teamState();
    },

    // ---- what the team knows: every answer is the package's, with the clock and the units changed at the edge
    "memory.list": () => ({ facts: this.memory.facts.map((f) => this.factView(f)) }),
    "memory.remember": (p) => ({ fact: this.applyMemory(rememberFact(this.memory, p.text, this.nowMs())) }),
    "memory.confirm": (p) => ({ fact: this.applyMemory(confirmFact(this.memory, this.needText(p.fact, "fact"), this.nowMs())) }),
    "memory.correct": (p) => ({ fact: this.applyMemory(correctFact(this.memory, this.needText(p.fact, "fact"), p.text, this.nowMs())) }),
    "memory.forget": (p) => {
      const id = this.needText(p.fact, "fact");
      const forgotten = forgetFact(this.memory, id);
      if (!forgotten.ok) throw new OpError(forgotten.reason, MEMORY_REFUSAL[forgotten.reason]);
      this.memory = forgotten.state;
      return { fact: id };
    },

    // ---- the team's routines: the package makes each routine, says its timing and works out its next run
    "routine.list": () => ({ routines: this.routines.map((r) => this.routineView(r)) }),
    "routine.create": (p) => {
      // The caller's own timing object is not kept: a routine made from it must not change when the caller later edits it.
      const trigger = typeof p.trigger === "object" && p.trigger !== null ? copy(p.trigger) : p.trigger;
      const made = createRoutine({ id: this.nextId("routine"), name: p.name, action: p.action, trigger, ...(p.asksFirst === undefined ? {} : { asksFirst: p.asksFirst }) });
      if (!made.ok) throw new OpError(made.reason, ROUTINE_REFUSAL[made.reason]);
      const stored: StoredRoutine = { routine: made.routine, enabled: true };
      this.routines.push(stored);
      return { routine: this.routineView(stored) };
    },
    "routine.pause": (p) => ({ routine: this.switchRoutine(p.routine, false) }),
    "routine.resume": (p) => ({ routine: this.switchRoutine(p.routine, true) }),

    // ---- Customize › Connections: the sample vault and outposts, which only the person's own shop has. The list is the
    // shop being viewed; a change acts on the shop its row was read for, as on the connected runtime.
    "connections.list": () => this.atVault(this.shop, () => ({ ok: true, value: this.vault.list(OWN_SHOP) })),
    "connections.add": (p) => this.atVault(p.shop, () => {
      const { shop: _shop, ...fields } = p;
      const added = this.vault.add(fields, this.now());
      return added.ok ? { ok: true, value: { signIn: added.value } } : added;
    }),
    "connections.password": (p) => this.atVault(p.shop, () => {
      const changed = this.vault.password(p.signIn, p.password, this.now());
      return changed.ok ? { ok: true, value: { signIn: changed.value } } : changed;
    }),
    "connections.members": (p) => this.atVault(p.shop, () => {
      const changed = this.vault.members(p.signIn, p.members);
      return changed.ok ? { ok: true, value: { signIn: changed.value } } : changed;
    }),
    "connections.change": (p) => this.atVault(p.shop, () => {
      const { shop: _shop, signIn, ...fields } = p;
      const changed = this.vault.change(signIn, fields, this.now());
      return changed.ok ? { ok: true, value: { signIn: changed.value } } : changed;
    }),
    "connections.removeSignIn": (p) => this.atVault(p.shop, () => {
      const removed = this.vault.removeSignIn(p.signIn);
      return removed.ok ? { ok: true, value: { signIn: removed.value } } : removed;
    }),
    "connections.rename": (p) => this.atVault(p.shop, () => {
      const renamed = this.vault.rename(p.outpost, p.name);
      return renamed.ok ? { ok: true, value: { outpost: renamed.value } } : renamed;
    }),
    "connections.remove": (p) => this.atVault(p.shop, () => {
      const removed = this.vault.remove(p.outpost);
      return removed.ok ? { ok: true, value: { outpost: removed.value } } : removed;
    }),

    // ---- Customize › Connections, Google Sheets: the sample sheet, which only the person's own shop has (google.ts). Nothing is
    // sent and no window opens; a change acts on the shop its row was read for, as on the connected runtime.
    "google.status": () => this.atGoogle(this.shop, () => ({ ok: true, value: this.google.status(OWN_SHOP, this.now()) })),
    "google.connect": (p) => this.atGoogle(p.shop, () => this.google.connect(this.now())),
    "google.disconnect": (p) => this.atGoogle(p.shop, () => this.google.disconnect()),
    "google.books": (p) => this.atGoogle(p.shop, () => this.google.books(p.month, this.nowMs())),

    // ---- Settings › People: the sample owner, helper and invite, which only the person's own shop has. The list is the shop
    // being viewed; a change acts on the shop its list was read for, as on the connected runtime.
    "people.list": () => this.atPeople(this.shop, () => ({ ok: true, value: this.people.list(OWN_SHOP, this.now()) })),
    "people.invite": (p) => this.atPeople(p.shop, () => {
      const made = this.people.makeInvite(p.name, p.identity, this.now());
      return made.ok ? { ok: true, value: { invite: made.value } } : made;
    }),
    "people.cancelInvite": (p) => this.atPeople(p.shop, () => {
      const done = this.people.cancelInvite(p.invite);
      return done.ok ? { ok: true, value: { invite: done.value } } : done;
    }),
    "people.remove": (p) => this.atPeople(p.shop, () => this.people.remove(p.helper)),
    "people.setAway": (p) => this.atPeople(p.shop, () => {
      const done = this.people.setAway(p.helper, p.until, this.now());
      return done.ok ? { ok: true, value: { away: done.value } } : done;
    }),
    "people.clearAway": (p) => this.atPeople(p.shop, () => {
      const done = this.people.clearAway();
      return done.ok ? { ok: true, value: { away: done.value } } : done;
    }),
  };

  /** The person's shops as the switcher lists them: the ones they own first (their own sample shop, then each one they made
   *  here, oldest first), then Ran Pa Noi, which they help at, as the API lists a person's shops. */
  private shopRows(): ShopRow[] {
    const [own, ...helped] = sampleShops();
    return [own!, ...this.made.map((shop) => ({ ...shop })), ...helped];
  }

  /** Make your shop, in Practice: a shop of the person's own, named as they typed, with no network. It refuses as the API
   *  would (a name it would not keep, a kind it does not have, more than `MADE_SHOPS_LIMIT` made shops), and is then listed
   *  with their other shops and shown on every page, with the demo team, as the API's own shop would be. */
  private makeShop(p: OpMap["shops.make"]["params"]): OpMap["shops.make"]["result"] {
    const name = shopNameOf(p.name);
    if (!name) throw new OpError("invalid_name", "A shop's name is 1 to 80 characters.");
    const ownerName = shopNameOf(p.ownerName);
    if (!ownerName) throw new OpError("invalid_owner_name", "Your name is 1 to 80 characters.");
    if (p.template !== null && !isShopTemplateId(p.template)) throw new OpError("unknown_template", "There is no such kind of shop.");
    if (this.made.length >= MADE_SHOPS_LIMIT) {
      throw new OpError("too_many_shops", `One account can make ${MADE_SHOPS_LIMIT} shops, and this one has.`);
    }
    const shop: ShopRow = { id: `practice:made-${this.made.length + 1}`, name, owner: ownerName, role: "owner" };
    this.made.push(shop);
    this.shop = shop.id;
    this.soon(() => this.broadcast({ event: "shops.update", bot: "buddy" }));
    return { shop: { ...shop } };
  }

  /** Runs a Connections op on `shop`'s sample vault: the person's own shop's. At Ran Pa Noi they are a helper, and only Noi,
   *  its owner, sees its sign-ins and outposts, as the API answers a helper's session; any other shop is not theirs. */
  private atVault<T>(shop: unknown, run: () => VaultResult<T>): T {
    if (shop === HELPED_SHOP) throw new OpError("owner_only", "Only Noi, the shop's owner, sees its sign-ins and outposts.");
    if (this.made.some((one) => one.id === shop)) throw new OpError("not_yet", MADE_IN_PRACTICE);
    if (shop !== OWN_SHOP) throw new OpError("not_found", "no such shop");
    const done = run();
    if (!done.ok) throw new OpError(done.code, done.message);
    return done.value;
  }

  /** Runs a Google Sheets op on `shop`'s sample sheet: the person's own shop's. At Ran Pa Noi they are a helper, and only Noi, its
   *  owner, sees or changes its Google Sheets, as the API answers a helper's session; any other shop is not theirs. */
  private atGoogle<T>(shop: unknown, run: () => GoogleResult<T>): T {
    if (shop === HELPED_SHOP) throw new OpError("owner_only", "Only Noi, the shop's owner, sees or changes its Google Sheets.");
    if (this.made.some((one) => one.id === shop)) throw new OpError("not_yet", MADE_NO_SHEET);
    if (shop !== OWN_SHOP) throw new OpError("not_found", "no such shop");
    const done = run();
    if (!done.ok) throw new OpError(done.code, done.message);
    return done.value;
  }

  /** Runs a People op on `shop`'s sample people: the person's own shop's. At Ran Pa Noi they are a helper, and only Noi, its owner,
   *  sees or changes who can help there, as the API answers a helper's session; any other shop is not theirs. */
  private atPeople<T>(shop: unknown, run: () => PeopleResult<T>): T {
    if (shop === HELPED_SHOP) throw new OpError("owner_only", "Only Noi, the shop's owner, sees or changes who can help at Ran Pa Noi.");
    if (this.made.some((one) => one.id === shop)) throw new OpError("not_yet", MADE_IN_PRACTICE);
    if (shop !== OWN_SHOP) throw new OpError("not_found", "no such shop");
    const done = run();
    if (!done.ok) throw new OpError(done.code, done.message);
    return done.value;
  }

  private unsupported(): never {
    throw new OpError("unsupported", UNSUPPORTED);
  }
}

/** What People and Connections say about a shop made in Practice, which has no sample people or sign-ins of its own. */
const MADE_NO_SHEET = "A shop you made in Practice has no sample Google Sheet. Switch back to your own shop to try it.";
const MADE_IN_PRACTICE = "A shop you made in Practice has no sample helpers or sign-ins. Switch back to your own shop to try them.";

let shared: MockHost | null = null;
/** The one runtime every adapter in this page talks to, as every client of a real runtime would. */
export function sharedHost(): MockHost {
  return (shared ??= new MockHost());
}
