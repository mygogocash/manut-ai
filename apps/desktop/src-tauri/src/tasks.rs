//! Tasks (the sidebar's Tasks row and the Tasks page): open issues and pull / merge requests of one repository, read
//! through the person's own GitHub CLI (`gh`) or GitLab CLI (`glab`), read-only (BOUNDARY rule 33).
//!
//! The idea and the page's shape come from Orca's Tasks (stablyai/orca, MIT License, Copyright (c) 2026 Lovecast
//! Inc.; src/renderer/src/components/sidebar/SidebarTaskNavButton.tsx, src/renderer/src/components/task-page/**,
//! src/main/github|gitlab). No Orca code is copied here: the argv and parsing are manut's own.
//!
//! What crosses from the page is only: the source (`github` / `gitlab`), the repository (`owner/repo`, checked
//! below), the filter and kind (fixed words), the page number and an item number. Every program runs as a fixed argv
//! with no shell, nothing on stdin, at most 20 seconds, and its answer is kept 60 seconds per argv. manut passes no
//! token, reads none (`auth status` is judged by its exit code alone, its output goes nowhere) and changes nothing:
//! every argv here is a `list`, `view` or `auth status`. Every text a CLI answers passes `mask_secrets` before it
//! leaves this module, so a token-like string in an issue never reaches the page.
use std::collections::HashMap;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use regex::{Regex, RegexBuilder};
use serde::Serialize;
use serde_json::Value;

use crate::accounts::{resolve, search_dirs};
use crate::platform::Os;

/// Rows a page shows.
pub const PAGE: usize = 25;
/// The last page asked for (100 000 rows). Every page is one call of at most `PAGE + 1 + MAX_SEEN` rows, however
/// deep it is: GitHub pages start below the row the page before ended on (`After`), GitLab's CLI has `--page`.
pub const MAX_PAGE: u32 = 3999;
/// The most rows of one second a GitHub page may have to skip (more rows opened in the same second: the page fails).
const MAX_SEEN: usize = 100;
/// How long a program may run.
pub const TIMEOUT: Duration = Duration::from_secs(20);
/// How long an answer is kept for the same argv.
pub const KEEP: Duration = Duration::from_secs(60);
/// The most bytes of a program's output read (lane.rs takes a listing this long as one that may have been cut short).
pub(crate) const MAX_OUT: u64 = 16 << 20;
/// The most characters of an item's description or a comment passed to the page.
const MAX_BODY: usize = 64 * 1024;
/// The most comments passed to the page.
const MAX_COMMENTS: usize = 50;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Source {
    Github,
    Gitlab,
}

