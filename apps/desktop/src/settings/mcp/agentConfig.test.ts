// What Settings › MCP and Skills keeps from the shell's answer and from a chat's report: names, sources and a few fixed words,
// never anything else the answer might carry.
import { afterEach, describe, expect, it } from "vitest";
import { forgetMcpSeen, mcpSeen, noteMcpSeen, readAgentConfig } from "./agentConfig";

const SECRET = "sk-SECRET-never-on-the-page";

afterEach(() => forgetMcpSeen());

describe("the shell's list of servers and skills", () => {
  it("keeps a name, where it comes from and its state, and drops every other field", () => {
    const raw = [
      {
        agent: "claude",
        found: true,
        servers: [
          { name: "github", from: "home", state: "on", url: `https://x.example/?key=${SECRET}`, headers: { Authorization: SECRET } },
          { name: "helper-db", from: "plugin", plugin: "helper", state: "on", env: { K: SECRET } },
          { name: "waiting", from: "project", state: "ask", command: SECRET },
        ],
        skills: [{ name: "promptpay", from: "home", state: "on", path: `/Users/me/${SECRET}` }],
        token: SECRET,
      },
    ];
    const got = readAgentConfig(raw);
    expect(got).toEqual([
      {
        agent: "claude",
        found: true,
        servers: [
          { name: "github", from: "home", state: "on" },
          { name: "helper-db", from: "plugin", plugin: "helper", state: "on" },
          { name: "waiting", from: "project", state: "ask" },
        ],
        skills: [{ name: "promptpay", from: "home", state: "on" }],
      },
    ]);
    expect(JSON.stringify(got)).not.toContain(SECRET);
  });

  it("leaves out what is not one: another agent, an unknown source or state, a name that is not one line", () => {
    const got = readAgentConfig([
      { agent: "gemini", found: true, servers: [], skills: [] },
      { agent: "codex", found: "yes", servers: [{ name: "a", from: "elsewhere", state: "on" }, { name: "b", from: "home", state: "maybe" }, { name: "\u0007", from: "home", state: "on" }, { name: `c\n${"x".repeat(100)}`, from: "home", state: "off" }, null], skills: "none" },
    ]);
    expect(got).toEqual([{ agent: "codex", found: false, servers: [{ name: `c${"x".repeat(79)}`, from: "home", state: "off" }], skills: [] }]);
    expect(readAgentConfig(null)).toEqual([]);
    expect(readAgentConfig({ agent: "claude" })).toEqual([]);
  });
});

describe("what a chat said of its servers", () => {
  it("keeps each name with one of the status words, and the newest report replaces the last", () => {
    expect(mcpSeen("claude")).toBeUndefined();
    noteMcpSeen("claude", [{ name: "github", status: "connected", url: SECRET }, { name: "docs", status: "needs_auth" }, { name: "odd", status: SECRET }, { name: "" }, "x"]);
    expect([...(mcpSeen("claude") ?? [])]).toEqual([
      ["github", "connected"],
      ["docs", "needs_auth"],
      ["odd", "other"],
    ]);
    noteMcpSeen("claude", [{ name: "github", status: "failed" }]);
    expect([...(mcpSeen("claude") ?? [])]).toEqual([["github", "failed"]]);
    // nothing for an unnamed agent or a report that is not a list
    noteMcpSeen("", [{ name: "x", status: "connected" }]);
    noteMcpSeen("codex", { name: "x" });
    expect(mcpSeen("codex")).toBeUndefined();
  });
});
