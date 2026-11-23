// Pause everyone's rules, apart from the page: how the flow moves between asking, paused and back, and how the page's
// sentences are chosen from what the runtime says. The sentences are the design canvas's (PauseAll.dc.html).
import { afterEach, describe, expect, it } from "vitest";
import { setLang } from "../i18n";
import type { PausedJob } from "../runtime/mission";
import { goneOut, jobsLine, memberNames, pausedJobLine, PAUSE_START, pauseReduce, routinesLine, sinceText } from "./pause";

const NOW = new Date(2026, 10, 22, 12, 0).getTime();
const at = (day: number, h: number, m: number) => new Date(2026, 10, day, h, m).getTime() / 1000;
const nameOf = (bot: string) => ({ nam: "Nam", pim: "Pim", ton: "Ton", kit: "Kit" })[bot] ?? bot;
const job = (over: Partial<PausedJob> = {}): PausedJob => ({ id: "weekend-replies", title: "Replies about weekend orders", bot: "nam", out: { sent: 1, total: 3 }, ...over });

afterEach(() => setLang("en"));

describe("the pause flow", () => {
  it("starts with nothing asked and nothing on its way", () => {
    expect(PAUSE_START).toEqual({ ask: false, back: false, busy: false, error: null });
  });

  it("asks first, and Keep working goes back without pausing anyone", () => {
    const asked = pauseReduce(PAUSE_START, { type: "ask" });
    expect(asked).toEqual({ ask: true, back: false, busy: false, error: null });
    expect(pauseReduce(asked, { type: "keep" })).toEqual(PAUSE_START);
  });

  it("is busy while the request is on its way, and a pause that went through closes the question", () => {
    const busy = pauseReduce(pauseReduce(PAUSE_START, { type: "ask" }), { type: "begin" });
    expect(busy).toEqual({ ask: true, back: false, busy: true, error: null });
    expect(pauseReduce(busy, { type: "done", paused: true })).toEqual(PAUSE_START);
  });

  it("says everyone is back after a resume that went through, and forgets it when the next question is asked", () => {
    const back = pauseReduce(pauseReduce(PAUSE_START, { type: "begin" }), { type: "done", paused: false });
    expect(back).toEqual({ ask: false, back: true, busy: false, error: null });
    expect(pauseReduce(back, { type: "ask" }).back).toBe(false);
  });

  it("keeps the question open and shows why when the runtime said no", () => {
    const failed = pauseReduce(pauseReduce(pauseReduce(PAUSE_START, { type: "ask" }), { type: "begin" }), { type: "failed", message: "Not yet: Connected mode only reads for now." });
    expect(failed).toEqual({ ask: true, back: false, busy: false, error: "Not yet: Connected mode only reads for now." });
    // trying again clears the old reason
    expect(pauseReduce(failed, { type: "begin" }).error).toBeNull();
  });
});

describe("what the page says", () => {
  it("names whom a pause stops, as a list in the language", () => {
    expect(memberNames(["nam", "pim", "ton", "kit"], nameOf)).toBe("Nam, Pim, Ton and Kit");
    expect(memberNames(["nam"], nameOf)).toBe("Nam");
    expect(memberNames(["nam", "stranger"], nameOf)).toBe("Nam and stranger");
    expect(memberNames([], nameOf)).toBe("");
  });

  it("says how many routines wait, and how many jobs are running", () => {
    expect(routinesLine(5)).toBe("5 routines wait.");
    expect(routinesLine(1)).toBe("1 routine waits.");
    expect(routinesLine(0)).toBe("No routines wait.");
    expect(jobsLine(2)).toBe("2 jobs are running.");
    expect(jobsLine(1)).toBe("1 job is running.");
    expect(jobsLine(0)).toBe("No job is running.");
  });

  it("lists, for the jobs that send things, how much has already gone out", () => {
    const state = [job(), job({ id: "teaser-draft", title: "Captions for the pre-order page", bot: "pim", out: null }), job({ id: "x", title: "Done one", out: { sent: 3, total: 3 } })];
    expect(goneOut(state)).toEqual([
      { id: "weekend-replies", title: "Replies about weekend orders", sent: 1, total: 3 },
      { id: "x", title: "Done one", sent: 3, total: 3 },
    ]);
  });

  it("tells each stopped job's state: what went and what waits, or that its work is kept", () => {
    expect(pausedJobLine(job(), nameOf)).toBe("1 of 3 sent. 2 are waiting.");
    expect(pausedJobLine(job({ out: { sent: 2, total: 3 } }), nameOf)).toBe("2 of 3 sent. 1 is waiting.");
    expect(pausedJobLine(job({ out: { sent: 0, total: 3 } }), nameOf)).toBe("0 of 3 sent. 3 are waiting.");
    expect(pausedJobLine(job({ out: { sent: 3, total: 3 } }), nameOf)).toBe("3 of 3 sent.");
    expect(pausedJobLine(job({ bot: "pim", out: null }), nameOf)).toBe("Pim’s work is kept.");
  });

  it("says when everyone was paused: the time today, and the day too when it was another", () => {
    expect(sinceText(at(22, 9, 15), NOW)).toBe("09:15");
    expect(sinceText(at(21, 23, 40), NOW)).toBe("Yesterday 23:40");
  });
});
