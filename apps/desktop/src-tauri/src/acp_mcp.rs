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
//! A lane's `.mcp.json` is the lane's own file, which its agent can change, while the person approved each server by name in
//! their own folder, where they saw its entry (item 89, security review of 26 Nov 2026). So in a lane a server is handed on
//! only when its whole entry, canonical JSON with its keys sorted and its `${VAR}`s as written, has the same SHA-256 digest as
//! the entry of that name in the developer's folder at the same place ([`entry_digest`]): another command, argument,
//! variable, address, header or kind, or a server the developer's folder does not have, starts nothing, and the chat says
//! which servers the lane's entry differs for ([`Approved::differs`]). A session in the developer's own folder reads the
//! entries the person approved there, as Claude Code does.
//!
//! The same entry can still run the lane's files (item 114): the agent starts its servers in the lane's folder, so
//! `node ./mcp/server.js` names the lane's copy, which its agent can change. In a lane a stdio server whose program, words or
//! variables reach into its working folder is not started either, and the chat names it ([`runs_the_lane`],
//! [`Approved::lane_files`]).
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

/// The approved servers of one session, the names of the approved ones a lane's entry differs for, and the names of the
/// approved ones that would run the lane's own files (item 114, [`runs_the_lane`]); neither of the last two is handed on. Its
/// `Debug` says how many and nothing else, so a value can never reach a log.
#[derive(Clone, Default, PartialEq, Eq)]
pub struct Approved(Vec<Server>, Vec<String>, Vec<String>);

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

    /// No server, and `names` as the approved ones a lane's entry differs for, for another module's test.
    #[cfg(test)]
    pub(crate) fn differing(names: &[&str]) -> Approved {
        Approved(Vec::new(), names.iter().map(|n| n.to_string()).collect(), Vec::new())
    }

    /// No server, and `names` as the approved ones that would run the lane's own files, for another module's test.
    #[cfg(test)]
    pub(crate) fn lane_files_of(names: &[&str]) -> Approved {
        Approved(Vec::new(), Vec::new(), names.iter().map(|n| n.to_string()).collect())
    }

    /// The names of the servers the person approved whose entry in this lane is not the one in the developer's folder:
    /// not started, and named to the person (a name only, never a value).
    pub fn differs(&self) -> &[String] {
        &self.1
    }

    /// The names of the servers the person approved that, in this lane, would run the lane's own files (item 114): not
    /// started, and named to the person (a name only, never a value).
    pub fn lane_files(&self) -> &[String] {
        &self.2
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

/// Programs that run what their working folder's own files name, whatever the words after them say (item 114): package
/// managers and the runtimes that read a project file or a local package first (`npx` runs `node_modules/.bin` before the
/// registry, `uv` and `uvx` read `uv.toml` and `pyproject.toml`, `bun` reads `bunfig.toml`, `deno` reads `deno.json`, `tsx`
/// `tsconfig.json`), task runners and build tools (`make`, `cargo` reads `.cargo/config.toml`, `go` reads `go.work`), `git`
/// (the lane's own config), shells and wrappers (a line or a program this reader does not read as a command). A program named
/// here is matched by its file name, wherever it is.
const RUN_THE_FOLDER: [&str; 47] = [
    "npm", "npx", "pnpm", "pnpx", "yarn", "yarnpkg", "bun", "bunx", "deno", "corepack", "tsx", "ts-node", "uv", "uvx", "poetry", "pipenv", "pdm", "hatch", "rye", "pixi", "make", "gmake", "just", "task", "cargo", "go", "mvn", "gradle", "dotnet", "bundle", "bundler", "rake", "composer", "git", "sh",
    "bash", "zsh", "dash", "ksh", "fish", "pwsh", "powershell", "cmd", "env", "xargs", "sudo", "nohup",
];

/// Node's options whose value is a module it loads, resolved from the working folder's `node_modules` when it is a bare name,
/// or inline code (whose `require` resolves there too).
const NODE_LOADS: [&str; 11] = ["-r", "--require", "--import", "--loader", "--experimental-loader", "--env-file", "--env-file-if-exists", "-e", "--eval", "-p", "--print"];

/// The program's own name: the file name, lower case, without a Windows ending.
fn program(command: &str) -> String {
    let base = command.rsplit(['/', '\\']).next().unwrap_or(command).to_ascii_lowercase();
    [".exe", ".cmd", ".bat", ".ps1"].iter().find_map(|e| base.strip_suffix(e).map(str::to_string)).unwrap_or(base)
}

/// `p` (absolute) is the lane's folder or inside it, read as it is written (`..` taken out) and as the disk has it.
fn inside(p: &Path, lane: &Path) -> bool {
    let mut plain = PathBuf::new();
    for c in p.components() {
        match c {
            std::path::Component::ParentDir => {
                plain.pop();
            }
            std::path::Component::CurDir => {}
            other => plain.push(other),
        }
    }
    let real = |x: &Path| x.canonicalize().unwrap_or_else(|_| x.to_path_buf());
    plain.starts_with(lane) || real(&plain).starts_with(real(lane)) || plain.starts_with(real(lane))
}

/// Whether the word `w` (an argument, or a part of one, or of a variable's value) names something of the lane's: an
/// absolute path inside it, a path that starts from the working folder (`.`, `..`, `./x`, `../x`), or a relative name whose
/// first part is there, in the session's folder or at the lane's top (`mcp/server.js`, `server.py`). An option names what its
/// value after `=` names. An address (`scheme://`) names nothing of the lane's, but a `file://` one names its path.
fn names_lane(w: &str, lane: &Path, cwd: &Path) -> bool {
    let w = w.trim();
    if w.is_empty() {
        return false;
    }
    if let Some(rest) = w.strip_prefix("file://") {
        return names_lane(rest, lane, cwd);
    }
    if w.contains("://") {
        return false;
    }
    if w.starts_with('-') {
        return w.split_once('=').is_some_and(|(_, v)| names_lane(v, lane, cwd));
    }
    let p = Path::new(w);
    if p.is_absolute() {
        return inside(p, lane);
    }
    if w == "." || w == ".." || ["./", "../", ".\\", "..\\"].iter().any(|s| w.starts_with(s)) {
        return true;
    }
    match p.components().next() {
        Some(std::path::Component::Normal(first)) => [cwd, lane].iter().any(|at| std::fs::symlink_metadata(at.join(first)).is_ok()),
        _ => true,
    }
}

/// Whether any part of `text`, split at spaces, `=`, `:`, `,` and `;`, names something of the lane's ([`names_lane`]): a
/// container's bind mount (`.:/app`, `src=.`) or a variable's list of folders is read part by part. An address is read
/// whole.
fn any_part_names_lane(text: &str, lane: &Path, cwd: &Path) -> bool {
    text.split_whitespace().any(|w| names_lane(w, lane, cwd) || (!w.contains("://") && w.split(['=', ':', ',', ';']).any(|part| names_lane(part, lane, cwd))))
}

/// Node's words (its arguments, or `NODE_OPTIONS`'s) that load a module or run inline code: a value that is not an absolute
/// path outside the lane is read from the working folder ([`NODE_LOADS`]).
fn node_loads_lane(words: &[&str], lane: &Path) -> bool {
    let outside = |v: &str| Path::new(v).is_absolute() && !inside(Path::new(v), lane);
    let mut iter = words.iter();
    while let Some(w) = iter.next() {
        if NODE_LOADS.contains(w) {
            if !iter.next().is_some_and(|v| outside(v)) {
                return true;
            }
        } else if let Some((opt, v)) = w.split_once('=') {
            if NODE_LOADS.contains(&opt) && !outside(v) {
                return true;
            }
        }
    }
    false
}

/// Agent names other programs share, which `fg.rs` counts only in a known install place (so a terminal's row never shows a
/// wrong mark). Here a wrong guess only keeps a server from starting in a lane, so each counts by its name alone.
const SHARED_AGENT_NAMES: [&str; 3] = ["grok", "pi", "dsh"];

/// Whether a stdio server's `command` with `args` is an agent's own CLI (item 118): started by the agent in a lane's folder, it
/// reads that folder's own agent settings as its project's (Claude Code's `.claude/settings.json` and its hooks, Codex's
/// `.codex/config.toml`, OpenCode's `opencode.json`), which the lane's agent can change. Read as `fg.rs` reads which agent
/// runs in a terminal ([`crate::fg::agent_for_process`]: the agents the app starts and the few a person runs themselves, by
/// install place, by name, and for `node` and the other interpreters by the script they run), from the program's real path,
/// found on `PATH` when it is named alone, so a link of another name leads to the agent it is.
fn an_agents_cli(command: &str, args: &[String], env: &dyn Fn(&str) -> Option<String>) -> bool {
    let real = |p: &Path| p.canonicalize().ok().map(|r| r.to_string_lossy().into_owned());
    let found = if command.contains(['/', '\\']) {
        real(Path::new(command))
    } else {
        env("PATH").and_then(|path| std::env::split_paths(&path).map(|d| d.join(command)).find(|c| c.is_file()).and_then(|c| real(&c)))
    };
    let argv: Vec<&str> = std::iter::once(command).chain(args.iter().map(String::as_str)).collect();
    let script_real = |s: &str| real(Path::new(s));
    let named = SHARED_AGENT_NAMES.contains(&program(command).as_str());
    named || crate::fg::agent_for_process(found.as_deref().unwrap_or(command), &argv, script_real).is_some() || crate::fg::agent_for_exe(command).is_some()
}

/// Whether stdio server `s`, started by the agent in a lane's folder `cwd` (the lane's top being `lane`), would run what the
/// lane's agent can change (item 114). The entry is the one the person approved in their own folder, but there its words
/// named the developer's files; here they name the lane's. So it is not started when:
///
/// - its program is named by a path from the working folder (`./bin/mcp`, `bin/mcp`), or inside the lane by its whole path,
///   or found through a `PATH` with a relative or empty entry;
/// - its program runs what its working folder's own files name ([`RUN_THE_FOLDER`]); `python` with `-m` or `-c` (which put the
///   working folder first on the module path); `node` loading a module or inline code ([`node_loads_lane`]); `docker` or
///   `podman` with `compose` or `build` (the folder's compose file or build context);
/// - any argument, or any part of one, names something of the lane's ([`names_lane`]);
/// - any variable's value does, or `NODE_OPTIONS` loads a module, or a variable whose name ends in `PATH` or `LIB` has an
///   empty entry (the working folder);
/// - it is an agent's own CLI, which reads the lane's own agent settings ([`an_agents_cli`], item 118).
///
/// An address (HTTP, SSE) starts no program here. What this cannot see: a program that reads its working folder by itself
/// (a server that loads `./config.js` with no word naming it). `docs/code-editor.md` lists the class.
fn runs_the_lane(s: &Server, lane: &Path, cwd: &Path, env: &dyn Fn(&str) -> Option<String>) -> bool {
    let Transport::Stdio { command, args, env: vars } = &s.how else { return false };
    if command.contains(['/', '\\']) {
        let p = Path::new(command);
        if !p.is_absolute() || inside(p, lane) {
            return true;
        }
    } else if env("PATH").is_some_and(|path| std::env::split_paths(&path).any(|d| !d.is_absolute())) {
        return true;
    }
    let name = program(command);
    let words: Vec<&str> = args.iter().map(String::as_str).collect();
    let python = name.starts_with("python") && words.iter().any(|w| w.starts_with('-') && !w.starts_with("--") && w.contains(['m', 'c']));
    let node = matches!(name.as_str(), "node" | "nodejs") && node_loads_lane(&words, lane);
    let container = matches!(name.as_str(), "docker" | "podman" | "nerdctl") && words.iter().any(|w| matches!(*w, "compose" | "build" | "buildx"));
    if RUN_THE_FOLDER.contains(&name.as_str()) || python || node || container || an_agents_cli(command, args, env) {
        return true;
    }
    if words.iter().any(|w| any_part_names_lane(w, lane, cwd)) {
        return true;
    }
    vars.iter().any(|(k, v)| {
        let k = k.to_ascii_uppercase();
        let listed = (k.ends_with("PATH") || k.ends_with("LIB")) && v.split([':', ';']).any(|part| part.trim().is_empty());
        let node_opts = k == "NODE_OPTIONS" && node_loads_lane(&v.split_whitespace().collect::<Vec<_>>(), lane);
        listed || node_opts || any_part_names_lane(v, lane, cwd)
    })
}

/// The servers to hand an ACP agent working in `cwd`: see the module's note. `home` is the person's home folder and `env`
/// this app's environment (the agent's own, which it inherits), read for `CLAUDE_CONFIG_DIR` and the `${VAR}`s.
pub fn approved(home: &Path, cwd: &Path, env: &dyn Fn(&str) -> Option<String>) -> Approved {
    let p = project(home, cwd, env);
    let mut out = Vec::new();
    let mut differs = Vec::new();
    let mut lane_files = Vec::new();
    for (name, v) in p.servers.iter() {
        if out.len() >= MAX_SERVERS || p.state(name) != "on" {
            continue;
        }
        if !p.is_approved_entry(name, v) {
            differs.push(name.clone());
            continue;
        }
        if let Some(s) = server(name, v, env) {
            // in a lane, an approved entry that would run what the lane's agent can change is not started (item 114)
            if p.lane.as_deref().is_some_and(|lane| runs_the_lane(&s, lane, cwd, env)) {
                lane_files.push(name.clone());
                continue;
            }
            out.push(s);
        }
    }
    Approved(out, differs, lane_files)
}

/// `v` as canonical JSON: every object's keys sorted, at every depth, and nothing else changed, so two entries that differ
/// only in key order or spacing are the same entry and any other difference is not.
fn canonical(v: &Value) -> String {
    fn put(v: &Value, out: &mut String) {
        match v {
            Value::Object(o) => {
                let mut keys: Vec<&String> = o.keys().collect();
                keys.sort();
                out.push('{');
                for (i, k) in keys.into_iter().enumerate() {
                    if i > 0 {
                        out.push(',');
                    }
                    out.push_str(&Value::String(k.clone()).to_string());
                    out.push(':');
                    put(&o[k], out);
                }
                out.push('}');
            }
            Value::Array(a) => {
                out.push('[');
                for (i, x) in a.iter().enumerate() {
                    if i > 0 {
                        out.push(',');
                    }
                    put(x, out);
                }
                out.push(']');
            }
            other => out.push_str(&other.to_string()),
        }
    }
    let mut out = String::new();
    put(v, &mut out);
    out
}

/// The SHA-256 digest, in hex, of server entry `v` as canonical JSON ([`canonical`]), with its `${VAR}`s as written: what
/// the person's approval of a server by name in their own folder is held to in a lane.
pub(crate) fn entry_digest(v: &Value) -> String {
    use sha2::{Digest, Sha256};
    Sha256::digest(canonical(v).as_bytes()).iter().map(|b| format!("{b:02x}")).collect()
}

/// Claude Code's own state file: `.claude.json` in `CLAUDE_CONFIG_DIR` when that is set, else in the home folder.
pub(crate) fn claude_state(home: &Path, env: &dyn Fn(&str) -> Option<String>) -> Value {
    let claude = crate::past_chats::cli_home(home, "claude", &[], env).unwrap_or_else(|| home.join(".claude"));
    let file = if env("CLAUDE_CONFIG_DIR").is_some_and(|v| !v.is_empty()) { claude.join(".claude.json") } else { home.join(".claude.json") };
    read_json(&file, MAX_STATE).unwrap_or(Value::Null)
}

/// A project's `.mcp.json` as Claude Code reads it there: its servers (their whole entries, kept in the shell), the
/// repository's root, whether the folder is trusted, and what the person's own settings approve or turn off.
pub(crate) struct ProjectMcp {
    pub servers: serde_json::Map<String, Value>,
    /// Claude Code's entry for the repository's root in its state file (`Value::Null` when there is none)
    pub entry: Value,
    trusted: bool,
    all: bool,
    enabled: BTreeSet<String>,
    disabled: BTreeSet<String>,
    /// For a session outside the developer's own folder (a lane): the digest of each server's entry in the developer's
    /// folder at the same place, the entries the person approved by name. `None` in the developer's folder itself.
    approved_digests: Option<std::collections::BTreeMap<String, String>>,
    /// For a session in a lane: the lane's top folder, which its agent can change (item 114). `None` in the developer's folder.
    lane: Option<PathBuf>,
}

impl ProjectMcp {
    /// Whether server `name`'s entry `v` here is the one the person approved: in their own folder, it is; in a lane, only
    /// when its digest is that of the entry of the same name in the developer's folder, which must have one.
    pub fn is_approved_entry(&self, name: &str, v: &Value) -> bool {
        match &self.approved_digests {
            None => true,
            Some(d) => d.get(name).is_some_and(|x| *x == entry_digest(v)),
        }
    }

    /// `on` (Claude Code connects it), `off` (the person turned it off) or `ask` (it waits for their yes in Claude Code).
    pub fn state(&self, name: &str) -> &'static str {
        if self.disabled.contains(name) {
            "off"
        } else if self.trusted && (self.all || self.enabled.contains(name)) {
            "on"
        } else {
            "ask"
        }
    }
}

