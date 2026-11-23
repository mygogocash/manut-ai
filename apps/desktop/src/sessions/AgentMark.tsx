// The small mark of each session agent. Oh My Hermes drew each vendor's own logo here (Claude, OpenAI, Grok, pi,
// oh-my-pi, OmO, DeepSeek Harness, OpenCode, and the ACP agents' marks). Manut AI ships no other company's logo, so
// every agent draws the first letter of its name on a quiet tile, the same neutral mark an unknown agent always had.
import { AgentIcon } from "../ui";
import { acpRow, agentDef, type AgentId } from "./agents";

export function AgentMark({ agent, size = 16 }: { agent: AgentId; size?: number }) {
  // a generic ACP agent is named by the row the shell sent; a built-in by its own table entry
  const label = acpRow(agent)?.label ?? agentDef(agent).label;
  return <AgentIcon id={label} file="-" size={size} className="ag-mark" />;
}
