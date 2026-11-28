//! What really changed in a lane's own folder, for the Diff beside the lane (src/code/LanePane.tsx, item 71). Until now the
//! pane drew only what the chat's own events said while the app ran, so after a restart it was empty, a subagent's edits were
//! missing, and it could disagree with the disk. This reads git instead: every file that differs from the commit the lane
//! started from, with its state (changed, new, deleted, renamed) and its text diff. Work not yet committed, files git has not
//! seen and commits made in the lane are all included; a file git ignores (a `.env`, the copied agent settings, installed
//! dependencies) never is.
//!
//! The commit it starts from is the lane's record's `at`, the commit the branch was made at, so a base branch that has moved
//! since does not put its changes in the lane's Diff (git_moved.rs is what tells the person it moved). When `at` is no longer
//! an ancestor of the lane's HEAD (the lane was rebased) the merge-base with the recorded base branch stands in for it.
//!
//! Only a folder the app made is read (`lane::own_lane`, the check the removal paths use, plus git listing the folder as a
//! worktree of the recorded repository). Every call only reads, through the lane's own `Git` runner (no hook, no file monitor,
//! no prompt, no optional lock), with `--no-ext-diff --no-textconv` so no program the repository names runs to draw a diff.
//! The Diff is read by itself whenever the lane is shown, so a repository whose own config names a program git would run while
//! it compares (a clean filter) or fetches is not read at all (`config:<setting>`, `lane::Git::config_risk`; item 86): the pane
//! then shows what the chat's own events said, as for a folder it cannot read.
//!
//! Bounded, and each bound is said: at most `MAX_FILES` files (the rest are counted), a file's diff over `MAX_FILE_DIFF` bytes or
//! a file over `MAX_SOURCE` bytes is "too large to show", the diffs together stop at `MAX_TOTAL` bytes (later files are listed
//! with no text), a binary file says it is binary, and the whole read stops at `BUDGET`. Every diff passes `mask_secrets`
//! before it leaves this module.
//!
//! Review in the pane (item 146): `review` reads the same folder as two kinds of section instead of one list, the work not
//! committed yet (the folder against HEAD, files git has not seen included) and the lane's own commits, newest first, each
//! against its first parent. A merge is not one of the commits: a lane that took its base in by merging would otherwise show the
//! base's work as the lane's. It is the same read through the same runner, so every rule above holds for it, and its caps are
//! shared across the sections: `MAX_FILES` files, `MAX_TOTAL` bytes of text and `BUDGET` in all, `REVIEW_COMMITS` commits (the
//! rest are counted), and a commit git cannot read or that the budget did not reach is said to be unread.

use std::fs;
use std::path::{Component, Path, PathBuf};
use std::time::{Duration, Instant, UNIX_EPOCH};

use serde::Serialize;

use crate::lane::{self, real, safe_rev, Git, Record};
use crate::tasks::mask_secrets;

/// The most files whose diffs are read; the rest are counted in `more_files`.
const MAX_FILES: usize = 100;
/// The most bytes of one file's diff; a longer one is not shown.
const MAX_FILE_DIFF: usize = 256 * 1024;
/// A file larger than this on disk is not diffed at all.
const MAX_SOURCE: u64 = 2 * 1024 * 1024;
/// The most bytes of diff text in one answer.
const MAX_TOTAL: usize = 1024 * 1024;
/// How long one read may take in all; files not reached are listed without text.
const BUDGET: Duration = Duration::from_secs(15);
/// The most paths git lists, so a folder with a million new files cannot fill memory.
const MAX_NAMES: usize = 20_000;
/// The most of a lane's commits the review reads files for, newest first; the rest are counted in `more_commits`.
const REVIEW_COMMITS: usize = 30;
/// The longest a commit's subject is kept, in characters.
const SUBJECT_MAX: usize = 200;

/// Set for every call: a path from a list is a path, never a pathspec; nothing pages.
const ENV: &[(&str, &str)] = &[("GIT_LITERAL_PATHSPECS", "1"), ("GIT_PAGER", "cat")];

/// On every diff (item 90): a submodule is hidden, so git never runs inside one (a `diff` against the work tree runs `status`
/// in each submodule, which reads the submodule's own config and runs its clean filter), and one that reached a diff anyway is
/// drawn as two commit names, never with `diff.submodule`'s `log` or `diff` forms, which read or diff inside it.
const SUBMODULES: &[&str] = &["--ignore-submodules=all", "--submodule=short"];

/// One changed file. `state` is `changed`, `new`, `deleted` or `renamed` (`from` is its old path). `diff` is git's unified diff
/// with its keys masked, empty when `note` says why: `binary`, `too_large` or `left_out` (the answer's budget ran out first).
#[derive(Serialize, Debug, PartialEq, Clone)]
pub struct LaneFile {
    pub path: String,
    pub from: Option<String>,
    pub state: String,
    pub diff: String,
    pub note: Option<String>,
}

/// What the lane's folder says: where it started from (a short commit id), the files, and how many more there were than
/// `MAX_FILES`; and, when asked (a push about to go, item 120), what the commits it would send hold.
#[derive(Serialize, Debug, PartialEq)]
pub struct LaneDiff {
    pub start: String,
    pub files: Vec<LaneFile>,
    pub more_files: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub history: Option<History>,
}

/// A list of changed files and how many more there were than the review had room to read (`MAX_FILES` in all, shared by every
/// part of one answer).
#[derive(Serialize, Debug, PartialEq, Default)]
pub struct Part {
    pub files: Vec<LaneFile>,
    pub more_files: u32,
}

/// One of the lane's own commits: its short id, its subject with its keys masked, and its files against its first parent.
/// `unread` when git could not list them or the answer's time ran out before this commit (the files are then none).
#[derive(Serialize, Debug, PartialEq)]
pub struct CommitPart {
    pub id: String,
    pub subject: String,
    pub files: Vec<LaneFile>,
    pub more_files: u32,
    pub unread: bool,
}

/// The lane's folder as sections (item 146): `uncommitted` is the folder against HEAD, `commits` the lane's own commits newest
/// first (at most `REVIEW_COMMITS`; `more_commits` counts the rest), and `start` the short id they are counted from.
#[derive(Serialize, Debug, PartialEq)]
pub struct LaneReview {
    pub start: String,
    pub uncommitted: Part,
    pub commits: Vec<CommitPart>,
    pub more_commits: u32,
}

/// The most commits a push's read goes through (item 120); with more, it says it could not read them all.
const MAX_COMMITS: usize = 200;
/// The most bytes of the commits' messages, and of their patches, a push's read takes in.
const MAX_HISTORY: usize = 4 << 20;