impl Source {
    pub fn parse(s: &str) -> Result<Source, String> {
        match s {
            "github" => Ok(Source::Github),
            "gitlab" => Ok(Source::Gitlab),
            _ => Err(format!("unknown task source {s:?}")),
        }
    }
    pub fn program(self) -> &'static str {
        match self {
            Source::Github => "gh",
            Source::Gitlab => "glab",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    Issues,
    /// pull requests (GitHub) or merge requests (GitLab)
    Changes,
}

impl Kind {
    pub fn parse(s: &str) -> Result<Kind, String> {
        match s {
            "issues" => Ok(Kind::Issues),
            "prs" => Ok(Kind::Changes),
            _ => Err(format!("unknown task kind {s:?}")),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Filter {
    Assigned,
    Created,
    Mentioned,
    Open,
}

impl Filter {
    pub fn parse(s: &str) -> Result<Filter, String> {
        match s {
            "assigned" => Ok(Filter::Assigned),
            "created" => Ok(Filter::Created),
            "mentioned" => Ok(Filter::Mentioned),
            "open" => Ok(Filter::Open),
            _ => Err(format!("unknown task filter {s:?}")),
        }
    }
}

fn segment_ok(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 100
        && !s.starts_with('-')
        && !s.starts_with('.')
        && s.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
}

/// `repo` when it names a repository: `owner/repo` for GitHub (`^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$`), and for GitLab
/// also a project under subgroups (`group/sub/project`, at most 6 parts). No part may start with `-` or `.`, so a
/// name is never read as an option or a path.
pub fn check_repo(source: Source, repo: &str) -> Result<String, String> {
    let parts: Vec<&str> = repo.split('/').collect();
    let n_ok = match source {
        Source::Github => parts.len() == 2,
        Source::Gitlab => (2..=6).contains(&parts.len()),
    };
    if !n_ok || !parts.iter().all(|p| segment_ok(p)) {
        return Err(format!("not a repository: {repo:?}"));
    }
    Ok(repo.to_string())
}

/// The argv (after the program) that tells whether the CLI is signed in. Only its exit code is used.
pub fn auth_argv(_source: Source) -> Vec<String> {
    vec!["auth".into(), "status".into()]
}

const GH_ISSUE_FIELDS: &str = "number,title,state,url,labels,author,createdAt,updatedAt";
const GH_PR_FIELDS: &str = "number,title,state,url,labels,author,createdAt,updatedAt,isDraft,headRefName,statusCheckRollup,isCrossRepository,headRepository,headRepositoryOwner";
const GH_ISSUE_VIEW: &str = "number,title,state,url,body,author,createdAt,updatedAt,labels,comments";
const GH_PR_VIEW: &str = "number,title,state,url,body,author,createdAt,updatedAt,labels,comments,isDraft,headRefName,statusCheckRollup";

fn s(v: &str) -> String {
    v.to_string()
}

/// Where a GitHub page starts. gh lists newest first; page `n` asks for the rows opened at or before `created` (the
/// second the page before ended on) and drops `seen`, the rows of that same second earlier pages already showed. So
/// a page deep in a long list costs one call of `PAGE + 1 + seen` rows, never every row above it.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct After {
    /// seconds since the epoch
    pub created: i64,
    pub seen: Vec<u64>,
}

/// `2026-11-15T18:19:59Z` for seconds since the epoch (the inverse of `epoch`).
pub fn iso(t: i64) -> String {
    let (days, secs) = (t.div_euclid(86_400), t.rem_euclid(86_400));
    // civil from days (Howard Hinnant)
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + if m <= 2 { 1 } else { 0 };
    format!("{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}Z", secs / 3600, secs % 3600 / 60, secs % 60)
}

/// The list argv for one page. `None` when the source has no such filter (GitLab's CLI has no "mentions me").
/// `after`: where a GitHub page after the first starts (`Tasks` keeps it from the page before).
pub fn list_argv(source: Source, kind: Kind, repo: &str, filter: Filter, page: u32, after: Option<&After>) -> Result<Option<Vec<String>>, String> {
    let repo = check_repo(source, repo)?;
    if page > MAX_PAGE {
        return Err(format!("page {page} is past the last one"));
    }
    Ok(match source {
        Source::Github => {
            if page > 0 && after.is_none() {
                return Err(format!("page {} follows a page not read yet", page + 1));
            }
            let seen = after.map_or(0, |a| a.seen.len());
            if seen > MAX_SEEN {
                return Err(format!("more than {MAX_SEEN} items were opened in one second"));
            }
            let (noun, fields) = match kind {
                Kind::Issues => ("issue", GH_ISSUE_FIELDS),
                Kind::Changes => ("pr", GH_PR_FIELDS),
            };
            let limit = PAGE + 1 + seen;
            let mut a = vec![s(noun), s("list"), s("--repo"), repo, s("--state"), s("open"), s("--json"), s(fields), s("--limit"), limit.to_string()];
            let mut search = vec![];
            match (filter, kind) {
                (Filter::Assigned, _) => a.extend([s("--assignee"), s("@me")]),
                (Filter::Created, _) => a.extend([s("--author"), s("@me")]),
                (Filter::Mentioned, Kind::Issues) => a.extend([s("--mention"), s("@me")]),
                (Filter::Mentioned, Kind::Changes) => search.push(s("mentions:@me")),
                (Filter::Open, _) => {}
            }
            search.push(s("sort:created-desc"));
            if let Some(at) = after {
                search.push(format!("created:<={}", iso(at.created)));
            }
            a.extend([s("--search"), search.join(" ")]);
            Some(a)
        }
        Source::Gitlab => {
            let noun = match kind {
                Kind::Issues => "issue",
                Kind::Changes => "mr",
            };
            let mut a = vec![s(noun), s("list"), s("--repo"), repo, s("--output"), s("json"), s("--per-page"), PAGE.to_string(), s("--page"), (page + 1).to_string()];
            match filter {
                Filter::Assigned => a.push(s("--assignee=@me")),
                Filter::Created => a.push(s("--author=@me")),
                Filter::Mentioned => return Ok(None),
                Filter::Open => {}
            }
            Some(a)
        }
    })
}

/// The view argv for item `number`.
pub fn view_argv(source: Source, kind: Kind, repo: &str, number: u64) -> Result<Vec<String>, String> {
    let repo = check_repo(source, repo)?;
    if number == 0 || number > 100_000_000 {
        return Err(format!("not an item number: {number}"));
    }
    Ok(match source {
        Source::Github => {
            let (noun, fields) = match kind {
                Kind::Issues => ("issue", GH_ISSUE_VIEW),
                Kind::Changes => ("pr", GH_PR_VIEW),
            };
            vec![s(noun), s("view"), number.to_string(), s("--repo"), repo, s("--json"), s(fields)]
        }
        Source::Gitlab => {
            let noun = match kind {
                Kind::Issues => "issue",
                Kind::Changes => "mr",
            };
            vec![s(noun), s("view"), number.to_string(), s("--repo"), repo, s("--output"), s("json")]
        }
    })
}

// ---- the shapes the page gets ------------------------------------------------------------------

#[derive(Clone, Debug, Default, Serialize, PartialEq)]
pub struct Label {
    pub name: String,
    /// `rrggbb` when the source gave one
    pub color: String,
}

#[derive(Clone, Debug, Default, Serialize, PartialEq)]
pub struct Checks {
    pub passed: u32,
    pub failed: u32,
    pub pending: u32,
    pub total: u32,
}

#[derive(Clone, Debug, Default, Serialize, PartialEq)]
pub struct Item {
    pub number: u64,
    pub title: String,
    /// `open`, `closed`, `merged` or `draft`
    pub state: String,
    pub url: String,
    pub labels: Vec<Label>,
    pub author: String,
    /// seconds since the epoch (0: unknown)
    pub created: i64,
    pub updated: i64,
    /// pull / merge requests only
    pub checks: Option<Checks>,
    /// The branch a pull / merge request is made from ("" for an issue, and when the source did not say): what the Code page's lane
    /// rows match to show their pull request (item 76), read from the list the page already asks for, never from a call of its own.
    pub head: String,
    /// Whether the host says that branch is in this very repository (GitHub's `isCrossRepository` false with its head repository
    /// the one listed, GitLab's `source_project_id` its `target_project_id`): false for a fork's request, which anyone can open
    /// on a branch named like a lane's, and when the host did not say. A lane's row only ever shows a request with this true.
    pub same: bool,
    /// The repository the branch is in, `owner/repo`, as GitHub names it ("" when it did not say, and for GitLab).
    pub from: String,
}

#[derive(Clone, Debug, Default, Serialize, PartialEq)]
pub struct Comment {
    pub author: String,
    pub body: String,
    pub created: i64,
}

#[derive(Clone, Debug, Default, Serialize, PartialEq)]
pub struct Check {
    pub name: String,
    /// `passed`, `failed`, `pending` or `skipped`
    pub state: String,
    pub url: String,
}

#[derive(Clone, Debug, Default, Serialize, PartialEq)]
pub struct Detail {
    pub item: Item,
    pub body: String,
    pub comments: Vec<Comment>,
    pub checks: Vec<Check>,
}

#[derive(Clone, Debug, Default, Serialize, PartialEq)]
pub struct Page {
    pub items: Vec<Item>,
    /// another page may follow
    pub more: bool,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct Status {
    /// the CLI was found
    pub installed: bool,
    /// `auth status` exited 0
    pub signed_in: bool,
}

// ---- parsing ------------------------------------------------------------------------------------

/// manut's one masker (src/lib/secrets.json: the page uses the same patterns).
const SECRETS: &str = include_str!("../../src/lib/secrets.json");

struct Secrets {
    /// replaced whole, first: private key blocks, provider-prefixed keys, JSON web tokens; with its kind: `word` (the match
    /// must stand alone as a word), `block` (a private key block, which a command masks through `blocks` instead), or ""
    whole: Vec<(Regex, String)>,
    /// a command's private key blocks: (pattern with (BEGIN)(body)(END) groups, the line break before the mask, no END)
    blocks: Vec<(Regex, String, bool)>,
    block_begin: Regex,
    block_end: Regex,
    /// a fixed-length family broken over lines: (pattern, body length)
    split: Vec<(Regex, usize)>,
    tokens: Regex,
    /// `tokens` as one word, for a command
    word: Regex,
    /// three groups each: the first and third kept, the second masked
    kept: Vec<Regex>,
    assigned: Regex,
    mask: String,
    /// a character that, glued to a token, makes it part of a longer name
    edge: Regex,
    /// what a token's body holds: a capital or a digit; or the token has a provider's exact shape and length
    needs: Regex,
    exact: Regex,
    /// a prefix that ordinary names start with too (`sk-`), its named forms, and the run of letters and digits it needs
    wordlike: Regex,
    named: Regex,
    run: Regex,
    /// a token's prefix, at the start
    prefix: Regex,
    /// a character the shell acts on: in a command, a masked value stops at it
    shell: Regex,
    /// a value that is a reference (`${DB_PASSWORD}`), and a word that says there is none (`none`): no key
    reference: Regex,
    plain: Regex,
    /// commands that only write their input out: a key block is masked only in the data of one of these
    sinks: Vec<String>,
}

/// A pattern of secrets.json as the page's JavaScript reads it: `{names}` and `{prefixes}` filled in, its flags (`i`, `m`),
/// and `\b` an ASCII word boundary, so a token right after Thai text, which JavaScript sees as no word, is masked here too.
fn pattern(p: &str, flags: &str, names: &str, prefixes: &str) -> Regex {
    RegexBuilder::new(&p.replace("{names}", names).replace("{prefixes}", prefixes).replace(r"\b", r"(?-u:\b)"))
        .case_insensitive(flags.contains('i'))
        .multi_line(flags.contains('m'))
        .build()
        .expect("secrets.json pattern")
}

fn secrets() -> &'static Secrets {
    static R: OnceLock<Secrets> = OnceLock::new();
    R.get_or_init(|| {
        let v: Value = serde_json::from_str(SECRETS).expect("secrets.json");
        let get = |k: &str| v[k].as_str().expect("secrets.json key").to_string();
        let names = get("names");
        let prefixes = get("prefixes");
        let one = |k: &str| pattern(&get(k), "", &names, &prefixes);
        let entries = |k: &str| v[k].as_array().expect("secrets.json list").clone();
        let compiled = |e: &Value| pattern(e[0].as_str().expect("pattern"), e[1].as_str().expect("flags"), &names, &prefixes);
        let split = entries("split").iter()
            .map(|e| (pattern(e[0].as_str().expect("split pattern"), "", &names, &prefixes), e[1].as_u64().expect("split length") as usize))
            .collect();
        Secrets {
            whole: entries("whole").iter().map(|e| (compiled(e), e.get(2).and_then(Value::as_str).unwrap_or("").to_string())).collect(),
            blocks: entries("blocks")
                .iter()
                .map(|e| (pattern(e[0].as_str().expect("block pattern"), e.get(3).and_then(Value::as_str).unwrap_or(""), &names, &prefixes), e[1].as_str().expect("block break").to_string(), e.get(2).and_then(Value::as_str) == Some("unended")))
                .collect(),
            block_begin: one("blockBegin"),
            block_end: one("blockEnd"),
            split,
            tokens: one("tokens"),
            word: one("word"),
            kept: entries("kept").iter().map(compiled).collect(),
            assigned: pattern(&get("assigned"), "i", &names, &prefixes),
            mask: get("mask"),
            edge: one("edge"),
            needs: one("needs"),
            exact: one("exact"),
            wordlike: one("wordlike"),
            named: one("named"),
            run: one("run"),
            prefix: pattern(&format!("^{prefixes}"), "", &names, &prefixes),
            shell: one("shell"),
            reference: one("ref"),
            plain: pattern(&get("plain"), "i", &names, &prefixes),
            sinks: entries("sinks").iter().map(|e| e.as_str().expect("secrets.json sink").to_string()).collect(),
        }
    })
}

/// Whether the match `m` in `t` stands alone: no letter, digit, `_` or `-` glued to either side, so a token inside a
/// longer name (`build-sk-…`) is the name's and stays (src/lib/secrets.ts `alone`).
fn alone(s: &Secrets, t: &str, m: regex::Match) -> bool {
    let touches = |c: Option<char>| c.is_some_and(|c| s.edge.is_match(c.encode_utf8(&mut [0; 4])));
    !touches(t[..m.start()].chars().next_back()) && !touches(t[m.end()..].chars().next())
}

/// Whether a `tokens` match has a key's shape (src/lib/secrets.ts `keyShaped`).
fn key_shaped(s: &Secrets, m: &str) -> bool {
    if s.exact.is_match(m) {
        return true;
    }
    if s.wordlike.is_match(m) {
        return s.named.is_match(m) || s.run.find_iter(m).any(|r| s.needs.is_match(r.as_str()));
    }
    s.needs.is_match(&s.prefix.replace(m, ""))
}

/// Whether a named value is a key at all: not a reference and not a word that says there is none (src/lib/secrets.ts `aKey`).
fn a_key(s: &Secrets, v: &str) -> bool {
    !s.reference.is_match(v) && !s.plain.is_match(v)
}

/// How much of a value may be masked in a command: up to the first character the shell acts on.
fn up_to(s: &Secrets, v: &str) -> usize {
    s.shell.find(v).map_or(v.len(), |m| m.start())
}

/// `t`'s `whole` matches masked; in a command (`command`), not a key block, which [`mask_blocks`] masked first.
fn mask_whole(s: &Secrets, mut t: String, command: bool) -> String {
    for (rx, kind) in &s.whole {
        if command && kind == "block" {
            continue;
        }
        t = rx.replace_all(&t, |c: &regex::Captures| {
            let m = c.get(0).expect("match");
            if kind == "word" && !alone(s, &t, m) { m.as_str().to_string() } else { s.mask.clone() }
        }).into_owned();
    }
    t
}

/// A command read as the shell reads it (src/lib/secrets.ts `lex`, step for step): its words as byte ranges, and for each byte
/// whether a key block there is data that is only written out, so it may be masked.
struct Reading {
    words: Vec<(usize, usize)>,
    data: Vec<bool>,
}

/// The terminator a heredoc's word names, and whether it was quoted (src/lib/secrets.ts `heredocWord`): a plain word, a word in
/// one pair of single or double quotes, or a word after one backslash. Any other form is not read.
fn heredoc_word(w: &str) -> Option<(String, bool)> {
    static PLAIN: OnceLock<Regex> = OnceLock::new();
    static QUOTED: OnceLock<Regex> = OnceLock::new();
    if PLAIN.get_or_init(|| Regex::new(r"^[A-Za-z0-9_.-]+$").expect("plain heredoc word")).is_match(w) {
        return Some((w.to_string(), false));
    }
    let m = QUOTED.get_or_init(|| Regex::new(r#"^(?:'([^']*)'|"([^"\\$`]*)"|\\([A-Za-z0-9_.-]+))$"#).expect("quoted heredoc word")).captures(w)?;
    Some((m.get(1).or_else(|| m.get(2)).or_else(|| m.get(3)).map_or("", |x| x.as_str()).to_string(), true))
}

/// A quote being read: `'…'`, `"…"` or `$'…'`.
#[derive(Clone, Copy, PartialEq)]
enum Quote {
    Single,
    Double,
    Dollar,
}

/// The reader's state (src/lib/secrets.ts `lex`): byte offsets throughout.
struct Lexer<'a> {
    text: &'a str,
    words: Vec<(usize, usize)>,
    /// each simple command's first word, once it has one
    commands: Vec<Option<String>>,
    /// quoted strings and heredoc bodies: from, to, and the simple command each belongs to
    regions: Vec<(usize, usize, usize)>,
    /// nothing from here on can be followed
    until: usize,
    start: Option<usize>,
    /// a `<<` waits for its word (whether it was `<<-`)
    wanted: Option<bool>,
    /// heredocs begun on this line: terminator, quoted, `<<-`, simple command
    heredocs: Vec<(String, bool, bool, usize)>,
}

impl Lexer<'_> {
    fn stop(&mut self, at: usize) {
        self.until = self.until.min(at);
    }

    fn end(&mut self, to: usize) {
        let Some(from) = self.start.take() else { return };
        let w = &self.text[from..to];
        self.words.push((from, to));
        let command = self.commands.len() - 1;
        if let Some(dash) = self.wanted.take() {
            match heredoc_word(w) {
                Some((word, quoted)) => self.heredocs.push((word, quoted, dash, command)),
                None => self.stop(from),
            }
        } else if self.commands[command].is_none() {
            self.commands[command] = Some(w.to_string());
        }
    }

    /// The heredocs begun on the line that ended at byte `from`, in order: each body one word, its terminator line another.
    fn bodies(&mut self, from: usize) -> usize {
        static ACTS: OnceLock<Regex> = OnceLock::new();
        let acts = ACTS.get_or_init(|| Regex::new(r"[`\\]|\$[({\[]").expect("heredoc acts"));
        let n = self.text.len();
        let mut at = from;
        for (word, quoted, dash, command) in std::mem::take(&mut self.heredocs) {
            let body = at;
            let mut term = None;
            while at < n {
                let line_end = self.text[at..].find('\n').map_or(n, |k| at + k);
                let line = &self.text[at..line_end];
                if (if dash { line.trim_start_matches('\t') } else { line }) == word {
                    term = Some((at, line_end));
                    break;
                }
                at = line_end + 1;
            }
            let body_end = term.map_or(n, |t| t.0);
            self.words.push((body, body_end));
            let readable = if quoted { body_end } else { acts.find(&self.text[body..body_end]).map_or(body_end, |m| body + m.start()) };
            self.regions.push((body, readable, command));
            let Some((t, t_end)) = term else { return n };
            self.words.push((t, t_end));
            at = t_end + 1;
        }
        at.min(n)
    }
}

/// A command read as the shell reads it (src/lib/secrets.ts `lex`, which says how).
fn lex(text: &str) -> Reading {
    let s = secrets();
    let b: Vec<(usize, char)> = text.char_indices().collect();
    let n = text.len();
    let index = |byte: usize| b.partition_point(|x| x.0 < byte);
    let mut lx = Lexer { text, words: Vec::new(), commands: vec![None], regions: Vec::new(), until: n, start: None, wanted: None, heredocs: Vec::new() };
    let mut piped = false;
    let mut quote: Option<Quote> = None;
    let mut opened = 0;
    let mut plain: Option<usize> = None;
    let mut i = 0;
    while i < b.len() {
        let (here, c) = b[i];
        let next = b.get(i + 1).map(|x| x.1);
        let after = |k: usize| b.get(k).map_or(n, |x| x.0);
        if let Some(q) = quote {
            if q != Quote::Single && c == '\\' {
                i += 2;
                continue;
            }
            if (q == Quote::Single && c == '\'') || (q == Quote::Dollar && c == '\'') || (q == Quote::Double && c == '"') {
                lx.regions.push((opened, here, lx.commands.len() - 1));
                quote = None;
            } else if q == Quote::Double && (c == '`' || (c == '$' && matches!(next, Some('(' | '{')))) {
                lx.stop(here);
            }
            i += 1;
            continue;
        }
        if c == '\\' {
            lx.start.get_or_insert(here);
            i += 2;
            continue;
        }
        if c == '\'' || c == '"' {
            lx.start.get_or_insert(here);
            quote = Some(if c == '"' {
                Quote::Double
            } else if i > 0 && plain == Some(i - 1) && b[i - 1].1 == '$' {
                Quote::Dollar
            } else {
                Quote::Single
            });
            opened = after(i + 1);
            i += 1;
            continue;
        }
        if c == '`' || (c == '$' && matches!(next, Some('(' | '{' | '['))) || (c == '(' && next == Some('(')) {
            lx.stop(here);
        }
        if c == ' ' || c == '\t' {
            lx.end(here);
        } else if c == '#' && lx.start.is_none() {
            let nl = text[here..].find('\n').map_or(n, |k| here + k);
            lx.words.push((here, nl));
            i = index(nl);
            continue;
        } else if c == '<' || c == '>' {
            lx.end(here);
            if lx.wanted.is_some() {
                lx.stop(here);
            }
            let prev = if i > 0 { Some(b[i - 1].1) } else { None };
            let third = b.get(i + 2).map(|x| x.1);
            if c == '<' && next == Some('<') && prev != Some('<') && third != Some('<') {
                let dash = third == Some('-');
                let len = if dash { 3 } else { 2 };
                lx.words.push((here, here + len));
                lx.wanted = Some(dash);
                i += len;
                continue;
            }
            lx.words.push((here, here + 1));
        } else if ";&|()\n".contains(c) {
            lx.end(here);
            if lx.wanted.take().is_some() {
                lx.stop(here);
            }
            lx.words.push((here, here + 1));
            if matches!(c, '|' | '(' | ')') {
                piped = true;
            }
            lx.commands.push(None);
            if c == '\n' && !lx.heredocs.is_empty() {
                let to = lx.bodies(here + 1);
                i = index(to);
                continue;
            }
        } else {
            lx.start.get_or_insert(here);
            plain = Some(i);
        }
        i += 1;
    }
    lx.end(n);
    let mut data = vec![false; n];
    let first = lx.commands.iter().position(Option::is_some);
    if let Some(f) = first.filter(|&f| !piped && lx.commands[f].as_ref().is_some_and(|w| s.sinks.iter().any(|k| k == w))) {
        for &(from, to, command) in &lx.regions {
            if command == f {
                for d in &mut data[from..to.min(lx.until).max(from)] {
                    *d = true;
                }
            }
        }
    }
    Reading { words: lx.words, data }
}

/// The words of a command as the shell splits it ([`lex`]).
#[cfg(test)]
fn shell_words(t: &str) -> Vec<String> {
    lex(t).words.iter().map(|&(a, z)| t[a..z].to_string()).collect()
}

/// Whether pieces `i..` of a masked word follow at byte `at` of `before`, the mask before piece `i` standing for a run of one or
/// more characters `free` allows (src/lib/secrets.ts `aligned`).
fn rest(before: &str, from: usize, pieces: &[&str], i: usize, at: usize, free: &dyn Fn(usize) -> bool, failed: &mut std::collections::HashSet<(usize, usize)>) -> bool {
    if failed.contains(&(i, at)) {
        return false;
    }
    let next = pieces[i];
    let last = i == pieces.len() - 1;
    for (k, ch) in before[at..].char_indices() {
        let pos = at + k;
        if !free(from + pos) {
            break;
        }
        let end = pos + ch.len_utf8();
        if before[end..].starts_with(next) && (if last { end + next.len() == before.len() } else { rest(before, from, pieces, i + 1, end + next.len(), free, failed) }) {
            return true;
        }
    }
    failed.insert((i, at));
    false
}

/// Whether `after` is the word `before` (which starts at byte `from` in its command) with each mask standing for a run of one or
/// more of its characters, every one of which `free` allows, and everything else equal.
fn aligned(before: &str, from: usize, after: &str, mask: &str, free: &dyn Fn(usize) -> bool) -> bool {
    if before == after {
        return true;
    }
    let pieces: Vec<&str> = after.split(mask).collect();
    if pieces.len() == 1 || pieces.len() > 64 || !before.starts_with(pieces[0]) {
        return false;
    }
    rest(before, from, &pieces, 1, pieces[0].len(), free, &mut std::collections::HashSet::new())
}

/// Whether `after` splits into the same shell words as `before`, each the same or with masks standing for characters `free`
/// allows (given `before`'s reading and a byte offset).
fn shaped(before: &str, after: &str, free: &dyn Fn(&Reading, usize) -> bool) -> bool {
    let s = secrets();
    let a = lex(before);
    let b = lex(after);
    a.words.len() == b.words.len() && a.words.iter().zip(&b.words).all(|(&(f, t), &(g, u))| aligned(&before[f..t], f, &after[g..u], &s.mask, &|k| free(&a, k)))
}

/// The structural check of what an approval shows (src/lib/secrets.ts `sameShape`): `after` splits into exactly `before`'s
/// shell words, each the same or with only a key's part masked, a run that holds no character the command form stops at.
fn same_shape(before: &str, after: &str) -> bool {
    let s = secrets();
    shaped(before, after, &|_, k| before[k..].chars().next().is_some_and(|c| !s.shell.is_match(c.encode_utf8(&mut [0; 4]))))
}

/// A command's private key blocks whose body holds only key lines, where the whole block is data a writer only writes out
/// ([`lex`]): the BEGIN and END lines stay, the body is one mask line (src/lib/secrets.ts `maskBlocks`). A block with no END
/// of its own is masked only when none comes before the next BEGIN.
fn mask_blocks(s: &Secrets, mut t: String) -> String {
    if !t.contains("PRIVATE KEY") {
        return t;
    }
    for (rx, sep, open) in &s.blocks {
        let data = lex(&t).data;
        t = rx.replace_all(&t, |c: &regex::Captures| {
            let m = c.get(0).expect("match");
            if *open {
                let rest = &t[m.end()..];
                let scope = s.block_begin.find(rest).map_or(rest, |b| &rest[..b.start()]);
                if s.block_end.is_match(scope) {
                    return m.as_str().to_string();
                }
            }
            if !data[m.start()..m.end()].iter().all(|&d| d) {
                return m.as_str().to_string();
            }
            format!("{}{}{}{}", &c[1], sep, s.mask, &c[3])
        }).into_owned();
    }
    t
}

/// `t`'s token matches of `rx` masked, when they stand alone and have a key's shape.
fn mask_tokens(s: &Secrets, rx: &Regex, t: String) -> String {
    rx.replace_all(&t, |c: &regex::Captures| {
        let m = c.get(0).expect("match");
        if alone(s, &t, m) && key_shaped(s, m.as_str()) { s.mask.clone() } else { m.as_str().to_string() }
    }).into_owned()
}

/// A `split` match: the prefix and the body's pieces up to exactly `n` token characters become `mask` (the pieces
/// after stay); left as it is when the pieces do not make exactly `n` at the end of one.
fn split_token(c: &regex::Captures, n: usize, mask: &str) -> String {
    let body = &c[1];
    let mut k = 0;
    for (i, ch) in body.char_indices() {
        if ch.is_whitespace() {
            continue;
        }
        k += 1;
        if k == n {
            let rest = &body[i + ch.len_utf8()..];
            return if rest.is_empty() || rest.starts_with(char::is_whitespace) { format!("{mask}{rest}") } else { c[0].to_string() };
        }
    }
    c[0].to_string()
}

/// `t` with every token-like string replaced by `••••` (src/lib/secrets.ts `maskSecrets`, step for step). A secret with a name
/// keeps its name and what frames it (`token=••••`, `"password": "••••"`, `Authorization: Bearer ••••`). For text that never
/// runs: what an approval shows goes through [`mask_command`].
pub fn mask_secrets(t: &str) -> String {
    let s = secrets();
    let mut t = mask_whole(s, t.to_string(), false);
    for (rx, n) in &s.split {
        t = rx.replace_all(&t, |c: &regex::Captures| split_token(c, *n, &s.mask)).into_owned();
    }
    t = mask_tokens(s, &s.tokens, t);
    for rx in &s.kept {
        t = rx.replace_all(&t, |c: &regex::Captures| if a_key(s, &c[2]) { format!("{}{}{}", &c[1], s.mask, &c[3]) } else { c[0].to_string() }).into_owned();
    }
    s.assigned.replace_all(&t, |c: &regex::Captures| if a_key(s, &c[0][c[1].len() + 1..]) { format!("{}={}", &c[1], s.mask) } else { c[0].to_string() }).into_owned()
}

/// One line of a command, masked as [`mask_command`] says. A value that already holds the mask (a key block's) is left as it is.
fn command_line(s: &Secrets, line: &str) -> String {
    let mut t = mask_tokens(s, &s.word, mask_whole(s, line.to_string(), true));
    for rx in &s.kept {
        t = rx.replace_all(&t, |c: &regex::Captures| {
            let v = &c[2];
            match if a_key(s, v) && !v.contains(s.mask.as_str()) { up_to(s, v) } else { 0 } {
                0 => c[0].to_string(),
                n => format!("{}{}{}{}", &c[1], s.mask, &v[n..], &c[3]),
            }
        }).into_owned();
    }
    s.assigned.replace_all(&t, |c: &regex::Captures| {
        let v = &c[0][c[1].len() + 1..];
        match if a_key(s, v) && !v.contains(s.mask.as_str()) { up_to(s, v) } else { 0 } {
            0 => c[0].to_string(),
            n => format!("{}={}{}", &c[1], s.mask, &v[n..]),
        }
    }).into_owned()
}

/// What an approval shows of a command (src/lib/secrets.ts `ShownCommand`).
pub struct Shown {
    /// the command with its keys masked; or as it is, when masking it could change what it seems to do
    pub text: String,
    /// shown as it is: the masked line would not split into the command's own shell words, or the command already holds
    /// the mask's character, and the person is told it may hold a key
    pub unmasked: bool,
}

/// A command, or anything else an approval shows, with its keys masked and nothing else (src/lib/secrets.ts `showCommand`,
/// step for step): line by line, never joined across a blank, and a masked value stops at the first blank, quote, `#`, glob
/// character or character the shell acts on, which is shown with what follows it; then the structural check, or the command
/// is shown as it is.
pub fn show_command(t: &str) -> Shown {
    let s = secrets();
    let blocks = mask_blocks(s, t.to_string());
    let masked = blocks.split('\n').map(|l| command_line(s, l)).collect::<Vec<_>>().join("\n");
    if masked == t {
        return Shown { text: masked, unmasked: false };
    }
    let dot = s.mask.chars().next().unwrap_or('•');
    let sure = !t.contains(dot) && shaped(t, &blocks, &|r, k| r.data[k]) && same_shape(&blocks, &masked);
    if sure { Shown { text: masked, unmasked: false } } else { Shown { text: t.to_string(), unmasked: true } }
}

/// [`show_command`]'s text: what an approval shows of a command.
pub fn mask_command(t: &str) -> String {
    show_command(t).text
}

/// A text field of a CLI answer: control characters out, token-like strings masked.
pub(crate) fn text(v: &Value, k: &str) -> String {
    let t: String = v.get(k).and_then(Value::as_str).unwrap_or("").chars().filter(|c| !c.is_control() || *c == '\n' || *c == '\t').collect();
    mask_secrets(&t)
}

fn clip(mut t: String, n: usize) -> String {
    if t.len() > n {
        let mut at = n;
        while !t.is_char_boundary(at) {
            at -= 1;
        }
        t.truncate(at);
        t.push('…');
    }
    t
}

pub(crate) fn one_line(t: String, n: usize) -> String {
    clip(t.split_whitespace().collect::<Vec<_>>().join(" "), n)
}

/// Seconds since the epoch of an RFC 3339 time (`2026-11-15T18:19:59Z`, `2026-11-15T18:19:59.123+09:00`); 0 when
/// it is not one.
pub fn epoch(t: &str) -> i64 {
    let b = t.as_bytes();
    if b.len() < 19 || b[4] != b'-' || b[7] != b'-' || (b[10] != b'T' && b[10] != b' ') || b[13] != b':' || b[16] != b':' {
        return 0;
    }
    let num = |r: std::ops::Range<usize>| t.get(r).and_then(|x| x.parse::<i64>().ok());
    let (Some(y), Some(mo), Some(d), Some(h), Some(mi), Some(sec)) = (num(0..4), num(5..7), num(8..10), num(11..13), num(14..16), num(17..19)) else {
        return 0;
    };
    // days from civil (Howard Hinnant)
    let (y2, m2) = if mo <= 2 { (y - 1, mo + 9) } else { (y, mo - 3) };
    let era = y2.div_euclid(400);
    let yoe = y2 - era * 400;
    let doy = (153 * m2 + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    let mut off = 0i64;
    let rest = &t[19..];
    let rest = rest.trim_start_matches(|c: char| c == '.' || c.is_ascii_digit());
    if rest.len() >= 6 && (rest.starts_with('+') || rest.starts_with('-')) {
        if let (Ok(oh), Ok(om)) = (rest[1..3].parse::<i64>(), rest[4..6].parse::<i64>()) {
            off = (oh * 3600 + om * 60) * if rest.starts_with('-') { -1 } else { 1 };
        }
    }
    days * 86_400 + h * 3600 + mi * 60 + sec - off
}

pub(crate) fn gh_author(v: &Value) -> String {
    v.get("author").map(|a| text(a, "login")).unwrap_or_default()
}

pub(crate) fn gh_labels(v: &Value) -> Vec<Label> {
    v.get("labels")
        .and_then(Value::as_array)
        .map(|ls| ls.iter().take(12).map(|l| Label { name: one_line(text(l, "name"), 60), color: text(l, "color") }).filter(|l| !l.name.is_empty()).collect())
        .unwrap_or_default()
}

/// One GitHub check (a CheckRun or a StatusContext of `statusCheckRollup`) as passed / failed / pending / skipped.
fn gh_check_state(c: &Value) -> &'static str {
    let up = |k: &str| c.get(k).and_then(Value::as_str).unwrap_or("").to_ascii_uppercase();
    if c.get("__typename").and_then(Value::as_str) == Some("StatusContext") || (c.get("status").is_none() && c.get("state").is_some()) {
        return match up("state").as_str() {
            "SUCCESS" => "passed",
            "FAILURE" | "ERROR" => "failed",
            _ => "pending",
        };
    }
    if up("status") != "COMPLETED" {
        return "pending";
    }
    match up("conclusion").as_str() {
        "SUCCESS" | "NEUTRAL" => "passed",
        "SKIPPED" => "skipped",
        "" => "pending",
        _ => "failed",
    }
}

fn gh_checks(v: &Value) -> Option<(Checks, Vec<Check>)> {
    let rows = v.get("statusCheckRollup")?.as_array()?;
    let mut sum = Checks::default();
    let mut list = Vec::new();
    for c in rows {
        let st = gh_check_state(c);
        match st {
            "passed" | "skipped" => sum.passed += 1,
            "failed" => sum.failed += 1,
            _ => sum.pending += 1,
        }
        sum.total += 1;
        let name = if c.get("name").is_some() { text(c, "name") } else { text(c, "context") };
        let url = if c.get("detailsUrl").is_some() { text(c, "detailsUrl") } else { text(c, "targetUrl") };
        list.push(Check { name: one_line(name, 120), state: st.into(), url: web_url(&url) });
    }
    Some((sum, list))
}

/// `u` when it is an https address (anything else is dropped: the page opens only https links from here).
pub(crate) fn web_url(u: &str) -> String {
    if u.starts_with("https://") && !u.chars().any(|c| c.is_whitespace() || c.is_control()) { u.to_string() } else { String::new() }
}

/// The repository a GitHub pull request's branch is in, and whether the host says it is the one the pull request is in: only
/// when `isCrossRepository` is false and the head repository (`headRepository.nameWithOwner`, else its owner's login and its
/// name) is the base repository its own address names. Anything the host did not say reads as another repository's.
pub(crate) fn gh_from(v: &Value, url: &str) -> (String, bool) {
    let owner = v.get("headRepositoryOwner").map(|o| text(o, "login")).unwrap_or_default();
    let repo = v.get("headRepository").filter(|r| r.is_object());
    let named = repo.map(|r| text(r, "nameWithOwner")).unwrap_or_default();
    let name = repo.map(|r| text(r, "name")).unwrap_or_default();
    let from = if !named.is_empty() { named } else if !owner.is_empty() && !name.is_empty() { format!("{owner}/{name}") } else { String::new() };
    let from = if from.split('/').count() == 2 && from.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | '/')) { from } else { String::new() };
    // `https://<host>/<owner>/<repo>/pull/<n>`: the repository the pull request is in, as the host itself names it
    let base = url.strip_prefix("https://").and_then(|rest| rest.split_once('/')).and_then(|(_, path)| path.split_once("/pull/")).map(|(r, _)| r.to_string()).unwrap_or_default();
    let cross = v.get("isCrossRepository").and_then(Value::as_bool);
    let same = cross == Some(false) && !from.is_empty() && from.eq_ignore_ascii_case(&base);
    (from, same)
}

/// Whether a GitLab merge request's branch is in its own project: `source_project_id` and `target_project_id` both given and
/// equal ("Equal to `target_project_id`, unless the merge request originates from a fork", GitLab's merge requests API).
pub(crate) fn gl_same_project(v: &Value) -> bool {
    let id = |k: &str| v.get(k).and_then(Value::as_u64);
    matches!((id("source_project_id"), id("target_project_id")), (Some(a), Some(b)) if a == b)
}

pub(crate) fn gh_item(v: &Value, change: bool) -> Item {
    let draft = v.get("isDraft").and_then(Value::as_bool).unwrap_or(false);
    let state = match text(v, "state").to_ascii_uppercase().as_str() {
        "MERGED" => "merged",
        "CLOSED" => "closed",
        _ if draft => "draft",
        _ => "open",
    };
    Item {
        number: v.get("number").and_then(Value::as_u64).unwrap_or(0),
        title: one_line(text(v, "title"), 300),
        state: state.into(),
        url: web_url(&text(v, "url")),
        labels: gh_labels(v),
        author: gh_author(v),
        created: epoch(&text(v, "createdAt")),
        updated: epoch(&text(v, "updatedAt")),
        checks: if change { Some(gh_checks(v).map(|c| c.0).unwrap_or_default()) } else { None },
        head: if change { one_line(text(v, "headRefName"), 250) } else { String::new() },
        same: change && gh_from(v, &web_url(&text(v, "url"))).1,
        from: if change { gh_from(v, &web_url(&text(v, "url"))).0 } else { String::new() },
    }
}

pub(crate) fn gl_item(v: &Value, change: bool) -> Item {
    let draft = v.get("draft").and_then(Value::as_bool).unwrap_or(false) || v.get("work_in_progress").and_then(Value::as_bool).unwrap_or(false);
    let state = match text(v, "state").as_str() {
        "merged" => "merged",
        "closed" | "locked" => "closed",
        _ if draft => "draft",
        _ => "open",
    };
    let labels = v
        .get("labels")
        .and_then(Value::as_array)
        .map(|ls| {
            ls.iter()
                .take(12)
                .filter_map(|l| l.as_str().map(|n| Label { name: one_line(n.to_string(), 60), color: String::new() }).or_else(|| Some(Label { name: one_line(text(l, "name"), 60), color: text(l, "color").trim_start_matches('#').to_string() })))
                .filter(|l| !l.name.is_empty())
                .collect()
        })
        .unwrap_or_default();
    let checks = if change {
        let p = v.get("head_pipeline").filter(|p| p.is_object()).or_else(|| v.get("pipeline").filter(|p| p.is_object()));
        Some(match p.map(|p| text(p, "status")).as_deref() {
            Some("success") => Checks { passed: 1, total: 1, ..Default::default() },
            Some("failed") | Some("canceled") => Checks { failed: 1, total: 1, ..Default::default() },
            Some("") | None => Checks::default(),
            Some(_) => Checks { pending: 1, total: 1, ..Default::default() },
        })
    } else {
        None
    };
    Item {
        number: v.get("iid").and_then(Value::as_u64).unwrap_or(0),
        title: one_line(text(v, "title"), 300),
        state: state.into(),
        url: web_url(&text(v, "web_url")),
        labels,
        author: v.get("author").map(|a| text(a, "username")).unwrap_or_default(),
        created: epoch(&text(v, "created_at")),
        updated: epoch(&text(v, "updated_at")),
        checks,
        head: if change { one_line(text(v, "source_branch"), 250) } else { String::new() },
        same: change && gl_same_project(v),
        from: String::new(),
    }
}

/// A list answer (a JSON array) as one page of items, and where the next GitHub page starts (None: no next page,
/// or GitLab, which pages by number). `page` is the page asked for, `after` the start `list_argv` was given.
pub fn parse_list(source: Source, kind: Kind, page: u32, after: Option<&After>, out: &str) -> Result<(Page, Option<After>), String> {
    let v: Value = serde_json::from_str(out.trim()).map_err(|e| format!("{} answered something that is not JSON: {e}", source.program()))?;
    let rows = v.as_array().ok_or_else(|| format!("{} did not answer a list", source.program()))?;
    let change = kind == Kind::Changes;
    Ok(match source {
        Source::Github => {
            let shown = |i: &Item| after.is_some_and(|a| i.created == a.created && a.seen.contains(&i.number));
            let mut items: Vec<Item> = rows.iter().map(|r| gh_item(r, change)).filter(|i| i.number > 0 && !shown(i)).collect();
            let more = items.len() > PAGE && page < MAX_PAGE;
            items.truncate(PAGE);
            let next = items.last().filter(|_| more).map(|last| {
                let mut seen: Vec<u64> = after.filter(|a| a.created == last.created).map(|a| a.seen.clone()).unwrap_or_default();
                seen.extend(items.iter().filter(|i| i.created == last.created).map(|i| i.number));
                After { created: last.created, seen }
            });
            (Page { items, more }, next)
        }
        Source::Gitlab => {
            let items: Vec<Item> = rows.iter().take(PAGE).map(|r| gl_item(r, change)).filter(|i| i.number > 0).collect();
            (Page { more: rows.len() >= PAGE && page < MAX_PAGE, items }, None)
        }
    })
}

/// A view answer as the drawer's detail.
pub fn parse_view(source: Source, kind: Kind, out: &str) -> Result<Detail, String> {
    let v: Value = serde_json::from_str(out.trim()).map_err(|e| format!("{} answered something that is not JSON: {e}", source.program()))?;
    if !v.is_object() {
        return Err(format!("{} did not answer an item", source.program()));
    }
    let change = kind == Kind::Changes;
    Ok(match source {
        Source::Github => {
            let comments = v
                .get("comments")
                .and_then(Value::as_array)
                .map(|cs| {
                    cs.iter()
                        .rev()
                        .take(MAX_COMMENTS)
                        .rev()
                        .map(|c| Comment { author: gh_author(c), body: clip(text(c, "body"), MAX_BODY), created: epoch(&text(c, "createdAt")) })
                        .collect()
                })
                .unwrap_or_default();
            Detail {
                item: gh_item(&v, change),
                body: clip(text(&v, "body"), MAX_BODY),
                comments,
                checks: if change { gh_checks(&v).map(|c| c.1).unwrap_or_default() } else { vec![] },
            }
        }
        Source::Gitlab => {
            let comments = v
                .get("notes")
                .or_else(|| v.get("comments"))
                .and_then(Value::as_array)
                .map(|cs| {
                    cs.iter()
                        .filter(|c| !c.get("system").and_then(Value::as_bool).unwrap_or(false))
                        .take(MAX_COMMENTS)
                        .map(|c| Comment { author: c.get("author").map(|a| text(a, "username")).unwrap_or_default(), body: clip(text(c, "body"), MAX_BODY), created: epoch(&text(c, "created_at")) })
                        .collect()
                })
                .unwrap_or_default();
            let mut checks = vec![];
            if change {
                if let Some(p) = v.get("head_pipeline").filter(|p| p.is_object()).or_else(|| v.get("pipeline").filter(|p| p.is_object())) {
                    let st = match text(p, "status").as_str() {
                        "success" => "passed",
                        "failed" | "canceled" => "failed",
                        "skipped" => "skipped",
                        _ => "pending",
                    };
                    checks.push(Check { name: format!("pipeline #{}", p.get("id").and_then(Value::as_u64).unwrap_or(0)), state: st.into(), url: web_url(&text(p, "web_url")) });
                }
            }
            Detail { item: gl_item(&v, change), body: clip(text(&v, "description"), MAX_BODY), comments, checks }
        }
    })
}

// ---- the repository of a folder (read from its git config file, no program) -------------------------

#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct Remote {
    pub source: String,
    pub repo: String,
}

