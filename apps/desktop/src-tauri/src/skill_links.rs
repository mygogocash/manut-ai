//! Skills shared by a link (item 84): reading the person's own skill folders before they are published, and installing skills
//! from someone else's link. A skill tells a coding agent what to do and its folder can hold scripts, so both sides are the most
//! careful file handling in the app.
//!
//! Reading (`read_skill`). Only for the folders Settings › MCP and Skills lists as the person's own (agent_config.rs), by folder
//! name. Nothing is followed through a link: a skill folder that is a link is refused, and inside it a link of any kind is named
//! and refused, never read. A file that is not UTF-8 text is refused by name as binary. Dot-files and dot-folders (`.env`,
//! `.git`) are left out and named, since that is where keys live. Each file comes back with its text, its size and whether its
//! executable bit is set, so the page can show every file and mark each script before anything is asked.
//!
//! Installing. `read_link` takes a link only on the artifact origin the API named (refused `other_host` before anything is
//! fetched), fetches its JSON with the shell's curl (api_link.rs `fetch_link`) and holds the bundle to the API's own rules
//! again (`bundle_refusal`, the same as apps/api/src/artifact-store.ts). The bundle is kept here, by id, so what is installed is
//! exactly what was fetched and shown: the page never hands the shell a file to write. An install is asked as review.rs's
//! pushes are: `Installs::ask` writes nothing and answers the ask, the page settles it through approval-core, and only
//! `Installs::settle` with its id and a Yes writes, once. Writing never goes through a link (the skills folder may not be one,
//! every folder below it is made new, every file is made new with `create_new`), never outside the agent's skills folder (every
//! path is plain and relative, and the skill's name is one folder), never over an existing skill (refused `exists:<name>`, at
//! the ask and again before writing), sets no executable bit (files are made `0644`), and runs nothing.
//!
//! What a skill holds that an agent would act on by itself, without its permission prompt (item 113: Claude Code's
//! `allowed-tools`, `hooks`, a command run as the skill loads, any setting not on the harmless list; Codex's
//! `agents/openai.yaml` beyond its look), is refused at the ask and again before writing (`acts_alone`), naming the file and
//! the setting. Nothing is stripped so that the rest can be installed.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

use crate::api_link::{ApiAnswer, LinkError};

/// The API's limits (apps/api/src/artifact-store.ts): skills a bundle, files a bundle, characters a path.
pub const MAX_SKILLS: usize = 20;
pub const MAX_FILES: usize = 200;
pub const MAX_PATH: usize = 200;
/// The largest file read from disk: a bundle is at most 128 KiB in all, so no one file can be larger.
const MAX_FILE_BYTES: u64 = 128 * 1024;
/// How deep a skill's folders are read.
const MAX_DEPTH: usize = 8;
/// The longest title kept from a link.
const MAX_TITLE: usize = 120;
/// How long a fetched bundle and an ask wait for the person.
const ASK_LIFE: Duration = Duration::from_secs(15 * 60);
/// The most reads and asks kept in one run; the oldest go first.
const KEPT_MAX: usize = 64;
pub const SKILL_FILE: &str = "SKILL.md";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SkillFile {
    pub path: String,
    pub text: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Skill {
    pub name: String,
    pub files: Vec<SkillFile>,
}

/// A bundle as a link serves it (`/a/{link}.json`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Bundle {
    pub title: String,
    pub skills: Vec<Skill>,
}

// ---- the rules both sides keep -------------------------------------------------------------------------------------------

/// A skill's name, which is the one folder it is installed as: 1 to 64 letters, digits, `-`, `_` or `.`, not starting with a dot
/// and never `..`.
pub fn skill_name_ok(name: &str) -> bool {
    let b = name.as_bytes();
    !b.is_empty() && b.len() <= 64 && b[0].is_ascii_alphanumeric() && !name.contains("..")
        && b.iter().all(|c| c.is_ascii_alphanumeric() || matches!(c, b'-' | b'_' | b'.'))
}

/// Why `path` is not a plain relative path inside a skill: `dot_file` for a step whose name starts with a dot, `bad_path` for
/// anything else that is not `name/name/...` (empty, absolute, a `.` or `..` step, a backslash, a colon, a control or line
/// separator character, or over `MAX_PATH` characters). None when it is one.
pub fn path_refusal(path: &str) -> Option<&'static str> {
    if path.is_empty() || path.chars().count() > MAX_PATH || path.starts_with('/') {
        return Some("bad_path");
    }
    if path.chars().any(|c| c == '\\' || c == ':' || c.is_control() || c == '\u{2028}' || c == '\u{2029}') {
        return Some("bad_path");
    }
    let steps: Vec<&str> = path.split('/').collect();
    if steps.iter().any(|s| s.is_empty() || *s == "." || *s == "..") {
        return Some("bad_path");
    }
    if steps.iter().any(|s| s.starts_with('.')) {
        return Some("dot_file");
    }
    None
}

/// Why `skills` cannot be a bundle, as the API says it (`reason` alone), or None: the same rules as the API's `skillsRefusal`.
pub fn bundle_refusal(skills: &[Skill]) -> Option<&'static str> {
    if skills.is_empty() {
        return Some("no_skills");
    }
    if skills.len() > MAX_SKILLS {
        return Some("too_many_skills");
    }
    let mut names = HashSet::new();
    let mut count = 0;
    for skill in skills {
        if !skill_name_ok(&skill.name) {
            return Some("bad_name");
        }
        if !names.insert(skill.name.to_lowercase()) {
            return Some("duplicate_name");
        }
        count += skill.files.len();
        if count > MAX_FILES {
            return Some("too_many_files");
        }
        let mut paths = HashSet::new();
        for file in &skill.files {
            if let Some(bad) = path_refusal(&file.path) {
                return Some(bad);
            }
            if !paths.insert(file.path.to_lowercase()) {
                return Some("duplicate_path");
            }
            if file.text.contains('\0') {
                return Some("binary_file");
            }
        }
        for path in &paths {
            let steps: Vec<&str> = path.split('/').collect();
            if (1..steps.len()).any(|i| paths.contains(&steps[..i].join("/"))) {
                return Some("duplicate_path");
            }
        }
        if !skill.files.iter().any(|f| f.path == SKILL_FILE) {
            return Some("no_skill_md");
        }
    }
    None
}

// ---- what a coding agent would act on by itself (item 113) ----------------------------------------------------------------
//
// A skill is instructions, and every step an agent takes from them asks as usual. Some of what a skill's files can hold is acted
// on by the agent itself, before or without that prompt, so Kit's dial never sees it: in Claude Code (its skills documentation,
// read 26 Nov 2026) `allowed-tools`, `hooks`, a command run while the skill loads (`!` then a backtick, or a fence opened with
// "```!"), and settings that start a subagent or change the model or effort; in Codex, `agents/openai.yaml`'s `dependencies`,
// which declare tools such as an MCP server at an address. None of it is installed. The rule is an allow-list, the same as
// src/runtime/skillBundle.ts `fileActsAlone`, and src/runtime/skillActs.cases.json is the table both run.

