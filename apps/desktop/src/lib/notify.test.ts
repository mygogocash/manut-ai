import { afterEach, describe, expect, it, vi } from "vitest";
import { createNoteGate, HOLD_MS, noteFor, sessionNote, sessionRings, spoken } from "./notify";
import type { BridgeEvent } from "./protocol";

const ctx = (errors?: boolean) => ({ name: (b: string) => (b === "kami" ? "Kami" : b), watching: () => false, errors });
const ev = (e: Record<string, unknown>) => ({ bot: "kami", ...e }) as unknown as BridgeEvent;

describe("spoken: what the bot said, as a notification says it", () => {
  it.each([
    ["first sentence only", "Fixed the 502s. Then I ran the tests. All green.", "Fixed the 502s."],
    ["a greeting takes the next sentence", "Done! The 502s came from keep-alive. I raised the timeout.", "Done! The 502s came from keep-alive."],
    ["Korean greeting with an honorific", "네, 선생님! 배포를 마쳤어요. 확인해 주세요.", "네, 선생님! 배포를 마쳤어요."],
    ["three sentences at most", "Hi. Ok. Yes. Sure. The real news.", "Hi. Ok. Yes."],
    ["Korean sentence end", "빌드가 깨졌어요. 원인은 캐시예요.", "빌드가 깨졌어요."],
    ["Japanese sentence end", "テストが通りました。次はデプロイです。", "テストが通りました。"],
    ["Chinese full-width marks", "好的！我已经修好了这个错误。还有一个问题？", "好的！我已经修好了这个错误。"],
    ["a new line is a new sentence", "Fixed it\nsecond line", "Fixed it"],
    ["a code block goes", "```ts\nconst a = 1;\n```\nThe fix is in.", "The fix is in."],
    ["a table and a heading go", "## Summary\n| a | b |\n|---|---|\nAll three pass.", "All three pass."],
    ["markdown marks and bullets go", "- **Fixed** the `502s` in _gateway_.", "Fixed the 502s in gateway."],
    ["an aside in brackets goes", "Pushed the branch (after a rebase). Done.", "Pushed the branch."],
    ["a path keeps its last name", "I changed /a/b/c.ts for you.", "I changed c.ts for you."],
    ["a URL keeps its host", "Opened https://x.y/z?q for review.", "Opened x.y for review."],
    ["a markdown link keeps its words", "See [the PR](https://github.com/o/r/pull/1) now.", "See the PR now."],
  ])("%s", (_, input, want) => {
    expect(spoken(input)).toBe(want);
  });
  it("140 characters at most, ending in …", () => {
    const out = spoken(`${"word ".repeat(60)}end.`);
    expect(out.length).toBe(140);
    expect(out.endsWith("…")).toBe(true);
  });
});

describe("noteFor: only what needs the person", () => {
  it("a turn that ends with an error marks its chat only, unless Also notify on errors is on", () => {
    const err = ev({ event: "turn.end", outcome: "error", error: "provider 500" });
    expect(noteFor(err, ctx())).toBeNull();
    expect(noteFor(err, ctx(false))).toBeNull();
    expect(noteFor(err, ctx(true))).toMatchObject({ title: "Kami stopped with an error", body: "provider 500" });
  });
  it("the answer's body is its spoken first sentence; the title has no status marks", () => {
    const n = noteFor(ev({ event: "message", id: "m", text: "Done! I fixed `/w/gateway/src/pool.rs`. Next I ran the suite." }), ctx());
    expect(n).toMatchObject({ title: "Kami", body: "Done! I fixed pool.rs." });
  });
  it("an approval keeps its command, with paths and URLs shortened", () => {
    const n = noteFor(ev({ event: "approval.request", request_id: "a", title: "Run", command: "curl https://api.example.com/v1/x -o /tmp/a/b/out.json", choices: [] }), ctx());
    expect(n).toMatchObject({ title: "Kami needs your approval", body: "curl api.example.com -o out.json" });
  });
  it("an approval's key never reaches Notification Centre, and a masked body is never the action Approve would allow (item 117)", () => {
    const n = noteFor(ev({ event: "approval.request", request_id: "a", title: "Run", command: "API_KEY=abc123 pnpm deploy", choices: ["once", "deny"], kind: "reply" }), ctx());
    // (a body drops markdown's marks, `_` among them, as every notification's does)
    expect(n).toMatchObject({ body: "APIKEY=•••• pnpm deploy", ask: { action: "API_KEY=abc123 pnpm deploy" } });
    expect(JSON.stringify(n?.body)).not.toContain("abc123");
    // notify-rules offers Approve only when the body is the action word for word, which a masked body is not
    expect(n?.body).not.toBe(n?.ask?.action);
  });
  it("an approval from one of several shops says whose it is, and offers no Approve where the person's role may not decide", () => {
    const shop = { id: "pilot:b", name: "Ran Pa Noi", owner: "Noi", role: "helper" as const };
    const reply = noteFor(ev({ event: "approval.request", request_id: "pilot%3Ab/r@1", title: "", command: "Send on LINE: “Hi”", choices: ["once", "deny"], kind: "reply", shop }), ctx());
    expect(reply).toMatchObject({ title: "Kami at Ran Pa Noi needs your approval", ask: { canApprove: true } });
    const money = noteFor(ev({ event: "approval.request", request_id: "pilot%3Ab/m@1", title: "", command: "Refund ฿120", choices: [], kind: "money", shop, pass_on: true }), ctx());
    expect(money).toMatchObject({ title: "Kami at Ran Pa Noi needs your approval", ask: { canApprove: false } });
  });
});

