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
//!   sandbox, is refused by name ([`ARG_RULES`], read from each CLI's own `--help`), in every spelling its parser takes
//!   ([`norm`]). And since no `--help` prints a CLI's hidden options, a refused list cannot be shown whole: every other
//!   option must be on a short list of options known to be harmless for that CLI ([`ArgRules::allow`]), or it is
//!   refused too. An agent whose options were not read here takes none. Buddy takes none at all.
//! - **Environment variables** reach that agent's chats and terminals only (not Buddy's), before the home and the app's
//!   own variables, which therefore win; a name the app sets itself is refused, and so is one the CLI's own
//!   documentation or program names as skipping its asks, lifting its sandbox or pointing it at another settings file
//!   ([`ArgRules::vars`]). The person is setting their own tool: these refusals catch a mistake or a pasted line, and the
//!   page says so. Their values are secrets: kept in this file
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
    /// an argument names an option not on the short list known to be harmless for this agent
    ArgUnlisted,
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
/// 2.1.332, Codex 0.167 and 0.169, OpenCode 2.3.0, Gemini CLI 0.65.0, oh-my-pi 18.22.0, Grok Build 1.0.93, Cursor Agent
/// 2026.11.22, Antigravity 1.5.17), with the hidden spellings found since (security review, 25 Nov 2026): Codex takes
/// `--yolo` for its bypass and `--not-so-yolo` for `--approve-for-me` (Codex's `rust-v0.169.0` source, and `codex --yolo
/// --version` on this Mac), and took `--full-auto` before 0.147.
///
/// Names are written without their dashes; one letter is a short option, compared as written. A long option is compared
/// with every `-` and `_` taken out and case folded, on both sides ([`norm`]): yargs (Gemini CLI) also reads
/// `--approval-mode` as `--approvalMode`, and Go's and yargs' spellings differ in `_`. A refused option is also refused as
/// its `--no-` form (yargs and commander turn a switch off with it), and in yargs' dot form (`--sandbox.enabled=false`
/// makes an object of it). None of these eight parses an abbreviation as the whole option (commander, yargs, clap, Go's
/// flag and Bun's parser do not), so a shorter name that is another option of its own is not refused for it; it still
/// has to be on [`ArgRules::allow`].
#[derive(Serialize)]
pub struct ArgRules {
    pub id: &'static str,
    /// Options that let the agent act without asking first, or outside its sandbox, or widen where it may act unasked.
    pub skips: &'static [&'static str],
    /// Options the app sets itself or that take the session somewhere else: the chat mode, the conversation, the folder,
    /// where the asks go.
    pub own: &'static [&'static str],
    /// Options whose `key=value` is a configuration override (Codex's `-c`), the key prefixes refused as skipping the asks
    /// or the sandbox, and the only keys taken (the rule turned round, as for options).
    pub config: &'static [&'static str],
    pub config_keys: &'static [&'static str],
    pub config_allow: &'static [&'static str],
    /// The options known to be harmless (which model, how hard it thinks, what it logs, how it draws, and options that
    /// only take something away): the only ones taken besides the configuration keys above.
    pub allow: &'static [&'static str],
    /// Environment variables the CLI's own documentation or program names as skipping its asks, lifting or changing its
    /// sandbox, or pointing it at another settings or configuration file.
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
            "setting-sources",
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
        config_allow: &[],
        allow: &["model", "fallback-model", "effort", "n", "name", "d", "debug", "betas", "ax-screen-reader", "disallowedTools", "disallowed-tools", "disable-slash-commands"],
        // the environment variables page (code.claude.com/docs/en/env-vars) and Claude Code 2.1.332's own program
        vars: &[
            "CLAUDE_CODE_EVEN_MORE_DANGEROUSLY_SKIP_PERMISSIONS",
            "CLAUDE_CODE_DISABLE_DANGEROUS_RM_TIMEOUT",
            "CLAUDE_CODE_DISABLE_INLINE_SHELL_RM_PROMPT",
            "CLAUDE_CODE_DISABLE_MOUNTED_DRIVE_RM_PROMPT",
            "CLAUDE_CODE_DISABLE_SUBSTITUTION_RM_PROMPT",
            "CLAUDE_CODE_DISABLE_POWERSHELL_CMD_RM_DENY",
            "CLAUDE_CODE_SANDBOXED",
            "CLAUDE_CODE_IGNORE_PERSISTED_TRUST",
            "CLAUDE_CODE_SESSION_KIND",
            "CLAUDE_BG_SESSION_PERMISSION_RULES",
            "CLAUDE_BG_WORKSPACE_TRUSTED",
            "CLAUDE_CHROME_PERMISSION_MODE",
            "CLAUDE_CODE_MANAGED_SETTINGS_PATH",
            "CLAUDE_CODE_REMOTE_SETTINGS_PATH",
            "CLAUDE_CODE_PLUGIN_DIRS",
            "CLAUDE_CODE_PLUGIN_CACHE_DIR",
            "CLAUDE_CODE_PLUGIN_SEED_DIR",
            "CLAUDE_CODE_SHELL_PREFIX",
            "CLAUDE_ENV_FILE",
        ],
    },
    ArgRules {
        id: "codex",
        skips: &[
            "dangerously-bypass-approvals-and-sandbox",
            "yolo",
            "full-auto",
            "dangerously-bypass-hook-trust",
            "a",
            "ask-for-approval",
            "s",
            "sandbox",
            "approve-for-me",
            "not-so-yolo",
            "add-dir",
            "search",
            "p",
            "profile",
            "enable",
            "disable",
            "trust",
        ],
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
        config_keys: &["approval", "sandbox", "profile", "default_permissions", "permissions", "projects", "mcp_servers", "features", "shell_environment_policy"],
        config_allow: &["model", "model_reasoning_effort", "model_reasoning_summary", "model_verbosity"],
        allow: &["m", "model", "oss", "local-provider", "strict-config", "no-alt-screen"],
        // Codex's `rust-v0.169.0` source: tools sent to another exec server
        vars: &["CODEX_EXEC_SERVER_URL", "CODEX_EXEC_SERVER_NOISE_REGISTRY_URL"],
    },
    ArgRules {
        id: "opencode",
        skips: &["auto", "yolo", "dangerously-skip-permissions"],
        own: &["standalone", "server", "c", "continue", "s", "session", "prompt", "login", "wizard", "completions", "h", "help", "v", "version"],
        config: &[],
        config_keys: &[],
        config_allow: &[],
        allow: &["log-level", "print-logs"],
        // OpenCode 2.3.0's own program: another configuration file or folder, project configuration skipped
        vars: &[
            "OPENCODE_CONFIG",
            "OPENCODE_CONFIG_DIR",
            "OPENCODE_DISABLE_PROJECT_CONFIG",
            "OPENCODE_CONFIG_PROJECT_DISABLE",
            "OPENCODE_DISABLE_CLAUDE_CODE",
            "OPENCODE_DISABLE_CLAUDE_CODE_SKILLS",
            "OPENCODE_FLAGS",
            "OPENCODE_TEST_HOME",
            "XDG_CONFIG_HOME",
        ],
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
        config_allow: &[],
        allow: &["m", "model", "d", "debug", "screen-reader"],
        // Gemini CLI 0.65.0's own bundle and its documentation: trust, the sandbox, and other settings files
        vars: &[
            "GEMINI_CLI_TRUST_WORKSPACE",
            "GEMINI_CLI_INTEGRATION_TEST",
            "VITEST",
            "SANDBOX",
            "GEMINI_SANDBOX",
            "SEATBELT_PROFILE",
            "SANDBOX_FLAGS",
            "SANDBOX_MOUNTS",
            "SANDBOX_ENV",
            "SANDBOX_PORTS",
            "GEMINI_SANDBOX_IMAGE",
            "GEMINI_SANDBOX_PROXY_COMMAND",
            "BUILD_SANDBOX",
            "GEMINI_CLI_SYSTEM_SETTINGS_PATH",
            "GEMINI_CLI_SYSTEM_DEFAULTS_PATH",
            "GEMINI_CLI_TRUSTED_FOLDERS_PATH",
            "GEMINI_CLI_IDE_WORKSPACE_PATH",
        ],
    },
    ArgRules {
        id: "omp",
        skips: &["auto-approve", "approval-mode", "yolo", "plan-yolo", "plan-yolo-into", "add-dir", "config", "profile", "allow-home", "hook", "e", "extension", "trusted-extension", "plugin-dir"],
        own: &["mode", "p", "print", "c", "continue", "r", "resume", "restore", "goal", "from-claude", "from-codex", "export", "alias", "cwd", "session-dir", "no-session", "no-ui", "h", "help", "version"],
        config: &[],
        config_keys: &[],
        config_allow: &[],
        allow: &["model", "smol", "slow", "plan", "models", "thinking", "hide-thinking", "no-title", "max-time", "warn-cost", "max-cost", "motion"],
        // oh-my-pi 18.22.0's own program: another configuration folder or files, a wrapper around every command
        vars: &["PI_CONFIG_DIR", "PI_CONFIG_FILES", "PI_SHELL_PREFIX", "CLAUDE_CODE_SHELL_PREFIX"],
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
        config_allow: &[],
        allow: &["m", "model", "reasoning-effort", "debug", "disable-web-search", "disallowed-tools", "no-alt-screen", "max-turns"],
        // Grok Build 1.0.93's own documentation, built into its program
        vars: &[
            "GROK_SANDBOX",
            "GROK_SANDBOX_MODE",
            "GROK_SANDBOX_AUTO_ALLOW_BASH",
            "GROK_AUTO_PERMISSION_MODE",
            "GROK_DEFAULT_SELECTED_PERMISSION",
            "GROK_REMEMBER_TOOL_APPROVALS",
            "GROK_WORKTREE_INHERITS_MAIN_APPROVALS",
            "GROK_FOLDER_TRUST",
            "GROK_CONFIG",
            "GROK_CONFIG_PATH",
            "GROK_MANAGED_CONFIG_URL",
        ],
    },
    ArgRules {
        id: "cursor-agent",
        skips: &["f", "force", "yolo", "auto-review", "sandbox", "approve-mcps", "trust", "add-dir", "plugin-dir"],
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
        config_allow: &[],
        allow: &["model"],
        // Cursor Agent 2026.11.22's own program: another configuration folder, sandbox policies, feature overrides
        vars: &["CURSOR_CONFIG_DIR", "XDG_CONFIG_HOME", "CURSOR_SANDBOX_POLICY_DIR", "CURSOR_STATSIG_OVERRIDES"],
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
        config_allow: &[],
        allow: &["model", "effort", "disable-slash-commands"],
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

/// The agents whose sign-in the page reads from the shell (item 101a), each with its own fixed command, besides Claude
/// Code and Codex, whose sign-in the Accounts list reads for the account new sessions use: Cursor's `status --format json`
/// (`cursor-agent help status` on this Mac, 2026.11.22) and Antigravity's `models`, which lists models only when it is
/// signed in (it has no status command; `agy --help` on this Mac, 1.5.18, and GoSpark's Antigravity adapter, which reads
/// its sign-in the same way). Neither spends a message.
pub const SIGNIN_AGENTS: [&str; 2] = ["cursor-agent", "agy"];

/// The fixed arguments of agent `id`'s sign-in read, or `None`: never text from the page.
pub fn signin_args(id: &str) -> Option<&'static [&'static str]> {
    match id {
        "cursor-agent" => Some(&["status", "--format", "json"]),
        "agy" => Some(&["models"]),
        _ => None,
    }
}

