// The job view's rules, apart from the page: how money, times and stages are written, how the timeline and the trace read,
// and what Copy trace puts on the clipboard. Times are this computer's, as the page's are.
import { afterEach, describe, expect, it } from "vitest";
import { setLang, t } from "../i18n";
import type { Job, JobStage, RecipientStatus } from "../runtime/mission";
import { initialOf, recipientTag, satangText, stageTag, stepTime, timeline, tookText, traceRows, traceText, traceTotal, whenText } from "./job";

const NOW = new Date(2026, 10, 22, 12, 0).getTime();
const at = (day: number, h = 9, m = 14) => new Date(2026, 10, day, h, m).getTime() / 1000;
const trace = [
  { tool: "shopee.list_orders", found: "late > 2 days, 3 found", ms: 800, costSatang: null, tokens: null, result: null },
  { tool: "draft_reply", found: "demo-standard, 1,412 tokens", ms: 31_200, costSatang: 98, tokens: 1_412, result: null },
  { tool: "approval.wait", found: "allow once, by you", ms: 240_000, costSatang: null, tokens: null, result: null },
  { tool: "verify.delivery", found: "3 of 3 delivered", ms: 5_000, costSatang: 22, tokens: 552, result: "pass" as const },
];
const job: Job = {
  id: "late-parcels",
  title: "Replies about late parcels",
  bot: "nam",
  stage: "checked",
  at: at(22, 9, 20),
  goal: "Reply to customers whose parcels are late.",
  again: "parcels are late",
  steps: [
    { stage: "proposed", at: at(22, 9, 10) },
    { stage: "approved", at: at(22, 9, 14) },
    { stage: "sent", at: at(22, 9, 14) },
    { stage: "checked", at: at(22, 9, 20) },
  ],
  summary: "Nam found 3 customers.",
  recipients: [{ name: "Khun Ploy", status: "read" }],
  costSatang: 120,
  tookSeconds: 40,
  trace,
};

afterEach(() => setLang("en"));

describe("money", () => {
  it("is written from integer satang with the baht sign first, satang shown only when there are some", () => {
    expect(satangText(120)).toBe("฿1.20");
    expect(satangText(38)).toBe("฿0.38");
    expect(satangText(5)).toBe("฿0.05");
    expect(satangText(40)).toBe("฿0.40");
    expect(satangText(100)).toBe("฿1");
    expect(satangText(129_000)).toBe("฿1,290");
    expect(satangText(123_456_789)).toBe("฿1,234,567.89");
    expect(satangText(0)).toBe("฿0");
  });

  it("is a dash, never a guess, for anything that is not whole satang", () => {
    for (const bad of [1.5, -1, Number.NaN, Number.POSITIVE_INFINITY]) expect(satangText(bad)).toBe("—");
  });
});

describe("how long", () => {
  it("a step takes tenths of a second under ten, whole seconds under a minute, then minutes and hours", () => {
    expect(stepTime(800)).toBe("0.8 s");
    expect(stepTime(1_900)).toBe("1.9 s");
    expect(stepTime(9_950)).toBe("10 s");
    expect(stepTime(31_200)).toBe("31 s");
    expect(stepTime(240_000)).toBe("4 min");
    expect(stepTime(4_320_000)).toBe("1.2 h");
  });

  it("the whole job took seconds, then minutes and seconds, then hours and minutes", () => {
    expect(tookText(40)).toBe("40 seconds");
    expect(tookText(1)).toBe("1 second");
    expect(tookText(0)).toBe("0 seconds");
    expect(tookText(125)).toBe("2m 5s");
    expect(tookText(3_900)).toBe("1h 5m");
  });
});

describe("a stage", () => {
  const rows: [JobStage, string, string][] = [
    ["proposed", "Needs you", "tag warn"],
    ["approved", "You approved", "tag"],
    ["working", "Working", "tag run"],
    ["paused", "Paused", "tag"],
    ["sent", "Sent", "tag ok"],
    ["checked", "Checked", "tag ok"],
    ["failed", "Failed", "tag err"],
    ["cancelled", "Cancelled by you", "tag"],
    ["partly", "Partly done", "tag warn"],
  ];
  it.each(rows)("%s is tagged %j in the canvas's colour", (stage, word, cls) => {
    setLang("en");
    expect({ word: t(stageTag(stage).word), cls: stageTag(stage).cls }).toEqual({ word, cls });
  });

  it("has a word in every language", () => {
    for (const l of ["en", "ko", "ja", "zh"] as const) for (const [stage] of rows) expect(t(stageTag(stage).word, undefined, l).trim(), `${l} ${stage}`).not.toBe("");
  });
});

