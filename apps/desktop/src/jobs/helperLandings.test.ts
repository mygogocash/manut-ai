// Item 102i in the sessions store, against a stand-in shell whose `lane_land`, `lane_take_back` and `lane_patch` answer as the test
// says (each outcome of src-tauri/src/lane_land.rs) and a stand-in agent driven by hand, as helperRuns.test.ts drives its lanes: each
// helper lane that reports finished work lands in its lead's folder, one at a time in the order they reported; each row names its
// outcome (landed, conflicts named, kept as a patch with its reason, outside the project, refused, keys by file); Show patch reads the
// kept patch; Take back calls the shell and says its reason when refused; a stopped or failed helper lands nothing; a round whose
// landings are all settled is handed over with nothing sent to the lead.
//
// The slice's safety test (R8 of docs/several-agents.md): no landing starts while the lead's turn runs or an ask or a question of the
// lead waits on the person, a message to the lead waits while a landing writes its folder, and no landing starts between that message
// and its turn.
import { beforeEach, describe, expect, it } from "vitest";
import { resetLanes } from "../code/laneStore";
import { resetKitProjects } from "../code/project";
import { resetKitAsks } from "../code/kitAsks";
import type { LaneMade } from "../code/laneBranch";
import { createStore, selectAsks, type BridgeLike, type HelpersAskItem } from "../state/store";
import { createSessions, type SessionClock } from "../sessions/sessions";
import type { ChatEvent, ChatInput, SessionHost } from "../sessions/host";
import { resetHelpersAsks } from "./helperAsks";
import type { RoundLanded } from "./helperLandings";
import { readLanded } from "./landingWire";
import { landingOutcome } from "./rules";

const bridge: BridgeLike = { connect: async () => undefined, onAny: () => () => {}, onStatus: () => () => {}, request: (async () => ({})) as BridgeLike["request"] };
const DEV = "/w/baanmali-preorder";
const LANES = "/w/.manut/lanes/baanmali-preorder";
const GB = 1024 ** 3;
const tick = () => new Promise((r) => setTimeout(r, 0));
const settle = async () => {
  for (let i = 0; i < 30; i++) await tick();
};

const block = (o: Record<string, unknown>) => `\`\`\`manut-helpers\n${JSON.stringify(o)}\n\`\`\``;
const ask = (blocks: Record<string, unknown>[]) => ["Splitting this.", "", ...blocks.map(block)].join("\n\n");
const THREE = ask([
  { title: "Tests for the QR builder", brief: "Write tests in src/qr.test.ts.", agent: "codex" },
  { title: "The receipt's Thai date", brief: "Show the Thai date in src/receipt.tsx." },
  { title: "LINE share button", brief: "Add a Share to LINE button.", agent: "codex" },
]);

/** The shell's `Landed` answer, as its serde writes it. */
const landedAs = (o: Record<string, unknown>) => ({ outcome: "landed", files: [], files_total: 0, conflicts: [], cut: [], cut_total: 0, keys: [], patch: "", why: "", outside: [], error: "", ...o });
const CLEAN = landedAs({ files: ["src/qr.test.ts"], files_total: 1, keys: ["src/qr.test.ts"] });
const CONFLICTS = landedAs({ files: ["src/receipt.tsx", "src/qr.ts"], files_total: 2, conflicts: ["src/qr.ts"] });
const KEPT = landedAs({ outcome: "kept", files: ["src/line.ts"], files_total: 1, patch: "/w/.manut/patches/j1/lead-help-3.patch", why: "would_not_apply", error: "error: src/line.ts: does not exist in index" });
const OUTSIDE = landedAs({ outcome: "kept", files: ["../other/app.ts"], files_total: 1, patch: "/w/.manut/patches/j1/lead-help-1.patch", why: "outside", outside: ["../other/app.ts"] });
const PATCH = "diff --git a/src/line.ts b/src/line.ts\n--- a/src/line.ts\n+++ b/src/line.ts\n@@ -1 +1 @@\n-old\n+new\n";

/** What one landing call saw: the helper lane it named, and whether its lead was busy then. */
interface LandCall {
  helper: string;
  leadWorking: boolean;
  leadAsks: number;
}

