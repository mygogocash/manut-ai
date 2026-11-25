//! Settings › MCP and Skills (item 72): which MCP servers and skills Claude Code and Codex have on this computer, read from
//! each agent's own files, only read. Names only: a server's command, arguments, environment, headers and address never
//! leave this module, and nothing here runs a program (Claude Code's own `claude mcp list` would start every server to check
//! it, and prints their commands).
//!
//! Where each comes from, by the agents' own documentation and what Codex itself lists as its skill roots:
//! - Claude Code: its state file `.claude.json` (user servers, and a folder's own "local" servers under its repository's
//!   root), the project's `.mcp.json` (with whether Claude Code connects each there, `acp_mcp::project`), the plugins its
//!   user settings turn on (each plugin's `.mcp.json` or `plugin.json`, and its `skills/`), its `skills/` folder and the
//!   project's `.claude/skills/`.
//! - Codex: its `config.toml` (`[mcp_servers.<name>]`, `enabled = false` when turned off) and the project's
//!   `.codex/config.toml` (read by Codex only in a trusted project), its own `skills/` and `~/.agents/skills/`, and the
//!   project's `.agents/skills/`.
//!
//! Whether a server is connected is not known here: the page shows what a running Claude Code chat last reported.

use std::path::{Path, PathBuf};

use serde::Serialize;
use serde_json::Value;

use crate::acp_mcp;

/// The most servers or skills listed from one place.
const MAX_ITEMS: usize = 300;
/// The largest settings or plugin file read.
const MAX_FILE: u64 = 1 << 20;
/// The most of a `SKILL.md` read for its name.
const SKILL_HEAD: u64 = 8 * 1024;

/// One server or skill. `from`: `home` (the person's own, in every project), `local` (theirs, in this project only),
/// `project` (the project's own file), `plugin` (from plugin `plugin`). `state`: `on`, `off` (turned off) or `ask` (the agent
/// waits for the person's yes before it uses it).
#[derive(Debug, Serialize, PartialEq, Eq, Clone)]
pub struct Item {
    pub name: String,
    pub from: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub plugin: Option<String>,
    pub state: &'static str,
}

/// What one agent has. `found`: its home folder is on this computer.
#[derive(Debug, Serialize, PartialEq, Eq)]
pub struct AgentConfig {
    pub agent: &'static str,
    pub found: bool,
    pub servers: Vec<Item>,
    pub skills: Vec<Item>,
}

/// A name as the page may show it: one line, no control characters, at most 80 characters; `None` when nothing is left.
fn clean(name: &str) -> Option<String> {
    let n: String = name.chars().filter(|c| !c.is_control()).take(80).collect();
    let n = n.trim().to_string();
    (!n.is_empty()).then_some(n)
}

fn item(name: &str, from: &'static str, plugin: Option<&str>, state: &'static str) -> Option<Item> {
    Some(Item { name: clean(name)?, from, plugin: plugin.and_then(clean), state })
}

/// The skills in `root`: each folder with a `SKILL.md`, named by its front matter's `name:` (else the folder's name).
/// Folders whose names start with a dot are the agent's own (Codex's `.system`) and are left out.
fn skills_in(root: &Path, from: &'static str, plugin: Option<&str>) -> Vec<Item> {
    let Ok(rd) = std::fs::read_dir(root) else { return Vec::new() };
    let mut out: Vec<Item> = rd
        .flatten()
        .take(MAX_ITEMS * 2)
        .filter_map(|e| {
            let folder = e.file_name().to_string_lossy().into_owned();
            if folder.starts_with('.') {
                return None;
            }
            let file = e.path().join("SKILL.md");
            if !std::fs::metadata(&file).map(|m| m.is_file()).unwrap_or(false) {
                return None;
            }
            let name = front_name(&file).unwrap_or(folder);
            item(&name, from, plugin, "on")
        })
        .take(MAX_ITEMS)
        .collect();
    out.sort_by(|a, b| a.name.cmp(&b.name));
    out
}

