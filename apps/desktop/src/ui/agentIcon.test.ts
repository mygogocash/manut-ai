// Each provider by its own logo (the owner's request of 26 Nov 2026, docs/decisions.md): every coding agent the app
// offers, every provider and editor it names, resolves to a mark, its own published logo where Lobe Icons or Simple
// Icons has that product or its maker (src/ui/agentMarks.ts, generated), else its monogram.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AGENT_IDS, AgentIcon, agentIcon, fileMark, monogram, ownIds } from "./AgentIcon";
import { AGENT_MARKS } from "./agentMarks";
import { AGENTS } from "../sessions/agents";
import { EDITOR_IDS } from "../code/editor";

const ACP = JSON.parse(readFileSync(join(__dirname, "..", "sessions", "mockAcpAgents.json"), "utf8")) as { id: string; label: string; mark: string }[];

/** The agent each id draws: the mark's key, or "letter:<L>" for a monogram. */
const drawn = (id: string, title?: string) => {
  const m = agentIcon(id, title);
  return m.kind === "svg" ? m.id : `letter:${m.letter}`;
};

describe("agentIcon", () => {
  it("draws every built-in agent by its own logo, or by its monogram where none is published", () => {
    expect(Object.fromEntries(AGENTS.map((a) => [a.id, drawn(a.id, a.label)]))).toEqual({
      claude: "claude",
      codex: "codex",
      omo: "letter:O",
      dsh: "letter:D",
      omh: "letter:O",
      pi: "pi",
      omp: "letter:O",
      grok: "grok",
      opencode: "opencode",
    });
  });

  it("draws every generic ACP agent the shell offers by its own logo, by its id and by the file its row names", () => {
    expect(ACP.map((a) => a.id)).toEqual(["gemini", "qwen", "kimi", "copilot", "cline", "cursor-agent", "agy"]);
    expect(ACP.map((a) => drawn(a.id, a.label))).toEqual(["gemini", "qwen", "kimi", "copilot", "cline", "cursor", "antigravity"]);
    for (const a of ACP) expect(fileMark(a.mark, a.label), a.id).toMatchObject({ kind: "svg", id: drawn(a.id) });
  });

  it("draws the providers and the editors the app names by their own logos; VS Code has none published, and Xcode, Apple's, is never drawn", () => {
    expect(["deepseek", "zai", "z.ai", "hermes", "openai", "meta", "openrouter"].map((id) => drawn(id))).toEqual(["deepseek", "zai", "zai", "hermes", "openai", "meta", "openrouter"]);
    expect(EDITOR_IDS.map((id) => drawn(id))).toEqual(["letter:V", "cursor", "windsurf", "zed", "letter:X"]);
  });

  it("takes the vendors' own spellings and any case", () => {
    for (const [id, key] of [["claudecode", "claude"], ["Claude-Code", "claude"], ["GithubCopilot", "copilot"], ["geminicli", "gemini"], [" Codex ", "codex"], ["KIMI-CODE", "kimi"], ["roocode", "roo"]])
      expect(drawn(id), id).toBe(key);
  });

  it("an unknown id, a person's own agent or a name with no letter gets a monogram, never another product's logo", () => {
    expect(agentIcon("my-helper")).toMatchObject({ kind: "letter", id: null, letter: "M", title: "my-helper" });
    expect(agentIcon(null, "Reviewer")).toMatchObject({ kind: "letter", letter: "R" });
    expect(agentIcon(undefined)).toMatchObject({ kind: "letter", letter: "?" });
    expect(fileMark("omo.svg", "OmO")).toMatchObject({ kind: "letter", letter: "O" });
    expect(monogram("ไทย")).toBe("ไ");
    expect(monogram("  9lives")).toBe("9");
  });

  it("lists every published mark once, each with its source, and keeps the generated drawings to drawing elements", () => {
    expect(AGENT_IDS).toEqual(Object.keys(AGENT_MARKS));
    for (const [key, art] of Object.entries(AGENT_MARKS)) {
      expect(art.source, key).toMatch(/^(@lobehub\/icons-static-svg|simple-icons) [\d.]+ icons\/[\w-]+\.svg$/);
      expect(art.body, key).not.toMatch(/<title|<script|<image|<foreignObject|\son[a-z]+=|javascript:/i);
      // every id is a placeholder AgentIcon fills, and every reference is to one of them
      for (const [, id] of art.body.matchAll(/\bid="([^"]+)"/g)) expect(id, key).toMatch(/^%u-\d+$/);
      for (const [, id] of art.body.matchAll(/url\(#([^)]+)\)/g)) expect(id, key).toMatch(/^%u-\d+$/);
    }
  });
});

describe("<AgentIcon>", () => {
  const html = (props: Parameters<typeof AgentIcon>[0]) => renderToString(createElement(AgentIcon, props));

  it("draws a logo inline, hidden from a screen reader, in the text colour where its source is monochrome", () => {
    const out = html({ id: "codex", size: 16 });
    expect(out).toMatch(/^<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" fill-rule="evenodd" aria-hidden="true" focusable="false" class="agent-ic" data-agent="codex"/);
    // a colour mark keeps its own colours and its own fill rule per path
    expect(html({ id: "claude" })).toContain('fill="#D97757"');
    expect(html({ id: "claude" })).not.toContain("fill-rule=\"evenodd\" aria-hidden");
  });

  it("gives each drawing of a mark with gradients ids of its own once it is on the page", () => {
    const a = html({ id: "gemini" });
    const ids = [...a.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]);
    expect(ids.length).toBeGreaterThan(0);
    for (const id of ids) {
      expect(id).toMatch(/^ag-gemini-\d+$/);
      expect(a).toContain(`url(#${id})`);
    }
    expect(a).not.toContain("%u");
    // on the page, each copy renumbers its own ids once, and keeps them on a later render
    const body = AGENT_MARKS.gemini.body;
    const one = { dataset: {} as DOMStringMap, innerHTML: "" };
    const two = { dataset: {} as DOMStringMap, innerHTML: "" };
    ownIds(body)(one);
    ownIds(body)(two);
    const first = one.innerHTML;
    ownIds(body)(one);
    expect(one.innerHTML).toBe(first);
    const idsOf = (h: string) => [...h.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]);
    expect(idsOf(one.innerHTML).some((id) => idsOf(two.innerHTML).includes(id))).toBe(false);
  });

  it("draws a monogram as a tile whose letter is the stylesheet's, so it is never part of a row's words", () => {
    const out = html({ id: "omo", title: "OmO", size: 16 });
    expect(out).toBe('<span class="agent-ic agent-mono" data-agent="letter" data-letter="O" aria-hidden="true" style="width:16px;height:16px;font-size:10px;border-radius:4px"></span>');
  });
});