async function setup(over: { landings?: Record<number, unknown>; takeBack?: Record<number, string>; patches?: Record<number, string>; memory?: number; noShell?: boolean } = {}) {
  (globalThis as { localStorage?: unknown }).localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
  resetKitProjects();
  resetKitAsks();
  resetHelpersAsks();
  resetLanes();
  const sinks = new Map<string, (e: ChatEvent) => void>();
  const byHost = new Map<number, string>();
  const inputs: { session: string; input: ChatInput }[] = [];
  const lands: LandCall[] = [];
  const takeBacks: string[] = [];
  const patches: string[] = [];
  let next = 0;
  let helpers = 0;
  let inFlight = 0;
  let most = 0;
  /** while set, each landing waits for it: a barrier inside the stand-in shell */
  let gate: { wait: Promise<void>; open: () => void } | null = null;
  /** the lead lane, read by the stand-in shell as each landing starts */
  let leadId = "";
  const clock: SessionClock = { now: () => Date.now(), every: () => () => {} };
  const numberOf = (helper: string) => Number(/-help-(\d+)$/.exec(helper)?.[1] ?? 0);
  const host = {
    kind: "mock",
    reset: async () => {},
    agents: async () => [
      { id: "claude", label: "Claude Code", mode: "chat", path: "/bin/claude" },
      { id: "codex", label: "Codex", mode: "chat", path: "/bin/codex" },
    ],
    home: async () => "/w",
    pickFolder: async () => null,
    branch: async (cwd: string) => (cwd === DEV ? "main" : "kit/x"),
    chatStart: async (_agent: string, _cwd: string, on: (e: ChatEvent) => void, _r?: string, _acc?: string, session?: string) => {
      const id = ++next;
      byHost.set(id, session ?? "");
      sinks.set(session ?? "", on);
      return id;
    },
    chatInput: async (id: number, input: ChatInput) => {
      inputs.push({ session: byHost.get(id) ?? "", input });
    },
    chatClose: async () => {},
    removeFiles: async () => {},
    pruneFiles: async () => {},
    historyPrune: async () => {},
    laneWorktree: async (_cwd: string, names: string[]) =>
      ({ branch: names[0], base: "main", dir: `${LANES}/lead`, worktree: `${LANES}/lead`, left: 0, from: "", local: "", config: 0, stayed: 0 }) satisfies LaneMade,
    laneHelperWorktree: async (lead: string) => {
      const n = ++helpers;
      const dir = `${lead}-help-${n}`;
      return { branch: `kit/lead-help-${n}`, base: "kit/lead", dir, worktree: dir, left: 0, from: "", local: "", config: 0, stayed: 0 } satisfies LaneMade;
    },
    machineMemory: async () => over.memory ?? 32 * GB,
    ...(over.noShell
      ? {}
      : {
          // as lane_land.rs answers, one at a time per lead folder on its own side too
          laneLand: async (helper: string) => {
            const key = ss.chatKey(leadId)!;
            lands.push({ helper, leadWorking: !!store.getState().chats[key]?.turn, leadAsks: selectAsks(store.getState()).filter((a) => a.bot === key).length });
            inFlight++;
            most = Math.max(most, inFlight);
            try {
              if (gate) await gate.wait;
              const said = (over.landings?.[numberOf(helper)] ?? CLEAN) as { refuse?: string };
              if (said.refuse) throw said.refuse; // the shell rejects with its code, as Tauri hands a command's Err over
              return readLanded(said)!;
            } finally {
              inFlight--;
            }
          },
          laneTakeBack: async (helper: string) => {
            takeBacks.push(helper);
            const refused = over.takeBack?.[numberOf(helper)];
            if (refused) throw refused;
            return { files: ["src/qr.test.ts"], filesTotal: 1 };
          },
          lanePatch: async (helper: string) => {
            patches.push(helper);
            const text = over.patches?.[numberOf(helper)];
            if (text === undefined) throw "no_patch";
            return { text, bytes: text.length, cut: false, path: "/w/.manut/patches/j1/lead-help-3.patch" };
          },
        }),
  } as unknown as SessionHost;
  const store = createStore(bridge);
  const ss = createSessions(host, () => store, () => null, () => null, clock);
  await ss.loadAgents();
  const handed: RoundLanded[] = [];
  ss.whenHelperRoundLanded((r) => handed.push(r));
  const chat = (id: string) => store.getState().chats[ss.chatKey(id)!];
  const emit = (id: string, e: ChatEvent) => sinks.get(id)?.(e);
  const turn = async (id: string, text: string, outcome = "done") => {
    emit(id, { event: "turn.start" });
    emit(id, { event: "message", id: `m${Math.random()}`, text });
    emit(id, { event: "turn.end", outcome });
    await settle();
  };
  const lead = async (text = THREE) => {
    const id = ss.draft("claude" as never);
    leadId = id;
    ss.setDraft(id, { cwd: DEV });
    await ss.start(id, "Add a PromptPay QR");
    ss.setHelpers(id, true);
    await turn(id, text);
    const card = (chat(id)?.items ?? []).find((i): i is HelpersAskItem => i.kind === "helpersAsk")!;
    expect(await ss.answerHelpers(id, card.id, true)).toEqual({ ok: true });
    await settle();
    return { id, round: card.id };
  };
  const helperIds = () => ss.getState().list.filter((r) => r.helperOf).sort((a, b) => a.helperOf!.index - b.helperOf!.index).map((r) => r.id);
  const dirOf = (id: string) => ss.getState().list.find((r) => r.id === id)!.lane!.worktree!;
  const sends = (session: string) => inputs.filter((i) => i.session === session && i.input.kind === "send");
  return {
    ss,
    store,
    lands,
    takeBacks,
    patches,
    handed,
    emit,
    turn,
    lead,
    helperIds,
    dirOf,
    sends,
    most: () => most,
    hold: () => {
      let open = () => {};
      const wait = new Promise<void>((r) => (open = r));
      gate = { wait, open };
      return () => {
        gate = null;
        open();
      };
    },
  };
}

