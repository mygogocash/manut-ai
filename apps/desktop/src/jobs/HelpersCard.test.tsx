// The Start helpers card and the Helpers switch from props alone (item 102e), drawn with react-dom/server as the chat box's parts
// are (src/chat/box/box.test.tsx): every brief whole with its agent, model and effort, Not now before Start helpers, the line each
// settled state collapses to, and the card's rows as helperRows makes them from a request. How they behave in the app is
// e2e/helper-blocks.spec.ts's; what a press does is leadLanes.test.ts's.
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { setLang } from "../i18n";
import type { AgentInfo } from "../sessions/agents";
import { helperRows, resolveAgent, type HelpersAsk } from "./helperAsks";
import { HelpersCardView, refusedWords, rowAgentWords } from "./HelpersCard";
import { HelpersToggle } from "./HelpersSwitch";

afterEach(() => setLang("en"));

const AGENTS: AgentInfo[] = [
  { id: "claude", label: "Claude Code", mode: "chat", path: "/bin/claude" },
  { id: "codex", label: "Codex", mode: "chat", path: "/bin/codex" },
  { id: "opencode", label: "OpenCode", mode: "chat", path: null },
  { id: "omh", label: "oh-my-hermes", mode: "hermes", path: "/bin/omh" },
];
const LEAD = { agent: "claude", models: [{ id: "opus", label: "Opus 5.5" }, { id: "haiku", label: "Haiku 5.5" }], efforts: ["low", "high"] };

const LONG = `${"Read src/qr.ts and every caller of promptPayQR. ".repeat(40)}The last words of the brief.`;
const ask = (over: Partial<HelpersAsk> = {}): HelpersAsk => ({
  id: "helpers-s1-t1",
  lead: "s1",
  leadAgent: "claude",
  turn: "agent:s1-t1",
  rows: helperRows(
    [
      { title: "Tests for the QR builder", brief: LONG, agent: "codex", model: "gpt-6.1", effort: "high" },
      { title: "The receipt's Thai date", brief: "Show the date in the Thai calendar.\n\nCheck with pnpm test." },
    ],
    LEAD,
    AGENTS,
  ).rows,
  heldBack: 0,
  ...over,
});
const draw = (el: ReturnType<typeof createElement>) => renderToString(el).replace(/<!-- -->/g, "");
const text = (html: string) => html.replace(/<[^>]+>/g, "").replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&");

describe("the card's rows (helperRows)", () => {
  it("runs a helper on the lead's agent unless it names another, and says the model it starts on", () => {
    const { rows } = helperRows(
      [
        { title: "a", brief: "a" },
        { title: "b", brief: "b", agent: "Codex", model: "gpt-6.1" },
        { title: "c", brief: "c", agent: "claude", model: "Haiku 5.5", effort: "LOW" },
        { title: "d", brief: "d", agent: "claude", model: "sonnet-9", effort: "max" },
      ],
      LEAD,
      AGENTS,
    );
    expect(rows.map((r) => [r.agent, r.own, r.modelUnlisted ?? false, r.effortUnlisted ?? false])).toEqual([
      ["claude", true, false, false],
      ["codex", false, false, false],
      ["claude", true, false, false],
      ["claude", true, true, true],
    ]);
    expect(rows.map(rowAgentWords)).toEqual([
      "Claude Code · the lead's model",
      "Codex · gpt-6.1",
      "Claude Code · Haiku 5.5 · LOW",
      "Claude Code · the agent's default (Kit asked for sonnet-9, which it does not list) · its usual effort (Kit asked for max, which it does not list)",
    ]);
  });

  it("says when the app already knows a helper will not start: an agent it does not run in a lane, or one not installed", () => {
    expect(resolveAgent("gemini", AGENTS)).toEqual({ id: "gemini", problem: "unknown" });
    expect(resolveAgent("omh", AGENTS)).toEqual({ id: "omh", problem: "unknown" });
    expect(resolveAgent("OpenCode", AGENTS)).toEqual({ id: "opencode", problem: "notInstalled" });
    expect(resolveAgent("Claude Code", AGENTS)).toEqual({ id: "claude" });
    const { rows } = helperRows([{ title: "x", brief: "x", agent: "gemini" }, { title: "y", brief: "y", agent: "opencode", model: "m" }], LEAD, AGENTS);
    expect(rows.map(rowAgentWords)).toEqual(["gemini: not an agent Manut AI runs in a lane, will not start", "OpenCode: not installed, will not start"]);
  });

  it("takes at most a round's eight and counts the rest", () => {
    const r = helperRows(Array.from({ length: 11 }, (_, k) => ({ title: `${k}`, brief: `${k}` })), LEAD, AGENTS);
    expect(r.rows).toHaveLength(8);
    expect(r.heldBack).toBe(3);
  });
});

