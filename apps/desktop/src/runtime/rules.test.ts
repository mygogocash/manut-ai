// The rules a runtime refuses with before it sends anything, said once beside the protocol (memory.ts, routines.ts) and shared by
// the connected runtime and Practice: what words can be a fact, what can name one, what a new routine's shape may be, and the timing
// as the API reads it. The memory and routine rules themselves are `@manut/shop-memory`'s and `@manut/routine-rules`', so these
// only check that what is asked of the packages is what the API checks, and that Practice, which applies the packages through its
// own state, refuses the same words.
import { MAX_TEXT } from "@manut/shop-memory";
import { describe, expect, it } from "vitest";
import { factIdOk, factTextRefusal, MAX_FACT_ID } from "./memory";
import { MockHost, MockRuntime } from "./mock";
import { OWN_SHOP } from "./mock/shops";
import { MAX_ROUTINES, newRoutineRefusal, triggerBody } from "./routines";

describe("what words can be a fact", () => {
  const taken: [string, unknown][] = [
    ["a sentence", "We ship on weekdays"],
    ["words with spaces at both ends", "  We ship on weekdays  "],
    ["exactly 280 characters", "x".repeat(MAX_TEXT)],
    ["280 Thai letters, counted as letters", "ก".repeat(MAX_TEXT)],
    ["280 emoji, counted as characters and not as the bytes they take", "🌸".repeat(MAX_TEXT)],
  ];
  const refused: [string, unknown][] = [
    ["nothing", ""],
    ["only spaces", "   \n\t "],
    ["281 characters", "x".repeat(MAX_TEXT + 1)],
    ["281 Thai letters", "ข".repeat(MAX_TEXT + 1)],
    ["a number", 42],
    ["nothing at all", undefined],
    ["null", null],
    ["a list", ["We ship"]],
  ];

  it.each(taken)("takes %s", (_what, text) => {
    expect(factTextRefusal(text)).toBeNull();
  });

  it.each(refused)("refuses %s as invalid_text", (_what, text) => {
    expect(factTextRefusal(text)).toBe("invalid_text");
  });

  it("is the rule Practice keeps, which applies the same package to its own memory", async () => {
    const rt = new MockRuntime(new MockHost());
    await rt.connect();
    for (const [what, text] of [...taken, ...refused]) {
      const outcome = await rt.request("memory.remember", { shop: OWN_SHOP, text: text as string }).then(
        () => null,
        (e: { code: string }) => e.code,
      );
      // `already_known` and `full` are about the memory it holds, which the rule has no say in
      expect(outcome === "invalid_text" ? "invalid_text" : null, what).toBe(factTextRefusal(text));
    }
  });
});

describe("what can name a fact", () => {
  it("takes text of 1 to 64 characters, as the API counts them, and nothing else", () => {
    expect(factIdOk("f1")).toBe(true);
    expect(factIdOk("f".repeat(MAX_FACT_ID))).toBe(true);
    for (const id of ["", "f".repeat(MAX_FACT_ID + 1), undefined, null, 1, {}, ["f1"]]) expect(factIdOk(id), JSON.stringify(id)).toBe(false);
  });
});