/// [`ProjectMcp`] for a session in `cwd`: the session folder's `.mcp.json`, else the work tree's top's; trust and the
/// folder's entry under the root of the repository's first checkout (a lane's developer folder); approvals from the
/// person's user settings, that entry, and the root's `.claude/settings.local.json` while git does not track it.
pub(crate) fn project(home: &Path, cwd: &Path, env: &dyn Fn(&str) -> Option<String>) -> ProjectMcp {
    let place = Place::of(home, cwd);
    let file = [cwd.join(".mcp.json"), place.top.join(".mcp.json")].into_iter().find(|p| p.is_file());
    let servers = file.and_then(|f| read_json(&f, MAX_FILE)).and_then(|v| v.get("mcpServers").and_then(Value::as_object).cloned()).unwrap_or_default();
    let mut p = ProjectMcp { servers, entry: Value::Null, trusted: false, all: false, enabled: BTreeSet::new(), disabled: BTreeSet::new(), approved_digests: None, lane: None };
    if p.servers.is_empty() {
        return p;
    }
    p.approved_digests = developer_digests(&place, cwd);
    p.lane = p.approved_digests.as_ref().map(|_| place.top.clone());
    let state = claude_state(home, env);
    let keys: Vec<String> = [place.root.clone(), place.root.canonicalize().unwrap_or_else(|_| place.root.clone())].iter().map(|p| p.to_string_lossy().into_owned()).collect();
    p.entry = state.get("projects").and_then(Value::as_object).and_then(|ps| keys.iter().find_map(|k| ps.get(k))).cloned().unwrap_or(Value::Null);
    p.trusted = p.entry.get("hasTrustDialogAccepted").and_then(Value::as_bool) == Some(true);
    // the person's own settings only: their user settings, and the root's local settings while git does not track them
    let claude = crate::past_chats::cli_home(home, "claude", &[], env).unwrap_or_else(|| home.join(".claude"));
    let local_rel = ".claude/settings.local.json";
    let mut sources = vec![read_json(&claude.join("settings.json"), MAX_FILE).unwrap_or(Value::Null), p.entry.clone()];
    if !place.tracked(local_rel) {
        sources.push(read_json(&place.root.join(local_rel), MAX_FILE).unwrap_or(Value::Null));
    }
    p.all = sources.iter().any(|s| s.get("enableAllProjectMcpServers").and_then(Value::as_bool) == Some(true));
    p.enabled = sources.iter().flat_map(|s| strings(s.get("enabledMcpjsonServers"))).collect();
    p.disabled = sources.iter().flat_map(|s| strings(s.get("disabledMcpjsonServers"))).collect();
    p
}

