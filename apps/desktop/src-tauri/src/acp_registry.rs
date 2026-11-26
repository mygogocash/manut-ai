//! The Agent Client Protocol's agent registry (agentclientprotocol/registry, Apache-2.0), offered on Settings ›
//! Providers as pre-filled versions of the person's own agents (item 101c).
//!
//! - **A pinned copy, never fetched.** The registry is the file one of its releases published, committed in
//!   `acp-registry/registry.json` with its address, tag, commit and SHA-256 in `acp-registry/pin.json`
//!   (`scripts/pin-acp-registry.mjs` writes both, by hand) and compiled in here. Nothing in the app asks the network for
//!   it, so the list changes only when someone pins a newer release and the change is reviewed like any other.
//! - **Read entry by entry.** Each entry is read on its own ([`read`]); one that is not an agent entry (a field missing or
//!   of the wrong kind, an id that is not plain, a download that is not https) is skipped and counted, never fatal.
//! - **Only what manut can run without running anything else.** The registry says how to run an agent through `npx`,
//!   `uvx` or a downloaded archive. manut never runs any of them: it shows the install line (`npm install -g`, `uv tool
//!   install`) or the archive's address for the person to install from, and then starts the command that installs, as
//!   it starts an agent the person added by hand. An entry is offered only when that command, its arguments and its
//!   install line pass [`custom_agents::check`] and what a bot's draft is held to besides ([`custom_agents::bot_refusal`]:
//!   no shell, interpreter or built-in agent's program); when its arguments are one of the start lines read here
//!   ([`STARTS`], words that only start its ACP server, so the registry can never add an option that skips an ask); when
//!   it needs no environment variable (a person's own agent gets none); and when the registry's own checks have not set
//!   it aside (its `quarantine.json`).
//! - **No second way in.** This module writes nothing. Add on the confirm card is the same `custom_agent_confirm` the
//!   form's card uses, which checks the entry again and writes it into `~/.manut/custom-agents.json`. From there it is a
//!   person's own agent like any other: its asks come through `session/request_permission` to the one ask path, and the
//!   registry names no session modes for it (its schema has none), so nothing here sets or skips one.
//! - **Not offered twice.** An entry that is an agent manut already offers (by its id, its program, or [`SAME_AS`]) is
//!   listed as already there; one whose program a person's own agent already runs, as theirs.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::custom_agents::{self, CustomAgent};
use crate::platform::Os;

/// The pinned registry, byte for byte as its release published it.
pub const REGISTRY: &str = include_str!("../acp-registry/registry.json");
/// Where [`REGISTRY`] came from, its SHA-256, the registry's quarantine list at that commit and the npm packages' commands.
pub const PIN: &str = include_str!("../acp-registry/pin.json");

/// At most this many entries are read.
pub const MAX_ENTRIES: usize = 512;
/// A description is shown up to this many characters.
pub const DESCRIPTION_MAX: usize = 300;

/// The arguments an offered entry may start its agent with: each line only starts the agent's ACP server, read in the
/// pinned registry. A line not here (a later pin's, or one with any other option) is listed as not checked and not
/// offered until someone reads what it does and adds it: the rule turned round, as for Settings › Providers' extra
/// arguments, so a registry entry can never bring an option that lets its agent act without asking.
pub const STARTS: [&[&str]; 7] = [
    // the program is itself an ACP server (Codex's and Claude's adapters, Amp's, pi's, Mistral Vibe's `vibe-acp`, ...)
    &[],
    &["acp"],
    &["--acp"],
    // Junie
    &["--acp=true"],
    // Cortex Code
    &["acp", "serve"],
    // Harn
    &["serve", "acp"],
    // Kimchi
    &["--mode", "acp"],
];

/// Registry entries that are an agent manut already offers under another program: the registry runs each through an ACP
/// adapter of its own, and manut runs the agent itself. The other agents manut offers are matched by id or program.
pub const SAME_AS: [(&str, &str); 4] = [
    // "Claude Agent", Anthropic's Agent SDK over ACP: manut runs Claude Code itself
    ("claude-acp", "claude"),
    // Codex over ACP: manut runs Codex's own app-server
    ("codex-acp", "codex"),
    // Antigravity's ACP server from its extension downloads: manut's Antigravity row runs `agy acp`
    ("antigravity-acp", "agy"),
    // pi over ACP: manut runs pi's own RPC
    ("pi-acp", "pi"),
];

/// What `pin.json` holds.
#[derive(Debug, Clone, Default, Deserialize, PartialEq)]
pub struct Pin {
    #[serde(default)]
    pub source: String,
    #[serde(default)]
    pub tag: String,
    #[serde(default)]
    pub commit: String,
    #[serde(default)]
    pub published: String,
    #[serde(default)]
    pub sha256: String,
    #[serde(default)]
    pub license: String,
    /// The registry's own `quarantine.json` at the pinned commit: entry id -> its reason.
    #[serde(default)]
    pub quarantine: BTreeMap<String, String>,
    /// npm package spec (as the registry writes it) -> the command it installs.
    #[serde(default)]
    pub bins: BTreeMap<String, String>,
}

impl Pin {
    /// `pin.json` read; one that cannot be read is an empty pin (no quarantine, no npm commands), never fatal.
    pub fn parse(text: &str) -> Pin {
        serde_json::from_str(text).unwrap_or_default()
    }
}

/// One way the registry says to run an agent.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Launch {
    /// npx and uvx: the package spec; a binary: the command inside the archive.
    pub cmd: String,
    pub args: Vec<String>,
    /// The environment variables it sets (names only: a person's own agent gets none).
    pub env: Vec<String>,
    /// A binary's archive (https) and its SHA-256 when the registry gives one.
    pub archive: String,
    pub sha256: String,
}

