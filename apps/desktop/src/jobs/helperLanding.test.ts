// Landings and the hand-over (items 102i and 102j, rules R8 and R9), driven with stand-ins: nothing lands while the lead's turn
// runs or its ask waits, landings go one at a time, what each did is kept for its row and settled into the round, a helper with
// nothing to land settles at once, the reports go once and together only when everything is settled and nothing waits, a late
// report lands nothing and sends nothing, and Take back works only for a landing that landed.
import { describe, expect, it } from "vitest";
import type { LaneLanded } from "../code/laneBranch";
import type { HelperRow } from "./helperAsks";
import { REPORT_FENCE } from "./helperReports";
import { createHelperLandings, toLanding } from "./helperLanding";
import type { HelperReport, Rounds } from "./rules";

const LANDED = (files: string[], over: Partial<LaneLanded> = {}): LaneLanded => ({ outcome: "landed", files, filesTotal: files.length, conflicts: [], cut: [], cutTotal: 0, keys: [], patch: "", why: "", outside: [], error: "", ...over });

const report = (index: number, over: Partial<HelperReport> = {}): HelperReport => ({ round: "r1", index, title: `Part ${index + 1}`, ended: "done", words: `Did part ${index + 1}.`, steps: 2, landing: "pending", ...over });

function make(n = 2, words?: string) {
  let rounds: Rounds<HelperRow> = {
    rounds: [{ id: "r1", out: [], reports: Array.from({ length: n }, (_, i) => report(i, words ? { words } : {})), dropped: { breaker: 0, person: 0 }, back: true }],
    waiting: [],
    infraInARow: 0,
    breakerTripped: false,
    roundsThisMessage: 1,
  };
  const state = { working: false, asks: [] as string[], personWaiting: false, helperAsks: [] as string[] };
  const landed: string[] = [];
  const sent: string[] = [];
  const notes: string[] = [];
  const details: { label: string; text: string }[] = [];
  let sendOk = true;
  const takenBack: string[] = [];
  const holds: (() => void)[] = [];
  let hold = false;
  const answers = new Map<string, LaneLanded | Error>();
  let tick: () => void = () => {};
  const l = createHelperLandings({
    laneDir: (id) => (id === "nolane" ? null : `/lanes/${id}`),
    working: () => state.working,
    asks: (id) => (id === "lead" ? state.asks : state.helperAsks),
    personWaiting: () => state.personWaiting,
    rounds: () => rounds,
    setRounds: (_, r) => (rounds = r),
    helperSessions: () => ["h1", "h2"],
    land: async (dir) => {
      landed.push(dir);
      if (hold) await new Promise<void>((r) => holds.push(r));
      const a = answers.get(dir) ?? LANDED([`${dir.split("/").pop()}.ts`]);
      if (a instanceof Error) throw a;
      return a;
    },
    takeBack: async (dir) => {
      takenBack.push(dir);
      return { files: [], filesTotal: 0 };
    },
    send: async (_, text) => (sent.push(text), sendOk),
    note: (_, text, detail) => {
      notes.push(text);
      if (detail) details.push(detail);
    },
    words: () => ({ reported: "Helpers reported to Kit", failed: "Could not send", showSent: "Show what was sent", showUnsent: "Show the reports" }),
    every: (_, fn) => ((tick = fn), () => {}),
  });
  const back = (index: number, session: string | null, kept = true) => l.back({ lead: "lead", round: "r1", index, session, report: report(index), kept });
  return { l, state, landed, sent, notes, details, failSends: () => (sendOk = false), takenBack, answers, back, tick: () => tick(), rounds: () => rounds, holdNext: () => (hold = true), release: () => holds.splice(0).forEach((r) => r()) };
}

const settle = () => new Promise((r) => setTimeout(r, 0));

