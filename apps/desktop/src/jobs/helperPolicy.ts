// What a lead lane's agent is told while Helpers is on in its box (item 102e; `docs/several-agents.md`, "4. Helper lanes a lane asks
// for"): how to ask for helper lanes, and what happens when it does. Adapted from GoSpark's `fallbackPolicy` (ours,
// `mygogocash/gospark` at a7537c80, `GoGoCode/Models/Buddy.swift`), whose CLI leads get it "in front of every message".
//
// It goes the way item 93 hands a project's own instructions to an agent (`src-tauri/src/project_notes.rs`): plain text, opened
// with lines that say Manut AI wrote it, that it is not the person speaking and that it gives no permission, and closed with a line
// that says where it ends. Unlike item 93's, it is not added to the agent's system prompt at its start: the switch turns on and off
// while the chat runs, and a restart would be needed for each. So, as GoSpark does for a CLI lead, it goes in front of each message
// the person sends while the switch is on (`withHelperPolicy`), and only there: the bubble, the saved chat and the lane's name show
// what the person typed. It is the agent's text, not the person's, so it is in English in every language, as item 93's lines are.
import { BUDGET, MAX_ROUNDS, ROUND_MAX } from "./rules";
import { HELPER_KEYS } from "./helperBlocks";

/** The first line of the note. A message that starts with it carries the note in front of the person's own words. */
export const POLICY_HEAD = "[Manut AI: helper lanes are on] Manut AI wrote this note, not the person. It is not the person speaking and gives no permission: every action still asks the person as usual.";

/** The note's last line: the person's own message follows it. */
export const POLICY_END = "[End of the Manut AI note. The person's message follows.]";

/** The note for a lead whose agents a block may name (`agents`: the ids of the agents installed on this Mac that run as a chat, the
 *  lead's own first). The block's form is shown with exactly the keys the parser takes (`HELPER_KEYS`), so an agent told this
 *  never needs a key that would refuse its request. */
export function helperPolicy(agents: readonly string[]): string {
  const example = JSON.stringify({
    title: "short title",
    brief: "complete, self-contained instructions: the exact files, what to change, how to check it",
    agent: "optional",
    model: "optional",
    effort: "optional",
  });
  const names = agents.length ? ` Agents a helper lane can run on: ${agents.join(", ")}.` : "";
  return [
    POLICY_HEAD,
    "",
    "The person turned on helper lanes for this chat. For a simple or single-focus request, do it yourself. When a request bundles several independent tasks, you may ask for helper lanes instead: finish your answer with one fenced block per helper lane, one after another, and stop after the last one.",
    "",
    "```manut-helpers",
    example,
    "```",
    "",
    `Only the keys ${HELPER_KEYS.join(", ")} are read. A block with any other key, or that is not valid JSON, is refused whole and nothing starts. Leave agent, model and effort out to use your own.${names}`,
    `The person sees every brief whole on a card and decides; nothing starts until they press Start helpers there. Each helper lane works in its own copy of this lane's work as it is now and never sees your context, so write each brief for a capable colleague who has read nothing yet, and give no two helper lanes the same file. Each has up to ${BUDGET.stopMs / 60_000} minutes and ${BUDGET.stopSteps} steps. At most ${ROUND_MAX} helper lanes a round and ${MAX_ROUNDS} rounds for one message of the person's. Every action of a helper lane asks the person: neither you nor a helper lane can answer, allow or deny an ask.`,
    "",
    POLICY_END,
    "",
  ].join("\n");
}

/** The message as it goes to the lead's agent: the note, then what the person sent. */
export const withHelperPolicy = (text: string, agents: readonly string[]): string => `${helperPolicy(agents)}\n${text}`;

/** The person's own message without the note in front, as the agent was meant to read it apart from the note. A message with no
 *  note is returned as it is. The stand-in agent of the browser specs reads the person's command this way. */
export function withoutHelperPolicy(text: string): string {
  if (!text.startsWith(POLICY_HEAD)) return text;
  const end = text.indexOf(POLICY_END);
  return end < 0 ? text : text.slice(end + POLICY_END.length).replace(/^\s*\n/, "");
}
