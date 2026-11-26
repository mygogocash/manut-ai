//! Accounts: the coding-CLI logins on this computer, and adding another subscription through the CLI's own login.
//!
//! * `account_env(cli, id)` gives the env a new session of `cli` starts with to use the manut account
//!   `~/.manut/accounts/<cli>/<id>/` (CLAUDE_CONFIG_DIR, CODEX_HOME, PI_CODING_AGENT_DIR, GROK_HOME,
//!   GEMINI_CLI_HOME). `default` is the CLI's own home on this computer: no env.
//! * The only programs run here are the CLIs' own status and login commands, as FIXED argv from
//!   [`fixed_args`] (`claude auth status --json`, `claude auth login`, `codex --help`, `codex login status`,
//!   `codex login`, and `claude --version` / `codex --version` for the version beside the CLI's name), resolved in the PATH and install folders. Nothing the page sends reaches a command line:
//!   the page names a CLI and an account id, both checked against fixed lists.
//! * The browser sign-in happens inside the CLI. manut never sees, asks for or accepts a token or key; from a
//!   status it keeps only [`LoginStatus`] (signed in, email, plan, method), never the CLI's text.

use std::collections::HashMap;
use std::ffi::OsString;
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

use crate::platform::Os;

/// Every coding CLI Accounts knows, in page order.
pub const ACCOUNT_CLIS: [&str; 6] = ["claude", "codex", "pi", "omp", "grok", "gemini"];
const STATUS_TIMEOUT: Duration = Duration::from_secs(10);

/// The env var each CLI reads for its home folder (Claude Code CLAUDE_CONFIG_DIR, Codex CODEX_HOME, pi and
/// oh-my-pi PI_CODING_AGENT_DIR, Grok Build GROK_HOME, Gemini CLI GEMINI_CLI_HOME).
pub fn home_var(cli: &str) -> Option<&'static str> {
    match cli {
        "claude" => Some("CLAUDE_CONFIG_DIR"),
        "codex" => Some("CODEX_HOME"),
        "pi" | "omp" => Some("PI_CODING_AGENT_DIR"),
        "grok" => Some("GROK_HOME"),
        "gemini" => Some("GEMINI_CLI_HOME"),
        _ => None,
    }
}

/// Same rule as the bridge: lower-case letters, digits, `.`, `_`, `-`; up to 40; not `default`.
pub fn valid_account_id(id: &str) -> bool {
    let b = id.as_bytes();
    !b.is_empty()
        && b.len() <= 40
        && id != "default"
        && b[0].is_ascii_alphanumeric()
        && !b[0].is_ascii_uppercase()
        && b.iter().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, b'.' | b'_' | b'-'))
        && !id.contains("..")
}

/// `<home>/.manut/accounts/<cli>/<id>`.
pub fn account_dir(home: &Path, cli: &str, id: &str) -> Result<PathBuf, String> {
    home_var(cli).ok_or("unknown cli")?;
    if !valid_account_id(id) {
        return Err("bad account id".into());
    }
    Ok(home.join(".manut").join("accounts").join(cli).join(id))
}

/// The env a new session of `cli` starts with to use account `id`. `default` is "This computer": the CLI's own home (no
/// env), or the home folder set for it on Settings › Providers ([`own_home_env`]).
pub fn account_env(home: &Path, cli: &str, id: &str) -> Result<Vec<(String, String)>, String> {
    let var = home_var(cli).ok_or("unknown cli")?;
    if id == "default" {
        return Ok(own_home_env(home, cli));
    }
    let dir = account_dir(home, cli, id)?;
    Ok(vec![(var.to_string(), dir.to_string_lossy().into_owned())])
}

/// The home folder set for `cli` on Settings › Providers (item 74), as its home variable: what "This computer" means for
/// that CLI in this app. Nothing when none is set (the CLI's own default), or when what the file holds is not an absolute
/// path. An added account's folder replaces it for the sessions that run as that account, and shares this one's settings
/// ([`prepare`]), so the two never fight over the variable.
pub fn own_home_env(home: &Path, cli: &str) -> Vec<(String, String)> {
    let Some(var) = home_var(cli) else { return Vec::new() };
    let h = crate::providers::load(home).get(cli).home;
    if h.is_empty() || !Path::new(&h).is_absolute() {
        return Vec::new();
    }
    vec![(var.to_string(), h)]
}

/// The Accounts CLI a SESSIONS agent signs in as: claude, codex and grok map 1:1. omh has no login of its own,
/// and pi / omp sessions do not take an account yet, so those start with the CLI's own home.
pub fn session_cli(agent: &str) -> Option<&'static str> {
    match agent {
        "claude" => Some("claude"),
        "codex" => Some("codex"),
        "grok" => Some("grok"),
        _ => None,
    }
}

/// The account new sessions of `cli` use: `active.json`'s `{cli: id}` (written by the bridge's
/// `accounts.set_active`), when that id is a valid name whose folder still exists; otherwise `default`.
/// Reads manut's own `active.json` only, never a CLI's login file.
pub fn active_account(home: &Path, cli: &str) -> String {
    let file = home.join(".manut").join("accounts").join("active.json");
    let id = std::fs::read_to_string(file)
        .ok()
        .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
        .and_then(|v| v.get(cli).and_then(|x| x.as_str()).map(str::to_string));
    match id {
        Some(id) if account_dir(home, cli, &id).map(|d| d.is_dir() && !d.is_symlink()).unwrap_or(false) => id,
        _ => "default".to_string(),
    }
}

/// The extra env a new session of SESSIONS agent `agent` starts with: the chosen account's home variable
/// (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `GROK_HOME`) pointing at its folder, or nothing for "This computer",
/// no choice, or an agent without accounts.
pub fn session_env(home: &Path, agent: &str) -> Vec<(String, String)> {
    let Some(cli) = session_cli(agent) else {
        return Vec::new();
    };
    account_env(home, cli, &active_account(home, cli)).unwrap_or_default()
}

/// The env a session manut starts again after a restart gets: the account it ran with (`account`, from the UI's
/// saved list) when that is `default` or a valid id whose folder still exists, else [`session_env`]'s choice.
pub fn session_env_for(home: &Path, agent: &str, account: Option<&str>) -> Vec<(String, String)> {
    let Some(cli) = session_cli(agent) else {
        return Vec::new();
    };
    match account {
        Some("default") => account_env(home, cli, "default").unwrap_or_default(),
        Some(id) if account_dir(home, cli, id).map(|d| d.is_dir() && !d.is_symlink()).unwrap_or(false) => account_env(home, cli, id).unwrap_or_default(),
        _ => session_env(home, agent),
    }
}

// ---------------------------------------------------------------------------------------------
// What an added account shares with the person's own home (item 72)
// ---------------------------------------------------------------------------------------------

/// The entries of a CLI's home an added account shares with the person's own home of that CLI, as links: configuration
/// only, each named in the CLI's own documentation or listed by the CLI itself. An allow-list rather than "all but the
/// sign-in" (T3 Code's Codex shadow home shares every entry but `auth.json`): a CLI can add a credentials file at any time
/// (Codex's MCP sign-ins can be a file in its home), and an allow-list never shares one it does not name.
///
/// - Claude Code (code.claude.com/docs/en/claude-directory): skills, commands, subagents, output styles, rules, workflows,
///   plugins and the person's `CLAUDE.md`. Its `settings.json` is shared as a copy without the sign-in keys
///   ([`CLAUDE_LOGIN_KEYS`]). Its `.claude.json` is not shared at all: it holds the account's own identity beside the
///   person's user-scope MCP servers, and Claude Code rewrites it while it runs, so no part of it can be split off safely.
/// - Codex (its config, AGENTS.md and custom prompts pages; `skills` and `plugins` are the skill roots `codex debug
///   prompt-input` names): the instructions files, skills, prompts and plugins. Its `config.toml` (settings and MCP
///   servers) is shared as a copy without the keys that hold or fetch a credential ([`CODEX_LOGIN_KEYS`]): it can hold a
///   provider's key or headers and an MCP server's tokens, and a link would hand them all to the account.
pub fn shared_names(cli: &str) -> &'static [&'static str] {
    match cli {
        "claude" => &["skills", "commands", "agents", "output-styles", "rules", "workflows", "plugins", "CLAUDE.md"],
        "codex" => &["AGENTS.md", "AGENTS.override.md", "skills", "prompts", "plugins"],
        _ => &[],
    }
}

/// What holds a sign-in in a CLI's home (Codex's `auth.json`; Claude Code's `.credentials.json` where there is no keychain,
/// and its `.claude.json`, which holds the account's own details): never shared, whatever [`shared_names`] says.
pub const NEVER_SHARED: [&str; 4] = ["auth.json", "auth.lock", ".credentials.json", ".claude.json"];

/// The keys of Claude Code's `settings.json` an added account's copy leaves out: the ones its settings reference files under
/// "Authentication and providers", which supply or pick a sign-in, and `env`, which can carry an API key or switch the
/// provider. With any of them shared, the account would sign in as the person's own home does.
pub const CLAUDE_LOGIN_KEYS: [&str; 11] = [
    "env",
    "apiKeyHelper",
    "awsAuthRefresh",
    "awsCredentialExport",
    "gcpAuthRefresh",
    "forceLoginMethod",
    "forceLoginOrgUUID",
    "forceLoginGatewayUrl",
    "enforceAnthropicSignIn",
    "allowedProviders",
    "otelHeadersHelper",
];

/// The keys of Codex's `config.toml` an added account's copy leaves out, wherever they sit (a model provider, an MCP
/// server, a profile, OpenTelemetry's exporters, the network proxy's credentials, an agent's role): each holds a
/// credential, names the variable or file one is read from, or runs a command that prints one, as Codex's configuration
/// reference and its `rust-v0.169.0` schema (`core/config.schema.json`) list them. With them, the account would sign in
/// to a provider, an MCP server or a telemetry endpoint as the person's own home does.
pub const CODEX_LOGIN_KEYS: [&str; 27] = [
    // the secret itself
    "experimental_bearer_token",
    "bearer_token",
    "http_headers",
    "query_params",
    "model_catalog_url",
    "headers",
    "client_secret",
    "oauth",
    "env",
    "secret_access_key",
    "access_key_id",
    "session_token",
    // where one is read from
    "env_key",
    "env_http_headers",
    "bearer_token_env_var",
    "secret_env_var",
    "secret_file",
    "credential_file",
    "client-private-key",
    "config_file",
    // a command that prints one
    "auth",
    "gateway_oauth",
    "aws",
    "aws_sigv4",
    "http_headers_helper",
    "headers_helper",
    "body_secret_substitution",
];

/// Tables of Codex's `config.toml` left out whole: the enterprise sign-in, and the shell's set variables (any of which
/// can be a key handed to every command).
const CODEX_LOGIN_TABLES: [(&str, &str); 2] = [("", "mcp_enterprise_managed_auth"), ("shell_environment_policy", "set")];

/// Codex `config.toml` text without [`CODEX_LOGIN_KEYS`] and [`CODEX_LOGIN_TABLES`], or `None` when it is not TOML.
pub fn codex_config_copy(text: &str) -> Option<String> {
    fn strip(t: &mut toml::Table, parent: &str) {
        t.retain(|k, _| !CODEX_LOGIN_KEYS.contains(&k) && !CODEX_LOGIN_TABLES.contains(&(parent, k)));
        for (k, v) in t.iter_mut() {
            match v {
                toml::Value::Table(inner) => strip(inner, k),
                toml::Value::Array(items) => {
                    for i in items.iter_mut() {
                        if let toml::Value::Table(inner) = i {
                            strip(inner, k);
                        }
                    }
                }
                _ => {}
            }
        }
    }
    let mut t: toml::Table = text.parse().ok()?;
    strip(&mut t, "");
    toml::to_string(&t).ok()
}

