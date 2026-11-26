// Item 102e's helper block parser, with GoSpark's delegation block tests ported case by case (`mygogocash/gospark` at a7537c80:
// `Tests/BuddyDelegationTests.swift`, `BuddyDelegationFenceTests.swift`, `BuddyStreamingDelegationTests.swift` and the
// `delegatingReply` cases of `BuddyHeldBackTests.swift`), and the fork's fence walk cases (`src/threads/splitBlocks.test.ts`). Each row
// names the test it comes from; a row whose answer differs from GoSpark's says how and why. GoSpark's fences were `buddy` and
// `hydra`; here they are `manut-helpers` and `helpers`, and its `task` and `prompt` are `title` and `brief`. The slice's safety tests
// are at the end: a block with an unknown key (`mode`, `approve`) is refused whole.
import { describe, expect, it } from "vitest";
import {
  BRIEF_MAX,
  endsInHelperBlock,
  hasHelperBlock,
  helperOutcome,
  helperReply,
  hideHelperBlocks,
  partialHelpers,
  streamingHelpers,
  TITLE_MAX,
  type HelperOutcome,
} from "./helperBlocks";

const fence = (body: string, word = "manut-helpers") => `\`\`\`${word}\n${body}\n\`\`\``;
const block = (body: string, word = "manut-helpers") => `Sending out helper lanes.\n\n${fence(body, word)}`;
const titles = (o: HelperOutcome) => (o.kind === "helpers" || o.kind === "partial" ? o.helpers.map((h) => h.title) : null);