/// What a push of the lane's branch sends besides what its folder shows (item 120): every commit on HEAD that no
/// remote-tracking branch holds, each one's added lines and message read with the masker, so a key added in one commit and taken
/// out in the next, or written into a message, is seen. `files` are the paths an added line of which holds a key and, for a
/// message that holds one, the commit's short id; nothing of a key itself. `unread` when the commits could not all be read
/// whole and in time (too many, too large, a binary change, git refusing), which makes the push ask.
#[derive(Serialize, Debug, PartialEq, Default, Clone)]
pub struct History {
    pub files: Vec<String>,
    pub unread: bool,
}

/// The commits on HEAD in `wt` that no remote-tracking branch holds, at most `max`, read within `left`, through the lane's own
/// read-only `Git` (no hook, no external diff, no text conversion, never into a submodule).
fn history(git: &Git, wt: &Path, left: Duration, max: usize) -> History {
    let unread = || History { files: Vec::new(), unread: true };
    let began = Instant::now();
    let count = format!("--max-count={}", max + 1);
    // each commit's full id and its message, each ended by a NUL: git keeps no NUL in a message
    let msgs = match git.run_with(wt, &["log", &count, "--no-color", "--format=%H%x00%B%x00", "HEAD", "--not", "--remotes"], left.max(Duration::from_secs(1)), ENV) {
        Ok(r) if r.code == Some(0) && r.out.len() < MAX_HISTORY => r.out,
        _ => return unread(),
    };
    let mut files: Vec<String> = Vec::new();
    let note = |name: String, files: &mut Vec<String>| {
        if !files.contains(&name) {
            files.push(name);
        }
    };
    let mut commits = 0usize;
    let mut parts = msgs.split('\0');
    while let Some(id) = parts.next() {
        let id = id.trim();
        if id.is_empty() {
            break;
        }
        // anything but a commit's id where one stands is output this does not understand
        if !matches!(id.len(), 40 | 64) || !id.bytes().all(|b| b.is_ascii_hexdigit()) {
            return unread();
        }
        let Some(body) = parts.next() else { return unread() };
        commits += 1;
        if mask_secrets(body) != body {
            note(id[..12].to_string(), &mut files);
        }
    }
    if commits > max {
        return unread();
    }
    let Some(left) = left.checked_sub(began.elapsed()) else { return unread() };
    // their patches, a merge's against its first parent; no message is printed here, so every line is the patch's own
    let mut argv: Vec<&str> = vec!["log", &count, "-p", "--diff-merges=first-parent", "--no-ext-diff", "--no-textconv", "--no-color", "--format="];
    argv.extend_from_slice(SUBMODULES);
    argv.extend(["HEAD", "--not", "--remotes"]);
    let patches = match git.run_with(wt, &argv, left.max(Duration::from_secs(1)), ENV) {
        Ok(r) if r.code == Some(0) && r.out.len() < MAX_HISTORY => r.out,
        _ => return unread(),
    };
    let mut path = String::new();
    let mut binary = false;
    for line in patches.lines() {
        if line.starts_with("Binary files ") || line.starts_with("GIT binary patch") {
            binary = true;
            continue;
        }
        // Every added line is read, a line that looks like a file's header (`+++ x`, an added `++ x`) among them: masking a
        // real header only ever finds a key in a file's name. A new name from a rename or a copy is read the same way.
        let added = line.strip_prefix('+').or_else(|| line.strip_prefix("rename to ")).or_else(|| line.strip_prefix("copy to "));
        if let Some(text) = added {
            if mask_secrets(text) != text {
                note(if path.is_empty() { "?".to_string() } else { path.clone() }, &mut files);
            }
        }
        if let Some(p) = line.strip_prefix("+++ ") {
            path = p.strip_prefix("b/").unwrap_or(p).to_string();
        } else if line.starts_with("diff --git ") {
            path.clear();
        }
    }
    History { files, unread: binary }
}

/// The folder `dir` and its record when it is a lane the app made: the worktree itself, or the folder inside it that a lane
/// started in a subfolder works in (`Made::dir`).
fn own_folder(home: &Path, dir: &str) -> Result<(PathBuf, Record), String> {
    if let Ok((wt, _, rec)) = lane::own_lane(home, dir) {
        return Ok((wt, rec));
    }
    let want = PathBuf::from(dir);
    for (_, r) in lane::records(home) {
        if r.prefix.is_empty() || r.prefix.split('/').any(|c| c == ".." || c == "." || c.is_empty()) {
            continue;
        }
        if Path::new(&r.worktree).join(&r.prefix) == want {
            let (wt, _, rec) = lane::own_lane(home, &r.worktree)?;
            return Ok((wt, rec));
        }
    }
    Err("not_a_lane".into())
}

/// The commit the lane's changes are counted from, as a full id. Normally the record's `at`, where the lane's branch was made.
/// Once the base branch has been brought into the lane (a rebase onto it, or a merge of it) `at` is still behind HEAD but the
/// base's own changes now are too, so where HEAD and the base branch parted stands in for it, as long as that is not HEAD
/// itself (the base has taken in all of the lane's commits: its own commits then still show, from `at`).
fn start_commit(git: &Git, wt: &Path, rec: &Record) -> Option<String> {
    let full = |id: String| (id.len() >= 40 && id.bytes().all(|b| b.is_ascii_hexdigit())).then_some(id);
    let commit = |rev: &str| git.line(wt, &["rev-parse", "--verify", "--quiet", &format!("{rev}^{{commit}}")]).and_then(full);
    let ancestor = |a: &str, b: &str| git.run(wt, &["merge-base", "--is-ancestor", a, b]).ok().and_then(|r| r.code) == Some(0);
    let at = safe_rev(&rec.at).then(|| commit(&rec.at)).flatten().filter(|at| ancestor(at, "HEAD"));
    let head = commit("HEAD");
    let parted = safe_rev(&rec.base).then(|| git.line(wt, &["merge-base", "HEAD", &rec.base]).and_then(full)).flatten();
    match (at, parted) {
        (Some(a), Some(m)) if Some(&m) != head.as_ref() && ancestor(&a, &m) => Some(m),
        (Some(a), _) => Some(a),
        (None, m) => m,
    }
}

struct Entry {
    path: String,
    from: Option<String>,
    state: &'static str,
    untracked: bool,
    mtime: u64,
}

/// A path git printed that is safe to join under the folder: relative, nothing in it that climbs.
fn plain(p: &str) -> bool {
    !p.is_empty() && Path::new(p).components().all(|c| matches!(c, Component::Normal(_)))
}

fn mtime_of(wt: &Path, p: &str) -> u64 {
    fs::symlink_metadata(wt.join(p)).and_then(|m| m.modified()).ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map(|d| d.as_secs()).unwrap_or(0)
}

/// What a diff compares. `Worktree(rev)`: the folder against the commit `rev`, with the files git has not seen yet, as the pane's
/// whole list and its uncommitted section are. `Commits(from, to)`: one commit against another (a lane's commit against its
/// first parent), where every file is one git holds already and nothing on disk is read.
enum Span<'a> {
    Worktree(&'a str),
    Commits(&'a str, &'a str),
}