/// The app's note, in an added Claude Code account's home, of the settings copy it last wrote (a sha256), so a copy the
/// account changed since (a plugin it turned on, a model it picked) is the account's own and never written over.
const SETTINGS_NOTE: &str = ".manut-settings-copy";
/// The same note for an added Codex account's `config.toml` copy.
const CONFIG_NOTE: &str = ".manut-config-copy";
/// The largest `settings.json` copied.
const SETTINGS_MAX: u64 = 1 << 20;

/// What [`share`] did for one account: the entries linked to the person's own home (new or already there), the ones the
/// account keeps as its own (a file or folder of its own, or a link elsewhere), and for Claude Code whether its settings are
/// the app's copy (`copied`), the account's own (`own`) or not there (`none`).
#[derive(Debug, Default, Serialize, PartialEq, Eq)]
pub struct Shared {
    pub linked: Vec<String>,
    pub own: Vec<String>,
    pub settings: Option<String>,
}

/// Claude Code `settings.json` text without [`CLAUDE_LOGIN_KEYS`], or `None` when it is not one JSON object.
pub fn claude_settings_copy(text: &str) -> Option<String> {
    let mut v: serde_json::Value = serde_json::from_str(text).ok()?;
    let o = v.as_object_mut()?;
    for k in CLAUDE_LOGIN_KEYS {
        o.remove(k);
    }
    serde_json::to_string_pretty(&v).ok()
}

fn sha256_hex(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    Sha256::digest(bytes).iter().map(|b| format!("{b:02x}")).collect()
}

/// Gives the added account `id` of `cli` the person's configuration from `own` (the CLI's own home on this computer): each of
/// [`shared_names`] that exists there becomes a link in the account's home, unless the account has that entry already
/// (then it is the account's own and stays). Claude Code's settings are a copy without the sign-in keys, written again on
/// each start while the account has not changed it. Nothing is written in `own`, nothing of [`NEVER_SHARED`] is touched, and
/// a link that is not the app's is never replaced. Unix only: elsewhere a link needs rights a person rarely has, so an
/// added account there starts as it always did.
pub fn share(home: &Path, cli: &str, id: &str, own: &Path) -> Result<Shared, String> {
    let dir = account_dir(home, cli, id)?;
    let manut = home.join(".manut");
    for p in [manut.clone(), manut.join("accounts"), manut.join("accounts").join(cli), dir.clone()] {
        if std::fs::symlink_metadata(&p).map(|m| m.file_type().is_symlink()).unwrap_or(false) {
            return Err("the account folder is a link".into());
        }
    }
    if !dir.is_dir() {
        return Err("no such account folder".into());
    }
    let own = own.canonicalize().map_err(|_| "no home of its own".to_string())?;
    if own == dir.canonicalize().map_err(|e| e.to_string())? || !own.is_dir() {
        return Err("no home of its own".into());
    }
    let mut out = Shared::default();
    if !cfg!(unix) {
        return Ok(out);
    }
    for name in shared_names(cli).iter().filter(|n| !NEVER_SHARED.contains(n)) {
        let target = own.join(name);
        if std::fs::symlink_metadata(&target).is_err() {
            continue;
        }
        let link = dir.join(name);
        match std::fs::symlink_metadata(&link) {
            Err(_) => {
                #[cfg(unix)]
                if std::os::unix::fs::symlink(&target, &link).is_ok() {
                    out.linked.push((*name).to_string());
                }
            }
            Ok(m) if m.file_type().is_symlink() && std::fs::read_link(&link).ok().as_deref() == Some(target.as_path()) => {
                out.linked.push((*name).to_string());
            }
            Ok(_) => out.own.push((*name).to_string()),
        }
    }
    match cli {
        "claude" => out.settings = Some(share_copy(&own, &dir, "settings.json", SETTINGS_NOTE, claude_settings_copy)),
        "codex" => out.settings = Some(share_copy(&own, &dir, "config.toml", CONFIG_NOTE, codex_config_copy)),
        _ => {}
    }
    Ok(out)
}

/// The copy of the settings file `name` without its sign-in keys (`copy`, [`share`]): `copied`, `own` or `none`. An
/// earlier version linked Codex's `config.toml` whole; that link, the app's own, is replaced by the copy.
fn share_copy(own: &Path, dir: &Path, name: &str, note_name: &str, copy: fn(&str) -> Option<String>) -> String {
    let src = own.join(name);
    let dst = dir.join(name);
    let note = dir.join(note_name);
    let Some(text) = std::fs::symlink_metadata(&src)
        .ok()
        .filter(|m| m.is_file() && m.len() <= SETTINGS_MAX)
        .and_then(|_| std::fs::read_to_string(&src).ok())
        .and_then(|t| copy(&t))
    else {
        return "none".into();
    };
    let ours = match std::fs::symlink_metadata(&dst) {
        Err(_) => true,
        Ok(m) if m.is_file() && !m.file_type().is_symlink() => {
            let now = std::fs::read(&dst).map(|b| sha256_hex(&b)).unwrap_or_default();
            std::fs::read_to_string(&note).map(|n| n.trim() == now).unwrap_or(false)
        }
        Ok(m) if m.file_type().is_symlink() => std::fs::read_link(&dst).ok().as_deref() == Some(src.as_path()),
        Ok(_) => false,
    };
    if !ours {
        return "own".into();
    }
    // written beside it and moved over it (a link of the app's own included), so the CLI never reads half a file
    let tmp = dir.join(format!("{note_name}.tmp"));
    let _ = std::fs::remove_file(&tmp);
    let mut o = std::fs::OpenOptions::new();
    o.write(true).create_new(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut o, 0o600);
    let wrote = o.open(&tmp).and_then(|mut f| std::io::Write::write_all(&mut f, text.as_bytes())).and_then(|_| std::fs::rename(&tmp, &dst));
    if wrote.is_err() {
        let _ = std::fs::remove_file(&tmp);
        return "none".into();
    }
    let _ = std::fs::write(&note, sha256_hex(text.as_bytes()));
    "copied".into()
}

/// Before a session of `agent` starts with `account_env` ([`session_env_for`]): when that names an added account, give it
/// the person's configuration ([`share`]). Never in the way of the start: whatever cannot be shared stays as it was.
pub fn prepare(home: &Path, agent: &str, account_env: &[(String, String)]) {
    let Some(cli) = session_cli(agent) else { return };
    let Some(var) = home_var(cli) else { return };
    let Some((_, dir)) = account_env.iter().find(|(k, _)| k == var) else { return };
    let Some(id) = Path::new(dir).file_name().and_then(|n| n.to_str()) else { return };
    if account_dir(home, cli, id).ok().as_deref() != Some(Path::new(dir)) {
        return;
    }
    // the person's own home of that CLI: the one set on Settings › Providers, else the CLI's default
    if let Some(own) = crate::past_chats::cli_home(home, agent, &own_home_env(home, cli), &host_env) {
        let _ = share(home, cli, id, &own);
    }
}

// ---------------------------------------------------------------------------------------------
// The fixed commands
// ---------------------------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Step {
    /// Does this CLI have the status command (`codex --help` lists `login`)?
    Help,
    Status,
    Login,
    /// `--version`: the CLI's version, shown beside its name (only [`parse_version`]'s token is kept).
    Version,
}

/// The whole allow-list of what Accounts runs: program = the CLI id, arguments = these. `'static`, so no
/// runtime text can become an argument.
pub fn fixed_args(cli: &str, step: Step) -> Option<&'static [&'static str]> {
    match (cli, step) {
        ("claude", Step::Status) => Some(&["auth", "status", "--json"]),
        ("claude", Step::Login) => Some(&["auth", "login"]),
        ("claude", Step::Version) => Some(&["--version"]),
        ("codex", Step::Help) => Some(&["--help"]),
        ("codex", Step::Status) => Some(&["login", "status"]),
        ("codex", Step::Login) => Some(&["login"]),
        ("codex", Step::Version) => Some(&["--version"]),
        _ => None,
    }
}

/// What manut keeps from a CLI's status: never its text, a token or a key.
#[derive(Debug, Clone, Default, Serialize, PartialEq, Eq)]
pub struct LoginStatus {
    pub logged_in: bool,
    pub email: Option<String>,
    /// `max_20x`, `pro`, … (the page words it).
    pub plan: Option<String>,
    /// `claude.ai`, `chatgpt`, `api_key`, …
    pub method: Option<String>,
    pub last_refresh: Option<String>,
}

/// The fields of `claude auth status --json` manut reads; serde skips every other one.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ClaudeStatus {
    logged_in: Option<bool>,
    email: Option<String>,
    plan_tier: Option<String>,
    subscription_type: Option<String>,
    auth_method: Option<String>,
}

fn short(s: Option<String>, n: usize) -> Option<String> {
    s.map(|v| v.trim().chars().filter(|c| !c.is_control()).take(n).collect::<String>()).filter(|v| !v.is_empty())
}

pub fn parse_claude_status(stdout: &str) -> Option<LoginStatus> {
    let s: ClaudeStatus = serde_json::from_str(stdout.trim()).ok()?;
    let logged_in = s.logged_in.unwrap_or(false);
    Some(LoginStatus {
        logged_in,
        email: if logged_in { short(s.email, 120).filter(|e| e.contains('@')) } else { None },
        plan: if logged_in { short(s.plan_tier.or(s.subscription_type), 40) } else { None },
        method: short(s.auth_method, 40),
        last_refresh: None,
    })
}

/// `codex login status` prints a fixed phrase on stderr (`Logged in using ChatGPT`, or `API key configured -
/// sk-…` with part of the key). Only the exit code and which phrase it was are kept; the text never leaves.
pub fn parse_codex_status(code: Option<i32>, stderr: &str) -> LoginStatus {
    let method = if stderr.contains("ChatGPT") {
        Some("chatgpt".to_string())
    } else if stderr.contains("API key") {
        Some("api_key".to_string())
    } else {
        None
    };
    LoginStatus { logged_in: code == Some(0) && method.is_some(), email: None, plan: None, method, last_refresh: None }
}

/// The two fields of Codex's `auth.json` manut may read when the CLI has no status command. The `tokens`
/// object and the key are skipped by serde without being kept; `id_token` is never decoded.
#[derive(Deserialize)]
struct CodexAuthFile {
    #[serde(default, deserialize_with = "string_or_none")]
    auth_mode: Option<String>,
    #[serde(default, deserialize_with = "string_or_none")]
    last_refresh: Option<String>,
}

/// A string field, or `None` for any other JSON value (so a wrong-typed field is dropped, not echoed).
fn string_or_none<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Option<String>, D::Error> {
    Ok(match serde_json::Value::deserialize(d)? {
        serde_json::Value::String(s) => Some(s),
        _ => None,
    })
}

pub fn codex_status_from_file(path: &Path) -> LoginStatus {
    let Ok(text) = std::fs::read_to_string(path) else {
        return LoginStatus::default();
    };
    match serde_json::from_str::<CodexAuthFile>(&text) {
        Ok(f) => {
            let method = short(f.auth_mode, 40)
                .filter(|m| m.len() <= 24 && m.bytes().all(|c| c.is_ascii_lowercase() || c == b'_'));
            let refresh = short(f.last_refresh, 40)
                .filter(|r| r.bytes().all(|c| c.is_ascii_digit() || matches!(c, b'-' | b':' | b'.' | b'T' | b'Z' | b'+')));
            LoginStatus { logged_in: method.is_some(), email: None, plan: None, method, last_refresh: refresh }
        }
        Err(_) => LoginStatus::default(),
    }
}

