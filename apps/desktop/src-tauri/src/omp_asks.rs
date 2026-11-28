//! oh-my-pi held to asking first as the app's chat (item 139, the sixth security read's H1).
//!
//! omp 18.22.0 defaults its own `tools.approvalMode` to `yolo`, so a chat started with `--mode rpc` alone ran every command,
//! write and edit with no card, in every lane the app makes. Three things now hold an omp chat to the cards, each read in
//! omp itself: its `--help`, `omp config list --json --scope=…` in scratch folders on this Mac, and its source at tag
//! v18.22.0 (commit 3e8cff3, `packages/coding-agent/src`).
//!
//! - Its asking mode on its command line ([`crate::sessions::OMP_CHAT_ARGS`]), a runtime override no settings layer outranks.
//! - An overlay of the app's own, loaded with `--config` ([`OVERLAY`]), that denies omp's `task` tool. omp runs the helpers a
//!   `task` call starts in `yolo` ("Subagents run headless … Use yolo mode to preserve unattended subagent execution", its
//!   `task/executor.ts`), so one card the person allowed let a helper run every command and change after it with no card,
//!   while the chat says every step asks. A `--config` overlay outranks the project's settings and the person's own
//!   (`Settings.getProvenance`), and a `deny` policy wins in every mode (`tools/approval.ts`, `resolvePolicy`); with omp
//!   itself, an overlay's `task: deny` beside a project's `task: allow` reads as `deny`.
//! - Its own settings, read before the start ([`settings_allow`]). A per-tool `tools.approval` policy of `allow` is
//!   "honored in every approval mode" (its own description of the setting), so one in the person's settings or in the
//!   project's would run that tool with no card. omp merges its project layer from the chat's folder alone, out of seven
//!   kinds of file in six tools' folders and four formats (`.omp/config.yml`, `.omp/settings.json`, `.claude/settings.json`,
//!   `.codex/config.toml`, `.cursor/settings.json`, `.gemini/settings.json`, `opencode.json(c)` and
//!   `.opencode/opencode.json(c)`: each set a `tools.approval` entry that omp listed, in a scratch folder here), and its
//!   global layer from the `config.yml` of the agent folder its profile and variables pick. So the shell does not read
//!   those files itself, which could miss one or read one differently: it asks omp, in the chat's folder and with the
//!   chat's variables, for the keys each layer sets as written (`omp config list --json --scope=global|project`, which omp
//!   added "so a host can edit the global value"), as OpenCode's rules are read from its own listing.
//!
//! omp has no switch that leaves out the project layer: its `disabledProviders` setting drops whole tools' folders, the
//! person's own with them, and never `.omp`. So the project's settings are checked, not left out. A change the agent makes
//! to one of these files during the chat asks at every level (`.omp`, `.claude`, `.codex`, `.cursor`, `.gemini`,
//! `opencode.json` and `.opencode` are in `src/code/command/protected.ts`), and omp's own folder is outside the project.
//!
//! Item 139b: code a project carries no longer runs inside an omp chat as it starts. omp imports a project's extension
//! modules (`.omp/extensions`, an `extensions` entry in any of its project settings files) and hooks (`.omp/hooks/pre` and
//! `post`, `.claude/hooks`, `.codex/hooks`) when a session starts, with no card, and has no switch that leaves out only the
//! project's: its user-or-project choice exists for MCP servers alone (`mcp.enableProjectConfig`), and
//! `isUserSourceEnabled` only turns the person's foreign folders on or off. So every chat starts with `--no-extensions`
//! ([`crate::sessions::OMP_CHAT_ARGS`]), which turns all of omp's own discovery of extensions and hooks off (its
//! `discoverExtensionPaths` with `ambient: false`, `extensions/loader.ts`, which also drops code-written commands and the
//! extensions of installed and configured packages), and the person's own extension modules and hooks are named again with
//! `-e` and `--hook` ([`own_files`]), found in omp's own folder as omp itself finds them. Three more things a project carries
//! act as omp starts whatever `--no-extensions` says, each read in omp's source and two seen with omp itself, starting it in
//! scratch folders with nothing sent: its custom tools (`.omp/tools`, `.claude/tools`, `.codex/tools`, and the tools of
//! plugins installed for the project in `.omp/plugins`), which `discoverCustomToolPaths` imports for every session, and its
//! `.env`, from which omp sets any of its own variables the chat did not set (`PI_CONFIG_FILES`, `PI_CODING_AGENT_DIR`,
//! `PI_SHELL_PREFIX`, the `OMP_` names copied to `PI_`), each refuse the chat ([`project_code`]); a project's MCP servers,
//! which start as programs, are left out by the overlay ([`OVERLAY`]). `--no-lsp` keeps omp from starting a language server or
//! formatter it finds in the project's own folders, as item 114 did for OpenCode.

use std::ffi::OsString;
use std::path::{Path, PathBuf};

use serde_json::Value;

/// The overlay's text: omp's `task` tool denied, and the project's MCP servers left out (item 139b: each is a program omp
/// starts as the chat starts, and `mcp.enableProjectConfig: false` drops every server a project file names while the
/// person's own stay, as omp 18.22.0 showed here, starting the server of a scratch project's `.mcp.json` without it and not
/// with it). YAML, as omp reads a `--config` file.
pub const OVERLAY: &str = "# Manut AI: oh-my-pi runs the helpers a task call starts without asking, so its chats in Manut AI deny that tool.\ntools:\n  approval:\n    task: deny\n# A project's own MCP servers are programs that would start with the chat before anything asks, so they are left out.\nmcp:\n  enableProjectConfig: false\n";

