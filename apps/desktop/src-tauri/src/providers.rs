//! Settings › Providers (item 74): what a person sets for each coding agent the app knows, kept in ONE file of the
//! app's own, [`store_path`] (`~/.manut/providers.json`), which only [`save`] writes (0600, through a temporary file and a
//! rename, never through a link). The page names an agent id and sends a [`Patch`]; the shell checks it and answers with
//! [`View`]s, which never carry a variable's value.
//!
//! The shell reads the file again at every start, and every stored value is checked again there, so a file changed by
//! hand can never start what the page would refuse:
//!
//! - **Off**: no session of the agent starts ([`may_start`], which `sessions::launch_with` calls for every built-in and
//!   ACP agent, and `agent_chat` for a person's own). Sessions already running are not touched.
//! - **Program path**: it replaces only where the program is found ([`set_program`]). The arguments, the chat mode and the
//!   asks stay the app's, and a path that stopped being a program the person may run starts nothing.
//! - **Home folder**: the agent's own home variable, the one an added account sets (`accounts::home_var`). It is what
//!   "This computer" means for that agent: a session that runs as an added account gets the account's folder instead, and
//!   that account's shared settings are linked from this folder (`accounts::prepare`). A variable of the same name is
//!   refused, so the two never fight.
//! - **Extra arguments** go after every argument the app adds ([`extra_args`]): a value-taking option of theirs at the end
//!   can only fail, never take one of the app's arguments as its value. Each is one argument, never split by a shell, in
//!   the shape `--name`, `--name=value`, `-x` or `-x=value`, so none is a word the agent reads as a command or a prompt.
//!   One that names an option the app sets itself, or one that would let the agent act without asking or outside its
//!   sandbox, is refused by name ([`ARG_RULES`], read from each CLI's own `--help`). An agent whose options were not read
//!   here takes none. Buddy takes none at all.
//! - **Environment variables** reach that agent's chats and terminals only (not Buddy's), before the home and the app's
//!   own variables, which therefore win; a name the app sets itself is refused. Their values are secrets: kept in this file
//!   and handed to the agent's process, never sent back to the page, put in an event or written to a log ([`View`] has
//!   the names only, [`Var`]'s `Debug` hides the value, and a refusal names the variable, never its value).

use std::collections::BTreeMap;
use std::ffi::OsString;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::platform::Os;
use crate::sessions::{Agent, Mode};

/// The file's format version.
pub const VERSION: u64 = 1;
/// The file is read only up to this size.
const FILE_MAX: u64 = 256 * 1024;
/// A display name's length cap, in characters.
pub const NAME_MAX: usize = 40;
/// A program path's or a home folder's length cap.
pub const PATH_MAX: usize = 1024;
/// At most this many extra arguments per agent.
pub const MAX_ARGS: usize = 16;
/// One extra argument's length cap.
pub const ARG_MAX: usize = 512;
/// At most this many environment variables per agent.
pub const MAX_VARS: usize = 32;
/// A variable name's length cap.
pub const VAR_NAME_MAX: usize = 128;
/// A variable value's length cap.
pub const VAR_VALUE_MAX: usize = 8192;

/// One environment variable a person set for an agent. Its `Debug` never prints the value, so no `{:?}` can log it.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Var {
    pub name: String,
    pub value: String,
}

impl std::fmt::Debug for Var {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Var").field("name", &self.name).field("value", &"<hidden>").finish()
    }
}

/// What the file keeps for one agent. Every field is optional in the file; empty means the app's own way.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct Stored {
    /// Turned off: offered nowhere, and no session of it starts.
    pub off: bool,
    /// The name the page shows instead of the agent's own ("" = its own).
    pub name: String,
    /// An absolute path to the program ("" = found as always).
    pub path: String,
    /// The agent's home folder, as its home variable ("" = the CLI's own default).
    pub home: String,
    /// Arguments added after every argument the app adds.
    pub args: Vec<String>,
    /// Variables for this agent's chats and terminals.
    pub env: Vec<Var>,
}

/// Why a setting was refused. The page words each code (`prov.why.<code>`); a refusal names the argument's option or the
/// variable's name ([`Refusal`]), never a value.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Why {
    /// not an agent the app knows
    Unknown,
    /// the display name is too long or holds a character other than letters, digits, space and `.-_+`
    Name,
    /// the path is not absolute, too long, or holds a control character or a `..`
    PathShape,
    /// nothing is at that path, or it is not a file this account may run
    PathRun,
    /// this agent has no program of its own to set (a person's own agent keeps its own entry)
    PathNone,
    /// the home folder is not absolute, too long, or holds a control character or a `..`
    HomeShape,
    /// the home folder is not an existing folder
    HomeMissing,
    /// this agent has no home variable here
    HomeNone,
    /// an argument is not `--name`, `--name=value`, `-x` or `-x=value`, holds a control character or is too long
    ArgShape,
    /// an argument would let the agent act without asking, or outside its sandbox
    ArgSkips,
    /// an argument names an option the app sets itself (the chat mode, the conversation, the folder, the asks' path)
    ArgOwn,
    /// more than [`MAX_ARGS`] arguments
    ArgMany,
    /// this agent's options were not read here, so it takes no extra arguments
    ArgUnchecked,
    /// an argument holds a character Windows' `cmd.exe` would read as a command (an agent started through a `.cmd` shim)
    ArgCmd,
    /// a variable name is not `^[A-Za-z_][A-Za-z0-9_]*$`, is too long, or is there twice
    VarName,
    /// a variable the app sets itself, or one that sets the agent's sandbox or asks
    VarOwn,
    /// the agent's home variable: the home folder field sets it
    VarHome,
    /// more than [`MAX_VARS`] variables
    VarMany,
    /// a value is too long or holds a NUL
    VarValue,
    /// a variable kept from before is not in the file any more (its value was never sent to the page)
    VarKeep,
    /// this agent takes no variables here
    VarNone,
    /// the file could not be read or written; nothing was changed
    File,
}

impl Why {
    pub fn code(self) -> String {
        serde_json::to_value(self).ok().and_then(|v| v.as_str().map(str::to_string)).unwrap_or_default()
    }
}

/// A refusal: the reason, and the option or variable name it is about ("" when it is about the whole field).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Refusal {
    pub why: Why,
    pub what: String,
}

impl Refusal {
    fn of(why: Why) -> Refusal {
        Refusal { why, what: String::new() }
    }
    fn on(why: Why, what: &str) -> Refusal {
        Refusal { why, what: what.to_string() }
    }
    /// `why:<code>` or `why:<code>:<name>`, the shape the page reads.
    pub fn text(&self) -> String {
        if self.what.is_empty() {
            format!("why:{}", self.why.code())
        } else {
            format!("why:{}:{}", self.why.code(), self.what)
        }
    }
}

// ---------------------------------------------------------------------------------------------
// Which agents and what each takes
// ---------------------------------------------------------------------------------------------

/// What each agent's own `--help` says about the options a person might add, read on this Mac on 25 Nov 2026 (Claude Code
/// 2.1.332, Codex 0.167, OpenCode, Gemini CLI, oh-my-pi 18.22.0, Grok Build, Cursor Agent 2026.11.22, Antigravity 1.5.17).
/// Names are written without their dashes; one letter is a short option, compared as written, and a longer one is a long
/// option, compared without case and with `_` read as `-` (Go's and yargs' spellings) and as its `--no-` form (yargs and
/// commander turn a switch off with it). None of these eight parses an abbreviation as the whole option (commander,
/// yargs, clap, Go's flag and Bun's parser do not), so a shorter name that is another option of its own stays allowed.
#[derive(Serialize)]
pub struct ArgRules {
    pub id: &'static str,
    /// Options that let the agent act without asking first, or outside its sandbox, or widen where it may act unasked.
    pub skips: &'static [&'static str],
    /// Options the app sets itself or that take the session somewhere else: the chat mode, the conversation, the folder,
    /// where the asks go.
    pub own: &'static [&'static str],
    /// Options whose `key=value` is a configuration override (Codex's `-c`), and the key prefixes refused in them.
    pub config: &'static [&'static str],
    pub config_keys: &'static [&'static str],
    /// Environment variables the help names as setting the sandbox or the asks.
    pub vars: &'static [&'static str],
}