/// The version token of `--version` output: the first run of `digits.digits.digits` with its suffix
/// (`2.1.322 (Claude Code)` -> `2.1.322`, `codex-cli 0.167.0-alpha.4.1` -> `0.167.0-alpha.4.1`). Nothing else
/// of the text is kept; output with no such run gives `None`.
pub fn parse_version(stdout: &str) -> Option<String> {
    let b = stdout.as_bytes();
    let digits = |from: usize| b[from..].iter().take_while(|c| c.is_ascii_digit()).count();
    for start in 0..b.len() {
        if !b[start].is_ascii_digit() || (start > 0 && b[start - 1].is_ascii_digit()) {
            continue;
        }
        let mut end = start;
        let mut parts = 0;
        loop {
            let n = digits(end);
            if n == 0 {
                break;
            }
            end += n;
            parts += 1;
            if parts == 3 || b.get(end) != Some(&b'.') || digits(end + 1) == 0 {
                break;
            }
            end += 1;
        }
        if parts < 3 {
            continue;
        }
        // the suffix is one `-pre-release.1` run (letters, digits, dots, hyphens), nothing after it
        let tail = if b.get(end) == Some(&b'-') {
            1 + b[end + 1..].iter().take_while(|c| c.is_ascii_alphanumeric() || **c == b'.' || **c == b'-').count()
        } else {
            0
        };
        let token = stdout[start..end + tail].trim_end_matches(['.', '-']);
        return Some(token.chars().take(40).collect());
    }
    None
}

/// The version of `cli` through its fixed `--version`; `None` for CLIs without one here or output with no
/// version in it. Runs in the CLI's own home (`default`), the same for every account of a CLI.
pub fn version(home: &Path, cli: &str) -> Result<Option<String>, String> {
    if fixed_args(cli, Step::Version).is_none() {
        return Ok(None);
    }
    let (program, args, env) = command_for(home, cli, "default", Step::Version)?;
    let (_, out, _) = run_to_end(&program, args, &env)?;
    Ok(parse_version(&out))
}

/// Whether `codex --help` lists the `login` command (older builds lack `login status`).
pub fn codex_has_login(help: &str) -> bool {
    help.lines().any(|l| l.trim_start().starts_with("login "))
}

// ---------------------------------------------------------------------------------------------
// Finding the CLIs (a Dock-started app has PATH=/usr/bin:/bin)
// ---------------------------------------------------------------------------------------------

/// PATH first, then the folders CLI installers use: `~/.local/bin` (Claude Code), Homebrew, npm/pnpm/bun/
/// cargo/volta globals, then on macOS the CLI folders inside app bundles (the ChatGPT app's Codex); on Windows
/// the npm and WinGet folders.
pub fn search_dirs<E: Fn(&str) -> Option<String>>(env: &E, os: Os) -> Vec<PathBuf> {
    let sep = if os == Os::Windows { ';' } else { ':' };
    let mut dirs: Vec<PathBuf> =
        env("PATH").unwrap_or_default().split(sep).filter(|s| !s.is_empty()).map(PathBuf::from).collect();
    match os {
        Os::Unix => {
            if let Some(home) = env("HOME").filter(|h| !h.is_empty()) {
                let h = Path::new(&home);
                for rel in [".local/bin", ".npm-global/bin", "Library/pnpm", ".bun/bin", ".cargo/bin", ".volta/bin"] {
                    dirs.push(h.join(rel));
                }
            }
            dirs.push(PathBuf::from("/opt/homebrew/bin"));
            dirs.push(PathBuf::from("/usr/local/bin"));
            dirs.extend(crate::sessions::app_bundle_cli_dirs(env("HOME").as_deref()));
        }
        Os::Windows => {
            if let Some(app) = env("APPDATA").filter(|h| !h.is_empty()) {
                dirs.push(Path::new(&app).join("npm"));
            }
            if let Some(local) = env("LOCALAPPDATA").filter(|h| !h.is_empty()) {
                dirs.push(Path::new(&local).join("Microsoft").join("WinGet").join("Links"));
                dirs.push(Path::new(&local).join("pnpm"));
            }
            if let Some(home) = env("USERPROFILE").filter(|h| !h.is_empty()) {
                dirs.push(Path::new(&home).join(".local").join("bin"));
                dirs.push(Path::new(&home).join(".bun").join("bin"));
            }
        }
    }
    let mut seen = std::collections::HashSet::new();
    dirs.retain(|d| seen.insert(d.clone()));
    dirs
}

pub fn file_names(program: &str, os: Os) -> Vec<String> {
    match os {
        Os::Unix => vec![program.to_string()],
        Os::Windows => ["exe", "cmd"].iter().map(|e| format!("{program}.{e}")).collect(),
    }
}

/// The first `dir/name` that `is_program` accepts.
pub fn resolve<X: Fn(&Path) -> bool>(program: &str, dirs: &[PathBuf], is_program: X, os: Os) -> Option<PathBuf> {
    let names = file_names(program, os);
    dirs.iter().flat_map(|d| names.iter().map(move |n| d.join(n))).find(|p| is_program(p))
}

fn host_env(k: &str) -> Option<String> {
    std::env::var(k).ok()
}

#[cfg(unix)]
fn is_program_file(p: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(p).map(|m| m.is_file() && m.permissions().mode() & 0o111 != 0).unwrap_or(false)
}

#[cfg(not(unix))]
fn is_program_file(p: &Path) -> bool {
    p.is_file()
}

/// Which of [`ACCOUNT_CLIS`] are on this computer (PATH and install folders).
pub fn clis_on_this_computer() -> Vec<(&'static str, bool)> {
    let dirs = search_dirs(&host_env, Os::current());
    ACCOUNT_CLIS.iter().map(|c| (*c, resolve(c, &dirs, is_program_file, Os::current()).is_some())).collect()
}

type Prepared = (PathBuf, &'static [&'static str], Vec<(String, OsString)>);

/// The program, its fixed arguments, and the env for `cli`'s `step` with account `id`: the account's home var
/// and a PATH that starts with the program's folder (so `#!/usr/bin/env node` shims find Node).
pub fn command_for(home: &Path, cli: &str, id: &str, step: Step) -> Result<Prepared, String> {
    let args = fixed_args(cli, step).ok_or("not something Manut AI runs")?;
    let mut env: Vec<(String, OsString)> =
        account_env(home, cli, id)?.into_iter().map(|(k, v)| (k, v.into())).collect();
    let os = Os::current();
    let dirs = search_dirs(&host_env, os);
    // the program set on Settings › Providers (checked again now), else the first on the search path as always
    let program = match crate::providers::set_program(cli, &crate::providers::load(home).get(cli), os, is_program_file)? {
        Some(p) => p,
        None => resolve(cli, &dirs, is_program_file, os).ok_or_else(|| format!("{cli} is not on this computer"))?,
    };
    let mut child_dirs: Vec<PathBuf> = program.parent().map(|p| vec![p.to_path_buf()]).unwrap_or_default();
    child_dirs.extend(dirs.into_iter().filter(|d| d.is_dir()));
    env.push(("PATH".into(), std::env::join_paths(child_dirs).map_err(|e| e.to_string())?));
    Ok((program, args, env))
}

fn command(program: &Path, args: &[&str], env: &[(String, OsString)]) -> Command {
    let shim = Os::current() == Os::Windows && program.extension().is_some_and(|e| e.eq_ignore_ascii_case("cmd"));
    let mut cmd = if shim {
        // CreateProcess does not start a batch shim on its own. The path comes from the install folders above
        // and the arguments are fixed.
        let mut c = Command::new("cmd.exe");
        c.arg("/c").arg(program);
        c
    } else {
        Command::new(program)
    };
    cmd.args(args).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    for (k, v) in env {
        cmd.env(k, v);
    }
    crate::platform::no_console_window(&mut cmd);
    crate::appimage::host_env(&mut cmd);
    cmd
}

/// Run a fixed command to the end (or `STATUS_TIMEOUT`): `(exit code, stdout, stderr)`.
fn run_to_end(program: &Path, args: &[&str], env: &[(String, OsString)]) -> Result<(Option<i32>, String, String), String> {
    run_cmd(command(program, args, env), program)
}

/// The version an agent's program prints for Settings › Providers: `argv` is the program a session would start and
/// `--version` (`providers::version_here`), with the session's child `PATH` and nothing else; the output is read to the
/// end (or `STATUS_TIMEOUT`) and only the caller's [`parse_version`] of it is kept.
pub fn run_version(argv: &[OsString], path_env: &OsString) -> Result<Option<String>, String> {
    let (program, rest) = argv.split_first().ok_or("nothing to run")?;
    let mut cmd = Command::new(program);
    cmd.args(rest).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).env("PATH", path_env);
    crate::platform::no_console_window(&mut cmd);
    crate::appimage::host_env(&mut cmd);
    let (_, out, err) = run_cmd(cmd, Path::new(program))?;
    Ok(Some(if out.trim().is_empty() { err } else { out }))
}

/// An agent's own fixed status command for Settings › Providers (`providers::signin_here`): `argv` is the program a
/// session would start and the fixed arguments, run as [`run_version`] runs, to the end or `STATUS_TIMEOUT`. The caller
/// keeps only what its parser reads of `(exit code, stdout, stderr)`.
pub fn run_fixed(argv: &[OsString], path_env: &OsString) -> Result<(Option<i32>, String, String), String> {
    let (program, rest) = argv.split_first().ok_or("nothing to run")?;
    let mut cmd = Command::new(program);
    cmd.args(rest).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).env("PATH", path_env);
    crate::platform::no_console_window(&mut cmd);
    crate::appimage::host_env(&mut cmd);
    run_cmd(cmd, Path::new(program))
}

fn run_cmd(mut cmd: Command, program: &Path) -> Result<(Option<i32>, String, String), String> {
    let mut child = cmd.spawn().map_err(|e| format!("could not start {}: {e}", program.display()))?;
    let read = |s: Option<Box<dyn Read + Send>>| {
        thread::spawn(move || {
            let mut buf = Vec::new();
            if let Some(s) = s {
                let _ = s.take(256 * 1024).read_to_end(&mut buf);
            }
            String::from_utf8_lossy(&buf).into_owned()
        })
    };
    let out = read(child.stdout.take().map(|s| Box::new(s) as Box<dyn Read + Send>));
    let err = read(child.stderr.take().map(|s| Box::new(s) as Box<dyn Read + Send>));
    let start = Instant::now();
    let code = loop {
        if let Some(st) = child.try_wait().map_err(|e| e.to_string())? {
            break st.code();
        }
        if start.elapsed() > STATUS_TIMEOUT {
            let _ = child.kill();
            let _ = child.wait();
            return Err("the status check took too long".into());
        }
        thread::sleep(Duration::from_millis(30));
    };
    Ok((code, out.join().unwrap_or_default(), err.join().unwrap_or_default()))
}

/// The login status of `cli` account `id` (`default` = the CLI's own home), or `None` for CLIs without a
/// status command (pi, oh-my-pi, Grok, Gemini: the bridge's file check stands).
pub fn status(home: &Path, cli: &str, id: &str) -> Result<Option<LoginStatus>, String> {
    match cli {
        "claude" => {
            let (program, args, env) = command_for(home, cli, id, Step::Status)?;
            let (_, out, _) = run_to_end(&program, args, &env)?;
            Ok(Some(parse_claude_status(&out).ok_or("Claude Code gave no status")?))
        }
        "codex" => {
            let (program, help_args, env) = command_for(home, cli, id, Step::Help)?;
            let (_, help, _) = run_to_end(&program, help_args, &env)?;
            if codex_has_login(&help) {
                let args = fixed_args(cli, Step::Status).ok_or("not something Manut AI runs")?;
                let (code, _, err) = run_to_end(&program, args, &env)?;
                Ok(Some(parse_codex_status(code, &err)))
            } else {
                let codex_home = if id == "default" { home.join(".codex") } else { account_dir(home, cli, id)? };
                Ok(Some(codex_status_from_file(&codex_home.join("auth.json"))))
            }
        }
        _ => Ok(None),
    }
}