/// One agent of the registry, as read.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Entry {
    pub id: String,
    pub name: String,
    pub version: String,
    pub description: String,
    pub authors: Vec<String>,
    pub license: String,
    pub website: String,
    pub repository: String,
    pub npx: Option<Launch>,
    pub uvx: Option<Launch>,
    /// Platform target (`darwin-aarch64`, ...) -> its archive.
    pub binary: BTreeMap<String, Launch>,
}

/// `^[a-z0-9][a-z0-9._-]{0,63}$`
fn id_ok(id: &str) -> bool {
    let b = id.as_bytes();
    (1..=64).contains(&b.len()) && (b[0].is_ascii_lowercase() || b[0].is_ascii_digit()) && b.iter().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, b'.' | b'_' | b'-'))
}

/// At most `n` characters of one line.
fn clip(t: &str, n: usize) -> String {
    let one = t.split_whitespace().collect::<Vec<_>>().join(" ");
    if one.chars().count() <= n {
        one
    } else {
        format!("{}…", one.chars().take(n - 1).collect::<String>())
    }
}

/// A string field, or `None` when it is missing, not a string, or longer than `max`.
fn text(v: &Value, k: &str, max: usize) -> Option<String> {
    v.get(k).and_then(Value::as_str).filter(|s| s.chars().count() <= max).map(str::to_string)
}

/// An https address as given, or "" for anything else (another scheme, a space, a control character, too long).
fn https(v: &Value, k: &str) -> String {
    text(v, k, 2048).filter(|s| s.starts_with("https://") && s.len() > 8 && !s.chars().any(|c| c.is_whitespace() || c.is_control())).unwrap_or_default()
}

/// A launch's `args` and `env`: a list of strings, and an object of strings whose names are plain.
fn args_env(v: &Value) -> Option<(Vec<String>, Vec<String>)> {
    let args = match v.get("args") {
        None | Some(Value::Null) => Vec::new(),
        Some(Value::Array(a)) if a.len() <= 32 => a.iter().map(|x| x.as_str().map(str::to_string)).collect::<Option<Vec<_>>>()?,
        _ => return None,
    };
    let env = match v.get("env") {
        None | Some(Value::Null) => Vec::new(),
        Some(Value::Object(m)) if m.len() <= 32 => {
            let plain = |k: &str| (1..=128).contains(&k.len()) && k.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'_') && !k.as_bytes()[0].is_ascii_digit();
            if !m.iter().all(|(k, val)| plain(k) && val.is_string()) {
                return None;
            }
            m.keys().cloned().collect()
        }
        _ => return None,
    };
    Some((args, env))
}

fn package(v: &Value) -> Option<Launch> {
    let cmd = text(v, "package", 214).filter(|s| !s.trim().is_empty())?;
    let (args, env) = args_env(v)?;
    Some(Launch { cmd, args, env, archive: String::new(), sha256: String::new() })
}

fn archive(v: &Value) -> Option<Launch> {
    let cmd = text(v, "cmd", 512).filter(|s| !s.trim().is_empty())?;
    let archive = https(v, "archive");
    if archive.is_empty() {
        return None;
    }
    let sha256 = text(v, "sha256", 64).filter(|s| s.len() == 64 && s.bytes().all(|c| c.is_ascii_hexdigit())).map(|s| s.to_ascii_lowercase()).unwrap_or_default();
    let (args, env) = args_env(v)?;
    Some(Launch { cmd, args, env, archive, sha256 })
}

/// One entry, or `None` when it is not an agent entry manut can read. A distribution of a kind it does not know, or
/// one that is malformed, is dropped on its own; an entry left with none is not read.
fn entry(v: &Value) -> Option<Entry> {
    let id = text(v, "id", 64).filter(|s| id_ok(s))?;
    let name = text(v, "name", 160).map(|s| s.trim().to_string()).filter(|s| !s.is_empty())?;
    let version = text(v, "version", 64).unwrap_or_default();
    let description = text(v, "description", 4096).map(|d| clip(&d, DESCRIPTION_MAX)).unwrap_or_default();
    let authors = v.get("authors").and_then(Value::as_array).map(|a| a.iter().filter_map(Value::as_str).take(16).map(|s| clip(s, 120)).collect()).unwrap_or_default();
    let dist = v.get("distribution").filter(|d| d.is_object())?;
    let npx = dist.get("npx").and_then(package);
    let uvx = dist.get("uvx").and_then(package);
    let binary: BTreeMap<String, Launch> = dist
        .get("binary")
        .and_then(Value::as_object)
        .map(|m| m.iter().filter(|(t, _)| t.len() <= 64).filter_map(|(t, l)| archive(l).map(|l| (t.clone(), l))).collect())
        .unwrap_or_default();
    if npx.is_none() && uvx.is_none() && binary.is_empty() {
        return None;
    }
    Some(Entry {
        id,
        name,
        version,
        description,
        authors,
        license: text(v, "license", 128).unwrap_or_default(),
        website: https(v, "website"),
        repository: https(v, "repository"),
        npx,
        uvx,
        binary,
    })
}

/// The registry's entries, each read on its own, and how many were skipped. A file that is not the registry's shape
/// reads as no entries and one skip.
pub fn read(text: &str) -> (Vec<Entry>, usize) {
    let Some(list) = serde_json::from_str::<Value>(text).ok().and_then(|v| v.get("agents").and_then(Value::as_array).cloned()) else {
        return (Vec::new(), 1);
    };
    let mut out: Vec<Entry> = Vec::new();
    let mut skipped = 0;
    for v in list.iter().take(MAX_ENTRIES) {
        match entry(v) {
            Some(e) if !out.iter().any(|o| o.id == e.id) => out.push(e),
            _ => skipped += 1,
        }
    }
    (out, skipped + list.len().saturating_sub(MAX_ENTRIES))
}