impl Span<'_> {
    /// The revisions git is given, then `--`, so a file named like one is still only a file.
    fn revs(&self) -> Vec<&str> {
        match self {
            Span::Worktree(r) => vec![*r, "--"],
            Span::Commits(a, b) => vec![*a, *b, "--"],
        }
    }
}

/// Every file that differs across `span`: what git's own diff says about tracked files (renames paired), then, for a folder, the
/// new files git does not ignore.
fn entries(git: &Git, wt: &Path, span: &Span) -> Result<Vec<Entry>, String> {
    // a submodule is not one of the lane's files, and comparing one would run git inside it (`SUBMODULES`)
    let mut argv: Vec<&str> = vec!["diff", "--name-status", "-z", "-M", "--no-ext-diff", "--no-textconv", "--no-color"];
    argv.extend_from_slice(SUBMODULES);
    argv.extend(span.revs());
    let on_disk = matches!(span, Span::Worktree(_));
    let mtime = |p: &str| if on_disk { mtime_of(wt, p) } else { 0 };
    let tracked = git.run_with(wt, &argv, Duration::from_secs(20), ENV)?;
    if tracked.code != Some(0) {
        return Err("unread".into());
    }
    let mut out: Vec<Entry> = Vec::new();
    let mut parts = tracked.out.split('\0').filter(|s| !s.is_empty());
    while let Some(status) = parts.next() {
        let (state, from, path) = match status.chars().next() {
            Some('R') | Some('C') => {
                let old = parts.next().unwrap_or("");
                let new = parts.next().unwrap_or("");
                // a copy is shown as a new file: nothing was renamed
                if status.starts_with('C') {
                    ("new", None, new)
                } else {
                    ("renamed", Some(old), new)
                }
            }
            Some('A') => ("new", None, parts.next().unwrap_or("")),
            Some('D') => ("deleted", None, parts.next().unwrap_or("")),
            _ => ("changed", None, parts.next().unwrap_or("")),
        };
        if !plain(path) || from.is_some_and(|f| !plain(f)) {
            continue;
        }
        out.push(Entry { path: path.to_string(), from: from.map(str::to_string), state, untracked: false, mtime: mtime(path) });
        if out.len() >= MAX_NAMES {
            break;
        }
    }
    if on_disk {
        let fresh = git.run_with(wt, &["ls-files", "--others", "--exclude-standard", "-z"], Duration::from_secs(20), ENV)?;
        if fresh.code != Some(0) {
            return Err("unread".into());
        }
        for p in fresh.out.split('\0').filter(|s| !s.is_empty()) {
            // a nested repository is listed as `dir/`: it is not a file of this one
            if p.ends_with('/') || !plain(p) || out.iter().any(|e| e.path == p) {
                continue;
            }
            out.push(Entry { path: p.to_string(), from: None, state: "new", untracked: true, mtime: mtime(p) });
            if out.len() >= MAX_NAMES {
                break;
            }
        }
    }
    // the file that changed last first, as the pane has always listed them; a commit's files have no time on disk, so they stay
    // in git's order, which is by path
    out.sort_by(|a, b| b.mtime.cmp(&a.mtime).then_with(|| a.path.cmp(&b.path)));
    Ok(out)
}

/// The diff text of one entry, or why there is none.
fn diff_of(git: &Git, wt: &Path, span: &Span, e: &Entry, left: Duration) -> Result<String, &'static str> {
    // how big a file is on disk says how big its diff may be only for the folder's own files; a commit's are held by git, and the
    // length of what git printed (read at most `tasks::MAX_OUT`) is checked below
    if matches!(span, Span::Worktree(_)) && e.state != "deleted" && fs::symlink_metadata(wt.join(&e.path)).map(|m| m.len() > MAX_SOURCE).unwrap_or(false) {
        return Err("too_large");
    }
    let from = e.from.as_deref().unwrap_or("");
    let mut argv: Vec<&str> = vec!["diff", "--no-ext-diff", "--no-textconv", "--no-color"];
    argv.extend_from_slice(SUBMODULES);
    if e.untracked {
        argv.extend(["--no-index", "--", "/dev/null", &e.path]);
    } else {
        argv.push(if e.from.is_some() { "-M" } else { "--no-renames" });
        // each revision, then `--`, then the paths of this one file
        argv.extend(span.revs());
        if e.from.is_some() {
            argv.push(from);
        }
        argv.push(&e.path);
    }
    let ran = git.run_with(wt, &argv, left.max(Duration::from_secs(1)), ENV).map_err(|_| "left_out")?;
    // `--no-index` ends with 1 when the files differ
    if !matches!(ran.code, Some(0) | Some(1)) {
        return Err("left_out");
    }
    let header = ran.out.split("\n@@").next().unwrap_or("");
    if header.lines().any(|l| l.starts_with("Binary files ") || l.starts_with("GIT binary patch")) {
        return Err("binary");
    }
    if ran.out.len() > MAX_FILE_DIFF {
        return Err("too_large");
    }
    Ok(mask_secrets(&ran.out))
}

/// What changed in the lane's folder `dir` since the lane started, for the Diff pane. `Err` is a short code: `not_a_lane` (a
/// folder the app did not make, or one git does not list as a worktree of the recorded repository), `git_missing`, `unread`,
/// `config:<setting>` (the repository's own config names a program git would run).
pub fn read(home: &Path, dir: &str) -> Result<LaneDiff, String> {
    read_with(home, dir, false)
}

/// The runner, the folder and the record of the lane `dir`, once every check a read of a lane's folder needs has passed: the
/// app made it, git still lists it as a worktree of the recorded repository, and the repository's own config names no program
/// git would run (`not_a_lane`, `git_missing`, `config:<setting>`). Every read of a lane's folder by itself starts here.
pub(crate) fn opened(home: &Path, dir: &str) -> Result<(Git, PathBuf, Record), String> {
    let (wt, rec) = own_folder(home, dir)?;
    let git = Git::automatic(home)?;
    let repo = real(Path::new(&rec.repo));
    let exists = fs::symlink_metadata(&wt).map(|m| m.is_dir()).unwrap_or(false);
    let ours = exists && git.common_dir(&wt).as_ref() == Some(&repo) && git.worktrees(&repo).is_some_and(|l| l.contains(&real(&wt)) && l.first() != Some(&real(&wt)));
    if !ours {
        return Err("not_a_lane".into());
    }
    // read in the lane's folder, and in the repository's git folder, where the worktree list above ran (item 118)
    if let Some(setting) = git.lane_config_risk(&wt, &repo) {
        return Err(format!("config:{setting}"));
    }
    Ok((git, wt, rec))
}

