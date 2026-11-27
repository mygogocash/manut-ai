// Item 102j-2: a lead's helper rounds kept by the resume snapshot and put back after a restart. What a helper was doing when the
// app closed decides what it reports; every part read back is checked; and what comes back is all back, so nothing starts.
import { describe, expect, it } from "vitest";
import type { HelperRow } from "./helperAsks";
import { REPORT_MAX } from "./helperReports";
import { NEVER_STARTED, closedWords, parseSavedRounds, restoreRounds, saveRounds } from "./helperRestore";
import { hasOpenWork, type Rounds } from "./rules";

const row = (title: string): HelperRow => ({ title, brief: `Do ${title}.`, agent: "claude", own: true });
const rounds = (): Rounds<HelperRow> => ({
  rounds: [
    {
      id: "r1",
      out: [1],
      back: false,
      dropped: { breaker: 0, person: 0 },
      reports: [{ round: "r1", index: 0, title: "Tests", ended: "done", words: "Added the tests.", steps: 4, landing: { files: [{ path: "src/a.ts", added: 3, removed: 1 }], conflicts: [] } }],
    },
  ],
  waiting: [{ round: "r1", index: 2, brief: row("Share button"), queuedAt: 1 }],
  infraInARow: 0,
  breakerTripped: false,
  roundsThisMessage: 1,
});
const through = (v: unknown) => parseSavedRounds(JSON.parse(JSON.stringify(v)));

describe("a lead's rounds across a restart (102j-2)", () => {
  it("keeps a report and its landing, a helper still out by its title, and one still waiting", () => {
    const saved = saveRounds(rounds(), (round, index) => (round === "r1" && index === 1 ? "Thai date" : "?"))!;
    expect(saved.roundsThisMessage).toBe(1);
    expect(saved.rounds[0].helpers).toEqual([
      { index: 0, title: "Tests", ended: "done", words: "Added the tests.", steps: 4, landing: { files: [{ path: "src/a.ts", added: 3, removed: 1 }], conflicts: [] } },
      { index: 1, title: "Thai date" },
      { index: 2, title: "Share button", waited: true },
    ]);
    expect(through(saved)).toEqual(saved);
  });

  it("puts every round back as back, with nothing out or waiting, so nothing starts by itself", () => {
    const back = restoreRounds(through(saveRounds(rounds(), () => "Thai date"))!, (_, index) => (index === 1 ? "Half of the date is done." : ""));
    expect(hasOpenWork(back)).toBe(false);
    expect(back.waiting).toEqual([]);
    expect(back.roundsThisMessage).toBe(1);
    const [done, out, waited] = back.rounds[0].reports;
    expect(done).toMatchObject({ ended: "done", words: "Added the tests.", landing: { files: [{ path: "src/a.ts" }] } });
    // the one still working failed: the app closed, and its last answer is what it reports; its work may still land
    expect(out).toMatchObject({ index: 1, title: "Thai date", ended: "failed", landing: "pending" });
    expect(out.words).toBe(closedWords("Half of the date is done."));
    expect(out.words).toContain("Half of the date is done.");
    expect(out.failure).toBeUndefined();
    // the one still waiting never started and has nothing to land
    expect(waited).toMatchObject({ index: 2, title: "Share button", ended: "failed", words: NEVER_STARTED, landing: null });
  });

  it("a report whose landing was still pending comes back pending; one with no answer says so", () => {
    const r = rounds();
    const pending: Rounds<HelperRow> = { ...r, waiting: [], rounds: [{ ...r.rounds[0], out: [], reports: [{ ...r.rounds[0].reports[0], landing: "pending" }] }] };
    const back = restoreRounds(through(saveRounds(pending, () => ""))!, () => "");
    expect(back.rounds[0].reports[0].landing).toBe("pending");
    expect(closedWords("  ")).toBe("The app closed while it worked, before it answered anything.");
  });

  it("caps what it keeps: a report at the report's own length", () => {
    const r = rounds();
    const long: Rounds<HelperRow> = { ...r, rounds: [{ ...r.rounds[0], reports: [{ ...r.rounds[0].reports[0], words: "x".repeat(REPORT_MAX + 500) }] }] };
    expect(saveRounds(long, () => "")!.rounds[0].helpers[0].words).toHaveLength(REPORT_MAX);
    expect(saveRounds({ ...r, rounds: [] }, () => "")).toBeNull();
  });

  it("reads back only what it can check: a bad helper or two in one place leaves its round out, and the count never passes two", () => {
    const good = saveRounds(rounds(), () => "Thai date")!;
    const bad = (helpers: unknown[]) => ({ ...good, rounds: [{ ...good.rounds[0], helpers }] });
    expect(through(bad([{ index: 0, title: "A", ended: "maybe" }]))).toBeNull();
    expect(through(bad([{ index: 0, title: "A" }, { index: 0, title: "B" }]))).toBeNull();
    expect(through(bad([{ index: -1, title: "A" }]))).toBeNull();
    expect(through({ ...good, roundsThisMessage: 50 })?.roundsThisMessage).toBe(2);
    expect(through({ rounds: "x" })).toBeNull();
    expect(through(null)).toBeNull();
    // a landing that cannot be read comes back pending, so Land what they did asks the shell, which refuses a second landing
    const odd = bad([{ index: 0, title: "A", ended: "done", words: "w", landing: { files: "x", conflicts: [] } }]);
    expect(through(odd)?.rounds[0].helpers[0].landing).toBeUndefined();
  });
});