describe("reading a request (GoSpark's BuddyDelegationTests)", () => {
  const rows: { from: string; text: string; want: HelperOutcome }[] = [
    {
      from: "parsesSingleDelegation",
      text: block(`[{"title": "Rename the model", "brief": "Rename Foo to Bar in Models/Foo.swift."}]`),
      want: { kind: "helpers", helpers: [{ title: "Rename the model", brief: "Rename Foo to Bar in Models/Foo.swift." }] },
    },
    {
      from: "parsesSeveralInOrder",
      text: block(`[{"title": "A", "brief": "do a"}, {"title": "B", "brief": "do b"}]`),
      want: { kind: "helpers", helpers: [{ title: "A", brief: "do a" }, { title: "B", brief: "do b" }] },
    },
    { from: "acceptsBareObject", text: block(`{"title": "Solo", "brief": "do it"}`), want: { kind: "helpers", helpers: [{ title: "Solo", brief: "do it" }] } },
    {
      from: "fallsBackToPromptForTitle",
      text: block(`[{"brief": "Update the changelog for the release."}]`),
      want: { kind: "helpers", helpers: [{ title: "Update the changelog for the release.", brief: "Update the changelog for the release." }] },
    },
    { from: "trimsWhitespace", text: block(`[{"title": "  Padded  ", "brief": "  work  "}]`), want: { kind: "helpers", helpers: [{ title: "Padded", brief: "work" }] } },
    // GoSpark skips the entry with no prompt and keeps the rest; here it refuses the request, because the card would show fewer
    // helper lanes than were asked for (R3: refused whole)
    { from: "skipsEntryWithoutPrompt (differs)", text: block(`[{"title": "No brief"}, {"title": "Good", "brief": "do it"}]`), want: { kind: "refused", refusal: { why: "brief" } } },
    { from: "skipsWhitespaceOnlyPrompt", text: block(`[{"title": "Blank", "brief": "   "}]`), want: { kind: "refused", refusal: { why: "brief" } } },
    { from: "returnsNilWithoutBlock", text: "Just a normal reply with no helper lanes.", want: { kind: "none" } },
    { from: "returnsNilForEmptyArray", text: block("[]"), want: { kind: "refused", refusal: { why: "empty" } } },
    { from: "returnsNilForMalformedJSON", text: block(`[{"title": "broken"`), want: { kind: "refused", refusal: { why: "json" } } },
    { from: "ignoresOtherFencedBlocks", text: "Here is code:\n\n```swift\nlet x = 1\n```", want: { kind: "none" } },
    {
      from: "readsEveryBlock",
      text: `${block(`[{"title": "First", "brief": "a"}]`)}\n\n${fence(`[{"title": "Second", "brief": "b"}]`)}`,
      want: { kind: "helpers", helpers: [{ title: "First", brief: "a" }, { title: "Second", brief: "b" }] },
    },
    {
      from: "parsesBuddyFence: the shorter word reads the same",
      text: block(`[{"title": "Rename the model", "brief": "Rename Foo to Bar."}]`, "helpers"),
      want: { kind: "helpers", helpers: [{ title: "Rename the model", brief: "Rename Foo to Bar." }] },
    },
    {
      from: "stripsTheFirstFenceLanguage: both words in one answer are read in written order",
      text: `${block(`[{"title": "A", "brief": "do a"}]`, "helpers")}\n\n${fence(`[{"title": "B", "brief": "do b"}]`)}`,
      want: { kind: "helpers", helpers: [{ title: "A", brief: "do a" }, { title: "B", brief: "do b" }] },
    },
  ];
  it.each(rows)("$from", ({ text, want }) => {
    expect(helperOutcome(text)).toEqual(want);
  });

  it("keeps the agent, the model and the effort a helper names, and leaves out the ones it does not", () => {
    const o = helperOutcome(block(`{"title": "Tests", "brief": "Write the tests.", "agent": " codex ", "model": "gpt-6.1", "effort": "high"}\n`));
    expect(o).toEqual({ kind: "helpers", helpers: [{ title: "Tests", brief: "Write the tests.", agent: "codex", model: "gpt-6.1", effort: "high" }] });
    expect(helperOutcome(block(`{"brief": "x", "agent": "", "model": "  "}`))).toEqual({ kind: "helpers", helpers: [{ title: "x", brief: "x" }] });
  });

  it("makes a title one line, cut at its limit, and keeps the brief whole with its lines", () => {
    const long = "word ".repeat(40);
    const o = helperOutcome(block(JSON.stringify({ title: `A\n  title\twith  lines ${long}`, brief: "line one\n\nline two" })));
    if (o.kind !== "helpers") throw new Error(o.kind);
    // cut at the limit, then the space before the cut trimmed
    expect(o.helpers[0].title.length).toBeLessThanOrEqual(TITLE_MAX);
    expect(o.helpers[0].title.length).toBeGreaterThan(TITLE_MAX - 3);
    expect(o.helpers[0].title.startsWith("A title with lines word")).toBe(true);
    expect(o.helpers[0].title.endsWith("…")).toBe(true);
    expect(o.helpers[0].brief).toBe("line one\n\nline two");
  });

  it("refuses a brief past its limit, and a name that is not one line of text", () => {
    expect(helperOutcome(block(JSON.stringify({ brief: "x".repeat(BRIEF_MAX + 1) })))).toEqual({ kind: "refused", refusal: { why: "long" } });
    expect(helperOutcome(block(JSON.stringify({ brief: "x".repeat(BRIEF_MAX) }))).kind).toBe("helpers");
    expect(helperOutcome(block(JSON.stringify({ brief: "x", model: "a\nb" })))).toEqual({ kind: "refused", refusal: { why: "value", key: "model" } });
    expect(helperOutcome(block(JSON.stringify({ brief: "x", agent: "a".repeat(101) })))).toEqual({ kind: "refused", refusal: { why: "value", key: "agent" } });
    expect(helperOutcome(block(`{"brief": "x", "effort": 3}`))).toEqual({ kind: "refused", refusal: { why: "value", key: "effort" } });
    expect(helperOutcome(block(`{"brief": "x", "model": null}`))).toEqual({ kind: "refused", refusal: { why: "value", key: "model" } });
    expect(helperOutcome(block(`{"brief": ["x"]}`))).toEqual({ kind: "refused", refusal: { why: "value", key: "brief" } });
    expect(helperOutcome(block(`["a brief"]`))).toEqual({ kind: "refused", refusal: { why: "shape" } });
    expect(helperOutcome(block(`"a brief"`))).toEqual({ kind: "refused", refusal: { why: "shape" } });
  });

  it("refuses the whole request when one block of several cannot be read, where GoSpark starts the readable ones", () => {
    const text = `${block(`{"title": "A", "brief": "do a"}`)}\n\n${fence("not json")}`;
    expect(helperOutcome(text)).toEqual({ kind: "refused", refusal: { why: "json" } });
  });
});