pub const ARG_RULES: [ArgRules; 8] = [
    ArgRules {
        id: "claude",
        skips: &[
            "dangerously-skip-permissions",
            "allow-dangerously-skip-permissions",
            "permission-mode",
            "allowedTools",
            "allowed-tools",
            "settings",
            "agents",
            "add-dir",
        ],
        own: &[
            "p",
            "print",
            "input-format",
            "output-format",
            "verbose",
            "include-partial-messages",
            "include-hook-events",
            "forward-subagent-text",
            "permission-prompt-tool",
            "permission-prompts",
            "replay-user-messages",
            "prompt-suggestions",
            "r",
            "resume",
            "session-id",
            "c",
            "continue",
            "fork-session",
            "no-session-persistence",
            "append-system-prompt-file",
            "bg",
            "background",
            "cloud",
            "teleport",
            "desktop",
            "remote-control",
            "w",
            "worktree",
            "tmux",
            "from-pr",
            "environment",
            "h",
            "help",
            "v",
            "version",
        ],
        config: &[],
        config_keys: &[],
        vars: &[],
    },
    ArgRules {
        id: "codex",
        skips: &["dangerously-bypass-approvals-and-sandbox", "dangerously-bypass-hook-trust", "a", "ask-for-approval", "s", "sandbox", "approve-for-me", "add-dir", "search", "p", "profile"],
        own: &[
            "C",
            "cd",
            "worktree",
            "remote",
            "remote-auth-token-env",
            "listen",
            "stdio",
            "ws-auth",
            "ws-token-file",
            "ws-token-sha256",
            "ws-shared-secret-file",
            "ws-issuer",
            "ws-audience",
            "ws-max-clock-skew-seconds",
            "startup-sign-out",
            "code-mode-host",
            "print-startup-config",
            "h",
            "help",
            "V",
            "version",
        ],
        config: &["c", "config"],
        config_keys: &["approval", "sandbox", "profile"],
        vars: &[],
    },
    ArgRules {
        id: "opencode",
        skips: &["auto"],
        own: &["standalone", "server", "c", "continue", "s", "session", "prompt", "login", "wizard", "completions", "h", "help", "v", "version"],
        config: &[],
        config_keys: &[],
        vars: &[],
    },
    ArgRules {
        id: "gemini",
        skips: &["y", "yolo", "approval-mode", "allowed-tools", "policy", "admin-policy", "skip-trust", "s", "sandbox", "include-directories"],
        own: &[
            "p",
            "prompt",
            "i",
            "prompt-interactive",
            "acp",
            "experimental-acp",
            "o",
            "output-format",
            "r",
            "resume",
            "session-file",
            "session-id",
            "list-sessions",
            "delete-session",
            "w",
            "worktree",
            "l",
            "list-extensions",
            "h",
            "help",
            "v",
            "version",
        ],
        config: &[],
        config_keys: &[],
        vars: &[],
    },
    ArgRules {
        id: "omp",
        skips: &["auto-approve", "approval-mode", "plan-yolo", "plan-yolo-into", "add-dir", "config", "profile"],
        own: &["mode", "p", "print", "c", "continue", "r", "resume", "restore", "goal", "from-claude", "from-codex", "export", "alias", "cwd", "session-dir", "no-session", "no-ui", "h", "help", "version"],
        config: &[],
        config_keys: &[],
        vars: &[],
    },
    ArgRules {
        id: "grok",
        skips: &["always-approve", "allow", "allowedTools", "allowed-tools", "permission-mode", "sandbox", "add-dir", "agents"],
        own: &[
            "c",
            "continue",
            "r",
            "resume",
            "s",
            "session-id",
            "fork-session",
            "p",
            "single",
            "prompt-file",
            "prompt-json",
            "cwd",
            "w",
            "worktree",
            "worktree-ref",
            "leader-socket",
            "restore-code",
            "output-format",
            "h",
            "help",
            "v",
            "version",
        ],
        config: &[],
        config_keys: &[],
        vars: &["GROK_SANDBOX"],
    },
    ArgRules {
        id: "cursor-agent",
        skips: &["f", "force", "yolo", "auto-review", "sandbox", "approve-mcps", "trust", "add-dir"],
        own: &[
            "p",
            "print",
            "output-format",
            "stream-partial-output",
            "mode",
            "plan",
            "resume",
            "continue",
            "workspace",
            "w",
            "worktree",
            "worktree-base",
            "skip-worktree-setup",
            "api-key",
            "list-models",
            "h",
            "help",
            "v",
            "version",
        ],
        config: &[],
        config_keys: &[],
        vars: &[],
    },
    ArgRules {
        id: "agy",
        skips: &["dangerously-skip-permissions", "mode", "settings", "add-dir", "sandbox"],
        own: &[
            "p",
            "print",
            "prompt",
            "i",
            "prompt-interactive",
            "input-format",
            "output-format",
            "c",
            "continue",
            "r",
            "conversation",
            "resume",
            "json-schema",
            "print-timeout",
            "project",
            "new-project",
            "remote-agent",
            "remote-control",
            "worker",
            "process-per-session",
            "stdio",
            "login",
            "app-data-dir",
            "cli-dir-name",
            "gemini-dir",
            "h",
            "help",
        ],
        config: &[],
        config_keys: &[],
        vars: &[],
    },
];

/// The option rules of agent `id`, or `None` when its options were not read here (it takes no extra arguments).
pub fn rules(id: &str) -> Option<&'static ArgRules> {
    ARG_RULES.iter().find(|r| r.id == id)
}

/// The agents whose `--version` the app runs for the page, each read here (in its help, or Antigravity's by running it):
/// only the version token is kept (`accounts::parse_version`).
pub const VERSION_AGENTS: [&str; 7] = ["claude", "codex", "opencode", "gemini", "grok", "cursor-agent", "agy"];

/// Variables the app sets on an agent's process itself (the terminal's, the child's `PATH`, the app's own `MANUT_*`, and
/// the ask rules OpenCode gets in `OPENCODE_CONFIG_CONTENT`): a person's variable of the same name would fight one of them.
pub const APP_VARS: [&str; 6] = ["PATH", "TERM", "COLORTERM", "TERM_PROGRAM", "HOME", "OPENCODE_CONFIG_CONTENT"];

/// The agent's home variable ([`crate::accounts::home_var`]: Claude Code, Codex, pi, oh-my-pi, Grok, Gemini CLI).
pub fn home_var(id: &str) -> Option<&'static str> {
    crate::accounts::home_var(id)
}

/// What a kind of agent takes on this page. A person's own agent (Settings › Agents) keeps its program and arguments in
/// its own entry, so only the switch applies to it. DeepSeek Harness's chat runs one headless process per message with
/// the harness's own setup, so it takes a path and nothing else.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Takes {
    pub path: bool,
    pub home: bool,
    pub args: bool,
    pub vars: bool,
}

pub fn takes(id: &str) -> Takes {
    if crate::sessions::agent(id).is_none() {
        return Takes { path: false, home: false, args: false, vars: false };
    }
    Takes { path: true, home: home_var(id).is_some(), args: rules(id).is_some(), vars: id != "dsh" }
}

// ---------------------------------------------------------------------------------------------
// Checks (pure: the OS and the file checks are passed in)
// ---------------------------------------------------------------------------------------------

fn has_control(s: &str) -> bool {
    s.chars().any(char::is_control)
}

/// An absolute path for `os`, without `..`, a control character or more than [`PATH_MAX`] bytes.
fn abs_ok(p: &str, os: Os) -> bool {
    if p.len() > PATH_MAX || has_control(p) || p.split(['/', '\\']).any(|s| s == "..") {
        return false;
    }
    match os {
        Os::Unix => p.starts_with('/') && p.len() > 1,
        Os::Windows => {
            let b = p.as_bytes();
            b.len() > 3 && b[0].is_ascii_alphabetic() && b[1] == b':' && matches!(b[2], b'\\' | b'/')
        }
    }
}

/// The display name: "" (the agent's own) or what a person's own agent's name may be.
pub fn check_name(n: &str) -> Result<(), Refusal> {
    if n.is_empty() || (crate::custom_agents::label_ok(n) && n.chars().count() <= NAME_MAX) {
        Ok(())
    } else {
        Err(Refusal::of(Why::Name))
    }
}