/// The settings at the top of a skill's markdown that only describe it or narrow when it is used (skillBundle.ts HARMLESS_FIELDS).
pub const HARMLESS_FIELDS: &[&str] =
    &["name", "description", "when_to_use", "argument-hint", "disable-model-invocation", "user-invocable", "license", "compatibility", "metadata"];
/// The settings of a Codex `agents/openai.yaml` that only change how the skill is shown.
pub const HARMLESS_AGENT_FIELDS: &[&str] = &["interface"];

/// Why a file of a skill would be acted on by an agent by itself: `field` (a setting not on the harmless list, named in
/// `field`), `command` (a command run when the skill loads) or `unreadable` (a top that cannot be read as plain settings).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ActsAlone {
    pub why: &'static str,
    pub field: String,
}

impl ActsAlone {
    fn why(why: &'static str) -> Option<ActsAlone> {
        Some(ActsAlone { why, field: String::new() })
    }
}

/// Blank: Rust's whitespace and the BOM, the same set as JavaScript's `\s` and NEL.
fn is_blank(c: char) -> bool {
    c.is_whitespace() || c == '\u{feff}'
}

/// Space within a line: blank, but no line break.
fn is_space(c: char) -> bool {
    matches!(c, '\t' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'..='\u{200a}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}')
}

/// `text`'s lines, split at every break a YAML or JavaScript reader may take as one (`\r\n`, `\n`, `\r`, NEL, U+2028, U+2029).
fn lines(text: &str) -> Vec<&str> {
    let mut out = Vec::new();
    let mut start = 0;
    let mut it = text.char_indices().peekable();
    while let Some((i, c)) = it.next() {
        if matches!(c, '\n' | '\r' | '\u{85}' | '\u{2028}' | '\u{2029}') {
            out.push(&text[start..i]);
            let mut end = i + c.len_utf8();
            if c == '\r' && it.peek().map(|p| p.1) == Some('\n') {
                it.next();
                end += 1;
            }
            start = end;
        }
    }
    out.push(&text[start..]);
    out
}

/// One plain setting's name and what follows on its line: a letter, then up to 63 letters, digits, `_` or `-`, then a colon and
/// a space or the line's end.
fn setting_name(line: &str) -> Option<(&str, &str)> {
    let b = line.as_bytes();
    if !b.first()?.is_ascii_alphabetic() {
        return None;
    }
    let n = b.iter().take_while(|c| c.is_ascii_alphanumeric() || matches!(c, b'_' | b'-')).count();
    if n > 64 {
        return None;
    }
    let rest = line[n..].trim_start_matches([' ', '\t']);
    let after = rest.strip_prefix(':')?;
    (after.is_empty() || after.starts_with([' ', '\t'])).then_some((&line[..n], after))
}

/// Whether a setting with `value` on its line takes the indented lines under it (skillBundle.ts OPENS_BLOCK): nothing after the
/// colon, or only a comment, or a block mark (`|`, `>`, with its keep, strip or indent signs). Only under one of these may
/// indented lines follow: a one-line value with an indented line under it is read differently by a strict YAML reader and a
/// forgiving one, so it is not read at all.
fn opens_block(value: &str) -> bool {
    let v = value.trim_matches(is_blank);
    let mut c = v.chars().peekable();
    if matches!(c.peek(), Some('|' | '>')) {
        c.next();
        match c.peek().copied() {
            Some('+' | '-') => {
                c.next();
                if c.peek().is_some_and(|d| ('1'..='9').contains(d)) {
                    c.next();
                }
            }
            Some(d) if ('1'..='9').contains(&d) => {
                c.next();
                if matches!(c.peek(), Some('+' | '-')) {
                    c.next();
                }
            }
            _ => {}
        }
    }
    let rest: String = c.collect();
    let rest = rest.trim_start_matches([' ', '\t']);
    rest.is_empty() || rest.starts_with('#')
}

/// The settings of `lines` from `from`, each held to `allowed`, until a line that is exactly `---` (when `fenced`) or the end.
fn settings_refusal(lines: &[&str], from: usize, fenced: bool, allowed: &[&str]) -> Option<ActsAlone> {
    // whether the setting above takes indented lines, and how far its first one was indented: a later line indented less
    // would leave its block, which no setting does by being indented
    let mut open = false;
    let mut indent: Option<usize> = None;
    for line in lines.iter().skip(from) {
        if fenced && *line == "---" {
            return None;
        }
        if line.chars().all(is_blank) {
            continue;
        }
        if line.starts_with("---") || line.starts_with("...") {
            return ActsAlone::why("unreadable");
        }
        if line.starts_with(' ') {
            let n = line.bytes().take_while(|b| *b == b' ').count();
            if !open || line[n..].starts_with('\t') || indent.is_some_and(|i| n < i) {
                return ActsAlone::why("unreadable");
            }
            indent.get_or_insert(n);
            continue;
        }
        if line.starts_with('#') {
            continue;
        }
        let Some((name, value)) = setting_name(line) else { return ActsAlone::why("unreadable") };
        if !allowed.contains(&name) {
            return Some(ActsAlone { why: "field", field: name.to_string() });
        }
        open = opens_block(value);
        indent = None;
    }
    if fenced { ActsAlone::why("unreadable") } else { None }
}

/// `!` then a backtick with only space between, or a fence of three or more backticks or tildes whose word starts with `!`,
/// anywhere in the text (Claude Code runs the first only at a line's start or after a space: wider only refuses more).
fn runs_on_load(text: &str) -> bool {
    let c: Vec<char> = text.chars().collect();
    (0..c.len()).filter(|&i| c[i] == '!').any(|i| {
        let after = c[i + 1..].iter().find(|x| !is_space(**x));
        let mut j = i;
        while j > 0 && is_space(c[j - 1]) {
            j -= 1;
        }
        let fence = j > 0 && matches!(c[j - 1], '`' | '~') && c[..j].iter().rev().take_while(|x| **x == c[j - 1]).count() >= 3;
        after == Some(&'`') || fence
    })
}