describe("the timeline", () => {
  it("is each step with its time, and only the last one coloured for where the job stands", () => {
    expect(timeline(job.steps, NOW)).toEqual({
      day: null,
      chips: [
        { stage: "proposed", text: "Proposed 09:10", cls: "tag" },
        { stage: "approved", text: "You approved 09:14", cls: "tag" },
        { stage: "sent", text: "Sent 09:14", cls: "tag" },
        { stage: "checked", text: "Checked 09:20", cls: "tag ok" },
      ],
    });
  });

  it("says Working with no time, since it has no end yet", () => {
    const t = timeline([{ stage: "proposed", at: at(22, 9, 10) }, { stage: "approved", at: at(22, 9, 14) }, { stage: "working", at: at(22, 9, 14) }], NOW);
    expect(t.chips.at(-1)).toEqual({ stage: "working", text: "Working", cls: "tag run" });
  });

  it("names the day when the job began on another day, so a time alone is never ambiguous", () => {
    expect(timeline([{ stage: "sent", at: at(21, 18, 40) }], NOW).day).toBe("Yesterday");
    expect(timeline([{ stage: "sent", at: at(22, 8, 0) }], NOW).day).toBeNull();
    expect(timeline([], NOW)).toEqual({ day: null, chips: [] });
  });
});

describe("who a job went to", () => {
  it("is tagged waiting, delivered, read or not delivered", () => {
    const rows: [RecipientStatus, string, string][] = [
      ["waiting", "Waiting", "tag"],
      ["delivered", "Delivered", "tag"],
      ["read", "Read", "tag ok"],
      ["failed", "Not delivered", "tag err"],
    ];
    for (const [status, word, cls] of rows) expect({ word: t(recipientTag(status).word), cls: recipientTag(status).cls }, status).toEqual({ word, cls });
  });

  it("is shown by the first letter of the given name, past Khun", () => {
    expect(initialOf("Khun Ploy")).toBe("P");
    expect(initialOf("khun mint")).toBe("M");
    expect(initialOf("Ploy")).toBe("P");
    expect(initialOf("คุณสมชาย")).toBe("ส");
    expect(initialOf("   ")).toBe("?");
  });
});

describe("the trace", () => {
  it("is one row per step with its time and, when it cost something, its cost", () => {
    expect(traceRows(trace)).toEqual([
      { tool: "shopee.list_orders", found: "late > 2 days, 3 found", time: "0.8 s", cost: null, result: null },
      { tool: "draft_reply", found: "demo-standard, 1,412 tokens", time: "31 s", cost: "฿0.98", result: null },
      { tool: "approval.wait", found: "allow once, by you", time: "4 min", cost: null, result: null },
      { tool: "verify.delivery", found: "3 of 3 delivered", time: "5.0 s", cost: "฿0.22", result: "pass" },
    ]);
  });

  it("totals the tokens and the cost of its steps, and has no tokens when no step used any", () => {
    expect(traceTotal(trace)).toEqual({ tokens: 1_964, costSatang: 120 });
    expect(traceTotal([trace[0], trace[2]])).toEqual({ tokens: null, costSatang: 0 });
    expect(traceTotal([])).toEqual({ tokens: null, costSatang: 0 });
  });

  it("copies as text: the job's title, a line per step, and the total, with nothing about customers", () => {
    expect(traceText(job)).toBe(
      [
        "Replies about late parcels",
        "shopee.list_orders · late > 2 days, 3 found · 0.8 s",
        "draft_reply · demo-standard, 1,412 tokens · 31 s · ฿0.98",
        "approval.wait · allow once, by you · 4 min",
        "verify.delivery · 3 of 3 delivered · 5.0 s · ฿0.22 · pass",
        "Total · 1,964 tokens · ฿1.20",
      ].join("\n"),
    );
    expect(traceText(job)).not.toContain("Khun Ploy");
  });

  it("leaves the tokens out of the total line when none was used", () => {
    expect(traceText({ ...job, trace: [trace[0]] }).split("\n").at(-1)).toBe("Total · ฿0");
  });
});

describe("when a job last moved, where a list names it", () => {
  it("is the time today, and the day too on another day, so a list of work never reads ambiguously", () => {
    expect(whenText(at(22, 9, 20), NOW)).toBe("09:20");
    expect(whenText(at(21, 18, 40), NOW)).toBe("Yesterday 18:40");
    expect(whenText(at(20, 11, 30), NOW)).toBe("Friday 11:30");
    expect(whenText(new Date(2026, 10, 3, 3, 0).getTime() / 1000, NOW)).toBe("Nov 3 03:00");
  });
});
