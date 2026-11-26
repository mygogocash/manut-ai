// Every agent's, provider's and editor's mark at the session header's size (22px) and a row's (16px), on the app's own
// theme tokens: each published logo (src/ui/agentMarks.ts), then the monograms of the agents with none published.
import { createRoot } from "react-dom/client";
import "../src/theme/tokens.css";
import "../src/theme/base.css";
import "../src/ui/ui.css";
import { AGENT_IDS, AgentIcon, agentIcon } from "../src/ui/AgentIcon";

const theme = new URLSearchParams(location.search).get("theme") === "light" ? "light" : "dark";
document.documentElement.dataset.theme = theme;

/** The agents and the editor the app offers with no published mark, by the names the app shows. */
export const MONOGRAMS: [string, string][] = [["omo", "OmO"], ["dsh", "DSH"], ["omh", "oh-my-hermes"], ["omp", "oh-my-pi"], ["vscode", "Visual Studio Code"]];

function Grid() {
  return (
    <div style={{ padding: 24, background: "var(--bg)", color: "var(--ink)", minHeight: "100%" }}>
      <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 14 }}>Agent marks · {theme}</div>
      <div data-testid="agent-grid" style={{ display: "grid", gridTemplateColumns: "repeat(6, 132px)", gap: 8 }}>
        {[...AGENT_IDS.map((id) => [id, undefined] as [string, string | undefined]), ...MONOGRAMS].map(([id, title]) => (
          <div key={id} data-testid={`agent-cell-${id}`}
            style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 10px", borderRadius: 6, background: "var(--raise)" }}>
            <AgentIcon id={id} title={title} size={22} />
            <AgentIcon id={id} title={title} size={16} />
            <span style={{ fontSize: 12, color: "var(--muted)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
              {agentIcon(id, title).title}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<Grid />);
