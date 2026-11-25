// Settings › Workflows (item 77b), drawn with react-dom/server: the switch off at first, why Run now cannot be pressed, a workflow's
// time in its zone, a run waiting on the person, the history's lines, a file that is not a workflow, and the words in every language.
import { afterEach, describe, expect, it } from "vitest";
import { renderToString } from "react-dom/server";
import { LANGS, setLang, t } from "../i18n";
import { pinComputerZone } from "../lib/zone";
import { readFolder } from "./file";
import { WORKFLOW_DEFAULTS } from "./settings";
import { keptOf, WorkflowsView, type WorkflowsViewProps } from "./WorkflowsPage";
import { runLine, whenWords } from "./words";
import type { RunRec } from "./history";

const words = (html: string) => html.replace(/<[^>]*>/g, " ").replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
const noop = () => {};
const NOW = Date.UTC(2026, 10, 24, 12, 0);
const nightly = { name: "Nightly tests", project: "/Users/nam/code/shop-site", agent: "claude", steps: ["Run the tests.", "Fix them."], schedule: { kind: "daily", at: "02:00" }, timeZone: "Asia/Bangkok" };
const files = readFolder([
  { name: "nightly.json", text: JSON.stringify(nightly) },
  { name: "broken.json", text: JSON.stringify({ ...nightly, name: "Broken", shedule: 1 }) },
  { name: "linked.json", why: "link" },
]);
const shown = (files[0] as { workflow: { digest: string } }).workflow.digest;
/** `nightly.json` allowed as it is drawn. */
const allowed = { "nightly.json": { digest: shown, project: nightly.project, at: 1 } };
const run = (over: Partial<RunRec>): RunRec => ({ id: "r1", file: "nightly.json", name: "Nightly tests", by: "schedule", at: Date.UTC(2026, 10, 23, 19, 0), steps: 2, reached: 2, state: "done", ...over });

function draw(over: Partial<WorkflowsViewProps> = {}) {
  return renderToString(
    <WorkflowsView
      settings={WORKFLOW_DEFAULTS}
      keptText="50"
      folder={{ path: "/Users/nam/.manut/workflows", state: "ok", more: 0 }}
      files={files}
      runs={[]}
      live={{}}
      waiting={[]}
      refused={{}}
      allowed={{}}
      agents={[{ id: "claude", label: "Claude Code", mode: "chat", path: "/bin/claude" } as never]}
      now={NOW}
      onOn={noop}
      onKeptText={noop}
      onKeptSave={noop}
      onShowFolder={noop}
      onRunNow={noop}
      onOpenLane={noop}
      onStopAfter={noop}
      onAllow={noop}
      onDisallow={noop}
      {...over}
    />,
  );
}

afterEach(() => {
  setLang("en");
  pinComputerZone(null);
});