/// What in file `path` of a skill an agent would act on by itself, or None (skillBundle.ts `fileActsAlone`): the settings at the
/// top of any markdown file and any command run as it loads, and the settings of a Codex `agents/*.yaml`.
pub fn file_acts_alone(path: &str, text: &str) -> Option<ActsAlone> {
    let lower = path.to_ascii_lowercase();
    let markdown = [".md", ".markdown", ".mdx"].iter().any(|e| lower.ends_with(e));
    let steps: Vec<&str> = lower.split('/').collect();
    let name = steps[steps.len() - 1];
    let agent_yaml = steps.len() >= 2
        && steps[steps.len() - 2] == "agents"
        && name.strip_suffix(".yaml").or_else(|| name.strip_suffix(".yml")).is_some_and(|stem| !stem.is_empty());
    if !markdown && !agent_yaml {
        return None;
    }
    let all = lines(text.trim_start_matches('\u{feff}'));
    let first = all.iter().position(|l| !l.chars().all(is_blank));
    if agent_yaml {
        let first = first?;
        let top = all[first];
        if top.starts_with("---") && top != "---" {
            return ActsAlone::why("unreadable");
        }
        return settings_refusal(&all, if top == "---" { first + 1 } else { first }, false, HARMLESS_AGENT_FIELDS);
    }
    if let Some(first) = first {
        let top = all[first].trim_start_matches(is_blank);
        if top.starts_with("---") {
            if top != "---" {
                return ActsAlone::why("unreadable");
            }
            if let Some(refused) = settings_refusal(&all, first + 1, true, HARMLESS_FIELDS) {
                return Some(refused);
            }
        }
    }
    if runs_on_load(text) { ActsAlone::why("command") } else { None }
}

/// The first file of the first skill of `skills` an agent would act on by itself, as the shell refuses it:
/// `acts_alone:<why>:<skill>/<path>`, with `:<field>` for a setting. Neither a name nor a path can hold a colon.
pub fn acts_alone_refusal(skills: &[Skill]) -> Option<String> {
    skills.iter().find_map(|s| {
        s.files.iter().find_map(|f| {
            file_acts_alone(&f.path, &f.text).map(|a| {
                let field = if a.field.is_empty() { String::new() } else { format!(":{}", a.field) };
                format!("acts_alone:{}:{}/{}{field}", a.why, s.name, f.path)
            })
        })
    })
}

// ---- reading the person's own skill ---------------------------------------------------------------------------------------

/// One file of a skill as read from disk.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ReadFile {
    pub path: String,
    pub text: String,
    pub bytes: u64,
    /// its executable bit is set
    pub exec: bool,
}

/// A file that cannot be in the bundle, by path, and why: `link`, `binary`, `too_large`, `special`, `bad_path`, `too_many`,
/// `too_deep` or `unreadable`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Refused {
    pub path: String,
    pub why: &'static str,
}

/// One skill folder as read: its files, the files that cannot be published (any one of them stops the publish), and the
/// dot-files and dot-folders left out.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ReadSkill {
    pub name: String,
    pub files: Vec<ReadFile>,
    pub refused: Vec<Refused>,
    pub left_out: Vec<String>,
}

/// The skill in folder `folder` of the first of `roots` that holds one (agent_config.rs `home_skill_roots`). Err `bad_name` for
/// a folder that is not one plain name, `not_found`, `link` when the skill's folder is a link, `no_skill_md`.
pub fn read_skill(roots: &[PathBuf], folder: &str) -> Result<ReadSkill, String> {
    if !skill_name_ok(folder) {
        return Err("bad_name".into());
    }
    let dir = roots.iter().map(|r| r.join(folder)).find(|d| std::fs::symlink_metadata(d).is_ok()).ok_or("not_found")?;
    let meta = std::fs::symlink_metadata(&dir).map_err(|_| "not_found")?;
    if meta.file_type().is_symlink() {
        return Err("link".into());
    }
    if !meta.is_dir() {
        return Err("not_found".into());
    }
    let mut out = ReadSkill { name: folder.to_string(), files: Vec::new(), refused: Vec::new(), left_out: Vec::new() };
    walk(&dir, "", 0, &mut out);
    if !out.files.iter().any(|f| f.path == SKILL_FILE) {
        return Err("no_skill_md".into());
    }
    Ok(out)
}

fn walk(dir: &Path, rel: &str, depth: usize, out: &mut ReadSkill) {
    if depth > MAX_DEPTH {
        out.refused.push(Refused { path: rel.to_string(), why: "too_deep" });
        return;
    }
    let Ok(rd) = std::fs::read_dir(dir) else {
        out.refused.push(Refused { path: if rel.is_empty() { ".".into() } else { rel.to_string() }, why: "unreadable" });
        return;
    };
    let mut entries: Vec<_> = rd.flatten().collect();
    entries.sort_by_key(|e| e.file_name());
    for e in entries {
        let name = e.file_name().to_string_lossy().into_owned();
        let path = if rel.is_empty() { name.clone() } else { format!("{rel}/{name}") };
        if name.starts_with('.') {
            out.left_out.push(path);
            continue;
        }
        let Ok(meta) = std::fs::symlink_metadata(e.path()) else {
            out.refused.push(Refused { path, why: "unreadable" });
            continue;
        };
        if meta.file_type().is_symlink() {
            out.refused.push(Refused { path, why: "link" });
            continue;
        }
        if e.file_name().to_str().is_none() || path_refusal(&path).is_some() {
            out.refused.push(Refused { path, why: "bad_path" });
            continue;
        }
        if meta.is_dir() {
            walk(&e.path(), &path, depth + 1, out);
            continue;
        }
        if !meta.is_file() {
            out.refused.push(Refused { path, why: "special" });
            continue;
        }
        if out.files.len() >= MAX_FILES {
            out.refused.push(Refused { path, why: "too_many" });
            continue;
        }
        if meta.len() > MAX_FILE_BYTES {
            out.refused.push(Refused { path, why: "too_large" });
            continue;
        }
        match read_no_follow(&e.path()) {
            Some(bytes) if !bytes.contains(&0) => match String::from_utf8(bytes) {
                Ok(text) => out.files.push(ReadFile { bytes: text.len() as u64, text, path, exec: executable(&meta) }),
                Err(_) => out.refused.push(Refused { path, why: "binary" }),
            },
            Some(_) => out.refused.push(Refused { path, why: "binary" }),
            None => out.refused.push(Refused { path, why: "unreadable" }),
        }
    }
}

/// A file's bytes, opened without following a link (a link put in its place since it was looked at is not read).
fn read_no_follow(path: &Path) -> Option<Vec<u8>> {
    use std::io::Read;
    let mut options = std::fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW);
    }
    let mut bytes = Vec::new();
    options.open(path).ok()?.take(MAX_FILE_BYTES + 1).read_to_end(&mut bytes).ok()?;
    (bytes.len() as u64 <= MAX_FILE_BYTES).then_some(bytes)
}

#[cfg(unix)]
fn executable(meta: &std::fs::Metadata) -> bool {
    use std::os::unix::fs::PermissionsExt;
    meta.permissions().mode() & 0o111 != 0
}

#[cfg(not(unix))]
fn executable(_meta: &std::fs::Metadata) -> bool {
    false
}

// ---- a link to install from ----------------------------------------------------------------------------------------------