beforeEach(() => resetLanes());

describe("landing each helper lane that reports (R8)", () => {
  it("lands one at a time in the order they reported, names each outcome on its row and in the round, and hands the round over", async () => {
    const t = await setup({ landings: { 1: CLEAN, 2: CONFLICTS, 3: KEPT } });
    const { id, round } = await t.lead();
    const [h1, h2, h3] = t.helperIds();
    const leadSends = t.sends(id).length;
    // the first landing is held inside the shell; the others report meanwhile
    const open = t.hold();
    await t.turn(h2, "Helper 2: done.");
    expect(t.lands.map((c) => c.helper)).toEqual([t.dirOf(h2)]);
    await t.turn(h1, "Helper 1: done.");
    await t.turn(h3, "Helper 3: done.");
    expect(t.lands).toHaveLength(1);
    expect(t.ss.helperLandings(round).map((l) => [l.index, l.step])).toEqual([
      [0, "waiting"],
      [1, "landing"],
      [2, "waiting"],
    ]);
    open();
    await settle();
    // in the order they reported, never two at once
    expect(t.lands.map((c) => c.helper)).toEqual([t.dirOf(h2), t.dirOf(h1), t.dirOf(h3)]);
    expect(t.most()).toBe(1);
    const rows = t.ss.helperLandings(round);
    expect(rows.map((l) => [l.step, landingOutcome(l.landing ?? null)])).toEqual([
      ["settled", "landed"],
      ["settled", "landed"],
      ["settled", "keptPatch"],
    ]);
    // a key is named by its file, and only by its file
    expect(rows[0].landing).toMatchObject({ files: [{ path: "src/qr.test.ts" }], keys: ["src/qr.test.ts"] });
    expect(rows[1].landing).toMatchObject({ conflicts: ["src/qr.ts"] });
    expect(rows[2].landing).toMatchObject({ patchPath: "/w/.manut/patches/j1/lead-help-3.patch", error: "error: src/line.ts: does not exist in index" });
    // the round's reports carry each landing for item 102j, and the round is handed over once, with nothing sent to the lead
    const reports = t.ss.helperRounds(id).rounds[0].reports;
    expect([...reports].sort((a, b) => a.index - b.index).map((r) => landingOutcome(r.landing === "pending" ? null : r.landing))).toEqual(["landed", "landed", "keptPatch"]);
    expect(t.handed).toHaveLength(1);
    expect(t.handed[0]).toMatchObject({ lead: id, round });
    expect(t.handed[0].landings.map((l) => [l.index, landingOutcome(l.landing)])).toEqual([
      [0, "landed"],
      [1, "landed"],
      [2, "keptPatch"],
    ]);
    expect(t.sends(id)).toHaveLength(leadSends);
  });

  it("a patch naming a file outside the project is kept untried, a refused landing says why, and a shell without landings lands nothing", async () => {
    const t = await setup({ landings: { 1: OUTSIDE, 2: { refuse: "busy" }, 3: { refuse: "config:filter.lfs.clean" } } });
    const { round } = await t.lead();
    for (const h of t.helperIds()) await t.turn(h, "Done.");
    const rows = t.ss.helperLandings(round);
    expect(rows[0].landing).toMatchObject({ refusal: "outside", outside: ["../other/app.ts"], patchPath: "/w/.manut/patches/j1/lead-help-1.patch" });
    expect(landingOutcome(rows[0].landing!)).toBe("keptOutside");
    expect(rows.slice(1).map((r) => [landingOutcome(r.landing!), r.landing!.error])).toEqual([
      ["failed", "busy"],
      ["failed", "config:filter.lfs.clean"],
    ]);
    const old = await setup({ noShell: true });
    const r2 = await old.lead();
    await old.turn(old.helperIds()[0], "Done.");
    expect(old.ss.helperLandings(r2.round)[0].landing).toMatchObject({ error: "no_shell" });
  });

  it("a helper the person stopped, or one that failed, lands nothing: only finished work lands", async () => {
    const t = await setup();
    const { round } = await t.lead();
    const [h1, h2] = t.helperIds();
    t.emit(h1, { event: "turn.start" });
    await settle();
    await t.ss.stopHelper(round, 0);
    t.emit(h1, { event: "turn.end", outcome: "interrupted" });
    t.emit(h2, { event: "turn.start" });
    t.emit(h2, { event: "tool.start", tool_id: "t1", name: "terminal", detail: "pnpm test" });
    t.emit(h2, { event: "turn.end", outcome: "error", error: "Tests failed: 2" });
    await settle();
    expect(t.lands).toEqual([]);
    expect(t.ss.helperLandings(round).map((l) => [l.index, l.step, l.landing, l.skipped])).toEqual([
      [0, "settled", null, "unfinished"],
      [1, "settled", null, "unfinished"],
    ]);
  });
});