describe("what a new routine's shape may be", () => {
  const daily = { kind: "daily", at: "08:00" } as const;

  it("takes the form's every kind of work and every kind of time", () => {
    for (const action of ["brief", "draft", "reply", "send"] as const) expect(newRoutineRefusal({ name: "Do it", action, trigger: daily }), action).toBeNull();
    for (const trigger of [
      daily,
      { kind: "weekly", weekdays: [1, 4], at: "09:30" },
      { kind: "monthly", day: 1, at: "08:00" },
      { kind: "monthly", day: 28, at: "08:00" },
      { kind: "monthly", day: "last", at: "18:00" },
      { kind: "window", from: "21:00", to: "08:00" },
      { kind: "stockBelow", threshold: 5 },
    ])
      expect(newRoutineRefusal({ name: "Do it", action: "brief", trigger }), JSON.stringify(trigger)).toBeNull();
  });

  it("refuses with the package's own reason, in the order the API checks", () => {
    expect(newRoutineRefusal({ name: "   ", action: "brief", trigger: daily })).toBe("invalid_name");
    expect(newRoutineRefusal({ name: "x".repeat(81), action: "brief", trigger: daily })).toBe("invalid_name");
    expect(newRoutineRefusal({ name: "x".repeat(80), action: "brief", trigger: daily })).toBeNull();
    expect(newRoutineRefusal({ name: "Do it", action: "juggle", trigger: daily })).toBe("invalid_action");
    expect(newRoutineRefusal({ name: "Do it", action: "brief", trigger: { kind: "hourly" } })).toBe("invalid_trigger");
    expect(newRoutineRefusal({ name: "Do it", action: "brief", trigger: null })).toBe("invalid_trigger");
    expect(newRoutineRefusal({ name: "Do it", action: "brief", trigger: { kind: "daily", at: "8:00" } })).toBe("invalid_time");
    expect(newRoutineRefusal({ name: "Do it", action: "brief", trigger: { kind: "weekly", weekdays: [], at: "08:00" } })).toBe("invalid_weekdays");
    expect(newRoutineRefusal({ name: "Do it", action: "brief", trigger: { kind: "weekly", weekdays: [7], at: "08:00" } })).toBe("invalid_weekdays");
    expect(newRoutineRefusal({ name: "Do it", action: "brief", trigger: { kind: "monthly", day: 29, at: "08:00" } })).toBe("invalid_day");
    expect(newRoutineRefusal({ name: "Do it", action: "brief", trigger: { kind: "window", from: "08:00", to: "08:00" } })).toBe("invalid_window");
    expect(newRoutineRefusal({ name: "Do it", action: "brief", trigger: { kind: "stockBelow", threshold: 0 } })).toBe("invalid_threshold");
    expect(newRoutineRefusal({ name: "Do it", action: "brief", trigger: { kind: "stockBelow", threshold: 2.5 } })).toBe("invalid_threshold");
  });

  it("refuses to say a routine that replies, sends, pays or deletes need not ask, and never quietly changes it", () => {
    for (const action of ["reply", "send", "pay", "delete"] as const) {
      expect(newRoutineRefusal({ name: "Do it", action, trigger: daily, asksFirst: false }), action).toBe("must_ask_first");
      expect(newRoutineRefusal({ name: "Do it", action, trigger: daily, asksFirst: true }), action).toBeNull();
    }
    // a brief or a draft only the owner sees may be made to ask, or not
    for (const action of ["brief", "draft"] as const) for (const asksFirst of [true, false]) expect(newRoutineRefusal({ name: "Do it", action, trigger: daily, asksFirst }), `${action} ${asksFirst}`).toBeNull();
  });

  it("refuses an asksFirst that is neither true nor false, as the API does before it asks the package", () => {
    for (const asksFirst of ["yes", 1, null, {}])
      expect(newRoutineRefusal({ name: "Do it", action: "brief", trigger: daily, asksFirst }), JSON.stringify(asksFirst)).toBe("invalid_request");
    // it is the first thing the API checks, so it wins over a name the package would refuse too
    expect(newRoutineRefusal({ name: "", action: "brief", trigger: daily, asksFirst: "no" })).toBe("invalid_request");
  });

  it("keeps the API's limit of routines a team has", () => {
    expect(MAX_ROUTINES).toBe(50);
  });
});

describe("the timing as the API reads it", () => {
  it("keeps only the fields of its kind, so nothing a caller left on the object goes with it", () => {
    const stray = { extra: "x", secret: "y" };
    expect(triggerBody({ kind: "daily", at: "08:00", ...stray } as never)).toEqual({ kind: "daily", at: "08:00" });
    expect(triggerBody({ kind: "weekly", weekdays: [1, 4], at: "09:30", ...stray } as never)).toEqual({ kind: "weekly", weekdays: [1, 4], at: "09:30" });
    expect(triggerBody({ kind: "monthly", day: "last", at: "18:00", ...stray } as never)).toEqual({ kind: "monthly", day: "last", at: "18:00" });
    expect(triggerBody({ kind: "window", from: "21:00", to: "08:00", ...stray } as never)).toEqual({ kind: "window", from: "21:00", to: "08:00" });
    expect(triggerBody({ kind: "stockBelow", threshold: 5, ...stray } as never)).toEqual({ kind: "stockBelow", threshold: 5 });
  });

  it("hands out a copy of the days, so the caller's list is not the one the request holds", () => {
    const days = [1, 4];
    const body = triggerBody({ kind: "weekly", weekdays: days, at: "09:30" });
    days.push(6);
    expect(body).toEqual({ kind: "weekly", weekdays: [1, 4], at: "09:30" });
  });
});