describe("the card", () => {
  it("shows every brief whole, its agent, model and effort, the budget, and Not now before Start helpers", () => {
    const html = draw(createElement(HelpersCardView, { ask: ask() }));
    const words = text(html);
    expect(words).toContain("Kit asks for 2 helper lanes");
    expect(words).toContain("Helper 1·Codex · gpt-6.1 · high");
    expect(words).toContain("Helper 2·Claude Code · the lead's model");
    expect(words).toContain("Tests for the QR builder");
    // the brief whole: its last words are there, and its lines are kept
    expect(words).toContain("The last words of the brief.");
    expect(words).toContain(LONG);
    expect(words).toContain("Show the date in the Thai calendar.\n\nCheck with pnpm test.");
    expect(words).toContain("Each has up to 20 minutes and 90 steps; time waiting for you does not count.");
    expect(html.indexOf('data-testid="helpers-not-now"')).toBeLessThan(html.indexOf('data-testid="helpers-start"'));
    expect(html).toMatch(/class="card-btn primary"[^>]*data-testid="helpers-start"/);
    expect(html).not.toContain('data-testid="helpers-held"');
  });

  it("masks a key in a brief and marks a character that does not show", () => {
    const rows = helperRows([{ title: "Deploy‮", brief: "Use the key sk-ant-api03-FAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKE0000 to deploy.​" }], LEAD, AGENTS).rows;
    const words = text(draw(createElement(HelpersCardView, { ask: ask({ rows }) })));
    expect(words).not.toContain("FAKEFAKE");
    expect(words).toContain("••••");
    expect(words).toContain("⟨U+202E⟩");
    expect(words).toContain("⟨U+200B⟩");
  });

  it("says how many were left out of a round", () => {
    const words = text(draw(createElement(HelpersCardView, { ask: ask({ heldBack: 3 }) })));
    expect(words).toContain("Kit asked for 5. A round takes at most 8, so the last 3 are left out.");
  });

  it("holds its buttons while a press is on its way, and says why one was not taken", () => {
    const html = draw(createElement(HelpersCardView, { ask: ask(), busy: true, error: refusedWords("already_decided") }));
    expect(html).toMatch(/disabled=""[^>]*data-testid="helpers-not-now"/);
    expect(html).toMatch(/disabled=""[^>]*data-testid="helpers-start"/);
    expect(text(html)).toContain("This was already decided.");
    expect(refusedWords("superseded")).toBe("This is no longer open: Kit's turn moved on.");
    expect(refusedWords("roundsSpent")).toBe("This message has had its 2 rounds of helper lanes.");
    expect(refusedWords("not_found")).toBe("Not taken (not_found).");
  });

  it.each([
    { done: "started" as const, line: "You approved this round. This version does not start helper lanes yet, so none started." },
    { done: "notNow" as const, line: "Not now: no helper lanes started." },
    { done: "gone" as const, line: "No longer open, so no helper lanes started." },
  ])("settled as $done, it is one line with no button", ({ done, line }) => {
    const html = draw(createElement(HelpersCardView, { ask: ask(), done }));
    expect(text(html)).toBe(`${done === "started" ? "✓" : "–"}${line} · Kit asks for 2 helper lanes`);
    expect(html).not.toContain("<button");
  });

  it("reads in the person's language", () => {
    setLang("ja");
    const words = text(draw(createElement(HelpersCardView, { ask: ask() })));
    expect(words).toContain("Kit がヘルパーレーンを 2 つ依頼しています");
    expect(words).toContain("ヘルパーを開始");
    expect(words).toContain("今はしない");
  });
});

describe("the Helpers switch", () => {
  it("is a switch named Helpers, checked when on, with what it does as its tip", () => {
    const off = draw(createElement(HelpersToggle, { on: false, onChange: () => {} }));
    expect(off).toMatch(/role="switch"[^>]*aria-checked="false"[^>]*aria-label="Helpers"/);
    expect(off).toContain("None starts until you press Start helpers on its card.");
    const on = draw(createElement(HelpersToggle, { on: true, onChange: () => {} }));
    expect(on).toMatch(/role="switch"[^>]*aria-checked="true"/);
    expect(on).toContain("bx-helpers on");
  });
});