/// For a session in a folder other than the developer's own (a lane, a linked worktree), the digest of each server entry in
/// the developer's folder at the same place: its `.mcp.json` in the folder that matches the session's, else at its top, as the
/// lane's own is read. `None` in the developer's own folder. A developer's folder with no `.mcp.json`, or one that cannot be
/// read, gives an empty list, so no lane's server is handed on.
fn developer_digests(place: &Place, cwd: &Path) -> Option<std::collections::BTreeMap<String, String>> {
    let real = |p: &Path| p.canonicalize().unwrap_or_else(|_| p.to_path_buf());
    let (top, root) = (real(&place.top), real(&place.root));
    if top == root {
        return None;
    }
    let below = real(cwd).strip_prefix(&top).ok().map(Path::to_path_buf);
    let file = [below.map(|b| root.join(b).join(".mcp.json")), Some(root.join(".mcp.json"))].into_iter().flatten().find(|p| p.is_file());
    let servers = file.and_then(|f| read_json(&f, MAX_FILE)).and_then(|v| v.get("mcpServers").and_then(Value::as_object).cloned()).unwrap_or_default();
    Some(servers.iter().map(|(n, v)| (n.clone(), entry_digest(v))).collect())
}

/// The root of the repository `cwd` is in (its first checkout's folder), or `cwd` outside one: where Claude Code keeps a
/// folder's own state.
pub(crate) fn repository_root(home: &Path, cwd: &Path) -> PathBuf {
    Place::of(home, cwd).root
}

