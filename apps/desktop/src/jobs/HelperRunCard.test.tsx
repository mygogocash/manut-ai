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
import type { HelperLanding } from "./helperLandings";
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

// Item 102i: each row's landing, from the landings the sessions store keeps (helperLandings.ts), and Show patch's view.
describe("the rows' landings (landRow, item 102i)", () => {
  const lv = (index: number, p: Partial<HelperLanding>): HelperLanding => ({ lead: "s1", round: "r1", index, worktree: `/w/lead-help-${index + 1}`, step: "settled", ...p });
  const backRun = (index: number) => run(index, { state: "back", session: `s${index + 2}`, report: { round: "r1", index, title: "x", ended: "done", words: "Did it.", landing: "pending" } });

  it("says how each landed, names conflicts and each key's file, and offers Show patch or Take back where each applies", () => {
    const landings = [
      lv(0, { landing: { files: [{ path: "src/qr.test.ts" }, { path: "src/qr.ts" }, { path: "src/x.ts" }], conflicts: [], keys: ["src/config.ts"] } }),
      lv(1, { landing: { files: [{ path: "src/receipt.tsx" }, { path: "src/qr.ts" }], conflicts: ["src/qr.ts"] } }),
      lv(2, { landing: { files: [{ path: "src/line.ts" }], conflicts: [], patchPath: "/w/.manut/patches/j/h.patch", error: "error: src/line.ts: does not exist in index" } }),
      lv(3, { landing: { files: [{ path: "../x.ts" }], conflicts: [], patchPath: "/p", refusal: "outside", outside: ["../x.ts"] } }),
      lv(4, { landing: { files: [], conflicts: [] } }),
      lv(5, { landing: { files: [], conflicts: [], error: "config:filter.lfs.clean" } }),
      lv(6, { landing: null, skipped: "unfinished" }),
      lv(7, { step: "waiting" }),
      lv(8, { landing: { files: [{ path: "a" }], conflicts: [], takenBack: true } }),
    ];
    const rows = runRows(Array.from({ length: 9 }, (_, i) => backRun(i)), chat, landings);
    expect(rows.map((r) => [r.land?.tone, r.land?.line])).toEqual([
      ["done", "Landed 3 files"],
      ["waiting", "Landed 2 files, 1 with conflicts: src/qr.ts"],
      ["failed", "Kept as a patch: it would not apply"],
      ["failed", "Kept as a patch, not tried: it names a file outside this project (../x.ts)"],
      ["stopped", "Changed nothing"],
      ["failed", "Not landed: the repository's own settings name a program git would run (filter.lfs.clean)"],
      ["stopped", "Not landed: only finished work lands, so its work stays in its own folder"],
      ["queued", "Lands once Kit is idle"],
      ["stopped", "Taken back: Kit's folder is as it was before this landing"],
    ]);
    expect(rows.map((r) => [r.land?.canShowPatch, r.land?.canTakeBack])).toEqual([
      [false, true],
      [false, true],
      [true, false],
      [true, false],
      [false, false],
      [false, false],
      [false, false],
      [false, false],
      [false, false],
    ]);
    expect(rows[0].land?.keys).toEqual(["src/config.ts"]);
    expect(rows[2].land?.detail).toBe("error: src/line.ts: does not exist in index");
    // a helper not back yet has no landing line
    expect(runRows([run(0, { state: "running", session: "s2" })], chat, [lv(0, { step: "waiting" })])[0].land).toBeUndefined();
  });

  it("Take back waits while the lead works, and says the shell's reason when refused", () => {
    const landings = [lv(0, { landing: { files: [{ path: "a" }], conflicts: [] }, takeBackError: "changed" })];
    const [row] = runRows([backRun(0)], chat, landings, true);
    expect(row.land).toMatchObject({ canTakeBack: true, takeBackWaits: true, takeBackError: "Not taken back: Kit's folder changed since this landing." });
    const html = draw(createElement(HelperRunView, { rows: [row], now: NOW, onTakeBack: () => {} }));
    expect(html).toMatch(/disabled=""[^>]*title="Take back waits until Kit&#x27;s turn ends[^"]*"[^>]*data-testid="helper-landing-take-back"/);
    expect(text(html)).toContain("Not taken back: Kit's folder changed since this landing.");
  });

  it("draws the landing under the row: its line, the key's file named and never the key, and Show patch's view of the kept patch", () => {
    const key = `ghp_${"a".repeat(36)}`;
    const landings = [
      lv(0, { landing: { files: [{ path: "src/qr.test.ts" }], conflicts: [], keys: ["src/config.ts"] } }),
      lv(1, { landing: { files: [{ path: "src/line.ts" }], conflicts: [], patchPath: "/w/.manut/patches/j/h.patch", error: "would_not_apply" } }),
    ];
    const rows = runRows([backRun(0), backRun(1)], chat, landings);
    const patch = `diff --git a/src/line.ts b/src/line.ts\n--- a/src/line.ts\n+++ b/src/line.ts\n@@ -1 +1,2 @@\n-old\n+new\n+token = "${key}"\n`;
    const html = draw(
      createElement(HelperRunView, {
        rows,
        now: NOW,
        patches: { 1: { state: "shown", patch: { text: patch, bytes: patch.length, cut: false, path: "/w/.manut/patches/j/h.patch" } } },
        onPatch: () => {},
        onTakeBack: () => {},
      }),
    );
    const words = text(html);
    expect(words).toContain("Landed 1 file");
    expect(words).toContain("A key is in src/config.ts. It is hidden here, and Kit's next commit or push asks you first.");
    expect(words).toContain("Take back this landing");
    expect(words).toContain("Hide patch");
    expect(words).toContain("Kept at /w/.manut/patches/j/h.patch");
    expect(html).toContain('data-testid="landing-patch-view"');
    expect(html.match(/data-kind="add"/g)).toHaveLength(2);
    // the patch's key is masked in the view, whatever the shell sent
    expect(html).not.toContain(key);
    // an unreadable patch says why
    const gone = draw(createElement(HelperRunView, { rows, now: NOW, patches: { 1: { state: "error", why: "no_patch" } }, onPatch: () => {} }));
    expect(text(gone)).toContain("The patch could not be read: it is no longer kept");
  });

  it("reads in the person's language", () => {
    setLang("ja");
    const rows = runRows([backRun(0)], chat, [lv(0, { landing: { files: [{ path: "a" }, { path: "b" }], conflicts: ["b"] } })]);
    expect(rows[0].land?.line).toBe("2 ファイルを反映しました。うち 1 つに競合があります: b");
  });
});
