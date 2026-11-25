//! The MCP servers an Agent Client Protocol agent is handed when its conversation opens (`session/new`, `session/load`,
//! `session/resume`; `acp_chat.rs`). Each ACP agent already reads its own MCP configuration itself, as in its own terminal;
//! what the app adds is the one source that belongs to the project rather than to another vendor's agent:
//!
//! The project's `.mcp.json` (the session's folder's, else the repository's top), the servers in it that the person has
//! approved for this project in Claude Code, exactly as Claude Code would connect them: the folder is trusted
//! (`projects["<repository root>"].hasTrustDialogAccepted` in Claude Code's own `.claude.json`), the server is approved by
//! `enabledMcpjsonServers` or `enableAllProjectMcpServers` in the person's user settings, in the repository root's
//! `.claude/settings.local.json` while git does not track it, or in the folder's entry in `.claude.json` (where older
//! versions kept it), and no such place lists it in `disabledMcpjsonServers`. A repository's own committed settings never
//! approve a server, as in Claude Code, so a cloned project cannot start a program here unasked.
//!
//! Why this source and no other: `.mcp.json` lives in the folder the agent already works in, so its literal values are ones
//! that agent can read anyway, and a `${VAR}` in it comes from the environment the agent already runs with. The servers the
//! person added to Claude Code or Codex themselves are not handed on: their headers and environment hold secrets those
//! agents were given, not this one.
//!
//! Shapes (agentclientprotocol.com, "Session Setup"): stdio `{name, command, args, env: [{name, value}]}`, which every agent
//! takes; HTTP `{type: "http", name, url, headers: [{name, value}]}` and SSE the same with `"sse"`, only to an agent whose
//! `agentCapabilities.mcpCapabilities` says it takes them. The servers' values go only into that one line to the agent:
//! never into an event, the page or a log ([`Approved`]'s `Debug` prints only how many).

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

use serde_json::{json, Value};

/// The most servers handed on; a project names a few.
const MAX_SERVERS: usize = 20;
/// The largest `.mcp.json` or settings file read.
const MAX_FILE: u64 = 1 << 20;
/// The largest `.claude.json` read (it keeps Claude Code's own state for every project, so it grows).
const MAX_STATE: u64 = 32 << 20;

#[derive(Clone, PartialEq, Eq)]
enum Transport {
    Stdio { command: String, args: Vec<String>, env: Vec<(String, String)> },
    Http { url: String, headers: Vec<(String, String)> },
    Sse { url: String, headers: Vec<(String, String)> },
}

#[derive(Clone, PartialEq, Eq)]
struct Server {
    name: String,
    how: Transport,
}

/// The approved servers of one session. Its `Debug` says how many and nothing else, so a value can never reach a log.
#[derive(Clone, Default, PartialEq, Eq)]
pub struct Approved(Vec<Server>);

impl std::fmt::Debug for Approved {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "Approved({} servers)", self.0.len())
    }
}

impl Approved {
    #[cfg(test)]
    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }

    /// The servers' names, for a test; never their values.
    #[cfg(test)]
    pub fn names(&self) -> Vec<String> {
        self.0.iter().map(|s| s.name.clone()).collect()
    }

    /// The `mcpServers` list for an agent that takes HTTP (`http`) and SSE (`sse`) servers or not; stdio always.
    pub fn for_agent(&self, http: bool, sse: bool) -> Value {
        let pairs = |v: &[(String, String)]| Value::Array(v.iter().map(|(n, x)| json!({"name": n, "value": x})).collect());
        Value::Array(
            self.0
                .iter()
                .filter_map(|s| match &s.how {
                    Transport::Stdio { command, args, env } => Some(json!({"name": s.name, "command": command, "args": args, "env": pairs(env)})),
                    Transport::Http { url, headers } if http => Some(json!({"type": "http", "name": s.name, "url": url, "headers": pairs(headers)})),
                    Transport::Sse { url, headers } if sse => Some(json!({"type": "sse", "name": s.name, "url": url, "headers": pairs(headers)})),
                    _ => None,
                })
                .collect(),
        )
    }
}

/// `text` with each `${VAR}` and `${VAR:-default}` replaced from `env`, the two forms Claude Code's `.mcp.json` takes; `None`
/// when a variable is not set and has no default (Claude Code could not start that server either).
pub(crate) fn expand(text: &str, env: &dyn Fn(&str) -> Option<String>) -> Option<String> {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(at) = rest.find("${") {
        out.push_str(&rest[..at]);
        let after = &rest[at + 2..];
        let Some(end) = after.find('}') else {
            out.push_str(&rest[at..]);
            return Some(out);
        };
        let inner = &after[..end];
        let (name, default) = match inner.split_once(":-") {
            Some((n, d)) => (n, Some(d)),
            None => (inner, None),
        };
        let valid = !name.is_empty() && name.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_') && !name.as_bytes()[0].is_ascii_digit();
        if !valid {
            out.push_str(&rest[at..at + 3 + end]);
        } else {
            match env(name).filter(|v| !v.is_empty()).or_else(|| default.map(str::to_string)) {
                Some(v) => out.push_str(&v),
                None => return None,
            }
        }
        rest = &after[end + 1..];
    }
    out.push_str(rest);
    Some(out)
}