/// Cursor's `status --format json`: signed in when its `isAuthenticated` is `true`, with `userInfo.email` (an address, at
/// most 120 characters). Nothing else of it is kept (it also says whether it holds tokens, never the tokens). Output that
/// is not that object, or has no `isAuthenticated`, says nothing.
pub fn parse_cursor_status(stdout: &str) -> Option<crate::accounts::LoginStatus> {
    let v: Value = serde_json::from_str(stdout.trim()).ok()?;
    let logged_in = v.get("isAuthenticated")?.as_bool()?;
    let email = v
        .get("userInfo")
        .and_then(|u| u.get("email"))
        .and_then(Value::as_str)
        .map(|e| e.trim().chars().filter(|c| !c.is_control()).take(120).collect::<String>())
        .filter(|e| logged_in && e.contains('@'));
    Some(crate::accounts::LoginStatus { logged_in, email, plan: None, method: None, last_refresh: None })
}

/// Antigravity's `models`: signed in when it ends well and lists at least one model (a line starting with a model id,
/// letters, digits, `-`, `_` and `.`, then a tab); signed out when what it printed asks for a sign-in; anything else says
/// nothing. The words are GoSpark's reading of the same command (`AntigravitySession.authStatus`). The output is the
/// account's model list: only the answer is kept.
pub fn parse_agy_models(code: Option<i32>, stdout: &str, stderr: &str) -> Option<crate::accounts::LoginStatus> {
    let slug = |t: &str| t.chars().next().is_some_and(|c| c.is_ascii_alphanumeric()) && t.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'));
    let listed = stdout.lines().any(|l| l.split_once('\t').is_some_and(|(id, name)| slug(id) && !name.trim().is_empty()));
    let said = |l: bool| Some(crate::accounts::LoginStatus { logged_in: l, ..Default::default() });
    if code == Some(0) && listed {
        return said(true);
    }
    let low = format!("{stdout}\n{stderr}").to_ascii_lowercase();
    if ["authentication required", "not signed in", "unauthenticated", "sign in", "log in", "login"].iter().any(|w| low.contains(w)) {
        return said(false);
    }
    None
}