/// A uvx package spec's name (the command `uvx` runs, which takes the package's name: `uvx --help`, "Run a command
/// provided by a Python package") and its install line, with `name@1.2` written as the requirement `name==1.2`.
fn uv_tool(spec: &str) -> (String, String) {
    let end = spec.find(|c: char| !(c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))).unwrap_or(spec.len());
    let (name, rest) = spec.split_at(end);
    let rest = rest.strip_prefix('@').map(|v| format!("=={v}")).unwrap_or_else(|| rest.to_string());
    (name.to_string(), format!("uv tool install {name}{rest}"))
}

/// The file name of an archive's command (`./dist-package/cursor-agent` -> `cursor-agent`).
fn file_name(cmd: &str) -> String {
    cmd.rsplit(['/', '\\']).next().unwrap_or(cmd).to_string()
}

/// How an offered entry is installed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Via {
    Npx,
    Uvx,
    Binary,
    #[serde(rename = "")]
    None,
}

/// Where an entry stands for this person on this computer.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum State {
    /// Add… opens the confirm card.
    Offered,
    /// An agent manut already offers (`note`: its name).
    There,
    /// A person's own agent already runs its program (`note`: that agent's name).
    Yours,
    /// The registry's own checks set it aside (`note`: the registry's reason).
    Quarantine,
    /// No way to run it on this computer.
    Platform,
    /// It needs environment variables (`note`: their names), which a person's own agent does not get.
    Env,
    /// Its arguments are not a start line read here ([`STARTS`]; `note`: the arguments).
    Start,
    /// Its npm package's command is not in the pin.
    Bin,
    /// The custom-agent checks refused it (`note`: the check's code, `ag.why.<code>`).
    Refused,
}

/// One registry entry as the page lists it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Offer {
    pub id: String,
    pub name: String,
    pub version: String,
    pub description: String,
    pub authors: Vec<String>,
    pub license: String,
    pub website: String,
    pub repository: String,
    pub state: State,
    pub note: String,
    /// What Add makes, once a way to run it on this computer was found: its name, program, arguments and install line.
    pub label: String,
    pub program: String,
    pub args: Vec<String>,
    pub install: String,
    pub via: Via,
    /// A binary's archive for this computer and its SHA-256, shown for the person to download (manut never does).
    pub archive: String,
    pub sha256: String,
}

/// An agent manut already offers: its id, program and name.
pub type Row = (&'static str, &'static str, &'static str);

/// The built-ins and the generic ACP agents.
pub fn rows() -> Vec<Row> {
    crate::sessions::AGENTS.iter().map(|a| (a.id, a.program, a.label)).chain(crate::acp_agents::ACP_LIST.iter().map(|e| (e.agent.id, e.agent.program, e.agent.label))).collect()
}

/// The registry's name as a custom agent's name: the characters a name may hold, at most 40; else its id.
fn label_of(name: &str, id: &str) -> String {
    let kept: String = name.chars().map(|c| if c.is_alphanumeric() || matches!(c, '.' | '-' | '_' | '+') { c } else { ' ' }).collect();
    let one = kept.split_whitespace().collect::<Vec<_>>().join(" ");
    let cut: String = one.chars().take(custom_agents::LABEL_MAX).collect();
    let cut = cut.trim().to_string();
    if custom_agents::label_ok(&cut) {
        cut
    } else {
        id.chars().take(custom_agents::LABEL_MAX).collect()
    }
}

/// This computer's platform target, as the registry names them (FORMAT.md, "Platform Targets").
pub fn target_here() -> String {
    let os = match std::env::consts::OS {
        "macos" => "darwin",
        o => o,
    };
    let base = format!("{os}-{}", std::env::consts::ARCH);
    if cfg!(target_env = "musl") {
        format!("{base}-musl")
    } else {
        base
    }
}

/// Every program `e` could run as (each way, each platform): how it is matched to the agents already there.
fn programs(e: &Entry, pin: &Pin) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    if let Some(b) = e.npx.as_ref().and_then(|l| pin.bins.get(&l.cmd)) {
        out.push(custom_agents::program_base(b));
    }
    if let Some(l) = &e.uvx {
        out.push(custom_agents::program_base(&uv_tool(&l.cmd).0));
    }
    out.extend(e.binary.values().map(|l| custom_agents::program_base(&file_name(&l.cmd))));
    out.retain(|p| !p.is_empty());
    out.sort();
    out.dedup();
    out
}

