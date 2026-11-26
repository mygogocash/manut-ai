// Settings › MCP and Skills, drawn with react-dom/server: each agent's servers and skills by name with where each comes from,
// what a chat said of a server, plugin skills counted per plugin, what changes them, the page in a browser, and every language.
import { afterEach, describe, expect, it } from "vitest";
import { renderToString } from "react-dom/server";
import { LANGS, setLang, t } from "../../i18n";
import { readAgentConfig, type AgentConfig, type SeenStatus } from "./agentConfig";
import { McpSkillsView, type McpSkillsViewProps } from "./McpSkillsPage";

const words = (html: string) => html.replace(/<[^>]*>/g, " ").replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, " ").trim();
const noop = () => {};
const SECRET = "sk-SECRET-never-on-the-page";

const LIST: AgentConfig[] = [
  {
    agent: "claude",
    found: true,
    servers: [
      { name: "github", from: "home", state: "on" },
      { name: "local-db", from: "local", state: "on" },
      { name: "waiting", from: "project", state: "ask" },
      { name: "helper-db", from: "plugin", plugin: "helper", state: "on" },
    ],
    skills: [
      { name: "promptpay-qr", from: "home", state: "on" },
      { name: "shop-copy", from: "project", state: "on" },
      ...Array.from({ length: 10 }, (_, i) => ({ name: `helping-${i}`, from: "plugin" as const, plugin: "helper", state: "on" as const })),
    ],
  },
  { agent: "codex", found: true, servers: [{ name: "old", from: "home", state: "off" }], skills: [] },
];

function draw(over: Partial<McpSkillsViewProps> = {}) {
  return renderToString(<McpSkillsView list={LIST} project="" seen={{}} labels={{ claude: "Claude Code", codex: "Codex" }} onChoose={noop} onClear={noop} {...over} />);
}

afterEach(() => setLang("en"));

describe("Settings › MCP and Skills", () => {
  it("lists each agent's servers and skills by name with where each comes from and its state", () => {
    setLang("en");
    const text = words(draw());
    for (const s of ["github", "local-db", "waiting", "helper-db", "promptpay-qr", "shop-copy", "old"]) expect(text).toContain(s);
    for (const k of ["set.mcp", "mcp.intro", "mcp.from.home", "mcp.from.local", "mcp.from.project", "mcp.state.ask", "mcp.state.off", "mcp.servers", "mcp.skills", "mcp.others"] as const) expect(text, k).toContain(t(k));
    expect(text).toContain("From plugin helper");
    // plugin skills are one row per plugin: how many, and the first names
    expect(text).toContain("10 skills from plugin helper");
    expect(text).toContain("helping-0, helping-1");
    expect(text).not.toContain("helping-9");
    // Codex has no skills: it says so
    expect(text).toContain(t("mcp.none"));
    // each agent's own commands are what change these
    expect(text).toContain("claude mcp add");
    expect(text).toContain("codex mcp remove");
    expect(text).toContain("~/.agents/skills");
  });

  it("shows what the last chat said of a server that is on, and a server only a chat named", () => {
    setLang("en");
    const seen = new Map<string, SeenStatus>([
      ["github", "connected"],
      ["waiting", "connected"],
      ["claude_ai_Gmail", "needs_auth"],
    ]);
    const html = draw({ seen: { claude: seen } });
    expect(words(html)).toContain(t("mcp.seen.connected"));
    // a server that waits for a yes still says so, whatever a chat said
    expect(html).toMatch(/data-testid="mcp-state-claude-waiting"[^>]*>Waits for your yes/);
    expect(words(html)).toContain("claude_ai_Gmail");
    expect(words(html)).toContain(t("mcp.from.seen"));
    expect(words(html)).toContain(t("mcp.seen.needs_auth"));
  });

  it("says where else the settings reach: lanes, added accounts, ACP agents, and that tools still ask", () => {
    setLang("en");
    const text = words(draw());
    for (const k of ["mcp.where", "mcp.where.lanes", "mcp.where.codex", "mcp.where.claude", "mcp.where.other", "mcp.where.acp", "mcp.where.asks"] as const) expect(text, k).toContain(t(k));
  });

  it("says a missing agent is not on this computer, and in a browser that there is nothing to read", () => {
    setLang("en");
    expect(words(draw({ list: [{ agent: "codex", found: false, servers: [], skills: [] }] }))).toContain("Codex is not on this computer.");
    const browser = draw({ list: null });
    expect(words(browser)).toContain(t("mcp.browser"));
    expect(browser).not.toContain("mcp-project-choose");
    expect(words(draw({ list: "loading" }))).toContain(t("mcp.loading"));
    expect(words(draw({ list: { error: "no home folder" } }))).toContain("Could not read the list: no home folder");
  });

  it("shows the chosen project with a way back to none", () => {
    setLang("en");
    expect(words(draw())).toContain(t("mcp.project.none"));
    const chosen = draw({ project: "/Users/fon/web-app" });
    expect(words(chosen)).toContain("/Users/fon/web-app");
    expect(chosen).toContain("mcp-project-clear");
  });

  it("never draws anything but names, whatever the shell's answer carried", () => {
    setLang("en");
    const raw = [{ agent: "claude", found: true, servers: [{ name: "github", from: "home", state: "on", url: `https://x/?k=${SECRET}`, env: { T: SECRET } }], skills: [] }];
    expect(draw({ list: readAgentConfig(raw) })).not.toContain(SECRET);
  });

  it("is written in every language", () => {
    for (const l of LANGS) {
      setLang(l);
      const text = words(draw({ list: [...LIST, { agent: "codex", found: false, servers: [], skills: [] }] }));
      for (const k of ["set.mcp", "mcp.intro", "mcp.where.claude", "mcp.state.ask"] as const) expect(text, `${l} ${k}`).toContain(words(t(k)));
      expect(text, l).toContain(words(t("mcp.pluginSkills", { n: 10, plugin: "helper" })));
    }
  });
});
