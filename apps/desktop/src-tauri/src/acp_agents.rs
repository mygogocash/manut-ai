//! The generic Agent Client Protocol agents as DATA: one row each, and no code path anywhere else names one.
//!
//! Each row says everything manut needs to offer the agent: its id (which is also its program), its name, the one
//! fixed argument that starts its ACP server, the command a person runs to sign it in, the install line the menu
//! shows, its mark (a file name the desktop's AgentIcon maps to a logo) and whether a Restart continues its
//! conversation. The shell keeps this, the authoritative copy: [`crate::sessions::agent`] and
//! [`crate::sessions::chat_args`] read it to decide what may run, [`crate::acp_chat::acp_agent`] reads it for the
//! adapter, and the agent look-up (`sessions_agents`) hands each row to the UI, which keeps no table of its own for
//! these agents.
//!
//! The main agents (Claude Code, Codex, OmO) and the other built-ins (DSH, oh-my-hermes, pi, oh-my-pi, Grok,
//! OpenCode, with its own rule check) keep their own rows and adapters in `sessions::AGENTS`; they are not here.
//! The rows are fixed in the binary; [`AcpEntry`] is the shape a later, person-confirmed entry takes too.

use serde::{Serialize, Serializer};

use crate::acp_chat::{AcpAgent, SettingCheck};
use crate::sessions::{Agent, Mode};

/// One generic ACP agent. Built by [`generic`], so the id, the program and the adapter's name never disagree.
#[derive(Debug)]
pub struct AcpEntry {
    /// The allow-list row (`id` = `program`, always a chat).
    pub agent: Agent,
    /// The structured-mode argument: `["acp"]` or `["--acp"]`, nothing else (a test holds every row to it).
    pub args: &'static [&'static str],
    /// What the adapter needs: the name and the sign-in line, no skill tool, no rule probe.
    pub acp: AcpAgent,
    /// The install line the menu shows (manut never runs it).
    pub install: &'static str,
    /// The mark's file name, which the desktop's AgentIcon maps to the agent's logo (src/ui/agentMarks.ts) or to
    /// its monogram.
    pub mark: &'static str,
    /// Restart (and a restart of manut) continues its conversation (`session/resume`, or `session/load`).
    pub continues: bool,
}

#[allow(clippy::too_many_arguments)]
const fn generic(
    id: &'static str,
    label: &'static str,
    args: &'static [&'static str],
    login: &'static str,
    install: &'static str,
    mark: &'static str,
    continues: bool,
    asks_in: &'static [&'static str],
    settings: Option<SettingCheck>,
) -> AcpEntry {
    AcpEntry {
        agent: Agent { id, program: id, label, mode: Mode::Chat },
        args,
        acp: AcpAgent { id, label, login, skill_tool: None, rules: None, asks_in, settings },
        install,
        mark,
        continues,
    }
}

/// Gemini CLI 0.68.0, Qwen Code 0.27.2, Kimi Code 2.6.0, Copilot CLI 1.0.110 and Cline 3.0.74, checked up to their
/// signed-out `session/new` (`tests/fixtures/acp/<agent>-signed-out.jsonl`). Gemini's `--experimental-acp` is
/// deprecated. Sign-in lines from each agent's own help; install lines from each one's README.
///
/// Cursor's and Antigravity's CLIs (item 74) were read from their own `--help` and documentation on this Mac (Cursor
/// Agent 2026.11.22, Antigravity 1.5.17), not run as a chat: `cursor-agent help acp` says "Start the Cursor Agent as an
/// ACP (Agent Client Protocol) server", and cursor.com/docs/cli/acp that it sends `session/request_permission` when a
/// tool needs approval and resumes with `session/load` (its bundle asks before a write, a delete, a read, a command and
/// an MCP tool, and skips asking only under `--force`, which [`crate::providers`] refuses); `agy help acp` says "Start the
/// Agent Client Protocol (ACP) stdio server" with `--dangerously-skip-permissions` to "Auto-approve all tool permission
/// requests", so by default it asks the client (its binary names `session/request_permission`, `session/load` and
/// `loadSession`). Sign-in lines from each one's help (`login`; Antigravity's `acp --login`), install lines from
/// cursor.com/docs/cli/installation and antigravity.google/docs/getting-started.
///
/// Item 101a ran both as chats (Cursor Agent 2026.11.22, Antigravity 1.5.18; `tests/fixtures/acp/cursor-*.jsonl` and
/// `agy-*.jsonl`) and holds each to the modes in which it asks: Cursor's `session/new` lists `agent`, `plan` and `ask`,
/// all asking; Antigravity's lists `default` ("Ask before edits and commands"), `accept-edits`, `auto` and `plan`, and
/// only `default` is taken (its default mode is a setting of its own). Cursor's own settings file is read before its chat
/// starts ([`CURSOR_SETTINGS`]).
pub const ACP_LIST: [AcpEntry; 7] = [
    generic("gemini", "Gemini CLI", &["--acp"], "gemini", "npm install -g @google/gemini-cli", "geminicli-color.svg", true, &[], None),
    generic("qwen", "Qwen Code", &["--acp"], "qwen", "npm install -g @qwen-code/qwen-code@latest", "qwen-color.svg", true, &[], None),
    generic("kimi", "Kimi Code", &["acp"], "kimi login", "npm install -g @moonshot-ai/kimi-code", "kimi-code.png", true, &[], None),
    generic("copilot", "Copilot CLI", &["--acp"], "copilot login", "npm install -g @github/copilot", "githubcopilot.svg", true, &[], None),
    generic("cline", "Cline", &["--acp"], "cline auth", "npm install -g cline", "cline.svg", true, &[], None),
    generic("cursor-agent", "Cursor", &["acp"], "cursor-agent login", "curl https://cursor.com/install -fsS | bash", "cursor.svg", true, &["agent", "plan", "ask"], Some(CURSOR_SETTINGS)),
    generic("agy", "Antigravity", &["acp"], "agy acp --login", "curl -fsSL https://antigravity.google/cli/install.sh | bash", "antigravity.svg", true, &["default"], None),
];