/// `scheme://authority` and the rest of an address, the authority in lower case.
fn split_address(url: &str) -> Option<(&'static str, String, &str)> {
    let (scheme, rest) = if let Some(r) = url.strip_prefix("https://") { ("https", r) } else { ("http", url.strip_prefix("http://")?) };
    let at = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    Some((scheme, rest[..at].to_ascii_lowercase(), &rest[at..]))
}

/// The JSON address of `link` when it is a link on `origin` (the artifact origin the API named): the same scheme and host
/// (and port), then `/a/<shop>.<secret>`, with or without `.json`, and nothing else. Err `no_origin` while there is no usable
/// origin, `other_host` for a link anywhere else, `not_a_link` for any other address on it. Reaches nothing.
pub fn json_url(link: &str, origin: &str) -> Result<String, &'static str> {
    let origin = origin.trim().trim_end_matches('/');
    let (o_scheme, o_auth, o_rest) = split_address(origin).ok_or("no_origin")?;
    if !o_rest.is_empty() || crate::api_link::checked_url(&format!("{o_scheme}://{o_auth}/v1/x")).is_err() {
        return Err("no_origin");
    }
    let (scheme, auth, path) = split_address(link.trim()).ok_or("other_host")?;
    if scheme != o_scheme || auth != o_auth {
        return Err("other_host");
    }
    let key = path.strip_prefix("/a/").ok_or("not_a_link")?;
    let key = key.strip_suffix(".json").unwrap_or(key);
    let url = format!("{o_scheme}://{o_auth}/a/{key}.json");
    crate::api_link::checked_link_url(&url).map_err(|_| "not_a_link")?;
    Ok(url)
}

/// The bundle at `link`, fetched with `fetch` only once `json_url` took the link, and held to `bundle_refusal`. Err `other_host`,
/// `not_a_link`, `no_origin` (nothing fetched), `not_found` (the link opens nothing: unknown, removed or switched off),
/// `rate_limited`, `offline`, `unavailable`, `unreadable`, or `bad_bundle:<reason>`.
pub fn read_link(link: &str, origin: &str, fetch: &dyn Fn(&str) -> Result<ApiAnswer, LinkError>) -> Result<Bundle, String> {
    let url = json_url(link, origin)?;
    let answer = fetch(&url).map_err(|e| if e == LinkError::Offline { "offline" } else { "unavailable" })?;
    match answer.status {
        200 => {}
        404 => return Err("not_found".into()),
        429 => return Err("rate_limited".into()),
        _ => return Err("unavailable".into()),
    }
    let mut bundle: Bundle = serde_json::from_str(&answer.body).map_err(|_| "unreadable")?;
    if let Some(why) = bundle_refusal(&bundle.skills) {
        return Err(format!("bad_bundle:{why}"));
    }
    let title: String = bundle.title.chars().filter(|c| !c.is_control()).take(MAX_TITLE).collect();
    bundle.title = title.trim().to_string();
    Ok(bundle)
}

/// A fetched bundle as the page is given it: the id `Installs::keep_read` kept it under, which an install names, and what it holds.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct LinkRead {
    pub read: String,
    pub title: String,
    pub skills: Vec<Skill>,
}

// ---- the install ask -----------------------------------------------------------------------------------------------------

/// One file of an ask, as the page shows it beside the text it already holds.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct AskFile {
    pub path: String,
    pub bytes: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct AskSkill {
    pub name: String,
    pub files: Vec<AskFile>,
}

/// What one install would write: for `agent`, into `folder` (the agent's skills folder, `~` for the home), each skill as a new
/// folder of its name. Nothing is written until it is settled with a Yes.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct InstallAsk {
    pub id: String,
    pub agent: String,
    pub folder: String,
    pub skills: Vec<AskSkill>,
}

/// What a settled ask did: `declined`, `installed` (every skill), or `failed` with the skill it stopped at (`failed`, whose
/// half-made folder was taken away) and `why`. `installed` names what was written.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Default)]
pub struct InstallDone {
    pub outcome: String,
    pub installed: Vec<String>,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub failed: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub why: String,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum State {
    Waiting,
    Decided,
    Withdrawn,
}

struct Plan {
    root: PathBuf,
    skills: Vec<Skill>,
}

struct Entry {
    plan: Plan,
    made: Instant,
    state: State,
}

/// The proof an ask was settled with a Yes: only `Installs::settle` makes one, and `install` cannot run without it.
struct Settled(());

/// The bundles fetched and the asks made in this run of the app, by id. Ids are never reused.
pub struct Installs {
    reads: Mutex<HashMap<String, (Instant, Bundle)>>,
    asks: Mutex<HashMap<String, Entry>>,
    life: Duration,
}

impl Default for Installs {
    fn default() -> Installs {
        Installs { reads: Mutex::new(HashMap::new()), asks: Mutex::new(HashMap::new()), life: ASK_LIFE }
    }
}

/// A fresh id: 128 random bits from the system, else the time and a counter.
fn new_id() -> String {
    use std::io::Read;
    use std::sync::atomic::{AtomicU64, Ordering};
    static N: AtomicU64 = AtomicU64::new(0);
    let mut b = [0u8; 16];
    if std::fs::File::open("/dev/urandom").and_then(|mut f| f.read_exact(&mut b)).is_err() {
        let t = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
        b[..8].copy_from_slice(&(t as u64).to_le_bytes());
        b[8..].copy_from_slice(&N.fetch_add(1, Ordering::Relaxed).to_le_bytes());
    }
    b.iter().map(|x| format!("{x:02x}")).collect()
}

/// `path` as the page shows it: under the home as `~/...`.
fn shown(home: &Path, path: &Path) -> String {
    match path.strip_prefix(home) {
        Ok(rest) => format!("~/{}", rest.to_string_lossy()),
        Err(_) => path.to_string_lossy().into_owned(),
    }
}

/// Whether anything at all is at `path`, a link that leads nowhere included.
fn taken(path: &Path) -> bool {
    std::fs::symlink_metadata(path).is_ok()
}

impl Installs {
    #[cfg(test)]
    fn with_life(life: Duration) -> Installs {
        Installs { life, ..Installs::default() }
    }

    /// Keeps a bundle `read_link` fetched, and answers its id: an install names it, so the shell writes only what it fetched.
    pub fn keep_read(&self, bundle: Bundle) -> String {
        let id = new_id();
        let mut m = self.reads.lock().unwrap_or_else(|e| e.into_inner());
        if m.len() >= KEPT_MAX {
            let life = self.life;
            m.retain(|_, (made, _)| made.elapsed() <= life);
        }
        m.insert(id.clone(), (Instant::now(), bundle));
        id
    }