// ---------------------------------------------------------------------------------------------
// The accounts list, kept by the shell (item 74)
// ---------------------------------------------------------------------------------------------
//
// Settings › Accounts listed and changed accounts through the Hermes bridge (`accounts.list`, `add`, `set_active`,
// `remove`, `label`, `discard`), which Practice and Connected do not have, so the page hid itself there. All the bridge did
// was read and write folders and two small files under `~/.manut/accounts`, which the shell can do in every mode; the
// sign-in and the status were already the shell's. These are those six, for the two CLIs whose sign-in the app runs and
// reads (Claude Code and Codex). The bridge's usage records and its CLIProxyAPI rows are not read here: a row's usage is
// `null` from the shell.

/// The CLIs the shell lists accounts for: the ones whose own sign-in it runs ([`fixed_args`] `Login`) and whose status it
/// reads.
pub const LISTED_CLIS: [&str; 2] = ["claude", "codex"];

/// One account row, in the bridge's shape (`Account` in src/lib/protocol.ts). Never a token: an email at most.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct Row {
    pub id: String,
    pub label: String,
    pub email: String,
    /// `ready` (a sign-in is there) or `login` (none yet). The page's status read wins over it.
    pub state: &'static str,
    pub dir: Option<String>,
    pub usage: Option<()>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct Group {
    pub cli: &'static str,
    pub installed: bool,
    pub active: String,
    pub accounts: Vec<Row>,
}

/// The largest `.claude.json` the email is read from (it holds the account's projects too).
const CLAUDE_JSON_MAX: u64 = 16 << 20;
/// A label's length cap, in characters (the bridge's).
pub const LABEL_MAX: usize = 40;

fn is_real_dir(p: &Path) -> bool {
    std::fs::symlink_metadata(p).map(|m| m.is_dir()).unwrap_or(false)
}

/// The sign-in a CLI home holds, as far as a file shows it without reading a token: Codex's `auth.json` is there (a stat
/// only, the file is never opened); Claude Code's `.claude.json` names its `oauthAccount` (only its email is kept). On
/// macOS Claude Code keeps the key itself in the keychain, so this is the account's own identity file, not the key.
pub fn signed_in_here(cli: &str, cli_home: &Path, claude_json: &Path) -> (bool, String) {
    match cli {
        "codex" => (std::fs::symlink_metadata(cli_home.join("auth.json")).map(|m| m.is_file()).unwrap_or(false), String::new()),
        "claude" => {
            let v = std::fs::symlink_metadata(claude_json)
                .ok()
                .filter(|m| m.is_file() && m.len() <= CLAUDE_JSON_MAX)
                .and_then(|_| std::fs::read_to_string(claude_json).ok())
                .and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok());
            let Some(acct) = v.as_ref().and_then(|v| v.get("oauthAccount")).filter(|a| a.is_object()) else { return (false, String::new()) };
            let email = short(acct.get("emailAddress").and_then(|e| e.as_str()).map(str::to_string), 120).filter(|e| e.contains('@')).unwrap_or_default();
            (true, email)
        }
        _ => (false, String::new()),
    }
}

fn accounts_root(home: &Path) -> PathBuf {
    home.join(".manut").join("accounts")
}

/// Refuses when `~/.manut`, `~/.manut/accounts` or the CLI's folder in it is a link: every write stays in the app's own
/// folders.
fn no_links(home: &Path, cli: &str) -> Result<(), String> {
    let root = accounts_root(home);
    for p in [home.join(".manut"), root.clone(), root.join(cli)] {
        if std::fs::symlink_metadata(&p).map(|m| m.file_type().is_symlink()).unwrap_or(false) {
            return Err("the accounts folder is a link".into());
        }
    }
    Ok(())
}

fn read_json(p: &Path) -> serde_json::Map<String, serde_json::Value> {
    std::fs::symlink_metadata(p)
        .ok()
        .filter(|m| m.is_file() && m.len() <= 64 * 1024)
        .and_then(|_| std::fs::read_to_string(p).ok())
        .and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok())
        .and_then(|v| v.as_object().cloned())
        .unwrap_or_default()
}

/// Write a small JSON file of the app's own through a temporary file and a rename (never through a link).
fn write_json(p: &Path, v: &serde_json::Value) -> Result<(), String> {
    if p.is_symlink() {
        return Err("a link is in the way".into());
    }
    let dir = p.parent().ok_or("no folder")?;
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let tmp = dir.join(format!(".{}.tmp", p.file_name().and_then(|n| n.to_str()).unwrap_or("file")));
    std::fs::write(&tmp, serde_json::to_string_pretty(v).map_err(|e| e.to_string())? + "\n").map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, p).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        e.to_string()
    })
}

/// A label as kept: trimmed, without control characters, at most [`LABEL_MAX`] characters.
pub fn clean_label(label: &str) -> String {
    label.trim().chars().filter(|c| !c.is_control()).take(LABEL_MAX).collect::<String>().trim().to_string()
}

/// An id made from a label: lower-case letters, digits, `.`, `_`, `-`; `account-<n>` when nothing is left or it would be
/// `default`.
pub fn id_from_label(label: &str, taken: &[String]) -> String {
    let mut id = String::new();
    for c in label.to_lowercase().chars() {
        if c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, '.' | '_' | '-') {
            id.push(c);
        } else if !id.ends_with('-') {
            id.push('-');
        }
    }
    let id: String = id.trim_matches(|c| matches!(c, '-' | '.' | '_')).chars().take(LABEL_MAX).collect();
    if valid_account_id(&id) {
        return id;
    }
    (2..1000).map(|n| format!("account-{n}")).find(|i| !taken.contains(i)).unwrap_or_else(|| "account-x".into())
}

/// The ids of `cli`'s added accounts: real folders (never links) with a valid name, sorted.
fn added_ids(home: &Path, cli: &str) -> Vec<String> {
    let mut ids: Vec<String> = std::fs::read_dir(accounts_root(home).join(cli))
        .map(|rd| rd.flatten().filter_map(|e| e.file_name().to_str().map(str::to_string)).filter(|n| valid_account_id(n)).collect())
        .unwrap_or_default();
    ids.retain(|id| is_real_dir(&accounts_root(home).join(cli).join(id)));
    ids.sort();
    ids
}

/// Every account of the [`LISTED_CLIS`] on this computer: the CLI's own login first ("This computer", in the home set on
/// Settings › Providers when one is), then the added ones. A CLI is listed when it is installed or has added accounts.
/// `installed` says whether each CLI's program is there.
pub fn list(home: &Path, installed: &dyn Fn(&str) -> bool, env: &dyn Fn(&str) -> Option<String>) -> Vec<Group> {
    let labels = read_json(&accounts_root(home).join("labels.json"));
    LISTED_CLIS
        .iter()
        .filter_map(|&cli| {
            let ids = added_ids(home, cli);
            let here = installed(cli);
            if !here && ids.is_empty() {
                return None;
            }
            let own = own_home_env(home, cli);
            let own_home = crate::past_chats::cli_home(home, cli, &own, env);
            // Claude Code keeps `.claude.json` inside its config folder when one is named, else beside the home folder
            let named = !own.is_empty() || env("CLAUDE_CONFIG_DIR").is_some_and(|v| !v.is_empty());
            let own_json = match (&own_home, named) {
                (Some(h), true) => h.join(".claude.json"),
                _ => home.join(".claude.json"),
            };
            let (signed, email) = own_home.as_deref().map(|h| signed_in_here(cli, h, &own_json)).unwrap_or((false, String::new()));
            let mut rows = vec![Row {
                id: "default".into(),
                label: labels.get(cli).and_then(|v| v.as_str()).map(clean_label).unwrap_or_default(),
                email,
                state: if signed { "ready" } else { "login" },
                dir: None,
                usage: None,
            }];
            for id in ids {
                let dir = accounts_root(home).join(cli).join(&id);
                let (signed, email) = signed_in_here(cli, &dir, &dir.join(".claude.json"));
                let label = read_json(&dir.join("account.json")).get("label").and_then(|v| v.as_str()).map(clean_label).unwrap_or_default();
                rows.push(Row { id, label, email, state: if signed { "ready" } else { "login" }, dir: Some(dir.to_string_lossy().into_owned()), usage: None });
            }
            Some(Group { cli, installed: here, active: active_account(home, cli), accounts: rows })
        })
        .collect()
}

fn listed(cli: &str) -> Result<(), String> {
    if LISTED_CLIS.contains(&cli) {
        Ok(())
    } else {
        Err("unknown cli".into())
    }
}

/// A new empty home folder for `cli` (made for this account only), named from `label`, with the label kept beside it.
/// The page then runs the CLI's own sign-in with it. Refused when the name is taken.
pub fn add(home: &Path, cli: &str, label: &str) -> Result<(String, PathBuf), String> {
    listed(cli)?;
    no_links(home, cli)?;
    let label = clean_label(label);
    let taken = added_ids(home, cli);
    let id = id_from_label(&label, &taken);
    let dir = account_dir(home, cli, &id)?;
    std::fs::create_dir_all(accounts_root(home).join(cli)).map_err(|e| e.to_string())?;
    let mut b = std::fs::DirBuilder::new();
    #[cfg(unix)]
    std::os::unix::fs::DirBuilderExt::mode(&mut b, 0o700);
    b.create(&dir).map_err(|e| if e.kind() == std::io::ErrorKind::AlreadyExists { format!("an account named {id} already exists") } else { e.to_string() })?;
    write_json(&dir.join("account.json"), &serde_json::json!({ "label": label }))?;
    Ok((id, dir))
}

/// The account new sessions of `cli` start with (`default` or an added account's id). Running sessions are untouched.
pub fn set_active(home: &Path, cli: &str, id: &str) -> Result<(), String> {
    listed(cli)?;
    no_links(home, cli)?;
    if id != "default" && !account_dir(home, cli, id).map(|d| is_real_dir(&d)).unwrap_or(false) {
        return Err("no such account".into());
    }
    let path = accounts_root(home).join("active.json");
    let mut all = read_json(&path);
    all.insert(cli.to_string(), serde_json::Value::String(id.to_string()));
    write_json(&path, &serde_json::Value::Object(all))
}

/// The person's own name for a row ("" clears it); `default` = the CLI's own login.
pub fn set_label(home: &Path, cli: &str, id: &str, label: &str) -> Result<(), String> {
    listed(cli)?;
    no_links(home, cli)?;
    let label = clean_label(label);
    if id == "default" {
        let path = accounts_root(home).join("labels.json");
        let mut all = read_json(&path);
        all.insert(cli.to_string(), serde_json::Value::String(label));
        return write_json(&path, &serde_json::Value::Object(all));
    }
    let dir = account_dir(home, cli, id)?;
    if !is_real_dir(&dir) {
        return Err("no such account".into());
    }
    write_json(&dir.join("account.json"), &serde_json::json!({ "label": label }))
}

/// Deletes `~/.manut/accounts/<cli>/<id>/` and nothing else (never `default`, never through a link). When it was the
/// account new sessions use, they go back to "This computer".
pub fn remove(home: &Path, cli: &str, id: &str) -> Result<(), String> {
    listed(cli)?;
    no_links(home, cli)?;
    let dir = account_dir(home, cli, id)?;
    if !is_real_dir(&dir) {
        return Err("no such account".into());
    }
    std::fs::remove_dir_all(&dir).map_err(|e| e.to_string())?;
    if active_account(home, cli) == "default" {
        let path = accounts_root(home).join("active.json");
        let mut all = read_json(&path);
        if all.get(cli).and_then(|v| v.as_str()) == Some(id) {
            all.insert(cli.to_string(), serde_json::Value::String("default".into()));
            let _ = write_json(&path, &serde_json::Value::Object(all));
        }
    }
    Ok(())
}