/// The program path: "" (found as always), or an absolute path to a file this account may run (`is_program`), with on
/// Windows an `.exe`, or a `.cmd` / `.bat` shim whose path `cmd.exe` takes ([`crate::sessions::cmd_path_arg`]).
pub fn check_path<X: Fn(&Path) -> bool>(p: &str, os: Os, is_program: X) -> Result<(), Refusal> {
    if p.is_empty() {
        return Ok(());
    }
    if !abs_ok(p, os) {
        return Err(Refusal::of(Why::PathShape));
    }
    if os == Os::Windows {
        let ext = p.rsplit(['/', '\\']).next().and_then(|n| n.rsplit_once('.')).map(|(_, e)| e.to_ascii_lowercase()).unwrap_or_default();
        match ext.as_str() {
            "exe" => {}
            "cmd" | "bat" if crate::sessions::cmd_path_arg(p).is_ok() => {}
            _ => return Err(Refusal::of(Why::PathRun)),
        }
    }
    if !is_program(Path::new(p)) {
        return Err(Refusal::of(Why::PathRun));
    }
    Ok(())
}

/// The home folder: "" (the CLI's own), or an existing absolute folder, for an agent that has a home variable.
pub fn check_home<D: Fn(&Path) -> bool>(id: &str, h: &str, os: Os, is_dir: D) -> Result<(), Refusal> {
    if h.is_empty() {
        return Ok(());
    }
    if home_var(id).is_none() {
        return Err(Refusal::of(Why::HomeNone));
    }
    if !abs_ok(h, os) {
        return Err(Refusal::of(Why::HomeShape));
    }
    if !is_dir(Path::new(h)) {
        return Err(Refusal::of(Why::HomeMissing));
    }
    Ok(())
}

/// The option an argument names, and whether it is a long one: `--name[=value]` or `-x[=value]`; `None` for any other
/// shape (a word an agent would read as a command or a prompt, `--` that ends its options, a cluster of short options).
pub fn option_of(a: &str) -> Option<(&str, bool)> {
    if let Some(rest) = a.strip_prefix("--") {
        let name = rest.split('=').next().unwrap_or("");
        let ok = name.chars().next().is_some_and(|c| c.is_ascii_alphanumeric()) && name.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'));
        return ok.then_some((name, true));
    }
    let rest = a.strip_prefix('-')?;
    let mut chars = rest.chars();
    let c = chars.next().filter(|c| c.is_ascii_alphanumeric())?;
    let after = chars.as_str();
    (after.is_empty() || after.starts_with('=')).then_some((&rest[..c.len_utf8()], false))
}

fn norm(n: &str) -> String {
    n.to_ascii_lowercase().replace('_', "-")
}

/// Whether option `name` (long or short) is one of `list`: a short one as written; a long one by [`norm`], or as its
/// `--no-` form.
fn names(list: &[&str], name: &str, long: bool) -> bool {
    if !long {
        return list.iter().any(|r| r.len() == 1 && *r == name);
    }
    let n = norm(name);
    let off = n.strip_prefix("no-");
    list.iter().filter(|r| r.len() > 1).map(|r| norm(r)).any(|r| r == n || off == Some(r.as_str()))
}

/// Agent `id`'s extra arguments, checked: the shape of each, then the app's own options and the ones that skip the asks
/// or the sandbox, by name.
pub fn check_args(id: &str, args: &[String]) -> Result<(), Refusal> {
    if args.is_empty() {
        return Ok(());
    }
    let Some(r) = rules(id) else { return Err(Refusal::of(Why::ArgUnchecked)) };
    if args.len() > MAX_ARGS {
        return Err(Refusal::of(Why::ArgMany));
    }
    for a in args {
        let (name, long) = match option_of(a) {
            Some(o) if a.len() <= ARG_MAX && !has_control(a) => o,
            // the argument's own text can hold a key (`--api-key=…`): only its option, when it has one, is named
            _ => return Err(Refusal::on(Why::ArgShape, option_of(a).map(|(n, _)| n).unwrap_or(""))),
        };
        let shown = if long { format!("--{name}") } else { format!("-{name}") };
        if names(r.skips, name, long) {
            return Err(Refusal::on(Why::ArgSkips, &shown));
        }
        if names(r.own, name, long) {
            return Err(Refusal::on(Why::ArgOwn, &shown));
        }
        if names(r.config, name, long) {
            // `-c key=value` written as one argument; the key decides
            let key = a.split_once('=').map(|(_, v)| v).unwrap_or("").split('=').next().unwrap_or("").trim().to_ascii_lowercase();
            if key.is_empty() || r.config_keys.iter().any(|k| key.starts_with(k)) {
                return Err(Refusal::on(Why::ArgSkips, &shown));
            }
        }
    }
    Ok(())
}

/// Agent `id`'s variables, checked: names, the app's own and the home variable, values.
pub fn check_vars(id: &str, vars: &[Var]) -> Result<(), Refusal> {
    if vars.is_empty() {
        return Ok(());
    }
    if !takes(id).vars {
        return Err(Refusal::of(Why::VarNone));
    }
    if vars.len() > MAX_VARS {
        return Err(Refusal::of(Why::VarMany));
    }
    let mut seen: Vec<String> = Vec::new();
    for v in vars {
        let n = &v.name;
        let shape = !n.is_empty()
            && n.len() <= VAR_NAME_MAX
            && n.chars().next().is_some_and(|c| c.is_ascii_alphabetic() || c == '_')
            && n.chars().all(|c| c.is_ascii_alphanumeric() || c == '_');
        let upper = n.to_ascii_uppercase();
        if !shape || seen.contains(&upper) {
            return Err(Refusal::on(Why::VarName, if shape { n } else { "" }));
        }
        seen.push(upper.clone());
        if home_var(id).is_some_and(|h| h.eq_ignore_ascii_case(n)) {
            return Err(Refusal::on(Why::VarHome, n));
        }
        // names compared without case: Windows reads them so
        let own = APP_VARS.iter().any(|a| a.eq_ignore_ascii_case(n)) || upper.starts_with("MANUT_") || rules(id).is_some_and(|r| r.vars.iter().any(|x| x.eq_ignore_ascii_case(n)));
        if own {
            return Err(Refusal::on(Why::VarOwn, n));
        }
        if v.value.len() > VAR_VALUE_MAX || v.value.contains('\0') {
            return Err(Refusal::on(Why::VarValue, n));
        }
    }
    Ok(())
}

/// Everything stored for agent `id`, checked as one.
pub fn check<X: Fn(&Path) -> bool, D: Fn(&Path) -> bool>(id: &str, s: &Stored, os: Os, is_program: X, is_dir: D) -> Result<(), Refusal> {
    let t = takes(id);
    // a built-in or ACP agent, or the shape of a person's own agent's id (its switch is kept by id)
    if crate::sessions::agent(id).is_none() && !crate::custom_agents::id_ok(id) {
        return Err(Refusal::of(Why::Unknown));
    }
    check_name(&s.name)?;
    if !s.path.is_empty() && !t.path {
        return Err(Refusal::of(Why::PathNone));
    }
    check_path(&s.path, os, is_program)?;
    check_home(id, &s.home, os, is_dir)?;
    if !s.args.is_empty() && !t.args {
        return Err(Refusal::of(Why::ArgUnchecked));
    }
    check_args(id, &s.args)?;
    check_vars(id, &s.env)
}

// ---------------------------------------------------------------------------------------------
// What a session gets
// ---------------------------------------------------------------------------------------------

/// Refuses a start of an agent the person turned off, before anything runs.
pub fn may_start(label: &str, s: &Stored) -> Result<(), String> {
    if s.off {
        Err(format!("{label} is turned off in Settings › Providers"))
    } else {
        Ok(())
    }
}

/// The program the person set for a session, checked again now: `None` when they set none (it is found as always).
pub fn set_program<X: Fn(&Path) -> bool>(label: &str, s: &Stored, os: Os, is_program: X) -> Result<Option<PathBuf>, String> {
    if s.path.is_empty() {
        return Ok(None);
    }
    check_path(&s.path, os, is_program).map_err(|_| format!("{label} cannot start: the program path set in Settings › Providers is not a program this account may run"))?;
    Ok(Some(PathBuf::from(&s.path)))
}