describe("fences and nesting (GoSpark's BuddyDelegationFenceTests, the fork's walk)", () => {
  it("parsesNestedFence: a brief holding a fenced code sample still parses", () => {
    const reply = `Sending out helper lanes.\n\n\`\`\`helpers\n[{"title": "Add a flag", "brief": "Make it match:\\n\`\`\`swift\\nlet a = 1\\n\`\`\`\\nThen test."}]\n\`\`\``;
    const o = helperOutcome(reply);
    if (o.kind !== "helpers") throw new Error(o.kind);
    expect(o.helpers).toHaveLength(1);
    expect(o.helpers[0].title).toBe("Add a flag");
    expect(o.helpers[0].brief).toContain("let a = 1");
  });

  it("stripsBlockWithNestedFence: a nested fence goes with its block", () => {
    expect(hideHelperBlocks(`Here you go.\n\n\`\`\`helpers\n[{"title": "T", "brief": "\`\`\`swift\\nlet a = 1\\n\`\`\`"}]\n\`\`\``)).toBe("Here you go.");
  });

  it("a fenced sample on lines of its own inside a block opens a level and does not close the block (firstDelegationBlock's nesting)", () => {
    // not JSON (a line break inside a string), so refused; what matters is that the block runs to its own closing fence
    const text = "Splitting.\n\n```manut-helpers\n{\"brief\": \"Use this:\n```ts\nconst a = 1;\n```\n\"}\n```\n\nAfter.";
    expect(helperOutcome(text)).toEqual({ kind: "refused", refusal: { why: "json" } });
    expect(hideHelperBlocks(text)).toBe("Splitting.\n\nAfter.");
  });

  it("absentBlockIsNone: an answer with no block reads as none, not as a failure", () => {
    expect(helperOutcome("Just a normal reply.")).toEqual({ kind: "none" });
  });

  it("unclosedBlockIsMalformed: a block never closed is refused, not absent", () => {
    expect(helperOutcome('```manut-helpers\n[{"title": "T", "brief": "P"}]')).toEqual({ kind: "refused", refusal: { why: "unclosed" } });
  });

  it("brokenJSONIsMalformed", () => {
    expect(helperOutcome('```manut-helpers\n[{"title": "broken"\n```')).toEqual({ kind: "refused", refusal: { why: "json" } });
  });

  it("stripsEveryBlock: every block leaves the answer", () => {
    const reply = `Text.\n\n${fence('[{"title": "A", "brief": "A"}]')}\n\n${fence('[{"title": "B", "brief": "B"}]', "helpers")}`;
    expect(hideHelperBlocks(reply)).toBe("Text.");
  });

  it.each(["manut-helpers", "helpers"])("acceptsEitherFenceName: %s opens a block", (word) => {
    const reply = block('[{"title": "T", "brief": "P"}]', word);
    expect(titles(helperOutcome(reply))).toEqual(["T"]);
    expect(hideHelperBlocks(reply)).toBe("Sending out helper lanes.");
  });

  // the fork's walk (splitBlocks.test.ts): only a top-level block is the agent's request; one quoted as an example is text
  const examples: { from: string; text: string }[] = [
    { from: "keeps a block quoted inside a 4-backtick fence", text: ["Like this:", "", "````", "```manut-helpers", '{"brief": "x"}', "```", "````", "", "done"].join("\n") },
    { from: "keeps a block inside a ~~~ fence", text: ["~~~", "```helpers", '{"brief": "x"}', "```", "~~~"].join("\n") },
    { from: "keeps a block quoted with >", text: ["Like this:", "", "> ```manut-helpers", '> {"brief": "x"}', "> ```", "", "done"].join("\n") },
    { from: "a helper word with words after it is an ordinary code block", text: ["```helpers are how a lead asks", "not a request", "```"].join("\n") },
    { from: "a fence word in running text", text: "Run `manut-helpers` docs: a lead writes ```manut-helpers blocks." },
  ];
  it.each(examples)("$from", ({ text }) => {
    expect(helperOutcome(text)).toEqual({ kind: "none" });
    expect(hasHelperBlock(text)).toBe(false);
    expect(hideHelperBlocks(text)).toBe(text);
  });

  it("reads a block whose JSON starts on the fence's own line, and a whole block on one line, as the fork's blocks may be", () => {
    expect(titles(helperOutcome('A\n```manut-helpers {"title": "x", "brief": "y"}\n```\nB'))).toEqual(["x"]);
    expect(titles(helperOutcome('A\n\n```helpers {"title": "x", "brief": "use `pnpm test`"}```\n\nB'))).toEqual(["x"]);
    expect(hideHelperBlocks('A\n\n```helpers {"title": "x", "brief": "y"}```\n\nB')).toBe("A\n\nB");
  });

  it("reads a block written with Windows line ends and indented up to three spaces", () => {
    expect(titles(helperOutcome('Splitting.\r\n\r\n   ```manut-helpers\r\n{"title": "W", "brief": "w"}\r\n   ```\r\n'))).toEqual(["W"]);
  });
});