/// Where entry `e` stands for target `target` on `os`, beside the agents manut offers (`rows`) and the person's own.
pub fn offer(e: &Entry, pin: &Pin, target: &str, os: Os, rows: &[Row], mine: &[CustomAgent]) -> Offer {
    let mut o = Offer {
        id: e.id.clone(),
        name: e.name.clone(),
        version: e.version.clone(),
        description: e.description.clone(),
        authors: e.authors.clone(),
        license: e.license.clone(),
        website: e.website.clone(),
        repository: e.repository.clone(),
        state: State::Offered,
        note: String::new(),
        label: String::new(),
        program: String::new(),
        args: Vec::new(),
        install: String::new(),
        via: Via::None,
        archive: String::new(),
        sha256: String::new(),
    };
    let progs = programs(e, pin);
    let same = SAME_AS.iter().find(|(r, _)| *r == e.id).and_then(|(_, id)| rows.iter().find(|r| r.0 == *id));
    if let Some(r) = same.or_else(|| rows.iter().find(|r| r.0 == e.id || progs.iter().any(|p| p == r.1 || p == r.0))) {
        o.state = State::There;
        o.note = r.2.to_string();
        return o;
    }
    if let Some(c) = mine.iter().find(|c| progs.contains(&custom_agents::program_base(&c.program))) {
        o.state = State::Yours;
        o.note = c.label.clone();
        return o;
    }
    if let Some(why) = pin.quarantine.get(&e.id) {
        o.state = State::Quarantine;
        o.note = clip(why, 200);
        return o;
    }
    // A command npm installs on Windows is a .cmd file, which only a shell starts and manut never starts, so there only
    // an archive or uv's command is taken; elsewhere an install line the person can run comes before a download.
    let order: &[Via] = if os == Os::Windows { &[Via::Binary, Via::Uvx] } else { &[Via::Npx, Via::Uvx, Via::Binary] };
    let mut no_bin = false;
    let mut picked: Option<&Launch> = None;
    for via in order {
        match via {
            Via::Npx => {
                if let Some(l) = &e.npx {
                    match pin.bins.get(&l.cmd) {
                        Some(bin) => {
                            o.program = bin.clone();
                            o.install = format!("npm install -g {}", l.cmd);
                        }
                        None => {
                            no_bin = true;
                            continue;
                        }
                    }
                    picked = Some(l);
                }
            }
            Via::Uvx => {
                if let Some(l) = &e.uvx {
                    (o.program, o.install) = uv_tool(&l.cmd);
                    picked = Some(l);
                }
            }
            Via::Binary => {
                if let Some(l) = e.binary.get(target) {
                    o.program = file_name(&l.cmd);
                    o.archive = l.archive.clone();
                    o.sha256 = l.sha256.clone();
                    picked = Some(l);
                }
            }
            Via::None => {}
        }
        if picked.is_some() {
            o.via = *via;
            break;
        }
    }
    let Some(l) = picked else {
        o.state = if no_bin { State::Bin } else { State::Platform };
        return o;
    };
    o.label = label_of(&e.name, &e.id);
    o.args = l.args.clone();
    if !l.env.is_empty() {
        o.state = State::Env;
        o.note = l.env.join(", ");
        return o;
    }
    if !STARTS.iter().any(|s| s.iter().copied().eq(l.args.iter().map(String::as_str))) {
        o.state = State::Start;
        o.note = l.args.join(" ");
        return o;
    }
    // the checks a bot's draft gets, then every check of a person's own agent (the id is the card's to choose)
    let probe = CustomAgent { id: "acp-registry-entry".into(), label: o.label.clone(), program: o.program.clone(), args: o.args.clone(), install: o.install.clone() };
    if let Some(why) = custom_agents::bot_refusal(&probe.program).or_else(|| custom_agents::check(&probe, os, |_: &Path| false).err()) {
        o.state = State::Refused;
        o.note = why.code();
    }
    o
}

/// What the page shows of the pin: where the copy came from and when.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct PinInfo {
    pub source: String,
    pub tag: String,
    pub commit: String,
    pub published: String,
    pub sha256: String,
}

/// The page's list: the pin, how many entries were skipped, and every entry read.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct RegistryList {
    pub pin: PinInfo,
    pub skipped: usize,
    pub agents: Vec<Offer>,
}

pub fn list_for(registry: &str, pin: &Pin, target: &str, os: Os, rows: &[Row], mine: &[CustomAgent]) -> RegistryList {
    let (entries, skipped) = read(registry);
    RegistryList {
        pin: PinInfo { source: pin.source.clone(), tag: pin.tag.clone(), commit: pin.commit.clone(), published: pin.published.clone(), sha256: pin.sha256.clone() },
        skipped,
        agents: entries.iter().map(|e| offer(e, pin, target, os, rows, mine)).collect(),
    }
}

/// The list on this computer, beside the person's own agents as the file holds them now.
pub fn list_here() -> RegistryList {
    let mine = custom_agents::load_here().agents;
    list_for(REGISTRY, &Pin::parse(PIN), &target_here(), Os::current(), &rows(), &mine)
}

/// What the confirm card says of an entry from the registry, beside the command.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Source {
    pub id: String,
    pub name: String,
    pub version: String,
    pub via: Via,
    pub install: String,
    pub archive: String,
    pub sha256: String,
    pub website: String,
    pub repository: String,
    pub license: String,
    pub tag: String,
}

/// The confirm card for a registry entry: the same card as the form's and a bot draft's (the checked entry and the exact
/// command), and where it comes from.
#[derive(Debug, Clone, Serialize)]
pub struct RegistryPreview {
    pub entry: CustomAgent,
    pub command: Option<String>,
    pub registry: Source,
}

/// The card for `o` in `home`: refused unless it is offered, then drafted as a bot's draft is (the custom-agent checks,
/// no shell, interpreter or built-in program, an id free in the person's file) and its command resolved in `dirs`.
/// Writes nothing; Add is the form's `custom_agent_confirm`. A refusal is `why:<code>`.
pub fn preview_in<X: Fn(&Path) -> bool>(home: &Path, o: &Offer, tag: &str, dirs: &[PathBuf], os: Os, is_program: X) -> Result<RegistryPreview, String> {
    match o.state {
        State::Offered => {}
        State::There => return Err("why:builtin".into()),
        State::Yours => return Err("why:dup".into()),
        State::Refused => return Err(format!("why:{}", o.note)),
        _ => return Err("why:registry".into()),
    }
    let entry = custom_agents::bot_draft(home, &o.label, &o.program, &o.args, &o.install, os, &is_program).map_err(|w| format!("why:{}", w.code()))?;
    let command = custom_agents::command(&entry, dirs, &is_program, os);
    let registry = Source {
        id: o.id.clone(),
        name: o.name.clone(),
        version: o.version.clone(),
        via: o.via,
        install: o.install.clone(),
        archive: o.archive.clone(),
        sha256: o.sha256.clone(),
        website: o.website.clone(),
        repository: o.repository.clone(),
        license: o.license.clone(),
        tag: tag.to_string(),
    };
    Ok(RegistryPreview { entry, command, registry })
}