/// Agent `id`'s sign-in as its own fixed command says it ([`signin_args`]), for an agent of [`SIGNIN_AGENTS`] that is
/// installed; `None` when it is neither, or its answer says nothing. Runs the program a session would start, with the
/// session's child `PATH`, as [`version_here`] does.
pub fn signin_here(id: &str) -> Result<Option<crate::accounts::LoginStatus>, String> {
    let Some(args) = signin_args(id) else { return Ok(None) };
    let s = stored_here(id);
    let Ok((mut argv, path_env)) = crate::sessions::program_for(id, &s) else { return Ok(None) };
    argv.extend(args.iter().map(OsString::from));
    let (code, out, err) = crate::accounts::run_fixed(&argv, &path_env)?;
    Ok(match id {
        "cursor-agent" => parse_cursor_status(&out),
        "agy" => parse_agy_models(code, &out, &err),
        _ => None,
    })
}

/// Variables the app sets on an agent's process itself (the terminal's, the child's `PATH`, the app's own `MANUT_*`, and
/// the ask rules OpenCode gets in `OPENCODE_CONFIG_CONTENT`, and `OPENCODE_DISABLE_PROJECT_CONFIG`, which keeps a project's own
/// configuration out of an OpenCode chat, item 89): a person's variable of the same name would fight one of them.
pub const APP_VARS: [&str; 7] = ["PATH", "TERM", "COLORTERM", "TERM_PROGRAM", "HOME", "OPENCODE_CONFIG_CONTENT", "OPENCODE_DISABLE_PROJECT_CONFIG"];

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