fn read_json(path: &Path, max: u64) -> Option<Value> {
    let m = std::fs::metadata(path).ok()?;
    if !m.is_file() || m.len() > max {
        return None;
    }
    serde_json::from_str(&std::fs::read_to_string(path).ok()?).ok()
}

fn strings(v: Option<&Value>) -> Vec<String> {
    v.and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str).map(str::to_string).collect()
}

/// `{"k": "v"}` as pairs, each value expanded; `None` when one cannot be.
fn pairs(v: Option<&Value>, env: &dyn Fn(&str) -> Option<String>) -> Option<Vec<(String, String)>> {
    let Some(o) = v.and_then(Value::as_object) else { return Some(Vec::new()) };
    o.iter().map(|(k, x)| Some((k.clone(), expand(x.as_str()?, env)?))).collect()
}

/// One `.mcp.json` entry as a server, when it is one the protocol has a shape for and every value in it can be filled in.
fn server(name: &str, v: &Value, env: &dyn Fn(&str) -> Option<String>) -> Option<Server> {
    if name.is_empty() || name.len() > 64 || name.chars().any(char::is_control) {
        return None;
    }
    let kind = v.get("type").and_then(Value::as_str).unwrap_or("");
    let how = match kind {
        "" | "stdio" => {
            let command = expand(v.get("command")?.as_str()?, env)?;
            let args = v.get("args").and_then(Value::as_array).map(|a| a.iter().map(|x| expand(x.as_str()?, env)).collect::<Option<Vec<_>>>()).unwrap_or(Some(Vec::new()))?;
            Transport::Stdio { command, args, env: pairs(v.get("env"), env)? }
        }
        "http" | "sse" => {
            let url = expand(v.get("url")?.as_str()?, env)?;
            let headers = pairs(v.get("headers"), env)?;
            if kind == "http" {
                Transport::Http { url, headers }
            } else {
                Transport::Sse { url, headers }
            }
        }
        _ => return None,
    };
    Some(Server { name: name.to_string(), how })
}

/// Where a session's folder sits in git: its work tree's top, and the root of the repository's first checkout (the
/// developer's folder of a lane, whose root Claude Code keeps a worktree's trust and local settings under). `tracked`: whether
/// git tracks a path relative to that root. Both are the folder itself outside a repository.
struct Place {
    top: PathBuf,
    root: PathBuf,
    git: Option<crate::lane::Git>,
}

impl Place {
    fn of(home: &Path, cwd: &Path) -> Place {
        let alone = || Place { top: cwd.to_path_buf(), root: cwd.to_path_buf(), git: None };
        let Ok(git) = crate::lane::Git::new(home) else { return alone() };
        let Some(line) = git.run(cwd, &["rev-parse", "--path-format=absolute", "--show-toplevel", "--git-common-dir"]).ok().filter(|r| r.code == Some(0)).map(|r| r.out) else {
            return alone();
        };
        let mut lines = line.lines().map(str::trim);
        let top = PathBuf::from(lines.next().unwrap_or(""));
        let common = PathBuf::from(lines.next().unwrap_or(""));
        if !top.is_absolute() {
            return alone();
        }
        let root = match common.file_name() {
            Some(n) if n == ".git" && common.is_absolute() => common.parent().map(Path::to_path_buf).unwrap_or_else(|| top.clone()),
            _ => top.clone(),
        };
        Place { top, root, git: Some(git) }
    }

    fn tracked(&self, rel: &str) -> bool {
        self.git.as_ref().is_some_and(|g| g.run(&self.root, &["ls-files", "--error-unmatch", "--", rel]).map(|r| r.code == Some(0)).unwrap_or(true))
    }
}