/// The `name:` in a `SKILL.md`'s front matter (between its first two `---` lines).
fn front_name(file: &Path) -> Option<String> {
    use std::io::Read;
    let mut text = String::new();
    std::fs::File::open(file).ok()?.take(SKILL_HEAD).read_to_string(&mut text).ok()?;
    let mut lines = text.lines();
    if lines.next()?.trim() != "---" {
        return None;
    }
    for l in lines {
        if l.trim() == "---" {
            return None;
        }
        if let Some(v) = l.strip_prefix("name:") {
            return clean(v.trim().trim_matches(['"', '\'']));
        }
    }
    None
}

/// An object's keys in name order (whatever order the file had them in).
fn keys(v: Option<&Value>) -> Vec<String> {
    let mut out: Vec<String> = v.and_then(Value::as_object).map(|o| o.keys().take(MAX_ITEMS).cloned().collect()).unwrap_or_default();
    out.sort();
    out
}

/// A plugin's MCP servers: its `.mcp.json` (an `mcpServers` object, or the servers at its top) and the `mcpServers` object
/// in its `.claude-plugin/plugin.json`.
fn plugin_servers(root: &Path) -> Vec<String> {
    let mut out = Vec::new();
    if let Some(v) = acp_mcp::read_json_file(&root.join(".mcp.json"), MAX_FILE) {
        match v.get("mcpServers") {
            Some(m) => out.extend(keys(Some(m))),
            None => out.extend(v.as_object().into_iter().flatten().filter(|(_, x)| x.get("command").is_some() || x.get("url").is_some()).map(|(k, _)| k.clone())),
        }
    }
    if let Some(v) = acp_mcp::read_json_file(&root.join(".claude-plugin").join("plugin.json"), MAX_FILE) {
        out.extend(keys(v.get("mcpServers")));
    }
    out
}

/// The folder each enabled plugin is installed in, from Claude Code's own list of installed plugins, kept only when it is
/// inside its plugins folder.
fn plugin_roots(claude: &Path, enabled: &[String]) -> Vec<(String, PathBuf)> {
    let plugins = claude.join("plugins");
    let base = plugins.canonicalize().unwrap_or(plugins.clone());
    let list = acp_mcp::read_json_file(&plugins.join("installed_plugins.json"), 4 * MAX_FILE).unwrap_or(Value::Null);
    enabled
        .iter()
        .filter_map(|id| {
            let entry = list.get("plugins")?.get(id)?;
            let entry = entry.as_array().and_then(|a| a.first()).unwrap_or(entry);
            let path = PathBuf::from(entry.get("installPath")?.as_str()?);
            let real = path.canonicalize().ok()?;
            real.starts_with(&base).then(|| (id.split('@').next().unwrap_or(id).to_string(), real))
        })
        .collect()
}