/// A cancelled sign-in: removes the new folder, refused when the CLI did sign in there after all.
pub fn discard(home: &Path, cli: &str, id: &str) -> Result<(), String> {
    listed(cli)?;
    let dir = account_dir(home, cli, id)?;
    if signed_in_here(cli, &dir, &dir.join(".claude.json")).0 {
        return Err("this account is signed in; remove it from its menu".into());
    }
    remove(home, cli, id)
}

/// [`list`] on this computer.
pub fn list_here(home: &Path) -> Vec<Group> {
    let on: Vec<(&str, bool)> = clis_on_this_computer();
    let installed = |cli: &str| {
        on.iter().any(|(c, here)| *c == cli && *here) || crate::providers::set_program(cli, &crate::providers::load(home).get(cli), Os::current(), is_program_file).ok().flatten().is_some()
    };
    list(home, &installed, &host_env)
}

// ---------------------------------------------------------------------------------------------
// Sign-in sessions: the CLI's own login with the account's home, output streamed to the page
// ---------------------------------------------------------------------------------------------

/// Streamed to the Accounts page through a Tauri channel.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum LoginEvent {
    Line { text: String },
    Exit { code: Option<i32> },
}

/// One output line for the page: colour codes and carriage-return redraws removed, and any prompt for a code
/// or key dropped (manut never asks for one; the browser hands the sign-in back to the CLI).
pub fn clean_line(raw: &str) -> Option<String> {
    let last = raw.trim_end_matches(['\r', '\n']).rsplit('\r').next().unwrap_or("");
    let mut out = String::with_capacity(last.len());
    let mut chars = last.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\u{1b}' {
            if chars.peek() == Some(&'[') {
                chars.next();
                for d in chars.by_ref() {
                    if ('@'..='~').contains(&d) {
                        break;
                    }
                }
            } else {
                chars.next();
            }
            continue;
        }
        if c.is_control() && c != '\t' {
            continue;
        }
        out.push(c);
    }
    let text = out.trim().to_string();
    let lower = text.to_ascii_lowercase();
    if text.is_empty() || lower.contains("paste") || lower.contains("api key") || lower.contains("token") {
        return None;
    }
    Some(text.chars().take(600).collect())
}

/// Running sign-ins, so Cancel (and app exit) can stop them.
#[derive(Default)]
pub struct Logins {
    next: AtomicU32,
    live: Mutex<HashMap<u32, Arc<Mutex<Child>>>>,
}

impl Logins {
    pub fn new() -> Arc<Logins> {
        Arc::new(Logins::default())
    }

