//! What was used in a coding tool's sessions outside Manut AI (item 106), read from the tool's own files on this Mac.
//!
//! Where the numbers come from (looked at on a real Mac, field names only):
//! * Claude Code, `<claude home>/projects/<folder slug>/<session id>.jsonl`, and a session's sub-agents at
//!   `<session id>/subagents/**/agent-*.jsonl`. Each `assistant` line carries `timestamp`, `cwd`, `entrypoint` and
//!   `message.{id, usage}`, where `usage` has `input_tokens`, `output_tokens`, `cache_read_input_tokens` and
//!   `cache_creation_input_tokens`. One answer is written several times (the same `message.id`, three or four lines
//!   with the same numbers), so a line counts once per `message.id`, the largest `output_tokens` winning.
//! * Codex, `<codex home>/sessions/YYYY/MM/DD/rollout-*.jsonl`: the first line is `session_meta` (`payload.{id, cwd,
//!   originator}`), and `event_msg` / `token_count` lines carry a running `info.total_token_usage` (`input_tokens`,
//!   `cached_input_tokens`, `cache_write_input_tokens`, `output_tokens`). What a line adds is its total minus the
//!   total before it. Codex's `input_tokens` includes the cached ones (`total_tokens` is input plus output), so the
//!   scan keeps the cached part apart. Rollouts that Codex wrote as `.jsonl.zst` are not read (no decompressor is in
//!   the app); they are counted as skipped, compressed.
//!
//! What leaves a scan: dates, token counts and a project folder's NAME (the last part of a `cwd`), never a path above
//! the name, a message, or a key. A link, a file over the size cap and a file that is not JSON lines are skipped and
//! counted. Nothing is ever written into a tool's folder. The page names a tool, never a path: the folders read are
//! the tool's own home, and the account homes Manut AI made under `~/.manut/accounts/<tool>/` ([`homes_for`]).
//!
//! What it cannot tell apart: a Claude Code session Manut AI started is known by its id (the page sends the ids its
//! session rows hold) and by `entrypoint: "sdk-cli"` (how `claude -p` writes itself, which is how a Manut AI chat
//! runs Claude Code; a person's own `claude -p` script is left out with it); a Codex session by
//! `originator: "manut"` (the `clientInfo.name` Manut AI initializes with) or its id. A Manut AI session whose row
//! was closed long ago and which Claude Code wrote as an interactive terminal session carries nothing that says so.
//!
//! Bounds ([`Limits`]): files newest first, only those changed in the window, at most `files` files and `total_bytes`
//! bytes actually read a scan; a file's result is cached by its size and modified time, so the next scan reads only
//! what changed. The scan runs off the main thread and stops between files when cancelled.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs::File;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::UNIX_EPOCH;

use serde::Serialize;
use serde_json::Value;

/// Days kept, today included.
pub const DAYS: i64 = 30;
/// Events are summed in quarter hours, so a day boundary can be drawn in any zone (every zone's offset is a multiple of
/// 15 minutes) without reading the file again when the zone changes.
const BUCKET: i64 = 900;
/// Characters of a project folder's name.
const NAME_MAX: usize = 80;
/// Entries a cache keeps.
const CACHE_MAX: usize = 4_000;

#[derive(Clone, Copy, Debug)]
pub struct Limits {
    /// Files looked at a scan, newest first.
    pub files: usize,
    /// Bytes read a scan (a cached file reads none).
    pub total_bytes: u64,
    /// A file over this is skipped, not read.
    pub file_bytes: u64,
    /// Directory entries visited a scan.
    pub walk: usize,
}

impl Default for Limits {
    fn default() -> Self {
        Limits { files: 300, total_bytes: 256 * 1024 * 1024, file_bytes: 32 * 1024 * 1024, walk: 50_000 }
    }
}

#[derive(Default, Clone, Copy, Debug, PartialEq, Serialize)]
pub struct Tokens {
    pub input: u64,
    pub output: u64,
    pub cache_read: u64,
    pub cache_write: u64,
}