fn claude(home: &Path, project: Option<&Path>, env: &dyn Fn(&str) -> Option<String>) -> AgentConfig {
    let dir = crate::past_chats::cli_home(home, "claude", &[], env).unwrap_or_else(|| home.join(".claude"));
    let state = acp_mcp::claude_state(home, env);
    let mut servers: Vec<Item> = keys(state.get("mcpServers")).iter().filter_map(|n| item(n, "home", None, "on")).collect();
    let mut skills = skills_in(&dir.join("skills"), "home", None);
    if let Some(p) = project {
        let mcp = acp_mcp::project(home, p, env);
        let root = acp_mcp::repository_root(home, p);
        let keys_at: Vec<String> = [root.clone(), root.canonicalize().unwrap_or_else(|_| root.clone())].iter().map(|r| r.to_string_lossy().into_owned()).collect();
        let entry = state.get("projects").and_then(Value::as_object).and_then(|ps| keys_at.iter().find_map(|k| ps.get(k)));
        servers.extend(keys(entry.and_then(|e| e.get("mcpServers"))).iter().filter_map(|n| item(n, "local", None, "on")));
        let mut names: Vec<&String> = mcp.servers.keys().take(MAX_ITEMS).collect();
        names.sort();
        servers.extend(names.into_iter().filter_map(|n| item(n, "project", None, mcp.state(n))));
        skills.extend(skills_in(&p.join(".claude").join("skills"), "project", None));
    }
    let settings = acp_mcp::read_json_file(&dir.join("settings.json"), MAX_FILE).unwrap_or(Value::Null);
    let enabled: Vec<String> = settings.get("enabledPlugins").and_then(Value::as_object).into_iter().flatten().filter(|(_, on)| on.as_bool() == Some(true)).map(|(k, _)| k.clone()).take(MAX_ITEMS).collect();
    for (name, root) in plugin_roots(&dir, &enabled) {
        servers.extend(plugin_servers(&root).iter().filter_map(|n| item(n, "plugin", Some(&name), "on")));
        skills.extend(skills_in(&root.join("skills"), "plugin", Some(&name)));
    }
    let found = dir.is_dir() || state.is_object();
    AgentConfig { agent: "claude", found, servers, skills }
}

/// The `[mcp_servers]` table of a Codex `config.toml` as names, each `off` when it says `enabled = false`.
fn codex_servers(file: &Path, from: &'static str, on: &'static str) -> Vec<Item> {
    let Some(text) = std::fs::metadata(file).ok().filter(|m| m.is_file() && m.len() <= MAX_FILE).and_then(|_| std::fs::read_to_string(file).ok()) else {
        return Vec::new();
    };
    let Ok(doc) = text.parse::<toml::Table>() else { return Vec::new() };
    let Some(table) = doc.get("mcp_servers").and_then(toml::Value::as_table) else { return Vec::new() };
    let mut out: Vec<Item> = table
        .iter()
        .take(MAX_ITEMS)
        .filter_map(|(name, v)| {
            let off = v.get("enabled").and_then(toml::Value::as_bool) == Some(false);
            item(name, from, None, if off { "off" } else { on })
        })
        .collect();
    out.sort_by(|a, b| a.name.cmp(&b.name));
    out
}

/// Whether Codex's own config marks the project `root` trusted (`[projects."<path>"] trust_level = "trusted"`).
fn codex_trusts(file: &Path, root: &Path) -> bool {
    let Some(doc) = std::fs::read_to_string(file).ok().and_then(|t| t.parse::<toml::Table>().ok()) else { return false };
    let Some(projects) = doc.get("projects").and_then(toml::Value::as_table) else { return false };
    [root.to_path_buf(), root.canonicalize().unwrap_or_else(|_| root.to_path_buf())]
        .iter()
        .any(|r| projects.get(&*r.to_string_lossy()).and_then(|p| p.get("trust_level")).and_then(toml::Value::as_str) == Some("trusted"))
}

fn codex(home: &Path, project: Option<&Path>, env: &dyn Fn(&str) -> Option<String>) -> AgentConfig {
    let dir = crate::past_chats::cli_home(home, "codex", &[], env).unwrap_or_else(|| home.join(".codex"));
    let config = dir.join("config.toml");
    let mut servers = codex_servers(&config, "home", "on");
    let mut skills = skills_in(&dir.join("skills"), "home", None);
    skills.extend(skills_in(&home.join(".agents").join("skills"), "home", None));
    if let Some(p) = project {
        let root = acp_mcp::repository_root(home, p);
        let on = if codex_trusts(&config, &root) { "on" } else { "ask" };
        servers.extend(codex_servers(&p.join(".codex").join("config.toml"), "project", on));
        skills.extend(skills_in(&p.join(".agents").join("skills"), "project", None));
    }
    AgentConfig { agent: "codex", found: dir.is_dir(), servers, skills }
}

