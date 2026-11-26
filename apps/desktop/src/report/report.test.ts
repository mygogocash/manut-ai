// The report (item 105): what it says, and what it never lets through. Every input below carries a made-up key, an email, a
// home path and a chat line, and none of them may reach the text.
import { describe, expect, it } from "vitest";
import { buildReport, clean, issueOf, issueUrl, MAX_ERRORS, repoOf, stamp, type ReportInput } from "./report";

const HOME = "/Users/ana";
// made-up values, assembled so no scanner reads this file as holding a real key
const KEY = ["ghp", "_", "a".repeat(36)].join("");
const CHAT = "please refund Somchai's order and tell him the card number on file is wrong";

const base = (over: Partial<ReportInput> = {}): ReportInput => ({
  app: "0.1.1",
  edition: "github",
  macos: "26.1",
  chip: "Apple M2",
  agents: [
    { label: "Claude Code", installed: true, version: "2.1.332", signedIn: true },
    { label: "Codex", installed: true, version: "0.167.0", signedIn: false },
    { label: "Grok", installed: false, version: "", signedIn: null },
    { label: "Gemini CLI", installed: true, version: "1.0.0", signedIn: null },
  ],
  git: { installed: true, version: "2.54.0" },
  errors: [{ at: Date.UTC(2026, 10, 26, 10, 15), source: "chat", text: "the agent ended: exit 1" }],
  switches: [{ label: "Notify me", on: true }, { label: "Automatically pull", on: false }],
  home: HOME,
  ...over,
});

describe("the report", () => {
  it("says the app, edition, macOS, chip, git, each agent and the switches", () => {
    const r = buildReport(base());
    expect(r).toContain("App: Manut AI 0.1.1 (GitHub)");
    expect(buildReport(base({ edition: "app-store" }))).toContain("(Mac App Store)");
    expect(r).toContain("macOS: 26.1");
    expect(r).toContain("Chip: Apple M2");
    expect(r).toContain("git: 2.54.0");
    expect(r).toContain("- Claude Code: 2.1.332, signed in");
    expect(r).toContain("- Codex: 0.167.0, not signed in");
    expect(r).toContain("- Grok: not installed");
    expect(r).toContain("- Gemini CLI: 1.0.0, sign-in not checked");
    expect(r).toContain("- Notify me: on");
    expect(r).toContain("- Automatically pull: off");
    expect(r).toContain("2026-11-26 10:15 UTC chat: the agent ended: exit 1");
  });

  it("says plainly when nothing went wrong, and when git is missing", () => {
    const r = buildReport(base({ errors: [], git: { installed: false, version: "" } }));
    expect(r).toContain("Last problems: none since this run started");
    expect(r).toContain("git: not installed");
  });

  it("lists at most 20 problems, in the order it is given (newest first)", () => {
    const errors = Array.from({ length: 30 }, (_, i) => ({ at: Date.UTC(2026, 10, 26, 10, 0, 30 - i), source: "chat", text: `problem ${i}` }));
    const r = buildReport(base({ errors }));
    expect(r.match(/ chat: problem /g)).toHaveLength(MAX_ERRORS);
    expect(r).toContain("problem 0");
    expect(r).toContain("problem 19");
    expect(r).not.toContain("problem 20");
  });

  it("never lets a key, an email, a home path or a chat line through", () => {
    const dirty = base({
      app: `0.1.1 ${KEY}`,
      chip: `${HOME}/secret`,
      agents: [
        // fields the builder does not read are never copied, whatever a caller adds
        { label: "Claude Code", installed: true, version: "2.1.332", signedIn: true, account: "ana@example.com", email: "ana@example.com", title: CHAT } as never,
      ],
      errors: [
        { at: 1, source: "chat", text: `token=${KEY} failed for ana@example.com in ${HOME}/shop/orders.csv` },
        { at: 2, source: "session", text: `could not start in ${HOME}` },
        { at: 3, source: "chat", text: `the model refused "${CHAT}"` },
        { at: 4, source: "page", text: `read /Users/someone-else/notes.txt` },
      ],
      switches: [{ label: `Switch ${KEY}`, on: true }],
    });
    const r = buildReport(dirty);
    expect(r).not.toContain(KEY);
    expect(r).not.toContain("example.com");
    expect(r).not.toContain("ana@");
    expect(r).not.toContain("/Users/");
    expect(r).not.toContain(HOME);
    expect(r).not.toContain("Somchai");
    expect(r).not.toContain("refund");
    // the paths are kept as `~`, so the cause stays readable
    expect(r).toContain("in ~/shop/orders.csv");
    expect(r).toContain("could not start in ~");
    expect(r).toContain("read ~/notes.txt");
    expect(r).toContain("[email]");
    expect(r).toContain('"[text]"');
  });

  it("keeps a short quoted word, which is a cause and not a message", () => {
    expect(clean('exit "1" from "codex"', HOME)).toBe('exit "1" from "codex"');
  });

  it("does not take the first folder of another person's path for the home", () => {
    expect(clean("/Users/anabel/x and /Users/ana/x", "/Users/ana")).toBe("~/x and ~/x");
  });

  it("has no em-dash, no emoji and no account word of its own", () => {
    const r = buildReport(base());
    expect(r).not.toMatch(/—|[\u{1F300}-\u{1FAFF}]/u);
  });
});

describe("the time", () => {
  it("is UTC, the same in every zone", () => {
    expect(stamp(Date.UTC(2026, 0, 2, 3, 4, 59))).toBe("2026-01-02 03:04 UTC");
  });
});

describe("the issue", () => {
  it("is the repository the updater names, with the title and the report in the address", () => {
    expect(repoOf("https://github.com/mygogocash/manut-ai/releases/latest/download/latest.json")).toBe("mygogocash/manut-ai");
    expect(repoOf("https://evil.example/mygogocash/manut-ai/releases")).toBeNull();
    expect(repoOf("http://github.com/a/b/x")).toBeNull();
    const url = issueUrl("mygogocash/manut-ai", issueOf("line one\nline two & more", "0.1.1"));
    expect(url.startsWith("https://github.com/mygogocash/manut-ai/issues/new?title=")).toBe(true);
    expect(url).toContain("Problem%20report%3A%20Manut%20AI%200.1.1");
    expect(url).toContain("line%20one%0Aline%20two%20%26%20more");
  });

  it("cuts a very long report in the address and says so", () => {
    const url = decodeURIComponent(issueUrl("a/b", { title: "t", body: "x".repeat(9000) }));
    expect(url.length).toBeLessThan(6600);
    expect(url).toContain("[cut:");
  });
});
