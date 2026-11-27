// Settings › MCP and Skills (item 72): the MCP servers and skills Claude Code and Codex have on this computer, by name and
// where each comes from (the person's own home, this project, a plugin), with whether a server connected when a running chat
// said so. The shell reads them from each agent's own files and sends names only (src-tauri/src/agent_config.rs); this page
// changes nothing and says which command changes what. Below the lists, where else the same settings reach: lanes, added
// accounts and the ACP agents (docs/code-editor.md, "MCP servers and skills").
//
// Install skills from a link (item 84) sits below the lists, behind Settings › Artifacts › Allow sharing skills by link
// (InstallSkills.tsx).
//
// `McpSkillsView` draws a given state so a test can draw each one; `McpSkillsPage` asks the shell and keeps the project.
import { useEffect, useState, type ReactNode } from "react";
import { t, type Key } from "../../i18n";
import { getHost } from "../../sessions/host";
import { agentLabel } from "../../sessions/agents";
import { Row } from "../DevRow";
import { mcpSeen, useMcpSeenVersion, type AgentConfig, type ConfigItem, type SeenStatus } from "./agentConfig";
import { InstallSkills } from "./InstallSkills";
import { OtherPrograms } from "./OtherPrograms";

type AgentKey = AgentConfig["agent"];

/** The agent's own commands for adding and removing a server, and the folder its own skills are in. */
const CHANGE: Record<AgentKey, { add: string; remove: string; skills: string }> = {
  claude: { add: "claude mcp add", remove: "claude mcp remove", skills: "~/.claude/skills" },
  codex: { add: "codex mcp add", remove: "codex mcp remove", skills: "~/.agents/skills" },
};

/** The most skill names a plugin's row lists before it says how many more. */
const PLUGIN_NAMES = 8;

export type McpList = AgentConfig[] | null | "loading" | { error: string };

export interface McpSkillsViewProps {
  /** The shell's answer; null where it cannot read (a browser). */
  list: McpList;
  /** The project folder chosen, or "". */
  project: string;
  /** What each agent's last chat said of its servers. */
  seen: Partial<Record<AgentKey, ReadonlyMap<string, SeenStatus>>>;
  labels: Record<AgentKey, string>;
  onChoose: () => void;
  onClear: () => void;
  /** Install skills from a link, drawn below the lists (absent in a test that draws the lists alone) */
  install?: ReactNode;
  /** Other programs (item 103), drawn above "where else these reach" whatever the lists say (absent in a test of the lists) */
  others?: ReactNode;
}

function fromWords(i: { from: ConfigItem["from"] | "seen"; plugin?: string }): string {
  return i.from === "plugin" ? t("mcp.from.plugin", { plugin: i.plugin ?? "" }) : t(`mcp.from.${i.from}` as Key);
}

/** A server's state in words: what the last chat said when it named this server and it is on, else what its files say. */
function stateWords(state: ConfigItem["state"], seen: SeenStatus | undefined): string {
  if (state === "on" && seen) return t(`mcp.seen.${seen}` as Key);
  return t(`mcp.state.${state}` as Key);
}

function Servers({ a, seen }: { a: AgentConfig; seen: ReadonlyMap<string, SeenStatus> | undefined }) {
  const named = new Set(a.servers.map((s) => s.name));
  // servers a chat connected that no file here names (Claude Code's claude.ai connectors, a server from --mcp-config)
  const extra = [...(seen ?? new Map<string, SeenStatus>()).entries()].filter(([n]) => !named.has(n));
  if (!a.servers.length && !extra.length) return <div className="st-note">{t("mcp.none")}</div>;
  return (
    <div className="st-grp" data-testid={`mcp-servers-${a.agent}`}>
      {a.servers.map((s) => (
        <Row key={`${s.from}:${s.plugin ?? ""}:${s.name}`} title={s.name} hint={fromWords(s)}>
          <span className="st-val" data-testid={`mcp-state-${a.agent}-${s.name}`}>
            {stateWords(s.state, seen?.get(s.name))}
          </span>
        </Row>
      ))}
      {extra.map(([n, st]) => (
        <Row key={`seen:${n}`} title={n} hint={fromWords({ from: "seen" })}>
          <span className="st-val">{t(`mcp.seen.${st}` as Key)}</span>
        </Row>
      ))}
    </div>
  );
}