/// A JSON file of at most `max` bytes, read for another module of the shell.
pub(crate) fn read_json_file(path: &Path, max: u64) -> Option<Value> {
    read_json(path, max)
}

/// Every server of a `.mcp.json` body as if approved, for another module's test.
#[cfg(test)]
pub(crate) fn all_of(mcp: &Value, env: &dyn Fn(&str) -> Option<String>) -> Approved {
    Approved(mcp.get("mcpServers").and_then(Value::as_object).into_iter().flatten().filter_map(|(n, v)| server(n, v, env)).collect(), Vec::new(), Vec::new())
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

    /// Item 89 (security review, 26 Nov 2026). The person approves a project's server by its name, in their own folder, where
    /// they saw its entry; a lane's `.mcp.json` is a file of the lane's, which its agent can change. So a lane's server is
    /// handed on only when its whole entry is the one in the developer's folder at the same place: any change to what it runs,
    /// with what, where it connects or with which headers, and any server the developer's folder does not have, starts
    /// nothing. The cases are the ways an entry can be changed, one at a time.
    #[test]
    fn a_lanes_server_is_handed_on_only_when_its_whole_entry_is_the_approved_one() {
        let Some((home, d)) = setup("acpmcp-digest", true, json!({})) else { return };
        fs::write(d.join(".gitignore"), "node_modules/\n.mcp.json\n").unwrap();
        sh(&d, &["add", ".gitignore"]);
        sh(&d, &["commit", "-q", "-m", "ignore"]);
        fs::create_dir_all(d.join(".claude")).unwrap();
        // approved by name: three servers the developer's folder has, and one name it does not have
        fs::write(d.join(".claude/settings.local.json"), r#"{"enabledMcpjsonServers":["github","docs","events","fresh"]}"#).unwrap();
        let made = crate::lane::make(&home, &d, &crate::lane::tests::names(&["kit/digest"])).unwrap();
        let wt = PathBuf::from(&made.worktree);
        let original: Value = serde_json::from_str(&fs::read_to_string(wt.join(".mcp.json")).unwrap()).unwrap();
        let env_with = |k: &str| match k {
            "OTHER_TOKEN" => Some("other".to_string()),
            _ => env(k),
        };
        // as the lane brought it, all three approved servers go on, and nothing differs
        assert_eq!(approved(&home, &wt, &env_with).names(), vec!["docs", "events", "github"]);
        assert!(approved(&home, &wt, &env_with).differs().is_empty());
        // the same entries with their keys in another order and other spacing are the same entries
        let reordered = r#"{ "mcpServers": { "events": {"url": "https://events.example/sse", "type": "sse"}, "docs": {"headers": {"Authorization": "Bearer ${GH_TOKEN}"}, "url": "https://docs.example/mcp", "type": "http"}, "github": {"env": {"TOKEN": "${GH_TOKEN}"}, "args": ["--token", "${GH_TOKEN}"], "command": "gh-mcp"} } }"#;
        fs::write(wt.join(".mcp.json"), reordered).unwrap();
        assert_eq!(approved(&home, &wt, &env_with).names(), vec!["docs", "events", "github"]);
        let cases: Vec<(&str, &str, Value)> = vec![
            ("another command", "github", json!({"command": "/bin/sh", "args": ["--token", "${GH_TOKEN}"], "env": {"TOKEN": "${GH_TOKEN}"}})),
            ("another argument", "github", json!({"command": "gh-mcp", "args": ["-c", "${GH_TOKEN}"], "env": {"TOKEN": "${GH_TOKEN}"}})),
            ("an argument more", "github", json!({"command": "gh-mcp", "args": ["--token", "${GH_TOKEN}", "--exec=/bin/sh"], "env": {"TOKEN": "${GH_TOKEN}"}})),
            ("an argument fewer", "github", json!({"command": "gh-mcp", "args": ["--token"], "env": {"TOKEN": "${GH_TOKEN}"}})),
            ("another variable's value", "github", json!({"command": "gh-mcp", "args": ["--token", "${GH_TOKEN}"], "env": {"TOKEN": "${OTHER_TOKEN}"}})),
            ("a variable more", "github", json!({"command": "gh-mcp", "args": ["--token", "${GH_TOKEN}"], "env": {"TOKEN": "${GH_TOKEN}", "NODE_OPTIONS": "--require /tmp/x.js"}})),
            ("no environment", "github", json!({"command": "gh-mcp", "args": ["--token", "${GH_TOKEN}"]})),
            ("a key the app does not read", "github", json!({"command": "gh-mcp", "args": ["--token", "${GH_TOKEN}"], "env": {"TOKEN": "${GH_TOKEN}"}, "cwd": "/"})),
            ("its kind named outright", "github", json!({"type": "stdio", "command": "gh-mcp", "args": ["--token", "${GH_TOKEN}"], "env": {"TOKEN": "${GH_TOKEN}"}})),
            ("another address", "docs", json!({"type": "http", "url": "https://hostile.example/mcp", "headers": {"Authorization": "Bearer ${GH_TOKEN}"}})),
            ("a header more", "docs", json!({"type": "http", "url": "https://docs.example/mcp", "headers": {"Authorization": "Bearer ${GH_TOKEN}", "X-Forward": "https://hostile.example"}})),
            ("another kind of server", "docs", json!({"type": "sse", "url": "https://docs.example/mcp", "headers": {"Authorization": "Bearer ${GH_TOKEN}"}})),
            ("a stdio server under an address's name", "events", json!({"command": "/bin/sh", "args": ["-c", "id"]})),
            ("a server only the lane has, approved by its name", "fresh", json!({"command": "/bin/sh", "args": ["-c", "id"]})),
        ];
        for (what, name, entry) in cases {
            let mut m = original.clone();
            m["mcpServers"][name] = entry;
            fs::write(wt.join(".mcp.json"), m.to_string()).unwrap();
            let got = approved(&home, &wt, &env_with);
            assert!(!got.names().contains(&name.to_string()), "{what}: {:?}", got.names());
            // and the chat is told which server's entry differs, by its name alone
            assert_eq!(got.differs(), [name.to_string()], "{what}");
            assert!(!format!("{got:?}").contains("hostile") && !format!("{got:?}").contains("/bin/sh"), "{what}");
            // every other approved server is still handed on
            let others: Vec<String> = ["docs", "events", "github"].iter().filter(|n| **n != name).map(|n| n.to_string()).collect();
            assert_eq!(got.names(), others, "{what}");
        }
        // a lane folder's own `.mcp.json` below the top is held to the developer's at that place, else at the top
        fs::write(wt.join(".mcp.json"), original.to_string()).unwrap();
        let sub = wt.join("apps").join("web");
        fs::create_dir_all(&sub).unwrap();
        let mut m = original.clone();
        m["mcpServers"]["github"]["command"] = json!("/bin/sh");
        fs::write(sub.join(".mcp.json"), m.to_string()).unwrap();
        assert_eq!(approved(&home, &sub, &env_with).names(), vec!["docs", "events"]);
        fs::write(sub.join(".mcp.json"), original.to_string()).unwrap();
        assert_eq!(approved(&home, &sub, &env_with).names(), vec!["docs", "events", "github"]);
        // the developer's own folder is unchanged: what the person approved there is handed on
        assert_eq!(approved(&home, &d, &env_with).names(), vec!["docs", "events", "github"]);
        assert!(approved(&home, &d, &env_with).differs().is_empty());
        // a developer's folder without the file (moved away) leaves a lane nothing to compare with: nothing is handed on
        fs::rename(d.join(".mcp.json"), d.join("mcp.json.away")).unwrap();
        let got = approved(&home, &wt, &env_with);
        assert!(got.is_empty(), "{:?}", got.names());
        assert_eq!(got.differs(), ["docs".to_string(), "events".to_string(), "github".to_string()]);
        fs::rename(d.join("mcp.json.away"), d.join(".mcp.json")).unwrap();
        // the digest is of the entry as written: key order is not part of it, anything else is
        assert_eq!(entry_digest(&json!({"command": "a", "args": ["b"]})), entry_digest(&json!({"args": ["b"], "command": "a"})));
        assert_ne!(entry_digest(&json!({"command": "a", "args": ["b"]})), entry_digest(&json!({"command": "a", "args": ["b", "c"]})));
        assert_ne!(entry_digest(&json!({"command": "a", "env": {"K": "${A}"}})), entry_digest(&json!({"command": "a", "env": {"K": "${B}"}})));
        assert_eq!(entry_digest(&json!({"command": "a"})).len(), 64);
        // and it is the standard SHA-256 of the canonical text, so an approval an earlier build recorded still matches
        assert_eq!(entry_digest(&json!({"command": "a"})), "e50e5a32d073f447861d50221b154fd327abf9f59018a003734300292500c2c2");
        let _ = fs::remove_dir_all(home);
    }

    /// Item 114 (third security review, 26 Nov 2026). An approved entry matches the developer's by digest, but what it runs
    /// can still be the LANE's: a script it names, a file or folder an argument names, a package or task its launcher finds
    /// in the working folder, a module a runtime loads from there. The lane's agent can change all of those, so in a lane such
    /// a server is not started (and named). The cases are the ways an entry reaches into its working folder, one at a time;
    /// the ones after them reach nothing of the lane's and still start.
    #[test]
    fn a_lanes_server_that_runs_the_lanes_own_files_is_not_started() {
        let Some((home, d)) = setup("acpmcp-lanefiles", true, json!({"enableAllProjectMcpServers": true})) else { return };
        fs::write(d.join(".gitignore"), "node_modules/\n.mcp.json\n").unwrap();
        sh(&d, &["add", ".gitignore"]);
        sh(&d, &["commit", "-q", "-m", "ignore"]);
        let made = crate::lane::make(&home, &d, &crate::lane::tests::names(&["kit/files"])).unwrap();
        let wt = PathBuf::from(&made.worktree);
        let outside = home.join("tools");
        fs::create_dir_all(&outside).unwrap();
        // what the lane's agent could have written
        for f in ["mcp/server.js", "server.py", "bin/mcp", "hook.js", "cfg.json", "loader.mjs"] {
            fs::create_dir_all(wt.join(f).parent().unwrap()).unwrap();
            fs::write(wt.join(f), "x").unwrap();
        }
        let lane_bin = wt.join("bin/mcp").to_string_lossy().into_owned();
        let abs = outside.join("server.js").to_string_lossy().into_owned();
        let hostile: Vec<(&str, Value)> = vec![
            ("a script named from the working folder", json!({"command": "node", "args": ["./mcp/server.js"]})),
            ("a script named without ./", json!({"command": "node", "args": ["mcp/server.js"]})),
            ("a file name alone that is the lane's", json!({"command": "python3", "args": ["server.py"]})),
            ("a program named from the working folder", json!({"command": "./bin/mcp"})),
            ("a program named by a relative path", json!({"command": "bin/mcp"})),
            ("a program inside the lane by its whole path", json!({"command": lane_bin})),
            ("an option's value that is the lane's file", json!({"command": abs, "args": ["--config=./cfg.json"]})),
            ("the parent folder", json!({"command": abs, "args": [".."]})),
            ("a bind mount of the working folder", json!({"command": "docker", "args": ["run", "-v", ".:/app", "image"]})),
            ("a file name alone after an option", json!({"command": abs, "args": ["--config", "cfg.json"]})),
            ("a file:// address of the lane's file", json!({"command": abs, "args": [format!("file://{}/cfg.json", wt.display())]})),
            ("a wrapper that runs another program", json!({"command": "env", "args": ["FOO=1", "gh-mcp"]})),
            ("a program from a launcher's full path", json!({"command": "/opt/homebrew/bin/npx", "args": ["-y", "x"]})),
            ("a module loaded before the script", json!({"command": "node", "args": ["--import=./loader.mjs", abs]})),
            ("a package module loaded from the folder's node_modules", json!({"command": "node", "args": ["-r", "dotenv/config", abs]})),
            ("a variable that loads the lane's file", json!({"command": "node", "args": [abs], "env": {"NODE_OPTIONS": "--require ./hook.js"}})),
            ("a variable that adds the lane to the module path", json!({"command": abs, "env": {"PYTHONPATH": "."}})),
            ("a module path with an empty entry, which is the working folder", json!({"command": abs, "env": {"PYTHONPATH": "/opt/lib:"}})),
            ("npx, which runs the folder's own package first", json!({"command": "npx", "args": ["-y", "@modelcontextprotocol/server-github"]})),
            ("a package manager's script", json!({"command": "npm", "args": ["run", "mcp"]})),
            ("uv, which reads the folder's project", json!({"command": "uv", "args": ["run", "server"]})),
            ("uvx, which reads the folder's uv settings", json!({"command": "uvx", "args": ["mcp-server-git"]})),
            ("python running a module from the folder", json!({"command": "python3", "args": ["-m", "server"]})),
            ("a task runner", json!({"command": "make", "args": ["mcp"]})),
            ("a shell line", json!({"command": "sh", "args": ["-c", "exec gh-mcp"]})),
            ("docker compose, which reads the folder's compose file", json!({"command": "docker", "args": ["compose", "run", "mcp"]})),
        ];
        let fine: Vec<(&str, Value)> = vec![
            ("a program on the PATH with plain arguments", json!({"command": "gh-mcp", "args": ["--token", "${GH_TOKEN}"]})),
            ("a program outside the lane by its whole path", json!({"command": abs, "args": ["--port", "3000"]})),
            ("a container image, whose name has slashes", json!({"command": "docker", "args": ["run", "-i", "--rm", "ghcr.io/github/github-mcp-server"]})),
            ("an address", json!({"type": "http", "url": "https://docs.example/mcp"})),
        ];
        let mut servers = serde_json::Map::new();
        for (i, (_, e)) in hostile.iter().chain(fine.iter()).enumerate() {
            servers.insert(format!("s{i:02}"), e.clone());
        }
        let mcp = json!({"mcpServers": servers}).to_string();
        // the developer's folder has the very same entries, so each is the one the person approved
        fs::write(d.join(".mcp.json"), &mcp).unwrap();
        fs::write(wt.join(".mcp.json"), &mcp).unwrap();
        let got = approved(&home, &wt, &env);
        for (i, (what, _)) in hostile.iter().enumerate() {
            assert!(!got.names().contains(&format!("s{i:02}")), "{what}: started in the lane");
        }
        for (i, (what, _)) in fine.iter().enumerate() {
            let name = format!("s{:02}", hostile.len() + i);
            assert!(got.names().contains(&name), "{what}: not started");
        }
        // each one not started is named to the chat, by its name alone, apart from the entries that differ
        let expected: Vec<String> = (0..hostile.len()).map(|i| format!("s{i:02}")).collect();
        assert_eq!(got.lane_files(), expected.as_slice());
        assert!(got.differs().is_empty());
        assert!(!format!("{got:?}").contains("server.js"));
        // the developer's own folder is the person's: what they approved there starts, as before
        let mine = approved(&home, &d, &env);
        assert_eq!(mine.names().len(), (hostile.len() + fine.len()).min(MAX_SERVERS));
        assert!(mine.lane_files().is_empty());
        // a PATH with a relative entry finds a program named alone in the working folder: nothing of that kind starts
        let relative_path = |k: &str| if k == "PATH" { Some("node_modules/.bin:/usr/bin".to_string()) } else { env(k) };
        assert!(!approved(&home, &wt, &relative_path).names().contains(&format!("s{:02}", hostile.len())));
        let _ = fs::remove_dir_all(home);
    }

    /// Item 118 (fourth security review, 26 Nov 2026): an approved server that is itself an agent's CLI (`claude mcp serve`,
    /// `codex mcp-server`), started by the agent in a lane's folder, reads that folder's own agent settings as its project's
    /// (hooks in `.claude/settings.json`, `.codex/config.toml`, `opencode.json`), which the lane's agent can change. It is not
    /// started in a lane, however the entry reaches it, and the chat names it as it names the others.
    #[test]
    fn a_lanes_server_that_is_an_agent_s_own_cli_is_not_started() {
        let Some((home, d)) = setup("acpmcp-agentcli", true, json!({"enableAllProjectMcpServers": true})) else { return };
        fs::write(d.join(".gitignore"), "node_modules/\n.mcp.json\n").unwrap();
        sh(&d, &["add", ".gitignore"]);
        sh(&d, &["commit", "-q", "-m", "ignore"]);
        let made = crate::lane::make(&home, &d, &crate::lane::tests::names(&["kit/agentcli"])).unwrap();
        let wt = PathBuf::from(&made.worktree);
        // stand-ins outside the lane for where agents are installed: a native file, npm packages, and links to them
        let bin = home.join("bin");
        let lib = home.join("lib/node_modules");
        for f in ["@anthropic-ai/claude-code/cli.js", "cline/bin/cline", "@google/gemini-cli/dist/index.js", "some-mcp/index.js"] {
            fs::create_dir_all(lib.join(f).parent().unwrap()).unwrap();
            fs::write(lib.join(f), "x").unwrap();
        }
        fs::create_dir_all(&bin).unwrap();
        fs::write(bin.join("claude"), "x").unwrap();
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(bin.join("claude"), bin.join("my-helper")).unwrap();
            std::os::unix::fs::symlink(lib.join("@google/gemini-cli/dist/index.js"), bin.join("ask")).unwrap();
        }
        let p = |x: &Path| x.to_string_lossy().into_owned();
        let mut hostile: Vec<(&str, Value)> = vec![
            ("Claude Code's own MCP server", json!({"command": "claude", "args": ["mcp", "serve"]})),
            ("Codex's own MCP server", json!({"command": "codex", "args": ["mcp-server"]})),
            ("OpenCode", json!({"command": "opencode", "args": ["mcp"]})),
            ("Gemini CLI", json!({"command": "gemini"})),
            ("Cursor's agent", json!({"command": "cursor-agent", "args": ["mcp"]})),
            ("oh-my-pi", json!({"command": "omp"})),
            ("pi, a name other programs share", json!({"command": "pi"})),
            ("Grok, a name other programs share", json!({"command": "grok"})),
            ("Qwen Code", json!({"command": "qwen"})),
            ("Kimi Code", json!({"command": "kimi"})),
            ("Copilot CLI", json!({"command": "copilot"})),
            ("Cline", json!({"command": "cline"})),
            ("Antigravity", json!({"command": "agy"})),
            ("an agent a person runs themselves", json!({"command": "goose", "args": ["mcp"]})),
            ("a Windows ending, in any case", json!({"command": "Codex.EXE", "args": ["mcp-server"]})),
            ("an agent by its whole path", json!({"command": p(&bin.join("claude")), "args": ["mcp", "serve"]})),
            ("node running an agent package's script", json!({"command": "node", "args": [p(&lib.join("@anthropic-ai/claude-code/cli.js")), "mcp", "serve"]})),
            ("node running another agent package's script", json!({"command": "node", "args": [p(&lib.join("cline/bin/cline"))]})),
        ];
        #[cfg(unix)]
        hostile.extend([
            ("a link of another name to an agent, by its whole path", json!({"command": p(&bin.join("my-helper")), "args": ["mcp", "serve"]})),
            ("a link of another name to an agent, found on the PATH", json!({"command": "my-helper", "args": ["mcp", "serve"]})),
            ("a link to an agent package's script, found on the PATH", json!({"command": "ask"})),
        ]);
        let fine: Vec<(&str, Value)> = vec![
            ("a server on the PATH named like no agent", json!({"command": "gh-mcp", "args": ["--token", "${GH_TOKEN}"]})),
            ("node running another package's script outside the lane", json!({"command": "node", "args": [p(&lib.join("some-mcp/index.js"))]})),
            ("an agent's name as a plain word", json!({"command": "gh-mcp", "args": ["--for", "claude"]})),
        ];
        let mut servers = serde_json::Map::new();
        for (i, (_, e)) in hostile.iter().chain(fine.iter()).enumerate() {
            servers.insert(format!("s{i:02}"), e.clone());
        }
        let mcp = json!({"mcpServers": servers}).to_string();
        fs::write(d.join(".mcp.json"), &mcp).unwrap();
        fs::write(wt.join(".mcp.json"), &mcp).unwrap();
        let path = format!("{}:/usr/bin:/bin", bin.display());
        let with_path = |k: &str| if k == "PATH" { Some(path.clone()) } else { env(k) };
        let got = approved(&home, &wt, &with_path);
        for (i, (what, _)) in hostile.iter().enumerate() {
            assert!(!got.names().contains(&format!("s{i:02}")), "{what}: started in the lane");
        }
        for (i, (what, _)) in fine.iter().enumerate() {
            assert!(got.names().contains(&format!("s{:02}", hostile.len() + i)), "{what}: not started");
        }
        // named to the chat by name alone, as a server that runs the lane's files is
        let expected: Vec<String> = (0..hostile.len()).map(|i| format!("s{i:02}")).filter(|n| got.lane_files().contains(n)).collect();
        assert_eq!(expected.len(), hostile.len(), "{:?}", got.lane_files());
        // in the developer's own folder the person's approval stands, as before
        assert!(approved(&home, &d, &with_path).lane_files().is_empty());
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
