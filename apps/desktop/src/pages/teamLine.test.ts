// The second line of a member's row on the Team page: what they are doing, what waits for them, or why they are not at
// work, in the words of the design canvas's member states (StatesTeam.dc.html: Working, Needs you, Idle, Paused, Could
// not finish). It is decided from what the store and the runtime's jobs already hold, never from a number of its own.
import { afterEach, describe, expect, it } from "vitest";
import { setLang } from "../i18n";
import type { JobRow } from "../runtime/mission";
import type { Ask } from "../state/store";
import { lineWords, teamLine, type TeamLine } from "./teamLine";

const job = (over: Partial<JobRow> & { id: string }): JobRow => ({ title: "A job", bot: "nam", stage: "sent", at: 1_000, ...over });
const ask = (id: string, ts: number, command: string): Ask => ({ bot: "nam", ts, item: { kind: "approval", id, command, title: "", choices: ["once", "deny"], request_id: id } }) as unknown as Ask;
const base = { turn: null, asks: [], jobs: [], error: undefined, pausedSince: null };

afterEach(() => setLang("en"));

describe("what a member is doing", () => {
  it("is the running turn's own words and when the turn began", () => {
    expect(teamLine({ ...base, status: "working", turn: { status: "Drafting the post", startedAt: 5_000 } })).toEqual({ kind: "doing", text: "Drafting the post", since: 5_000 });
  });

  it("is the title of the member's running job when the turn says nothing, and nothing more than that they work when no job says it", () => {
    const running = job({ id: "j1", title: "Captions for the pre-order page", stage: "working", at: 3_000 });
    expect(teamLine({ ...base, status: "working", jobs: [job({ id: "j0", stage: "sent", at: 9_000 }), running] })).toEqual({ kind: "doing", text: "Captions for the pre-order page", since: null });
    expect(teamLine({ ...base, status: "working", turn: { status: "", startedAt: 7_000 } })).toEqual({ kind: "doing", text: "", since: 7_000 });
  });
});

describe("what waits for a member", () => {
  it("is the newest ask of theirs, with how many more wait behind it", () => {
    const asks = [ask("a", 100, "git push"), ask("b", 300, "pnpm test"), ask("c", 200, "ls")];
    expect(teamLine({ ...base, status: "needs", asks })).toEqual({ kind: "asks", text: "Allow `pnpm test`?", more: 2 });
    expect(teamLine({ ...base, status: "needs", asks: [asks[0]] })).toEqual({ kind: "asks", text: "Allow `git push`?", more: 0 });
  });
});

describe("why a member is not at work", () => {
  it("is when Pause everyone began, or only that they are paused when the runtime did not say", () => {
    expect(teamLine({ ...base, status: "paused", pausedSince: 4_000 })).toEqual({ kind: "paused", since: 4_000 });
    expect(teamLine({ ...base, status: "paused" })).toEqual({ kind: "paused", since: null });
  });

  it("is the reason the last turn gave for stopping, its first line only and no longer than a line can show", () => {
    expect(teamLine({ ...base, status: "stuck", error: "  Shopee did not answer.\nRetried 3 times.  " })).toEqual({ kind: "stuck", reason: "Shopee did not answer." });
    const long = "x".repeat(300);
    const reason = (teamLine({ ...base, status: "stuck", error: long }) as Extract<TeamLine, { kind: "stuck" }>).reason;
    expect(reason.length).toBeLessThanOrEqual(140);
    expect(reason.endsWith("…")).toBe(true);
    expect(teamLine({ ...base, status: "stuck" })).toEqual({ kind: "stuck", reason: "" });
  });

  it("is when the last job finished for a member with nothing to do, not counting a job still open", () => {
    const jobs = [job({ id: "a", stage: "sent", at: 2_000 }), job({ id: "b", stage: "checked", at: 5_000 }), job({ id: "c", stage: "working", at: 9_000 }), job({ id: "d", stage: "proposed", at: 9_500 }), job({ id: "e", stage: "failed", at: 4_000 })];
    expect(teamLine({ ...base, status: "idle", jobs })).toEqual({ kind: "idle", last: 5_000 });
    expect(teamLine({ ...base, status: "idle", jobs: [jobs[2], jobs[3]] })).toEqual({ kind: "idle", last: null });
    expect(teamLine({ ...base, status: "idle" })).toEqual({ kind: "idle", last: null });
  });

  it("is nothing for a member the runtime cannot reach: the status already says so", () => {
    expect(teamLine({ ...base, status: "offline" })).toBeNull();
  });
});

describe("the words of a line", () => {
  const NOW = new Date(2026, 10, 22, 12, 0, 0).getTime();
  const at = (h: number, m: number, day = 22) => new Date(2026, 10, day, h, m).getTime() / 1000;

  it("says what is being done with how long it has run, or only that the member works", () => {
    setLang("en");
    expect(lineWords({ kind: "doing", text: "Drafting the post", since: NOW - 38_000 }, NOW)).toEqual({ words: "Drafting the post", meta: "38s" });
    expect(lineWords({ kind: "doing", text: "", since: null }, NOW)).toEqual({ words: "Working now", meta: null });
  });

  it("says the ask's words and how many more wait", () => {
    setLang("en");
    expect(lineWords({ kind: "asks", text: "Allow `pnpm test`?", more: 2 }, NOW)).toEqual({ words: "Allow `pnpm test`?", meta: "+2 more" });
    expect(lineWords({ kind: "asks", text: "Allow `ls`?", more: 0 }, NOW)).toEqual({ words: "Allow `ls`?", meta: null });
  });

  it("says when the member was paused, with the day when it was another", () => {
    setLang("en");
    expect(lineWords({ kind: "paused", since: at(10, 30) }, NOW).words).toBe("Paused 10:30. Starts nothing new.");
    expect(lineWords({ kind: "paused", since: at(15, 10, 21) }, NOW).words).toBe("Paused Yesterday 15:10. Starts nothing new.");
    expect(lineWords({ kind: "paused", since: null }, NOW).words).toBe("Paused. Starts nothing new.");
  });

  it("says why the member stopped, or that the last job stopped part way when nobody said why", () => {
    setLang("en");
    expect(lineWords({ kind: "stuck", reason: "Shopee did not answer." }, NOW).words).toBe("Shopee did not answer.");
    expect(lineWords({ kind: "stuck", reason: "" }, NOW).words).toBe("The last job stopped part way.");
  });

  it("says when the last job was, or only that there is nothing to do", () => {
    setLang("en");
    expect(lineWords({ kind: "idle", last: at(9, 20) }, NOW).words).toBe("Nothing to do right now. Last job: 09:20.");
    expect(lineWords({ kind: "idle", last: at(15, 10, 21) }, NOW).words).toBe("Nothing to do right now. Last job: Yesterday 15:10.");
    expect(lineWords({ kind: "idle", last: null }, NOW).words).toBe("Nothing to do right now.");
  });
});