/// What the answer in progress has taken so far, shared by every part of it: the files read and the bytes of diff text.
#[derive(Default)]
struct Spent {
    files: usize,
    total: usize,
}

/// The files across `span`, as many as the answer still has room for (`MAX_FILES` in all, `MAX_TOTAL` bytes of text, `BUDGET`
/// from `begun`); the rest are counted, and a file the text or the time had no room for is listed with no text and says so.
fn part(git: &Git, wt: &Path, span: &Span, begun: Instant, spent: &mut Spent) -> Result<Part, String> {
    let all = entries(git, wt, span)?;
    let room = MAX_FILES.saturating_sub(spent.files);
    let more_files = all.len().saturating_sub(room) as u32;
    let mut files = Vec::new();
    for e in all.iter().take(room) {
        let got = match BUDGET.checked_sub(begun.elapsed()) {
            None => Err("left_out"),
            Some(_) if spent.total >= MAX_TOTAL => Err("left_out"),
            Some(left) => diff_of(git, wt, span, e, left).and_then(|t| if spent.total + t.len() > MAX_TOTAL { Err("left_out") } else { Ok(t) }),
        };
        let (diff, note) = match got {
            Ok(t) => {
                spent.total += t.len();
                (t, None)
            }
            Err(n) => (String::new(), Some(n.to_string())),
        };
        spent.files += 1;
        files.push(LaneFile { path: e.path.clone(), from: e.from.clone(), state: e.state.to_string(), diff, note });
    }
    Ok(Part { files, more_files })
}

/// `read`, and with `with_history` what the commits a push would send hold (item 120), within the same budget.
pub fn read_with(home: &Path, dir: &str, with_history: bool) -> Result<LaneDiff, String> {
    let (git, wt, rec) = opened(home, dir)?;
    let begun = Instant::now();
    let start = start_commit(&git, &wt, &rec).ok_or("unread")?;
    let Part { files, more_files } = part(&git, &wt, &Span::Worktree(&start), begun, &mut Spent::default())?;
    let history = with_history.then(|| match BUDGET.checked_sub(begun.elapsed()) {
        Some(left) => history(&git, &wt, left, MAX_COMMITS),
        None => History { files: Vec::new(), unread: true },
    });
    Ok(LaneDiff { start: start.chars().take(12).collect(), files, more_files, history })
}

/// The lane's own commits, newest first, from `start` to HEAD, each with its full id and its subject: at most `REVIEW_COMMITS`
/// and one more, so a longer history can say so. A merge is left out (see the module's note), and so is everything `start`
/// already holds.
fn commits(git: &Git, wt: &Path, start: &str) -> Result<Vec<(String, String)>, String> {
    let count = format!("--max-count={}", REVIEW_COMMITS + 1);
    let range = format!("{start}..HEAD");
    // each commit's full id and its subject, each ended by a NUL: git keeps no NUL in a message
    let ran = git.run_with(wt, &["log", &count, "--no-merges", "--no-color", "--format=%H%x00%s%x00", &range, "--"], Duration::from_secs(20), ENV)?;
    if ran.code != Some(0) {
        return Err("unread".into());
    }
    let mut out = Vec::new();
    let mut parts = ran.out.split('\0');
    while let Some(id) = parts.next() {
        let id = id.trim();
        if id.is_empty() {
            break;
        }
        // anything but a commit's id where one stands is output this does not understand
        if !matches!(id.len(), 40 | 64) || !id.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err("unread".into());
        }
        let Some(subject) = parts.next() else { return Err("unread".into()) };
        out.push((id.to_string(), subject.to_string()));
    }
    Ok(out)
}

/// A commit's subject as it leaves: on one line, its keys masked, cut at `SUBJECT_MAX` characters.
fn subject_of(raw: &str) -> String {
    let one = mask_secrets(&raw.split_whitespace().collect::<Vec<_>>().join(" "));
    one.chars().take(SUBJECT_MAX).collect()
}

