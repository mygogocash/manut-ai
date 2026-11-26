// When a job's lanes count as answered (item 102c, `gathered.ts`): a lane that works, waits on an ask or failed has not answered,
// whatever words it wrote earlier, and Compare in a chat is offered for two answers or more and never brings more than a box takes.
import { describe, expect, it } from "vitest";
import { THREADS_MAX } from "../chat/box/carry";
import type { LaneStatus } from "../code/lane";
import { answerState, comparable, lastAnswer, tally, type AnswerState } from "./gathered";

const said = "I replaced bank transfer with a PromptPay QR.";

describe("when a lane has answered", () => {
  it("is answered when its turn ended and it wrote an answer, whatever the tests say", () => {
    for (const status of ["checked", "tests_failed", "unconfirmed", "not_run", "reverted"] as LaneStatus[]) expect(answerState({ status, answer: said })).toBe("answered");
  });

  it("is not answered while it works, even with an earlier turn's words in its chat", () => {
    expect(answerState({ status: "working", answer: said })).toBe("working");
  });

  it("is waiting, not answered, while an ask waits: the words before the ask are not its answer", () => {
    expect(answerState({ status: "needs_you", answer: said })).toBe("waiting");
    expect(answerState({ status: "needs_you", answer: "" })).toBe("waiting");
  });

  it("a lane that failed has not answered and shows its words", () => {
    expect(answerState({ status: "failed", answer: said })).toBe("failed");
  });

  it("a lane that ended with no words of its own has none", () => {
    expect(answerState({ status: "not_run", answer: "" })).toBe("none");
    expect(answerState({ status: "checked", answer: "  \n " })).toBe("none");
  });
});

describe("the last answer", () => {
  it("is the agent's last message, whole, not cut and not the person's", () => {
    const long = "word ".repeat(2000);
    expect(lastAnswer([{ role: "assistant", text: "first" }, { role: "user", text: "and?" }, { role: "assistant", text: long }, { role: "user", text: "thanks" }])).toBe(long);
  });
  it("is nothing when the agent wrote none", () => {
    expect(lastAnswer([{ role: "user", text: "hi" }])).toBe("");
    expect(lastAnswer(undefined)).toBe("");
  });
});

describe("the count", () => {
  const states = (...s: AnswerState[]) => s;
  it("counts the answered of all, and is over only when none works and none waits", () => {
    expect(tally(states("answered", "answered", "answered"))).toEqual({ answered: 3, total: 3, waiting: 0, working: 0, over: true });
    expect(tally(states("answered", "waiting", "answered"))).toEqual({ answered: 2, total: 3, waiting: 1, working: 0, over: false });
    expect(tally(states("answered", "working", "failed"))).toMatchObject({ answered: 1, working: 1, over: false });
    expect(tally(states("answered", "failed", "none")).over).toBe(true);
  });
});

describe("which lanes Compare brings", () => {
  const lane = (id: string, state: AnswerState) => ({ id, state });
  it("brings the answered lanes in column order, and nothing for fewer than two", () => {
    expect(comparable([lane("a", "answered"), lane("b", "waiting"), lane("c", "answered")])).toEqual(["a", "c"]);
    expect(comparable([lane("a", "answered"), lane("b", "failed")])).toEqual([]);
    expect(comparable([])).toEqual([]);
  });
  it("never brings more than a box takes of other chats", () => {
    const many = ["a", "b", "c", "d", "e"].map((id) => lane(id, "answered"));
    expect(comparable(many)).toHaveLength(THREADS_MAX);
  });
});