    /// Asks to install the skills `names` of fetched bundle `read` for `agent` (`claude` or `codex`) into `root`, its skills
    /// folder (agent_config.rs `install_root`). Writes nothing. Err `not_found` or `expired` for the read, `no_skills`,
    /// `bad_bundle:<reason>`, `acts_alone:<why>:<skill>/<path>[:<field>]` for a skill an agent would act on by itself,
    /// `link_root` when the skills folder is a link, `not_a_folder`, or `exists:<name>` for a skill the agent already has.
    pub fn ask(&self, home: &Path, agent: &str, root: &Path, read: &str, names: &[String]) -> Result<InstallAsk, String> {
        let bundle = {
            let m = self.reads.lock().unwrap_or_else(|e| e.into_inner());
            let (made, bundle) = m.get(read).ok_or("not_found")?;
            if made.elapsed() > self.life {
                return Err("expired".into());
            }
            bundle.clone()
        };
        let skills: Vec<Skill> = bundle.skills.into_iter().filter(|s| names.contains(&s.name)).collect();
        if skills.is_empty() || skills.len() != names.iter().collect::<HashSet<_>>().len() {
            return Err("no_skills".into());
        }
        if let Some(why) = bundle_refusal(&skills) {
            return Err(format!("bad_bundle:{why}"));
        }
        // Never stripped and installed without it: the skill is refused whole, naming its file and setting.
        if let Some(why) = acts_alone_refusal(&skills) {
            return Err(why);
        }
        root_ok(root)?;
        if let Some(s) = skills.iter().find(|s| taken(&root.join(&s.name))) {
            return Err(format!("exists:{}", s.name));
        }
        let ask = InstallAsk {
            id: String::new(),
            agent: agent.to_string(),
            folder: shown(home, root),
            skills: skills
                .iter()
                .map(|s| AskSkill { name: s.name.clone(), files: s.files.iter().map(|f| AskFile { path: f.path.clone(), bytes: f.text.len() as u64 }).collect() })
                .collect(),
        };
        let id = new_id();
        let mut m = self.asks.lock().unwrap_or_else(|e| e.into_inner());
        if m.len() >= KEPT_MAX {
            let life = self.life;
            m.retain(|_, e| e.state == State::Waiting && e.made.elapsed() <= life);
        }
        m.insert(id.clone(), Entry { plan: Plan { root: root.to_path_buf(), skills }, made: Instant::now(), state: State::Waiting });
        Ok(InstallAsk { id, ..ask })
    }

    /// The person's answer to ask `id`, as approval-core settled it on the page. The ask leaves waiting before anything is
    /// written, so it is answered once (`already_decided`, `withdrawn`, `expired`, `not_found` otherwise). A No writes nothing;
    /// a Yes writes what the ask named, once.
    pub fn settle(&self, id: &str, yes: bool) -> Result<InstallDone, String> {
        let plan = {
            let mut m = self.asks.lock().unwrap_or_else(|e| e.into_inner());
            let e = m.get_mut(id).ok_or("not_found")?;
            match e.state {
                State::Decided => return Err("already_decided".into()),
                State::Withdrawn => return Err("withdrawn".into()),
                State::Waiting => {}
            }
            if e.made.elapsed() > self.life {
                e.state = State::Withdrawn;
                return Err("expired".into());
            }
            e.state = State::Decided;
            if !yes {
                return Ok(InstallDone { outcome: "declined".into(), ..InstallDone::default() });
            }
            Plan { root: e.plan.root.clone(), skills: e.plan.skills.clone() }
        };
        install(Settled(()), &plan)
    }

    /// Takes a waiting ask back: a later answer to it writes nothing.
    pub fn withdraw(&self, id: &str) {
        let mut m = self.asks.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(e) = m.get_mut(id).filter(|e| e.state == State::Waiting) {
            e.state = State::Withdrawn;
        }
    }
}

/// The skills folder may be missing (it is made) or a real folder; never a link or a file.
fn root_ok(root: &Path) -> Result<(), String> {
    match std::fs::symlink_metadata(root) {
        Ok(m) if m.file_type().is_symlink() => Err("link_root".into()),
        Ok(m) if !m.is_dir() => Err("not_a_folder".into()),
        _ => Ok(()),
    }
}

/// A new folder at `path`: refused when anything is there already, a link included.
fn new_dir(path: &Path) -> std::io::Result<()> {
    let mut b = std::fs::DirBuilder::new();
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        b.mode(0o755);
    }
    b.create(path)
}

/// A new file at `path` holding `text`, with no executable bit: refused when anything is there already, a link included.
fn new_file(path: &Path, text: &str) -> std::io::Result<()> {
    use std::io::Write;
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o644);
    }
    options.open(path)?.write_all(text.as_bytes())
}

/// Writes one skill's files into `dir`, the new folder just made for it: every folder below it new, every file new. Nothing here
/// follows a link, since everything it writes into was made by it a moment before.
fn write_files(dir: &Path, skill: &Skill) -> std::io::Result<()> {
    for file in &skill.files {
        let steps: Vec<&str> = file.path.split('/').collect();
        let mut at = dir.to_path_buf();
        for step in &steps[..steps.len() - 1] {
            at.push(step);
            match std::fs::symlink_metadata(&at) {
                Ok(m) if m.is_dir() && !m.file_type().is_symlink() => {}
                Ok(_) => return Err(std::io::Error::new(std::io::ErrorKind::AlreadyExists, "not a folder")),
                Err(_) => new_dir(&at)?,
            }
        }
        new_file(&at.join(steps[steps.len() - 1]), &file.text)?;
    }
    Ok(())
}