/// The card for registry entry `id` on this computer, read against the person's file as it is now.
pub fn preview_here(id: &str) -> Result<RegistryPreview, String> {
    let home = custom_agents::home().ok_or("why:file")?;
    let pin = Pin::parse(PIN);
    let list = list_here();
    let o = list.agents.iter().find(|o| o.id == id).ok_or("why:registry")?;
    preview_in(&home, o, &pin.tag, &crate::sessions::host_dirs(), Os::current(), crate::sessions::is_program_file)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use sha2::{Digest, Sha256};

    const MAC: &str = "darwin-aarch64";

    fn pinned() -> (Vec<Entry>, Pin) {
        (read(REGISTRY).0, Pin::parse(PIN))
    }

    fn state_of<'a>(l: &'a RegistryList, id: &str) -> &'a Offer {
        l.agents.iter().find(|o| o.id == id).unwrap_or_else(|| panic!("{id} is not listed"))
    }

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("manut-acp-registry-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d.canonicalize().unwrap()
    }

    /// The committed file is the release's file: its SHA-256 is the pin's, the pin names the release it came from and
    /// the commit its tag names, and every entry of it is read.
    #[test]
    fn the_pinned_file_is_the_one_its_pin_names() {
        let pin = Pin::parse(PIN);
        let sum: String = Sha256::digest(REGISTRY.as_bytes()).iter().map(|b| format!("{b:02x}")).collect();
        assert_eq!(sum, pin.sha256);
        assert_eq!(pin.source, format!("https://github.com/agentclientprotocol/registry/releases/download/{}/registry.json", pin.tag));
        let short = pin.tag.rsplit('-').next().unwrap();
        assert!(pin.tag.starts_with('v') && short.len() >= 7 && pin.commit.len() == 40 && pin.commit.starts_with(short), "{pin:?}");
        assert!(pin.published.starts_with(&pin.tag[1..11].replace('.', "-")), "{}", pin.published);
        assert_eq!(pin.license, "Apache-2.0");
        let (entries, skipped) = read(REGISTRY);
        let raw: Value = serde_json::from_str(REGISTRY).unwrap();
        assert_eq!((entries.len(), skipped), (raw["agents"].as_array().unwrap().len(), 0));
        // each npm command in the pin is one of the registry's packages, and a plain program name
        for (spec, bin) in &pin.bins {
            assert!(entries.iter().any(|e| e.npx.as_ref().is_some_and(|l| &l.cmd == spec)), "{spec}");
            assert!(custom_agents::bare_ok(bin), "{spec}: {bin}");
        }
    }

    /// The registry names no session modes, or anything else manut would act on: every field of every pinned entry is
    /// one of the schema's (agent.schema.json at the pinned commit), and the reader takes only the ones it needs.
    #[test]
    fn the_registry_names_no_modes() {
        let raw: Value = serde_json::from_str(REGISTRY).unwrap();
        let fields = ["id", "name", "version", "description", "repository", "website", "authors", "license", "license_url", "icon", "distribution"];
        for a in raw["agents"].as_array().unwrap() {
            let id = a["id"].as_str().unwrap();
            assert!(a.as_object().unwrap().keys().all(|k| fields.contains(&k.as_str())), "{id}");
            for (kind, d) in a["distribution"].as_object().unwrap() {
                let launches: Vec<&Value> = if kind == "binary" { d.as_object().unwrap().values().collect() } else { vec![d] };
                for l in launches {
                    let ok = ["package", "archive", "sha256", "cmd", "args", "env"];
                    assert!(l.as_object().unwrap().keys().all(|k| ok.contains(&k.as_str())), "{id} {kind}");
                }
            }
        }
    }

    /// A bad or missing entry is skipped and counted, never fatal; the good ones are still read, and a file that is not
    /// the registry at all, or a pin that cannot be read, lists nothing or offers nothing that needs the pin.
    #[test]
    fn a_bad_or_missing_entry_is_skipped_never_fatal() {
        let good = json!({"id": "acme", "name": "Acme Agent", "version": "1.0.0", "description": "An agent.", "distribution": {"binary": {"darwin-aarch64": {"archive": "https://example.com/acme.tar.gz", "cmd": "./acme", "args": ["acp"]}}}});
        let text = json!({"version": "1.0.0", "agents": [
            good,
            {"name": "No id", "distribution": {"npx": {"package": "x@1"}}},
            {"id": "../evil", "name": "Evil", "distribution": {"npx": {"package": "x@1"}}},
            {"id": "Upper", "name": "Upper", "distribution": {"npx": {"package": "x@1"}}},
            {"id": "noname", "name": 3, "distribution": {"npx": {"package": "x@1"}}},
            {"id": "nodist", "name": "No distribution"},
            {"id": "badargs", "name": "Bad args", "distribution": {"npx": {"package": "x@1", "args": [1]}}},
            {"id": "badenv", "name": "Bad env", "distribution": {"npx": {"package": "x@1", "env": {"A B": "1"}}}},
            {"id": "plainhttp", "name": "Plain http", "distribution": {"binary": {"darwin-aarch64": {"archive": "http://example.com/x.tgz", "cmd": "./x"}}}},
            {"id": "acme", "name": "Acme again", "distribution": {"npx": {"package": "y@1"}}},
            "not an object",
            null,
            // a kind it does not know is dropped, the kind it knows still read
            {"id": "mixed", "name": "Mixed", "distribution": {"docker": {"image": "x"}, "binary": {"darwin-aarch64": {"archive": "https://example.com/m.zip", "cmd": "./m"}}}}
        ]})
        .to_string();
        let (entries, skipped) = read(&text);
        assert_eq!(entries.iter().map(|e| e.id.as_str()).collect::<Vec<_>>(), ["acme", "mixed"]);
        assert_eq!(skipped, 11);
        let l = list_for(&text, &Pin::default(), MAC, Os::Unix, &rows(), &[]);
        assert_eq!(state_of(&l, "acme").state, State::Offered);
        assert_eq!(state_of(&l, "mixed").state, State::Offered);
        // not the registry: nothing, one skip
        for bad in ["", "not json", "[]", "{\"agents\": 3}"] {
            assert_eq!(read(bad), (Vec::new(), 1), "{bad}");
            assert!(list_for(bad, &Pin::default(), MAC, Os::Unix, &rows(), &[]).agents.is_empty());
        }
        // a pin that cannot be read: the pinned registry still lists, and an npm entry, whose command is the pin's, is
        // not offered
        assert_eq!(Pin::parse("{ not json"), Pin::default());
        let l = list_for(REGISTRY, &Pin::parse("{ not json"), MAC, Os::Unix, &rows(), &[]);
        assert_eq!(l.agents.len(), read(REGISTRY).0.len());
        assert_eq!(state_of(&l, "dirac").state, State::Bin);
        assert_eq!(state_of(&l, "goose").state, State::Offered);
    }

    /// Entries that are agents manut already offers are listed as there, never offered: by the four adapters of
    /// [`SAME_AS`], by id and by program. And no entry that is offered runs a program an agent of manut's runs.
    #[test]
    fn matching_entries_to_the_agents_already_there() {
        let (entries, pin) = pinned();
        let l = list_for(REGISTRY, &pin, MAC, Os::Unix, &rows(), &[]);
        let there = |id: &str| {
            let o = state_of(&l, id);
            assert_eq!(o.state, State::There, "{id}: {o:?}");
            o.note.clone()
        };
        assert_eq!(there("claude-acp"), "Claude Code");
        assert_eq!(there("codex-acp"), "Codex");
        assert_eq!(there("antigravity-acp"), "Antigravity");
        assert_eq!(there("pi-acp"), "pi");
        assert_eq!(there("gemini"), "Gemini CLI");
        assert_eq!(there("qwen-code"), "Qwen Code");
        assert_eq!(there("kimi-code"), "Kimi Code");
        assert_eq!(there("github-copilot-cli"), "Copilot CLI");
        assert_eq!(there("cline"), "Cline");
        assert_eq!(there("cursor"), "Cursor");
        assert_eq!(there("opencode"), "OpenCode");
        assert_eq!(there("opencode-v2"), "OpenCode");
        assert_eq!(there("grok-build"), "Grok");
        // Kimi's older CLI installs the same `kimi` as Kimi Code: one agent, already there
        assert_eq!(there("kimi"), "Kimi Code");
        let all_rows = rows();
        for o in l.agents.iter().filter(|o| o.state == State::Offered) {
            let p = custom_agents::program_base(&o.program);
            assert!(all_rows.iter().all(|r| r.1 != p && r.0 != p && r.0 != o.id), "{} runs {p}, an agent manut offers", o.id);
        }
        // the same on Linux and Windows
        for target in ["linux-x86_64", "windows-x86_64"] {
            let os = if target.starts_with("windows") { Os::Windows } else { Os::Unix };
            let l = list_for(REGISTRY, &pin, target, os, &rows(), &[]);
            for id in ["claude-acp", "codex-acp", "antigravity-acp", "gemini", "cursor", "opencode", "grok-build"] {
                assert_eq!(state_of(&l, id).state, State::There, "{target} {id}");
            }
        }
        // a row of these tests' own: an entry whose program it runs is there
        let acme = Entry { id: "acme-acp".into(), name: "Acme".into(), version: "1".into(), description: String::new(), authors: vec![], license: String::new(), website: String::new(), repository: String::new(), npx: None, uvx: None, binary: BTreeMap::from([(MAC.into(), Launch { cmd: "./bin/acme".into(), args: vec!["acp".into()], env: vec![], archive: "https://example.com/a.tgz".into(), sha256: String::new() })]) };
        assert_eq!(offer(&acme, &pin, MAC, Os::Unix, &[("acme", "acme", "Acme Row")], &[]).state, State::There);
        assert_eq!(offer(&acme, &pin, MAC, Os::Unix, &[], &[]).state, State::Offered);
        assert!(!entries.is_empty());
    }

    /// The other entries on this Mac's platform: what each would be added as, or why it is not offered.
    #[test]
    fn what_each_entry_becomes() {
        let (_, pin) = pinned();
        let l = list_for(REGISTRY, &pin, MAC, Os::Unix, &rows(), &[]);
        // an npm package: the command it installs, its install line shown, never run
        let dirac = state_of(&l, "dirac");
        assert_eq!((dirac.state, dirac.via, dirac.program.as_str(), dirac.args.clone(), dirac.install.as_str()), (State::Offered, Via::Npx, "dirac", vec!["--acp".to_string()], "npm install -g dirac-cli@0.6.2"));
        // npm's choice among several commands: the one named after the package
        assert_eq!(state_of(&l, "qoder").program, "qodercli");
        assert_eq!(state_of(&l, "codebuddy-code").program, "codebuddy-code");
        // an archive: the command's file name, the archive and its checksum shown for the person to download
        let goose = state_of(&l, "goose");
        assert_eq!((goose.state, goose.via, goose.program.as_str(), goose.install.as_str()), (State::Offered, Via::Binary, "goose", ""));
        assert!(goose.archive.starts_with("https://github.com/block/goose/releases/download/") && goose.archive.ends_with("aarch64-apple-darwin.tar.bz2"));
        assert_eq!(state_of(&l, "junie").args, ["--acp=true"]);
        assert_eq!(state_of(&l, "kimchi").args, ["--mode", "acp"]);
        assert_eq!((state_of(&l, "cortex-code").program.as_str(), state_of(&l, "cortex-code").args.clone()), ("cortex", vec!["acp".to_string(), "serve".to_string()]));
        // a name with characters a name may not hold
        assert_eq!(label_of("Kimi CLI (Legacy)", "kimi"), "Kimi CLI Legacy");
        assert_eq!(label_of("(((", "odd-id"), "odd-id");
        // not offered, each with its reason
        let not = |id: &str, s: State| {
            let o = state_of(&l, id);
            assert_eq!(o.state, s, "{id}: {o:?}");
            o.note.clone()
        };
        assert_eq!(not("kilo", State::Refused), "kilo");
        assert_eq!(not("vtcode", State::Quarantine), "Missing windows builds");
        assert_eq!(not("auggie", State::Env), "AUGMENT_DISABLE_AUTO_UPDATE");
        assert_eq!(not("factory-droid", State::Env), "DROID_DISABLE_AUTO_UPDATE, FACTORY_DROID_AUTO_UPDATE_ENABLED");
        // Muse Code needs a variable to speak ACP, unless an agent of manut's runs `muse` (item 101b)
        let muse = state_of(&l, "muse-code");
        assert!(muse.state == State::Env || muse.state == State::There, "{muse:?}");
        // Windows: npm's commands there are .cmd files, which manut never starts
        let w = list_for(REGISTRY, &pin, "windows-x86_64", Os::Windows, &rows(), &[]);
        assert_eq!(state_of(&w, "dirac").state, State::Platform);
        let g = state_of(&w, "goose");
        assert_eq!((g.state, g.program.as_str()), (State::Offered, "goose.exe"));
        // a platform the entry has no archive for
        assert_eq!(state_of(&list_for(REGISTRY, &pin, "freebsd-riscv64", Os::Unix, &rows(), &[]), "goose").state, State::Platform);
        // uv: the package's command and a requirement manut never runs
        assert_eq!(uv_tool("minion-code@0.1.44"), ("minion-code".to_string(), "uv tool install minion-code==0.1.44".to_string()));
        assert_eq!(uv_tool("fast-agent-acp==0.10.66"), ("fast-agent-acp".to_string(), "uv tool install fast-agent-acp==0.10.66".to_string()));
        assert_eq!(l.skipped, 0);
    }

    fn one(name: &str, cmd: &str, args: &[&str], env: Option<Value>) -> String {
        let mut launch = json!({"archive": "https://example.com/x.tgz", "cmd": cmd, "args": args});
        if let Some(e) = env {
            launch["env"] = e;
        }
        json!({"agents": [{"id": "probe", "name": name, "version": "1", "description": "", "distribution": {"binary": {"darwin-aarch64": launch}}}]}).to_string()
    }

    fn state(text: &str) -> (State, String) {
        let l = list_for(text, &Pin::default(), MAC, Os::Unix, &rows(), &[]);
        (l.agents[0].state, l.agents[0].note.clone())
    }

    /// Anything the registry says to run goes through the custom-agent checks and what a bot's draft is held to: a
    /// shell or an interpreter, OpenCode or Kilo, a program with shell characters, an option that is not a start line
    /// read here (one that skips the asks among them), and a variable a person's own agent never gets are all refused.
    #[test]
    fn what_the_registry_says_to_run_gets_the_custom_agent_checks() {
        assert_eq!(state(&one("Acme", "./acme", &["acp"], None)).0, State::Offered);
        assert_eq!(state(&one("Acme", "./bin/bash", &["acp"], None)), (State::Refused, "interp".into()));
        assert_eq!(state(&one("Acme", "./node", &[], None)), (State::Refused, "interp".into()));
        assert_eq!(state(&one("Acme", "./kilocode", &["acp"], None)), (State::Refused, "kilo".into()));
        assert_eq!(state(&one("Acme", "./my agent", &["acp"], None)), (State::Refused, "program".into()));
        assert_eq!(state(&one("Acme", "./$(id)", &["acp"], None)), (State::Refused, "program".into()));
        for bad in [&["--yolo"][..], &["acp", "--dangerously-skip-permissions"], &["--acp", "--approval-mode=yolo"], &["acp;rm"], &["-x"]] {
            assert_eq!(state(&one("Acme", "./acme", bad, None)).0, State::Start, "{bad:?}");
        }
        assert_eq!(state(&one("Acme", "./acme", &["acp"], Some(json!({"ACME_YOLO": "1"})))), (State::Env, "ACME_YOLO".into()));
        // an install line with a shell character is refused, never shown as something to paste
        let text = json!({"agents": [{"id": "probe", "name": "Probe", "distribution": {"npx": {"package": "probe@1;rm", "args": ["--acp"]}}}]}).to_string();
        let pin = Pin { bins: BTreeMap::from([("probe@1;rm".to_string(), "probe".to_string())]), ..Pin::default() };
        let l = list_for(&text, &pin, MAC, Os::Unix, &rows(), &[]);
        assert_eq!((l.agents[0].state, l.agents[0].note.as_str()), (State::Refused, "install"));
        // a command npm would not pick is not guessed
        assert_eq!(list_for(&text, &Pin::default(), MAC, Os::Unix, &rows(), &[]).agents[0].state, State::Bin);
        // every start line read here only starts an ACP server
        for s in STARTS {
            assert!(s.iter().all(|w| ["acp", "--acp", "--acp=true", "serve", "--mode"].contains(w)), "{s:?}");
        }
    }

    /// Add goes through the same checks and the same one writer as the form's: the card drafts the entry as a bot's
    /// draft is drafted and writes nothing; `confirm_add` writes it; then the entry is listed as the person's own.
    #[test]
    fn adding_one_goes_through_the_custom_agent_flow() {
        let home = tmp("add");
        let (_, pin) = pinned();
        let any = |_: &Path| true;
        let l = list_for(REGISTRY, &pin, MAC, Os::Unix, &rows(), &[]);
        let goose = state_of(&l, "goose");
        let dirs = vec![PathBuf::from("/opt/homebrew/bin")];
        let card = preview_in(&home, goose, &pin.tag, &dirs, Os::Unix, |p: &Path| p == Path::new("/opt/homebrew/bin/goose")).unwrap();
        assert_eq!(card.entry, CustomAgent { id: "goose".into(), label: "goose".into(), program: "goose".into(), args: vec!["acp".into()], install: String::new() });
        assert_eq!(card.command, Some(format!("{} acp", Path::new("/opt/homebrew/bin").join("goose").display())));
        assert_eq!((card.registry.id.as_str(), card.registry.via, card.registry.tag.as_str()), ("goose", Via::Binary, pin.tag.as_str()));
        assert!(card.registry.archive.starts_with("https://"));
        // not installed yet: the card still shows every argument and says so (the UI's cardCommand)
        assert_eq!(preview_in(&home, goose, &pin.tag, &dirs, Os::Unix, |_: &Path| false).unwrap().command, None);
        assert!(!custom_agents::store_path(&home).exists(), "the card wrote the file");
        // Add: the custom-agent flow's one writer, which checks it again
        custom_agents::confirm_add(&home, &card.entry, Os::Unix, any).unwrap();
        let mine = custom_agents::load(&home, Os::Unix, any).agents;
        assert_eq!(mine, vec![card.entry.clone()]);
        let after = list_for(REGISTRY, &pin, MAC, Os::Unix, &rows(), &mine);
        assert_eq!((state_of(&after, "goose").state, state_of(&after, "goose").note.as_str()), (State::Yours, "goose"));
        assert_eq!(preview_in(&home, state_of(&after, "goose"), &pin.tag, &dirs, Os::Unix, any).unwrap_err(), "why:dup");
        // a person's own agent running the same program from a path of its own is the same agent
        let mine2 = vec![CustomAgent { id: "my-dirac".into(), label: "My Dirac".into(), program: "/opt/x/dirac".into(), args: vec![], install: String::new() }];
        assert_eq!(state_of(&list_for(REGISTRY, &pin, MAC, Os::Unix, &rows(), &mine2), "dirac").state, State::Yours);
        // only an offered entry has a card
        assert_eq!(preview_in(&home, state_of(&l, "claude-acp"), &pin.tag, &dirs, Os::Unix, any).unwrap_err(), "why:builtin");
        assert_eq!(preview_in(&home, state_of(&l, "kilo"), &pin.tag, &dirs, Os::Unix, any).unwrap_err(), "why:kilo");
        assert_eq!(preview_in(&home, state_of(&l, "auggie"), &pin.tag, &dirs, Os::Unix, any).unwrap_err(), "why:registry");
        // an entry changed in the page's hands is checked again by the card
        let mut forged = goose.clone();
        forged.program = "sh".into();
        assert_eq!(preview_in(&home, &forged, &pin.tag, &dirs, Os::Unix, any).unwrap_err(), "why:interp");
        forged.program = "goose".into();
        forged.args = vec!["-c".into(), "rm -rf ~".into()];
        assert_eq!(preview_in(&home, &forged, &pin.tag, &dirs, Os::Unix, any).unwrap_err(), "why:args");
        std::fs::remove_dir_all(home).unwrap();
    }

    /// This module writes nothing and asks the network for nothing: the only writer of a person's agents stays
    /// `custom_agents::confirm_add`, and the registry is the compiled-in copy.
    #[test]
    fn the_module_writes_nothing_and_fetches_nothing() {
        let src = include_str!("acp_registry.rs");
        let code = src.split("#[cfg(test)]").next().unwrap();
        for word in ["fs::write", "File::create", "confirm_add(", "save(", "Command::new", "http://", "TcpStream", "reqwest", "ureq"] {
            assert!(!code.contains(word), "{word}");
        }
    }

    /// The mock host's copy (`src/settings/agents/mockAcpRegistry.json`: a browser has no shell to ask) is this list,
    /// for an Apple silicon Mac with none of the person's own agents. `UPDATE_ACP_REGISTRY_MOCK=1` writes it again.
    #[test]
    fn the_mock_hosts_copy_is_the_pinned_list() {
        let p = Path::new(env!("CARGO_MANIFEST_DIR")).join("../src/settings/agents/mockAcpRegistry.json");
        let want = serde_json::to_value(list_for(REGISTRY, &Pin::parse(PIN), MAC, Os::Unix, &rows(), &[])).unwrap();
        if std::env::var_os("UPDATE_ACP_REGISTRY_MOCK").is_some() {
            std::fs::write(&p, serde_json::to_string_pretty(&want).unwrap() + "\n").unwrap();
        }
        let copy: Value = serde_json::from_str(&std::fs::read_to_string(p).unwrap()).unwrap();
        assert_eq!(copy, want);
    }
}