/// The person's arguments for a session of `id`, checked again now, to go after every argument the app adds. Through
/// `cmd.exe` (a Windows `.cmd` shim) each is escaped as the shim's path is, and one cmd cannot take whole is refused.
pub fn extra_args(id: &str, s: &Stored, through_cmd: bool) -> Result<Vec<OsString>, String> {
    let refused = |r: Refusal| format!("{} cannot start: an extra argument set in Settings › Providers is refused ({})", id, r.text());
    if !s.args.is_empty() && !takes(id).args {
        return Err(refused(Refusal::of(Why::ArgUnchecked)));
    }
    check_args(id, &s.args).map_err(refused)?;
    s.args
        .iter()
        .map(|a| if through_cmd { crate::sessions::cmd_path_arg(a).map(OsString::from).map_err(|_| refused(Refusal::of(Why::ArgCmd))) } else { Ok(OsString::from(a)) })
        .collect()
}

/// The environment a session of agent `id` starts with besides the app's own: the person's variables (when `with_vars`;
/// never for Buddy), then the home: `account_env` (an added account's folder, which wins) or else the home folder the
/// person set. Variables that no longer pass [`check_vars`] are left out, so a file changed by hand adds nothing the page
/// would refuse.
pub fn session_env(id: &str, s: &Stored, account_env: &[(String, String)], with_vars: bool) -> Vec<(String, String)> {
    let mut env: Vec<(String, String)> = Vec::new();
    if with_vars && check_vars(id, &s.env).is_ok() {
        env.extend(s.env.iter().map(|v| (v.name.clone(), v.value.clone())));
    }
    if let Some(var) = home_var(id) {
        if !s.home.is_empty() && !account_env.iter().any(|(k, _)| k == var) && abs_ok(&s.home, Os::current()) {
            env.push((var.to_string(), s.home.clone()));
        }
    }
    env.extend(account_env.iter().cloned());
    env
}

// ---------------------------------------------------------------------------------------------
// The file
// ---------------------------------------------------------------------------------------------

/// `<home>/.manut/providers.json`, beside the app's other settings. The only file this module writes.
pub fn store_path(home: &Path) -> PathBuf {
    home.join(".manut").join("providers.json")
}

/// What the file holds, and whether it could not be read (then nothing may write it, so a person's file is never lost).
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct Loaded {
    pub agents: BTreeMap<String, Stored>,
    pub unreadable: bool,
}

impl Loaded {
    /// Agent `id`'s settings ([`Stored::default`] when it has none).
    pub fn get(&self, id: &str) -> Stored {
        self.agents.get(id).cloned().unwrap_or_default()
    }
}

/// Read the file. No file is no settings; one that is a link, too big or not the format is unreadable and changes nothing.
pub fn load(home: &Path) -> Loaded {
    let path = store_path(home);
    let meta = match std::fs::symlink_metadata(&path) {
        Ok(m) => m,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Loaded::default(),
        Err(_) => return Loaded { unreadable: true, ..Loaded::default() },
    };
    let read = || -> Option<BTreeMap<String, Stored>> {
        if !meta.is_file() || meta.len() > FILE_MAX {
            return None;
        }
        let v: Value = serde_json::from_str(&std::fs::read_to_string(&path).ok()?).ok()?;
        if v.get("version").and_then(Value::as_u64) != Some(VERSION) {
            return None;
        }
        let agents = v.get("agents")?.as_object()?;
        // an entry that is not the shape is left out (and kept out of the next save), never half read
        Some(agents.iter().filter_map(|(k, e)| Some((k.clone(), serde_json::from_value::<Stored>(e.clone()).ok()?))).collect())
    };
    match read() {
        Some(agents) => Loaded { agents, unreadable: false },
        None => Loaded { unreadable: true, ..Loaded::default() },
    }
}

/// Write the file whole: through a temporary file made for this account only (0600) and a rename, never through a link.
pub fn save(home: &Path, agents: &BTreeMap<String, Stored>) -> Result<(), Refusal> {
    let dir = home.join(".manut");
    if dir.is_symlink() {
        return Err(Refusal::of(Why::File));
    }
    std::fs::create_dir_all(&dir).map_err(|_| Refusal::of(Why::File))?;
    let path = store_path(home);
    if path.is_symlink() {
        return Err(Refusal::of(Why::File));
    }
    // an agent with nothing set leaves the file
    let kept: BTreeMap<&String, &Stored> = agents.iter().filter(|(_, s)| **s != Stored::default()).collect();
    let body = serde_json::to_string_pretty(&json!({"version": VERSION, "agents": kept})).map_err(|_| Refusal::of(Why::File))? + "\n";
    let tmp = dir.join("providers.json.tmp");
    let _ = std::fs::remove_file(&tmp);
    let mut o = std::fs::OpenOptions::new();
    o.write(true).create_new(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut o, 0o600);
    let wrote = o.open(&tmp).and_then(|mut f| std::io::Write::write_all(&mut f, body.as_bytes())).and_then(|_| std::fs::rename(&tmp, &path));
    if wrote.is_err() {
        let _ = std::fs::remove_file(&tmp);
        return Err(Refusal::of(Why::File));
    }
    Ok(())
}

fn user_home() -> Option<PathBuf> {
    crate::custom_agents::home()
}

/// The file on this computer (nothing when there is no home folder).
pub fn load_here() -> Loaded {
    user_home().map(|h| load(&h)).unwrap_or_default()
}

/// Agent `id`'s settings on this computer, read now.
pub fn stored_here(id: &str) -> Stored {
    load_here().get(id)
}

// ---------------------------------------------------------------------------------------------
// The page's edits
// ---------------------------------------------------------------------------------------------

/// One change from the page. A field left out stays as it is.
#[derive(Debug, Default, Deserialize)]
#[serde(default)]
pub struct Patch {
    pub off: Option<bool>,
    pub name: Option<String>,
    pub path: Option<String>,
    pub home: Option<String>,
    pub args: Option<Vec<String>>,
    /// The whole list of variables. A variable without a value keeps the one saved for that name, which the page never
    /// had; one the list leaves out is removed.
    pub env: Option<Vec<VarPatch>>,
}

#[derive(Deserialize)]
pub struct VarPatch {
    pub name: String,
    #[serde(default)]
    pub value: Option<String>,
}

impl std::fmt::Debug for VarPatch {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("VarPatch").field("name", &self.name).field("value", &self.value.as_ref().map(|_| "<hidden>")).finish()
    }
}

/// `cur` with `patch` applied, trimmed where a field is a name or a path, and checked whole.
pub fn apply<X: Fn(&Path) -> bool, D: Fn(&Path) -> bool>(id: &str, cur: &Stored, patch: Patch, os: Os, is_program: X, is_dir: D) -> Result<Stored, Refusal> {
    let mut next = cur.clone();
    if let Some(off) = patch.off {
        next.off = off;
    }
    if let Some(n) = patch.name {
        next.name = n.trim().to_string();
    }
    if let Some(p) = patch.path {
        next.path = p.trim().to_string();
    }
    if let Some(h) = patch.home {
        next.home = h.trim().to_string();
    }
    if let Some(a) = patch.args {
        // an empty line is no argument; each other line is one argument as typed
        next.args = a.into_iter().filter(|x| !x.trim().is_empty()).collect();
    }
    if let Some(vars) = patch.env {
        let mut out = Vec::new();
        for v in vars {
            let name = v.name.trim().to_string();
            let value = match v.value {
                Some(value) => value,
                None => cur.env.iter().find(|x| x.name == name).map(|x| x.value.clone()).ok_or_else(|| Refusal::on(Why::VarKeep, &name))?,
            };
            out.push(Var { name, value });
        }
        next.env = out;
    }
    check(id, &next, os, is_program, is_dir)?;
    Ok(next)
}

/// Save agent `id`'s patch on this computer and give back its new view. Refused when the file cannot be read (it is left
/// as it is).
pub fn save_here(id: &str, patch: Patch) -> Result<View, String> {
    let home = user_home().ok_or("no home folder")?;
    let mut all = load(&home);
    if all.unreadable {
        return Err(Refusal::of(Why::File).text());
    }
    let next = apply(id, &all.get(id), patch, Os::current(), crate::sessions::is_program_file, Path::is_dir).map_err(|r| r.text())?;
    all.agents.insert(id.to_string(), next);
    save(&home, &all.agents).map_err(|r| r.text())?;
    list_here().into_iter().find(|v| v.id == id).ok_or_else(|| Refusal::of(Why::Unknown).text())
}