/// Runs a settled Yes: the one place a skill is written. Every rule is checked again before anything is written, and every
/// skill's folder is checked to be free; a skill that fails part way has its new folder taken away again.
fn install(_settled: Settled, plan: &Plan) -> Result<InstallDone, String> {
    if let Some(why) = bundle_refusal(&plan.skills) {
        return Err(format!("bad_bundle:{why}"));
    }
    if let Some(why) = acts_alone_refusal(&plan.skills) {
        return Err(why);
    }
    root_ok(&plan.root)?;
    if let Some(s) = plan.skills.iter().find(|s| taken(&plan.root.join(&s.name))) {
        return Err(format!("exists:{}", s.name));
    }
    if !taken(&plan.root) {
        std::fs::create_dir_all(&plan.root).map_err(|_| "unwritable")?;
        root_ok(&plan.root)?;
    }
    let mut done = InstallDone { outcome: "installed".into(), ..InstallDone::default() };
    for skill in &plan.skills {
        let dir = plan.root.join(&skill.name);
        // The skill's folder is made new, or nothing is written: whatever is there already, a link included, is left as it is.
        let failed = match new_dir(&dir) {
            Err(e) => Some(if e.kind() == std::io::ErrorKind::AlreadyExists { "exists" } else { "unwritable" }),
            Ok(()) => write_files(&dir, skill).err().map(|_| {
                // Only the folder this install just made is taken away again.
                let _ = std::fs::remove_dir_all(&dir);
                "unwritable"
            }),
        };
        if let Some(why) = failed {
            done.outcome = "failed".into();
            done.failed = skill.name.clone();
            done.why = why.into();
            return Ok(done);
        }
        done.installed.push(skill.name.clone());
    }
    Ok(done)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::net::TcpListener;

    fn temp(tag: &str) -> PathBuf {
        let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
        let d = std::env::temp_dir().join(format!("manut-skills-{tag}-{}-{nanos}", std::process::id()));
        fs::create_dir_all(&d).unwrap();
        d
    }

    fn put(dir: &Path, rel: &str, bytes: &[u8]) {
        let p = dir.join(rel);
        fs::create_dir_all(p.parent().unwrap()).unwrap();
        fs::write(p, bytes).unwrap();
    }

    #[cfg(unix)]
    fn mode(path: &Path) -> u32 {
        use std::os::unix::fs::PermissionsExt;
        fs::metadata(path).unwrap().permissions().mode() & 0o777
    }

    fn file(path: &str, text: &str) -> SkillFile {
        SkillFile { path: path.into(), text: text.into() }
    }

    fn skill(name: &str, files: Vec<SkillFile>) -> Skill {
        Skill { name: name.into(), files }
    }

    const KEY: &str = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA.BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";

    #[test]
    fn a_path_is_plain_and_relative_and_a_name_is_one_folder() {
        for ok in ["SKILL.md", "scripts/qr.py", "a/b/c.txt", "notes v2.md"] {
            assert_eq!(path_refusal(ok), None, "{ok}");
        }
        for bad in ["../x", "a/../../x", "a/..", "/etc/passwd", "./x", "a//b", "", "a/", "a\\b", "C:/x", "x\ny"] {
            assert_eq!(path_refusal(bad), Some("bad_path"), "{bad:?}");
        }
        assert_eq!(path_refusal(&"x".repeat(201)), Some("bad_path"));
        for dot in [".env", "a/.git/config", ".claude/settings.json"] {
            assert_eq!(path_refusal(dot), Some("dot_file"), "{dot}");
        }
        for name in ["stock", "promptpay-qr", "a.b_c"] {
            assert!(skill_name_ok(name), "{name}");
        }
        for name in ["", "..", ".x", "a/b", "a..b", "-x", "ไทย"] {
            assert!(!skill_name_ok(name), "{name}");
        }
    }

    #[test]
    fn a_bundle_keeps_the_apis_rules() {
        let ok = vec![skill("one", vec![file("SKILL.md", "x"), file("run.sh", "#!/bin/sh\n")])];
        assert_eq!(bundle_refusal(&ok), None);
        assert_eq!(bundle_refusal(&[]), Some("no_skills"));
        assert_eq!(bundle_refusal(&[skill("one", vec![file("README.md", "x")])]), Some("no_skill_md"));
        assert_eq!(bundle_refusal(&[skill("one", vec![file("SKILL.md", "x"), file("../up", "x")])]), Some("bad_path"));
        assert_eq!(bundle_refusal(&[skill("one", vec![file("SKILL.md", "x"), file("/abs", "x")])]), Some("bad_path"));
        assert_eq!(bundle_refusal(&[skill("one", vec![file("SKILL.md", "x"), file(".env", "K=1")])]), Some("dot_file"));
        assert_eq!(bundle_refusal(&[skill("one", vec![file("SKILL.md", "x"), file("a.bin", "\0")])]), Some("binary_file"));
        assert_eq!(bundle_refusal(&[skill("one", vec![file("SKILL.md", "x"), file("a", "x"), file("a/b", "y")])]), Some("duplicate_path"));
        assert_eq!(bundle_refusal(&[skill("../x", vec![file("SKILL.md", "x")])]), Some("bad_name"));
        assert_eq!(bundle_refusal(&[skill("a", vec![file("SKILL.md", "x")]), skill("A", vec![file("SKILL.md", "x")])]), Some("duplicate_name"));
    }

    #[test]
    #[cfg(unix)]
    fn reading_a_skill_follows_no_link_refuses_binaries_by_name_and_leaves_dot_files_out() {
        use std::os::unix::fs::{symlink, PermissionsExt};
        let root = temp("read");
        let outside = temp("read-outside");
        put(&outside, "secret.txt", b"sk-outside");
        let s = root.join("promptpay");
        put(&s, "SKILL.md", b"---\nname: promptpay\n---\nbody\n");
        put(&s, "scripts/qr.py", b"#!/usr/bin/env python3\nprint(1)\n");
        fs::set_permissions(s.join("scripts/qr.py"), fs::Permissions::from_mode(0o755)).unwrap();
        put(&s, "logo.png", b"\x89PNG\r\n\x1a\n\0\0");
        put(&s, ".env", b"KEY=1");
        put(&s, ".git/config", b"x");
        symlink(outside.join("secret.txt"), s.join("linked.txt")).unwrap();
        symlink(&outside, s.join("linked-folder")).unwrap();
        let read = read_skill(std::slice::from_ref(&root), "promptpay").unwrap();
        let files: Vec<(&str, bool)> = read.files.iter().map(|f| (f.path.as_str(), f.exec)).collect();
        assert_eq!(files, vec![("SKILL.md", false), ("scripts/qr.py", true)]);
        let refused: Vec<(&str, &str)> = read.refused.iter().map(|r| (r.path.as_str(), r.why)).collect();
        assert_eq!(refused, vec![("linked-folder", "link"), ("linked.txt", "link"), ("logo.png", "binary")]);
        assert_eq!(read.left_out, vec![".env".to_string(), ".git".to_string()]);
        // nothing behind a link was read
        assert!(!serde_json::to_string(&read).unwrap().contains("sk-outside"));
        // a skill whose own folder is a link is refused whole, and so is a name that is not one folder
        symlink(&s, root.join("alias")).unwrap();
        assert_eq!(read_skill(std::slice::from_ref(&root), "alias"), Err("link".into()));
        assert_eq!(read_skill(std::slice::from_ref(&root), "../promptpay"), Err("bad_name".into()));
        assert_eq!(read_skill(std::slice::from_ref(&root), "missing"), Err("not_found".into()));
        let _ = fs::remove_dir_all(root);
        let _ = fs::remove_dir_all(outside);
    }

    #[test]
    fn a_link_is_taken_only_on_the_artifact_origin() {
        let origin = "https://links.manut-pages.test";
        let want = Ok(format!("{origin}/a/{KEY}.json"));
        assert_eq!(json_url(&format!("{origin}/a/{KEY}"), origin), want);
        assert_eq!(json_url(&format!("{origin}/a/{KEY}.json"), &format!("{origin}/")), want);
        assert_eq!(json_url(&format!("https://LINKS.manut-pages.test/a/{KEY}"), origin), want);
        for other in [
            format!("https://evil.example/a/{KEY}"),
            format!("https://links.manut-pages.test.evil.example/a/{KEY}"),
            format!("http://links.manut-pages.test/a/{KEY}"),
            format!("https://links.manut-pages.test:8443/a/{KEY}"),
            format!("https://user@links.manut-pages.test/a/{KEY}"),
            format!("ftp://links.manut-pages.test/a/{KEY}"),
            "not a link".to_string(),
        ] {
            assert_eq!(json_url(&other, origin), Err("other_host"), "{other}");
        }
        for bad in [format!("{origin}/a/{KEY}?x=1"), format!("{origin}/a/{KEY}#x"), format!("{origin}/v1/artifacts"), format!("{origin}/a/../v1/x"), format!("{origin}/a/short.key")] {
            assert_eq!(json_url(&bad, origin), Err("not_a_link"), "{bad}");
        }
        for none in ["", "https://links.manut-pages.test/path", "http://links.manut-pages.test", "nonsense"] {
            assert_eq!(json_url(&format!("{origin}/a/{KEY}"), none), Err("no_origin"), "{none}");
        }
    }

    #[test]
    fn a_link_on_another_host_is_refused_before_anything_is_fetched() {
        let calls = std::cell::Cell::new(0);
        let fetch = |_: &str| -> Result<ApiAnswer, LinkError> {
            calls.set(calls.get() + 1);
            Ok(ApiAnswer { status: 200, body: "{}".into() })
        };
        let origin = "https://links.manut-pages.test";
        assert_eq!(read_link(&format!("https://evil.example/a/{KEY}"), origin, &fetch), Err("other_host".into()));
        assert_eq!(read_link(&format!("{origin}/v1/x"), origin, &fetch), Err("not_a_link".into()));
        assert_eq!(read_link(&format!("{origin}/a/{KEY}"), "", &fetch), Err("no_origin".into()));
        assert_eq!(calls.get(), 0);
        // and with the shell's real fetch, nothing reaches a server that is not the origin's
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let port = listener.local_addr().unwrap().port();
        let refused = read_link(&format!("http://127.0.0.1:{port}/a/{KEY}"), &format!("http://localhost:{port}"), &crate::api_link::fetch_link);
        assert_eq!(refused, Err("other_host".into()));
        assert!(matches!(listener.accept(), Err(e) if e.kind() == std::io::ErrorKind::WouldBlock));
    }

    /// Serves `body` once with `status` on this computer, and answers the request line it was sent.
    fn serve_once(status: u16, body: String) -> (String, std::thread::JoinHandle<String>) {
        use std::io::{Read, Write};
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let origin = format!("http://127.0.0.1:{}", listener.local_addr().unwrap().port());
        let handle = std::thread::spawn(move || {
            let (mut s, _) = listener.accept().unwrap();
            let mut buf = [0u8; 4096];
            let n = s.read(&mut buf).unwrap_or(0);
            let head = String::from_utf8_lossy(&buf[..n]).lines().next().unwrap_or("").to_string();
            let _ = write!(s, "HTTP/1.1 {status} X\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}", body.len());
            head
        });
        (origin, handle)
    }

    #[test]
    fn a_bundle_is_fetched_from_its_json_and_held_to_the_rules_again() {
        let good = serde_json::json!({"title": "Shop\nskills", "skills": [{"name": "stock", "files": [{"path": "SKILL.md", "text": "x"}]}]});
        let (origin, server) = serve_once(200, good.to_string());
        let read = read_link(&format!("{origin}/a/{KEY}"), &origin, &crate::api_link::fetch_link).unwrap();
        assert_eq!(read, Bundle { title: "Shopskills".into(), skills: vec![skill("stock", vec![file("SKILL.md", "x")])] });
        assert_eq!(server.join().unwrap(), format!("GET /a/{KEY}.json HTTP/1.1"));
        // a served bundle that breaks a rule, or carries a field a bundle has not, is refused whole
        for (body, why) in [
            (serde_json::json!({"title": "t", "skills": [{"name": "x", "files": [{"path": "SKILL.md", "text": "x"}, {"path": "../../.zshrc", "text": "rm"}]}]}), "bad_bundle:bad_path"),
            (serde_json::json!({"title": "t", "skills": [{"name": "x", "files": [{"path": "SKILL.md", "text": "x"}, {"path": ".env", "text": "K"}]}]}), "bad_bundle:dot_file"),
            (serde_json::json!({"title": "t", "skills": [{"name": "../x", "files": [{"path": "SKILL.md", "text": "x"}]}]}), "bad_bundle:bad_name"),
            (serde_json::json!({"title": "t", "skills": [{"name": "x", "files": [{"path": "SKILL.md", "text": "x", "mode": 493}]}]}), "unreadable"),
        ] {
            let fetch = |_: &str| -> Result<ApiAnswer, LinkError> { Ok(ApiAnswer { status: 200, body: body.to_string() }) };
            assert_eq!(read_link(&format!("{origin}/a/{KEY}"), &origin, &fetch), Err(why.to_string()));
        }
        let gone = |_: &str| -> Result<ApiAnswer, LinkError> { Ok(ApiAnswer { status: 404, body: "Not found".into() }) };
        assert_eq!(read_link(&format!("{origin}/a/{KEY}"), &origin, &gone), Err("not_found".into()));
    }

    fn bundle() -> Bundle {
        Bundle {
            title: "Shop skills".into(),
            skills: vec![
                skill("promptpay", vec![file("SKILL.md", "---\nname: promptpay\n---\n"), file("scripts/qr.sh", "#!/bin/sh\ntouch \"$HOME/ran\"\n")]),
                skill("stock", vec![file("SKILL.md", "count")]),
            ],
        }
    }

    #[test]
    #[cfg(unix)]
    fn an_install_writes_new_files_with_no_executable_bit_and_runs_nothing() {
        let home = temp("install");
        let root = home.join(".claude/skills");
        let installs = Installs::default();
        let read = installs.keep_read(bundle());
        let ask = installs.ask(&home, "claude", &root, &read, &["promptpay".into(), "stock".into()]).unwrap();
        assert_eq!(ask.folder, "~/.claude/skills");
        assert_eq!(ask.skills.iter().map(|s| s.name.as_str()).collect::<Vec<_>>(), vec!["promptpay", "stock"]);
        // the ask wrote nothing
        assert!(!root.exists());
        let done = installs.settle(&ask.id, true).unwrap();
        assert_eq!(done, InstallDone { outcome: "installed".into(), installed: vec!["promptpay".into(), "stock".into()], ..InstallDone::default() });
        let script = root.join("promptpay/scripts/qr.sh");
        assert_eq!(fs::read_to_string(&script).unwrap(), "#!/bin/sh\ntouch \"$HOME/ran\"\n");
        assert_eq!(mode(&script) & 0o111, 0);
        assert_eq!(mode(&root.join("stock/SKILL.md")) & 0o111, 0);
        // nothing was run: the script's mark is nowhere
        assert!(!home.join("ran").exists());
        // settled once
        assert_eq!(installs.settle(&ask.id, true), Err("already_decided".into()));
        let _ = fs::remove_dir_all(home);
    }

    #[test]
    #[cfg(unix)]
    fn an_install_never_overwrites_never_goes_through_a_link_and_writes_nothing_on_no() {
        use std::os::unix::fs::symlink;
        let home = temp("refuse");
        let root = home.join(".agents/skills");
        put(&root, "stock/SKILL.md", b"mine");
        let installs = Installs::default();
        let read = installs.keep_read(bundle());
        // a skill the agent has already is refused at the ask, and left as it was
        assert_eq!(installs.ask(&home, "codex", &root, &read, &["stock".into()]), Err("exists:stock".into()));
        // a link where a skill would go is a skill already there, even one that leads nowhere
        symlink(home.join("nowhere"), root.join("promptpay")).unwrap();
        assert_eq!(installs.ask(&home, "codex", &root, &read, &["promptpay".into()]), Err("exists:promptpay".into()));
        fs::remove_file(root.join("promptpay")).unwrap();
        // one made after the ask is found again before anything is written, and nothing else is written either
        let ask = installs.ask(&home, "codex", &root, &read, &["promptpay".into()]).unwrap();
        put(&root, "promptpay/SKILL.md", b"made since");
        assert_eq!(installs.settle(&ask.id, true), Err("exists:promptpay".into()));
        assert_eq!(fs::read_to_string(root.join("promptpay/SKILL.md")).unwrap(), "made since");
        assert_eq!(fs::read_to_string(root.join("stock/SKILL.md")).unwrap(), "mine");
        fs::remove_dir_all(root.join("promptpay")).unwrap();
        // a skills folder that is a link is never written through
        let elsewhere = temp("refuse-elsewhere");
        let linked = home.join("linked-skills");
        symlink(&elsewhere, &linked).unwrap();
        assert_eq!(installs.ask(&home, "codex", &linked, &read, &["promptpay".into()]), Err("link_root".into()));
        assert_eq!(fs::read_dir(&elsewhere).unwrap().count(), 0);
        // No writes nothing; a withdrawn ask and an expired one write nothing either
        let no = installs.ask(&home, "codex", &root, &read, &["promptpay".into()]).unwrap();
        assert_eq!(installs.settle(&no.id, false).unwrap().outcome, "declined");
        let gone = installs.ask(&home, "codex", &root, &read, &["promptpay".into()]).unwrap();
        installs.withdraw(&gone.id);
        assert_eq!(installs.settle(&gone.id, true), Err("withdrawn".into()));
        let short = Installs::with_life(Duration::ZERO);
        let r = short.keep_read(bundle());
        std::thread::sleep(Duration::from_millis(2));
        assert_eq!(short.ask(&home, "codex", &root, &r, &["promptpay".into()]), Err("expired".into()));
        assert!(!root.join("promptpay").exists());
        assert_eq!(installs.settle("never-made", true), Err("not_found".into()));
        let _ = fs::remove_dir_all(home);
        let _ = fs::remove_dir_all(elsewhere);
    }

    /// A one-file row of src/runtime/skillActs.cases.json as a skill named `x`: the file, beside a plain SKILL.md when it is not
    /// SKILL.md itself.
    fn case_skill(path: &str, text: &str) -> Skill {
        if path == SKILL_FILE {
            skill("x", vec![file(path, text)])
        } else {
            skill("x", vec![file(SKILL_FILE, "Plain instructions."), file(path, text)])
        }
    }

    #[test]
    fn an_install_refuses_a_skill_the_agent_would_act_on_by_itself_naming_the_file_and_the_field() {
        // src/runtime/skillActs.cases.json: the same table the page (skillBundle.test.ts) runs
        let v: serde_json::Value = serde_json::from_str(include_str!("../../src/runtime/skillActs.cases.json")).unwrap();
        let cases = v["cases"].as_array().unwrap();
        assert!(cases.len() > 60);
        let home = temp("acts");
        let root = home.join(".claude/skills");
        let installs = Installs::default();
        for c in cases {
            let [path, text, why, field] = [0, 1, 2, 3].map(|i| c[i].as_str().unwrap());
            let read = installs.keep_read(Bundle { title: "t".into(), skills: vec![case_skill(path, text)] });
            let asked = installs.ask(&home, "claude", &root, &read, &["x".into()]);
            if why.is_empty() {
                assert!(asked.is_ok(), "{c} {asked:?}");
                installs.withdraw(&asked.unwrap().id);
            } else {
                let want = if why == "field" { format!("acts_alone:field:x/{path}:{field}") } else { format!("acts_alone:{why}:x/{path}") };
                assert_eq!(asked.map(|a| a.id), Err(want), "{c}");
            }
        }
        // nothing was written for any of them
        assert!(!root.exists());
        // the reader itself answers each row as the page's twin does
        for c in cases {
            let [path, text, why, field] = [0, 1, 2, 3].map(|i| c[i].as_str().unwrap());
            let got = file_acts_alone(path, text).map(|a| (a.why.to_string(), a.field));
            assert_eq!(got, (!why.is_empty()).then(|| (why.to_string(), field.to_string())), "{c}");
        }
        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn a_settled_yes_checks_again_before_writing_and_writes_nothing_for_a_skill_that_acts_alone() {
        let home = temp("acts-again");
        let root = home.join(".claude/skills");
        let plan = Plan {
            root: root.clone(),
            skills: vec![skill("plain", vec![file("SKILL.md", "Count.")]), case_skill("SKILL.md", "---\nhooks:\n  Stop: []\n---\n")],
        };
        assert_eq!(install(Settled(()), &plan), Err("acts_alone:field:x/SKILL.md:hooks".into()));
        // the check comes before anything is written, so not even the plain skill before it is
        assert!(!root.exists());
        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn an_install_refuses_a_path_out_of_the_skill_and_a_dot_file_even_from_a_kept_read() {
        let home = temp("paths");
        let root = home.join(".claude/skills");
        let installs = Installs::default();
        for (bad, why) in [("../../escape.sh", "bad_bundle:bad_path"), ("/tmp/abs.sh", "bad_bundle:bad_path"), (".env", "bad_bundle:dot_file")] {
            let read = installs.keep_read(Bundle { title: "t".into(), skills: vec![skill("x", vec![file("SKILL.md", "x"), file(bad, "x")])] });
            assert_eq!(installs.ask(&home, "claude", &root, &read, &["x".into()]), Err(why.into()), "{bad}");
        }
        assert!(!root.exists());
        assert!(!home.join("escape.sh").exists());
        let read = installs.keep_read(bundle());
        assert_eq!(installs.ask(&home, "claude", &root, &read, &["missing".into()]), Err("no_skills".into()));
        assert_eq!(installs.ask(&home, "claude", &root, "nope", &["stock".into()]), Err("not_found".into()));
        let _ = fs::remove_dir_all(home);
    }
}