/// A name as the parsers here read it, whatever its spelling: case folded, with every `-` and `_` taken out, so
/// `approval-mode`, `approval_mode`, `approvalMode` and `APPROVAL-MODE` are one name.
fn norm(n: &str) -> String {
    n.chars().filter(|c| !matches!(c, '-' | '_')).flat_map(char::to_lowercase).collect()
}

/// Whether option `name` (long or short) is one of `list`, to refuse it: a short one as written; a long one by [`norm`]
/// against every entry (yargs reads `--s` as `-s`), as its `--no-` form, and by its part before a dot (yargs' object
/// form).
fn names(list: &[&str], name: &str, long: bool) -> bool {
    if !long {
        return list.iter().any(|r| r.len() == 1 && *r == name);
    }
    let whole = norm(name);
    let head = norm(name.split('.').next().unwrap_or(""));
    list.iter().map(|r| norm(r)).any(|r| [&whole, &head].iter().any(|n| **n == r || n.strip_prefix("no") == Some(r.as_str())))
}

/// Whether option `name` is on the harmless list `list`: a short one as written, a long one by [`norm`], whole.
fn listed(list: &[&str], name: &str, long: bool) -> bool {
    if !long {
        return list.iter().any(|r| r.len() == 1 && *r == name);
    }
    let n = norm(name);
    !name.contains('.') && list.iter().any(|r| norm(r) == n)
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
            // `-c key=value` written as one argument; the key decides, and only a key on the short list is taken
            let key = a.split_once('=').map(|(_, v)| v).unwrap_or("").split('=').next().unwrap_or("").trim().to_ascii_lowercase();
            if key.is_empty() || r.config_keys.iter().any(|k| key.starts_with(k)) {
                return Err(Refusal::on(Why::ArgSkips, &shown));
            }
            if !r.config_allow.iter().any(|k| *k == key) {
                return Err(Refusal::on(Why::ArgUnlisted, &shown));
            }
            continue;
        }
        // the rule turned round: no `--help` prints a CLI's hidden options, so anything not known to be harmless is refused
        if !listed(r.allow, name, long) {
            return Err(Refusal::on(Why::ArgUnlisted, &shown));
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
        if home_var(id).is_some_and(|h| norm(h) == norm(n)) {
            return Err(Refusal::on(Why::VarHome, n));
        }
        // names compared as the options are ([`norm`]): without case, as Windows reads them, and without `_`
        let own = APP_VARS.iter().any(|a| norm(a) == norm(n)) || upper.starts_with("MANUT_") || rules(id).is_some_and(|r| r.vars.iter().any(|x| norm(x) == norm(n)));
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
    env.extend(fixed_env(id).iter().map(|(k, v)| (k.to_string(), v.to_string())));
    let git = bare_explicit(&env);
    env.extend(git);
    env
}

/// Every agent's own git works with a bare repository only when one is named with `--git-dir` or `GIT_DIR`
/// (`safe.bareRepository=explicit`, which `git help config` says is read only from protected configuration, the command
/// scope that `GIT_CONFIG_COUNT` gives among it). A folder of plain files an agent wrote that git would take for a bare
/// repository can name a program git runs on a read (item 116); a normal repository, a lane's worktree and `.git` itself
/// work as before (checked with git 2.54). The setting goes after any the person set through `GIT_CONFIG_COUNT`, in the
/// variables they gave the agent or in the app's own environment, never over one.
fn bare_explicit(env: &[(String, String)]) -> Vec<(String, String)> {
    let set = env.iter().rev().find(|(k, _)| k == "GIT_CONFIG_COUNT").map(|(_, v)| v.clone()).or_else(|| std::env::var("GIT_CONFIG_COUNT").ok());
    let n = set.and_then(|v| v.trim().parse::<usize>().ok()).unwrap_or(0);
    vec![
        (format!("GIT_CONFIG_KEY_{n}"), "safe.bareRepository".to_string()),
        (format!("GIT_CONFIG_VALUE_{n}"), "explicit".to_string()),
        ("GIT_CONFIG_COUNT".to_string(), (n + 1).to_string()),
    ]
}