describe("Settings › Workflows", () => {
  it("starts off, says what turning it on does, and Run now cannot be pressed", () => {
    pinComputerZone("Asia/Bangkok");
    const html = draw();
    const text = words(html);
    expect(html).toMatch(/aria-checked="false"[^>]*data-testid="workflows-on"|data-testid="workflows-on"[^>]*aria-checked="false"/);
    expect(text).toContain("on your own agent and your own plan");
    expect(text).toContain("Only while this app is open and the Mac is awake");
    expect(text).toContain("Kit asks before every change in it, whatever the project's dial says");
    expect(html).toMatch(/disabled=""[^>]*data-testid="workflow-run-now"/);
    // the workflow with its agent, project, steps and time, and no next run while off
    expect(text).toContain("Nightly tests");
    expect(text).toContain("Claude Code · shop-site · 2 steps");
    expect(text).toContain("Every day at 02:00");
    expect(text).not.toContain("Next:");
  });

  it("says the next run once on, and names the zone when it is not this computer's", () => {
    pinComputerZone("Europe/London");
    const text = words(draw({ settings: { ...WORKFLOW_DEFAULTS, on: true }, allowed }));
    expect(text).toContain("Every day at 02:00 (Bangkok time) · Next:");
    expect(text).not.toContain("disabled");
  });

  it("lists a file that is not a workflow with its reason, never as a code", () => {
    const text = words(draw());
    expect(text).toContain("broken.json It has a field this app does not know: shedule.");
    expect(text).toContain("linked.json It is a link, so it is not read.");
  });

  it("shows a run waiting on the person, with Open lane and Stop after this step", () => {
    const live = { "nightly.json": { run: "r9", session: "s4", step: 1, steps: ["a", "b"] } };
    const html = draw({ settings: { ...WORKFLOW_DEFAULTS, on: true }, live, waiting: ["nightly.json"], allowed });
    expect(words(html)).toContain("Waiting for you at step 2 of 2: Kit asks on its card.");
    expect(html).toContain('data-testid="workflow-open-lane"');
    expect(html).toContain('data-testid="workflow-stop-after"');
    expect(html).toMatch(/disabled=""[^>]*data-testid="workflow-run-now"/);
    const stopping = words(draw({ settings: { ...WORKFLOW_DEFAULTS, on: true }, live: { "nightly.json": { ...live["nightly.json"], stopAfter: "person" as const } } }));
    expect(stopping).toContain("Running step 2 of 2");
    expect(stopping).toContain("Stops after this step");
  });

  it("draws the history, newest first, each run with how it ended and why", () => {
    pinComputerZone("Asia/Bangkok");
    const runs = [run({ id: "r3", state: "skipped", reached: 0, why: "closed" }), run({ id: "r2", state: "failed", reached: 1, why: "turn", detail: "2 tests failed" }), run({ id: "r1" })];
    const text = words(draw({ runs }));
    expect(text).toContain("24 Nov, 02:00 · Skipped · The app was not open.");
    expect(text).toContain("Failed · step 1 of 2 · A step failed. 2 tests failed");
    expect(text).toContain("Done · step 2 of 2");
  });

  it("says why Run now did not start, and what the folder is when it is not there", () => {
    expect(words(draw({ refused: { "nightly.json": "running" } }))).toContain("It is already running.");
    expect(words(draw({ files: [], folder: { path: "/x", state: "missing", more: 0 } }))).toContain("There is no workflows folder yet. Show folder makes it.");
    expect(words(draw({ files: [] }))).toContain(t("wf.none"));
  });

  describe("what the person allows (item 91)", () => {
    const on = { ...WORKFLOW_DEFAULTS, on: true };
    const card = (html: string, file = "nightly.json") => html.slice(html.indexOf(`data-file="${file}"`));
    const runNowDisabled = (html: string) => /disabled=""[^>]*data-testid="workflow-run-now"/.test(card(html));

    it("shows every step's text in full, in order, with the project's whole folder and the agent: nothing cut", () => {
      const long = `Read the failing tests.\nThen ${"fix one at a time and run it again. ".repeat(100).trim()}`;
      const wf = { ...nightly, steps: ["Run the tests.", long, "Push nothing."] };
      const html = draw({ files: readFolder([{ name: "nightly.json", text: JSON.stringify(wf) }]) });
      const steps = [...html.matchAll(/data-testid="workflow-step"[^>]*>([^<]*)</g)].map((m) => m[1]);
      expect(steps).toEqual(["Run the tests.", long, "Push nothing."]);
      expect(html).toMatch(/data-testid="workflow-project"[^>]*>\/Users\/nam\/code\/shop-site</);
      expect(words(card(html))).toContain("Agent Claude Code");
    });

    it("a workflow never allowed says so, opens its steps with Allow under them, and Run now cannot be pressed even while on", () => {
      const html = draw({ settings: on });
      expect(words(card(html))).toContain("Not allowed to run yet. Read its steps under Steps and project, then allow it.");
      expect(card(html)).toMatch(/aria-expanded="true"[^>]*data-testid="workflow-look"/);
      expect(card(html)).not.toMatch(/hidden=""[^>]*data-testid="workflow-steps"/);
      expect(card(html)).toContain('data-testid="workflow-allow"');
      expect(words(card(html))).toContain("Allow this workflow to run");
      expect(runNowDisabled(html)).toBe(true);
    });

    it("a file changed since it was allowed says so in the person's words, offers Allow again, and cannot be run", () => {
      const html = draw({ settings: on, allowed: { "nightly.json": { ...allowed["nightly.json"], digest: "f".repeat(64) } } });
      expect(words(card(html))).toContain("This workflow's file changed. Look at it again.");
      expect(card(html)).toContain('data-testid="workflow-allow"');
      expect(runNowDisabled(html)).toBe(true);
      // an allowance of another file allows nothing here
      expect(runNowDisabled(draw({ settings: on, allowed: { "other.json": allowed["nightly.json"] } }))).toBe(true);
    });

    it("an allowed workflow can be run while on, keeps its steps closed until opened, and offers Stop allowing", () => {
      const html = draw({ settings: on, allowed });
      expect(runNowDisabled(html)).toBe(false);
      expect(card(html)).not.toContain('data-testid="workflow-standing"');
      expect(card(html)).toMatch(/aria-expanded="false"[^>]*data-testid="workflow-look"/);
      expect(card(html)).toMatch(/hidden=""[^>]*data-testid="workflow-steps"/);
      expect(card(html)).toContain('data-testid="workflow-disallow"');
      // the switch is still the master switch
      expect(runNowDisabled(draw({ allowed }))).toBe(true);
    });

    it("says why a run did not start, whichever way it was asked for, without saying the standing twice", () => {
      expect(words(draw({ settings: on, allowed, refused: { "nightly.json": "changed" } }))).toContain("This workflow's file changed. Look at it again.");
      const twice = words(card(draw({ settings: on, refused: { "nightly.json": "not_allowed" } })));
      expect(twice.split("Not allowed to run yet").length - 1).toBe(1);
      expect(twice).not.toContain("It was not allowed to run yet.");
    });

    it("has its words in every language", () => {
      for (const l of LANGS) {
        setLang(l);
        const text = words(draw({ settings: on }));
        for (const k of ["wf.look", "wf.allow", "wf.allow.hint", "wf.stand.not_allowed"] as const) expect(text, `${l} ${k}`).toContain(words(t(k)));
      }
    });
  });

  it("takes 0 to 500 skipped runs", () => {
    expect(keptOf("0")).toBe(0);
    expect(keptOf(" 500 ")).toBe(500);
    for (const bad of ["501", "-1", "2.5", "", "ten"]) expect(keptOf(bad), bad).toBeNull();
    expect(words(draw({ keptText: "900" }))).toContain("Type a whole number from 0 to 500.");
  });

  it("says when a workflow runs, in every language", () => {
    pinComputerZone("Asia/Bangkok");
    const wf = files[0] as unknown as { workflow: object };
    for (const l of LANGS) {
      setLang(l);
      expect(whenWords({ ...wf.workflow, schedule: { kind: "weekly", weekdays: [5, 1], at: "09:00" } } as never, NOW).length, l).toBeGreaterThan(5);
      expect(runLine(run({}))).toContain("02:00");
      expect(words(draw()), l).toContain(t("wf.on.hint"));
    }
    setLang("en");
    pinComputerZone("Asia/Bangkok");
    expect(whenWords({ ...wf.workflow, schedule: { kind: "weekly", weekdays: [5, 1], at: "09:00" } } as never, NOW)).toBe("Every Monday and Friday at 09:00");
    expect(whenWords({ ...wf.workflow, schedule: { kind: "monthly", day: "last", at: "08:00" } } as never, NOW)).toBe("On the last day of each month at 08:00");
    expect(whenWords({ ...wf.workflow, schedule: undefined } as never, NOW)).toBe("Runs when you press Run now");
  });
});