/// `<home>/.manut/omp/asks.yml`, the one file Manut AI writes for oh-my-pi.
pub fn overlay_path(home: &Path) -> PathBuf {
    home.join(".manut").join("omp").join("asks.yml")
}

/// Write [`OVERLAY`] to `path` unless it already holds exactly that, as DSH's overlay is written. A link in its place or
/// in place of its folder is refused: the chat then does not start, since without it a helper would run unasked.
pub fn write_overlay(path: &Path) -> Result<(), String> {
    if path.is_symlink() || path.parent().is_some_and(Path::is_symlink) {
        return Err(format!("{} is a link; Manut AI does not write through it", path.display()));
    }
    if std::fs::read_to_string(path).is_ok_and(|t| t == OVERLAY) {
        return Ok(());
    }
    std::fs::create_dir_all(path.parent().ok_or("no folder")?).map_err(|e| e.to_string())?;
    std::fs::write(path, OVERLAY).map_err(|e| e.to_string())
}

/// The arguments that load the overlay at `path`: `--config` and the path as one argument. A Windows `.cmd` shim runs
/// through `cmd.exe /c`, which parses the line itself, so there the path goes in as [`crate::sessions::cmd_path_arg`]
/// allows it, and one it refuses refuses the start.
pub fn overlay_args(path: &Path, through_cmd: bool) -> Result<Vec<OsString>, String> {
    let arg = if through_cmd { OsString::from(crate::sessions::cmd_path_arg(&path.to_string_lossy())?) } else { path.as_os_str().to_owned() };
    Ok(vec!["--config".into(), arg])
}

/// The variable omp reads more overlay files from (`PI_CONFIG_FILES`, its `config/settings.ts`). A layer's listing does
/// not show what such a file sets, so a chat does not start while it is set (the person's own variables on Settings ›
/// Providers already refuse it).
pub const OVERLAYS_VAR: &str = "PI_CONFIG_FILES";

/// The approval modes in which omp asks before a write and before a command (its settings table: `always-ask`, and
/// `always-ask-cached`, which also asks before a read). `write` lets every write tool run alone and `yolo` every tool.
pub const ASKING: [&str; 2] = ["always-ask", "always-ask-cached"];

/// The two listings, each the keys one layer sets with their values as written: the person's own (`global`, the
/// `config.yml` of the agent folder) and the project's (`project`, the chat's folder).
pub const LISTINGS: [[&str; 4]; 2] = [["config", "list", "--json", "--scope=global"], ["config", "list", "--json", "--scope=project"]];

/// What one layer's listing (a JSON object of setting ids, each `{ value, type, description }`) says. `Some(true)`: it
/// leaves omp asking, since `tools.approvalMode`, when the layer sets it, is one of [`ASKING`], and every `tools.approval`
/// policy it sets is `prompt` or `deny`, compared as omp compares them (blanks trimmed, any case). `Some(false)`: it sets
/// anything else there (another mode or policy, or a value of another kind, which omp would read as no policy or as
/// `yolo`; a value it might read differently is not taken as safe). `None`: it is not a listing (not such an object, or one
/// of the two entries has no value, as only a credential's would). A `null` is a value omp counts as unset, so the mode on
/// the command line applies to it as to an absent one.
pub fn layer_asks(listing: &str) -> Option<bool> {
    let Ok(Value::Object(keys)) = serde_json::from_str::<Value>(listing.trim()) else { return None };
    let set = |id: &str| -> Option<Option<&Value>> { keys.get(id).map(|entry| entry.get("value")) };
    let (Some(mode), Some(policies)) = (set("tools.approvalMode").unwrap_or(Some(&Value::Null)), set("tools.approval").unwrap_or(Some(&Value::Null))) else {
        return None;
    };
    let mode_asks = match mode {
        Value::Null => true,
        Value::String(m) => ASKING.contains(&m.as_str()),
        _ => false,
    };
    let policies_ask = match policies {
        Value::Null => true,
        Value::Object(each) => each.values().all(|p| matches!(p, Value::String(s) if matches!(s.trim().to_lowercase().as_str(), "prompt" | "deny"))),
        _ => false,
    };
    Some(mode_asks && policies_ask)
}

/// Why an omp chat did not start when its settings could not be checked: a listing failed, ran out of time or printed
/// something else, or [`OVERLAYS_VAR`] is set (the UI shows it translated, `ss.noAsksCheck`).
pub fn no_check(label: &str) -> String {
    format!("{label} did not start because Manut AI could not check that its own settings make it ask first.")
}