/// The source and `owner/repo` of a remote address: `https://github.com/o/r(.git)`, `git@github.com:o/r.git`,
/// `ssh://git@github.com/o/r.git`, and the same for a host whose name has `gitlab` in it. Anything else: None.
pub fn parse_remote(url: &str) -> Option<Remote> {
    let u = url.trim();
    let (host, path) = if let Some(rest) = u.strip_prefix("https://").or_else(|| u.strip_prefix("http://")).or_else(|| u.strip_prefix("ssh://")).or_else(|| u.strip_prefix("git://")) {
        let rest = rest.rsplit_once('@').map(|(_, r)| r).filter(|r| !r.contains('/') || r.find('/') > Some(0)).unwrap_or(rest);
        let (host, path) = rest.split_once('/')?;
        (host.split(':').next()?.to_string(), path.to_string())
    } else if let Some((left, path)) = u.split_once(':') {
        let host = left.rsplit_once('@').map(|(_, h)| h).unwrap_or(left);
        if host.contains('/') {
            return None;
        }
        (host.to_string(), path.to_string())
    } else {
        return None;
    };
    let host = host.to_ascii_lowercase();
    let path = path.trim_matches('/');
    let path = path.strip_suffix(".git").unwrap_or(path);
    let source = if host == "github.com" || host == "www.github.com" {
        Source::Github
    } else if host.split('.').any(|p| p == "gitlab") {
        Source::Gitlab
    } else {
        return None;
    };
    let repo = check_repo(source, path).ok()?;
    Some(Remote { source: if source == Source::Github { "github".into() } else { "gitlab".into() }, repo })
}

