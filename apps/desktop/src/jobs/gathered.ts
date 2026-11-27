// When a job's lanes count as answered (item 102c; `docs/several-agents.md`, "3. The gathered answers"). Pure: the Gathered block
// draws what these functions say and nothing else decides it, so the rule is one place a test can pin.
//
// A lane has answered when its last turn ended and an answer is in its chat. A lane that is working has not, and neither has a lane
// that waits on an ask: whatever words it wrote before the ask are not its answer, so they are never shown as one. A lane that
// failed has no answer and shows its own words. No model is read here, and no lane is ranked: the app picks no best answer.
import type { LaneStatus } from "../code/lane";
import { THREADS_MAX } from "../chat/box/carry";

export type AnswerState = "answered" | "working" | "waiting" | "failed" | "none";

/** What the rule reads of a lane: its state as the Lanes band tags it and the last words the agent wrote in its chat. */
export interface AnswerFacts {
  status: LaneStatus;
  /** The agent's last message in the lane's chat ("" when it wrote none). */
  answer: string;
}

/** The state of one lane's answer. An ask that waits comes first, as it does in the lane's own tag: a lane that asks is waiting
 *  on the person even when an earlier turn left an answer. */
export function answerState(l: AnswerFacts): AnswerState {
  if (l.status === "needs_you") return "waiting";
  if (l.status === "working") return "working";
  if (l.status === "failed") return "failed";
  return l.answer.trim() ? "answered" : "none";
}

/** The agent's last message of a chat, whole, or "" when it wrote none. */
export function lastAnswer(messages: readonly { role: "user" | "assistant"; text: string }[] | undefined): string {
  for (let i = (messages?.length ?? 0) - 1; i >= 0; i--) {
    const m = (messages as readonly { role: string; text: string }[])[i];
    if (m.role === "assistant" && m.text.trim()) return m.text;
  }
  return "";
}

export interface Tally {
  answered: number;
  total: number;
  waiting: number;
  working: number;
  /** Every lane has ended its turn: none works and none waits on an ask. */
  over: boolean;
}

export function tally(states: readonly AnswerState[]): Tally {
  const n = (s: AnswerState) => states.filter((x) => x === s).length;
  const waiting = n("waiting");
  const working = n("working");
  return { answered: n("answered"), total: states.length, waiting, working, over: waiting === 0 && working === 0 };
}

/** The lanes Compare in a chat brings: those that answered, in the order the columns are, at most the chips of other chats one box takes (item 97, which is also the most lanes a job has). Fewer than two is nothing to compare. */
export function comparable(lanes: readonly { id: string; state: AnswerState }[]): string[] {
  const ids = lanes.filter((l) => l.state === "answered").map((l) => l.id);
  return ids.length >= 2 ? ids.slice(0, THREADS_MAX) : [];
}