function Skills({ a }: { a: AgentConfig }) {
  const own = a.skills.filter((s) => s.from !== "plugin");
  const plugins = new Map<string, string[]>();
  for (const s of a.skills.filter((s) => s.from === "plugin")) plugins.set(s.plugin ?? "", [...(plugins.get(s.plugin ?? "") ?? []), s.name]);
  if (!own.length && !plugins.size) return <div className="st-note">{t("mcp.none")}</div>;
  return (
    <div className="st-grp" data-testid={`mcp-skills-${a.agent}`}>
      {own.map((s) => (
        <Row key={`${s.from}:${s.name}`} title={s.name} hint={fromWords(s)} />
      ))}
      {[...plugins.entries()].map(([plugin, names]) => (
        <Row
          key={`plugin:${plugin}`}
          title={t("mcp.pluginSkills", { n: names.length, plugin })}
          hint={names.length > PLUGIN_NAMES ? `${names.slice(0, PLUGIN_NAMES).join(", ")}, …` : names.join(", ")}
        />
      ))}
    </div>
  );
}

function Agent({ a, label, seen }: { a: AgentConfig; label: string; seen: ReadonlyMap<string, SeenStatus> | undefined }) {
  return (
    <section data-testid={`mcp-agent-${a.agent}`}>
      <div className="st-gh">{label}</div>
      {!a.found ? (
        <div className="st-note">{t("mcp.notFound", { agent: label })}</div>
      ) : (
        <>
          <div className="st-note">{t("mcp.servers")}</div>
          <Servers a={a} seen={seen} />
          <div className="st-note">{t("mcp.skills")}</div>
          <Skills a={a} />
          <div className="st-note">{t("mcp.change", CHANGE[a.agent])}</div>
        </>
      )}
    </section>
  );
}

export function McpSkillsView(p: McpSkillsViewProps) {
  const { list } = p;
  return (
    <div className="st-page" data-testid="mcp-page">
      <div className="st-gh st-gh0">{t("set.mcp")}</div>
      <div className="st-note">{t("mcp.intro")}</div>
      {list === null ? (
        <div className="st-note" data-testid="mcp-browser">
          {t("mcp.browser")}
        </div>
      ) : (
        <>
          <div className="st-grp">
            <Row title={t("mcp.project.title")} hint={t("mcp.project.hint")}>
              <span className="st-pair">
                <span className="st-val mono" data-testid="mcp-project">
                  {p.project || t("mcp.project.none")}
                </span>
                <button type="button" className="st-btn" onClick={p.onChoose} data-testid="mcp-project-choose">
                  {t("mcp.project.choose")}
                </button>
                {p.project && (
                  <button type="button" className="st-btn" onClick={p.onClear} data-testid="mcp-project-clear">
                    {t("mcp.project.clear")}
                  </button>
                )}
              </span>
            </Row>
          </div>
          {list === "loading" ? (
            <div className="st-note">{t("mcp.loading")}</div>
          ) : !Array.isArray(list) ? (
            <div className="st-note">{t("mcp.failed", { why: list.error })}</div>
          ) : (
            list.map((a) => <Agent key={a.agent} a={a} label={p.labels[a.agent]} seen={p.seen[a.agent]} />)
          )}
          <div className="st-note">{t("mcp.others")}</div>
          {p.install}
        </>
      )}
      {p.others}
      <div className="st-gh">{t("mcp.where")}</div>
      {(["mcp.where.lanes", "mcp.where.codex", "mcp.where.claude", "mcp.where.other", "mcp.where.acp", "mcp.where.asks"] as const).map((k) => (
        <div key={k} className="st-note">
          {t(k)}
        </div>
      ))}
    </div>
  );
}

export function McpSkillsPage() {
  const [project, setProject] = useState("");
  const [list, setList] = useState<McpList>("loading");
  useMcpSeenVersion();

  useEffect(() => {
    let live = true;
    const host = getHost();
    if (!host.agentConfig) {
      setList(null);
      return;
    }
    setList("loading");
    host
      .agentConfig(project || undefined)
      .then((l) => live && setList(l))
      .catch((e: unknown) => live && setList({ error: e instanceof Error ? e.message : String(e) }));
    return () => {
      live = false;
    };
  }, [project]);

  const choose = async () => {
    const picked = await getHost()
      .pickFolder(project || "")
      .catch(() => null);
    if (picked) setProject(picked);
  };

  return (
    <McpSkillsView
      list={list}
      project={project}
      seen={{ claude: mcpSeen("claude"), codex: mcpSeen("codex") }}
      labels={{ claude: agentLabel("claude", null), codex: agentLabel("codex", null) }}
      onChoose={() => void choose()}
      onClear={() => setProject("")}
      install={<InstallSkills />}
      others={<OtherPrograms />}
    />
  );
}
