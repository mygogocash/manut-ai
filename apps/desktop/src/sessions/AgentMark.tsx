// The small mark of each session agent: its own published logo where one is published (Claude Code, Codex, OpenCode,
// Grok, pi, and the ACP agents: Gemini CLI, Qwen Code, Kimi Code, Copilot CLI, Cline, Cursor, Antigravity), else its
// monogram (OmO, DSH, oh-my-hermes, oh-my-pi), drawn by AgentIcon (src/ui/AgentIcon.tsx, the owner's request of 26 Nov
// 2026). A person's own agent (Settings › Agents) always draws its monogram: its id is the person's word, never a claim
// to be another company's product.
import { AgentIcon } from "../ui";
import { acpRow, agentDef, isCustom, type AgentId } from "./agents";

export function AgentMark({ agent, size = 16 }: { agent: AgentId; size?: number }) {
  // a generic ACP agent is named by the row the shell sent; a built-in by its own table entry
  const label = acpRow(agent)?.label ?? agentDef(agent).label;
  return <AgentIcon id={isCustom(agent) ? null : agent} title={label} size={size} className="ag-mark" />;
}