/// The servers to hand an ACP agent working in `cwd`: see the module's note. `home` is the person's home folder and `env`
/// this app's environment (the agent's own, which it inherits), read for `CLAUDE_CONFIG_DIR` and the `${VAR}`s.
pub fn approved(home: &Path, cwd: &Path, env: &dyn Fn(&str) -> Option<String>) -> Approved {
    let place = Place::of(home, cwd);
    let file = [cwd.join(".mcp.json"), place.top.join(".mcp.json")].into_iter().find(|p| p.is_file());
    let Some(servers) = file.and_then(|f| read_json(&f, MAX_FILE)).and_then(|v| v.get("mcpServers").and_then(Value::as_object).cloned()) else {
        return Approved::default();
    };
    // Claude Code's own record of this folder: trusted, and what was approved there
    let claude = crate::past_chats::cli_home(home, "claude", &[], env).unwrap_or_else(|| home.join(".claude"));
    let state_file = if env("CLAUDE_CONFIG_DIR").is_some_and(|v| !v.is_empty()) { claude.join(".claude.json") } else { home.join(".claude.json") };
    let state = read_json(&state_file, MAX_STATE).unwrap_or(Value::Null);
    let projects = state.get("projects").and_then(Value::as_object);
    let keys: Vec<String> = [place.root.clone(), place.root.canonicalize().unwrap_or_else(|_| place.root.clone())].iter().map(|p| p.to_string_lossy().into_owned()).collect();
    let entry = projects.and_then(|p| keys.iter().find_map(|k| p.get(k))).cloned().unwrap_or(Value::Null);
    if entry.get("hasTrustDialogAccepted").and_then(Value::as_bool) != Some(true) {
        return Approved::default();
    }
    // the person's own settings only: their user settings, and the root's local settings while git does not track them
    let local_rel = ".claude/settings.local.json";
    let mut sources = vec![read_json(&claude.join("settings.json"), MAX_FILE).unwrap_or(Value::Null), entry];
    if !place.tracked(local_rel) {
        sources.push(read_json(&place.root.join(local_rel), MAX_FILE).unwrap_or(Value::Null));
    }
    let all = sources.iter().any(|s| s.get("enableAllProjectMcpServers").and_then(Value::as_bool) == Some(true));
    let enabled: BTreeSet<String> = sources.iter().flat_map(|s| strings(s.get("enabledMcpjsonServers"))).collect();
    let disabled: BTreeSet<String> = sources.iter().flat_map(|s| strings(s.get("disabledMcpjsonServers"))).collect();
    let mut out = Vec::new();
    for (name, v) in servers.iter() {
        if out.len() >= MAX_SERVERS || disabled.contains(name) || !(all || enabled.contains(name)) {
            continue;
        }
        if let Some(s) = server(name, v, env) {
            out.push(s);
        }
    }
    Approved(out)
}

/// Every server of a `.mcp.json` body as if approved, for another module's test.
#[cfg(test)]
pub(crate) fn all_of(mcp: &Value, env: &dyn Fn(&str) -> Option<String>) -> Approved {
    Approved(mcp.get("mcpServers").and_then(Value::as_object).into_iter().flatten().filter_map(|(n, v)| server(n, v, env)).collect())
}