    /// Start `cli`'s own login for manut account `id` (never `default`: the CLI's own home is signed in to in
    /// the CLI itself). The folder must already exist (`accounts.add`).
    pub fn start<F: FnMut(LoginEvent) + Send + 'static>(
        self: &Arc<Self>,
        home: &Path,
        cli: &str,
        id: &str,
        emit: F,
    ) -> Result<u32, String> {
        let dir = account_dir(home, cli, id)?;
        if dir.is_symlink() || !dir.is_dir() {
            return Err("no such account folder".into());
        }
        let (program, args, env) = command_for(home, cli, id, Step::Login)?;
        self.spawn(command(&program, args, &env), emit)
    }

    fn spawn<F: FnMut(LoginEvent) + Send + 'static>(self: &Arc<Self>, mut cmd: Command, mut emit: F) -> Result<u32, String> {
        let mut child = cmd.spawn().map_err(|e| format!("could not start the sign-in: {e}"))?;
        let (tx, rx) = mpsc::channel::<String>();
        let readers: Vec<_> = [
            child.stdout.take().map(|s| Box::new(s) as Box<dyn Read + Send>),
            child.stderr.take().map(|s| Box::new(s) as Box<dyn Read + Send>),
        ]
        .into_iter()
        .flatten()
        .map(|stream| {
            let tx = tx.clone();
            thread::spawn(move || {
                // A prompt without a newline ("Paste code here > ") arrives with the next line or at exit.
                for line in BufReader::new(stream).split(b'\n').map_while(Result::ok) {
                    let _ = tx.send(String::from_utf8_lossy(&line).into_owned());
                }
            })
        })
        .collect();
        drop(tx);
        let id = self.next.fetch_add(1, Ordering::SeqCst) + 1;
        let child = Arc::new(Mutex::new(child));
        self.live.lock().unwrap().insert(id, Arc::clone(&child));
        let me = Arc::clone(self);
        thread::spawn(move || {
            // Watch the process, not the pipes: a helper the CLI started (a browser opener, a shell's `sleep`) can
            // keep stdout open after the CLI itself has exited or was cancelled, and waiting for EOF would then hold
            // the Exit event (and Cancel) until that helper ends.
            let mut emit_line = |raw: String| {
                if let Some(text) = clean_line(&raw) {
                    emit(LoginEvent::Line { text });
                }
            };
            let code = loop {
                match rx.recv_timeout(Duration::from_millis(30)) {
                    Ok(raw) => {
                        emit_line(raw);
                        continue;
                    }
                    // both pipes closed: the process is ending; poll its status without spinning
                    Err(mpsc::RecvTimeoutError::Disconnected) => thread::sleep(Duration::from_millis(30)),
                    Err(mpsc::RecvTimeoutError::Timeout) => {}
                }
                if let Ok(Some(st)) = child.lock().unwrap().try_wait() {
                    break st.code();
                }
            };
            // lines already written before the exit still go out, but never wait long for a helper's pipe
            let grace = Instant::now() + Duration::from_millis(200);
            while let Some(left) = grace.checked_duration_since(Instant::now()) {
                match rx.recv_timeout(left) {
                    Ok(raw) => emit_line(raw),
                    Err(_) => break,
                }
            }
            drop(readers); // detached: a reader blocked on a helper's pipe ends when that helper does
            me.live.lock().unwrap().remove(&id);
            emit(LoginEvent::Exit { code });
        });
        Ok(id)
    }

    /// Stop one sign-in (Cancel). Its `Exit` event still arrives.
    pub fn cancel(&self, id: u32) {
        let child = self.live.lock().unwrap().get(&id).cloned();
        if let Some(c) = child {
            let _ = c.lock().unwrap().kill();
        }
    }

    pub fn cancel_all(&self) {
        let all: Vec<_> = self.live.lock().unwrap().values().cloned().collect();
        for c in all {
            let _ = c.lock().unwrap().kill();
        }
    }

    #[cfg(test)]
    fn count(&self) -> usize {
        self.live.lock().unwrap().len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const TOKEN_KEYS: [&str; 6] = ["access_token", "refresh_token", "id_token", "api_key", "OPENAI_API_KEY", "tokens"];
    const SECRET: &str = "sk-SECRET-never-shown";

    /// The note of the last settings copy is compared with a fresh digest, so a digest is the standard SHA-256 in
    /// lower-case hex (FIPS 180-2's vectors): a new version of the hashing crate must not make a note an earlier build
    /// wrote read as changed.
    #[test]
    fn a_settings_digest_is_the_standard_sha256_in_hex() {
        assert_eq!(sha256_hex(b""), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
        assert_eq!(sha256_hex(b"abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    }

    #[test]
    fn env_per_cli_points_at_the_account_folder() {
        let home = Path::new("/h");
        // joined part by part as the code does, so the separators match on Windows too
        let dir = |cli: &str| home.join(".manut").join("accounts").join(cli).join("work").to_string_lossy().into_owned();
        assert_eq!(account_env(home, "claude", "work").unwrap(), vec![("CLAUDE_CONFIG_DIR".to_string(), dir("claude"))]);
        assert_eq!(account_env(home, "codex", "work").unwrap(), vec![("CODEX_HOME".to_string(), dir("codex"))]);
        assert_eq!(account_env(home, "pi", "work").unwrap(), vec![("PI_CODING_AGENT_DIR".to_string(), dir("pi"))]);
        assert_eq!(account_env(home, "omp", "work").unwrap()[0].0, "PI_CODING_AGENT_DIR");
        assert_eq!(account_env(home, "grok", "work").unwrap()[0].0, "GROK_HOME");
        assert_eq!(account_env(home, "gemini", "work").unwrap()[0].0, "GEMINI_CLI_HOME");
        assert_eq!(account_env(home, "claude", "default").unwrap(), vec![]);
    }

    /// `<tmp>/<name>` with `.manut/accounts/active.json` = `active` and one folder per `(cli, id)` in `folders`.
    fn session_home(name: &str, active: &str, folders: &[(&str, &str)]) -> PathBuf {
        let home = std::env::temp_dir().join(format!("manut-acct-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&home);
        for (cli, id) in folders {
            std::fs::create_dir_all(home.join(".manut").join("accounts").join(cli).join(id)).unwrap();
        }
        std::fs::create_dir_all(home.join(".manut").join("accounts")).unwrap();
        std::fs::write(home.join(".manut").join("accounts").join("active.json"), active).unwrap();
        home
    }

    #[test]
    fn session_env_follows_the_account_chosen_for_new_sessions() {
        let home = session_home("sess", r#"{"claude":"work","codex":"default","grok":"gone","pi":"p"}"#, &[("claude", "work"), ("pi", "p")]);
        let work = home.join(".manut").join("accounts").join("claude").join("work").to_string_lossy().into_owned();
        assert_eq!(session_env(&home, "claude"), vec![("CLAUDE_CONFIG_DIR".to_string(), work)]);
        // "This computer", a folder that is gone, an agent without accounts (pi / omp for now, omh never)
        for agent in ["codex", "grok", "pi", "omp", "omh", "bash"] {
            assert_eq!(session_env(&home, agent), vec![], "{agent}");
        }
        // nothing chosen, or an active.json that is not ours to trust
        for active in ["", "{}", "[]", r#"{"claude":"../../x"}"#, r#"{"claude":{"id":"work"}}"#, r#"{"claude":"Work"}"#] {
            let h = session_home("sess-bad", active, &[("claude", "work")]);
            assert_eq!(session_env(&h, "claude"), vec![], "{active}");
            let _ = std::fs::remove_dir_all(h);
        }
        let _ = std::fs::remove_dir_all(home);
    }

    #[test]
    fn a_restarted_session_keeps_its_account_while_it_exists() {
        let home = session_home("again", r#"{"claude":"work","codex":"work"}"#, &[("claude", "work"), ("claude", "old"), ("codex", "work")]);
        let dir = |cli: &str, id: &str| home.join(".manut").join("accounts").join(cli).join(id).to_string_lossy().into_owned();
        // the account it ran with, even when another one is picked for new sessions now
        assert_eq!(session_env_for(&home, "claude", Some("old")), vec![("CLAUDE_CONFIG_DIR".to_string(), dir("claude", "old"))]);
        // it ran as "This computer": still nothing, whatever is picked now
        assert_eq!(session_env_for(&home, "codex", Some("default")), vec![]);
        // no account saved, a folder that is gone, or an id that is not ours to trust: the one picked for new sessions
        for acct in [None, Some("gone"), Some("../work"), Some("Work"), Some("")] {
            assert_eq!(session_env_for(&home, "claude", acct), vec![("CLAUDE_CONFIG_DIR".to_string(), dir("claude", "work"))], "{acct:?}");
        }
        // agents without accounts never get one
        for agent in ["pi", "omp", "omh", "bash"] {
            assert_eq!(session_env_for(&home, agent, Some("work")), vec![], "{agent}");
        }
        let _ = std::fs::remove_dir_all(home);
    }

    #[test]
    fn env_refuses_other_paths_and_clis() {
        let home = Path::new("/h");
        for id in ["../x", "..", "a/b", "a\\b", "", "Work", "/tmp", "a..b", &"x".repeat(41)] {
            assert!(account_env(home, "claude", id).is_err(), "{id}");
        }
        assert!(account_env(home, "bash", "work").is_err());
        assert!(account_dir(home, "claude", "default").is_err());
        assert!(valid_account_id("account-2") && valid_account_id("a.b_c"));
    }

    #[test]
    fn the_fixed_argv_is_the_whole_allow_list() {
        assert_eq!(fixed_args("claude", Step::Status), Some(&["auth", "status", "--json"][..]));
        assert_eq!(fixed_args("claude", Step::Login), Some(&["auth", "login"][..]));
        assert_eq!(fixed_args("codex", Step::Help), Some(&["--help"][..]));
        assert_eq!(fixed_args("codex", Step::Status), Some(&["login", "status"][..]));
        assert_eq!(fixed_args("codex", Step::Login), Some(&["login"][..]));
        assert_eq!(fixed_args("claude", Step::Version), Some(&["--version"][..]));
        assert_eq!(fixed_args("codex", Step::Version), Some(&["--version"][..]));
        let mut n = 0;
        for cli in ACCOUNT_CLIS.iter().chain(["bash", "sh", "claude --x"].iter()) {
            for step in [Step::Help, Step::Status, Step::Login, Step::Version] {
                n += usize::from(fixed_args(cli, step).is_some());
            }
        }
        assert_eq!(n, 7, "only the seven commands above");
        assert!(fixed_args("pi", Step::Login).is_none() && fixed_args("omp", Step::Login).is_none());
    }

    #[test]
    fn version_keeps_only_the_version_token() {
        assert_eq!(parse_version("2.1.322 (Claude Code)\n").as_deref(), Some("2.1.322"));
        assert_eq!(parse_version("codex-cli 0.167.0-alpha.4.1\n").as_deref(), Some("0.167.0-alpha.4.1"));
        assert_eq!(parse_version("v1.2.3.").as_deref(), Some("1.2.3"));
        assert_eq!(parse_version("tool 12.34 build 7"), None);
        assert_eq!(parse_version(""), None);
        assert_eq!(parse_version("x 1.2.3-beta.1-rest of the text").as_deref(), Some("1.2.3-beta.1-rest"));
        assert_eq!(parse_version("1.2.3-alpha-beta.1 rest").as_deref(), Some("1.2.3-alpha-beta.1"));
        assert_eq!(version(Path::new("/h"), "pi"), Ok(None));
        assert!(fixed_args("pi", Step::Version).is_none() && fixed_args("bash", Step::Version).is_none());
    }

    #[test]
    fn command_for_refuses_before_looking_for_a_program() {
        let home = Path::new("/h");
        assert_eq!(command_for(home, "pi", "default", Step::Login).unwrap_err(), "not something Manut AI runs");
        assert_eq!(command_for(home, "bash", "default", Step::Status).unwrap_err(), "not something Manut AI runs");
        assert_eq!(command_for(home, "claude", "../x", Step::Status).unwrap_err(), "bad account id");
    }

    #[test]
    fn claude_status_keeps_its_fields_and_no_secret() {
        // The shape `claude auth status --json` printed on this Mac (values replaced), plus planted secrets.
        let raw = format!(
            r#"{{"loggedIn":true,"authMethod":"claude.ai","apiProvider":"firstParty","configDirectory":"/x/.claude",
            "loginExpiresAt":"2026-12-07T05:24:39.079Z","email":"owner@example.com","orgId":"0000","orgName":"Org",
            "subscriptionType":"max","storedClaudeAiLogin":true,"planTier":"max_20x",
            "access_token":"{SECRET}","refresh_token":"{SECRET}","primaryApiKey":"{SECRET}","nested":{{"id_token":"{SECRET}"}}}}"#
        );
        let s = parse_claude_status(&raw).unwrap();
        assert_eq!(
            s,
            LoginStatus {
                logged_in: true,
                email: Some("owner@example.com".into()),
                plan: Some("max_20x".into()),
                method: Some("claude.ai".into()),
                last_refresh: None
            }
        );
        let out = serde_json::to_string(&s).unwrap();
        for k in TOKEN_KEYS.iter().chain(["primaryApiKey", SECRET, "configDirectory", "orgId"].iter()) {
            assert!(!out.contains(k), "{k}");
        }
        let signed_out = parse_claude_status(r#"{"loggedIn":false,"authMethod":"none","email":"x@y.z"}"#).unwrap();
        assert!(!signed_out.logged_in && signed_out.email.is_none());
        assert!(parse_claude_status("not json").is_none());
    }

    #[test]
    fn codex_status_keeps_only_the_kind_of_login() {
        let s = parse_codex_status(Some(0), "API key configured - sk-proj-***abcd\nsome notice\n");
        assert_eq!((s.logged_in, s.method.as_deref()), (true, Some("api_key")));
        assert!(!serde_json::to_string(&s).unwrap().contains("sk-"));
        let c = parse_codex_status(Some(0), "Logged in using ChatGPT\n");
        assert_eq!((c.logged_in, c.method.as_deref()), (true, Some("chatgpt")));
        assert!(!parse_codex_status(Some(1), "Not logged in\n").logged_in);
        assert!(codex_has_login("Commands:\n  exec        Run Codex\n  login       Manage login\n"));
        assert!(!codex_has_login("Commands:\n  exec  Run\n"));
    }

    #[test]
    fn codex_auth_file_gives_mode_and_refresh_and_never_a_token() {
        let d = std::env::temp_dir().join(format!("manut-acct-test-{}", std::process::id()));
        std::fs::create_dir_all(&d).unwrap();
        let f = d.join("auth.json");
        let mut rnd: u32 = 25;
        for round in 0..25 {
            rnd = rnd.wrapping_mul(1_103_515_245).wrapping_add(12_345);
            let tokens = format!(
                r#"{{"id_token":"{SECRET}.{round}","access_token":"{SECRET}","refresh_token":"{SECRET}","account_id":"a"}}"#
            );
            let body = match (rnd >> 8) % 5 {
                0 => format!(r#"{{"OPENAI_API_KEY":"{SECRET}","auth_mode":"chatgpt","last_refresh":"2026-11-09T00:00:00Z","tokens":{tokens}}}"#),
                1 => format!(r#"{{"tokens":{tokens},"auth_mode":"{SECRET}","last_refresh":"{SECRET}"}}"#),
                2 => format!(r#"{{"auth_mode":{{"access_token":"{SECRET}"}},"last_refresh":{tokens},"tokens":{tokens}}}"#),
                3 => format!(r#"{{"OPENAI_API_KEY":"{SECRET}","auth_mode":"apikey","tokens":null}}"#),
                _ => format!(r#"[{tokens}]"#),
            };
            std::fs::write(&f, body).unwrap();
            let out = serde_json::to_string(&codex_status_from_file(&f)).unwrap();
            for k in TOKEN_KEYS.iter().chain([SECRET, "sk-", "SECRET"].iter()) {
                assert!(!out.contains(k), "round {round}: {k} in {out}");
            }
        }
        std::fs::write(&f, r#"{"auth_mode":"chatgpt","last_refresh":"2026-11-09T00:00:00Z","tokens":{"id_token":"x"}}"#).unwrap();
        let s = codex_status_from_file(&f);
        assert_eq!(
            (s.logged_in, s.method.as_deref(), s.last_refresh.as_deref()),
            (true, Some("chatgpt"), Some("2026-11-09T00:00:00Z"))
        );
        assert!(!codex_status_from_file(&d.join("missing.json")).logged_in);
        std::fs::remove_dir_all(&d).unwrap();
    }

    #[test]
    fn install_folders_follow_path_without_duplicates() {
        let env = |k: &str| match k {
            "PATH" => Some("/usr/bin:/bin:/opt/homebrew/bin".to_string()),
            "HOME" => Some("/Users/k".to_string()),
            _ => None,
        };
        let dirs = search_dirs(&env, Os::Unix);
        assert_eq!(dirs[0], PathBuf::from("/usr/bin"));
        assert!(dirs.contains(&PathBuf::from("/Users/k/.local/bin")));
        assert_eq!(dirs.iter().filter(|d| **d == PathBuf::from("/opt/homebrew/bin")).count(), 1);
        let claude = PathBuf::from("/Users/k/.local/bin/claude");
        assert_eq!(resolve("claude", &dirs, |p| p == claude, Os::Unix), Some(claude.clone()));
        // the ChatGPT app's bundled Codex comes after every install folder, so it counts only when it is the one
        let tail: Vec<PathBuf> = dirs[dirs.len() - 4..].to_vec();
        assert_eq!(tail, crate::sessions::app_bundle_cli_dirs(Some("/Users/k")));
        assert_eq!(tail[0], PathBuf::from("/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin"));
        assert_eq!(dirs[dirs.len() - 5], PathBuf::from("/usr/local/bin"));
        let bundled = tail[0].join("codex");
        assert_eq!(resolve("codex", &dirs, |p| p == bundled, Os::Unix), Some(bundled.clone()));
        let wenv = |k: &str| match k {
            "PATH" => Some(r"C:\Windows".to_string()),
            "APPDATA" => Some(r"C:\Users\k\AppData\Roaming".to_string()),
            _ => None,
        };
        let wdirs = search_dirs(&wenv, Os::Windows);
        let shim = Path::new(r"C:\Users\k\AppData\Roaming").join("npm").join("codex.cmd");
        assert_eq!(resolve("codex", &wdirs, |p| p == shim, Os::Windows), Some(shim.clone()));
    }

    #[test]
    fn sign_in_lines_are_plain_and_never_ask_for_a_code_or_key() {
        assert_eq!(
            clean_line("\u{1b}[1mOpening browser to sign in…\u{1b}[0m\r\n").as_deref(),
            Some("Opening browser to sign in…")
        );
        assert_eq!(clean_line("Paste code here if prompted > "), None);
        assert_eq!(clean_line("Or enter an API key"), None);
        assert_eq!(clean_line("Saved token to keychain"), None);
        assert_eq!(clean_line("50%\r100%"), Some("100%".into()));
        assert_eq!(clean_line("   "), None);
    }

    #[test]
    fn logins_refuse_the_default_home_and_missing_folders() {
        let logins = Logins::new();
        let home = std::env::temp_dir().join(format!("manut-acct-login-{}", std::process::id()));
        assert_eq!(logins.start(&home, "claude", "default", |_| {}).unwrap_err(), "bad account id");
        assert_eq!(logins.start(&home, "claude", "work", |_| {}).unwrap_err(), "no such account folder");
        assert_eq!(logins.start(&home, "bash", "work", |_| {}).unwrap_err(), "unknown cli");
        assert_eq!(logins.count(), 0);
    }

    #[cfg(unix)]
    #[test]
    fn a_sign_in_streams_lines_then_exit_and_cancel_stops_it() {
        let logins = Logins::new();
        let (tx, rx) = mpsc::channel();
        let mut cmd = Command::new("/bin/sh");
        cmd.args(["-c", "printf 'Opening browser\\nPaste code here > '; echo; sleep 30"])
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let id = logins.spawn(cmd, move |e| tx.send(e).unwrap()).unwrap();
        assert_eq!(rx.recv_timeout(Duration::from_secs(5)).unwrap(), LoginEvent::Line { text: "Opening browser".into() });
        assert_eq!(logins.count(), 1);
        logins.cancel(id);
        let exit = loop {
            match rx.recv_timeout(Duration::from_secs(5)).unwrap() {
                e @ LoginEvent::Exit { .. } => break e,
                LoginEvent::Line { text } => assert!(!text.contains("Paste"), "{text}"),
            }
        };
        assert_eq!(exit, LoginEvent::Exit { code: None });
        assert_eq!(logins.count(), 0);
    }

    /// `<tmp>/<name>` as a person's home: their own Codex and Claude Code homes with made-up configuration and sign-ins, and
    /// an added account of each.
    fn shared_home(name: &str) -> PathBuf {
        let home = std::env::temp_dir().join(format!("manut-acct-share-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&home);
        let put = |rel: &str, text: &str| {
            let p = home.join(rel);
            std::fs::create_dir_all(p.parent().unwrap()).unwrap();
            std::fs::write(p, text).unwrap();
        };
        put(".codex/config.toml", &format!("[mcp_servers.gh]\ncommand = \"gh-mcp\"\nenv = {{ TOKEN = \"{SECRET}\" }}\n"));
        put(".codex/auth.json", &format!(r#"{{"OPENAI_API_KEY":"{SECRET}"}}"#));
        put(".codex/skills/review/SKILL.md", "---\nname: review\n---\n");
        put(".codex/sessions/2026/x.jsonl", "{}\n");
        put(".claude/skills/promptpay/SKILL.md", "---\nname: promptpay\n---\n");
        put(".claude/plugins/installed_plugins.json", "{}");
        put(".claude/CLAUDE.md", "mine\n");
        put(".claude/.credentials.json", &format!(r#"{{"claudeAiOauth":{{"accessToken":"{SECRET}"}}}}"#));
        put(".claude/.claude.json", &format!(r#"{{"oauthAccount":{{"emailAddress":"me@example.com"}},"primaryApiKey":"{SECRET}","mcpServers":{{}}}}"#));
        put(
            ".claude/settings.json",
            &format!(r#"{{"enabledPlugins":{{"x@y":true}},"permissions":{{"allow":["Bash(ls)"]}},"env":{{"ANTHROPIC_API_KEY":"{SECRET}"}},"apiKeyHelper":"echo {SECRET}","forceLoginMethod":"console"}}"#),
        );
        for cli in ["codex", "claude"] {
            std::fs::create_dir_all(home.join(".manut/accounts").join(cli).join("work")).unwrap();
        }
        home
    }

    #[cfg(unix)]
    #[test]
    fn an_added_codex_account_shares_the_configuration_and_never_the_sign_in() {
        let home = shared_home("codex");
        let acct = home.join(".manut/accounts/codex/work");
        // the account's own sign-in, made by `codex login` in its home
        std::fs::write(acct.join("auth.json"), r#"{"auth_mode":"chatgpt"}"#).unwrap();
        let own = home.join(".codex").canonicalize().unwrap();
        let s = share(&home, "codex", "work", &own).unwrap();
        assert_eq!(s.linked, vec!["skills"]);
        // its configuration is a copy, without the MCP server's token
        assert_eq!(s.settings.as_deref(), Some("copied"));
        let copy = std::fs::read_to_string(acct.join("config.toml")).unwrap();
        assert!(copy.contains("gh-mcp") && !copy.contains(SECRET), "{copy}");
        assert!(acct.join("skills/review/SKILL.md").exists());
        // its sign-in is its own and stays so; the person's sessions are not shared
        assert_eq!(std::fs::read_to_string(acct.join("auth.json")).unwrap(), r#"{"auth_mode":"chatgpt"}"#);
        assert!(!acct.join("sessions").exists());
        // again: nothing changes, and an entry the account has of its own stays its own
        std::fs::create_dir_all(home.join(".codex/prompts")).unwrap();
        std::fs::create_dir_all(acct.join("prompts")).unwrap();
        let again = share(&home, "codex", "work", &own).unwrap();
        assert_eq!((again.linked, again.own, again.settings), (vec!["skills".to_string()], vec!["prompts".to_string()], Some("copied".to_string())));
        assert!(!std::fs::symlink_metadata(acct.join("prompts")).unwrap().file_type().is_symlink());
        // the person's home is never written: no link, no new file there
        let names: Vec<String> = std::fs::read_dir(&own).unwrap().flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect();
        assert_eq!(names.len(), 5, "{names:?}");
        let _ = std::fs::remove_dir_all(home);
    }

    /// A made-up `config.toml` with a credential in every place Codex's configuration reference names one: a provider's
    /// bearer token, headers, query and helper command, an MCP server's environment, headers and OAuth secret, a
    /// profile's provider, OpenTelemetry's exporter headers, the shell's set variables and the enterprise sign-in.
    const CODEX_CONFIG: &str = r#"model = "o3"
model_provider = "acme"
approval_policy = "on-request"

[model_providers.acme]
name = "Acme"
base_url = "https://llm.example.com/v1"
env_key = "ACME_KEY"
experimental_bearer_token = "sk-made-up-bearer"
http_headers = { "X-Api-Key" = "sk-made-up-header" }
query_params = { key = "sk-made-up-query" }
auth = { command = "print-made-up-token", args = [] }

[mcp_servers.gh]
command = "gh-mcp"
env = { GITHUB_TOKEN = "ghp_made_up" }

[mcp_servers.docs]
url = "https://mcp.example.com"
http_headers = { Authorization = "Bearer made-up-mcp" }
bearer_token_env_var = "DOCS_TOKEN"
oauth = { client_secret = "made-up-client-secret" }

[profiles.work.model_providers.inner]
base_url = "https://inner.example.com"
experimental_bearer_token = "sk-made-up-profile"

[otel.exporter.otlp-http]
endpoint = "https://otel.example.com"
headers = { "x-otlp-key" = "made-up-otel" }

[shell_environment_policy]
inherit = "core"
set = { DEPLOY_KEY = "made-up-deploy" }

[mcp_enterprise_managed_auth.idp]
client_secret = "made-up-idp"

[projects."/Users/k/shop"]
trust_level = "trusted"
"#;

    /// Codex's `config.toml` can hold provider keys, headers and an MCP server's tokens, so an added account gets a copy
    /// without them, as Claude Code's settings are copied without their sign-in keys: written again on each start while
    /// the account has not changed it, and an earlier version's link to the person's file is replaced by the copy.
    #[cfg(unix)]
    #[test]
    fn an_added_codex_account_gets_the_configuration_without_its_credentials() {
        let home = shared_home("codex-keys");
        std::fs::write(home.join(".codex/config.toml"), CODEX_CONFIG).unwrap();
        let acct = home.join(".manut/accounts/codex/work");
        let own = home.join(".codex").canonicalize().unwrap();
        let s = share(&home, "codex", "work", &own).unwrap();
        assert!(!std::fs::symlink_metadata(acct.join("config.toml")).unwrap().file_type().is_symlink(), "a copy, not a link");
        assert_eq!(s.settings.as_deref(), Some("copied"));
        let copy = std::fs::read_to_string(acct.join("config.toml")).unwrap();
        for secret in ["made-up", "ghp_", "ACME_KEY", "DOCS_TOKEN", "print-made-up-token"] {
            assert!(!copy.contains(secret), "{secret} in the account's config.toml:\n{copy}");
        }
        // what is not a credential is kept: the model, the provider's address, the MCP servers themselves, trust, policy
        let kept: toml::Table = copy.parse().unwrap();
        assert_eq!(kept["model"].as_str(), Some("o3"));
        assert_eq!(kept["model_providers"]["acme"]["base_url"].as_str(), Some("https://llm.example.com/v1"));
        assert_eq!(kept["mcp_servers"]["gh"]["command"].as_str(), Some("gh-mcp"));
        assert_eq!(kept["mcp_servers"]["docs"]["url"].as_str(), Some("https://mcp.example.com"));
        assert_eq!(kept["shell_environment_policy"]["inherit"].as_str(), Some("core"));
        assert_eq!(kept["otel"]["exporter"]["otlp-http"]["endpoint"].as_str(), Some("https://otel.example.com"));
        assert_eq!(kept["projects"]["/Users/k/shop"]["trust_level"].as_str(), Some("trusted"));
        assert!(kept.get("mcp_enterprise_managed_auth").is_none());
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(acct.join("config.toml")).unwrap().permissions().mode() & 0o777, 0o600);
        }
        // the person changes theirs: the unchanged copy follows; the account changes its own: never written over
        std::fs::write(own.join("config.toml"), "model = \"o4\"\n[model_providers.x]\nexperimental_bearer_token = \"made-up-2\"\n").unwrap();
        assert_eq!(share(&home, "codex", "work", &own).unwrap().settings.as_deref(), Some("copied"));
        let copy = std::fs::read_to_string(acct.join("config.toml")).unwrap();
        assert!(copy.contains("o4") && !copy.contains("made-up"));
        std::fs::write(acct.join("config.toml"), "model = \"mine\"\n").unwrap();
        assert_eq!(share(&home, "codex", "work", &own).unwrap().settings.as_deref(), Some("own"));
        assert_eq!(std::fs::read_to_string(acct.join("config.toml")).unwrap(), "model = \"mine\"\n");
        // an account an earlier version linked to the person's file gets the copy instead; anyone else's link stays
        std::fs::remove_file(acct.join("config.toml")).unwrap();
        std::os::unix::fs::symlink(own.join("config.toml"), acct.join("config.toml")).unwrap();
        assert_eq!(share(&home, "codex", "work", &own).unwrap().settings.as_deref(), Some("copied"));
        assert!(!std::fs::symlink_metadata(acct.join("config.toml")).unwrap().file_type().is_symlink());
        std::fs::remove_file(acct.join("config.toml")).unwrap();
        std::os::unix::fs::symlink("/tmp/elsewhere.toml", acct.join("config.toml")).unwrap();
        assert_eq!(share(&home, "codex", "work", &own).unwrap().settings.as_deref(), Some("own"));
        // a file that is not TOML is not copied at all
        std::fs::remove_file(acct.join("config.toml")).unwrap();
        std::fs::write(own.join("config.toml"), "not = [toml").unwrap();
        assert_eq!(share(&home, "codex", "work", &own).unwrap().settings.as_deref(), Some("none"));
        assert!(std::fs::symlink_metadata(acct.join("config.toml")).is_err());
        let _ = std::fs::remove_dir_all(home);
    }

    #[cfg(unix)]
    #[test]
    fn an_added_claude_account_gets_skills_plugins_and_settings_without_the_sign_in_keys() {
        let home = shared_home("claude");
        let acct = home.join(".manut/accounts/claude/work");
        let own = home.join(".claude").canonicalize().unwrap();
        let s = share(&home, "claude", "work", &own).unwrap();
        assert_eq!(s.linked, vec!["skills", "plugins", "CLAUDE.md"]);
        assert_eq!(s.settings.as_deref(), Some("copied"));
        // neither sign-in file is linked or copied
        for never in [".credentials.json", ".claude.json"] {
            assert!(std::fs::symlink_metadata(acct.join(never)).is_err(), "{never}");
        }
        let copy = std::fs::read_to_string(acct.join("settings.json")).unwrap();
        assert!(copy.contains("enabledPlugins") && copy.contains("Bash(ls)"));
        for k in ["env", "ANTHROPIC_API_KEY", "apiKeyHelper", "forceLoginMethod", SECRET] {
            assert!(!copy.contains(k), "{k} in the account's settings");
        }
        assert!(!std::fs::symlink_metadata(acct.join("settings.json")).unwrap().file_type().is_symlink());
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(acct.join("settings.json")).unwrap().permissions().mode() & 0o777, 0o600);
        }
        // the person changes their settings: the app's unchanged copy follows on the next start
        std::fs::write(own.join("settings.json"), r#"{"model":"opus","apiKeyHelper":"x"}"#).unwrap();
        assert_eq!(share(&home, "claude", "work", &own).unwrap().settings.as_deref(), Some("copied"));
        let copy = std::fs::read_to_string(acct.join("settings.json")).unwrap();
        assert!(copy.contains("opus") && !copy.contains("apiKeyHelper"));
        // the account changes its own (Claude Code saved a choice there): never written over again
        std::fs::write(acct.join("settings.json"), r#"{"model":"sonnet"}"#).unwrap();
        std::fs::write(own.join("settings.json"), r#"{"model":"haiku"}"#).unwrap();
        assert_eq!(share(&home, "claude", "work", &own).unwrap().settings.as_deref(), Some("own"));
        assert_eq!(std::fs::read_to_string(acct.join("settings.json")).unwrap(), r#"{"model":"sonnet"}"#);
        let _ = std::fs::remove_dir_all(home);
    }

    #[test]
    fn the_lists_share_configuration_only() {
        for cli in ACCOUNT_CLIS {
            for n in shared_names(cli) {
                assert!(!NEVER_SHARED.contains(n), "{cli}: {n}");
                assert!(!n.contains("auth") && !n.contains("credential") && !n.contains("token") && !n.contains(".env"), "{cli}: {n}");
            }
        }
        // the CLIs whose home is not split stay as they are
        for cli in ["grok", "pi", "omp", "gemini"] {
            assert!(shared_names(cli).is_empty(), "{cli}");
        }
        assert_eq!(claude_settings_copy("[1]"), None);
        assert_eq!(claude_settings_copy(r#"{"env":{"A":"1"},"model":"x"}"#).as_deref(), Some("{\n  \"model\": \"x\"\n}"));
    }

    #[cfg(unix)]
    #[test]
    fn sharing_refuses_a_linked_account_folder_the_default_home_and_a_cli_without_a_list() {
        let home = shared_home("refuse");
        let own = home.join(".codex").canonicalize().unwrap();
        assert_eq!(share(&home, "codex", "default", &own).unwrap_err(), "bad account id");
        assert_eq!(share(&home, "codex", "gone", &own).unwrap_err(), "no such account folder");
        assert_eq!(share(&home, "grok", "work", &own).unwrap_err(), "no such account folder");
        // an account folder that is a link (to the person's own home, say) is never written through
        let link = home.join(".manut/accounts/codex/linked");
        std::os::unix::fs::symlink(&own, &link).unwrap();
        assert_eq!(share(&home, "codex", "linked", &own).unwrap_err(), "the account folder is a link");
        // the account folder is the person's own home: nothing to share
        assert_eq!(share(&home, "codex", "work", &home.join(".manut/accounts/codex/work")).unwrap_err(), "no home of its own");
        // prepare: only an added account's own home variable, for an agent that takes accounts
        let work = home.join(".manut/accounts/codex/work");
        prepare(&home, "codex", &[("CODEX_HOME".into(), "/elsewhere/work".into())]);
        prepare(&home, "pi", &[("CODEX_HOME".into(), work.to_string_lossy().into())]);
        assert!(std::fs::symlink_metadata(work.join("config.toml")).is_err());
        let _ = std::fs::remove_dir_all(home);
    }

    /// Real check on a Mac with Claude Code: the fixed status command in a temp CLAUDE_CONFIG_DIR reads signed
    /// out, and the person's own ~/.claude is not used. `cargo test -- --ignored`.
    #[test]
    #[ignore]
    fn real_claude_status_in_a_temp_home() {
        let home = std::env::temp_dir().join(format!("manut-acct-real-{}", std::process::id()));
        std::fs::create_dir_all(account_dir(&home, "claude", "probe").unwrap()).unwrap();
        let s = status(&home, "claude", "probe").unwrap().unwrap();
        assert!(!s.logged_in && s.email.is_none());
        std::fs::remove_dir_all(&home).unwrap();
    }

    // ---- the accounts list the shell keeps (item 74) ------------------------------------------------------------

    fn list_home(name: &str) -> PathBuf {
        let home = std::env::temp_dir().join(format!("manut-acct-list-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&home);
        std::fs::create_dir_all(&home).unwrap();
        home
    }

    /// Practice and Connected have no bridge: the shell lists, adds, picks, names and removes accounts itself, writing only
    /// under `~/.manut/accounts`, and never reads a token (a Codex `auth.json` is a stat, a Claude Code `.claude.json` gives
    /// its email only).
    #[test]
    fn the_shell_keeps_the_accounts_list_in_every_mode() {
        let home = list_home("ops");
        let none = |_: &str| None;
        // nothing installed and no account: no group; installed: "This computer" alone
        assert!(list(&home, &|_| false, &none).is_empty());
        let g = list(&home, &|c| c == "codex", &none);
        assert_eq!(g.len(), 1);
        assert_eq!((g[0].cli, g[0].active.as_str(), g[0].accounts.len(), g[0].accounts[0].id.as_str(), g[0].accounts[0].state), ("codex", "default", 1, "default", "login"));
        // Codex's own sign-in is a file there; Claude Code's identity names an email (a token beside it is never kept)
        std::fs::create_dir_all(home.join(".codex")).unwrap();
        std::fs::write(home.join(".codex").join("auth.json"), format!(r#"{{"tokens":{{"access_token":"{SECRET}"}}}}"#)).unwrap();
        std::fs::write(home.join(".claude.json"), format!(r#"{{"oauthAccount":{{"emailAddress":"me@example.com","accessToken":"{SECRET}"}}}}"#)).unwrap();
        let g = list(&home, &|_| true, &none);
        assert_eq!(g.iter().map(|g| g.cli).collect::<Vec<_>>(), ["claude", "codex"]);
        assert_eq!((g[0].accounts[0].state, g[0].accounts[0].email.as_str()), ("ready", "me@example.com"));
        assert_eq!(g[1].accounts[0].state, "ready");
        assert!(!serde_json::to_string(&g).unwrap().contains(SECRET));

        // add: a folder of its own (0700) named from the label, the label kept beside it, taken names refused
        let (id, dir) = add(&home, "claude", "  Work  ").unwrap();
        assert_eq!((id.as_str(), dir.clone()), ("work", home.join(".manut").join("accounts").join("claude").join("work")));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(&dir).unwrap().permissions().mode() & 0o777, 0o700);
        }
        assert!(add(&home, "claude", "work").unwrap_err().contains("already exists"));
        assert_eq!(add(&home, "claude", "!!").unwrap().0, "account-2");
        assert_eq!(add(&home, "claude", "Default").unwrap().0, "account-3");
        for bad in ["gemini", "pi", "../x", ""] {
            assert!(add(&home, bad, "x").is_err(), "{bad}");
        }
        let g = list(&home, &|_| true, &none);
        let rows: Vec<(&str, &str, &str)> = g[0].accounts.iter().map(|r| (r.id.as_str(), r.label.as_str(), r.state)).collect();
        assert_eq!(rows, [("default", "", "ready"), ("account-2", "!!", "login"), ("account-3", "Default", "login"), ("work", "Work", "login")]);

        // pick, name, discard and remove
        set_active(&home, "claude", "work").unwrap();
        assert_eq!(active_account(&home, "claude"), "work");
        assert!(set_active(&home, "claude", "gone").is_err() && set_active(&home, "claude", "../../x").is_err());
        set_label(&home, "claude", "default", "Personal").unwrap();
        set_label(&home, "claude", "work", "Team").unwrap();
        let g = list(&home, &|_| true, &none);
        assert_eq!((g[0].accounts[0].label.as_str(), g[0].active.as_str()), ("Personal", "work"));
        assert_eq!(g[0].accounts.iter().find(|r| r.id == "work").unwrap().label, "Team");
        // a sign-in that happened after all is not discarded
        std::fs::write(home.join(".manut/accounts/claude/account-2/.claude.json"), r#"{"oauthAccount":{"emailAddress":"b@example.com"}}"#).unwrap();
        assert!(discard(&home, "claude", "account-2").unwrap_err().contains("signed in"));
        discard(&home, "claude", "account-3").unwrap();
        remove(&home, "claude", "work").unwrap();
        assert!(!dir.exists());
        assert_eq!(active_account(&home, "claude"), "default");
        assert!(remove(&home, "claude", "default").is_err());
        std::fs::remove_dir_all(&home).unwrap();
    }

    /// Nothing is written through a link: an accounts folder that is a link refuses every change, and a link inside the
    /// CLI's folder is never listed or removed.
    #[cfg(unix)]
    #[test]
    fn the_accounts_list_never_follows_a_link() {
        let home = list_home("links");
        let elsewhere = home.join("elsewhere");
        std::fs::create_dir_all(elsewhere.join("keep")).unwrap();
        std::fs::create_dir_all(home.join(".manut/accounts/claude")).unwrap();
        std::os::unix::fs::symlink(elsewhere.join("keep"), home.join(".manut/accounts/claude/linked")).unwrap();
        let g = list(&home, &|_| true, &|_: &str| None);
        assert!(!g[0].accounts.iter().any(|r| r.id == "linked"));
        assert!(remove(&home, "claude", "linked").is_err());
        assert!(elsewhere.join("keep").exists());
        std::fs::remove_dir_all(home.join(".manut/accounts/claude")).unwrap();
        std::os::unix::fs::symlink(&elsewhere, home.join(".manut/accounts/claude")).unwrap();
        assert!(add(&home, "claude", "x").unwrap_err().contains("link"));
        assert!(!elsewhere.join("x").exists());
        std::fs::remove_dir_all(&home).unwrap();
    }

    /// The home folder set on Settings › Providers is what "This computer" means: its variable for a session with no added
    /// account, the folder an added account's settings are shared from, and where its sign-in is read; an added account's
    /// own folder still replaces it.
    #[test]
    fn the_providers_home_is_this_computers_and_an_added_account_wins() {
        let home = list_home("own");
        let mine = home.join("claude-elsewhere");
        std::fs::create_dir_all(&mine).unwrap();
        std::fs::create_dir_all(home.join(".manut")).unwrap();
        std::fs::write(crate::providers::store_path(&home), serde_json::json!({"version": 1, "agents": {"claude": {"home": mine}}}).to_string()).unwrap();
        let own = vec![("CLAUDE_CONFIG_DIR".to_string(), mine.to_string_lossy().into_owned())];
        assert_eq!(own_home_env(&home, "claude"), own);
        assert_eq!(account_env(&home, "claude", "default").unwrap(), own);
        assert_eq!(session_env(&home, "claude"), own);
        assert_eq!(session_env_for(&home, "claude", Some("default")), own);
        assert!(own_home_env(&home, "codex").is_empty());
        // its sign-in is read where Claude Code keeps it for that folder
        std::fs::write(mine.join(".claude.json"), r#"{"oauthAccount":{"emailAddress":"elsewhere@example.com"}}"#).unwrap();
        let g = list(&home, &|c| c == "claude", &|_: &str| None);
        assert_eq!(g[0].accounts[0].email, "elsewhere@example.com");
        // an added account: its own folder, with its settings linked from the folder set here
        let (id, dir) = add(&home, "claude", "work").unwrap();
        set_active(&home, "claude", &id).unwrap();
        let env = session_env(&home, "claude");
        assert_eq!(env, vec![("CLAUDE_CONFIG_DIR".to_string(), dir.to_string_lossy().into_owned())]);
        std::fs::create_dir_all(mine.join("skills")).unwrap();
        prepare(&home, "claude", &env);
        #[cfg(unix)]
        assert_eq!(std::fs::read_link(dir.join("skills")).unwrap(), mine.canonicalize().unwrap().join("skills"));
        std::fs::remove_dir_all(&home).unwrap();
    }
}