describe("landings (102i)", () => {
  it("land nothing while the lead's turn runs or its ask waits, and land once it is idle", async () => {
    const t = make();
    t.state.working = true;
    t.back(0, "h1");
    await settle();
    expect(t.landed).toEqual([]);
    t.state.working = false;
    t.state.asks = ["ask-1"];
    t.tick();
    await settle();
    expect(t.landed).toEqual([]);
    t.state.asks = [];
    t.tick();
    await settle();
    expect(t.landed).toEqual(["/lanes/h1"]);
    expect(t.l.viewOf("r1", 0)).toMatchObject({ state: "landed", files: ["h1.ts"] });
  });

  it("land one at a time for a lead", async () => {
    const t = make();
    t.holdNext();
    t.back(0, "h1");
    t.back(1, "h2");
    await settle();
    expect(t.landed).toEqual(["/lanes/h1"]);
    t.release();
    await settle();
    t.release();
    await settle();
    expect(t.landed).toEqual(["/lanes/h1", "/lanes/h2"]);
  });

  it("keep for each row what its landing did, and settle it into the round", async () => {
    const t = make(3);
    t.answers.set("/lanes/h1", LANDED(["a.ts"], { conflicts: ["a.ts"], keys: ["a.ts"] }));
    t.answers.set("/lanes/h2", LANDED(["../x.ts"], { outcome: "kept", why: "outside", patch: "/p/2.patch", outside: ["../x.ts"] }));
    t.answers.set("/lanes/h3", new Error("busy"));
    t.state.working = true; // hold the hand-over so the settled rounds can be read
    t.back(0, "h1");
    t.back(1, "h2");
    t.back(2, "h3");
    t.state.working = false;
    t.state.personWaiting = true;
    for (let i = 0; i < 4; i++) {
      t.tick();
      await settle();
    }
    expect(t.l.viewOf("r1", 0)).toMatchObject({ state: "landed", conflicts: ["a.ts"], keys: ["a.ts"] });
    expect(t.l.viewOf("r1", 1)).toMatchObject({ state: "kept", why: "outside", patch: "/p/2.patch" });
    expect(t.l.viewOf("r1", 2)).toMatchObject({ state: "failed", error: "busy" });
    const reports = t.rounds().rounds[0].reports;
    expect(reports[0].landing).toEqual({ files: [{ path: "a.ts", added: 0, removed: 0 }], conflicts: ["a.ts"] });
    expect(reports[1].landing).toMatchObject({ refusal: "it names a file outside the project", patchPath: "/p/2.patch" });
    expect(reports[2].landing).toMatchObject({ error: "busy" });
  });

  it("settle a helper that never started, or has no lane, with nothing to land", async () => {
    const t = make(2);
    t.state.personWaiting = true;
    t.back(0, null);
    t.back(1, "nolane");
    await settle();
    expect(t.landed).toEqual([]);
    expect(t.rounds().rounds[0].reports.map((r) => r.landing)).toEqual([null, null]);
  });

  it("take back only a landing that landed", async () => {
    const t = make(2);
    t.state.personWaiting = true;
    t.answers.set("/lanes/h2", LANDED([], { outcome: "nothing" }));
    t.back(0, "h1");
    t.back(1, "h2");
    await settle();
    await settle();
    expect(await t.l.takeBack("r1", 1)).toBe(false);
    expect(await t.l.takeBack("r1", 0)).toBe(true);
    expect(t.takenBack).toEqual(["/lanes/h1"]);
    expect(t.l.viewOf("r1", 0)?.state).toBe("takenBack");
    expect(await t.l.takeBack("r1", 0)).toBe(false);
  });
});

describe("the hand-over (102j)", () => {
  it("sends the lead one message, once, only when every landing is settled and nothing waits", async () => {
    const t = make(2);
    t.back(0, "h1");
    await settle();
    expect(t.sent).toEqual([]);
    t.back(1, "h2");
    await settle();
    await settle();
    expect(t.sent).toHaveLength(1);
    expect(t.sent[0].split("\n")[0]).toBe(REPORT_FENCE);
    expect(t.sent[0]).toContain("Helper 1 and Helper 2 finished.");
    expect(t.notes).toEqual(["Helpers reported to Kit"]);
    // the quiet line opens every word that was sent
    expect(t.details).toEqual([{ label: "Show what was sent", text: t.sent[0] }]);
    expect(t.rounds().rounds).toEqual([]);
    // taken once: nothing more is sent on later ticks
    t.tick();
    await settle();
    expect(t.sent).toHaveLength(1);
  });

  it("a report that could not go says so, keeps its words for the person, and is not sent again", async () => {
    const t = make(1);
    t.failSends();
    t.back(0, "h1");
    await settle();
    await settle();
    expect(t.sent).toHaveLength(1);
    expect(t.notes).toEqual(["Could not send"]);
    expect(t.details).toEqual([{ label: "Show the reports", text: t.sent[0] }]);
    t.tick();
    await settle();
    expect(t.sent).toHaveLength(1);
  });

  it("waits while a helper's ask, the lead's ask or the person's own message waits", async () => {
    const t = make(1);
    t.state.helperAsks = ["helper-ask"];
    t.back(0, "h1");
    await settle();
    await settle();
    expect(t.landed).toEqual(["/lanes/h1"]);
    expect(t.sent).toEqual([]);
    t.state.helperAsks = [];
    t.state.personWaiting = true;
    t.tick();
    await settle();
    expect(t.sent).toEqual([]);
    t.state.personWaiting = false;
    t.tick();
    await settle();
    expect(t.sent).toHaveLength(1);
  });

  it("a late report lands nothing and sends nothing", async () => {
    const t = make(1);
    t.back(0, "h1", false);
    await settle();
    t.tick();
    await settle();
    expect(t.landed).toEqual([]);
    expect(t.sent).toEqual([]);
    expect(t.l.viewOf("r1", 0)).toBeNull();
  });

  it("masks a key in a report", async () => {
    const key = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789";
    // the round's own report carries the words the lead hears
    const t = make(1, `token ${key}`);
    t.back(0, "h1");
    await settle();
    await settle();
    expect(t.sent[0]).toBeDefined();
    expect(t.sent[0]).not.toContain("abcdefghijklmnopqrstuvwxyz0123456789");
  });
});

describe("the shell's answer as a landing", () => {
  it("reads landed, nothing and kept as item 102d's landing", () => {
    expect(toLanding(LANDED(["a.ts"], { conflicts: ["a.ts"] }))).toEqual({ files: [{ path: "a.ts", added: 0, removed: 0 }], conflicts: ["a.ts"] });
    expect(toLanding(LANDED([], { outcome: "nothing" }))).toEqual({ files: [], conflicts: [] });
    expect(toLanding(LANDED(["a.ts"], { outcome: "kept", why: "would_not_apply", patch: "/p.patch", error: "patch failed" }))).toMatchObject({ patchPath: "/p.patch", error: "patch failed" });
    expect(toLanding(LANDED(["a.ts"], { outcome: "kept", why: "other_repo" }))).toMatchObject({ refusal: "it comes from another repository than the lead's" });
  });
});