/// Whether an omp chat may start as far as its own settings say: `overlays` is [`OVERLAYS_VAR`]'s value in the chat's
/// variables (then the app's), and `list` runs omp with one of [`LISTINGS`] in the chat's folder with the chat's
/// variables, giving what it printed when it ended well. A layer that would let a tool run unasked refuses with
/// [`crate::acp_chat::no_asks`]; any doubt refuses with [`no_check`]. Nothing is started either way. When both ask, what
/// the person's own layer's listing printed comes back, for the extensions they turned off ([`disabled_of`]).
pub fn settings_allow(label: &str, overlays: Option<&str>, list: &dyn Fn(&[&str]) -> Option<String>) -> Result<String, String> {
    if overlays.is_some_and(|v| !v.trim().is_empty()) {
        return Err(no_check(label));
    }
    let mut own = String::new();
    for args in LISTINGS {
        let printed = list(&args);
        match printed.as_deref().map(layer_asks) {
            Some(Some(true)) => {}
            Some(Some(false)) => return Err(crate::acp_chat::no_asks(label)),
            Some(None) | None => return Err(no_check(label)),
        }
        if args == LISTINGS[0] {
            own = printed.unwrap_or_default();
        }
    }
    Ok(own)
}

/// The command that prints omp's own folder (`omp config path`, which prints its `getAgentDir()`): the agent folder whose
/// `extensions` and `hooks` omp discovers as the person's own and whose `config.yml` is their settings layer. The shell runs
/// it in the app's own folder that holds [`OVERLAY`], with the chat's variables, so a project cannot choose it.
pub const AGENT_DIR: [&str; 2] = ["config", "path"];

/// The folder [`AGENT_DIR`] printed: one line ending in at most one line break, an absolute path. Anything else is `None`,
/// and the chat then does not start ([`no_check`]), since the person's own extensions could not be found.
pub fn agent_dir_of(printed: &str) -> Option<PathBuf> {
    let line = printed.strip_suffix('\n').map_or(printed, |l| l.strip_suffix('\r').unwrap_or(l));
    if line.is_empty() || line.contains(['\n', '\r', '\0']) {
        return None;
    }
    let dir = PathBuf::from(line);
    dir.is_absolute().then_some(dir)
}

/// The extensions and hooks the person turned off in their own layer (`disabledExtensions` in its listing: ids such as
/// `extension-module:<name>` and `hook:pre:bash:bash.ts`), which omp's own discovery leaves out and its explicit paths do
/// not (`discoverSessionExtensionPaths` applies the list only to discovery). A listing without the key, or a value of
/// another kind, turns nothing off; an id that is not text is passed over.
pub fn disabled_of(listing: &str) -> Vec<String> {
    let Ok(Value::Object(keys)) = serde_json::from_str::<Value>(listing.trim()) else { return Vec::new() };
    match keys.get("disabledExtensions").and_then(|entry| entry.get("value")) {
        Some(Value::Array(ids)) => ids.iter().filter_map(|id| id.as_str().map(str::to_string)).collect(),
        _ => Vec::new(),
    }
}

/// One of the person's own files that an omp chat names on its command line, since `--no-extensions` turns omp's own
/// discovery off: an extension module (`-e`) or a hook (`--hook`). omp loads both the same way, as extension factories.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Own {
    Extension(PathBuf),
    Hook(PathBuf),
}

/// The person's own extension modules and hooks in omp's own folder `agent_dir`, as omp's own discovery finds them there
/// (its `discoverExtensionModulePaths` and the native hooks provider, `discovery/helpers.ts` and `discovery/builtin.ts`), in
/// the order it loads them and without the ones in `disabled`:
///
/// - In `extensions/`: each `.ts` or `.js` file; then, for each folder (a linked one too), the files its `package.json`
///   declares (`omp.extensions`, else `pi.extensions`: each a file, or a folder whose `index.ts` or `index.js` is taken),
///   else its `index.ts`, else its `index.js`. A name (the file's, or its folder's for an index) is loaded once, the first
///   one winning, as omp keys them; a hidden entry is passed over, as omp's file search does.
/// - In `hooks/pre/` and `hooks/post/`: each file or link whose name ends in `.ts` or `.js` and does not start with a dot.
///
/// A file reached twice, by a link, is named once, as omp keys them by their real path. A folder that cannot be read gives
/// nothing. What else omp would load as the person's own is left out of the app's chats: the `extensions` paths of their
/// settings and of a legacy `settings.json`, installed plugins' extensions and hooks, hooks in another tool's folder they
/// turned on, and omp's code-written commands; none of them is the project's.
pub fn own_files(agent_dir: &Path, disabled: &[String]) -> Vec<Own> {
    let mut seen = std::collections::HashSet::new();
    let mut first = |p: &Path| seen.insert(std::fs::canonicalize(p).unwrap_or_else(|_| p.to_path_buf()));
    let mut own = Vec::new();
    let mut names = std::collections::HashSet::new();
    for p in extension_modules(&agent_dir.join("extensions")) {
        let name = module_name(&p);
        if disabled.iter().any(|d| *d == format!("extension-module:{name}")) || !names.insert(name) || !first(&p) {
            continue;
        }
        own.push(Own::Extension(p));
    }
    for kind in ["pre", "post"] {
        for (name, p) in visible_entries(&agent_dir.join("hooks").join(kind)) {
            let linked_or_file = std::fs::symlink_metadata(&p).is_ok_and(|m| m.is_file() || m.file_type().is_symlink());
            if !linked_or_file || !(name.ends_with(".ts") || name.ends_with(".js")) {
                continue;
            }
            let tool = name.rsplit_once('.').map_or(name.as_str(), |(stem, _)| stem);
            if disabled.iter().any(|d| *d == format!("hook:{kind}:{tool}:{name}")) || !first(&p) {
                continue;
            }
            own.push(Own::Hook(p));
        }
    }
    own
}