describe("noteFor: a request that says its own short line", () => {
  const LONG = "Already sent: this month went to the sheet on 3 November (41 rows) and Google confirmed it.\n\nAdd the books for October 2026 to the Google Sheet “Manut AI books: Baan Mali”, tab “Books”.\n41 rows, after the header row.\nSales ฿12,300 (30)";
  it("says the brief as its body, and keeps the whole text as the action the card shows, which the body is not", () => {
    const n = noteFor(ev({ event: "approval.request", request_id: "pilot%3Aa/r@1", title: "Ton asks to add the books", command: LONG, whole: true, brief: "Ton asks to add the books for October 2026 to Google Sheets", choices: ["once", "deny"], kind: "command" }), ctx());
    expect(n).toMatchObject({ body: "Ton asks to add the books for October 2026 to Google Sheets", ask: { approval: "command", action: LONG } });
    // the body is not the whole text, so notify-rules offers no Approve even were the kind one a notification may approve
    expect(n?.body).not.toBe(n?.ask?.action);
  });
  it("says the command, cut as before, when it has no brief", () => {
    const n = noteFor(ev({ event: "approval.request", request_id: "a@1", title: "", command: LONG, choices: [], kind: "command" }), ctx());
    expect(n?.body.startsWith("Already sent: this month went to the sheet on 3 November")).toBe(true);
    expect(n?.body.endsWith("…")).toBe(true);
  });
});

describe("noteFor: what notify-rules needs to know of a request", () => {
  const approval = (over: Record<string, unknown> = {}) => ev({ event: "approval.request", request_id: "req-5@1", title: "Refund", command: "Send on LINE: “Thanks!”", choices: ["once", "deny"], kind: "reply", ...over });
  it("carries the ask's id, its approval-core kind, who asks and how many wait, and says whether the card offers Allow once", () => {
    expect(noteFor(approval(), { ...ctx(), waiting: () => 3 })?.ask).toEqual({ id: "req-5@1", approval: "reply", member: "Kami", canApprove: true, action: "Send on LINE: “Thanks!”", waiting: 3 });
    // the exact action is the command as the card shows it, never the body cut or shortened for the notification
    const long = noteFor(approval({ command: `Send on LINE: “See https://baanmali.shop/track?o=7 ${"and thanks ".repeat(20)}”` }), ctx());
    expect(long?.ask?.action).toBe(`Send on LINE: “See https://baanmali.shop/track?o=7 ${"and thanks ".repeat(20)}”`);
    expect(long?.body).not.toBe(long?.ask?.action);
    // the member is the bot's name as the app shows it
    expect(noteFor(approval(), { ...ctx(), name: () => "Nam" })?.ask?.member).toBe("Nam");
  });
  it("has no kind for an ask that has none, and no answer to approve for an ask the card cannot answer", () => {
    expect(noteFor(approval({ kind: undefined }), ctx())?.ask).toMatchObject({ approval: "", canApprove: true });
    expect(noteFor(approval({ choices: [], outdated: true }), ctx())?.ask).toMatchObject({ canApprove: false });
    expect(noteFor(approval({ choices: ["deny"] }), ctx())?.ask).toMatchObject({ canApprove: false });
  });
  it("still notifies, and cannot be approved, when an ask arrives with no list of choices", () => {
    const n = noteFor(approval({ choices: undefined }), ctx());
    expect(n).toMatchObject({ body: "Send on LINE: “Thanks!”", ask: { canApprove: false } });
  });
  it("is a request too for a question, which nothing can approve", () => {
    const n = noteFor(ev({ event: "clarify.request", request_id: "q1", question: "Which branch should I deploy?" }), ctx());
    expect(n?.ask).toEqual({ id: "q1", approval: "", member: "Kami", canApprove: false, waiting: 1 });
  });
  it("is news, with no ask, for everything else: an answer, an error, an automation's answer", () => {
    expect(noteFor(ev({ event: "message", id: "m", text: "Done!" }), ctx())).not.toHaveProperty("ask");
    expect(noteFor(ev({ event: "turn.end", outcome: "error", error: "x" }), ctx(true))).not.toHaveProperty("ask");
    expect(noteFor(ev({ event: "message", id: "m", text: "Hit", watch: { name: "deploys", ts: 1 } }), ctx())).not.toHaveProperty("ask");
  });
});