// ---------------------------------------------------------------------------------------------
// What the page gets
// ---------------------------------------------------------------------------------------------

/// One agent on the page. Variables are names only: a value never leaves the shell once saved.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct View {
    pub id: String,
    /// The agent's own name.
    pub label: String,
    /// `main` (Claude Code, Codex, OmO), `builtin`, `acp` or `custom` (one the person added).
    pub kind: &'static str,
    pub mode: Mode,
    pub off: bool,
    /// The display name the person set ("" = the agent's own).
    pub name: String,
    /// Where its program is for a session now (the set path when it is usable), or `None`: not installed.
    pub found: Option<String>,
    /// The set path ("" = found as always) and whether it is usable now.
    pub path: String,
    pub path_ok: bool,
    /// The agent's home variable, when it has one, and the folder set for it ("" = the CLI's own).
    pub home_var: Option<&'static str>,
    pub home: String,
    pub args: Vec<String>,
    /// The names of its variables, never the values.
    pub env: Vec<String>,
    pub takes_path: bool,
    pub takes_args: bool,
    pub takes_vars: bool,
    /// The page may ask for its version ([`VERSION_AGENTS`]) and its sign-in (Claude Code, Codex).
    pub version: bool,
    pub signin: bool,
    /// The command a chat and a terminal of it start with now (the program found, the app's fixed arguments, then the
    /// person's), for the page to show; `None` when it has no such way here or is not installed.
    pub chat: Option<String>,
    pub terminal: Option<String>,
}

fn kind_of(id: &str) -> &'static str {
    match id {
        "claude" | "codex" | "omo" => "main",
        _ if crate::acp_agents::entry(id).is_some() => "acp",
        _ if crate::sessions::agent(id).is_some() => "builtin",
        _ => "custom",
    }
}

fn line(argv: &[OsString]) -> String {
    argv.iter().map(|a| a.to_string_lossy().into_owned()).collect::<Vec<_>>().join(" ")
}

/// The view of built-in or ACP agent `a`, found at `found` (the set path, else as always).
pub fn view_of(a: &Agent, s: &Stored, found: Option<PathBuf>, path_ok: bool) -> View {
    let t = takes(a.id);
    let extra: Vec<OsString> = if check_args(a.id, &s.args).is_ok() { s.args.iter().map(OsString::from).collect() } else { Vec::new() };
    let program = found.as_ref().map(|p| p.as_os_str().to_owned());
    let chat = match (&program, crate::sessions::chat_args(a.id)) {
        (Some(p), Some(fixed)) => Some(line(&std::iter::once(p.clone()).chain(fixed.iter().map(OsString::from)).chain(extra.iter().cloned()).collect::<Vec<_>>())),
        _ => None,
    };
    let terminal = match &program {
        Some(p) if a.id != "dsh" => Some(line(&std::iter::once(p.clone()).chain(extra.iter().cloned()).collect::<Vec<_>>())),
        _ => None,
    };
    View {
        id: a.id.to_string(),
        label: a.label.to_string(),
        kind: kind_of(a.id),
        mode: a.mode,
        off: s.off,
        name: s.name.clone(),
        found: found.map(|p| p.to_string_lossy().into_owned()),
        path: s.path.clone(),
        path_ok,
        home_var: home_var(a.id),
        home: s.home.clone(),
        args: s.args.clone(),
        env: s.env.iter().map(|v| v.name.clone()).collect(),
        takes_path: t.path,
        takes_args: t.args,
        takes_vars: t.vars,
        version: VERSION_AGENTS.contains(&a.id),
        signin: matches!(a.id, "claude" | "codex"),
        chat,
        terminal,
    }
}

/// Every agent the app knows on this computer, in the page's order: the built-ins, the ACP agents, then the person's own.
pub fn list_here() -> Vec<View> {
    let all = load_here();
    let mut out: Vec<View> = crate::sessions::agents_on_this_machine_with(&all)
        .into_iter()
        .filter_map(|info| {
            let a = crate::sessions::agent(info.id)?;
            let s = all.get(a.id);
            let path_ok = check_path(&s.path, Os::current(), crate::sessions::is_program_file).is_ok();
            Some(view_of(a, &s, info.path.map(PathBuf::from), path_ok))
        })
        .collect();
    for c in crate::custom_agents::list_here().agents {
        let s = all.get(&c.id);
        out.push(View {
            id: c.id.clone(),
            label: c.label.clone(),
            kind: "custom",
            mode: Mode::Chat,
            off: s.off,
            name: String::new(),
            found: c.path.clone(),
            path: String::new(),
            path_ok: true,
            home_var: None,
            home: String::new(),
            args: Vec::new(),
            env: Vec::new(),
            takes_path: false,
            takes_args: false,
            takes_vars: false,
            version: false,
            signin: false,
            chat: c.path.map(|p| std::iter::once(p).chain(c.acp.args.iter().cloned()).collect::<Vec<_>>().join(" ")),
            terminal: None,
        });
    }
    out
}