/// A folder's entries whose names do not start with a dot, by name, each with its path (joined from the name as the
/// system gave it, so a name that is not UTF-8 still leads to its file).
fn visible_entries(dir: &Path) -> Vec<(String, PathBuf)> {
    let Ok(read) = std::fs::read_dir(dir) else { return Vec::new() };
    let mut entries: Vec<(String, PathBuf)> = read.filter_map(Result::ok).map(|e| (e.file_name().to_string_lossy().into_owned(), e.path())).filter(|(n, _)| !n.starts_with('.')).collect();
    entries.sort();
    entries
}

/// The extension module files of an `extensions/` folder, in omp's order: its own `.ts` and `.js` files, then the files
/// its folders' manifests declare, then its folders' index files ([`own_files`]).
fn extension_modules(dir: &Path) -> Vec<PathBuf> {
    let (mut files, mut declared, mut indexes) = (Vec::new(), Vec::new(), Vec::new());
    for (name, p) in visible_entries(dir) {
        // followed through a link, as omp's file search takes a linked file and its discovery a linked folder
        let Ok(meta) = std::fs::metadata(&p) else { continue };
        if meta.is_file() && (name.ends_with(".ts") || name.ends_with(".js")) {
            files.push(p);
        } else if meta.is_dir() {
            match manifest_entries(&p) {
                Some(entries) => declared.extend(entries),
                None => indexes.extend(index_of(&p)),
            }
        }
    }
    files.into_iter().chain(declared).chain(indexes).collect()
}

/// The files a folder's `package.json` declares as extensions, or `None` when it declares none (no such file, not JSON, no
/// `omp` object nor `pi` one, or no text entry in its `extensions` list). An entry that leads to no file is passed over.
fn manifest_entries(folder: &Path) -> Option<Vec<PathBuf>> {
    let pkg: Value = serde_json::from_str(&std::fs::read_to_string(folder.join("package.json")).ok()?).ok()?;
    // `pkg.omp ?? pkg.pi`: a `pi` field counts only when `omp` is absent or null, and the one taken must be an object
    let manifest = match pkg.get("omp") {
        Some(m) if !m.is_null() => m,
        _ => pkg.get("pi")?,
    };
    let entries: Vec<&str> = manifest.as_object()?.get("extensions")?.as_array()?.iter().filter_map(Value::as_str).collect();
    if entries.is_empty() {
        return None;
    }
    Some(
        entries
            .into_iter()
            .filter_map(|entry| {
                let p = folder.join(entry);
                let p = if p.is_dir() { index_of(&p)? } else { p };
                p.is_file().then_some(p)
            })
            .collect(),
    )
}

/// A folder's `index.ts`, else its `index.js`, when it is a file.
fn index_of(folder: &Path) -> Option<PathBuf> {
    ["index.ts", "index.js"].iter().map(|n| folder.join(n)).find(|p| p.is_file())
}

/// The name omp gives an extension module (its `getExtensionNameFromPath`): an index file's folder name, else the file's
/// name without its last extension.
fn module_name(p: &Path) -> String {
    let base = p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    if base == "index.ts" || base == "index.js" {
        return p.parent().and_then(Path::file_name).map(|n| n.to_string_lossy().into_owned()).unwrap_or(base);
    }
    match base.rfind('.') {
        Some(dot) if dot > 0 => base[..dot].to_string(),
        _ => base,
    }
}

/// The arguments that name the person's own files: `-e <path>` for an extension module and `--hook <path>` for a hook,
/// each path one argument, after the app's own (a Windows `.cmd` shim takes each path as [`crate::sessions::cmd_path_arg`]
/// allows it, and one it refuses refuses the start, as the overlay's does).
pub fn own_args(own: &[Own], through_cmd: bool) -> Result<Vec<OsString>, String> {
    let mut args = Vec::new();
    for file in own {
        let (flag, p) = match file {
            Own::Extension(p) => ("-e", p),
            Own::Hook(p) => ("--hook", p),
        };
        let arg = if through_cmd { OsString::from(crate::sessions::cmd_path_arg(&p.to_string_lossy())?) } else { p.as_os_str().to_owned() };
        args.extend([OsString::from(flag), arg]);
    }
    Ok(args)
}

/// The folders of a project from which omp imports custom tools as every session starts, whatever `--no-extensions` says:
/// its own, Claude Code's and Codex's (the `tools` providers of `discovery/builtin.ts`, `claude.ts` and `codex.ts`, each
/// read in the chat's folder alone; omp 18.22.0 imported a scratch project's `.omp/tools` module under `--no-extensions`).
pub const TOOL_FOLDERS: [&str; 3] = [".omp/tools", ".claude/tools", ".codex/tools"];

/// The largest `.env` the shell reads to look for omp's own variables; a larger one refuses, as one it could not check.
const ENV_LIMIT: u64 = 1 << 20;