describe("sessionRings: a program end notifies only when it went wrong", () => {
  const name = "web-app · Claude Code";
  it("exit 0 after a real run only marks the row; exit 1 notifies", () => {
    expect(sessionRings({ kind: "ended", name, code: 0, ms: 60_000 })).toBe(false);
    expect(sessionRings({ kind: "ended", name, code: 1, ms: 60_000 })).toBe(true);
    expect(sessionRings({ kind: "ended", name, code: null, error: "Claude Code is not signed in.", ms: 60_000 })).toBe(true);
  });
  it("an end within the first 5 s could not run: it notifies", () => {
    expect(sessionRings({ kind: "ended", name, code: 0, ms: 1200 })).toBe(true);
  });
  it("a start that failed and a ring always notify", () => {
    expect(sessionRings({ kind: "failed", name, error: "" })).toBe(true);
    // an agent's bell is it waiting for the person; a plain shell's bell (tab completion, a stray \\a) only marks the row
    expect(sessionRings({ kind: "bell", name, agent: true })).toBe(true);
    expect(sessionRings({ kind: "bell", name, agent: false })).toBe(false);
    expect(sessionRings({ kind: "bell", name })).toBe(false);
  });
  it("an agent's reason reads as spoken", () => {
    expect(sessionNote("s1", { kind: "ended", name, code: 1, error: "Could not read /home/you/.config/app/auth.json (missing). Sign in again." }).body).toBe(
      "Could not read auth.json.",
    );
  });
});

describe("createNoteGate: a ring with no words waits for the question", () => {
  afterEach(() => vi.useRealTimers());
  it("an empty ring then a texted question within 8 s: one notification, the texted one", () => {
    vi.useFakeTimers();
    const gate = createNoteGate();
    const shown: string[] = [];
    gate.offer("kami", "empty", () => shown.push("ring"));
    vi.advanceTimersByTime(3000);
    gate.offer("kami", "ask", () => shown.push("Which branch?"));
    vi.advanceTimersByTime(HOLD_MS * 2);
    expect(shown).toEqual(["Which branch?"]);
  });
  it("an empty ring with nothing after it fires after 8 s, not before", () => {
    vi.useFakeTimers();
    const gate = createNoteGate();
    const shown: string[] = [];
    gate.offer("kami", "empty", () => shown.push("ring"));
    vi.advanceTimersByTime(HOLD_MS - 1);
    expect(shown).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(shown).toEqual(["ring"]);
  });
  it("another chat's question does not take its place; an answer goes out as is", () => {
    vi.useFakeTimers();
    const gate = createNoteGate();
    const shown: string[] = [];
    gate.offer("kami", "empty", () => shown.push("kami ring"));
    gate.offer("friren", "ask", () => shown.push("friren asks"));
    gate.offer("kami", "plain", () => shown.push("kami answer"));
    vi.advanceTimersByTime(HOLD_MS);
    expect(shown).toEqual(["friren asks", "kami answer", "kami ring"]);
  });
  it("a clarify with no text is held (its note still names the chat)", () => {
    const n = noteFor(ev({ event: "clarify.request", request_id: "c", question: "  " }), ctx());
    expect(n).toMatchObject({ title: "Kami has a question", body: "It is waiting for you." });
  });
});
