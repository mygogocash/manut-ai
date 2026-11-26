// The Helpers card once a round runs (item 102h), from props alone, drawn with react-dom/server as HelpersCard.test.tsx draws the
// Start helpers card: one row per helper lane with its link line, state, step and time; Answer while its ask waits; Stop on each row
// the person can stop and Stop all while any waits or runs; the lines of a helper that did not start or failed. `runRows` turns the
// runtime's runs and each helper's chat into those rows. What a press does is helperRuns.test.ts's; how it looks in the app is
// e2e/helper-runs.spec.ts's.
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { setLang } from "../i18n";
import type { HelperRow } from "./helperAsks";
import { HelperRunView, runRows, type RunRow } from "./HelperRunCard";
import type { HelperRun } from "./helperRuns";

afterEach(() => setLang("en"));

const NOW = 1_800_000_000_000;
const row = (title: string, agent = "claude"): HelperRow => ({ title, brief: `Do ${title}.`, agent, own: agent === "claude" });
const run = (index: number, p: Partial<HelperRun> = {}): HelperRun => ({ lead: "s1", round: "r1", index, row: row(`Part ${index + 1}`, index % 2 ? "claude" : "codex"), state: "waiting", ...p });
const draw = (el: ReturnType<typeof createElement>) => renderToString(el).replace(/<!-- -->/g, "");
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ").trim();
const chats: Record<string, { turn: { status: string; startedAt: number } | null; asks: number; starting: boolean }> = {
  s2: { turn: { status: "Editing src/qr.test.ts", startedAt: NOW - 95_000 }, asks: 0, starting: false },
  s3: { turn: { status: "Running pnpm test", startedAt: NOW - 30_000 }, asks: 1, starting: false },
  s4: { turn: null, asks: 0, starting: false },
};
const chat = (s: string) => chats[s] ?? { turn: null, asks: 0, starting: true };

describe("the rows (runRows)", () => {
  it("reads each helper's state from its run and its chat", () => {
    const rows = runRows(
      [
        run(0, { state: "running", session: "s2" }),
        run(1, { state: "running", session: "s3" }),
        run(2),
        run(3, { state: "starting" }),
        run(4, { state: "running", session: "s4" }),
        run(5, { state: "running", session: "s9", stopping: true }),
      ],
      chat,
    );
    expect(rows.map((r) => [r.state, r.canStop, r.canOpen])).toEqual([
      ["working", true, true],
      ["asking", true, true],
      ["waiting", true, false],
      ["starting", true, false],
      ["idle", true, true],
      ["stopping", false, true],
    ]);
    expect(rows[0]).toMatchObject({ step: "Editing src/qr.test.ts", since: NOW - 95_000 });
  });

  it("says how each ended, and why one did not start", () => {
    const report = (p: Partial<NonNullable<HelperRun["report"]>>) => ({ round: "r1", index: 0, title: "x", ended: "done" as const, words: "Did it.", landing: "pending" as const, ...p });
    const rows = runRows(
      [
        run(0, { state: "back", session: "s2", report: report({}), ended: true }),
        run(1, { state: "back", session: "s3", report: report({ budgetSpent: true }) }),
        run(2, { state: "back", session: "s4", report: report({ ended: "failed", failure: "agent", words: "Tests failed: 2\nmore" }) }),
        run(3, { state: "back", session: "s5", report: report({ ended: "stopped" }) }),
        run(4, { state: "notStarted", why: "Codex is limited until 14:00", report: report({ ended: "failed", failure: "infra", landing: null }) }),
        run(5, { state: "dropped", dropped: "breaker" }),
        run(6, { state: "dropped", dropped: "person" }),
      ],
      chat,
    );
    expect(rows.map((r) => [r.state, r.line ?? "", r.canStop])).toEqual([
      ["done", "Its agent was closed once the round was done; its chat and folder stay.", false],
      ["budgetSpent", "", false],
      ["failed", "Tests failed: 2", false],
      ["stoppedByPerson", "", false],
      ["couldNotRun", "Codex is limited until 14:00", false],
      ["dropped", "Two helper lanes in a row could not run, so the rest of the round did not start.", false],
      ["dropped", "You stopped it before it started.", false],
    ]);
  });
});

describe("the card", () => {
  const live: RunRow[] = [
    { index: 0, title: "Tests for the QR builder", agent: "codex", state: "working", step: "Editing src/qr.test.ts", since: NOW - 95_000, canOpen: true, canStop: true },
    { index: 1, title: "The receipt's Thai date", agent: "claude", state: "asking", since: NOW - 30_000, canOpen: true, canStop: true },
    { index: 2, title: "LINE share button", agent: "codex", state: "waiting", canOpen: false, canStop: true },
  ];

  it("two running and one queued: the summary with this Mac's cap, a link line per helper, Answer while an ask waits, Stop and Stop all", () => {
    const html = draw(createElement(HelperRunView, { rows: live, atOnce: 2, now: NOW, onOpen: () => {}, onAnswer: () => {}, onStop: () => {}, onStopAll: () => {} }));
    const words = text(html);
    expect(words).toContain("Helper lanes: 2 running, 1 waiting, 0 back · This Mac runs 2 at once");
    expect(words).toContain("→ Helper 1: Tests for the QR builder Working 1m 35s");
    expect(words).toContain("Editing src/qr.test.ts");
    expect(words).toContain("→ Helper 2: The receipt's Thai date Waiting for you");
    expect(words).toContain("→ Helper 3: LINE share button Waiting for a place");
    expect(html.match(/data-testid="helper-run-answer"/g)).toHaveLength(1);
    expect(html.match(/data-testid="helper-run-stop"/g)).toHaveLength(3);
    expect(html).toContain('data-testid="helper-run-stop-all"');
    // a queued helper has no chat to open yet
    expect(html).toMatch(/disabled=""[^>]*data-testid="helper-run-link"[^>]*>.*Helper 3/);
  });

  it("once every helper is back: no Stop, no Stop all, and the head is quiet", () => {
    const back: RunRow[] = [
      { index: 0, title: "a", agent: "codex", state: "done", canOpen: true, canStop: false },
      { index: 1, title: "b", agent: "claude", state: "failed", line: "Tests failed", canOpen: true, canStop: false },
    ];
    const html = draw(createElement(HelperRunView, { rows: back, atOnce: 2, now: NOW, onStop: () => {}, onStopAll: () => {} }));
    expect(html).not.toContain('data-testid="helper-run-stop"');
    expect(html).not.toContain('data-testid="helper-run-stop-all"');
    expect(text(html)).toContain("Helper lanes: 0 running, 0 waiting, 2 back");
    expect(text(html)).toContain("Tests failed");
  });

  it("reads in the person's language", () => {
    setLang("ko");
    const words = text(draw(createElement(HelperRunView, { rows: live, atOnce: 2, now: NOW, onStop: () => {}, onStopAll: () => {} })));
    expect(words).toContain("도우미 1: Tests for the QR builder");
    expect(words).toContain("모두 멈추기");
  });
});