/// What in the chat's folder `cwd` would still run or apply inside omp as it starts, as the person should see it named, or
/// `None` when there is nothing:
///
/// - a folder of [`TOOL_FOLDERS`] with anything in it but hidden entries (any file at all, not only the modules omp imports);
/// - plugins installed for the project: a `.omp/plugins` in `cwd` or in any folder above it, up to and not including
///   `home` (omp reads the nearest one, `resolveActiveProjectRegistryPath`, for its own plugins' tools and Claude Code's,
///   and the person's own plugins folder is in their home, which is never a project);
/// - a `.env` in `cwd` with a line that sets a name starting `PI_` or `OMP_`, in any case (omp sets each name it holds that
///   the chat did not set, before it reads its folders and overlays, and copies `OMP_` names to `PI_`; seen here with omp
///   18.22.0: a project's `PI_CODING_AGENT_DIR` became omp's own folder and its `PI_CONFIG_FILES` an overlay allowing every
///   command, which neither layer listing shows). Lines are read as omp's dotenv reads them, more loosely: every kind of
///   line break starts one, and `export` before the name counts. omp reads no other dotenv file (`.env.local`,
///   `.env.development` and `.env.production` set nothing there).
pub fn project_code(cwd: &Path, home: Option<&Path>) -> Option<String> {
    for folder in TOOL_FOLDERS {
        if !visible_entries(&cwd.join(folder)).is_empty() {
            return Some(folder.to_string());
        }
    }
    let real = |p: &Path| std::fs::canonicalize(p).unwrap_or_else(|_| p.to_path_buf());
    let (start, home) = (real(cwd), home.map(real));
    let mut dir = Some(start.as_path());
    while let Some(d) = dir {
        if home.as_deref() == Some(d) {
            break;
        }
        let plugins = d.join(".omp").join("plugins");
        if std::fs::symlink_metadata(&plugins).is_ok() {
            return Some(if d == start { ".omp/plugins".to_string() } else { plugins.display().to_string() });
        }
        dir = d.parent();
    }
    let env = cwd.join(".env");
    match std::fs::metadata(&env) {
        Ok(m) if m.is_file() && m.len() > ENV_LIMIT => Some(".env".to_string()),
        Ok(m) if m.is_file() => std::fs::read(&env).ok().filter(|bytes| names_omp_variable(&String::from_utf8_lossy(bytes))).map(|_| ".env".to_string()),
        _ => None,
    }
}

/// Whether a dotenv text has a line that sets a name starting `PI_` or `OMP_` (in any letter case, as Windows compares
/// names): a line, split at every kind of line break, whose first word after any blanks and an `export` is such a name.
fn names_omp_variable(text: &str) -> bool {
    text.trim_start_matches('\u{feff}').split(['\n', '\r', '\u{0b}', '\u{0c}', '\u{85}', '\u{2028}', '\u{2029}']).any(|line| {
        let line = line.trim_start();
        let name = line.strip_prefix("export").filter(|rest| rest.starts_with(char::is_whitespace)).map_or(line, str::trim_start).as_bytes();
        name.get(..3).is_some_and(|p| p.eq_ignore_ascii_case(b"PI_")) || name.get(..4).is_some_and(|p| p.eq_ignore_ascii_case(b"OMP_"))
    })
}