describe("safety: no landing starts while the lead works or waits on the person (R8)", () => {
  it("not while the lead's turn runs: the helper's landing waits on its row and goes once the turn ends", async () => {
    const t = await setup();
    const { id, round } = await t.lead();
    const [h1] = t.helperIds();
    t.emit(id, { event: "turn.start" });
    await t.turn(h1, "Helper 1: done.");
    expect(t.lands).toEqual([]);
    expect(t.ss.helperLandings(round)[0].step).toBe("waiting");
    t.emit(id, { event: "turn.end", outcome: "done" });
    await settle();
    expect(t.lands).toHaveLength(1);
    expect(t.ss.helperLandings(round)[0].step).toBe("settled");
  });

  it("not while an ask or a question of the lead waits, also after its turn ended; it goes once the person has answered", async () => {
    const t = await setup();
    const { id, round } = await t.lead();
    const [h1, h2] = t.helperIds();
    const key = t.ss.chatKey(id)!;
    // a background subagent's ask, raised while no turn of the lead runs: it waits on the person with no turn running
    t.emit(id, { event: "approval.request", request_id: "lead-ask", title: "Run this command?", command: "pnpm add qrcode", cwd: t.dirOf(id), choices: ["deny", "once"] });
    await settle();
    expect(selectAsks(t.store.getState()).filter((a) => a.bot === key)).toHaveLength(1);
    await t.turn(h1, "Helper 1: done.");
    expect(t.lands).toEqual([]);
    // the person answers it (what a press records)
    t.store.dispatch({ type: "approval.resolved", bot: key, request_id: "lead-ask", choice: "once" } as never);
    await settle();
    expect(t.lands.map((c) => c.helper)).toEqual([t.dirOf(h1)]);
    // a question of the lead's waits likewise, until it is withdrawn
    t.emit(id, { event: "clarify.request", request_id: "lead-q", question: "Which file?", choices: ["a", "b"] });
    await settle();
    await t.turn(h2, "Helper 2: done.");
    expect(t.lands).toHaveLength(1);
    expect(t.ss.helperLandings(round)[1].step).toBe("waiting");
    t.emit(id, { event: "prompt.expired", request_id: "lead-q", reason: "cancelled" });
    await settle();
    expect(t.lands).toHaveLength(2);
    // no landing ever started with the lead's turn running or an ask of it waiting
    expect(t.lands.every((c) => !c.leadWorking && c.leadAsks === 0)).toBe(true);
  });

  it("a message to the lead waits while a landing writes its folder, and no landing starts between that message and its turn", async () => {
    const t = await setup();
    const { id, round } = await t.lead();
    const [h1, h2] = t.helperIds();
    const before = t.sends(id).length;
    const open = t.hold();
    await t.turn(h1, "Helper 1: done.");
    expect(t.lands).toHaveLength(1);
    // the person writes to the lead while helper 1's work is being written into its folder: nothing goes to its agent yet
    const sent = t.ss.send(id, "Now the receipt.");
    await settle();
    expect(t.sends(id)).toHaveLength(before);
    open();
    await sent;
    await settle();
    expect(t.sends(id)).toHaveLength(before + 1);
    // the message went and its turn has not shown yet: helper 2 reports and waits
    await t.turn(h2, "Helper 2: done.");
    expect(t.lands).toHaveLength(1);
    expect(t.ss.helperLandings(round)[1].step).toBe("waiting");
    t.emit(id, { event: "turn.start" });
    await settle();
    expect(t.lands).toHaveLength(1);
    t.emit(id, { event: "turn.end", outcome: "done" });
    await settle();
    expect(t.lands).toHaveLength(2);
    expect(t.lands.every((c) => !c.leadWorking && c.leadAsks === 0)).toBe(true);
  });

  it("closing the lead lands nothing of what waits (R11)", async () => {
    const t = await setup();
    const { id, round } = await t.lead();
    const [h1] = t.helperIds();
    t.emit(id, { event: "turn.start" });
    await t.turn(h1, "Helper 1: done.");
    t.ss.close(id);
    await settle();
    expect(t.lands).toEqual([]);
    expect(t.ss.helperLandings(round)[0].landing).toMatchObject({ error: "no_lead" });
  });
});