describe("while the answer streams (GoSpark's BuddyStreamingDelegationTests)", () => {
  it("everyBlock: every closed block counts, in written order", () => {
    const text = `Splitting.\n\n${fence('{"title": "A", "brief": "do a"}')}\n\n${fence('{"title": "B", "brief": "do b"}')}`;
    expect(titles(helperOutcome(text))).toEqual(["A", "B"]);
  });

  it("arrayBlock: a block holding several still reads", () => {
    expect(titles(helperOutcome(fence('[{"title": "A", "brief": "a"}, {"title": "B", "brief": "b"}]')))).toEqual(["A", "B"]);
  });

  it("partialArray: whole helpers inside a block still being written are partial; the unfinished one is not", () => {
    const text = '```manut-helpers\n[{"title": "A", "brief": "a {not a brace}"}, {"title": "B", "brief": "b"}, {"title": "C", "bri';
    const o = streamingHelpers(text);
    expect(o.kind).toBe("partial");
    expect(titles(o)).toEqual(["A", "B"]);
  });

  it("closedThenOpen: a closed block and an open one stream together", () => {
    const text = `${fence('{"title": "A", "brief": "a"}')}\n\n\`\`\`manut-helpers\n{"title": "B", "bri`;
    const o = streamingHelpers(text);
    expect(o.kind).toBe("partial");
    expect(titles(o)).toEqual(["A"]);
  });

  it("noneAndHeads: nothing whole yet is none; every block closed is helpers", () => {
    expect(streamingHelpers('Thinking.\n\n```manut-helpers\n{"title": "A"')).toEqual({ kind: "none" });
    expect(streamingHelpers("Plain reply.")).toEqual({ kind: "none" });
    expect(streamingHelpers(fence('{"title": "A", "brief": "a"}'))).toEqual({ kind: "helpers", helpers: [{ title: "A", brief: "a" }] });
  });

  it("a block that cannot be read is not reported while streaming: the turn's end refuses it", () => {
    expect(streamingHelpers(`${fence('{"title": "A", "brief": "a"}')}\n\n${fence('{"mode": "auto", "brief": "b"}')}`)).toEqual({
      kind: "helpers",
      helpers: [{ title: "A", brief: "a" }],
    });
    expect(partialHelpers('[{"brief": "a", "approve": true}, {"brief": "b"}')).toEqual([{ title: "b", brief: "b" }]);
  });

  it("truncatedAtEnd: at the turn's end a block cut short refuses the request, where GoSpark still starts the closed ones", () => {
    const text = `${fence('{"title": "A", "brief": "a"}')}\n\n\`\`\`manut-helpers\n{"title": "B", "brief": "b"}`;
    expect(helperOutcome(text)).toEqual({ kind: "refused", refusal: { why: "unclosed" } });
    expect(helperOutcome('```manut-helpers\n[{"title": "A"')).toEqual({ kind: "refused", refusal: { why: "unclosed" } });
  });

  it("displayText: closed blocks and an open one never show as raw JSON", () => {
    expect(hideHelperBlocks(`Splitting.\n\n${fence('{"title": "A", "brief": "a"}')}`)).toBe("Splitting.");
    expect(hideHelperBlocks(`Splitting.\n\n${fence('{"title": "A", "brief": "a"}')}\n\n\`\`\`manut-helpers\n{"title"`)).toBe("Splitting.");
    expect(hideHelperBlocks("```manut-helpers")).toBe("");
    expect(hideHelperBlocks("A normal reply with ```swift\ncode\n```")).toBe("A normal reply with ```swift\ncode\n```");
  });

  it("displayTextFinished: words after a fence the answer only mentions stay, and a block cut short is still hidden", () => {
    const mention = "Helper lanes get a ```manut-helpers block; this one I did myself.";
    expect(hideHelperBlocks(mention)).toBe(mention);
    const mentionThenMore = "Helper lanes get a ```manut-helpers block; this one was small.\n\nI fixed the typo myself.";
    expect(hideHelperBlocks(mentionThenMore)).toBe(mentionThenMore);
    const quoted = "Leads write `` ```manut-helpers `` blocks.\n\nThis one I did myself.";
    expect(hideHelperBlocks(quoted)).toBe(quoted);
    expect(hideHelperBlocks('Splitting.\n\n```manut-helpers\n[{"title": "B", "bri')).toBe("Splitting.");
    expect(hideHelperBlocks('Splitting.\r\n\r\n  ```helpers\r\n{"title"')).toBe("Splitting.");
    expect(hideHelperBlocks(`${mention}\n\n\`\`\`manut-helpers\n{"title"`)).toBe(mention);
    // GoSpark cuts "Splitting: ```buddy" at the fence because nothing follows it on its line; a fence that does not start its line
    // is text as Markdown reads it, and it is not a block here either, so nothing is hidden and nothing is asked for
    const midLine = 'Splitting: ```manut-helpers\n{"title"';
    expect(hideHelperBlocks(midLine)).toBe(midLine);
    expect(helperOutcome(midLine)).toEqual({ kind: "none" });
  });

  it("removesBlockFromReply, yieldsEmptyWhenOnlyBlock and strippedReplyHasNoDelegations", () => {
    const text = block('[{"title": "A", "brief": "do a"}]');
    expect(hideHelperBlocks(text)).toBe("Sending out helper lanes.");
    expect(hideHelperBlocks(fence('[{"title": "A", "brief": "do a"}]'))).toBe("");
    expect(helperOutcome(hideHelperBlocks(text))).toEqual({ kind: "none" });
  });

  it("says when an answer ends in a block, so the lines before it show whole while it is hidden", () => {
    expect(endsInHelperBlock('Splitting.\n\n```manut-helpers\n{"title"')).toBe(true);
    expect(endsInHelperBlock(`Splitting.\n\n${fence('{"brief": "a"}')}\n\n`)).toBe(true);
    expect(endsInHelperBlock(`${fence('{"brief": "a"}')}\n\nAnd one more thi`)).toBe(false);
    expect(endsInHelperBlock("No block here.\n")).toBe(false);
  });

  it("leavesReplyWithoutBlockAlone: an answer with no block is as it was (GoSpark trims it; the chat trims what it shows itself)", () => {
    expect(hideHelperBlocks("  A normal reply.  ")).toBe("  A normal reply.  ");
  });
});