impl Tokens {
    pub fn total(&self) -> u64 {
        self.input.saturating_add(self.output).saturating_add(self.cache_read).saturating_add(self.cache_write)
    }
    fn add(&mut self, o: &Tokens) {
        self.input = self.input.saturating_add(o.input);
        self.output = self.output.saturating_add(o.output);
        self.cache_read = self.cache_read.saturating_add(o.cache_read);
        self.cache_write = self.cache_write.saturating_add(o.cache_write);
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
enum Skip {
    Link,
    NotJson,
}

/// What one file holds once read: who it belongs to, and its tokens per quarter hour.
#[derive(Clone, Debug)]
struct FileUse {
    session: String,
    app_started: bool,
    project: String,
    buckets: BTreeMap<i64, Tokens>,
}

type Parsed = Result<FileUse, Skip>;

/// Results by file, valid while a file's size and modified time (ns) are the same.
#[derive(Default)]
pub struct Cache {
    map: HashMap<PathBuf, (u64, u128, Parsed)>,
}

impl Cache {
    #[cfg(test)]
    pub fn len(&self) -> usize {
        self.map.len()
    }
}

#[derive(Default, Clone, Debug, PartialEq, Serialize)]
pub struct Skipped {
    pub links: u32,
    pub too_big: u32,
    pub not_json: u32,
    pub compressed: u32,
    /// Sessions Manut AI started (it counts those itself).
    pub app_started: u32,
    /// Files past the file or byte bound, not looked at.
    pub over_limit: u32,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct DayRow {
    /// `YYYY-MM-DD` in this Mac's time zone.
    pub day: String,
    /// The project folder's name; empty when the file named none.
    pub project: String,
    #[serde(flatten)]
    pub tokens: Tokens,
    pub total: u64,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Report {
    pub tool: String,
    pub rows: Vec<DayRow>,
    pub today: u64,
    pub week: u64,
    /// Seconds since the epoch.
    pub read_at: f64,
    pub files_read: u32,
    pub files_cached: u32,
    pub skipped: Skipped,
    /// A bound or a cancel stopped the scan before every file was looked at.
    pub partial: bool,
}

pub struct Opts<'a> {
    /// Seconds since the epoch.
    pub now: i64,
    /// Seconds the Mac's clock is ahead of UTC at a moment.
    pub offset: &'a dyn Fn(i64) -> i64,
    /// Session ids Manut AI started.
    pub exclude: &'a HashSet<String>,
    pub limits: Limits,
    pub cancel: &'a AtomicBool,
}

/// The offset of this Mac's time zone at `ts`.
#[cfg(unix)]
pub fn system_offset(ts: i64) -> i64 {
    // SAFETY: localtime_r writes only into the zeroed `tm` it is given.
    unsafe {
        let t = ts as libc::time_t;
        let mut tm: libc::tm = std::mem::zeroed();
        if libc::localtime_r(&t, &mut tm).is_null() {
            0
        } else {
            tm.tm_gmtoff as i64
        }
    }
}

/// Windows has no `localtime_r` here: days are UTC days there.
#[cfg(not(unix))]
pub fn system_offset(_ts: i64) -> i64 {
    0
}

/// `YYYY-MM-DD` of the day number `days` since 1970-01-01.
fn day_string(days: i64) -> String {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + if m <= 2 { 1 } else { 0 };
    format!("{y:04}-{m:02}-{d:02}")
}

/// The local day number of a moment.
fn local_day(ts: i64, offset: &dyn Fn(i64) -> i64) -> i64 {
    (ts + offset(ts)).div_euclid(86_400)
}

/// The last part of a folder path, which is all that leaves a scan.
pub fn project_name(cwd: &str) -> String {
    let last = cwd.trim_end_matches(['/', '\\']).rsplit(['/', '\\']).next().unwrap_or("");
    last.chars().filter(|c| !c.is_control()).take(NAME_MAX).collect()
}

fn num(v: Option<&Value>) -> u64 {
    match v {
        Some(Value::Number(n)) => n.as_u64().or_else(|| n.as_f64().filter(|f| *f >= 0.0).map(|f| f as u64)).unwrap_or(0),
        _ => 0,
    }
}

fn is_text(line: &[u8], needle: &str) -> bool {
    let n = needle.as_bytes();
    line.windows(n.len()).any(|w| w == n)
}

/// A line that is cheap to accept as JSON without parsing it (the long lines no number is on).
fn looks_json(line: &[u8]) -> bool {
    let t = line.trim_ascii();
    t.first() == Some(&b'{') && t.last() == Some(&b'}')
}

/// Whether the file read as JSON lines: its first line parsed, and more lines were good than bad.
fn json_lines(first_ok: bool, good: u32, bad: u32) -> bool {
    first_ok && good > bad
}

fn mtime_ns(meta: &std::fs::Metadata) -> u128 {
    meta.modified().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map(|d| d.as_nanos()).unwrap_or(0)
}

fn secs(ts: &Value) -> Option<i64> {
    ts.as_str().and_then(crate::past_chats::iso_secs).map(|f| f.floor() as i64)
}

/// Claude Code's file: usage per answer, by quarter hour.
fn parse_claude(path: &Path, session: String) -> Parsed {
    let Ok(f) = File::open(path) else { return Err(Skip::NotJson) };
    let mut r = BufReader::new(f);
    let (mut buf, mut first, mut first_ok, mut good, mut bad) = (Vec::new(), true, false, 0u32, 0u32);
    let mut project = String::new();
    let mut app = false;
    let mut seen_assistant = false;
    // one answer per message id: its quarter hour and the largest numbers any of its lines had
    let mut by_id: HashMap<String, (i64, Tokens)> = HashMap::new();
    let mut loose: Vec<(i64, Tokens)> = Vec::new();
    loop {
        buf.clear();
        match r.read_until(b'\n', &mut buf) {
            Ok(0) | Err(_) => break,
            Ok(_) => {}
        }
        let line = buf.trim_ascii();
        if line.is_empty() {
            continue;
        }
        let candidate = first || (is_text(line, "\"usage\"") && is_text(line, "\"assistant\""));
        if !candidate {
            if looks_json(line) {
                good += 1;
            } else {
                bad += 1;
            }
            continue;
        }
        let Ok(v) = serde_json::from_slice::<Value>(line) else {
            bad += 1;
            first = false;
            continue;
        };
        good += 1;
        if first {
            first_ok = true;
            first = false;
        }
        if v.get("type").and_then(Value::as_str) != Some("assistant") {
            continue;
        }
        if !seen_assistant {
            seen_assistant = true;
            app = v.get("entrypoint").and_then(Value::as_str) == Some("sdk-cli");
        }
        if project.is_empty() {
            project = project_name(v.get("cwd").and_then(Value::as_str).unwrap_or(""));
        }
        let Some(msg) = v.get("message") else { continue };
        let Some(u) = msg.get("usage").filter(|u| u.is_object()) else { continue };
        let Some(ts) = v.get("timestamp").and_then(secs) else { continue };
        let t = Tokens {
            input: num(u.get("input_tokens")),
            output: num(u.get("output_tokens")),
            cache_read: num(u.get("cache_read_input_tokens")),
            cache_write: num(u.get("cache_creation_input_tokens")),
        };
        let b = ts.div_euclid(BUCKET);
        match msg.get("id").and_then(Value::as_str).filter(|i| !i.is_empty()) {
            Some(id) => {
                let key = format!("{id}/{}", v.get("requestId").and_then(Value::as_str).unwrap_or(""));
                let e = by_id.entry(key).or_insert((b, t));
                if t.output > e.1.output {
                    e.1 = t;
                }
            }
            None => loose.push((b, t)),
        }
    }
    if !json_lines(first_ok, good, bad) {
        return Err(Skip::NotJson);
    }
    let mut buckets: BTreeMap<i64, Tokens> = BTreeMap::new();
    for (b, t) in by_id.into_values().chain(loose) {
        buckets.entry(b).or_default().add(&t);
    }
    Ok(FileUse { session, app_started: app, project, buckets })
}

fn codex_totals(t: &Value) -> Tokens {
    let cached = num(t.get("cached_input_tokens"));
    Tokens {
        // `input_tokens` holds the cached ones too: keep them apart so the four add up to what was used
        input: num(t.get("input_tokens")).saturating_sub(cached),
        output: num(t.get("output_tokens")),
        cache_read: cached,
        cache_write: num(t.get("cache_write_input_tokens")),
    }
}

/// Codex's rollout: the growth of its running total, by quarter hour.
fn parse_codex(path: &Path, id_from_name: String) -> Parsed {
    let Ok(f) = File::open(path) else { return Err(Skip::NotJson) };
    let mut r = BufReader::new(f);
    let (mut buf, mut first, mut first_ok, mut good, mut bad) = (Vec::new(), true, false, 0u32, 0u32);
    let (mut project, mut session, mut app) = (String::new(), id_from_name, false);
    let mut buckets: BTreeMap<i64, Tokens> = BTreeMap::new();
    let mut prev: Option<Tokens> = None;
    loop {
        buf.clear();
        match r.read_until(b'\n', &mut buf) {
            Ok(0) | Err(_) => break,
            Ok(_) => {}
        }
        let line = buf.trim_ascii();
        if line.is_empty() {
            continue;
        }
        let candidate = first || is_text(line, "token_count");
        if !candidate {
            if looks_json(line) {
                good += 1;
            } else {
                bad += 1;
            }
            continue;
        }
        let Ok(v) = serde_json::from_slice::<Value>(line) else {
            bad += 1;
            first = false;
            continue;
        };
        good += 1;
        let p = v.get("payload");
        if first {
            first = false;
            first_ok = true;
            if v.get("type").and_then(Value::as_str) == Some("session_meta") {
                if let Some(p) = p {
                    project = project_name(p.get("cwd").and_then(Value::as_str).unwrap_or(""));
                    app = p.get("originator").and_then(Value::as_str) == Some("manut");
                    if let Some(id) = p.get("id").and_then(Value::as_str).filter(|i| !i.is_empty()) {
                        session = id.to_string();
                    }
                }
            }
            continue;
        }
        let Some(p) = p.filter(|p| p.get("type").and_then(Value::as_str) == Some("token_count")) else { continue };
        let Some(total) = p.get("info").and_then(|i| i.get("total_token_usage")).filter(|t| t.is_object()) else { continue };
        let Some(ts) = v.get("timestamp").and_then(secs) else { continue };
        let cur = codex_totals(total);
        // a total that went down (a restarted counter) starts over from what it now says
        let delta = match prev {
            Some(q) if cur.input >= q.input && cur.output >= q.output && cur.cache_read >= q.cache_read && cur.cache_write >= q.cache_write => Tokens {
                input: cur.input - q.input,
                output: cur.output - q.output,
                cache_read: cur.cache_read - q.cache_read,
                cache_write: cur.cache_write - q.cache_write,
            },
            _ => cur,
        };
        prev = Some(cur);
        if delta.total() > 0 {
            buckets.entry(ts.div_euclid(BUCKET)).or_default().add(&delta);
        }
    }
    if !json_lines(first_ok, good, bad) {
        return Err(Skip::NotJson);
    }
    Ok(FileUse { session, app_started: app, project, buckets })
}

#[derive(Clone, Debug)]
struct Candidate {
    path: PathBuf,
    session: String,
    size: u64,
    mtime: u128,
    compressed: bool,
}

/// Files of a tool's home that could hold the window, newest first, and the links met on the way (never followed).
struct Walk {
    files: Vec<Candidate>,
    links: u32,
    cut: bool,
}

fn uuid_tail(name: &str) -> String {
    let stem = name.strip_suffix(".zst").unwrap_or(name);
    let stem = stem.strip_suffix(".jsonl").unwrap_or(stem);
    stem.len().checked_sub(36).and_then(|i| stem.get(i..)).filter(|s| crate::sessions::is_uuid(s)).unwrap_or("").to_string()
}

/// `level`: for Claude Code 0 is `projects`, 1 a folder slug, 2 a session's own folder (only its `subagents` is entered), 3
/// and deeper inside `subagents`; Codex's date folders are walked to `max` levels whatever they are called.
#[derive(Clone, Copy)]
struct At<'a> {
    tool: &'a str,
    level: u32,
    max: u32,
    session: &'a str,
    floor_ns: u128,
}

fn walk_dir(dir: &Path, at: &At, budget: &mut usize, out: &mut Walk) {
    let Ok(rd) = std::fs::read_dir(dir) else { return };
    for e in rd.flatten() {
        if *budget == 0 {
            out.cut = true;
            return;
        }
        *budget -= 1;
        let path = e.path();
        let Ok(meta) = std::fs::symlink_metadata(&path) else { continue };
        let name = e.file_name().to_string_lossy().into_owned();
        if meta.file_type().is_symlink() {
            // a link anywhere under the tool's folder is refused, not followed
            out.links += 1;
            continue;
        }
        let claude = at.tool == "claude";
        if meta.is_dir() {
            if at.level + 1 >= at.max || (claude && at.level == 2 && name != "subagents") {
                continue;
            }
            let session = if claude && at.level == 1 { name.as_str() } else { at.session };
            walk_dir(&path, &At { level: at.level + 1, session, ..*at }, budget, out);
            continue;
        }
        if !meta.is_file() {
            continue;
        }
        let compressed = name.ends_with(".jsonl.zst");
        let wanted = if claude { name.ends_with(".jsonl") && at.level != 2 && at.level != 0 } else { name.starts_with("rollout-") && (name.ends_with(".jsonl") || compressed) };
        let mt = mtime_ns(&meta);
        if !wanted || mt < at.floor_ns {
            continue;
        }
        let session = if claude && at.level == 1 { name.trim_end_matches(".jsonl").to_string() } else if claude { at.session.to_string() } else { uuid_tail(&name) };
        out.files.push(Candidate { path, session, size: meta.len(), mtime: mt, compressed });
    }
}

/// The folders a tool keeps its transcripts under, relative to its home.
fn roots(tool: &str) -> Option<(&'static str, u32)> {
    match tool {
        "claude" => Some(("projects", 6)),
        "codex" => Some(("sessions", 4)),
        _ => None,
    }
}

pub fn supported(tool: &str) -> bool {
    roots(tool).is_some()
}

fn collect(home: &Path, tool: &str, floor_ns: u128, limits: &Limits) -> Walk {
    let mut out = Walk { files: Vec::new(), links: 0, cut: false };
    let Some((dir, depth)) = roots(tool) else { return out };
    let root = home.join(dir);
    match std::fs::symlink_metadata(&root) {
        Ok(m) if m.is_dir() && !m.file_type().is_symlink() => {}
        Ok(m) if m.file_type().is_symlink() => {
            out.links += 1;
            return out;
        }
        _ => return out,
    }
    let mut budget = limits.walk;
    walk_dir(&root, &At { tool, level: 0, max: depth, session: "", floor_ns }, &mut budget, &mut out);
    out.files.sort_by(|a, b| b.mtime.cmp(&a.mtime).then_with(|| a.path.cmp(&b.path)));
    out
}

/// A tool's homes to read: the home a new session uses (`primary`, found as past chats find it), the account homes Manut AI
/// made for it, each only when it is a real folder inside the person's own home folder. Another user's folder, or any
/// other path, is never read, however a variable names it.
pub fn homes_for(user_home: &Path, tool: &str, primary: Option<PathBuf>) -> Vec<PathBuf> {
    let Some(base) = user_home.canonicalize().ok() else { return Vec::new() };
    let mut out: Vec<PathBuf> = Vec::new();
    let mut add = |p: PathBuf| {
        let Ok(meta) = std::fs::symlink_metadata(&p) else { return };
        if meta.file_type().is_symlink() || !meta.is_dir() {
            return;
        }
        let Ok(real) = p.canonicalize() else { return };
        if real.starts_with(&base) && !out.contains(&real) {
            out.push(real);
        }
    };
    if let Some(p) = primary {
        add(p);
    }
    add(user_home.join(if tool == "claude" { ".claude" } else { ".codex" }));
    if let Ok(rd) = std::fs::read_dir(user_home.join(".manut").join("accounts").join(tool)) {
        let mut names: Vec<String> = rd.flatten().filter_map(|e| e.file_name().into_string().ok()).filter(|n| crate::accounts::valid_account_id(n)).collect();
        names.sort();
        for n in names {
            add(user_home.join(".manut").join("accounts").join(tool).join(n));
        }
    }
    out
}

/// Read one or more homes of `tool` and sum them (see the module doc).
pub fn scan(tool: &str, homes: &[PathBuf], o: &Opts, cache: &mut Cache) -> Report {
    let mut skipped = Skipped::default();
    let (mut files_read, mut files_cached, mut partial) = (0u32, 0u32, false);
    let today = local_day(o.now, o.offset);
    let first_day = today - (DAYS - 1);
    // a file untouched since before the window began cannot hold a day inside it (one day of slack for the zone)
    let floor_ns = ((first_day - 1) * 86_400).max(0) as u128 * 1_000_000_000;
    let mut cands: Vec<Candidate> = Vec::new();
    for h in homes {
        let w = collect(h, tool, floor_ns, &o.limits);
        skipped.links += w.links;
        partial |= w.cut;
        cands.extend(w.files);
    }
    cands.sort_by(|a, b| b.mtime.cmp(&a.mtime).then_with(|| a.path.cmp(&b.path)));
    let mut sums: BTreeMap<(i64, String), Tokens> = BTreeMap::new();
    let mut bytes = 0u64;
    let mut live: HashSet<PathBuf> = HashSet::new();
    for (i, c) in cands.iter().enumerate() {
        if o.cancel.load(Ordering::Relaxed) {
            partial = true;
            break;
        }
        if i >= o.limits.files {
            skipped.over_limit += (cands.len() - i) as u32;
            partial = true;
            break;
        }
        live.insert(c.path.clone());
        if c.compressed {
            skipped.compressed += 1;
            continue;
        }
        if c.size > o.limits.file_bytes {
            skipped.too_big += 1;
            continue;
        }
        let hit = cache.map.get(&c.path).filter(|(s, m, _)| *s == c.size && *m == c.mtime).map(|(_, _, p)| p.clone());
        let parsed = match hit {
            Some(p) => {
                files_cached += 1;
                p
            }
            None => {
                if bytes.saturating_add(c.size) > o.limits.total_bytes {
                    skipped.over_limit += 1;
                    partial = true;
                    continue;
                }
                bytes += c.size;
                files_read += 1;
                // the file is opened only now, after a last look that it is still a plain file (not swapped for a link)
                let p = match std::fs::symlink_metadata(&c.path) {
                    Ok(m) if m.is_file() && !m.file_type().is_symlink() => match tool {
                        "claude" => parse_claude(&c.path, c.session.clone()),
                        _ => parse_codex(&c.path, c.session.clone()),
                    },
                    _ => Err(Skip::Link),
                };
                cache.map.insert(c.path.clone(), (c.size, c.mtime, p.clone()));
                p
            }
        };
        match parsed {
            Err(Skip::Link) => skipped.links += 1,
            Err(Skip::NotJson) => skipped.not_json += 1,
            Ok(fu) => {
                if fu.app_started || o.exclude.contains(&fu.session) || o.exclude.contains(&c.session) {
                    skipped.app_started += 1;
                    continue;
                }
                for (b, t) in &fu.buckets {
                    let d = local_day(b * BUCKET, o.offset);
                    if d >= first_day && d <= today {
                        sums.entry((d, fu.project.clone())).or_default().add(t);
                    }
                }
            }
        }
    }
    if !partial {
        cache.map.retain(|p, _| live.contains(p));
    }
    if cache.map.len() > CACHE_MAX {
        cache.map.clear();
    }
    let mut rows: Vec<DayRow> = sums
        .into_iter()
        .map(|((d, project), tokens)| DayRow { day: day_string(d), project, total: tokens.total(), tokens })
        .collect();
    rows.sort_by(|a, b| b.day.cmp(&a.day).then(b.total.cmp(&a.total)).then_with(|| a.project.cmp(&b.project)));
    let day_total = |lo: i64| -> u64 {
        let (lo_s, hi_s) = (day_string(lo), day_string(today));
        rows.iter().filter(|r| r.day >= lo_s && r.day <= hi_s).map(|r| r.total).fold(0u64, |a, b| a.saturating_add(b))
    };
    let (today_total, week_total) = (day_total(today), day_total(today - 6));
    Report {
        tool: tool.to_string(),
        rows,
        today: today_total,
        week: week_total,
        read_at: o.now as f64,
        files_read,
        files_cached,
        skipped,
        partial,
    }
}

/// The cache the app's command shares between looks.
pub fn shared_cache() -> &'static Mutex<Cache> {
    static C: OnceLock<Mutex<Cache>> = OnceLock::new();
    C.get_or_init(|| Mutex::new(Cache::default()))
}

fn flags() -> &'static Mutex<HashMap<u32, Arc<AtomicBool>>> {
    static F: OnceLock<Mutex<HashMap<u32, Arc<AtomicBool>>>> = OnceLock::new();
    F.get_or_init(|| Mutex::new(HashMap::new()))
}