fn read_small(p: &Path) -> Option<String> {
    let f = std::fs::File::open(p).ok()?;
    let mut s = String::new();
    f.take(256 * 1024).read_to_string(&mut s).ok()?;
    Some(s)
}

/// The `url` of remote `origin` (else the first remote) in a git config file's text.
pub fn config_remote_url(cfg: &str) -> Option<String> {
    let mut section: Option<String> = None;
    let mut first: Option<String> = None;
    for line in cfg.lines() {
        let l = line.trim();
        if l.starts_with('[') {
            section = l.strip_prefix("[remote \"").and_then(|r| r.strip_suffix("\"]")).map(str::to_string);
            continue;
        }
        let Some(name) = &section else { continue };
        if let Some((k, v)) = l.split_once('=') {
            if k.trim().eq_ignore_ascii_case("url") {
                let v = v.trim().trim_matches('"').to_string();
                if name == "origin" {
                    return Some(v);
                }
                first.get_or_insert(v);
            }
        }
    }
    first
}

/// The repository folder `cwd` is in, as a remote this page can list. Reads `.git/config` (for a worktree, the
/// main repository's, through `commondir`); runs nothing.
pub fn folder_remote(cwd: &Path) -> Option<Remote> {
    if !cwd.is_absolute() || !cwd.is_dir() {
        return None;
    }
    let git = crate::git_branch::git_dir(cwd)?;
    let common = read_small(&git.join("commondir")).map(|c| {
        let p = PathBuf::from(c.trim());
        if p.is_absolute() { p } else { git.join(p) }
    });
    let cfg = read_small(&common.unwrap_or(git).join("config"))?;
    parse_remote(&config_remote_url(&cfg)?)
}

