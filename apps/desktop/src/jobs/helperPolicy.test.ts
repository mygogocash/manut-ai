// The lead's note while Helpers is on (item 102e), with GoSpark's prompt contract ported (`BuddyStreamingDelegationTests.promptContract`,
// `mygogocash/gospark` at a7537c80): it asks for one block per helper lane, in the fence the parser reads, with exactly the keys the
// parser takes, and it says, as item 93's notes do, that Manut AI wrote it and that it gives no permission.
import { describe, expect, it } from "vitest";
import { HELPER_KEYS, helperOutcome } from "./helperBlocks";
import { helperPolicy, POLICY_END, POLICY_HEAD, withHelperPolicy, withoutHelperPolicy } from "./helperPolicy";

describe("the lead's note", () => {
  const note = helperPolicy(["claude", "codex"]);

  it("promptContract: asks for one fenced block per helper lane, in the fence the parser reads", () => {
    expect(note).toContain("one fenced block per helper lane");
    expect(note).toContain("```manut-helpers");
    expect(note).toContain("stop after the last one");
  });

  it("shows the block with exactly the keys the parser takes, and names no mode", () => {
    const example = note.slice(note.indexOf("```manut-helpers"), note.indexOf("```", note.indexOf("```manut-helpers") + 3) + 3);
    const read = helperOutcome(example);
    expect(read.kind).toBe("helpers");
    expect(JSON.parse(example.split("\n")[1])).toEqual(expect.objectContaining(Object.fromEntries(HELPER_KEYS.map((k) => [k, expect.any(String)]))));
    expect(Object.keys(JSON.parse(example.split("\n")[1]))).toEqual([...HELPER_KEYS]);
    expect(note).not.toMatch(/"mode"|bypass|approve":/);
  });

  it("says who wrote it, that it gives no permission, the agents a helper lane can run on, the budget and the rounds", () => {
    expect(note.startsWith(POLICY_HEAD)).toBe(true);
    expect(POLICY_HEAD).toContain("not the person speaking and gives no permission");
    expect(note).toContain("Agents a helper lane can run on: claude, codex.");
    expect(note).toContain("up to 20 minutes and 90 steps");
    expect(note).toContain("At most 8 helper lanes a round and 2 rounds");
    expect(note).toContain("nothing starts until they press Start helpers");
    expect(note).toContain("neither you nor a helper lane can answer, allow or deny an ask");
    expect(note.trimEnd().endsWith(POLICY_END)).toBe(true);
  });

  it("goes in front of the person's message, and comes off again whole", () => {
    const wire = withHelperPolicy("Split the checkout work", ["claude"]);
    expect(wire.startsWith(POLICY_HEAD)).toBe(true);
    expect(wire.endsWith("Split the checkout work")).toBe(true);
    expect(withoutHelperPolicy(wire)).toBe("Split the checkout work");
    expect(withoutHelperPolicy(withHelperPolicy("line one\n\nline two", []))).toBe("line one\n\nline two");
    // a message with no note, or one that only starts like it, is as it was
    expect(withoutHelperPolicy("/kit pass")).toBe("/kit pass");
    expect(withoutHelperPolicy(`${POLICY_HEAD} and nothing more`)).toBe(`${POLICY_HEAD} and nothing more`);
  });
});