/// A scan the page can cancel by its id (the page closing).
pub fn register(id: u32) -> Arc<AtomicBool> {
    let f = Arc::new(AtomicBool::new(false));
    if let Ok(mut m) = flags().lock() {
        m.insert(id, f.clone());
    }
    f
}

pub fn finish(id: u32) {
    if let Ok(mut m) = flags().lock() {
        m.remove(&id);
    }
}

pub fn cancel(id: u32) {
    if let Ok(m) = flags().lock() {
        if let Some(f) = m.get(&id) {
            f.store(true, Ordering::Relaxed);
        }
    }
}

/// `ids` kept only when they look like a session id (a UUID, or a Codex / OmO `session-<uuid>`): they are matched
/// against file names, never opened as paths.
pub fn clean_ids(ids: Vec<String>) -> HashSet<String> {
    ids.into_iter().filter(|i| i.len() <= 80 && i.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')).take(5_000).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    struct Tmp(PathBuf);
    impl Tmp {
        fn new(tag: &str) -> Tmp {
            static N: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
            let p = std::env::temp_dir().join(format!("manut-outside-{tag}-{}-{}", std::process::id(), N.fetch_add(1, Ordering::Relaxed)));
            std::fs::create_dir_all(&p).unwrap();
            Tmp(p)
        }
    }
    impl Drop for Tmp {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    // 2026-11-20 12:00:00 UTC
    const NOW: i64 = 1_795_176_000;
    const SID: &str = "11111111-2222-4333-8444-555555555555";
    const SID2: &str = "99999999-2222-4333-8444-555555555555";

    fn utc(_: i64) -> i64 {
        0
    }
    fn plus7(_: i64) -> i64 {
        7 * 3600
    }

    fn iso(ts: i64) -> String {
        let (d, s) = (ts.div_euclid(86_400), ts.rem_euclid(86_400));
        format!("{}T{:02}:{:02}:{:02}.000Z", day_string(d), s / 3600, s % 3600 / 60, s % 60)
    }

    fn write(path: &Path, lines: &[String]) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        let mut f = File::create(path).unwrap();
        for l in lines {
            writeln!(f, "{l}").unwrap();
        }
        f.set_modified(std::time::UNIX_EPOCH + std::time::Duration::from_secs(NOW as u64)).unwrap();
    }

    fn claude_line(ts: i64, id: &str, inp: u64, out: u64, cr: u64, cw: u64, cwd: &str, entry: &str) -> String {
        serde_json::json!({
            "type": "assistant", "timestamp": iso(ts), "cwd": cwd, "entrypoint": entry, "sessionId": SID,
            "message": {"id": id, "role": "assistant", "usage": {"input_tokens": inp, "output_tokens": out, "cache_read_input_tokens": cr, "cache_creation_input_tokens": cw, "service_tier": "standard"}}
        })
        .to_string()
    }

    fn opts<'a>(exclude: &'a HashSet<String>, cancel: &'a AtomicBool, offset: &'a dyn Fn(i64) -> i64) -> Opts<'a> {
        Opts { now: NOW, offset, exclude, limits: Limits::default(), cancel }
    }

    fn run(tool: &str, home: &Path, exclude: &HashSet<String>, offset: &dyn Fn(i64) -> i64, cache: &mut Cache) -> Report {
        let cancel = AtomicBool::new(false);
        scan(tool, &[home.to_path_buf()], &opts(exclude, &cancel, offset), cache)
    }

    #[test]
    fn day_strings_are_calendar_days() {
        assert_eq!(day_string(0), "1970-01-01");
        assert_eq!(day_string(local_day(NOW, &utc)), "2026-11-20");
        assert_eq!(day_string(19_782), "2024-02-29");
    }

    #[test]
    fn claude_usage_sums_every_field_per_day_and_project_name_only() {
        let t = Tmp::new("claude");
        let f = t.0.join("projects/-Users-someone-Developer-shop/").join(format!("{SID}.jsonl"));
        write(&f, &[
            claude_line(NOW - 100, "msg_a", 10, 20, 300, 40, "/Users/someone/Developer/shop", "cli"),
            claude_line(NOW - 90, "msg_b", 1, 2, 3, 4, "/Users/someone/Developer/shop", "cli"),
        ]);
        let r = run("claude", &t.0, &HashSet::new(), &utc, &mut Cache::default());
        assert_eq!(r.rows.len(), 1);
        let row = &r.rows[0];
        assert_eq!((row.day.as_str(), row.project.as_str()), ("2026-11-20", "shop"));
        assert_eq!(row.tokens, Tokens { input: 11, output: 22, cache_read: 303, cache_write: 44 });
        assert_eq!(row.total, 380);
        assert_eq!((r.today, r.week), (380, 380));
        // nothing but numbers, dates and the folder's name is in what leaves
        let json = serde_json::to_string(&r).unwrap();
        assert!(!json.contains("Users") && !json.contains("someone") && !json.contains("Developer"), "{json}");
    }

    #[test]
    fn claude_writes_one_answer_several_times_and_it_counts_once() {
        let t = Tmp::new("dupes");
        let f = t.0.join("projects/p").join(format!("{SID}.jsonl"));
        let l = claude_line(NOW, "msg_a", 2, 672, 0, 84_009, "/w/app", "cli");
        write(&f, &[l.clone(), l.clone(), claude_line(NOW, "msg_a", 2, 700, 0, 84_009, "/w/app", "cli"), l]);
        let r = run("claude", &t.0, &HashSet::new(), &utc, &mut Cache::default());
        assert_eq!(r.rows[0].tokens, Tokens { input: 2, output: 700, cache_read: 0, cache_write: 84_009 });
    }

    #[test]
    fn a_day_boundary_follows_the_macs_time_zone() {
        let t = Tmp::new("zone");
        // 20:00 UTC on the 19th is 03:00 on the 20th at +7
        let late = NOW - 16 * 3600;
        let f = t.0.join("projects/p").join(format!("{SID}.jsonl"));
        write(&f, &[claude_line(late, "m1", 0, 5, 0, 0, "/w/app", "cli"), claude_line(NOW - 3600, "m2", 0, 7, 0, 0, "/w/app", "cli")]);
        let utc_days: Vec<(String, u64)> = run("claude", &t.0, &HashSet::new(), &utc, &mut Cache::default()).rows.iter().map(|r| (r.day.clone(), r.total)).collect();
        assert_eq!(utc_days, vec![("2026-11-20".into(), 7), ("2026-11-19".into(), 5)]);
        let r = run("claude", &t.0, &HashSet::new(), &plus7, &mut Cache::default());
        let local: Vec<(String, u64)> = r.rows.iter().map(|r| (r.day.clone(), r.total)).collect();
        assert_eq!(local, vec![("2026-11-20".into(), 12)]);
        assert_eq!(r.today, 12);
    }

    #[test]
    fn days_outside_the_thirty_are_left_out_and_week_is_seven_days() {
        let t = Tmp::new("window");
        let f = t.0.join("projects/p").join(format!("{SID}.jsonl"));
        let d = |n: i64| NOW - n * 86_400;
        write(&f, &[
            claude_line(d(0), "a", 0, 1, 0, 0, "/w/x", "cli"),
            claude_line(d(6), "b", 0, 10, 0, 0, "/w/x", "cli"),
            claude_line(d(7), "c", 0, 100, 0, 0, "/w/x", "cli"),
            claude_line(d(29), "d", 0, 1000, 0, 0, "/w/x", "cli"),
            claude_line(d(30), "e", 0, 10_000, 0, 0, "/w/x", "cli"),
        ]);
        let r = run("claude", &t.0, &HashSet::new(), &utc, &mut Cache::default());
        assert_eq!(r.rows.len(), 4);
        assert_eq!((r.today, r.week), (1, 11));
    }

    #[test]
    fn sessions_manut_started_are_not_counted_again() {
        let t = Tmp::new("app");
        write(&t.0.join("projects/p").join(format!("{SID}.jsonl")), &[claude_line(NOW, "a", 0, 100, 0, 0, "/w/x", "cli")]);
        write(&t.0.join("projects/p").join(format!("{SID2}.jsonl")), &[claude_line(NOW, "b", 0, 10, 0, 0, "/w/x", "cli")]);
        write(&t.0.join("projects/p/chat.jsonl"), &[claude_line(NOW, "c", 0, 1000, 0, 0, "/w/x", "sdk-cli")]);
        // by id the page sent
        let ex: HashSet<String> = [SID.to_string()].into();
        let r = run("claude", &t.0, &ex, &utc, &mut Cache::default());
        assert_eq!((r.today, r.skipped.app_started), (10, 2));
        // a sub-agent file belongs to its session's id
        let t2 = Tmp::new("sub");
        write(&t2.0.join(format!("projects/p/{SID}/subagents/agent-ab.jsonl")), &[claude_line(NOW, "s", 0, 5, 0, 0, "/w/x", "cli")]);
        assert_eq!(run("claude", &t2.0, &HashSet::new(), &utc, &mut Cache::default()).today, 5);
        assert_eq!(run("claude", &t2.0, &ex, &utc, &mut Cache::default()).today, 0);
    }

    fn codex_meta(id: &str, originator: &str, cwd: &str) -> String {
        serde_json::json!({"timestamp": iso(NOW - 500), "type": "session_meta", "payload": {"id": id, "cwd": cwd, "originator": originator, "source": "cli"}}).to_string()
    }
    fn codex_count(ts: i64, inp: u64, cached: u64, out: u64) -> String {
        serde_json::json!({"timestamp": iso(ts), "type": "event_msg", "payload": {"type": "token_count", "info": {"total_token_usage": {
            "input_tokens": inp, "cached_input_tokens": cached, "cache_write_input_tokens": 0, "output_tokens": out, "reasoning_output_tokens": 0, "total_tokens": inp + out}}}})
        .to_string()
    }

    #[test]
    fn codex_usage_is_the_growth_of_its_running_total() {
        let t = Tmp::new("codex");
        let f = t.0.join("sessions/2026/11/20").join(format!("rollout-2026-11-20T12-00-00-{SID}.jsonl"));
        write(&f, &[
            codex_meta(SID, "codex-tui", "/Users/someone/Developer/shop"),
            codex_count(NOW - 300, 1000, 800, 50),
            codex_count(NOW - 300, 1000, 800, 50), // the same total again adds nothing
            codex_count(NOW - 200, 1500, 1200, 80),
        ]);
        let r = run("codex", &t.0, &HashSet::new(), &utc, &mut Cache::default());
        assert_eq!(r.rows.len(), 1);
        assert_eq!(r.rows[0].project, "shop");
        // input is what was not cached: (1500 - 1200), cache read 1200, output 80
        assert_eq!(r.rows[0].tokens, Tokens { input: 300, output: 80, cache_read: 1200, cache_write: 0 });
        assert!(!serde_json::to_string(&r).unwrap().contains("Users"));
    }

    #[test]
    fn codex_total_that_goes_down_starts_over_and_manut_sessions_are_skipped() {
        let t = Tmp::new("codex2");
        let dir = t.0.join("sessions/2026/11/20");
        write(&dir.join(format!("rollout-a-{SID}.jsonl")), &[codex_meta(SID, "codex-tui", "/w/a"), codex_count(NOW, 100, 0, 10), codex_count(NOW, 30, 0, 5)]);
        write(&dir.join(format!("rollout-b-{SID2}.jsonl")), &[codex_meta(SID2, "manut", "/w/a"), codex_count(NOW, 9999, 0, 9999)]);
        let r = run("codex", &t.0, &HashSet::new(), &utc, &mut Cache::default());
        assert_eq!(r.today, 110 + 35);
        assert_eq!(r.skipped.app_started, 1);
        // and by id, for a session the page knows
        let ex: HashSet<String> = [SID.to_string()].into();
        assert_eq!(run("codex", &t.0, &ex, &utc, &mut Cache::default()).today, 0);
    }

    #[test]
    fn a_compressed_rollout_is_counted_skipped_not_read() {
        let t = Tmp::new("zst");
        let p = t.0.join("sessions/2026/11/20").join(format!("rollout-z-{SID}.jsonl.zst"));
        write(&p, &["not readable".to_string()]);
        let r = run("codex", &t.0, &HashSet::new(), &utc, &mut Cache::default());
        assert_eq!((r.skipped.compressed, r.files_read, r.rows.len()), (1, 0, 0));
    }

    #[test]
    fn links_big_files_and_text_that_is_not_json_are_skipped_and_counted() {
        let t = Tmp::new("skip");
        let dir = t.0.join("projects/p");
        write(&dir.join(format!("{SID}.jsonl")), &[claude_line(NOW, "ok", 0, 3, 0, 0, "/w/x", "cli")]);
        write(&dir.join("junk.jsonl"), &["this is a note".into(), "and so is this".into()]);
        write(&dir.join("big.jsonl"), &[claude_line(NOW, "big", 0, 9, 0, 0, "/w/x", "cli")]);
        let outside = Tmp::new("outside");
        write(&outside.0.join("secret.jsonl"), &[claude_line(NOW, "secret", 0, 999, 0, 0, "/w/x", "cli")]);
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(outside.0.join("secret.jsonl"), dir.join("link.jsonl")).unwrap();
            std::os::unix::fs::symlink(&outside.0, t.0.join("projects/dirlink")).unwrap();
        }
        let cancel = AtomicBool::new(false);
        let ex = HashSet::new();
        let mut o = opts(&ex, &cancel, &utc);
        o.limits.file_bytes = std::fs::metadata(dir.join("big.jsonl")).unwrap().len() - 1;
        let r = scan("claude", &[t.0.clone()], &o, &mut Cache::default());
        assert_eq!(r.today, 3);
        assert_eq!((r.skipped.not_json, r.skipped.too_big), (1, 1));
        #[cfg(unix)]
        assert_eq!(r.skipped.links, 2);
    }

    #[test]
    fn the_bounds_stop_a_scan_newest_first_and_say_so() {
        let t = Tmp::new("bounds");
        let dir = t.0.join("projects/p");
        for (i, name) in ["a", "b", "c"].iter().enumerate() {
            let p = dir.join(format!("{name}.jsonl"));
            write(&p, &[claude_line(NOW, name, 0, 10 * (i as u64 + 1), 0, 0, "/w/x", "cli")]);
            // c is the newest, then b, then a
            File::options().write(true).open(&p).unwrap().set_modified(std::time::UNIX_EPOCH + std::time::Duration::from_secs(NOW as u64 - 100 + i as u64)).unwrap();
        }
        let cancel = AtomicBool::new(false);
        let ex = HashSet::new();
        let mut o = opts(&ex, &cancel, &utc);
        o.limits.files = 2;
        let r = scan("claude", &[t.0.clone()], &o, &mut Cache::default());
        assert_eq!((r.today, r.skipped.over_limit, r.partial), (30 + 20, 1, true));
        // a byte bound keeps the newest and leaves the rest
        let mut o = opts(&ex, &cancel, &utc);
        o.limits.total_bytes = std::fs::metadata(dir.join("c.jsonl")).unwrap().len();
        let r = scan("claude", &[t.0.clone()], &o, &mut Cache::default());
        assert_eq!((r.today, r.skipped.over_limit, r.partial), (30, 2, true));
        // the walk is bounded too
        let mut o = opts(&ex, &cancel, &utc);
        o.limits.walk = 2;
        assert!(scan("claude", &[t.0.clone()], &o, &mut Cache::default()).partial);
    }

    #[test]
    fn a_cancelled_scan_stops_before_reading() {
        let t = Tmp::new("cancel");
        write(&t.0.join("projects/p/a.jsonl"), &[claude_line(NOW, "a", 0, 3, 0, 0, "/w/x", "cli")]);
        let cancel = AtomicBool::new(true);
        let ex = HashSet::new();
        let r = scan("claude", &[t.0.clone()], &opts(&ex, &cancel, &utc), &mut Cache::default());
        assert_eq!((r.files_read, r.partial, r.today), (0, true, 0));
        // and by its registered id
        let flag = register(4_242);
        cancel_id(4_242);
        assert!(flag.load(Ordering::Relaxed));
        finish(4_242);
    }

    fn cancel_id(id: u32) {
        cancel(id)
    }

    #[test]
    fn a_second_look_reads_only_what_changed() {
        let t = Tmp::new("cache");
        let a = t.0.join("projects/p/a.jsonl");
        let b = t.0.join("projects/p/b.jsonl");
        write(&a, &[claude_line(NOW, "a", 0, 3, 0, 0, "/w/x", "cli")]);
        write(&b, &[claude_line(NOW, "b", 0, 4, 0, 0, "/w/x", "cli")]);
        let mut cache = Cache::default();
        let first = run("claude", &t.0, &HashSet::new(), &utc, &mut cache);
        assert_eq!((first.files_read, first.files_cached, first.today), (2, 0, 7));
        let second = run("claude", &t.0, &HashSet::new(), &utc, &mut cache);
        assert_eq!((second.files_read, second.files_cached, second.today), (0, 2, 7));
        // one file grows: only it is read again
        let mut f = std::fs::OpenOptions::new().append(true).open(&b).unwrap();
        writeln!(f, "{}", claude_line(NOW, "b2", 0, 6, 0, 0, "/w/x", "cli")).unwrap();
        drop(f);
        File::options().write(true).open(&b).unwrap().set_modified(std::time::UNIX_EPOCH + std::time::Duration::from_secs(NOW as u64 + 5)).unwrap();
        let third = run("claude", &t.0, &HashSet::new(), &utc, &mut cache);
        assert_eq!((third.files_read, third.files_cached, third.today), (1, 1, 13));
        // a file that is gone leaves the cache
        std::fs::remove_file(&a).unwrap();
        run("claude", &t.0, &HashSet::new(), &utc, &mut cache);
        assert_eq!(cache.len(), 1);
    }

    #[test]
    fn nothing_is_written_into_the_tools_folder() {
        let t = Tmp::new("ro");
        write(&t.0.join("projects/p/a.jsonl"), &[claude_line(NOW, "a", 0, 3, 0, 0, "/w/x", "cli")]);
        let names = |d: &Path| -> Vec<(String, u64)> {
            let mut v: Vec<(String, u64)> = Vec::new();
            fn go(d: &Path, v: &mut Vec<(String, u64)>) {
                for e in std::fs::read_dir(d).unwrap().flatten() {
                    let m = e.metadata().unwrap();
                    v.push((e.path().to_string_lossy().into_owned(), m.len()));
                    if m.is_dir() {
                        go(&e.path(), v);
                    }
                }
            }
            go(d, &mut v);
            v.sort();
            v
        };
        let before = names(&t.0);
        run("claude", &t.0, &HashSet::new(), &utc, &mut Cache::default());
        assert_eq!(before, names(&t.0));
    }

    #[test]
    fn only_homes_inside_the_persons_own_folder_are_read() {
        let user = Tmp::new("user");
        let other = Tmp::new("other-user");
        std::fs::create_dir_all(user.0.join(".claude/projects")).unwrap();
        std::fs::create_dir_all(other.0.join(".claude/projects")).unwrap();
        std::fs::create_dir_all(user.0.join(".manut/accounts/claude/work")).unwrap();
        std::fs::create_dir_all(user.0.join(".manut/accounts/claude/Bad Name")).unwrap();
        // a variable (primary) naming another user's folder is refused, and the person's own are kept
        let homes = homes_for(&user.0, "claude", Some(other.0.join(".claude")));
        let base = user.0.canonicalize().unwrap();
        assert_eq!(homes.len(), 2);
        assert!(homes.iter().all(|h| h.starts_with(&base)));
        assert!(homes.iter().any(|h| h.ends_with("accounts/claude/work")));
        // a link out of the person's folder is refused too
        #[cfg(unix)]
        {
            let u2 = Tmp::new("user2");
            std::os::unix::fs::symlink(other.0.join(".claude"), u2.0.join(".claude")).unwrap();
            assert!(homes_for(&u2.0, "claude", None).is_empty());
        }
    }

    #[test]
    fn project_names_keep_only_the_last_part() {
        assert_eq!(project_name("/Users/a/Developer/shop"), "shop");
        assert_eq!(project_name("/Users/a/Developer/shop/"), "shop");
        assert_eq!(project_name("C:\\Users\\a\\shop"), "shop");
        assert_eq!(project_name(""), "");
        assert_eq!(project_name("/").len(), 0);
    }

    #[test]
    fn ids_from_the_page_are_only_ever_matched_never_opened() {
        let ids = clean_ids(vec![SID.into(), "../../etc/passwd".into(), "ok_id-1".into(), "x".repeat(200)]);
        assert!(ids.contains(SID) && ids.contains("ok_id-1"));
        assert_eq!(ids.len(), 2);
    }
}