// ---- running the CLI ----------------------------------------------------------------------------

fn host_env(k: &str) -> Option<String> {
    std::env::var(k).ok()
}

#[cfg(unix)]
fn is_program(p: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(p).map(|m| m.is_file() && m.permissions().mode() & 0o111 != 0).unwrap_or(false)
}

#[cfg(not(unix))]
fn is_program(p: &Path) -> bool {
    p.is_file()
}

/// Where `program` is on this computer (PATH plus the usual install folders), if anywhere.
pub fn find(program: &str) -> Option<PathBuf> {
    let os = Os::current();
    let dirs = search_dirs(&host_env, os);
    resolve(program, &dirs, is_program, os)
}

/// What a run gave: its exit code (None: killed or timed out) and its output.
pub struct Ran {
    pub code: Option<i32>,
    pub out: String,
    pub err: String,
}

/// Run `exe argv` with no shell, nothing on stdin, at most `TIMEOUT`. The CLI's prompts and colours are off. With
/// `keep` false its output goes nowhere (`auth status`, whose output can name a token): only the exit code is read.
fn run(exe: &Path, argv: &[String], keep: bool) -> Result<Ran, String> {
    run_env(exe, argv, keep, &[], &[])
}

/// `run`, with `env` added to this one child's environment only (gh_me.rs: `GH_HOST`, and a chosen GitHub account's
/// token for that one call) and the variables named in `unset` taken out of it. Nothing in `env` is logged, kept or
/// put in an error line here.
pub fn run_env(exe: &Path, argv: &[String], keep: bool, env: &[(&str, &str)], unset: &[&str]) -> Result<Ran, String> {
    run_full(exe, argv, keep, &[], env, unset)
}

/// `run_env`, with `inherited` set first as if manut itself had been started with it (gh_me.rs's tests: an inherited
/// token without touching this process's environment), so `unset` takes it out as it would the real one.
pub(crate) fn run_full(exe: &Path, argv: &[String], keep: bool, inherited: &[(&str, &str)], env: &[(&str, &str)], unset: &[&str]) -> Result<Ran, String> {
    run_until(exe, argv, keep, inherited, env, unset, TIMEOUT, MAX_OUT)
}

/// `run_env` with a deadline of its own instead of `TIMEOUT`: lane.rs makes and removes a lane's working folder, which
/// writes or deletes every file a project tracks and can take longer than a read on a large project.
pub(crate) fn run_env_for(exe: &Path, argv: &[String], keep: bool, env: &[(&str, &str)], unset: &[&str], limit: Duration) -> Result<Ran, String> {
    run_until(exe, argv, keep, &[], env, unset, limit, MAX_OUT)
}

/// `run` with a deadline and a byte cap of the caller's own: at most `cap` bytes of the program's output are read, and
/// the rest is never read at all (tailscale.rs, whose `status --json` answers a few kilobytes and is never trusted to
/// stay small).
pub(crate) fn run_capped(exe: &Path, argv: &[String], limit: Duration, cap: u64) -> Result<Ran, String> {
    run_until(exe, argv, true, &[], &[], &[], limit, cap)
}

#[allow(clippy::too_many_arguments)]
fn run_until(exe: &Path, argv: &[String], keep: bool, inherited: &[(&str, &str)], env: &[(&str, &str)], unset: &[&str], limit: Duration, cap: u64) -> Result<Ran, String> {
    let out = || if keep { Stdio::piped() } else { Stdio::null() };
    let mut cmd = Command::new(exe);
    cmd.args(argv)
        .stdin(Stdio::null())
        .stdout(out())
        .stderr(out())
        .env("GH_PROMPT_DISABLED", "1")
        .env("GH_NO_UPDATE_NOTIFIER", "1")
        .env("GLAB_NO_PROMPT", "1")
        .env("NO_COLOR", "1");
    for (k, v) in inherited {
        cmd.env(k, v);
    }
    for k in unset {
        cmd.env_remove(k);
    }
    for (k, v) in env {
        cmd.env(k, v);
    }
    // A release build has no console of its own, so each `gh`/`glab` read would flash a console window and take the
    // focus from the app: the same reason the bridge hides python.exe (bridge.rs `no_console_window`).
    crate::platform::no_console_window(&mut cmd);
    crate::appimage::host_env(&mut cmd);
    let mut child = cmd.spawn().map_err(|e| format!("could not start {}: {e}", exe.display()))?;
    let so = child.stdout.take();
    let se = child.stderr.take();
    let to = std::thread::spawn(move || {
        let mut b = Vec::new();
        if let Some(mut so) = so {
            let _ = (&mut so).take(cap).read_to_end(&mut b);
        }
        b
    });
    let te = std::thread::spawn(move || {
        let mut b = Vec::new();
        if let Some(mut se) = se {
            let _ = (&mut se).take(64 * 1024).read_to_end(&mut b);
        }
        b
    });
    let start = Instant::now();
    let code = loop {
        match child.try_wait() {
            Ok(Some(st)) => break st.code(),
            Ok(None) if start.elapsed() >= limit => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!("{} did not answer within {} seconds", exe.file_name().unwrap_or_default().to_string_lossy(), limit.as_secs()));
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(40)),
            Err(e) => return Err(e.to_string()),
        }
    };
    let out = String::from_utf8_lossy(&to.join().unwrap_or_default()).into_owned();
    let err = String::from_utf8_lossy(&te.join().unwrap_or_default()).into_owned();
    Ok(Ran { code, out, err })
}