/// The lane's folder as sections (item 146): the work not committed yet, then each of the lane's commits, newest first. `Err`
/// is a short code, as `read`'s. A commit whose files git could not list, or that the answer's time did not reach, is listed with
/// no files and `unread`; the sections after the uncommitted one share what `MAX_FILES`, `MAX_TOTAL` and `BUDGET` have left.
pub fn review(home: &Path, dir: &str) -> Result<LaneReview, String> {
    let (git, wt, rec) = opened(home, dir)?;
    let begun = Instant::now();
    let start = start_commit(&git, &wt, &rec).ok_or("unread")?;
    let mut spent = Spent::default();
    let uncommitted = part(&git, &wt, &Span::Worktree("HEAD"), begun, &mut spent)?;
    let list = commits(&git, &wt, &start)?;
    // the list holds one more than is read, only to know there are more: how many more is one cheap count (and at least one if
    // git does not give it)
    let more_commits = if list.len() > REVIEW_COMMITS {
        let total = git.line(&wt, &["rev-list", "--count", "--no-merges", &format!("{start}..HEAD"), "--"]).and_then(|n| n.parse::<usize>().ok());
        total.map_or(1, |n| n.saturating_sub(REVIEW_COMMITS).max(1)) as u32
    } else {
        0
    };
    let mut out = Vec::new();
    for (id, subject) in list.into_iter().take(REVIEW_COMMITS) {
        let parent = format!("{id}^");
        let read = if BUDGET.checked_sub(begun.elapsed()).is_some() { part(&git, &wt, &Span::Commits(&parent, &id), begun, &mut spent).ok() } else { None };
        let unread = read.is_none();
        let Part { files, more_files } = read.unwrap_or_default();
        out.push(CommitPart { id: id.chars().take(12).collect(), subject: subject_of(&subject), files, more_files, unread });
    }
    Ok(LaneReview { start: start.chars().take(12).collect(), uncommitted, commits: out, more_commits })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::lane::tests::{commit_in, names, repo, sh};

    /// A lane `kit/x` of the test repository, and its folder.
    fn lane(name: &str) -> Option<(PathBuf, PathBuf, PathBuf)> {
        let (home, d) = repo(name)?;
        let made = lane::make(&home, &d, &names(&["kit/x"])).unwrap();
        Some((home.clone(), d, PathBuf::from(made.worktree)))
    }

    fn get(home: &Path, wt: &Path) -> LaneDiff {
        read(home, &wt.to_string_lossy()).unwrap()
    }

    fn find<'a>(d: &'a LaneDiff, p: &str) -> &'a LaneFile {
        d.files.iter().find(|f| f.path == p).unwrap_or_else(|| panic!("{p} not in {:?}", d.files.iter().map(|f| &f.path).collect::<Vec<_>>()))
    }

    fn paths(d: &LaneDiff) -> Vec<&str> {
        d.files.iter().map(|f| f.path.as_str()).collect()
    }

    #[test]
    fn a_clean_lane_has_no_files() {
        let Some((home, _, wt)) = lane("ld-clean") else { return };
        let d = get(&home, &wt);
        assert!(d.files.is_empty() && d.more_files == 0, "{d:?}");
        assert_eq!(d.start.len(), 12);
        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn each_state_is_read_from_the_folder_with_its_text() {
        let Some((home, _, wt)) = lane("ld-states") else { return };
        // changed (not committed), new and untracked, new and committed, deleted, renamed
        fs::write(wt.join("a.txt"), "one\nchanged\n").unwrap();
        fs::write(wt.join("fresh.txt"), "hello\n").unwrap();
        commit_in(&wt, "kept.txt", "kept\n");
        sh(&wt, &["rm", "-q", "-f", ".gitignore"]);
        sh(&wt, &["mv", "apps/web/b.txt", "apps/web/c.txt"]);
        let d = get(&home, &wt);
        let a = find(&d, "a.txt");
        assert!(a.state == "changed" && a.diff.contains("+changed"), "{a:?}");
        let f = find(&d, "fresh.txt");
        assert!(f.state == "new" && f.diff.contains("+hello"), "{f:?}");
        assert_eq!(find(&d, "kept.txt").state, "new");
        let gone = find(&d, ".gitignore");
        assert!(gone.state == "deleted" && gone.diff.contains("-node_modules/"), "{gone:?}");
        let mv = find(&d, "apps/web/c.txt");
        assert!(mv.state == "renamed" && mv.from.as_deref() == Some("apps/web/b.txt"), "{mv:?}");
        assert!(d.files.iter().all(|f| f.path != "apps/web/b.txt"));
        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn a_file_put_back_as_it_was_is_not_listed() {
        let Some((home, _, wt)) = lane("ld-back") else { return };
        fs::write(wt.join("a.txt"), "other\n").unwrap();
        assert_eq!(get(&home, &wt).files.len(), 1);
        fs::write(wt.join("a.txt"), "one\n").unwrap();
        assert!(get(&home, &wt).files.is_empty());
        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn a_file_git_ignores_never_shows() {
        let Some((home, _, wt)) = lane("ld-ignored") else { return };
        fs::create_dir_all(wt.join("node_modules")).unwrap();
        fs::write(wt.join("node_modules/x.js"), "x\n").unwrap();
        // the copied agent settings and a secret file are ignored by the lane's own exclude file, as lane_config.rs makes them
        let exclude = sh(&wt, &["rev-parse", "--git-path", "info/exclude"]);
        let exclude = if Path::new(&exclude).is_absolute() { PathBuf::from(exclude) } else { wt.join(exclude) };
        fs::create_dir_all(exclude.parent().unwrap()).unwrap();
        fs::write(&exclude, ".env\n.mcp.json\n").unwrap();
        fs::write(wt.join(".env"), "TOKEN=abc\n").unwrap();
        fs::write(wt.join(".mcp.json"), "{}\n").unwrap();
        fs::write(wt.join("shown.txt"), "x\n").unwrap();
        let d = get(&home, &wt);
        assert_eq!(paths(&d), vec!["shown.txt"], "{d:?}");
        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn a_base_that_moved_adds_nothing_to_the_lane() {
        let Some((home, d, wt)) = lane("ld-moved") else { return };
        commit_in(&d, "from-main.txt", "main\n");
        commit_in(&wt, "mine.txt", "mine\n");
        let got = get(&home, &wt);
        assert_eq!(paths(&got), vec!["mine.txt"], "{got:?}");
        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn a_lane_rebased_onto_a_moved_base_still_counts_only_its_own() {
        let Some((home, d, wt)) = lane("ld-rebased") else { return };
        commit_in(&d, "from-main.txt", "main\n");
        commit_in(&wt, "mine.txt", "mine\n");
        sh(&wt, &["rebase", "-q", "main"]);
        let got = get(&home, &wt);
        assert_eq!(paths(&got), vec!["mine.txt"], "{got:?}");
        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn a_folder_inside_a_lane_that_started_in_a_subfolder_is_read_too() {
        let Some((home, d)) = repo("ld-prefix") else { return };
        let made = lane::make(&home, &d.join("apps/web"), &names(&["kit/y"])).unwrap();
        fs::write(Path::new(&made.worktree).join("a.txt"), "x\n").unwrap();
        let got = read(&home, &made.dir).unwrap();
        assert_eq!(got.files.len(), 1);
        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn the_caps_are_said_not_hidden() {
        let Some((home, _, wt)) = lane("ld-caps") else { return };
        // more files than the cap
        fs::create_dir_all(wt.join("many")).unwrap();
        for i in 0..(MAX_FILES + 5) {
            fs::write(wt.join(format!("many/f{i:03}.txt")), "x\n").unwrap();
        }
        let d = get(&home, &wt);
        assert_eq!((d.files.len(), d.more_files), (MAX_FILES, 5));
        fs::remove_dir_all(wt.join("many")).unwrap();
        // one file's diff too long, one file too big on disk
        fs::write(wt.join("big.txt"), "y".repeat(MAX_FILE_DIFF + 10) + "\n").unwrap();
        fs::write(wt.join("huge.txt"), vec![b'z'; MAX_SOURCE as usize + 10]).unwrap();
        let d = get(&home, &wt);
        for p in ["big.txt", "huge.txt"] {
            let f = find(&d, p);
            assert!(f.note.as_deref() == Some("too_large") && f.diff.is_empty(), "{p}: {f:?}");
        }
        fs::remove_file(wt.join("big.txt")).unwrap();
        fs::remove_file(wt.join("huge.txt")).unwrap();
        // the whole answer: each file under its own cap, together over the total
        for i in 0..6 {
            let text: String = (0..4000).map(|n| format!("line {i} {n} padding padding padding padding\n")).collect();
            fs::write(wt.join(format!("t{i}.txt")), text).unwrap();
        }
        let d = get(&home, &wt);
        let shown: usize = d.files.iter().map(|f| f.diff.len()).sum();
        assert!(shown <= MAX_TOTAL, "{shown}");
        assert!(d.files.iter().any(|f| f.note.as_deref() == Some("left_out")), "{:?}", d.files.iter().map(|f| (&f.path, f.diff.len(), &f.note)).collect::<Vec<_>>());
        assert!(d.files.iter().any(|f| f.note.is_none()));
        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn a_binary_file_says_it_is_binary() {
        let Some((home, _, wt)) = lane("ld-binary") else { return };
        fs::write(wt.join("pic.png"), [0u8, 1, 2, 0, 255, 0, 3]).unwrap();
        let d = get(&home, &wt);
        let f = find(&d, "pic.png");
        assert!(f.note.as_deref() == Some("binary") && f.diff.is_empty() && f.state == "new", "{f:?}");
        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn a_key_in_a_change_is_masked_before_it_leaves() {
        let Some((home, _, wt)) = lane("ld-key") else { return };
        let key = format!("ghp_{}", "a".repeat(36));
        fs::write(wt.join("a.txt"), format!("token={key}\n")).unwrap();
        let d = get(&home, &wt);
        let a = find(&d, "a.txt");
        assert!(!a.diff.contains(&key) && a.diff.contains("••••"), "{a:?}");
        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn a_folder_the_app_did_not_make_is_refused() {
        let Some((home, d, wt)) = lane("ld-refused") else { return };
        // the developer's own folder, a folder inside a lane that is no lane, a relative path, a path that climbs, a missing one
        let inside = wt.join("apps");
        for p in [d.to_string_lossy().into_owned(), inside.to_string_lossy().into_owned(), "web-app".into(), format!("{}/../x", wt.display()), "/no/such/folder".into(), String::new()] {
            assert_eq!(read(&home, &p).unwrap_err(), "not_a_lane", "{p}");
        }
        // a folder made by hand under the lanes' folder, with no record
        let by_hand = lane::lanes_dir(&home).join("web-app").join("by-hand");
        fs::create_dir_all(&by_hand).unwrap();
        assert_eq!(read(&home, &by_hand.to_string_lossy()).unwrap_err(), "not_a_lane");
        let _ = fs::remove_dir_all(home);
    }

    #[cfg(unix)]
    #[test]
    fn no_program_the_repository_names_runs_to_read_a_diff() {
        use std::os::unix::fs::PermissionsExt;
        let Some((home, d, wt)) = lane("ld-programs") else { return };
        let marker = home.join("ran");
        let script = home.join("spy.sh");
        fs::write(&script, format!("#!/bin/sh\necho ran >> '{}'\ncat \"$@\" 2>/dev/null\n", marker.display())).unwrap();
        fs::set_permissions(&script, fs::Permissions::from_mode(0o755)).unwrap();
        let s = script.to_string_lossy().into_owned();
        // an external diff, a text conversion, a file monitor and hooks, in the repository's own config and hooks
        sh(&d, &["config", "diff.external", &s]);
        sh(&d, &["config", "diff.spy.textconv", &s]);
        sh(&d, &["config", "core.fsmonitor", &s]);
        fs::write(d.join(".gitattributes"), "*.txt diff=spy\n").unwrap();
        for hook in ["post-index-change", "reference-transaction", "post-checkout"] {
            let h = d.join(".git/hooks").join(hook);
            fs::create_dir_all(h.parent().unwrap()).unwrap();
            fs::write(&h, format!("#!/bin/sh\necho ran >> '{}'\n", marker.display())).unwrap();
            fs::set_permissions(&h, fs::Permissions::from_mode(0o755)).unwrap();
        }
        fs::write(wt.join("a.txt"), "one\nchanged\n").unwrap();
        fs::write(wt.join("fresh.txt"), "new\n").unwrap();
        let got = get(&home, &wt);
        assert!(find(&got, "a.txt").diff.contains("+changed"));
        assert!(!marker.exists(), "a program ran: {}", fs::read_to_string(&marker).unwrap_or_default());
        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn no_program_a_submodule_s_own_config_names_runs_to_read_a_diff() {
        let Some((home, d)) = repo("ld-submodule") else { return };
        crate::lane::tests::with_submodule(&home, &d);
        let made = lane::make(&home, &d, &names(&["kit/x"])).unwrap();
        let wt = PathBuf::from(&made.worktree);
        let marker = crate::lane::tests::filter_in_submodule(&home, &wt);
        fs::write(wt.join("a.txt"), "one\nchanged\n").unwrap();
        let got = read(&home, &wt.to_string_lossy());
        assert!(!marker.exists(), "a program ran: {}", fs::read_to_string(&marker).unwrap_or_default());
        // whatever the Diff could say, a submodule is never one of the lane's own files
        if let Ok(got) = got {
            assert!(got.files.iter().all(|f| f.path != "sub"), "{got:?}");
        }
        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn a_lane_whose_repository_names_a_clean_filter_is_not_read_by_itself() {
        let Some((home, d, wt)) = lane("ld-filter") else { return };
        let marker = crate::lane::tests::filter_in(&home, &d, &wt);
        let got = read(&home, &wt.to_string_lossy());
        assert_eq!(got.unwrap_err(), "config:filter.spy.clean");
        assert!(!marker.exists(), "a program ran: {}", fs::read_to_string(&marker).unwrap_or_default());
        let _ = fs::remove_dir_all(home);
    }

    /// Item 118 (fourth security review, 26 Nov 2026): the Diff also runs git in the repository's own git folder (to see that
    /// the lane is still one of its worktrees), where git reads the developer's folder's own worktree config, which the lane's
    /// read does not see. That config is read too, and an include in the repository's config stops it whatever its condition.
    #[test]
    fn the_diff_reads_the_config_of_every_folder_it_runs_git_in() {
        let Some((home, d, wt)) = lane("ld-common") else { return };
        sh(&d, &["config", "extensions.worktreeConfig", "true"]);
        sh(&d, &["config", "--worktree", "filter.spy.clean", "x"]);
        assert_eq!(read(&home, &wt.to_string_lossy()).unwrap_err(), "config:filter.spy.clean");
        sh(&d, &["config", "--worktree", "--unset", "filter.spy.clean"]);
        assert!(read(&home, &wt.to_string_lossy()).is_ok());
        sh(&d, &["config", "includeIf.onbranch:kit/**.path", "more.conf"]);
        assert_eq!(read(&home, &wt.to_string_lossy()).unwrap_err(), "config:includeif.*.path");
        let _ = fs::remove_dir_all(home);
    }

    /// Item 120 (fifth security review, 26 Nov 2026): a push sends the lane's commits, not its folder's diff. A key added in one
    /// commit and taken out in the next, or written into a message, is in no diff of the folder.
    fn pushed(home: &Path, wt: &Path) -> History {
        read_with(home, &wt.to_string_lossy(), true).unwrap().history.expect("asked for the history")
    }

    #[test]
    fn a_key_added_and_taken_out_again_is_in_the_history_a_push_sends() {
        let Some((home, _, wt)) = lane("ld-hist-key") else { return };
        let key = format!("ghp_{}", "b".repeat(36));
        commit_in(&wt, "notes.txt", &format!("token={key}\n"));
        sh(&wt, &["rm", "-q", "notes.txt"]);
        sh(&wt, &["commit", "-q", "-m", "tidy"]);
        // the folder shows nothing: the lane's net change is empty
        assert!(get(&home, &wt).files.is_empty());
        let h = pushed(&home, &wt);
        assert_eq!(h, History { files: vec!["notes.txt".into()], unread: false });
        assert!(!format!("{h:?}").contains(&key));
        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn a_key_in_a_commit_s_message_names_the_commit() {
        let Some((home, _, wt)) = lane("ld-hist-msg") else { return };
        let key = format!("ghp_{}", "c".repeat(36));
        sh(&wt, &["commit", "-q", "--allow-empty", "-m", &format!("notes\n\ntoken={key}")]);
        let id = sh(&wt, &["rev-parse", "HEAD"]);
        let h = pushed(&home, &wt);
        assert_eq!(h, History { files: vec![id[..12].to_string()], unread: false });
        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn an_added_line_that_looks_like_a_file_s_header_is_read_as_the_line_it_is() {
        let Some((home, _, wt)) = lane("ld-hist-header") else { return };
        let key = format!("ghp_{}", "d".repeat(36));
        // `++ x` added is `+++ x` in the patch, as a file's header is
        commit_in(&wt, "notes.txt", &format!("++ {key}\n"));
        assert!(!pushed(&home, &wt).files.is_empty());
        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn commits_a_remote_holds_are_not_read_and_clean_ones_hold_nothing() {
        let Some((home, d)) = repo("ld-hist-remote") else { return };
        let key = format!("ghp_{}", "e".repeat(36));
        // a key already on the remote, before the lane was made: a push of the lane does not send it again
        commit_in(&d, "old.txt", &format!("token={key}\n"));
        let bare = home.join("origin.git");
        sh(&home, &["init", "-q", "--bare", &bare.to_string_lossy()]);
        sh(&d, &["remote", "add", "origin", &bare.to_string_lossy()]);
        sh(&d, &["push", "-q", "origin", "main"]);
        let made = lane::make(&home, &d, &names(&["kit/x"])).unwrap();
        let wt = PathBuf::from(made.worktree);
        commit_in(&wt, "clean.txt", "nothing here\n");
        assert_eq!(pushed(&home, &wt), History { files: vec![], unread: false });
        // the pane's own read does not ask for it
        assert!(get(&home, &wt).history.is_none());
        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn more_commits_than_it_reads_or_a_binary_one_are_unread() {
        let Some((home, _, wt)) = lane("ld-hist-caps") else { return };
        let git = Git::automatic(&home).unwrap();
        commit_in(&wt, "one.txt", "1\n");
        commit_in(&wt, "two.txt", "2\n");
        // with the first commit of the repository, three commits; a read of two at most says it could not read them all
        assert!(history(&git, &wt, BUDGET, 2).unread);
        assert!(!history(&git, &wt, BUDGET, 3).unread);
        fs::write(wt.join("logo.bin"), [0u8, 159, 146, 150, 0, 1, 2]).unwrap();
        sh(&wt, &["add", "logo.bin"]);
        sh(&wt, &["commit", "-q", "-m", "logo"]);
        assert!(pushed(&home, &wt).unread);
        let _ = fs::remove_dir_all(home);
    }
    /// Item 146: the pane's review reads the folder as two kinds of section, the work not committed yet and each commit.
    fn reviewed(home: &Path, wt: &Path) -> LaneReview {
        review(home, &wt.to_string_lossy()).unwrap()
    }

    fn files_of(p: &Part) -> Vec<&str> {
        let mut v: Vec<&str> = p.files.iter().map(|f| f.path.as_str()).collect();
        v.sort_unstable();
        v
    }

    #[test]
    fn the_review_has_the_work_not_committed_and_each_commit_with_its_files() {
        let Some((home, _, wt)) = lane("ld-rv-sections") else { return };
        // two commits, then a change not committed, a file added to the index only and a file git has not seen
        commit_in(&wt, "kept.txt", "kept\n");
        commit_in(&wt, "a.txt", "one\nchanged\n");
        fs::write(wt.join("apps/web/b.txt"), "two\nedited\n").unwrap();
        fs::write(wt.join("staged.txt"), "staged\n").unwrap();
        sh(&wt, &["add", "staged.txt"]);
        fs::write(wt.join("fresh.txt"), "fresh\n").unwrap();
        let r = reviewed(&home, &wt);
        // the folder against HEAD: nothing a commit already holds
        assert_eq!(files_of(&r.uncommitted), vec!["apps/web/b.txt", "fresh.txt", "staged.txt"], "{r:?}");
        let b = r.uncommitted.files.iter().find(|f| f.path == "apps/web/b.txt").unwrap();
        assert!(b.state == "changed" && b.diff.contains("+edited"), "{b:?}");
        let staged = r.uncommitted.files.iter().find(|f| f.path == "staged.txt").unwrap();
        assert!(staged.state == "new" && staged.diff.contains("+staged"), "{staged:?}");
        // the commits, newest first, each against its own parent
        assert_eq!(r.commits.iter().map(|c| c.subject.as_str()).collect::<Vec<_>>(), vec!["a.txt", "kept.txt"], "{r:?}");
        assert_eq!(r.more_commits, 0);
        let (newest, older) = (&r.commits[0], &r.commits[1]);
        assert_eq!(newest.id.len(), 12);
        assert_eq!(files_of(&Part { files: newest.files.clone(), more_files: 0 }), vec!["a.txt"]);
        assert!(newest.files[0].state == "changed" && newest.files[0].diff.contains("+changed") && !newest.files[0].diff.contains("kept"), "{newest:?}");
        assert!(older.files[0].path == "kept.txt" && older.files[0].state == "new" && older.files[0].diff.contains("+kept"), "{older:?}");
        assert!(!newest.unread && !older.unread);
        // the folder's own read is as it was: one list, everything since the lane started
        assert_eq!(get(&home, &wt).files.len(), 5);
        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn a_clean_lane_has_no_sections_and_the_base_s_work_is_not_the_lane_s() {
        let Some((home, d, wt)) = lane("ld-rv-clean") else { return };
        let r = reviewed(&home, &wt);
        assert!(r.uncommitted.files.is_empty() && r.commits.is_empty() && r.more_commits == 0, "{r:?}");
        // the base moves on and the lane takes it in by a merge: the merge is not one of the lane's commits, and the base's own
        // commits are not either, since the lane's start moved up to where they part
        commit_in(&d, "from-main.txt", "main\n");
        commit_in(&wt, "mine.txt", "mine\n");
        sh(&wt, &["merge", "-q", "--no-edit", "main"]);
        let r = reviewed(&home, &wt);
        assert_eq!(r.commits.iter().map(|c| c.subject.as_str()).collect::<Vec<_>>(), vec!["mine.txt"], "{r:?}");
        assert!(r.uncommitted.files.is_empty());
        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn a_rename_in_a_commit_is_paired_and_a_deleted_file_says_so() {
        let Some((home, _, wt)) = lane("ld-rv-rename") else { return };
        sh(&wt, &["mv", "apps/web/b.txt", "apps/web/c.txt"]);
        sh(&wt, &["rm", "-q", "a.txt"]);
        sh(&wt, &["commit", "-q", "-m", "move and remove"]);
        let r = reviewed(&home, &wt);
        let c = &r.commits[0];
        let mv = c.files.iter().find(|f| f.path == "apps/web/c.txt").unwrap();
        assert!(mv.state == "renamed" && mv.from.as_deref() == Some("apps/web/b.txt"), "{mv:?}");
        let gone = c.files.iter().find(|f| f.path == "a.txt").unwrap();
        assert!(gone.state == "deleted" && gone.diff.contains("-one"), "{gone:?}");
        assert!(r.uncommitted.files.is_empty());
        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn more_commits_than_the_review_reads_are_counted() {
        let Some((home, _, wt)) = lane("ld-rv-commits") else { return };
        for i in 0..(REVIEW_COMMITS + 3) {
            commit_in(&wt, &format!("c{i:02}.txt"), "x\n");
        }
        let r = reviewed(&home, &wt);
        assert_eq!((r.commits.len(), r.more_commits), (REVIEW_COMMITS, 3), "{:?}", r.commits.iter().map(|c| &c.subject).collect::<Vec<_>>());
        // the newest are the ones read
        assert_eq!(r.commits[0].subject, format!("c{:02}.txt", REVIEW_COMMITS + 2));
        assert!(r.commits.iter().all(|c| c.files.len() == 1 && !c.unread));
        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn the_files_are_counted_across_the_sections_with_the_work_not_committed_first() {
        let Some((home, _, wt)) = lane("ld-rv-files") else { return };
        // two commits of 50 files each, then 30 files not committed: 100 files are room for 30, then 50 of the newer commit, then
        // 20 of the older, whose other 30 are counted
        for dir in ["old", "new"] {
            fs::create_dir_all(wt.join(dir)).unwrap();
            for i in 0..50 {
                fs::write(wt.join(format!("{dir}/f{i:02}.txt")), "x\n").unwrap();
            }
            sh(&wt, &["add", dir]);
            sh(&wt, &["commit", "-q", "-m", dir]);
        }
        fs::create_dir_all(wt.join("wip")).unwrap();
        for i in 0..30 {
            fs::write(wt.join(format!("wip/w{i:02}.txt")), "w\n").unwrap();
        }
        let r = reviewed(&home, &wt);
        assert_eq!((r.uncommitted.files.len(), r.uncommitted.more_files), (30, 0));
        assert_eq!(r.commits.iter().map(|c| c.subject.as_str()).collect::<Vec<_>>(), vec!["new", "old"]);
        assert_eq!((r.commits[0].files.len(), r.commits[0].more_files), (50, 0));
        assert_eq!((r.commits[1].files.len(), r.commits[1].more_files), (20, 30));
        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn a_key_in_a_commit_or_its_subject_is_masked_before_it_leaves() {
        let Some((home, _, wt)) = lane("ld-rv-key") else { return };
        let key = format!("ghp_{}", "f".repeat(36));
        commit_in(&wt, "notes.txt", &format!("token={key}\n"));
        sh(&wt, &["commit", "-q", "--allow-empty", "-m", &format!("use {key} here")]);
        fs::write(wt.join("a.txt"), format!("token={key}\n")).unwrap();
        let r = reviewed(&home, &wt);
        let all = format!("{r:?}");
        assert!(!all.contains(&key), "{all}");
        assert!(r.commits[0].subject.contains("••••"), "{:?}", r.commits[0]);
        assert!(r.commits[1].files[0].diff.contains("••••"));
        assert!(r.uncommitted.files[0].diff.contains("••••"));
        // a long subject is cut, and a multi-line message gives its first line
        sh(&wt, &["commit", "-q", "--allow-empty", "-m", &format!("{}\n\nbody line", "w".repeat(SUBJECT_MAX + 50))]);
        let r = reviewed(&home, &wt);
        assert_eq!(r.commits[0].subject.chars().count(), SUBJECT_MAX);
        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn the_review_refuses_what_the_diff_refuses() {
        let Some((home, d, wt)) = lane("ld-rv-refused") else { return };
        for p in [d.to_string_lossy().into_owned(), wt.join("apps").to_string_lossy().into_owned(), "web-app".into(), format!("{}/../x", wt.display()), "/no/such/folder".into(), String::new()] {
            assert_eq!(review(&home, &p).unwrap_err(), "not_a_lane", "{p}");
        }
        let marker = crate::lane::tests::filter_in(&home, &d, &wt);
        assert_eq!(review(&home, &wt.to_string_lossy()).unwrap_err(), "config:filter.spy.clean");
        assert!(!marker.exists(), "a program ran: {}", fs::read_to_string(&marker).unwrap_or_default());
        let _ = fs::remove_dir_all(home);
    }

    #[cfg(unix)]
    #[test]
    fn no_program_the_repository_names_runs_to_review() {
        use std::os::unix::fs::PermissionsExt;
        let Some((home, d, wt)) = lane("ld-rv-programs") else { return };
        // the commit is made first: git run by the test itself would run the hooks below, and only the app's own read is on trial
        commit_in(&wt, "kept.txt", "kept\n");
        let marker = home.join("ran");
        let script = home.join("spy.sh");
        fs::write(&script, format!("#!/bin/sh\necho ran >> '{}'\ncat \"$@\" 2>/dev/null\n", marker.display())).unwrap();
        fs::set_permissions(&script, fs::Permissions::from_mode(0o755)).unwrap();
        let s = script.to_string_lossy().into_owned();
        sh(&d, &["config", "diff.external", &s]);
        sh(&d, &["config", "diff.spy.textconv", &s]);
        sh(&d, &["config", "core.fsmonitor", &s]);
        fs::write(d.join(".gitattributes"), "*.txt diff=spy\n").unwrap();
        for hook in ["post-index-change", "reference-transaction", "post-checkout"] {
            let h = d.join(".git/hooks").join(hook);
            fs::create_dir_all(h.parent().unwrap()).unwrap();
            fs::write(&h, format!("#!/bin/sh\necho ran >> '{}'\n", marker.display())).unwrap();
            fs::set_permissions(&h, fs::Permissions::from_mode(0o755)).unwrap();
        }
        fs::write(wt.join("a.txt"), "one\nchanged\n").unwrap();
        fs::write(wt.join("fresh.txt"), "new\n").unwrap();
        let r = reviewed(&home, &wt);
        assert!(r.uncommitted.files.iter().any(|f| f.path == "a.txt" && f.diff.contains("+changed")), "{r:?}");
        assert!(r.commits[0].files[0].diff.contains("+kept"), "{r:?}");
        assert!(!marker.exists(), "a program ran: {}", fs::read_to_string(&marker).unwrap_or_default());
        let _ = fs::remove_dir_all(home);
    }
}