/// Cursor's own settings file, where Cursor itself reads it (Cursor Agent 2026.11.22, `cursor-config/dist/paths.js`:
/// `CURSOR_CONFIG_DIR`, else `$XDG_CONFIG_HOME/cursor`, else `~/.cursor`; then `cli-config.json`). Its ACP server reads
/// the person's permissions from it (`acp/shared-services.ts` merges `cursor-config/dist/permissions-adapter.js`), and an
/// `approvalMode` of `unrestricted` (Run Everything) lets every command, edit and read run without a request; a project's
/// `.cursor/cli.json` may hold only `permissions` (its schema is strict), so it cannot set the mode. `allowlist` is the
/// only value taken: `auto-review` (a classifier that runs some calls unasked) and any other are refused. Read on this Mac
/// from the CLI's own bundle; the person's `permissions.allow` rules are theirs and apply as in Cursor itself.
pub const CURSOR_SETTINGS: SettingCheck = SettingCheck {
    dir_vars: &[("CURSOR_CONFIG_DIR", ""), ("XDG_CONFIG_HOME", "cursor")],
    home_dir: ".cursor",
    file: "cli-config.json",
    key: "approvalMode",
    allowed: &["allowlist"],
};

/// The row of generic ACP agent `id`, or `None` for anything else (a built-in, a removed agent, any other text).
pub fn entry(id: &str) -> Option<&'static AcpEntry> {
    ACP_LIST.iter().find(|e| e.agent.id == id)
}

/// One row is one agent: rows compare by id (the adapter row holds no comparable data).
impl PartialEq for AcpEntry {
    fn eq(&self, other: &Self) -> bool {
        self.agent.id == other.agent.id
    }
}

impl Eq for AcpEntry {}