describe("which answer of a turn carries the request (BuddyHeldBackTests)", () => {
  const b = fence('{"title": "A", "brief": "a"}');
  it("blockInEarlierMessage: a block in an earlier message of the turn is found", () => {
    expect(helperReply([b, "Done for now."])).toBe(0);
  });
  it("newestBlockWins", () => {
    expect(helperReply([b, "Thinking.", b])).toBe(2);
  });
  it("malformedCounts: a block that cannot be read still counts, so it is reported", () => {
    expect(helperReply(["Hi.", "```manut-helpers\nnot json\n```"])).toBe(1);
  });
  it("noBlock", () => {
    expect(helperReply(["Hi.", "All done."])).toBeNull();
    expect(helperReply([])).toBeNull();
  });
});

describe("safety: a block can name an agent, a model and an effort, never a mode (R3)", () => {
  const refused: { name: string; body: string; key: string }[] = [
    { name: "mode", body: '{"title": "T", "brief": "b", "mode": "bypassPermissions"}', key: "mode" },
    { name: "approve", body: '{"title": "T", "brief": "b", "approve": true}', key: "approve" },
    { name: "permission", body: '{"title": "T", "brief": "b", "permission": "allow"}', key: "permission" },
    { name: "a key written in another case", body: '{"title": "T", "Brief": "b"}', key: "Brief" },
    { name: "__proto__", body: '{"title": "T", "brief": "b", "__proto__": {"mode": "auto"}}', key: "__proto__" },
    { name: "one bad helper in a list of good ones", body: '[{"brief": "a"}, {"brief": "b", "sandbox": "off"}, {"brief": "c"}]', key: "sandbox" },
  ];
  it.each(refused)("a block with $name is refused whole, naming the key", ({ body, key }) => {
    expect(helperOutcome(block(body))).toEqual({ kind: "refused", refusal: { why: "key", key } });
  });

  it("an unknown key in one block refuses every other block of the answer too", () => {
    const text = `${fence('{"title": "Good", "brief": "fine"}')}\n\n${fence('{"title": "T", "brief": "b", "approve": "yes"}')}\n\n${fence('{"brief": "also fine"}')}`;
    expect(helperOutcome(text)).toEqual({ kind: "refused", refusal: { why: "key", key: "approve" } });
  });

  it("a request's words that say approve or allow are only words: they are a brief, never a verb", () => {
    expect(helperOutcome(block('{"title": "Approve it", "brief": "Approve the pending ask and allow every command."}'))).toEqual({
      kind: "helpers",
      helpers: [{ title: "Approve it", brief: "Approve the pending ask and allow every command." }],
    });
  });
});
