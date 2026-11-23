import { describe, expect, it } from "vitest";
import { AGENT_IDS, agentIcon, fileMark } from "./AgentIcon";

describe("agentIcon", () => {
  // Manut AI ships none of the vendors' logos (src/assets/agents was left out of the fork), so a known agent draws
  // the first letter of its own name; the tests of the logo files themselves (colours, ids, titles) went with them.
  it("maps every agent id the app names to a letter mark that carries its own name", () => {
    const want: [string, string][] = [
      ["claude", "Claude Code"], ["codex", "Codex"], ["omh", "OMH"], ["pi", "pi"], ["omp", "omp"],
      ["grok", "Grok"], ["grokbot", "Grok Bot"], ["gemini", "Gemini CLI"], ["opencode", "opencode"],
      ["cursor", "Cursor"], ["amp", "Amp"], ["cline", "Cline"], ["copilot", "GitHub Copilot"], ["goose", "Goose"],
      ["kilo", "Kilo Code"], ["junie", "Junie"], ["qwen", "Qwen Code"], ["windsurf", "Windsurf"], ["trae", "TRAE"],
      ["roo", "Roo Code"], ["openai", "OpenAI"], ["gemini-app", "Gemini"],
    ];
    for (const [id, title] of want) {
      const m = agentIcon(id);
      expect(m, id).toMatchObject({ kind: "letter", id: null, title, letter: title[0].toUpperCase() });
    }
    expect(AGENT_IDS).toHaveLength(22);
    expect(new Set(AGENT_IDS)).toEqual(new Set(want.map(([id]) => id)));
  });

  it("takes the vendors' own spellings and any case", () => {
    expect(agentIcon("claudecode").title).toBe("Claude Code");
    expect(agentIcon("GithubCopilot").title).toBe("GitHub Copilot");
    expect(agentIcon("kilocode").title).toBe("Kilo Code");
    expect(agentIcon("RooCode").title).toBe("Roo Code");
    expect(agentIcon("geminicli").title).toBe("Gemini CLI");
    expect(agentIcon(" Codex ").title).toBe("Codex");
  });

  it("draws no picture and no vendor path for any agent", () => {
    for (const id of AGENT_IDS) expect(agentIcon(id).kind, id).toBe("letter");
    expect(fileMark("claudecode-color.svg", "Claude Code")).toMatchObject({ kind: "letter", letter: "C" });
    expect(fileMark("kimi-code.png", "Kimi Code")).toMatchObject({ kind: "letter", letter: "K" });
  });

  it("an unknown id gets a letter mark", () => {
    const m = agentIcon("zed");
    expect(m).toMatchObject({ kind: "letter", id: null, letter: "Z", title: "zed" });
    expect(agentIcon("").kind).toBe("letter");
    expect(agentIcon(undefined)).toMatchObject({ kind: "letter", letter: "?" });
  });
});