/// Why an omp chat did not start in a folder that holds code or variables of its own for omp ([`project_code`], `what`
/// naming it; the UI shows it translated, `ss.ompProjectCode`).
pub fn project_code_refusal(label: &str, what: &str) -> String {
    format!("{label} did not start because this folder holds its own code or variables for it ({what}), which would run or apply as it starts, before anything asks you.")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    /// One layer's listing as omp prints it, with these setting ids and values.
    fn listing(entries: &[(&str, Value)]) -> String {
        let mut o = serde_json::Map::new();
        for (id, v) in entries {
            o.insert(id.to_string(), serde_json::json!({ "value": v, "type": "x", "description": "y" }));
        }
        Value::Object(o).to_string()
    }

    /// A layer that sets neither key, or sets them to ask, leaves omp asking; any mode or policy that lets a tool run unasked,
    /// any value of another kind, and any text that is not a listing refuses.
    #[test]
    fn only_a_layer_that_keeps_omp_asking_passes() {
        use serde_json::json;
        // omp 18.22.0's own words on this Mac for a layer with no such key (the five keys the person's config sets)
        let own = r#"{"composer.shape":{"value":"round","type":"enum","description":"x"},"setupVersion":{"value":3,"type":"number","description":"x"}}"#;
        for ok in [
            "{}".to_string(),
            own.to_string(),
            listing(&[("tools.approvalMode", json!("always-ask"))]),
            listing(&[("tools.approvalMode", json!("always-ask-cached"))]),
            listing(&[("tools.approvalMode", json!(null))]),
            listing(&[("tools.approval", json!({}))]),
            listing(&[("tools.approval", json!(null))]),
            listing(&[("tools.approval", json!({"bash": "prompt", "edit": "deny", "computer.control": " DENY ", "write": "Prompt"}))]),
            listing(&[("tools.approvalMode", json!("always-ask")), ("tools.approval", json!({"task": "deny"})), ("theme.dark", json!("titanium"))]),
        ] {
            assert_eq!(layer_asks(&ok), Some(true), "{ok}");
        }
        for unsafe_layer in [
            listing(&[("tools.approvalMode", json!("yolo"))]),
            listing(&[("tools.approvalMode", json!("write"))]),
            listing(&[("tools.approvalMode", json!("ALWAYS-ASK"))]),
            listing(&[("tools.approvalMode", json!("always-ask "))]),
            listing(&[("tools.approvalMode", json!(true))]),
            listing(&[("tools.approvalMode", json!(["always-ask"]))]),
            listing(&[("tools.approval", json!({"bash": "allow"}))]),
            listing(&[("tools.approval", json!({"edit": "ALLOW"}))]),
            listing(&[("tools.approval", json!({"write": " allow "}))]),
            listing(&[("tools.approval", json!({"computer.control": "allow"}))]),
            listing(&[("tools.approval", json!({"bash": "prompt", "task": "allow"}))]),
            listing(&[("tools.approval", json!({"bash": true}))]),
            listing(&[("tools.approval", json!({"bash": {"policy": "prompt"}}))]),
            listing(&[("tools.approval", json!({"bash": ""}))]),
            listing(&[("tools.approval", json!("allow"))]),
            listing(&[("tools.approval", json!(["bash"]))]),
            listing(&[("tools.approvalMode", json!("always-ask")), ("tools.approval", json!({"eval": "allow"}))]),
        ] {
            assert_eq!(layer_asks(&unsafe_layer), Some(false), "{unsafe_layer}");
        }
        for unread in [
            // an entry with no value (as a credential's is listed), or one that is not an entry, cannot be checked
            r#"{"tools.approval":{"redacted":true,"type":"record","description":"x"}}"#.to_string(),
            r#"{"tools.approvalMode":"yolo"}"#.to_string(),
            "[]".to_string(),
            "".to_string(),
            "not json".to_string(),
            "Settings in the project layer:\n  tools.approvalMode = always-ask".to_string(),
        ] {
            assert_eq!(layer_asks(&unread), None, "{unread}");
        }
    }

    /// Both layers are listed, each with its own scope; an unsafe one refuses with the settings sentence and a missing or
    /// unreadable listing with the could-not-check sentence, and an overlay variable refuses before omp is run at all.
    #[test]
    fn settings_allow_lists_both_layers_and_refuses_each_unsafe_one() {
        use serde_json::json;
        let safe = listing(&[("tools.approvalMode", json!("always-ask"))]);
        let yolo = listing(&[("tools.approvalMode", json!("yolo"))]);
        let allow = listing(&[("tools.approval", json!({"bash": "allow"}))]);
        let run = |global: Option<&str>, project: Option<&str>, overlays: Option<&str>| {
            let asked = RefCell::new(Vec::new());
            let got = settings_allow("oh-my-pi", overlays, &|args: &[&str]| {
                asked.borrow_mut().push(args.join(" "));
                match args.last() {
                    Some(&"--scope=global") => global.map(str::to_string),
                    Some(&"--scope=project") => project.map(str::to_string),
                    _ => None,
                }
            });
            (got, asked.into_inner())
        };
        let refused = crate::acp_chat::no_asks("oh-my-pi");
        let unchecked = no_check("oh-my-pi");
        // both ask: the person's own listing comes back, for the extensions they turned off
        let (got, asked) = run(Some(&safe), Some("{}"), None);
        assert_eq!(got, Ok(safe.clone()));
        assert_eq!(asked, ["config list --json --scope=global", "config list --json --scope=project"]);
        for (global, project) in [(&yolo, &safe), (&allow, &safe), (&safe, &yolo), (&safe, &allow)] {
            assert_eq!(run(Some(global), Some(project), None).0, Err(refused.clone()), "{global} {project}");
        }
        assert_eq!(run(None, Some(&safe), None).0, Err(unchecked.clone()));
        assert_eq!(run(Some(&safe), None, None).0, Err(unchecked.clone()));
        assert_eq!(run(Some(&safe), Some("garbage"), None).0, Err(unchecked.clone()));
        // the person's own layer is checked first, and an unsafe one stops before the project is listed
        let (got, asked) = run(Some(&yolo), Some(&safe), None);
        assert_eq!((got, asked.len()), (Err(refused), 1));
        let (got, asked) = run(Some(&safe), Some(&safe), Some("/tmp/more.yml"));
        assert_eq!((got, asked.len()), (Err(unchecked), 0));
        assert_eq!(run(Some(&safe), Some(&safe), Some("  ")).0, Ok(safe.clone()));
        assert_eq!(no_check("oh-my-pi"), "oh-my-pi did not start because Manut AI could not check that its own settings make it ask first.");
    }

    /// The overlay is written once in the app's own folder, with exactly its text, and never through a link.
    #[test]
    fn the_overlay_denies_the_task_tool_and_is_never_written_through_a_link() {
        let dir = std::env::temp_dir().join(format!("manut-omp-overlay-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let p = overlay_path(&dir);
        assert!(p.ends_with(".manut/omp/asks.yml"));
        write_overlay(&p).unwrap();
        assert_eq!(std::fs::read_to_string(&p).unwrap(), OVERLAY);
        std::fs::write(&p, "tools:\n  approval:\n    task: allow\n").unwrap();
        write_overlay(&p).unwrap();
        assert_eq!(std::fs::read_to_string(&p).unwrap(), OVERLAY);
        // the two settings it holds, as omp reads YAML: task denied, nothing allowed, and the project's MCP servers left out
        let lines: Vec<&str> = OVERLAY.lines().filter(|l| !l.trim_start().starts_with('#')).collect();
        assert_eq!(lines, ["tools:", "  approval:", "    task: deny", "mcp:", "  enableProjectConfig: false"]);
        assert_eq!(overlay_args(&p, false).unwrap(), [OsString::from("--config"), p.as_os_str().to_owned()]);
        #[cfg(unix)]
        {
            let elsewhere = dir.join("elsewhere.yml");
            std::fs::write(&elsewhere, "x").unwrap();
            std::fs::remove_file(&p).unwrap();
            std::os::unix::fs::symlink(&elsewhere, &p).unwrap();
            assert!(write_overlay(&p).is_err());
            assert_eq!(std::fs::read_to_string(&elsewhere).unwrap(), "x");
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A fresh temporary folder for one test, removed first if a run before left it.
    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("manut-139b-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir.canonicalize().unwrap()
    }

    /// Writes `text` at `rel` under `dir`, making the folders on the way.
    fn put(dir: &Path, rel: &str, text: &str) {
        let p = dir.join(rel);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, text).unwrap();
    }

    /// Item 139b: the person's own extension modules and hooks are the ones omp's own discovery finds in its folder, in its
    /// order and by its rules (files, then what a manifest declares, then index files; a name and a real file once; hidden
    /// entries and other kinds of file passed over), less the ones they turned off; a made-up agent folder, never this Mac's.
    #[test]
    fn the_persons_own_extensions_and_hooks_are_found_as_omp_finds_them() {
        let agent = scratch("own");
        let ext = |rel: &str| agent.join("extensions").join(rel);
        for rel in ["a.ts", "b.js", "types.d.ts", ".hidden.ts", "a/index.ts", "dir1/index.ts", "dir1/index.js", "dir2/index.js", "pkg/main.ts", "pkg/index.ts", "pkg/sub/index.js", "pionly/x.ts", "nullomp/y.ts", "badomp/z.ts", "badomp/index.ts"] {
            put(&agent.join("extensions"), rel, "export default function () {}\n");
        }
        put(&agent.join("extensions"), "notes.md", "not code");
        std::fs::create_dir_all(ext("empty")).unwrap();
        put(&agent.join("extensions"), "pkg/package.json", r#"{"omp":{"extensions":["./main.ts","./sub","./missing.ts",7]}}"#);
        put(&agent.join("extensions"), "pionly/package.json", r#"{"pi":{"extensions":["x.ts"]}}"#);
        put(&agent.join("extensions"), "nullomp/package.json", r#"{"omp":null,"pi":{"extensions":["y.ts"]}}"#);
        // an `omp` field that is not an object declares nothing, so the folder's index is taken, not `pi`'s file
        put(&agent.join("extensions"), "badomp/package.json", r#"{"omp":"x","pi":{"extensions":["z.ts"]}}"#);
        for rel in ["pre/bash.ts", "pre/README.md", "pre/.x.ts", "post/edit.ts", "post/write.js", "post/*.ts"] {
            put(&agent.join("hooks"), rel, "export default function () {}\n");
        }
        #[cfg(unix)]
        {
            // a linked folder counts as a folder, and a link to a file already named is not named again
            put(&agent, "elsewhere/index.ts", "export default function () {}\n");
            std::os::unix::fs::symlink(agent.join("elsewhere"), ext("linked")).unwrap();
            std::os::unix::fs::symlink(ext("a.ts"), ext("zz.ts")).unwrap();
        }
        let disabled = ["extension-module:b".to_string(), "hook:post:edit:edit.ts".to_string(), "extension-module:nothing".to_string()];
        let got = own_files(&agent, &disabled);
        let mut want = vec![
            Own::Extension(ext("a.ts")),
            Own::Extension(ext("types.d.ts")),
            Own::Extension(ext("nullomp/y.ts")),
            Own::Extension(ext("pionly/x.ts")),
            Own::Extension(ext("pkg/main.ts")),
            Own::Extension(ext("pkg/sub/index.js")),
            Own::Extension(ext("badomp/index.ts")),
            Own::Extension(ext("dir1/index.ts")),
            Own::Extension(ext("dir2/index.js")),
        ];
        if cfg!(unix) {
            want.push(Own::Extension(ext("linked/index.ts")));
        }
        want.extend([Own::Hook(agent.join("hooks/pre/bash.ts")), Own::Hook(agent.join("hooks/post/*.ts")), Own::Hook(agent.join("hooks/post/write.js"))]);
        assert_eq!(got, want);
        // nothing turned off: `b.js` and the post hook come back; a folder with neither part gives nothing
        let all = own_files(&agent, &[]);
        assert!(all.contains(&Own::Extension(ext("b.js"))) && all.contains(&Own::Hook(agent.join("hooks/post/edit.ts"))));
        assert_eq!(own_files(&agent.join("nowhere"), &[]), []);
        assert_eq!(
            own_args(&[Own::Extension(ext("a.ts")), Own::Hook(agent.join("hooks/pre/bash.ts"))], false).unwrap(),
            [OsString::from("-e"), ext("a.ts").into_os_string(), OsString::from("--hook"), agent.join("hooks/pre/bash.ts").into_os_string()]
        );
        // through cmd.exe a path is passed as cmd_path_arg allows it, and one it refuses refuses the start
        assert_eq!(own_args(&[Own::Hook(PathBuf::from("/a b/h.ts"))], true).unwrap(), ["--hook", "/a b/h.ts"]);
        assert!(own_args(&[Own::Extension(PathBuf::from("/50%/x.ts"))], true).is_err());
        let _ = std::fs::remove_dir_all(&agent);
    }

    /// omp's own folder is read from `omp config path` (one absolute line), and the extensions the person turned off from
    /// their own layer's listing; anything else gives no folder, and turns nothing off.
    #[test]
    fn the_agent_folder_and_the_turned_off_ids_are_read_strictly() {
        for (printed, want) in [("/Users/k/.omp/agent\n", Some("/Users/k/.omp/agent")), ("/x/agent\r\n", Some("/x/agent")), ("/x/agent", Some("/x/agent"))] {
            assert_eq!(agent_dir_of(printed), want.map(PathBuf::from), "{printed:?}");
        }
        for printed in ["", "\n", "agent\n", "/a\n/b\n", "/a\n\n", "/a\0b\n", "Updating...\n/x/agent\n"] {
            assert_eq!(agent_dir_of(printed), None, "{printed:?}");
        }
        let listing = r#"{"disabledExtensions":{"value":["extension-module:a",3,"hook:pre:bash:bash.ts"],"type":"array","description":"x"}}"#;
        assert_eq!(disabled_of(listing), ["extension-module:a", "hook:pre:bash:bash.ts"]);
        for other in ["{}", r#"{"disabledExtensions":{"value":"extension-module:a","type":"array","description":"x"}}"#, "not json", ""] {
            assert!(disabled_of(other).is_empty(), "{other}");
        }
    }

    /// Item 139b: a folder whose own tools, plugins or `.env` variables would still act inside omp as it starts refuses, with
    /// the thing named; the person's own plugins (in their home) and dotenv lines that set no omp variable do not.
    #[test]
    fn project_code_names_tools_plugins_and_omp_variables() {
        let home = scratch("home");
        let proj = home.join("work").join("proj");
        std::fs::create_dir_all(&proj).unwrap();
        let found = || project_code(&proj, Some(&home));
        assert_eq!(found(), None);
        // a tool folder with only a hidden entry holds nothing omp reads; any other file in one refuses
        put(&proj, ".omp/tools/.DS_Store", "x");
        assert_eq!(found(), None);
        for (rel, what) in [(".omp/tools/t.ts", ".omp/tools"), (".claude/tools/x.md", ".claude/tools"), (".codex/tools/y.js", ".codex/tools")] {
            put(&proj, rel, "x");
            assert_eq!(found().as_deref(), Some(what), "{rel}");
            std::fs::remove_dir_all(proj.join(rel).parent().unwrap()).unwrap();
        }
        // plugins installed for the project, in its folder or one above it; the person's own, in their home, are not the project's
        std::fs::create_dir_all(home.join(".omp/plugins")).unwrap();
        assert_eq!(found(), None);
        std::fs::create_dir_all(home.join("work/.omp/plugins")).unwrap();
        assert_eq!(found(), Some(home.join("work/.omp/plugins").display().to_string()));
        std::fs::create_dir_all(proj.join(".omp/plugins")).unwrap();
        assert_eq!(found().as_deref(), Some(".omp/plugins"));
        std::fs::remove_dir_all(proj.join(".omp")).unwrap();
        std::fs::remove_dir_all(home.join("work/.omp")).unwrap();
        // a .env that sets one of omp's own variables, in any of the forms omp's dotenv reads, refuses; other lines do not
        for text in ["PI_CONFIG_FILES=/x/more.yml\n", "FOO=1\nexport OMP_CODING_AGENT_DIR=/x\n", "  pi_shell_prefix=x\n", "FOO=1\rPI_X=1", "\u{feff}PI_X=1", "A=1\u{2028}OMP_PROFILE=p", "export\tPI_X=1"] {
            put(&proj, ".env", text);
            assert_eq!(found().as_deref(), Some(".env"), "{text:?}");
        }
        for text in ["", "FOO=1\nBAR=2\n", "# PI_X=1\n", "PIX=1\nOMP=2\nexported_PI_X=1\nNODE_ENV=production\n", "KEY=\"a PI_X=1\"\n"] {
            put(&proj, ".env", text);
            assert_eq!(found(), None, "{text:?}");
        }
        // only `.env` is read by omp, and one too large to read refuses as one that could not be checked
        std::fs::remove_file(proj.join(".env")).unwrap();
        put(&proj, ".env.local", "PI_X=1\n");
        assert_eq!(found(), None);
        put(&proj, ".env", &"A=1\n".repeat((ENV_LIMIT / 4 + 1) as usize));
        assert_eq!(found().as_deref(), Some(".env"));
        std::fs::remove_file(proj.join(".env")).unwrap();
        std::fs::create_dir_all(proj.join(".env")).unwrap();
        assert_eq!(found(), None);
        assert_eq!(
            project_code_refusal("oh-my-pi", ".omp/tools"),
            "oh-my-pi did not start because this folder holds its own code or variables for it (.omp/tools), which would run or apply as it starts, before anything asks you."
        );
        let _ = std::fs::remove_dir_all(&home);
    }
}