/// The version agent `id`'s program prints with `--version` (only the version token), for an agent of [`VERSION_AGENTS`]
/// that is installed; `None` otherwise. Runs the program a session would start, with nothing but `--version`.
pub fn version_here(id: &str) -> Result<Option<String>, String> {
    if !VERSION_AGENTS.contains(&id) {
        return Ok(None);
    }
    let s = stored_here(id);
    let Ok((mut argv, path_env)) = crate::sessions::program_for(id, &s) else { return Ok(None) };
    argv.push("--version".into());
    Ok(crate::accounts::run_version(&argv, &path_env)?.as_deref().and_then(crate::accounts::parse_version))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(args: &[&str]) -> Vec<String> {
        args.iter().map(|a| a.to_string()).collect()
    }

    fn var(name: &str, value: &str) -> Var {
        Var { name: name.into(), value: value.into() }
    }

    /// Each rule names a short option as one letter and a long one as written in its help, and every agent with rules is
    /// one the app knows.
    #[test]
    fn the_rules_are_agents_the_app_knows_written_as_their_help_writes_them() {
        for r in &ARG_RULES {
            assert!(crate::sessions::agent(r.id).is_some(), "{}", r.id);
            for n in r.skips.iter().chain(r.own).chain(r.config) {
                assert!(!n.starts_with('-') && !n.is_empty() && !n.contains('='), "{}: {n}", r.id);
            }
        }
        // the agents whose help could not be read here take no extra arguments
        for id in ["omo", "dsh", "omh", "pi", "qwen", "kimi", "copilot", "cline"] {
            assert!(rules(id).is_none(), "{id}");
            assert!(!takes(id).args, "{id}");
        }
    }

    /// Only `--name`, `--name=value`, `-x` and `-x=value` are arguments: never a word (a command or a prompt), `--`
    /// (after which the app's own arguments would be read as words), a cluster of short options or a control character.
    #[test]
    fn an_argument_is_one_option_and_nothing_else() {
        for ok in ["--model=opus", "--model", "-m", "-m=opus", "--name=two words", "--effort=high", "--agent=reviewer"] {
            assert!(check_args("claude", &s(&[ok])).is_ok(), "{ok}");
        }
        for bad in ["opus", "mcp", "--", "-", "-abc", "-mopus", "---x", "--=x", "--model\n", "--a\u{0}b", "", " --model=x"] {
            assert_eq!(check_args("claude", &s(&[bad])).unwrap_err().why, Why::ArgShape, "{bad:?}");
        }
        assert_eq!(check_args("claude", &s(&[&format!("--model={}", "x".repeat(ARG_MAX))])).unwrap_err().why, Why::ArgShape);
        let many: Vec<String> = (0..=MAX_ARGS).map(|i| format!("--x{i}")).collect();
        assert_eq!(check_args("claude", &many).unwrap_err().why, Why::ArgMany);
        // an agent whose options were not read takes none, and a person's own agent none here
        assert_eq!(check_args("pi", &s(&["--model=x"])).unwrap_err().why, Why::ArgUnchecked);
        assert_eq!(check_args("my-agent", &s(&["--model=x"])).unwrap_err().why, Why::ArgUnchecked);
    }

    /// Every spelling that lets an agent act unasked or outside its sandbox is refused by name, as each CLI's help spells
    /// it, also without case, with `_`, as its `--no-` form and with a value.
    #[test]
    fn a_refused_argument_is_refused_by_name() {
        let skips: &[(&str, &[&str])] = &[
            (
                "claude",
                &[
                    "--dangerously-skip-permissions",
                    "--allow-dangerously-skip-permissions",
                    "--permission-mode=bypassPermissions",
                    "--permission-mode=acceptEdits",
                    "--allowedTools=Bash",
                    "--allowed-tools=Edit",
                    "--settings={\"permissions\":{\"allow\":[\"Bash\"]}}",
                    "--agents={}",
                    "--add-dir=/",
                    "--DANGEROUSLY_SKIP_PERMISSIONS",
                ],
            ),
            (
                "codex",
                &[
                    "--dangerously-bypass-approvals-and-sandbox",
                    "-a=never",
                    "--ask-for-approval=never",
                    "-s=danger-full-access",
                    "--sandbox=danger-full-access",
                    "--approve-for-me",
                    "--search",
                    "--add-dir=/",
                    "-p=yolo",
                    "--profile=yolo",
                    "-c=approval_policy=\"never\"",
                    "--config=sandbox_mode=\"danger-full-access\"",
                    "--config=sandbox_workspace_write.network_access=true",
                    "-c=profile=x",
                    "-c",
                    "--dangerously-bypass-hook-trust",
                ],
            ),
            ("opencode", &["--auto"]),
            ("gemini", &["-y", "--yolo", "--approval-mode=yolo", "--allowed-tools=run_shell_command", "--policy=/tmp/p", "--skip-trust", "--sandbox=false", "--no-sandbox", "-s", "--include-directories=/"]),
            ("omp", &["--auto-approve", "--approval-mode=yolo", "--plan-yolo", "--add-dir=/", "--config=/tmp/x.yml", "--profile=p"]),
            ("grok", &["--always-approve", "--allow=Bash", "--allowed-tools=Bash", "--permission-mode=bypassPermissions", "--sandbox=off", "--add-dir=/"]),
            ("cursor-agent", &["-f", "--force", "--yolo", "--auto-review", "--sandbox=disabled", "--approve-mcps", "--trust", "--add-dir=/"]),
            ("agy", &["--dangerously-skip-permissions", "--mode=auto", "--mode=accept-edits", "--settings={}", "--add-dir=/", "--sandbox=false", "--dangerously_skip_permissions"]),
        ];
        for (id, args) in skips {
            for a in *args {
                let r = check_args(id, &s(&[a])).unwrap_err();
                assert_eq!(r.why, Why::ArgSkips, "{id} {a}");
                // the refusal names the option, never the value
                assert!(r.what.starts_with('-') && !r.what.contains('='), "{id} {a}: {r:?}");
            }
        }
        // the same option is refused wherever it sits among allowed ones
        assert_eq!(check_args("claude", &s(&["--model=opus", "--verbose"])).unwrap_err().what, "--verbose");
        assert_eq!(check_args("claude", &s(&["--model=opus", "--effort=high", "--dangerously-skip-permissions"])).unwrap_err().why, Why::ArgSkips);
        // a configuration override that is not about the asks or the sandbox stays the person's
        assert!(check_args("codex", &s(&["-c=model=\"o3\"", "--config=model_reasoning_effort=\"high\"", "-m=o3"])).is_ok());
        assert!(check_args("gemini", &s(&["-m=gemini-2.5-pro", "--debug"])).is_ok());
        assert!(check_args("cursor-agent", &s(&["--model=sonnet-4"])).is_ok());
        // an API key in an argument is refused as the app's own, and the refusal does not carry the key
        let r = check_args("cursor-agent", &s(&["--api-key=sk-secret-123"])).unwrap_err();
        assert_eq!((r.why, r.what.as_str()), (Why::ArgOwn, "--api-key"));
        assert!(!r.text().contains("sk-secret"));
    }

    /// The options the app sets itself cannot be given again: the chat mode, where the asks go, the conversation, the folder.
    #[test]
    fn the_apps_own_options_are_refused() {
        for a in crate::sessions::CLAUDE_CHAT_ARGS.iter().filter(|a| a.starts_with('-')).chain(crate::buddy_chat::BUDDY_CLAUDE_ARGS.iter().filter(|a| a.starts_with('-'))) {
            assert!(check_args("claude", &s(&[a])).is_err(), "{a}");
            assert!(check_args("claude", &s(&[&format!("{a}=x")])).is_err(), "{a}=x");
        }
        for a in ["--resume=eee5079a-c52e-4526-b633-f3d8cb7d6394", "-r", "--session-id=x", "--continue", "-c", "--append-system-prompt-file=/x", "--worktree", "--prompt-suggestions=false", "--remote-control"] {
            assert!(check_args("claude", &s(&[a])).is_err(), "{a}");
        }
        for a in ["--listen=ws://0.0.0.0:1", "--stdio", "-C=/", "--cd=/", "--remote=ws://x", "--startup-sign-out"] {
            assert_eq!(check_args("codex", &s(&[a])).unwrap_err().why, Why::ArgOwn, "{a}");
        }
        for a in ["--acp", "--experimental-acp", "-p=hi", "--resume=latest", "--delete-session=1"] {
            assert_eq!(check_args("gemini", &s(&[a])).unwrap_err().why, Why::ArgOwn, "{a}");
        }
        for a in ["--mode=text", "--cwd=/", "--resume=x", "-p"] {
            assert_eq!(check_args("omp", &s(&[a])).unwrap_err().why, Why::ArgOwn, "{a}");
        }
        for a in ["--login", "--print", "--conversation=x", "--gemini-dir=/x"] {
            assert_eq!(check_args("agy", &s(&[a])).unwrap_err().why, Why::ArgOwn, "{a}");
        }
    }

    #[test]
    fn a_bad_path_is_refused() {
        let prog = Path::new("/opt/x/bin/claude");
        let is_prog = |p: &Path| p == prog;
        assert!(check_path("", Os::Unix, is_prog).is_ok());
        assert!(check_path("/opt/x/bin/claude", Os::Unix, is_prog).is_ok());
        for (p, why) in [
            ("claude", Why::PathShape),
            ("bin/claude", Why::PathShape),
            ("~/bin/claude", Why::PathShape),
            ("/opt/x/../x/bin/claude", Why::PathShape),
            ("/opt/x/bin/claude\n", Why::PathShape),
            ("/", Why::PathShape),
            ("/opt/x/bin/nothing-here", Why::PathRun),
            ("/opt/x/bin", Why::PathRun),
        ] {
            assert_eq!(check_path(p, Os::Unix, is_prog).unwrap_err().why, why, "{p:?}");
        }
        assert_eq!(check_path(&format!("/{}", "a".repeat(PATH_MAX)), Os::Unix, |_: &Path| true).unwrap_err().why, Why::PathShape);
        // Windows: an .exe, or a shim cmd.exe takes whole; never a script it cannot run
        let all = |_: &Path| true;
        assert!(check_path(r"C:\Tools\claude.exe", Os::Windows, all).is_ok());
        assert!(check_path(r"C:\npm\claude.cmd", Os::Windows, all).is_ok());
        assert_eq!(check_path(r"C:\npm\claude.ps1", Os::Windows, all).unwrap_err().why, Why::PathRun);
        assert_eq!(check_path(r"C:\a&b (x)\claude.cmd", Os::Windows, all).unwrap_err().why, Why::PathRun);
        assert_eq!(check_path(r"\\server\claude.exe", Os::Windows, all).unwrap_err().why, Why::PathShape);
        // a real file without the run bit, and a folder, are not programs this account may run
        #[cfg(unix)]
        {
            let dir = std::env::temp_dir().join(format!("manut-prov-path-{}", std::process::id()));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(&dir).unwrap();
            let plain = dir.join("plain");
            std::fs::write(&plain, "#!/bin/sh\n").unwrap();
            let p = plain.to_string_lossy().into_owned();
            assert_eq!(check_path(&p, Os::Unix, crate::sessions::is_program_file).unwrap_err().why, Why::PathRun);
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&plain, std::fs::Permissions::from_mode(0o755)).unwrap();
            assert!(check_path(&p, Os::Unix, crate::sessions::is_program_file).is_ok());
            assert_eq!(check_path(&dir.to_string_lossy(), Os::Unix, crate::sessions::is_program_file).unwrap_err().why, Why::PathRun);
            // at start the same path is checked again: a program that went away starts nothing
            let st = Stored { path: p.clone(), ..Stored::default() };
            assert_eq!(set_program("Claude Code", &st, Os::Unix, crate::sessions::is_program_file).unwrap(), Some(PathBuf::from(&p)));
            std::fs::remove_file(&plain).unwrap();
            assert!(set_program("Claude Code", &st, Os::Unix, crate::sessions::is_program_file).is_err());
            let _ = std::fs::remove_dir_all(&dir);
        }
    }

    #[test]
    fn the_home_is_an_existing_folder_for_an_agent_with_a_home_variable() {
        let is_dir = |p: &Path| p == Path::new("/Users/k/.claude-work");
        assert!(check_home("claude", "/Users/k/.claude-work", Os::Unix, is_dir).is_ok());
        assert_eq!(check_home("claude", "~/.claude-work", Os::Unix, is_dir).unwrap_err().why, Why::HomeShape);
        assert_eq!(check_home("claude", "/Users/k/none", Os::Unix, is_dir).unwrap_err().why, Why::HomeMissing);
        assert_eq!(check_home("opencode", "/Users/k/.claude-work", Os::Unix, is_dir).unwrap_err().why, Why::HomeNone);
        for (id, var) in [("claude", "CLAUDE_CONFIG_DIR"), ("codex", "CODEX_HOME"), ("pi", "PI_CODING_AGENT_DIR"), ("omp", "PI_CODING_AGENT_DIR"), ("grok", "GROK_HOME"), ("gemini", "GEMINI_CLI_HOME")] {
            assert_eq!(home_var(id), Some(var));
        }
    }

    #[test]
    fn variables_are_named_once_and_never_the_apps_own_or_the_home() {
        assert!(check_vars("claude", &[var("ANTHROPIC_BASE_URL", "https://x"), var("MY_TOKEN", "a\nb")]).is_ok());
        for (v, why) in [
            (var("1X", "v"), Why::VarName),
            (var("A-B", "v"), Why::VarName),
            (var("", "v"), Why::VarName),
            (var("PATH", "/x"), Why::VarOwn),
            (var("path", "/x"), Why::VarOwn),
            (var("TERM", "x"), Why::VarOwn),
            (var("MANUT_TERMINAL_LINK", "x"), Why::VarOwn),
            (var("OPENCODE_CONFIG_CONTENT", "{}"), Why::VarOwn),
            (var("CLAUDE_CONFIG_DIR", "/x"), Why::VarHome),
            (var("X", "a\0b"), Why::VarValue),
            (var("X", &"v".repeat(VAR_VALUE_MAX + 1)), Why::VarValue),
        ] {
            assert_eq!(check_vars("claude", &[v.clone()]).unwrap_err().why, why, "{v:?}");
        }
        assert_eq!(check_vars("claude", &[var("A", "1"), var("a", "2")]).unwrap_err().why, Why::VarName);
        assert_eq!(check_vars("codex", &[var("CODEX_HOME", "/x")]).unwrap_err().why, Why::VarHome);
        assert_eq!(check_vars("grok", &[var("GROK_SANDBOX", "off")]).unwrap_err().why, Why::VarOwn);
        assert_eq!(check_vars("dsh", &[var("A", "1")]).unwrap_err().why, Why::VarNone);
        let many: Vec<Var> = (0..=MAX_VARS).map(|i| var(&format!("V{i}"), "x")).collect();
        assert_eq!(check_vars("claude", &many).unwrap_err().why, Why::VarMany);
        // a refusal names the variable, never its value
        let r = check_vars("claude", &[var("X", "secret-value\0")]).unwrap_err();
        assert!(r.text().contains("X") && !r.text().contains("secret-value"));
    }

    #[test]
    fn a_turned_off_agent_starts_nothing_and_a_path_replaces_only_where_it_is_found() {
        let off = Stored { off: true, ..Stored::default() };
        assert!(may_start("Claude Code", &off).unwrap_err().contains("turned off"));
        assert!(may_start("Claude Code", &Stored::default()).is_ok());
        // the launch refuses before it looks for a program at all
        let e = crate::sessions::launch_with("claude", &off).unwrap_err();
        assert!(e.contains("turned off"), "{e}");
        for a in crate::sessions::AGENTS.iter().chain(crate::acp_agents::ACP_LIST.iter().map(|e| &e.agent)) {
            assert!(crate::sessions::launch_with(a.id, &off).unwrap_err().contains("turned off"), "{}", a.id);
        }
    }

    #[cfg(unix)]
    #[test]
    fn a_set_path_is_the_program_and_the_apps_arguments_stay() {
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join(format!("manut-prov-launch-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let prog = dir.join("my-claude");
        std::fs::write(&prog, "#!/bin/sh\n").unwrap();
        std::fs::set_permissions(&prog, std::fs::Permissions::from_mode(0o755)).unwrap();
        let st = Stored { path: prog.to_string_lossy().into_owned(), args: s(&["--model=opus"]), ..Stored::default() };
        let (argv, path_env) = crate::sessions::launch_with("claude", &st).unwrap();
        // the path is only where the program is: nothing else is added to the launch, and its folder leads PATH
        assert_eq!(argv, vec![prog.as_os_str().to_owned()]);
        assert_eq!(std::env::split_paths(&path_env).next(), Some(dir.clone()));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn extra_arguments_come_after_the_apps_and_are_checked_again_at_start() {
        let st = Stored { args: s(&["--model=opus", "--effort=high"]), ..Stored::default() };
        assert_eq!(extra_args("claude", &st, false).unwrap(), vec![OsString::from("--model=opus"), OsString::from("--effort=high")]);
        // a file changed by hand: the start refuses, naming the option only
        let bad = Stored { args: s(&["--dangerously-skip-permissions"]), ..Stored::default() };
        let e = extra_args("claude", &bad, false).unwrap_err();
        assert!(e.contains("why:arg_skips:--dangerously-skip-permissions"), "{e}");
        assert!(extra_args("pi", &Stored { args: s(&["--model=x"]), ..Stored::default() }, false).is_err());
        // through cmd.exe each argument is escaped as a path is, and one cmd cannot take whole is refused
        assert_eq!(extra_args("claude", &Stored { args: s(&["--name=a&b"]), ..Stored::default() }, true).unwrap(), vec![OsString::from("--name=a^&b")]);
        assert!(extra_args("claude", &Stored { args: s(&["--name=100%"]), ..Stored::default() }, true).unwrap_err().contains("arg_cmd"));
    }

    #[test]
    fn the_variables_go_first_the_home_after_and_an_added_account_wins() {
        let st = Stored { home: "/Users/k/.claude-work".into(), env: vec![var("ANTHROPIC_BASE_URL", "https://x"), var("MY_TOKEN", "t0p")], ..Stored::default() };
        let env = session_env("claude", &st, &[], true);
        assert_eq!(
            env,
            vec![
                ("ANTHROPIC_BASE_URL".to_string(), "https://x".to_string()),
                ("MY_TOKEN".to_string(), "t0p".to_string()),
                ("CLAUDE_CONFIG_DIR".to_string(), "/Users/k/.claude-work".to_string())
            ]
        );
        // an added account's folder replaces the home, never both
        let acct = vec![("CLAUDE_CONFIG_DIR".to_string(), "/Users/k/.manut/accounts/claude/work".to_string())];
        let env = session_env("claude", &st, &acct, true);
        assert_eq!(env.iter().filter(|(k, _)| k == "CLAUDE_CONFIG_DIR").count(), 1);
        assert_eq!(env.last(), Some(&acct[0]));
        // Buddy: the home only, no variable of the person's
        assert_eq!(session_env("claude", &st, &[], false), vec![("CLAUDE_CONFIG_DIR".to_string(), "/Users/k/.claude-work".to_string())]);
        // a variable changed by hand into one the page refuses adds none
        let bad = Stored { env: vec![var("PATH", "/evil"), var("OK", "1")], ..Stored::default() };
        assert!(session_env("claude", &bad, &[], true).is_empty());
        // an agent without a home variable gets no home
        assert!(session_env("opencode", &Stored { home: "/x".into(), ..Stored::default() }, &[], true).is_empty());
    }

    /// A value given once stays in the file and never comes back: not in a view, not in `{:?}`, not in a refusal.
    #[test]
    fn a_variables_value_never_leaves_after_it_is_saved() {
        let home = std::env::temp_dir().join(format!("manut-prov-secret-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&home);
        std::fs::create_dir_all(&home).unwrap();
        let secret = "sk-live-7f3a9c2e1b";
        let patch = Patch { env: Some(vec![VarPatch { name: "MY_KEY".into(), value: Some(secret.into()) }]), ..Patch::default() };
        let next = apply("claude", &Stored::default(), patch, Os::current(), |_: &Path| true, |_: &Path| true).unwrap();
        let mut all = BTreeMap::new();
        all.insert("claude".to_string(), next.clone());
        save(&home, &all).unwrap();
        // kept in the file, for this account only
        let text = std::fs::read_to_string(store_path(&home)).unwrap();
        assert!(text.contains(secret));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(store_path(&home)).unwrap().permissions().mode() & 0o777, 0o600);
        }
        let loaded = load(&home).get("claude");
        assert_eq!(loaded.env, vec![var("MY_KEY", secret)]);
        // the page's view: the name only
        let a = crate::sessions::agent("claude").unwrap();
        let view = view_of(a, &loaded, Some(PathBuf::from("/x/claude")), true);
        let json = serde_json::to_string(&view).unwrap();
        assert!(json.contains("MY_KEY") && !json.contains(secret), "{json}");
        assert!(!format!("{view:?}").contains(secret));
        // no Debug print of the settings shows it
        assert!(!format!("{loaded:?}").contains(secret) && !format!("{:?}", load(&home)).contains(secret));
        // saving again without the value keeps it; a refusal elsewhere names no value
        let again = apply("claude", &loaded, Patch { env: Some(vec![VarPatch { name: "MY_KEY".into(), value: None }]), ..Patch::default() }, Os::current(), |_: &Path| true, |_: &Path| true).unwrap();
        assert_eq!(again.env, vec![var("MY_KEY", secret)]);
        let refused = apply("claude", &loaded, Patch { env: Some(vec![VarPatch { name: "MY_KEY".into(), value: None }, VarPatch { name: "PATH".into(), value: Some(secret.into()) }]), ..Patch::default() }, Os::current(), |_: &Path| true, |_: &Path| true).unwrap_err();
        assert!(!refused.text().contains(secret));
        // a value the page never had cannot be kept for a name that had none
        assert_eq!(apply("claude", &loaded, Patch { env: Some(vec![VarPatch { name: "OTHER".into(), value: None }]), ..Patch::default() }, Os::current(), |_: &Path| true, |_: &Path| true).unwrap_err().why, Why::VarKeep);
        // the patch's own Debug hides it too
        assert!(!format!("{:?}", VarPatch { name: "X".into(), value: Some(secret.into()) }).contains(secret));
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn the_file_is_written_whole_never_through_a_link_and_an_unreadable_one_is_left_alone() {
        let home = std::env::temp_dir().join(format!("manut-prov-file-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&home);
        std::fs::create_dir_all(home.join(".manut")).unwrap();
        assert_eq!(load(&home), Loaded::default());
        std::fs::write(store_path(&home), "not json").unwrap();
        assert!(load(&home).unreadable);
        std::fs::write(store_path(&home), r#"{"version":1,"agents":{"claude":{"off":true,"name":"Work"},"codex":"broken"}}"#).unwrap();
        let l = load(&home);
        assert!(!l.unreadable);
        assert_eq!((l.get("claude").off, l.get("claude").name.as_str()), (true, "Work"));
        assert_eq!(l.get("codex"), Stored::default());
        // an agent with nothing set leaves the file
        let mut all = l.agents.clone();
        all.insert("gemini".into(), Stored::default());
        save(&home, &all).unwrap();
        let v: Value = serde_json::from_str(&std::fs::read_to_string(store_path(&home)).unwrap()).unwrap();
        assert!(v["agents"].get("gemini").is_none() && v["agents"].get("claude").is_some());
        #[cfg(unix)]
        {
            std::fs::remove_file(store_path(&home)).unwrap();
            std::os::unix::fs::symlink(home.join("elsewhere.json"), store_path(&home)).unwrap();
            assert!(load(&home).unreadable);
            assert_eq!(save(&home, &all).unwrap_err().why, Why::File);
            assert!(!home.join("elsewhere.json").exists());
        }
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn a_patch_changes_only_what_it_names_and_is_checked_whole() {
        let cur = Stored { name: "Work".into(), args: s(&["--model=opus"]), ..Stored::default() };
        let next = apply("claude", &cur, Patch { off: Some(true), ..Patch::default() }, Os::Unix, |_: &Path| true, |_: &Path| true).unwrap();
        assert_eq!((next.off, next.name.as_str(), next.args.clone()), (true, "Work", s(&["--model=opus"])));
        let e = apply("claude", &cur, Patch { args: Some(s(&["--model=x", "", "--yolo-nope", "--permission-mode=auto"])), ..Patch::default() }, Os::Unix, |_: &Path| true, |_: &Path| true).unwrap_err();
        assert_eq!((e.why, e.what.as_str()), (Why::ArgSkips, "--permission-mode"));
        assert_eq!(apply("claude", &cur, Patch { name: Some("a;b".into()), ..Patch::default() }, Os::Unix, |_: &Path| true, |_: &Path| true).unwrap_err().why, Why::Name);
        // a person's own agent: the switch only
        assert!(apply("my-agent", &Stored::default(), Patch { off: Some(true), ..Patch::default() }, Os::Unix, |_: &Path| true, |_: &Path| true).is_ok());
        assert_eq!(apply("my-agent", &Stored::default(), Patch { path: Some("/x".into()), ..Patch::default() }, Os::Unix, |_: &Path| true, |_: &Path| true).unwrap_err().why, Why::PathNone);
        assert_eq!(apply("../x", &Stored::default(), Patch { off: Some(true), ..Patch::default() }, Os::Unix, |_: &Path| true, |_: &Path| true).unwrap_err().why, Why::Unknown);
    }

    /// The page's copy (`src/settings/providers/argRules.json`, which the browser stand-in and the page's own first check
    /// read) is this table exactly, with the variables the app sets and each agent's home variable.
    #[test]
    fn the_pages_copy_is_these_rules() {
        let p = Path::new(env!("CARGO_MANIFEST_DIR")).join("../src/settings/providers/argRules.json");
        let copy: Value = serde_json::from_str(&std::fs::read_to_string(p).unwrap()).unwrap();
        let homes: serde_json::Map<String, Value> = ["claude", "codex", "pi", "omp", "grok", "gemini"].iter().map(|id| (id.to_string(), json!(home_var(id)))).collect();
        assert_eq!(copy, json!({"rules": ARG_RULES, "appVars": APP_VARS, "homeVars": homes, "versionAgents": VERSION_AGENTS}));
    }

    #[test]
    fn the_view_shows_the_command_a_chat_and_a_terminal_run() {
        let a = crate::sessions::agent("gemini").unwrap();
        let st = Stored { args: s(&["-m=gemini-2.5-pro"]), ..Stored::default() };
        let v = view_of(a, &st, Some(PathBuf::from("/opt/bin/gemini")), true);
        assert_eq!(v.chat.as_deref(), Some("/opt/bin/gemini --acp -m=gemini-2.5-pro"));
        assert_eq!(v.terminal.as_deref(), Some("/opt/bin/gemini -m=gemini-2.5-pro"));
        assert_eq!((v.kind, v.takes_args, v.version, v.signin), ("acp", true, true, false));
        let v = view_of(crate::sessions::agent("dsh").unwrap(), &Stored::default(), None, true);
        assert_eq!((v.chat, v.terminal, v.takes_vars, v.takes_args), (None, None, false, false));
    }
}