/// What Claude Code and Codex have, for the person's own home (`home`) and, when one is given, the project `project`.
pub fn read(home: &Path, project: Option<&Path>, env: &dyn Fn(&str) -> Option<String>) -> Vec<AgentConfig> {
    let project = project.filter(|p| p.is_absolute() && p.is_dir());
    vec![claude(home, project, env), codex(home, project, env)]
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::fs;

    const SECRET: &str = "sk-SECRET-never-on-the-page";

    fn put(dir: &Path, rel: &str, text: &str) {
        let p = dir.join(rel);
        fs::create_dir_all(p.parent().unwrap()).unwrap();
        fs::write(p, text).unwrap();
    }

    fn no_env(_: &str) -> Option<String> {
        None
    }

    /// A made-up home: Claude Code with a user server, a local one for the project, a plugin with a server and a skill, a
    /// skill of its own; Codex with two servers (one off) and skills; a project with `.mcp.json`, skills and Codex config.
    /// Every value is a planted secret.
    fn made_up(name: &str) -> Option<(PathBuf, PathBuf)> {
        let (home, d) = crate::lane::tests::repo(name)?;
        let plugin = home.join(".claude/plugins/cache/mp/helper/1.0.0");
        put(&plugin, ".mcp.json", &json!({"mcpServers": {"helper-db": {"command": "db", "env": {"K": SECRET}}}}).to_string());
        put(&plugin, "skills/helping/SKILL.md", "---\nname: helping\ndescription: x\n---\n");
        put(&home, ".claude/plugins/installed_plugins.json", &json!({"version": 2, "plugins": {"helper@mp": [{"installPath": plugin.to_string_lossy(), "scope": "user"}]}}).to_string());
        put(&home, ".claude/settings.json", &json!({"enabledPlugins": {"helper@mp": true, "gone@mp": true}, "env": {"ANTHROPIC_API_KEY": SECRET}}).to_string());
        put(&home, ".claude/skills/promptpay/SKILL.md", "---\nname: \"promptpay-qr\"\n---\nbody\n");
        put(&home, ".claude/skills/nameless/SKILL.md", "no front matter\n");
        put(&home, ".claude/skills/not-a-skill/README.md", "x\n");
        let state = json!({
            "oauthAccount": {"emailAddress": "me@example.com"},
            "mcpServers": {"github": {"type": "http", "url": format!("https://x.example/mcp?key={SECRET}"), "headers": {"Authorization": SECRET}}},
            "projects": {d.to_string_lossy(): {"hasTrustDialogAccepted": true, "mcpServers": {"local-db": {"command": "psql", "args": [SECRET]}}, "enabledMcpjsonServers": ["shared"]}}
        });
        put(&home, ".claude.json", &state.to_string());
        put(&home, ".codex/config.toml", &format!("[mcp_servers.railway]\ncommand = \"railway\"\nenv = {{ TOKEN = \"{SECRET}\" }}\n\n[mcp_servers.old]\nurl = \"https://old.example/?k={SECRET}\"\nenabled = false\n"));
        put(&home, ".codex/auth.json", &format!(r#"{{"OPENAI_API_KEY":"{SECRET}"}}"#));
        put(&home, ".codex/skills/review/SKILL.md", "---\nname: review\n---\n");
        put(&home, ".codex/skills/.system/builtin/SKILL.md", "---\nname: builtin\n---\n");
        put(&home, ".agents/skills/qr/SKILL.md", "---\nname: qr\n---\n");
        put(&d, ".mcp.json", &json!({"mcpServers": {"shared": {"command": "s", "env": {"T": SECRET}}, "waiting": {"url": SECRET}}}).to_string());
        put(&d, ".claude/skills/shop-copy/SKILL.md", "---\nname: shop-copy\n---\n");
        put(&d, ".codex/config.toml", &format!("[mcp_servers.proj]\ncommand = \"{SECRET}\"\n"));
        put(&d, ".agents/skills/stock/SKILL.md", "---\nname: stock\n---\n");
        Some((home, d))
    }

    fn rows(items: &[Item]) -> Vec<(String, &'static str, Option<String>, &'static str)> {
        items.iter().map(|i| (i.name.clone(), i.from, i.plugin.clone(), i.state)).collect()
    }

    fn row(name: &str, from: &'static str, plugin: Option<&str>, state: &'static str) -> (String, &'static str, Option<String>, &'static str) {
        (name.into(), from, plugin.map(String::from), state)
    }

    #[test]
    fn lists_each_agents_servers_and_skills_by_name_and_where_each_comes_from() {
        let Some((home, d)) = made_up("agentcfg-all") else { return };
        let all = read(&home, Some(&d), &no_env);
        let c = &all[0];
        assert_eq!((c.agent, c.found), ("claude", true));
        assert_eq!(
            rows(&c.servers),
            vec![row("github", "home", None, "on"), row("local-db", "local", None, "on"), row("shared", "project", None, "on"), row("waiting", "project", None, "ask"), row("helper-db", "plugin", Some("helper"), "on")]
        );
        assert_eq!(
            rows(&c.skills),
            vec![row("nameless", "home", None, "on"), row("promptpay-qr", "home", None, "on"), row("shop-copy", "project", None, "on"), row("helping", "plugin", Some("helper"), "on")]
        );
        let x = &all[1];
        assert_eq!((x.agent, x.found), ("codex", true));
        // the project's Codex config is read by Codex only in a project it trusts
        assert_eq!(rows(&x.servers), vec![row("old", "home", None, "off"), row("railway", "home", None, "on"), row("proj", "project", None, "ask")]);
        assert_eq!(rows(&x.skills), vec![row("review", "home", None, "on"), row("qr", "home", None, "on"), row("stock", "project", None, "on")]);
        // names only: no value of any file reaches the page
        let page = serde_json::to_string(&all).unwrap();
        for never in [SECRET, "https://", "psql", "me@example.com", "ANTHROPIC"] {
            assert!(!page.contains(never), "{never} in {page}");
        }
        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn without_a_project_only_the_home_is_read_and_a_missing_agent_says_so() {
        let Some((home, d)) = made_up("agentcfg-home") else { return };
        let all = read(&home, None, &no_env);
        assert!(all[0].servers.iter().all(|s| s.from == "home" || s.from == "plugin"));
        assert!(all[1].skills.iter().all(|s| s.from == "home"));
        // a relative folder is no project
        assert_eq!(read(&home, Some(Path::new("code/web-app")), &no_env), all);
        let empty = home.join("empty");
        fs::create_dir_all(&empty).unwrap();
        let none = read(&empty, Some(&d), &no_env);
        assert!(!none[0].found && !none[1].found);
        let _ = fs::remove_dir_all(home);
    }

    /// Real check on this computer: how many of each kind are read from the person's own files (counts only).
    /// `cargo test -- --ignored real_agent_config`.
    #[test]
    #[ignore]
    fn real_agent_config() {
        let home = PathBuf::from(std::env::var("HOME").unwrap());
        let project = std::env::var("MANUT_PROJECT").ok().map(PathBuf::from);
        for a in read(&home, project.as_deref(), &|k| std::env::var(k).ok()) {
            let count = |v: &[Item]| {
                let mut m = std::collections::BTreeMap::new();
                for i in v {
                    *m.entry(format!("{}/{}", i.from, i.state)).or_insert(0) += 1;
                }
                m
            };
            println!("{} found={} servers={:?} skills={:?}", a.agent, a.found, count(&a.servers), count(&a.skills));
        }
    }

    #[test]
    fn a_name_is_one_short_line() {
        assert_eq!(clean("  a\nb\t "), Some("ab".into()));
        assert_eq!(clean(&"x".repeat(200)).map(|s| s.len()), Some(80));
        assert_eq!(clean("\u{7}"), None);
    }
}