/// What the UI gets for each row: the data, never the adapter's functions.
impl Serialize for AcpEntry {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        #[derive(Serialize)]
        struct Row<'a> {
            id: &'a str,
            label: &'a str,
            program: &'a str,
            args: &'a [&'a str],
            login: &'a str,
            install: &'a str,
            mark: &'a str,
            continues: bool,
        }
        let a = &self.agent;
        Row { id: a.id, label: a.label, program: a.program, args: self.args, login: self.acp.login, install: self.install, mark: self.mark, continues: self.continues }
            .serialize(s)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    /// The two structured-mode arguments a generic ACP agent may get.
    const ACP_ARGS: [&[&str]; 2] = [&["acp"], &["--acp"]];

    /// Each row is one consistent agent: the id is the program, a chat, one of the two ACP arguments, the adapter
    /// named the same, and its mark a file name the desktop looks up. No mark file ships in src/assets/agents: since
    /// item 122 the desktop draws each agent's own published logo from src/ui/agentMarks.ts (generated from Lobe
    /// Icons), found by the agent's id or this file name, and its monogram when none is published (src/ui/AgentIcon.tsx).
    #[test]
    fn every_row_is_one_agent() {
        let assets = Path::new(env!("CARGO_MANIFEST_DIR")).join("../src/assets/agents");
        let mut seen = Vec::new();
        for e in &ACP_LIST {
            let id = e.agent.id;
            assert!(!seen.contains(&id), "{id} twice");
            seen.push(id);
            assert_eq!((e.agent.program, e.agent.mode), (id, Mode::Chat), "{id}");
            assert!(ACP_ARGS.contains(&e.args), "{id}: {:?}", e.args);
            assert_eq!((e.acp.id, e.acp.label), (id, e.agent.label), "{id}");
            assert!(e.acp.skill_tool.is_none() && e.acp.rules.is_none(), "{id}: a generic agent has no rule probe");
            // a row held to its asking modes names each one plainly, and the one it sets back first
            assert!(e.acp.asks_in.iter().all(|m| !m.is_empty() && m.chars().all(|c| c.is_ascii_lowercase() || c == '-')), "{id}");
            // A plain file name of a kind the desktop's mark look-up names (AgentIcon.tsx `fileMark`: *.svg, *.png).
            assert!((e.mark.ends_with(".svg") || e.mark.ends_with(".png")) && !e.mark.contains('/'), "{id}: {}", e.mark);
            assert!(!assets.join(e.mark).exists(), "{id}: {} ships, but the vendors' logos are left out", e.mark);
            // an npm package, or (Cursor, Antigravity) the vendor's own installer line from its documentation
            let vendor = ["curl https://cursor.com/install -fsS | bash", "curl -fsSL https://antigravity.google/cli/install.sh | bash"];
            assert!(e.install.starts_with("npm install -g ") || vendor.contains(&e.install), "{id}");
            assert!(crate::sessions::AGENTS.iter().all(|a| a.id != id), "{id} is also a built-in");
        }
        assert_eq!(seen, ["gemini", "qwen", "kimi", "copilot", "cline", "cursor-agent", "agy"]);
        // item 101a: Cursor and Antigravity, which ran here as chats, are held to their asking modes; Antigravity's
        // `accept-edits` and `auto` are never among them, and only Cursor's settings file is read
        let held: Vec<(&str, &[&str], bool)> = ACP_LIST.iter().map(|e| (e.agent.id, e.acp.asks_in, e.acp.settings.is_some())).collect();
        assert_eq!(
            held,
            [
                ("gemini", &[][..], false),
                ("qwen", &[][..], false),
                ("kimi", &[][..], false),
                ("copilot", &[][..], false),
                ("cline", &[][..], false),
                ("cursor-agent", &["agent", "plan", "ask"][..], true),
                ("agy", &["default"][..], false),
            ]
        );
        assert!(entry("kilo").is_none() && entry("opencode").is_none() && entry("claude").is_none() && entry("").is_none());
    }

    /// The mock host's copy (`src/sessions/mockAcpAgents.json`: a browser has no shell to ask) is this list exactly as
    /// the shell sends it.
    #[test]
    fn the_mock_hosts_copy_is_this_list() {
        let p = Path::new(env!("CARGO_MANIFEST_DIR")).join("../src/sessions/mockAcpAgents.json");
        let copy: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(p).unwrap()).unwrap();
        assert_eq!(copy, serde_json::to_value(&ACP_LIST).unwrap());
    }

    /// 0.2.8's sign-in and install lines, unchanged, and Cursor's and Antigravity's (item 74).
    #[test]
    fn the_lines_are_0_2_8s() {
        let rows: Vec<(&str, &str, &str, &[&str])> = ACP_LIST.iter().map(|e| (e.agent.id, e.acp.login, e.install, e.args)).collect();
        assert_eq!(
            rows,
            [
                ("gemini", "gemini", "npm install -g @google/gemini-cli", &["--acp"][..]),
                ("qwen", "qwen", "npm install -g @qwen-code/qwen-code@latest", &["--acp"][..]),
                ("kimi", "kimi login", "npm install -g @moonshot-ai/kimi-code", &["acp"][..]),
                ("copilot", "copilot login", "npm install -g @github/copilot", &["--acp"][..]),
                ("cline", "cline auth", "npm install -g cline", &["--acp"][..]),
                ("cursor-agent", "cursor-agent login", "curl https://cursor.com/install -fsS | bash", &["acp"][..]),
                ("agy", "agy acp --login", "curl -fsSL https://antigravity.google/cli/install.sh | bash", &["acp"][..]),
            ]
        );
    }
}
