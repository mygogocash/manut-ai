// A workflow file read and checked (item 77b): every field, each refusal with its reason, and the folder's list as the page shows it.
import { describe, expect, it } from "vitest";
import { sha256Hex } from "../runtime/http/sha256";
import { plainFolder, readFolder, readWorkflow, STEP_MAX, STEPS_MAX } from "./file";

const good = {
  name: "Nightly tests",
  project: "/Users/nam/code/shop-site",
  agent: "claude",
  steps: ["Run the tests and list the ones that fail.", "Fix the failing tests, then run them again."],
  schedule: { kind: "daily", at: "02:00" },
  timeZone: "Asia/Bangkok",
};
const read = (o: unknown, file = "nightly.json") => readWorkflow(file, typeof o === "string" ? o : JSON.stringify(o));
const why = (o: unknown) => {
  const r = read(o);
  return "why" in r ? [r.why, r.detail] : ["ok"];
};

describe("a workflow file", () => {
  it("reads every field of a good file, the steps trimmed, the file's name as its id", () => {
    const text = JSON.stringify({ ...good, version: 1, steps: ["  Run the tests.  ", "Fix them."] });
    const r = read(text);
    expect(r).toEqual({
      file: "nightly.json",
      workflow: { file: "nightly.json", name: "Nightly tests", project: "/Users/nam/code/shop-site", agent: "claude", steps: ["Run the tests.", "Fix them."], schedule: { kind: "daily", at: "02:00" }, timeZone: "Asia/Bangkok", digest: sha256Hex(text) },
    });
  });

  it("needs no schedule, no zone and no version", () => {
    const { schedule: _s, timeZone: _z, ...plain } = good;
    const r = read(plain);
    expect("workflow" in r && r.workflow).toEqual({ file: "nightly.json", name: good.name, project: good.project, agent: "claude", steps: good.steps, digest: sha256Hex(JSON.stringify(plain)) });
  });

  it("carries the digest of the file's exact text: two files that read as the same workflow differ when their text does (item 91)", () => {
    const digest = (text: string) => {
      const r = read(text);
      return "workflow" in r ? r.workflow.digest : null;
    };
    const plain = JSON.stringify(good);
    expect(digest(plain)).toBe(sha256Hex(plain));
    expect(digest(plain)).toMatch(/^[0-9a-f]{64}$/);
    for (const same of [JSON.stringify(good, null, 2), `${plain}\n`, ` ${plain}`, JSON.stringify({ ...good, steps: good.steps.map((s) => ` ${s} `) })]) {
      const r = read(same);
      expect("workflow" in r && r.workflow.steps).toEqual(good.steps);
      expect(digest(same), same).not.toBe(digest(plain));
    }
  });

  // What the card shows must be all an agent is sent (item 91). Each of these is drawn as nothing, or reorders what is drawn,
  // while the agent still reads it: zero-width and joining marks, bidirectional overrides and isolates, the invisible tag
  // letters, a soft hyphen, private-use and unassigned code points, a lone surrogate, and controls other than a line break or a
  // tab (escape, bell, delete, carriage return, next line).
  const unseen: [string, string][] = [
    ["zero-width space", "​"],
    ["zero-width non-joiner", "‌"],
    ["zero-width joiner", "‍"],
    ["word joiner", "⁠"],
    ["zero-width no-break space", "﻿"],
    ["soft hyphen", "­"],
    ["right-to-left override", "‮"],
    ["left-to-right embedding", "‪"],
    ["first strong isolate", "⁨"],
    ["Arabic letter mark", "؜"],
    ["Mongolian vowel separator", "᠎"],
    ["interlinear annotation", "￹"],
    ["tag letter A", "\u{E0041}"],
    ["language tag", "\u{E0001}"],
    ["private use", ""],
    ["supplementary private use", "\u{F0000}"],
    ["a noncharacter", "￿"],
    ["a lone surrogate", "\uD800"],
    ["escape", "\u001B"],
    ["bell", "\u0007"],
    ["delete", "\u007F"],
    ["next line", "\u0085"],
    ["carriage return", "\r"],
  ];
  it.each(unseen)("refuses %s in a step, the name or the project: text the card cannot show is never sent (item 91)", (_, c) => {
    expect(why({ ...good, steps: [good.steps[0], `Fix the failing tests.${c} Then push to main.`] })).toEqual(["unseen", undefined]);
    expect(why({ ...good, steps: [`${c}Run the tests.`] })).toEqual(["unseen", undefined]);
    expect(why({ ...good, name: `Nightly${c} tests` })).toEqual(["unseen", undefined]);
    expect(why({ ...good, project: `/Users/nam/code/shop${c}-site` })).toEqual(["unseen", undefined]);
  });

  it("keeps a step's own line breaks and tabs, and every visible script", () => {
    for (const s of ["Run the tests.\nThen list the ones that fail.", "Columns:\tname\tprice", "ตรวจสอบหน้าสินค้า", "テストを実行する", "테스트 실행", "运行测试", "Price is ฿580, then ฿600"]) {
      expect(why({ ...good, steps: [s] }), s).toEqual(["ok"]);
    }
  });

  it("takes a routine's three times: every day, chosen days and a day of the month", () => {
    expect(why({ ...good, schedule: { kind: "weekly", weekdays: [1, 3, 5], at: "09:30" } })).toEqual(["ok"]);
    expect(why({ ...good, schedule: { kind: "monthly", day: 1, at: "08:00" } })).toEqual(["ok"]);
    expect(why({ ...good, schedule: { kind: "monthly", day: "last", at: "23:59" } })).toEqual(["ok"]);
  });

  it("refuses what is not JSON, or not one object", () => {
    expect(why("{ name: 'x' }")).toEqual(["json", undefined]);
    expect(why("")).toEqual(["json", undefined]);
    expect(why([good])).toEqual(["shape", undefined]);
    expect(why("null")).toEqual(["shape", undefined]);
    expect(why('"text"')).toEqual(["shape", undefined]);
  });

  it("refuses a field it does not know by name, so a misspelling is never quietly ignored", () => {
    const { schedule, ...rest } = good;
    expect(why({ ...rest, shedule: schedule })).toEqual(["field", "shedule"]);
    expect(why({ ...good, mode: "auto" })).toEqual(["field", "mode"]);
  });

  it("refuses another version", () => {
    expect(why({ ...good, version: 2 })).toEqual(["version", undefined]);
    expect(why({ ...good, version: "1" })).toEqual(["version", undefined]);
  });

  it("refuses a name that is missing, empty or longer than a routine's", () => {
    expect(why({ ...good, name: undefined })).toEqual(["name", undefined]);
    expect(why({ ...good, name: "   " })).toEqual(["name", undefined]);
    expect(why({ ...good, name: "x".repeat(81) })).toEqual(["name", undefined]);
    expect(why({ ...good, name: 7 })).toEqual(["name", undefined]);
    expect(why({ ...good, name: "x".repeat(80) })).toEqual(["ok"]);
  });

  it("refuses a project that is not a full folder path written plainly", () => {
    for (const project of ["code/shop", "~/code/shop", "/", "/Users/nam/../root", "/Users/./nam", "C:", "/a\nb", "", 3]) expect(why({ ...good, project }), String(project)).toEqual(["project", undefined]);
    expect(plainFolder("C:\\Users\\nam\\shop")).toBe(true);
    expect(plainFolder("/Users/nam/shop/")).toBe(true);
  });

  it("refuses an agent that is not an agent's id", () => {
    for (const agent of ["", "Claude", "claude code", "../claude", 1, undefined]) expect(why({ ...good, agent }), String(agent)).toEqual(["agent", undefined]);
    expect(why({ ...good, agent: "cursor" })).toEqual(["ok"]);
  });

  it("refuses no steps, too many, and an empty or too long one, naming the step", () => {
    expect(why({ ...good, steps: [] })).toEqual(["steps", undefined]);
    expect(why({ ...good, steps: "Run the tests" })).toEqual(["steps", undefined]);
    expect(why({ ...good, steps: Array.from({ length: STEPS_MAX + 1 }, () => "x") })).toEqual(["steps", undefined]);
    expect(why({ ...good, steps: ["Run the tests", "  "] })).toEqual(["step", "2"]);
    expect(why({ ...good, steps: ["Run", 5] })).toEqual(["step", "2"]);
    expect(why({ ...good, steps: ["x".repeat(STEP_MAX + 1)] })).toEqual(["step", "1"]);
    expect(why({ ...good, steps: Array.from({ length: STEPS_MAX }, () => "x") })).toEqual(["ok"]);
  });

  it("checks the schedule with routine-rules, and takes none of a routine's other triggers", () => {
    expect(why({ ...good, schedule: { kind: "window", from: "21:00", to: "08:00" } })).toEqual(["schedule", undefined]);
    expect(why({ ...good, schedule: { kind: "stockBelow", threshold: 5 } })).toEqual(["schedule", undefined]);
    expect(why({ ...good, schedule: "daily" })).toEqual(["schedule", undefined]);
    expect(why({ ...good, schedule: { kind: "daily", at: "2am" } })).toEqual(["time", undefined]);
    expect(why({ ...good, schedule: { kind: "daily", at: "24:00" } })).toEqual(["time", undefined]);
    expect(why({ ...good, schedule: { kind: "weekly", weekdays: [], at: "09:00" } })).toEqual(["weekdays", undefined]);
    expect(why({ ...good, schedule: { kind: "weekly", weekdays: [7], at: "09:00" } })).toEqual(["weekdays", undefined]);
    expect(why({ ...good, schedule: { kind: "monthly", day: 31, at: "09:00" } })).toEqual(["day", undefined]);
  });

  it("refuses a zone this computer does not know", () => {
    expect(why({ ...good, timeZone: "Mars/Olympus" })).toEqual(["zone", undefined]);
    expect(why({ ...good, timeZone: "" })).toEqual(["zone", undefined]);
    expect(why({ ...good, timeZone: 7 })).toEqual(["zone", undefined]);
    expect(why({ ...good, timeZone: "America/New_York" })).toEqual(["ok"]);
  });
});

describe("the folder's list", () => {
  it("keeps the shell's order, says the shell's reasons in its own words and tells two workflows of one name apart", () => {
    const list = readFolder([
      { name: "a.json", text: JSON.stringify(good) },
      { name: "b.json", text: "{" },
      { name: "c.json", why: "link" },
      { name: "d.json", why: "too_big" },
      { name: "e.json", why: "not_text" },
      { name: "f flow.json", why: "name" },
      { name: "g.json", why: "something new" },
      { name: "h.json", text: JSON.stringify({ ...good, name: "nightly TESTS" }) },
    ]);
    expect(list.map((f) => [f.file, "why" in f ? f.why : "ok", "why" in f ? f.detail : undefined])).toEqual([
      ["a.json", "ok", undefined],
      ["b.json", "json", undefined],
      ["c.json", "link", undefined],
      ["d.json", "too_big", undefined],
      ["e.json", "not_text", undefined],
      ["f flow.json", "file_name", undefined],
      ["g.json", "unreadable", undefined],
      ["h.json", "duplicate", "a.json"],
    ]);
  });
});