/// [`approved`] for a session about to start in `cwd`, with this app's home folder and environment; none without a home.
pub fn for_session(cwd: &Path) -> Approved {
    let home = std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" }).filter(|h| !h.is_empty()).map(PathBuf::from);
    match home {
        Some(h) => approved(&h, cwd, &|k| std::env::var(k).ok()),
        None => Approved::default(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::lane::tests::{repo, sh};
    use std::fs;

    const SECRET: &str = "ghp_SECRET_only_for_the_agent";

    fn env(k: &str) -> Option<String> {
        match k {
            "GH_TOKEN" => Some(SECRET.into()),
            "HOME" => Some("/h".into()),
            _ => None,
        }
    }

    #[test]
    fn variables_are_filled_in_as_claude_code_does() {
        assert_eq!(expand("Bearer ${GH_TOKEN}", &env).as_deref(), Some(format!("Bearer {SECRET}").as_str()));
        assert_eq!(expand("${MISSING:-fallback}/x", &env).as_deref(), Some("fallback/x"));
        assert_eq!(expand("${HOME}/bin/${GH_TOKEN:-no}", &env).as_deref(), Some(format!("/h/bin/{SECRET}").as_str()));
        assert_eq!(expand("plain", &env).as_deref(), Some("plain"));
        assert_eq!(expand("${MISSING}", &env), None, "a server that cannot be filled in is not handed on");
        assert_eq!(expand("${not valid}", &env).as_deref(), Some("${not valid}"));
        assert_eq!(expand("open ${", &env).as_deref(), Some("open ${"));
    }

    /// A person's home with Claude Code's state for `root` (trusted or not) and their user settings, and a project with a
    /// `.mcp.json` of five servers.
    fn setup(name: &str, trusted: bool, user: Value) -> Option<(PathBuf, PathBuf)> {
        let (home, d) = repo(name)?;
        let mut project = serde_json::Map::new();
        project.insert("hasTrustDialogAccepted".into(), Value::Bool(trusted));
        project.insert("disabledMcpjsonServers".into(), json!(["off"]));
        let state = json!({"oauthAccount": {"emailAddress": "me@example.com"}, "projects": {d.to_string_lossy(): project}});
        fs::write(home.join(".claude.json"), state.to_string()).unwrap();
        fs::create_dir_all(home.join(".claude")).unwrap();
        fs::write(home.join(".claude/settings.json"), user.to_string()).unwrap();
        let mcp = json!({"mcpServers": {
            "github": {"command": "gh-mcp", "args": ["--token", "${GH_TOKEN}"], "env": {"TOKEN": "${GH_TOKEN}"}},
            "docs": {"type": "http", "url": "https://docs.example/mcp", "headers": {"Authorization": "Bearer ${GH_TOKEN}"}},
            "events": {"type": "sse", "url": "https://events.example/sse"},
            "off": {"command": "off-mcp"},
            "unset": {"command": "x", "env": {"K": "${NOT_SET}"}},
            "socket": {"type": "ws", "url": "wss://x"}
        }});
        fs::write(d.join(".mcp.json"), mcp.to_string()).unwrap();
        Some((home, d))
    }

    #[test]
    fn only_servers_the_person_approved_in_a_trusted_folder_are_handed_on() {
        let Some((home, d)) = setup("acpmcp-approved", true, json!({"enableAllProjectMcpServers": true})) else { return };
        let a = approved(&home, &d, &env);
        // every approved server Claude Code would connect; not the one the person turned off, not one whose variable is unset
        assert_eq!(a.names(), vec!["docs", "events", "github"]);
        let all = a.for_agent(true, true);
        assert_eq!(all[2], json!({"name": "github", "command": "gh-mcp", "args": ["--token", SECRET], "env": [{"name": "TOKEN", "value": SECRET}]}));
        assert_eq!(all[0], json!({"type": "http", "name": "docs", "url": "https://docs.example/mcp", "headers": [{"name": "Authorization", "value": format!("Bearer {SECRET}")}]}));
        assert_eq!(all[1], json!({"type": "sse", "name": "events", "url": "https://events.example/sse", "headers": []}));
        // an agent that takes no HTTP or SSE servers gets stdio only, as the protocol says every agent takes
        assert_eq!(a.for_agent(false, false).as_array().unwrap().len(), 1);
        // nothing of a value is in how it is printed
        assert_eq!(format!("{a:?}"), "Approved(3 servers)");
        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn an_untrusted_folder_or_no_approval_hands_on_nothing() {
        let Some((home, d)) = setup("acpmcp-untrusted", false, json!({"enableAllProjectMcpServers": true})) else { return };
        assert!(approved(&home, &d, &env).is_empty(), "a folder Claude Code was never told to trust");
        let _ = fs::remove_dir_all(&home);
        let Some((home, d)) = setup("acpmcp-none", true, json!({})) else { return };
        assert!(approved(&home, &d, &env).is_empty(), "trusted, but no server approved");
        // the person's own local settings at the root, while git does not track them, approve one by name
        fs::create_dir_all(d.join(".claude")).unwrap();
        fs::write(d.join(".claude/settings.local.json"), r#"{"enabledMcpjsonServers":["github","off"]}"#).unwrap();
        assert_eq!(approved(&home, &d, &env).names(), vec!["github"]);
        // the same file committed is the repository's, and a repository never approves its own servers
        sh(&d, &["add", "-f", ".claude/settings.local.json", ".mcp.json"]);
        sh(&d, &["commit", "-q", "-m", "repo approves itself"]);
        assert!(approved(&home, &d, &env).is_empty());
        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn a_lane_reads_its_own_mcp_json_and_the_developers_trust_and_approvals() {
        let Some((home, d)) = setup("acpmcp-lane", true, json!({})) else { return };
        fs::write(d.join(".gitignore"), "node_modules/\n.mcp.json\n").unwrap();
        sh(&d, &["add", ".gitignore"]);
        sh(&d, &["commit", "-q", "-m", "ignore"]);
        fs::create_dir_all(d.join(".claude")).unwrap();
        fs::write(d.join(".claude/settings.local.json"), r#"{"enabledMcpjsonServers":["github"]}"#).unwrap();
        let made = crate::lane::make(&home, &d, &crate::lane::tests::names(&["kit/acp"])).unwrap();
        let wt = PathBuf::from(&made.worktree);
        assert!(wt.join(".mcp.json").exists(), "the lane brought it");
        assert_eq!(approved(&home, &wt, &env).names(), vec!["github"]);
        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn a_folder_with_no_mcp_json_or_no_home_state_hands_on_nothing() {
        let Some((home, d)) = repo("acpmcp-empty") else { return };
        assert!(approved(&home, &d, &env).is_empty());
        fs::write(d.join(".mcp.json"), r#"{"mcpServers":{"x":{"command":"x"}}}"#).unwrap();
        assert!(approved(&home, &d, &env).is_empty(), "no .claude.json: nothing is trusted");
        fs::write(d.join(".mcp.json"), "not json").unwrap();
        assert!(approved(&home, &d, &env).is_empty());
        let _ = fs::remove_dir_all(home);
    }
}