/// The last non-empty line of an error answer, short, with anything token-like masked.
pub fn error_line(err: &str) -> String {
    let line = err.lines().map(str::trim).filter(|l| !l.is_empty()).last().unwrap_or("");
    one_line(mask_secrets(line), 200)
}

/// The answers of the last minute, by argv, and where each GitHub page read so far ends.
#[derive(Default)]
pub struct Tasks {
    cache: Mutex<HashMap<String, (Instant, String)>>,
    status: Mutex<HashMap<&'static str, (Instant, Status)>>,
    /// `<kind>\0<repo>\0<filter>` -> page -> where it starts (kept while manut runs, at most 64 lists)
    starts: Mutex<HashMap<String, HashMap<u32, After>>>,
}

impl Tasks {
    fn cached(&self, key: &str) -> Option<String> {
        let c = self.cache.lock().ok()?;
        c.get(key).filter(|(at, _)| at.elapsed() < KEEP).map(|(_, v)| v.clone())
    }

    fn keep(&self, key: String, v: String) {
        if let Ok(mut c) = self.cache.lock() {
            c.retain(|_, (at, _)| at.elapsed() < KEEP);
            c.insert(key, (Instant::now(), v));
        }
    }

    /// Whether the source's CLI is here and signed in (kept 60 seconds; `fresh` asks again).
    pub fn status(&self, source: Source, fresh: bool) -> Status {
        let p = source.program();
        if !fresh {
            if let Some((at, st)) = self.status.lock().ok().and_then(|c| c.get(p).cloned()) {
                if at.elapsed() < KEEP {
                    return st;
                }
            }
        }
        let st = match find(p) {
            None => Status { installed: false, signed_in: false },
            Some(exe) => Status { installed: true, signed_in: matches!(run(&exe, &auth_argv(source), false), Ok(Ran { code: Some(0), .. })) },
        };
        if let Ok(mut c) = self.status.lock() {
            c.insert(p, (Instant::now(), st.clone()));
        }
        st
    }

    fn answer(&self, source: Source, argv: Vec<String>) -> Result<String, String> {
        let key = format!("{}\0{}", source.program(), argv.join("\0"));
        if let Some(v) = self.cached(&key) {
            return Ok(v);
        }
        let exe = find(source.program()).ok_or_else(|| format!("{} is not installed", source.program()))?;
        let ran = run(&exe, &argv, true)?;
        if ran.code != Some(0) {
            let line = error_line(&ran.err);
            return Err(if line.is_empty() { format!("{} failed", source.program()) } else { line });
        }
        self.keep(key, ran.out.clone());
        Ok(ran.out)
    }

    pub fn list(&self, source: Source, kind: Kind, repo: &str, filter: Filter, page: u32) -> Result<Page, String> {
        self.list_with(source, kind, repo, filter, page, "", |argv| self.answer(source, argv))
    }

    /// `list`, with `ask` running the argv (tests answer from a recorded list; a chosen GitHub account's calls go
    /// through gh_me.rs). `who`: the account the pages are read as ("": the CLI's own), so each keeps its own starts.
    pub fn list_with(&self, source: Source, kind: Kind, repo: &str, filter: Filter, page: u32, who: &str, ask: impl FnOnce(Vec<String>) -> Result<String, String>) -> Result<Page, String> {
        let key = format!("{who}\0{kind:?}\0{repo}\0{filter:?}");
        let after = if source == Source::Github && page > 0 { self.starts.lock().ok().and_then(|m| m.get(&key).and_then(|p| p.get(&page)).cloned()) } else { None };
        let Some(argv) = list_argv(source, kind, repo, filter, page, after.as_ref())? else {
            return Ok(Page::default());
        };
        let (out, next) = parse_list(source, kind, page, after.as_ref(), &ask(argv)?)?;
        if let (Some(next), Ok(mut m)) = (next, self.starts.lock()) {
            if m.len() >= 64 && !m.contains_key(&key) {
                m.clear();
            }
            m.entry(key).or_default().insert(page + 1, next);
        }
        Ok(out)
    }

    pub fn view(&self, source: Source, kind: Kind, repo: &str, number: u64) -> Result<Detail, String> {
        self.view_with(source, kind, repo, number, |argv| self.answer(source, argv))
    }