/// Variables every session of agent `id` starts with, after everything the person or an account set, so neither takes
/// one back. Kit's dial reads each command from the folder the session started in (src/code/ask.ts). Claude Code's shell
/// otherwise keeps a `cd` for its next command; with `CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR` set it goes back to the
/// folder it started in after every command, so the folder the dial reads a command from is the one it runs in (read in
/// Claude Code 2.1.332's Bash tool, which then says "Every call starts in the start folder: a `cd` does not carry over").
pub fn fixed_env(id: &str) -> &'static [(&'static str, &'static str)] {
    match id {
        "claude" => &[("CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR", "1")],
        _ => &[],
    }
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
    /// The page may ask for its version ([`VERSION_AGENTS`]) and its sign-in (Claude Code and Codex through the accounts,
    /// [`SIGNIN_AGENTS`] through [`signin_here`]).
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
        signin: matches!(a.id, "claude" | "codex") || SIGNIN_AGENTS.contains(&a.id),
        chat,
        terminal,
    }
}

/// Every agent the app offers on this computer, in the page's order: the built-ins, the ACP agents, then the person's own.
/// oh-my-hermes is left out: its chat needed the Hermes bridge, so the app offers it nowhere (`offeredAgents`).
pub fn list_here() -> Vec<View> {
    let all = load_here();
    let mut out: Vec<View> = crate::sessions::agents_on_this_machine_with(&all)
        .into_iter()
        .filter(|info| info.id != "omh")
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
            for n in r.skips.iter().chain(r.own).chain(r.config).chain(r.allow) {
                assert!(!n.starts_with('-') && !n.is_empty() && !n.contains('='), "{}: {n}", r.id);
            }
            // nothing on the harmless list is also refused, in any spelling
            for n in r.allow {
                let long = n.len() > 1;
                assert!(!names(r.skips, n, long) && !names(r.own, n, long) && !names(r.config, n, long), "{}: {n}", r.id);
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
        for ok in ["--model=opus", "--model", "-n", "-n=work", "--name=two words", "--effort=high", "-d", "--debug=api"] {
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
                    "--setting-sources=user,project,local",
                    "--setting_sources=project",
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

    /// Every other spelling a CLI's parser takes for a refused option is refused too: yargs (Gemini CLI) also reads a
    /// hyphenated option in camelCase and as an object with a dot, and Codex takes `--yolo` for its bypass, which its
    /// `--help` does not print.
    #[test]
    fn other_spellings_of_a_refused_option_are_refused() {
        let cases: &[(&str, &[&str])] = &[
            ("gemini", &["--approvalMode=yolo", "--skipTrust", "--includeDirectories=/", "--allowedTools=run_shell_command", "--adminPolicy=/tmp/p", "--approval_mode=yolo", "--sandbox.enabled=false", "--policy.x=1", "--s=false", "--noSandbox"]),
            ("codex", &["--yolo", "--full-auto", "--not-so-yolo", "--askForApproval=never", "--dangerously_bypass_approvals_and_sandbox"]),
            ("claude", &["--allowedtools=Bash", "--permissionMode=bypassPermissions", "--dangerouslySkipPermissions", "--addDir=/"]),
            ("cursor-agent", &["--autoReview", "--approveMcps"]),
        ];
        for (id, args) in cases {
            for a in *args {
                assert!(check_args(id, &s(&[a])).is_err(), "{id} {a}");
            }
        }
    }

    /// The rule turned round: no `--help` prints a CLI's hidden options, so an option is taken only when it is on that CLI's
    /// short list of options known to be harmless, in any spelling its parser takes, and a Codex configuration override
    /// only for a key on its own short list. Anything else is refused, naming the option only.
    #[test]
    fn only_options_known_to_be_harmless_are_taken() {
        let ok: &[(&str, &[&str])] = &[
            ("claude", &["--model=opus", "--fallback-model=sonnet", "--effort=high", "--name=work", "--betas=x", "--disallowedTools=Bash", "--disallowed-tools=Bash"]),
            ("codex", &["-m=o3", "--model=o3", "-c=model=\"o3\"", "--config=model_reasoning_effort=\"high\"", "-c=model_verbosity=low", "--oss", "--strict-config"]),
            ("gemini", &["-m=gemini-2.5-pro", "--model=x", "-d", "--debug", "--screen-reader", "--screenReader"]),
            ("opencode", &["--log-level=debug", "--print-logs"]),
            ("omp", &["--model=opus", "--thinking=high", "--no-title", "--max-cost=2"]),
            ("grok", &["-m=grok-4", "--reasoning-effort=high", "--disable-web-search"]),
            ("cursor-agent", &["--model=sonnet-4"]),
            ("agy", &["--model=x", "--effort=high"]),
        ];
        for (id, args) in ok {
            for a in *args {
                assert!(check_args(id, &s(&[a])).is_ok(), "{id} {a}: {:?}", check_args(id, &s(&[a])));
            }
            assert!(check_args(id, &s(args)).is_ok(), "{id} all at once");
        }
        let unlisted: &[(&str, &[&str])] = &[
            ("claude", &["--agent=reviewer", "--system-prompt=x", "--mcp-config={}", "--plugin-dir=/x", "--tools=Bash", "--model.x=1", "-m"]),
            ("codex", &["-c=model_providers.x.base_url=\"https://x\"", "-c=hide_agent_reasoning=true", "--remote-auth-token-env=X", "-i=/x.png"]),
            ("gemini", &["--proxy=http://x", "-e=foo", "--raw-output"]),
            ("cursor-agent", &["-H=X-Key: 1", "--endpoint=https://x", "--plan"]),
            ("agy", &["--agent=x", "--log-file=/tmp/x"]),
        ];
        for (id, args) in unlisted {
            for a in *args {
                let r = check_args(id, &s(&[a])).unwrap_err();
                assert!(matches!(r.why, Why::ArgUnlisted | Why::ArgOwn), "{id} {a}: {r:?}");
                assert!(r.what.starts_with('-') && !r.what.contains('='), "{id} {a}: {r:?}");
            }
        }
        assert_eq!(check_args("claude", &s(&["--agent=reviewer"])).unwrap_err(), Refusal::on(Why::ArgUnlisted, "--agent"));
        // a Codex override of a feature, a project's trust or an MCP server's approvals is about the asks
        for a in ["-c=features.x=true", "-c=projects.\"/\".trust_level=\"trusted\"", "-c=mcp_servers.x.default_tools_approval_mode=\"approve\"", "-c=default_permissions=\":danger-full-access\"", "--enable=x", "--disable=x"] {
            assert_eq!(check_args("codex", &s(&[a])).unwrap_err().why, Why::ArgSkips, "{a}");
        }
    }

    /// A variable a CLI's own documentation or program names as skipping its asks, lifting or changing its sandbox, or
    /// pointing it at another settings file is refused by name, compared as options are (without case or `_`).
    #[test]
    fn a_variable_that_skips_the_asks_or_points_elsewhere_is_refused() {
        let refused: &[(&str, &[&str])] = &[
            ("claude", &["CLAUDE_CODE_EVEN_MORE_DANGEROUSLY_SKIP_PERMISSIONS", "CLAUDE_CODE_SANDBOXED", "CLAUDE_CODE_MANAGED_SETTINGS_PATH", "CLAUDE_CODE_SHELL_PREFIX", "claude_code_plugin_dirs"]),
            ("codex", &["CODEX_EXEC_SERVER_URL", "codexhome"]),
            ("gemini", &["GEMINI_CLI_SYSTEM_SETTINGS_PATH", "gemini_cli_system_settings_path", "GEMINICLISYSTEMSETTINGSPATH", "GEMINI_SANDBOX", "SANDBOX", "SEATBELT_PROFILE", "GEMINI_CLI_TRUST_WORKSPACE"]),
            ("opencode", &["OPENCODE_CONFIG", "OPENCODE_CONFIG_DIR", "XDG_CONFIG_HOME", "OpenCode_Config_Content"]),
            ("omp", &["PI_CONFIG_DIR", "PI_SHELL_PREFIX"]),
            ("grok", &["GROK_SANDBOX", "GROK_SANDBOX_MODE", "GROK_AUTO_PERMISSION_MODE", "GROK_CONFIG_PATH", "GROK_FOLDER_TRUST"]),
            ("cursor-agent", &["CURSOR_CONFIG_DIR", "CURSOR_SANDBOX_POLICY_DIR"]),
        ];
        for (id, names) in refused {
            for n in *names {
                let r = check_vars(id, &[var(n, "x")]).unwrap_err();
                assert!(matches!(r.why, Why::VarOwn | Why::VarHome), "{id} {n}: {r:?}");
                assert_eq!(r.what, *n);
            }
        }
        // the ones that only say where the model is, or the person's own, stay theirs
        for (id, n) in [("claude", "ANTHROPIC_BASE_URL"), ("gemini", "GEMINI_API_KEY"), ("codex", "OPENAI_API_KEY"), ("opencode", "MY_TOKEN")] {
            assert!(check_vars(id, &[var(n, "x")]).is_ok(), "{id} {n}");
        }
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
            (var("OPENCODE_DISABLE_PROJECT_CONFIG", "0"), Why::VarOwn),
            (var("opencode_disable_project_config", ""), Why::VarOwn),
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
        let keep = ("CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR".to_string(), "1".to_string());
        // the app's own settings for every agent come last (`fixed_env`, `bare_explicit`)
        let mine = |env: Vec<(String, String)>| -> Vec<(String, String)> { env.into_iter().filter(|(k, _)| !k.starts_with("GIT_CONFIG_")).collect() };
        let env = mine(env);
        assert_eq!(
            env,
            vec![
                ("ANTHROPIC_BASE_URL".to_string(), "https://x".to_string()),
                ("MY_TOKEN".to_string(), "t0p".to_string()),
                ("CLAUDE_CONFIG_DIR".to_string(), "/Users/k/.claude-work".to_string()),
                keep.clone()
            ]
        );
        // an added account's folder replaces the home, never both
        let acct = vec![("CLAUDE_CONFIG_DIR".to_string(), "/Users/k/.manut/accounts/claude/work".to_string())];
        let env = mine(session_env("claude", &st, &acct, true));
        assert_eq!(env.iter().filter(|(k, _)| k == "CLAUDE_CONFIG_DIR").count(), 1);
        assert_eq!(env[env.len() - 2], acct[0]);
        // Buddy: the home only, no variable of the person's
        assert_eq!(mine(session_env("claude", &st, &[], false)), vec![("CLAUDE_CONFIG_DIR".to_string(), "/Users/k/.claude-work".to_string()), keep.clone()]);
        // a variable changed by hand into one the page refuses adds none
        let bad = Stored { env: vec![var("PATH", "/evil"), var("OK", "1")], ..Stored::default() };
        assert_eq!(mine(session_env("claude", &bad, &[], true)), vec![keep]);
        // an agent without a home variable gets no home
        assert!(mine(session_env("opencode", &Stored { home: "/x".into(), ..Stored::default() }, &[], true)).is_empty());
    }

    /// Every Claude Code the app starts (a chat, Buddy, a terminal, a title run) gets its environment here, and its shell
    /// then starts every command in the session's folder: the last value of the variable is the app's, whatever the person
    /// or an account set (item 116).
    #[test]
    fn every_claude_code_starts_each_command_in_its_session_folder() {
        const KEEP: &str = "CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR";
        let last = |env: &[(String, String)]| env.iter().rev().find(|(k, _)| k == KEEP).map(|(_, v)| v.clone());
        let theirs = Stored { home: "/Users/k/.claude-work".into(), env: vec![var(KEEP, "0")], ..Stored::default() };
        let acct = vec![("CLAUDE_CONFIG_DIR".to_string(), "/Users/k/.manut/accounts/claude/work".to_string())];
        for (st, a, with_vars) in [(&Stored::default(), &[][..], true), (&theirs, &[][..], true), (&theirs, &acct[..], true), (&theirs, &[][..], false)] {
            let env = session_env("claude", st, a, with_vars);
            assert_eq!(last(&env).as_deref(), Some("1"), "{with_vars}");
        }
        // the other agents read no such variable and get none
        for id in ["codex", "opencode", "pi", "omp", "gemini"] {
            assert_eq!(last(&session_env(id, &Stored::default(), &[], true)), None, "{id}");
        }
    }

    /// Every agent's own git reads a bare repository only when one is named with `--git-dir` or `GIT_DIR` (item 116):
    /// a folder of plain files that git would take for one can name a program it runs on a read. The setting goes after
    /// any the person set through `GIT_CONFIG_COUNT`, never over one.
    #[test]
    fn every_agents_git_reads_a_bare_repository_only_when_one_is_named() {
        let git = |env: &[(String, String)]| -> Vec<(String, String)> { env.iter().filter(|(k, _)| k.starts_with("GIT_CONFIG_")).cloned().collect() };
        let ours = |n: usize| vec![(format!("GIT_CONFIG_KEY_{n}"), "safe.bareRepository".to_string()), (format!("GIT_CONFIG_VALUE_{n}"), "explicit".to_string()), ("GIT_CONFIG_COUNT".to_string(), (n + 1).to_string())];
        for id in ["claude", "codex", "opencode", "pi", "omp", "gemini", "cursor-agent"] {
            assert_eq!(git(&session_env(id, &Stored::default(), &[], true)), ours(0), "{id}");
            assert_eq!(git(&session_env(id, &Stored::default(), &[], false)), ours(0), "{id}");
        }
        // after the person's own settings, which stay as they are
        let theirs = Stored { env: vec![var("GIT_CONFIG_COUNT", "1"), var("GIT_CONFIG_KEY_0", "core.pager"), var("GIT_CONFIG_VALUE_0", "less")], ..Stored::default() };
        let env = session_env("codex", &theirs, &[], true);
        assert_eq!(git(&env)[..3], [("GIT_CONFIG_COUNT".to_string(), "1".to_string()), ("GIT_CONFIG_KEY_0".to_string(), "core.pager".to_string()), ("GIT_CONFIG_VALUE_0".to_string(), "less".to_string())]);
        assert_eq!(git(&env)[3..], ours(1)[..]);
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
        let e = apply("claude", &cur, Patch { args: Some(s(&["--model=x", "", "--permission-mode=auto", "--yolo-nope"])), ..Patch::default() }, Os::Unix, |_: &Path| true, |_: &Path| true).unwrap_err();
        assert_eq!((e.why, e.what.as_str()), (Why::ArgSkips, "--permission-mode"));
        let e = apply("claude", &cur, Patch { args: Some(s(&["--model=x", "--yolo-nope"])), ..Patch::default() }, Os::Unix, |_: &Path| true, |_: &Path| true).unwrap_err();
        assert_eq!((e.why, e.what.as_str()), (Why::ArgUnlisted, "--yolo-nope"));
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
        assert_eq!(copy, json!({"rules": ARG_RULES, "appVars": APP_VARS, "homeVars": homes, "versionAgents": VERSION_AGENTS, "signinAgents": SIGNIN_AGENTS}));
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

    /// Item 101a: Cursor's and Antigravity's rows read their sign-in through their own fixed commands, and nothing but
    /// whether they are signed in, and Cursor's email, is kept.
    #[test]
    fn cursor_and_antigravity_say_whether_they_are_signed_in() {
        for id in ["cursor-agent", "agy"] {
            let v = view_of(crate::sessions::agent(id).unwrap(), &Stored::default(), Some(PathBuf::from("/opt/bin/x")), true);
            assert!(v.signin && v.version, "{id}");
        }
        assert!(!view_of(crate::sessions::agent("gemini").unwrap(), &Stored::default(), None, true).signin);
        assert_eq!(signin_args("cursor-agent"), Some(&["status", "--format", "json"][..]));
        assert_eq!(signin_args("agy"), Some(&["models"][..]));
        for other in ["claude", "codex", "gemini", "opencode", "", "agy models"] {
            assert_eq!(signin_args(other), None, "{other}");
        }
        // Cursor 2026.11.22's own shape (field names read on this Mac; the values here are made up)
        let signed = r#"{"status":"authenticated","isAuthenticated":true,"hasAccessToken":true,"hasRefreshToken":true,"userInfo":{"email":"me@example.com","userId":1,"firstName":"A","lastName":"B","teamId":2,"teamName":"T","createdAt":"2026-01-01"}}"#;
        let st = parse_cursor_status(signed).unwrap();
        assert_eq!((st.logged_in, st.email.as_deref(), st.plan, st.method), (true, Some("me@example.com"), None, None));
        let out = parse_cursor_status(r#"{"status":"unauthenticated","isAuthenticated":false,"userInfo":{"email":"me@example.com"}}"#).unwrap();
        assert_eq!((out.logged_in, out.email), (false, None));
        for nothing in ["", "Logged in as me@example.com", "{}", r#"{"isAuthenticated":"yes"}"#, "[]"] {
            assert_eq!(parse_cursor_status(nothing), None, "{nothing}");
        }
        // Antigravity 1.5.18's `models` as it printed on this Mac when signed in (its first lines)
        let listed = "Fetching available models...\ngemini-4-hydrogen-high\tGemini 4 Hydrogen (High)\nclaude-sonnet-4-6\tClaude Sonnet 4.6 (Thinking)\n";
        assert_eq!(parse_agy_models(Some(0), listed, "").map(|s| s.logged_in), Some(true));
        assert_eq!(parse_agy_models(Some(1), "", "Error: authentication required. Run agy acp --login").map(|s| s.logged_in), Some(false));
        assert_eq!(parse_agy_models(Some(0), "Fetching available models...\nPlease sign in first\n", "").map(|s| s.logged_in), Some(false));
        // a list that is not one (no tab, a sentence), or a failure that names no sign-in, says nothing
        assert_eq!(parse_agy_models(Some(0), "Fetching available models...\n", ""), None);
        assert_eq!(parse_agy_models(Some(0), "some words\tmore", "").map(|s| s.logged_in), None);
        assert_eq!(parse_agy_models(Some(1), "", "network unreachable"), None);
        assert_eq!(parse_agy_models(Some(2), listed, ""), None, "a list on a failing exit is not trusted");
    }
}