describe("Show patch and Take back this landing", () => {
  it("Show patch reads the kept patch through the shell; a landing that kept none offers none", async () => {
    const t = await setup({ landings: { 1: CLEAN, 3: KEPT }, patches: { 3: PATCH } });
    const { round } = await t.lead();
    for (const h of t.helperIds()) await t.turn(h, "Done.");
    expect(await t.ss.landingPatch(round, 2)).toEqual({ ok: true, patch: { text: PATCH, bytes: PATCH.length, cut: false, path: "/w/.manut/patches/j1/lead-help-3.patch" } });
    expect(await t.ss.landingPatch(round, 0)).toEqual({ ok: false, why: "no_patch" });
    expect(t.patches).toEqual([t.dirOf(t.helperIds()[2])]);
  });

  it("Take back calls the shell and marks the landing taken back; refused with the shell's reason when the lead's folder changed, and while the lead works", async () => {
    const t = await setup({ landings: { 1: CLEAN, 2: CONFLICTS }, takeBack: { 2: "changed" } });
    const { id, round } = await t.lead(ask([{ title: "A", brief: "Do A." }, { title: "B", brief: "Do B." }]));
    const [h1, h2] = t.helperIds();
    await t.turn(h1, "A done.");
    await t.turn(h2, "B done.");
    expect(await t.ss.takeBackLanding(round, 0)).toEqual({ ok: true });
    expect(t.takeBacks).toEqual([t.dirOf(h1)]);
    expect(landingOutcome(t.ss.helperLandings(round)[0].landing!)).toBe("takenBack");
    expect(t.ss.helperRounds(id).rounds[0].reports.find((r) => r.index === 0)!.landing).toMatchObject({ takenBack: true });
    // a second press finds nothing to take back
    expect(await t.ss.takeBackLanding(round, 0)).toEqual({ ok: false, why: "not_landed" });
    expect(await t.ss.takeBackLanding(round, 1)).toEqual({ ok: false, why: "changed" });
    expect(t.ss.helperLandings(round)[1]).toMatchObject({ takeBackError: "changed", takingBack: false });
    expect(landingOutcome(t.ss.helperLandings(round)[1].landing!)).toBe("landed");
    // while the lead's turn runs, Take back waits for it and the shell is not asked
    t.emit(id, { event: "turn.start" });
    await settle();
    expect(await t.ss.takeBackLanding(round, 1)).toEqual({ ok: false, why: "leadBusy" });
    expect(t.takeBacks).toEqual([t.dirOf(h1), t.dirOf(h2)]);
  });

  it("a helper that reports again while its landing is in the lead keeps that landing; once taken back, it lands again", async () => {
    const t = await setup();
    const { round } = await t.lead(ask([{ title: "A", brief: "Do A." }, { title: "B", brief: "Do B." }]));
    const [h1, h2] = t.helperIds();
    await t.turn(h1, "A done.");
    expect(t.lands).toHaveLength(1);
    // the person writes to helper 1 while helper 2 still works, and it reports again: its first landing stays, nothing lands twice
    await t.turn(h1, "A, better.");
    expect(t.lands).toHaveLength(1);
    expect(t.handed).toEqual([]);
    expect(landingOutcome(t.ss.helperLandings(round)[0].landing!)).toBe("landed");
    expect(await t.ss.takeBackLanding(round, 0)).toEqual({ ok: true });
    await t.turn(h1, "A, best.");
    expect(t.lands.map((c) => c.helper)).toEqual([t.dirOf(h1), t.dirOf(h1)]);
    expect(landingOutcome(t.ss.helperLandings(round)[0].landing!)).toBe("landed");
    await t.turn(h2, "B done.");
    expect(t.lands.map((c) => c.helper)).toEqual([t.dirOf(h1), t.dirOf(h1), t.dirOf(h2)]);
    expect(t.handed).toHaveLength(1);
  });
});