    /// `view`, with `ask` running the argv (a chosen GitHub account's call goes through gh_me.rs).
    pub fn view_with(&self, source: Source, kind: Kind, repo: &str, number: u64, ask: impl FnOnce(Vec<String>) -> Result<String, String>) -> Result<Detail, String> {
        let argv = view_argv(source, kind, repo, number)?;
        parse_view(source, kind, &ask(argv)?)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const GH_ISSUES: &str = include_str!("tasks_fixtures/gh-issue-list.json");
    const GH_PRS: &str = include_str!("tasks_fixtures/gh-pr-list.json");
    const GH_ISSUE: &str = include_str!("tasks_fixtures/gh-issue-view.json");
    const GH_PR: &str = include_str!("tasks_fixtures/gh-pr-view.json");
    const GL_ISSUES: &str = include_str!("tasks_fixtures/glab-issue-list.json");
    const GL_MR: &str = include_str!("tasks_fixtures/glab-mr-view.json");

    #[test]
    fn repository_names_are_checked() {
        let table: &[(Source, &str, bool)] = &[
            (Source::Github, "rlaope/oh-my-hermes", true),
            (Source::Github, "a.b_c-d/E.F_g-1", true),
            (Source::Github, "owner", false),
            (Source::Github, "a/b/c", false),
            (Source::Github, "-R/x", false),
            (Source::Github, "o/--json", false),
            (Source::Github, "../etc", false),
            (Source::Github, "o/.git", false),
            (Source::Github, "o/r x", false),
            (Source::Github, "o/r;rm", false),
            (Source::Github, "o/r\n", false),
            (Source::Github, "", false),
            (Source::Github, "o/", false),
            (Source::Gitlab, "group/sub/project", true),
            (Source::Gitlab, "a/b/c/d/e/f", true),
            (Source::Gitlab, "a/b/c/d/e/f/g", false),
            (Source::Gitlab, "group/-x", false),
            (Source::Gitlab, "https://gitlab.com/a/b", false),
        ];
        for (src, repo, ok) in table {
            assert_eq!(check_repo(*src, repo).is_ok(), *ok, "{src:?} {repo:?}");
        }
    }

    #[test]
    fn list_argv_table() {
        let r = "rlaope/oh-my-hermes";
        let j = |a: Vec<String>| a.join(" ");
        let table: &[(Source, Kind, Filter, u32, Option<&str>)] = &[
            (Source::Github, Kind::Issues, Filter::Open, 0, Some("issue list --repo rlaope/oh-my-hermes --state open --json number,title,state,url,labels,author,createdAt,updatedAt --limit 26 --search sort:created-desc")),
            (Source::Github, Kind::Issues, Filter::Assigned, 1, Some("issue list --repo rlaope/oh-my-hermes --state open --json number,title,state,url,labels,author,createdAt,updatedAt --limit 28 --assignee @me --search sort:created-desc created:<=2026-11-15T18:19:59Z")),
            (Source::Github, Kind::Issues, Filter::Created, 0, Some("issue list --repo rlaope/oh-my-hermes --state open --json number,title,state,url,labels,author,createdAt,updatedAt --limit 26 --author @me --search sort:created-desc")),
            (Source::Github, Kind::Issues, Filter::Mentioned, 0, Some("issue list --repo rlaope/oh-my-hermes --state open --json number,title,state,url,labels,author,createdAt,updatedAt --limit 26 --mention @me --search sort:created-desc")),
            (Source::Github, Kind::Changes, Filter::Mentioned, 7, Some("pr list --repo rlaope/oh-my-hermes --state open --json number,title,state,url,labels,author,createdAt,updatedAt,isDraft,headRefName,statusCheckRollup,isCrossRepository,headRepository,headRepositoryOwner --limit 28 --search mentions:@me sort:created-desc created:<=2026-11-15T18:19:59Z")),
            (Source::Github, Kind::Changes, Filter::Assigned, 0, Some("pr list --repo rlaope/oh-my-hermes --state open --json number,title,state,url,labels,author,createdAt,updatedAt,isDraft,headRefName,statusCheckRollup,isCrossRepository,headRepository,headRepositoryOwner --limit 26 --assignee @me --search sort:created-desc")),
            (Source::Gitlab, Kind::Issues, Filter::Open, 2, Some("issue list --repo rlaope/oh-my-hermes --output json --per-page 25 --page 3")),
            (Source::Gitlab, Kind::Changes, Filter::Created, 0, Some("mr list --repo rlaope/oh-my-hermes --output json --per-page 25 --page 1 --author=@me")),
            (Source::Gitlab, Kind::Changes, Filter::Assigned, 0, Some("mr list --repo rlaope/oh-my-hermes --output json --per-page 25 --page 1 --assignee=@me")),
            (Source::Gitlab, Kind::Issues, Filter::Mentioned, 0, None),
        ];
        let after = After { created: 1_794_766_799, seen: vec![9, 8] };
        for (src, kind, f, page, want) in table {
            let at = (*page > 0 && *src == Source::Github).then_some(&after);
            let got = list_argv(*src, *kind, r, *f, *page, at).unwrap().map(j);
            assert_eq!(got.as_deref(), *want, "{src:?} {kind:?} {f:?} {page}");
        }
        assert!(list_argv(Source::Github, Kind::Issues, r, Filter::Open, MAX_PAGE + 1, Some(&after)).is_err());
        assert!(list_argv(Source::Gitlab, Kind::Issues, r, Filter::Open, MAX_PAGE + 1, None).is_err());
        assert!(list_argv(Source::Github, Kind::Issues, "x/--web", Filter::Open, 0, None).is_err());
        // a GitHub page after the first starts where the page before ended, never from the top
        assert!(list_argv(Source::Github, Kind::Issues, r, Filter::Open, 3, None).is_err());
        let crowded = After { created: 0, seen: (0..=MAX_SEEN as u64).collect() };
        assert!(list_argv(Source::Github, Kind::Issues, r, Filter::Open, 3, Some(&crowded)).is_err());
        assert_eq!(iso(1_794_766_799), "2026-11-15T18:19:59Z");
        assert_eq!(iso(0), "1970-01-01T00:00:00Z");
        assert_eq!(iso(951_782_400), "2000-02-29T00:00:00Z");
    }

    #[test]
    fn view_argv_table() {
        let r = "rlaope/oh-my-hermes";
        assert_eq!(view_argv(Source::Github, Kind::Issues, r, 12).unwrap().join(" "), "issue view 12 --repo rlaope/oh-my-hermes --json number,title,state,url,body,author,createdAt,updatedAt,labels,comments");
        assert_eq!(
            view_argv(Source::Github, Kind::Changes, r, 2907).unwrap().join(" "),
            "pr view 2907 --repo rlaope/oh-my-hermes --json number,title,state,url,body,author,createdAt,updatedAt,labels,comments,isDraft,headRefName,statusCheckRollup"
        );
        assert_eq!(view_argv(Source::Gitlab, Kind::Issues, "g/s/p", 3).unwrap().join(" "), "issue view 3 --repo g/s/p --output json");
        assert_eq!(view_argv(Source::Gitlab, Kind::Changes, "g/p", 9).unwrap().join(" "), "mr view 9 --repo g/p --output json");
        assert!(view_argv(Source::Github, Kind::Issues, r, 0).is_err());
        assert_eq!(auth_argv(Source::Github), vec!["auth", "status"]);
    }

    #[test]
    fn every_argv_is_a_read() {
        // the second word of every argv this module builds is `list`, `view` or `status`: nothing that writes
        let mut all = vec![auth_argv(Source::Github), auth_argv(Source::Gitlab)];
        for src in [Source::Github, Source::Gitlab] {
            for kind in [Kind::Issues, Kind::Changes] {
                for f in [Filter::Assigned, Filter::Created, Filter::Mentioned, Filter::Open] {
                    all.extend(list_argv(src, kind, "o/r", f, 0, None).unwrap());
                }
                all.push(view_argv(src, kind, "o/r", 1).unwrap());
            }
        }
        for a in all {
            assert!(matches!(a[1].as_str(), "list" | "view" | "status"), "{a:?}");
            for w in ["create", "close", "edit", "comment", "merge", "delete", "reopen", "review", "--web", "-X", "api"] {
                assert!(!a.iter().any(|x| x == w), "{a:?} has {w}");
            }
        }
    }

    #[test]
    fn parses_recorded_gh_issue_list() {
        let (p, next) = parse_list(Source::Github, Kind::Issues, 0, None, GH_ISSUES).unwrap();
        assert_eq!(p.items.len(), 4);
        assert!(!p.more && next.is_none());
        let i = &p.items[1];
        assert!(i.number > 0 && !i.title.is_empty());
        assert_eq!(i.state, "open");
        assert!(i.url.starts_with("https://github.com/rlaope/oh-my-hermes/issues/"));
        assert!(i.author.starts_with("person"));
        assert!(i.created > 1_700_000_000);
        assert!(i.labels.iter().any(|l| l.name == "enhancement" && l.color == "a2eeef"));
        assert!(i.checks.is_none());
    }

    #[test]
    fn parses_recorded_gh_pr_list_with_checks() {
        let (p, _) = parse_list(Source::Github, Kind::Changes, 0, None, GH_PRS).unwrap();
        assert_eq!(p.items.len(), 3);
        let first = &p.items[0];
        assert_eq!(first.state, "merged");
        let c = first.checks.as_ref().unwrap();
        assert_eq!(c.total, 4);
        assert_eq!(c.failed, 0);
        assert_eq!(c.passed + c.pending, 4);
    }

    #[test]
    fn parses_recorded_gh_views() {
        let d = parse_view(Source::Github, Kind::Issues, GH_ISSUE).unwrap();
        assert!(d.body.len() > 100);
        assert!(d.checks.is_empty());
        assert_eq!(d.comments.len(), 1);
        assert!(d.comments[0].author.starts_with("person"));
        let d = parse_view(Source::Github, Kind::Changes, GH_PR).unwrap();
        assert_eq!(d.item.number, 2907);
        assert_eq!(d.checks.len(), 5);
        assert!(d.checks.iter().all(|c| c.url.starts_with("https://github.com/")));
        assert!(d.checks.iter().any(|c| c.state == "passed"));
    }

    #[test]
    fn check_states() {
        let t: &[(&str, &str)] = &[
            (r#"{"__typename":"CheckRun","status":"COMPLETED","conclusion":"SUCCESS"}"#, "passed"),
            (r#"{"__typename":"CheckRun","status":"COMPLETED","conclusion":"FAILURE"}"#, "failed"),
            (r#"{"__typename":"CheckRun","status":"COMPLETED","conclusion":"CANCELLED"}"#, "failed"),
            (r#"{"__typename":"CheckRun","status":"COMPLETED","conclusion":"SKIPPED"}"#, "skipped"),
            (r#"{"__typename":"CheckRun","status":"IN_PROGRESS","conclusion":""}"#, "pending"),
            (r#"{"__typename":"StatusContext","state":"SUCCESS"}"#, "passed"),
            (r#"{"__typename":"StatusContext","state":"ERROR"}"#, "failed"),
            (r#"{"__typename":"StatusContext","state":"PENDING"}"#, "pending"),
        ];
        for (j, want) in t {
            assert_eq!(gh_check_state(&serde_json::from_str(j).unwrap()), *want, "{j}");
        }
        let draft = r#"[{"number":5,"title":"x","state":"OPEN","isDraft":true,"statusCheckRollup":[]}]"#;
        let (p, _) = parse_list(Source::Github, Kind::Changes, 0, None, draft).unwrap();
        assert_eq!(p.items[0].state, "draft");
        assert_eq!(p.items[0].checks, Some(Checks::default()));
    }

    #[test]
    fn a_change_carries_the_branch_it_is_made_from_and_an_issue_none() {
        // item 76: the Code page matches a lane's branch to the open pull requests it already lists
        let gh = r#"[{"number":8,"title":"x","state":"OPEN","isDraft":false,"headRefName":"kit/promptpay-qr","statusCheckRollup":[]}]"#;
        let (p, _) = parse_list(Source::Github, Kind::Changes, 0, None, gh).unwrap();
        assert_eq!(p.items[0].head, "kit/promptpay-qr");
        // an answer without the field (an older gh) reads as no branch, never an error
        let old = r#"[{"number":9,"title":"x","state":"OPEN","statusCheckRollup":[]}]"#;
        assert_eq!(parse_list(Source::Github, Kind::Changes, 0, None, old).unwrap().0.items[0].head, "");
        let issue = r#"[{"number":3,"title":"x","state":"OPEN","headRefName":"not-a-branch"}]"#;
        assert_eq!(parse_list(Source::Github, Kind::Issues, 0, None, issue).unwrap().0.items[0].head, "");
        let gl = r#"[{"iid":4,"title":"x","state":"opened","source_branch":"kit/fix-sso","web_url":"https://gitlab.com/g/p/-/merge_requests/4"}]"#;
        let (p, _) = parse_list(Source::Gitlab, Kind::Changes, 0, None, gl).unwrap();
        assert_eq!(p.items[0].head, "kit/fix-sso");
    }

    #[test]
    fn a_change_says_whether_its_branch_is_in_this_repository_or_another_s() {
        // item 86: a fork's request on a branch named like a lane's must never stand for the lane's
        let own = r#"[{"number":8,"title":"x","state":"OPEN","headRefName":"kit/qr","url":"https://github.com/o/r/pull/8","isCrossRepository":false,"headRepositoryOwner":{"login":"o"},"headRepository":{"name":"r","nameWithOwner":"o/r"}}]"#;
        let it = &parse_list(Source::Github, Kind::Changes, 0, None, own).unwrap().0.items[0];
        assert_eq!((it.same, it.from.as_str()), (true, "o/r"));
        let fork = r#"[{"number":9,"title":"x","state":"OPEN","headRefName":"kit/qr","url":"https://github.com/o/r/pull/9","isCrossRepository":true,"headRepositoryOwner":{"login":"stranger"},"headRepository":{"name":"r","nameWithOwner":"stranger/r"}}]"#;
        let it = &parse_list(Source::Github, Kind::Changes, 0, None, fork).unwrap().0.items[0];
        assert_eq!((it.same, it.from.as_str()), (false, "stranger/r"));
        // an answer that does not say (an older gh) is not taken as this repository's
        let old = r#"[{"number":9,"title":"x","state":"OPEN","headRefName":"kit/qr","url":"https://github.com/o/r/pull/9"}]"#;
        assert!(!parse_list(Source::Github, Kind::Changes, 0, None, old).unwrap().0.items[0].same);
        let gl = |src: u64, dst: u64| format!(r#"[{{"iid":4,"title":"x","state":"opened","source_branch":"kit/qr","source_project_id":{src},"target_project_id":{dst}}}]"#);
        assert!(parse_list(Source::Gitlab, Kind::Changes, 0, None, &gl(5, 5)).unwrap().0.items[0].same);
        assert!(!parse_list(Source::Gitlab, Kind::Changes, 0, None, &gl(6, 5)).unwrap().0.items[0].same);
    }

    #[test]
    fn parses_gitlab_shapes() {
        let (p, _) = parse_list(Source::Gitlab, Kind::Issues, 0, None, GL_ISSUES).unwrap();
        assert_eq!(p.items.len(), 2);
        assert_eq!(p.items[0].number, 42);
        assert_eq!(p.items[0].state, "open");
        assert_eq!(p.items[0].labels[0].name, "bug");
        assert_eq!(p.items[0].author, "person1");
        assert!(p.items[0].url.starts_with("https://gitlab.com/"));
        let d = parse_view(Source::Gitlab, Kind::Changes, GL_MR).unwrap();
        assert_eq!(d.item.state, "draft");
        assert_eq!(d.item.checks, Some(Checks { failed: 1, total: 1, ..Default::default() }));
        assert_eq!(d.checks[0].state, "failed");
        assert!(d.body.contains("Fixes"));
    }

    #[test]
    fn bad_answers_are_errors_not_panics() {
        for out in ["", "not json", "{}", "[1,2", "null"] {
            assert!(parse_list(Source::Github, Kind::Issues, 0, None, out).is_err(), "{out:?}");
        }
        assert!(parse_view(Source::Github, Kind::Issues, "[]").is_err());
        // a row with no number is dropped; an http (not https) link is dropped
        let (p, _) = parse_list(Source::Github, Kind::Issues, 0, None, r#"[{"title":"x"},{"number":3,"title":"y","url":"http://evil"}]"#).unwrap();
        assert_eq!(p.items.len(), 1);
        assert_eq!(p.items[0].url, "");
    }

    #[test]
    fn rfc3339_times() {
        assert_eq!(epoch("1970-01-01T00:00:00Z"), 0);
        assert_eq!(epoch("2026-11-15T18:19:59Z"), 1_794_766_799);
        assert_eq!(epoch("2026-11-16T03:19:59+09:00"), 1_794_766_799);
        assert_eq!(epoch("2026-11-15T18:19:59.123Z"), 1_794_766_799);
        assert_eq!(epoch("yesterday"), 0);
    }

    #[test]
    fn remotes() {
        let t: &[(&str, Option<(&str, &str)>)] = &[
            ("https://github.com/rlaope/oh-my-hermes.git", Some(("github", "rlaope/oh-my-hermes"))),
            ("https://github.com/rlaope/oh-my-hermes", Some(("github", "rlaope/oh-my-hermes"))),
            ("git@github.com:rlaope/oh-my-hermes.git", Some(("github", "rlaope/oh-my-hermes"))),
            ("ssh://git@github.com/rlaope/oh-my-hermes.git", Some(("github", "rlaope/oh-my-hermes"))),
            ("https://user@github.com/o/r", Some(("github", "o/r"))),
            ("git@gitlab.com:group/sub/proj.git", Some(("gitlab", "group/sub/proj"))),
            ("https://gitlab.example.org/g/p.git", Some(("gitlab", "g/p"))),
            ("https://bitbucket.org/o/r.git", None),
            ("/srv/git/r.git", None),
            ("https://github.com/o/r/extra", None),
        ];
        for (u, want) in t {
            let got = parse_remote(u).map(|r| (r.source, r.repo));
            assert_eq!(got, want.map(|(a, b)| (a.to_string(), b.to_string())), "{u}");
        }
        let cfg = "[core]\n\tbare = false\n[remote \"upstream\"]\n\turl = git@github.com:a/b.git\n[remote \"origin\"]\n\turl = https://github.com/c/d.git\n";
        assert_eq!(config_remote_url(cfg).as_deref(), Some("https://github.com/c/d.git"));
        assert_eq!(config_remote_url("[remote \"up\"]\nurl = x\n").as_deref(), Some("x"));
        assert_eq!(config_remote_url("[core]\n"), None);
    }

    #[test]
    fn folder_remote_reads_the_config_of_a_repo_and_its_worktree() {
        let d = std::env::temp_dir().join(format!("manut-tasks-remote-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(d.join("main/.git/worktrees/wt")).unwrap();
        std::fs::create_dir_all(d.join("main/src")).unwrap();
        std::fs::create_dir_all(d.join("wt")).unwrap();
        let d = d.canonicalize().unwrap();
        std::fs::write(d.join("main/.git/config"), "[remote \"origin\"]\n\turl = git@github.com:rlaope/oh-my-hermes.git\n").unwrap();
        std::fs::write(d.join("main/.git/worktrees/wt/commondir"), "../..\n").unwrap();
        std::fs::write(d.join("wt/.git"), format!("gitdir: {}\n", d.join("main/.git/worktrees/wt").display())).unwrap();
        let want = Some(Remote { source: "github".into(), repo: "rlaope/oh-my-hermes".into() });
        assert_eq!(folder_remote(&d.join("main/src")), want);
        assert_eq!(folder_remote(&d.join("wt")), want);
        assert_eq!(folder_remote(Path::new("relative")), None);
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn error_lines_hide_tokens() {
        let old = format!("warn\nHTTP 401: Bad credentials gho_{}\n", "a".repeat(36));
        assert_eq!(error_line(&old), "HTTP 401: Bad credentials ••••");
        let fake = format!("ghp_{}", "X".repeat(36));
        assert_eq!(error_line(&format!("failure credential={fake}")), "failure credential=••••");
        assert_eq!(error_line(&format!("bad token ({fake}), retry")), "bad token (••••), retry");
        assert_eq!(error_line(""), "");
    }

    /// A gh stand-in over `rows` (newest first): honours `--limit` and `created:<=` in `--search`, as gh does.
    fn fake_gh(rows: &[Value], argv: &[String]) -> String {
        let at = |k: &str| argv.iter().position(|a| a == k).map(|i| argv[i + 1].clone());
        let limit: usize = at("--limit").unwrap().parse().unwrap();
        let search = at("--search").unwrap();
        assert!(search.contains("sort:created-desc"), "{search}");
        let bound = search.split(' ').find_map(|w| w.strip_prefix("created:<=")).map(epoch);
        let out: Vec<&Value> = rows.iter().filter(|r| bound.is_none_or(|b| epoch(r["createdAt"].as_str().unwrap()) <= b)).take(limit).collect();
        serde_json::to_string(&out).unwrap()
    }

    #[test]
    fn every_page_of_a_long_list_is_reachable_with_bounded_calls() {
        // several items opened in the same second, so ties cross page edges
        for (n, per_second) in [(500u64, 3i64), (1001, 4), (201, 1), (25, 1), (26, 7), (0, 1)] {
            let base = 1_794_766_799i64;
            let rows: Vec<Value> = (1..=n).rev().map(|k| serde_json::json!({"number": k, "title": format!("issue {k}"), "createdAt": iso(base - (n - k) as i64 / per_second)})).collect();
            let t = Tasks::default();
            let mut seen = Vec::new();
            let mut biggest = 0;
            for page in 0..=MAX_PAGE {
                let p = t
                    .list_with(Source::Github, Kind::Issues, "o/r", Filter::Open, page, "", |argv| {
                        biggest = biggest.max(argv[argv.iter().position(|a| a == "--limit").unwrap() + 1].parse::<usize>().unwrap());
                        Ok(fake_gh(&rows, &argv))
                    })
                    .unwrap();
                seen.extend(p.items.iter().map(|i| i.number));
                if !p.more {
                    break;
                }
                assert_eq!(p.items.len(), PAGE, "a page before the last is full");
            }
            let want: Vec<u64> = (1..=n).rev().collect();
            assert_eq!(seen, want, "{n} items: every one, once, newest first");
            assert!(biggest <= PAGE + 1 + per_second as usize, "{n}: one call asked for {biggest} rows");
        }
    }

    #[test]
    fn item_text_is_masked_by_the_one_masker() {
        let fake = format!("ghp_{}", "X".repeat(36));
        let view = serde_json::json!({"number": 1, "title": format!("leak {fake}"), "body": format!("example credential {fake}\n```sh\nexport GH_TOKEN={fake}\n```\n[link](https://example.com/?token=abc123)"), "comments": [{"author": {"login": "p"}, "body": format!("password=hunter2 and glpat-{}", "Y".repeat(20))}], "labels": [{"name": format!("sk-{}", "Z".repeat(20)), "color": "fff"}]}).to_string();
        let d = parse_view(Source::Github, Kind::Issues, &view).unwrap();
        let all = serde_json::to_string(&d).unwrap();
        for bad in [fake.as_str(), "hunter2", "abc123", "glpat-", "sk-Z"] {
            assert!(!all.contains(bad), "{bad} in {all}");
        }
        assert_eq!(d.item.title, "leak ••••");
        assert_eq!(d.body, "example credential ••••\n```sh\nexport GH_TOKEN=••••\n```\n[link](https://example.com/?token=••••)");
        assert_eq!(d.comments[0].body, "password=•••• and ••••");
        let (p, _) = parse_list(Source::Github, Kind::Issues, 0, None, &format!("[{view}]")).unwrap();
        assert_eq!(p.items[0].title, "leak ••••");
        // the same patterns as the page's and the bridge's (src/lib/secrets.json); ordinary words stay
        for plain in ["task-management works", "a risk-assessment", "the token is in the vault", "password: see wiki"] {
            assert_eq!(mask_secrets(plain), plain);
        }
    }

    #[test]
    fn the_shared_masker_table() {
        // src/lib/secrets.cases.json: the same table the page (secrets.test.ts) and the bridge (OneMasker) run
        let v: Value = serde_json::from_str(include_str!("../../src/lib/secrets.cases.json")).unwrap();
        let cases = v["cases"].as_array().unwrap();
        assert!(cases.len() > 120);
        for c in cases {
            assert_eq!(mask_secrets(c[0].as_str().unwrap()), c[1].as_str().unwrap(), "{c}");
        }
        // what an approval shows (item 117): the command form, the same rows the page runs
        let command = v["command"].as_array().unwrap();
        assert!(command.len() > 25);
        // a value also stops at a backslash; a key block on one line keeps its own, which escape only its masked characters;
        // a key block's body becomes one line, so only its line breaks may go
        let shell = |s: &str| s.chars().filter(|c| "`$()|;&<>{}\n".contains(*c)).collect::<String>();
        let block = Regex::new(r"-{4,5} ?BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY").unwrap();
        for c in command {
            let (text, want) = (c[0].as_str().unwrap(), c[1].as_str().unwrap());
            let shown = show_command(text);
            assert_eq!(shown.text, want, "{c}");
            // a row's third field names the notes the card adds: `unmasked` when the line is shown as it is (item 121)
            let notes = c.get(2).and_then(Value::as_str).unwrap_or("");
            assert_eq!(shown.unmasked, notes.split(' ').any(|n| n == "unmasked"), "{c}");
        }
        // a mask stands for part of one word, so the line a person reads splits where the line that runs does (item 121)
        for c in command.iter().chain(cases) {
            let text = c[0].as_str().unwrap();
            assert_eq!(shell_words(&mask_command(text)).len(), shell_words(text).len(), "{c}");
        }
        // the structural check itself, on lines a masker must never be let show
        let shape = v["shape"].as_array().unwrap();
        assert!(shape.len() > 8);
        for c in shape {
            assert_eq!(same_shape(c[0].as_str().unwrap(), c[1].as_str().unwrap()), c[2].as_bool().unwrap(), "{c}");
        }
        for c in command.iter().chain(cases) {
            let text = c[0].as_str().unwrap();
            let lines = |x: String| if block.is_match(text) { x.replace('\n', "") } else { x };
            assert_eq!(lines(shell(&mask_command(text))), lines(shell(text)), "{c}");
        }
        // an sk- key of 32 lowercase hex, built here so no scanner reads the table as a live key
        let key = format!("sk-{}", "0a1b2c3d".repeat(4));
        assert_eq!(mask_secrets(&format!("deepseek {key} done")), "deepseek •••• done");
        assert_eq!(mask_command(&format!("DEEPSEEK={key} pnpm test")), "DEEPSEEK=•••• pnpm test");
        // the verifier's V4 (PR #2908): a token broken by a line break, through parse_view
        let raw = serde_json::json!({"number": 1, "title": "safe", "body": format!("before ghp_XXXX\n{} after", "X".repeat(32))}).to_string();
        assert_eq!(parse_view(Source::Github, Kind::Issues, &raw).unwrap().body, "before •••• after");
    }

    /// The real smoke on this computer: `cargo test tasks::tests::real_gh -- --ignored --nocapture`. Lists the open
    /// issues and pull requests of rlaope/oh-my-hermes through the same code the app runs.
    #[test]
    #[ignore]
    fn real_gh() {
        let t = Tasks::default();
        let st = t.status(Source::Github, true);
        println!("gh status: {st:?}");
        assert!(st.installed && st.signed_in);
        let issues = t.list(Source::Github, Kind::Issues, "rlaope/oh-my-hermes", Filter::Open, 0).unwrap();
        println!("open issues (page 1): {} more={}", issues.items.len(), issues.more);
        for i in issues.items.iter().take(5) {
            println!("  #{} {} [{}] labels={}", i.number, i.title, i.state, i.labels.len());
        }
        let prs = t.list(Source::Github, Kind::Changes, "rlaope/oh-my-hermes", Filter::Open, 0).unwrap();
        println!("open PRs (page 1): {} more={}", prs.items.len(), prs.more);
        for p in prs.items.iter().take(5) {
            println!("  #{} {} [{}] checks={:?}", p.number, p.title, p.state, p.checks);
        }
        let again = Instant::now();
        let _ = t.list(Source::Github, Kind::Issues, "rlaope/oh-my-hermes", Filter::Open, 0).unwrap();
        println!("second list from the 60 s cache in {:?}", again.elapsed());
        if let Some(first) = prs.items.first().or(issues.items.first()) {
            let kind = if prs.items.first().is_some() { Kind::Changes } else { Kind::Issues };
            let d = t.view(Source::Github, kind, "rlaope/oh-my-hermes", first.number).unwrap();
            println!("view #{}: body {} chars, {} comments, {} checks", d.item.number, d.body.len(), d.comments.len(), d.checks.len());
        }
    }
}
