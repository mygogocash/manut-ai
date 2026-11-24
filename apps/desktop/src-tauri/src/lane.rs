//! A lane's own working folder (`src/code/laneBranch.ts`). When Kit starts a piece of work in a project, the page asks for a
//! git worktree of the developer's repository on a branch of its own, made from the branch the developer's folder is on. The
//! lane's agent works in that folder, so several lanes can work at once without touching each other's files, and nothing a
//! lane does moves the developer's folder: its branch, index, stash and HEAD stay as they are.
//!
//! Where the folders live: `~/.manut/lanes/<project>/<words>`, under the app's own data folder and never inside the
//! developer's folder or its `.git`. `<project>` is the repository folder's name as one plain word, `<words>` the branch's
//! words after `kit/` (`kit/promptpay-qr` works in `~/.manut/lanes/web-app/promptpay-qr`), with `-2`, `-3` … when that name
//! is taken on disk. git keeps its own note of each worktree in the repository (`.git/worktrees/<name>`), as it does for any.
//!
//! How the app knows its own: beside each folder it makes, a record of it, `<words>.json`, written before git is asked
//! and naming the folder beside it, the repository, the branch and the branch it was made from. Only a folder with such a
//! record, exactly two names below `~/.manut/lanes`, that git still lists as a worktree of the recorded repository, is ever
//! removed. Nothing here runs `git worktree prune`, and `--force` only ever reaches a folder the app made, after the person
//! said yes to what it holds.
//!
//! What comes along: the committed tree only. The developer's uncommitted changes stay in their folder, and nothing git
//! ignores (installed dependencies, build output) is copied or linked. No hook runs while a folder is made or removed, so
//! nothing a project sets up on checkout happens by itself: Kit may install what the lane needs, and the dial asks first.
//!
//! When a folder goes: when its session is closed, if nothing in it would be lost (git says no file in it is changed or new).
//! Otherwise it is kept, and the Code page lists it with Remove, which says how many changed files go with it; the branch
//! stays unless the person also asks for it to go, and a branch with commits that are not on its base goes only after the
//! person saw how many. Every refusal is a short code the page maps to its own words; the agent still starts without a
//! lane of its own.
//!
//! git runs with a fixed argument list (no shell, nothing on stdin, no prompt), as `tasks.rs` runs its CLIs, and every name
//! from the page is checked here first, so none can be read as an option or a path.

use std::collections::HashSet;
use std::ffi::OsStr;
use std::fs;
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use crate::git_branch;
use crate::tasks;

/// The most names one call tries (the page sends nine).
const NAMES_MAX: usize = 20;
/// The longest a branch name is. The page makes them far shorter.
const NAME_MAX: usize = 64;
/// How long making or removing a lane's folder may take: a checkout writes every file the project tracks, which on a large
/// project takes longer than a read.
const SLOW: Duration = Duration::from_secs(120);
/// The most numbered folder names tried when a lane's own is taken on disk.
const FOLDER_TRIES: usize = 50;
/// The most folders and records read when the lanes are listed: a person never has this many.
const RECORDS_MAX: usize = 500;
/// The kept lanes whose changes and commits are read in one list; the rest say they could not be read.
const STATUS_MAX: usize = 20;
/// The largest record read: one is a few hundred bytes.
const RECORD_BYTES: u64 = 16 * 1024;

/// Making and removing lanes one at a time, so two calls never choose the same folder or remove one twice. Reads take no
/// turn: they only look.
static WRITING: Mutex<()> = Mutex::new(());

/// What was made: the lane's branch, the one it was made from (a short commit when the folder was detached), the folder the
/// lane works in, and the worktree's own folder, which names the lane to the shell when it goes. `dir` is the worktree, or
/// the folder inside it that matches the developer's (a lane started in `apps/web` of a repository works in `apps/web` of
/// its worktree). `left`: how many changed or new files the developer's folder has that did not come along (0 when git
/// could not say), so the lane can say its work starts from the last commit.
#[derive(Debug, Serialize, PartialEq)]
pub struct Made {
    pub branch: String,
    pub base: String,
    pub dir: String,
    pub worktree: String,
    pub left: u32,
}

/// The app's record of one worktree it made, `<lanes>/<project>/<words>.json`, beside the folder it names.
#[derive(Debug, Serialize, Deserialize, Clone, PartialEq)]
struct Record {
    v: u32,
    /// The worktree's folder: always the record's own path without `.json`.
    worktree: String,
    /// git's own folder of the repository, the one every worktree of it shares (its common dir), as a real path.
    repo: String,
    /// The developer's folder the lane was made from.
    project: String,
    /// Where the lane works inside the worktree ("" or `apps/web`).
    prefix: String,
    branch: String,
    base: String,
    /// The commit the branch was made at.
    at: String,
    /// When, in seconds since 1970.
    made: u64,
}

/// A lane's working folder as the Code page lists it: the folders the app made for one repository, with whether each is still
/// there, how many of its files are changed or new (null: not read), and how many commits on its branch are not on its base
/// (null: not read, or its base is gone).
#[derive(Debug, Serialize, PartialEq)]
pub struct Kept {
    pub worktree: String,
    pub dir: String,
    pub branch: String,
    pub base: String,
    pub made: u64,
    pub exists: bool,
    pub changed: Option<u32>,
    pub ahead: Option<u32>,
}

/// What the person said yes to when a lane's folder goes. `changed`: how many changed or new files they saw counted and said
/// may go with it (0: none may, so a folder with any is kept). `branch`: delete the branch too. `ahead`: how many commits on
/// the branch not on its base they saw counted (null: the count could not be read) and said may go with it.
#[derive(Debug, Deserialize, Default)]
pub struct RemoveAsk {
    #[serde(default)]
    pub changed: u32,
    #[serde(default)]
    pub branch: bool,
    #[serde(default)]
    pub ahead: Option<u32>,
}

/// What happened. `removed`: the folder is gone. `deleted`: the branch is gone. When nothing was done because what is there
/// differs from what the person saw, `removed` is false and `changed` and `ahead` say what is there now. `error`: git's own
/// line when the branch could not be deleted after the folder went.
#[derive(Debug, Serialize, PartialEq, Default)]
pub struct Removed {
    pub removed: bool,
    pub deleted: bool,
    pub changed: Option<u32>,
    pub ahead: Option<u32>,
    pub error: Option<String>,
}

/// Whether `name` is a branch name Kit makes: `kit/` and then lower case words and numbers joined by single hyphens.
pub fn valid_name(name: &str) -> bool {
    let Some(rest) = name.strip_prefix("kit/") else { return false };
    name.len() <= NAME_MAX
        && !rest.is_empty()
        && rest.split('-').all(|w| !w.is_empty() && w.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit()))
}

/// `<home>/.manut/lanes`: the app's own folder for every lane's working folder.
pub fn lanes_dir(home: &Path) -> PathBuf {
    home.join(".manut").join("lanes")
}

/// Whether `path` is a lane's working folder or a folder inside one: two names or more below [`lanes_dir`]. turn_files.rs
/// keeps a lane's turns there, while the app's own data folder around it stays far too broad to keep.
pub fn in_a_lane(home: &Path, path: &Path) -> bool {
    path.strip_prefix(lanes_dir(home)).map(|rest| rest.components().count() >= 2 && rest.components().all(|c| matches!(c, Component::Normal(_)))).unwrap_or(false)
}

/// The files and folders git keeps while it is partway through something that moves `HEAD` or the index. A lane made then
/// would start from the middle of the developer's own operation.
const IN_PROGRESS: [&str; 7] = ["rebase-merge", "rebase-apply", "MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "BISECT_LOG", "index.lock"];

fn in_progress(git_dir: &Path) -> bool {
    IN_PROGRESS.iter().any(|f| git_dir.join(f).exists())
}

/// The environment variables that would point `git` at another repository than the folder it is run in.
const REDIRECTS: [&str; 7] = ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_COMMON_DIR", "GIT_NAMESPACE", "GIT_CEILING_DIRECTORIES"];

/// The person's own `git`, run with no hook and no file-system monitor (each can run a program the repository names: a
/// post-checkout hook that installs dependencies, a reference-transaction hook on a deleted branch), English messages, no
/// prompt, and no optional lock (a status never takes the index's lock to refresh it).
struct Git {
    exe: PathBuf,
    /// `core.hooksPath`: a folder that is never made, so git finds no hook in it.
    hooks: String,
}

impl Git {
    fn new(home: &Path) -> Result<Git, String> {
        let exe = tasks::find("git").ok_or("git_missing")?;
        Ok(Git { exe, hooks: format!("core.hooksPath={}", lanes_dir(home).join(".no-hooks").display()) })
    }

    /// `git -C <cwd> <args>`, at most `limit`.
    fn run_for(&self, cwd: &Path, args: &[&str], limit: Duration) -> Result<tasks::Ran, String> {
        let mut argv: Vec<String> = vec!["-C".into(), cwd.to_string_lossy().into_owned(), "-c".into(), self.hooks.clone(), "-c".into(), "core.fsmonitor=false".into()];
        argv.extend(args.iter().map(|a| (*a).to_string()));
        tasks::run_env_for(&self.exe, &argv, true, &[("GIT_TERMINAL_PROMPT", "0"), ("LC_ALL", "C"), ("GIT_OPTIONAL_LOCKS", "0")], &REDIRECTS, limit)
    }

    fn run(&self, cwd: &Path, args: &[&str]) -> Result<tasks::Ran, String> {
        self.run_for(cwd, args, tasks::TIMEOUT)
    }

    /// The first line git printed, when it ran and said yes.
    fn line(&self, cwd: &Path, args: &[&str]) -> Option<String> {
        let ran = self.run(cwd, args).ok()?;
        (ran.code == Some(0)).then(|| ran.out.lines().next().unwrap_or("").trim().to_string())
    }

    /// git's own folder for the repository `cwd` is in, the one every worktree of it shares, as a real path.
    fn common_dir(&self, cwd: &Path) -> Option<PathBuf> {
        let line = self.line(cwd, &["rev-parse", "--git-common-dir"]).filter(|l| !l.is_empty())?;
        let p = PathBuf::from(line);
        let p = if p.is_absolute() { p } else { cwd.join(p) };
        p.canonicalize().ok()
    }

    /// The branches under `kit/` that exist, lower-cased (a file system that ignores letter case treats two as one).
    fn taken(&self, cwd: &Path) -> Result<HashSet<String>, String> {
        let ran = self.run(cwd, &["for-each-ref", "--format=%(refname:short)", "refs/heads/kit/"])?;
        if ran.code != Some(0) {
            return Err(tasks::error_line(&ran.err));
        }
        Ok(ran.out.lines().map(|l| l.trim().to_lowercase()).filter(|l| !l.is_empty()).collect())
    }

    /// The worktrees git lists for the repository whose git folder is `repo`, as real paths where they exist.
    fn worktrees(&self, repo: &Path) -> Option<Vec<PathBuf>> {
        let ran = self.run(repo, &["worktree", "list", "--porcelain"]).ok()?;
        if ran.code != Some(0) {
            return None;
        }
        Some(ran.out.lines().filter_map(|l| l.strip_prefix("worktree ")).map(|p| real(Path::new(p))).collect())
    }

    /// How many files in worktree `wt` are changed or new (not ignored), or None when git could not say.
    fn changed(&self, wt: &Path) -> Option<u32> {
        let ran = self.run(wt, &["status", "--porcelain=v1", "--untracked-files=all", "--ignore-submodules=none"]).ok()?;
        (ran.code == Some(0)).then(|| ran.out.lines().filter(|l| !l.trim().is_empty()).count() as u32)
    }

    /// How many commits on `branch` are not on `base` (the branch it was made from, as it is now; else the commit it was
    /// made at, when that branch is gone), or None when git could not say.
    fn ahead(&self, at: &Path, rec: &Record) -> Option<u32> {
        if !valid_name(&rec.branch) {
            return None;
        }
        for from in [rec.base.as_str(), rec.at.as_str()] {
            if !safe_rev(from) {
                continue;
            }
            let range = format!("{from}..{}", rec.branch);
            if let Some(n) = self.line(at, &["rev-list", "--count", &range]).and_then(|l| l.parse().ok()) {
                return Some(n);
            }
        }
        None
    }
}

/// `p` as its real path when it exists, else as it is.
fn real(p: &Path) -> PathBuf {
    p.canonicalize().unwrap_or_else(|_| p.to_path_buf())
}

/// Whether `rev` is a branch name or commit id that can stand on either side of `..` and never be read as an option.
fn safe_rev(rev: &str) -> bool {
    !rev.is_empty()
        && rev.len() <= 200
        && !rev.starts_with(['-', '.', '/'])
        && !rev.ends_with(['/', '.'])
        && !rev.contains("..")
        && !rev.contains("//")
        && !rev.ends_with(".lock")
        && rev.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'/' | b'-'))
}

/// The repository folder's name as one plain word for the folder that holds its lanes: letters, digits, `.`, `_` and `-`,
/// anything else as one `-`, at most 40 characters, never starting or ending with a dot or a hyphen; `project` when nothing
/// is left. So it is never `.`, `..` or a word git or a shell reads as anything but a name.
fn project_word(top: &Path) -> String {
    let raw = top.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let mut out = String::new();
    for c in raw.chars() {
        let c = if c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-') { c } else { '-' };
        if c == '-' && out.ends_with('-') {
            continue;
        }
        out.push(c);
    }
    let trim = |s: &str| s.trim_matches(|c| c == '-' || c == '.').to_string();
    let out: String = trim(&out).chars().take(40).collect();
    let out = trim(&out);
    if out.is_empty() {
        "project".into()
    } else {
        out
    }
}

fn is_link(p: &Path) -> bool {
    fs::symlink_metadata(p).map(|m| m.file_type().is_symlink()).unwrap_or(false)
}

/// Makes `dir` for this account only when it is missing, and refuses one that is a link or a file: the folders lanes live in
/// are the app's own, and nothing is written through a link.
fn own_dir(dir: &Path) -> Result<(), String> {
    let check = || match fs::symlink_metadata(dir) {
        Ok(m) if m.file_type().is_symlink() => Err(format!("{} is a link", dir.display())),
        Ok(m) if !m.is_dir() => Err(format!("{} is not a folder", dir.display())),
        Ok(_) => Ok(true),
        Err(_) => Ok(false),
    };
    if check()? {
        return Ok(());
    }
    #[cfg(unix)]
    let made = {
        use std::os::unix::fs::DirBuilderExt;
        fs::DirBuilder::new().mode(0o700).create(dir)
    };
    #[cfg(not(unix))]
    let made = fs::create_dir(dir);
    match made {
        Ok(()) => Ok(()),
        // another call made it first: it is used if it is a folder
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => check().map(|_| ()),
        Err(e) => Err(e.to_string()),
    }
}

/// Writes `bytes` to the new file `path`, readable by this account only. A file or link already at `path` is never written
/// through: the call fails instead.
fn write_new(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let mut o = fs::OpenOptions::new();
    o.write(true).create_new(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut o, 0o600);
    let mut f = o.open(path)?;
    f.write_all(bytes).inspect_err(|_| {
        let _ = fs::remove_file(path);
    })
}

/// The record at `path`, when it is a plain file the app wrote: a link, a file too big or one that does not read as a
/// record is no record. Its folder must be the record's own path without `.json`, so a record can only ever name the folder
/// beside it.
fn read_record(path: &Path) -> Option<Record> {
    let md = fs::symlink_metadata(path).ok()?;
    if !md.is_file() || md.len() > RECORD_BYTES {
        return None;
    }
    let mut text = String::new();
    fs::File::open(path).ok()?.take(RECORD_BYTES).read_to_string(&mut text).ok()?;
    let r: Record = serde_json::from_str(&text).ok()?;
    let own = path.with_extension("");
    (r.v == 1 && valid_name(&r.branch) && Path::new(&r.worktree) == own && Path::new(&r.repo).is_absolute()).then_some(r)
}

/// Every record of a folder the app made, with its path: `<lanes>/<project>/<words>.json`, two names below the lanes'
/// folder, none of them a link.
fn records(home: &Path) -> Vec<(PathBuf, Record)> {
    let lanes = lanes_dir(home);
    if is_link(&home.join(".manut")) || is_link(&lanes) {
        return Vec::new();
    }
    let Ok(projects) = fs::read_dir(&lanes) else { return Vec::new() };
    let mut out = Vec::new();
    for p in projects.flatten().take(RECORDS_MAX) {
        // the entry's own type: a link to a folder is not a folder here
        if !p.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            continue;
        }
        let Ok(files) = fs::read_dir(p.path()) else { continue };
        for f in files.flatten().take(RECORDS_MAX) {
            let path = f.path();
            if f.file_type().map(|t| t.is_file()).unwrap_or(false) && path.extension() == Some(OsStr::new("json")) {
                if let Some(r) = read_record(&path) {
                    out.push((path, r));
                }
            }
        }
    }
    out
}

fn now_secs() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

/// Makes a lane's working folder: the first of `names` that no branch has, as a new branch made from the commit the folder
/// `cwd` is on, checked out in a worktree of its own under [`lanes_dir`]. The developer's folder is not touched.
pub fn make(home: &Path, cwd: &Path, names: &[String]) -> Result<Made, String> {
    if names.is_empty() || names.len() > NAMES_MAX || !names.iter().all(|n| valid_name(n)) {
        return Err("bad_name".into());
    }
    if !cwd.is_absolute() || !cwd.is_dir() {
        return Err("not_a_repository".into());
    }
    let git_dir = git_branch::git_dir(cwd).ok_or("not_a_repository")?;
    if in_progress(&git_dir) {
        return Err("busy".into());
    }
    let git = Git::new(home)?;
    // no commit yet: there is nothing to make a branch from
    let Some(at) = git.line(cwd, &["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]).filter(|l| l.len() >= 40 && l.bytes().all(|b| b.is_ascii_hexdigit())) else {
        return Err("no_commit".into());
    };
    // the work tree's top folder, and where the developer's folder is inside it
    let ran = git.run(cwd, &["rev-parse", "--show-toplevel", "--show-prefix"])?;
    if ran.code != Some(0) {
        return Err("not_a_repository".into());
    }
    let mut lines = ran.out.lines();
    let top = PathBuf::from(lines.next().unwrap_or("").trim());
    let prefix = lines.next().unwrap_or("").trim().trim_end_matches('/').to_string();
    if !top.is_absolute() || prefix.chars().any(char::is_control) || Path::new(&prefix).components().any(|c| !matches!(c, Component::Normal(_))) {
        return Err("not_a_repository".into());
    }
    // a folder the branch does not hold (one git ignores, or only new files) would not be in the lane's folder
    if !prefix.is_empty() && git.line(cwd, &["cat-file", "-t", &format!("{at}:{prefix}")]).as_deref() != Some("tree") {
        return Err("not_committed".into());
    }
    let repo = git.common_dir(cwd).ok_or("not_a_repository")?;
    let base = git_branch::branch(cwd);
    if base.is_empty() {
        return Err("not_a_repository".into());
    }

    let _turn = WRITING.lock().unwrap_or_else(|e| e.into_inner());
    let exists = git.taken(cwd)?;
    let lanes = lanes_dir(home);
    let parent = lanes.join(project_word(&top));
    for d in [home.join(".manut"), lanes.clone(), parent.clone()] {
        own_dir(&d)?;
    }
    for name in names.iter().filter(|n| !exists.contains(&n.to_lowercase())) {
        let words = &name["kit/".len()..];
        // the first folder name nothing has on disk, its record written first: the record is what says the folder is the
        // app's, and writing it as a new file claims the name before git makes the folder
        let Some((wt, rec_path)) = (1..=FOLDER_TRIES).find_map(|n| {
            let folder = if n == 1 { words.to_string() } else { format!("{words}-{n}") };
            let wt = parent.join(&folder);
            let rec_path = parent.join(format!("{folder}.json"));
            if fs::symlink_metadata(&wt).is_ok() || fs::symlink_metadata(&rec_path).is_ok() {
                return None;
            }
            let wt_s = wt.to_str()?.to_string();
            let rec = Record {
                v: 1,
                worktree: wt_s,
                repo: repo.to_string_lossy().into_owned(),
                project: cwd.to_string_lossy().into_owned(),
                prefix: prefix.clone(),
                branch: name.clone(),
                base: base.clone(),
                at: at.clone(),
                made: now_secs(),
            };
            write_new(&rec_path, serde_json::to_string(&rec).ok()?.as_bytes()).ok()?;
            Some((wt, rec_path))
        }) else {
            return Err("no_folder".into());
        };
        let wt_s = wt.to_string_lossy().into_owned();
        let ran = git.run_for(cwd, &["worktree", "add", "--no-track", "-b", name, &wt_s, &at], SLOW);
        // a step after the checkout may fail the command (or a slow one be stopped): what matters is whether the folder is
        // there, on the lane's branch
        if git_branch::branch(&wt) == *name {
            let inner = wt.join(&prefix);
            let dir = if prefix.is_empty() || !inner.is_dir() { wt.clone() } else { inner };
            // read without the index's lock, so the developer's index is never written
            let left = git.changed(cwd).unwrap_or(0);
            return Ok(Made { branch: name.clone(), base, dir: dir.to_string_lossy().into_owned(), worktree: wt_s, left });
        }
        let err = match &ran {
            Ok(r) => tasks::error_line(&r.err),
            Err(e) => e.clone(),
        };
        // another process made the branch (or the folder) first: git made nothing, so the record goes and the next name is
        // tried. Whatever has that name is someone else's, and is never taken back
        if err.contains("already exists") {
            let _ = fs::remove_file(&rec_path);
            continue;
        }
        if undo_make(&git, cwd, &wt, name, &at) {
            let _ = fs::remove_file(&rec_path);
        }
        return Err(err);
    }
    Err("taken".into())
}

/// Takes back a lane's folder that git could not finish making: the folder, when git made one, and the branch, while it is
/// still where it was made and on no folder. Both are the app's own, made a moment ago with nothing of anyone's in them.
/// True when nothing of it is left, so its record can go too.
fn undo_make(git: &Git, cwd: &Path, wt: &Path, name: &str, at: &str) -> bool {
    let wt_s = wt.to_string_lossy().into_owned();
    if fs::symlink_metadata(wt).is_ok() {
        let listed = git.common_dir(cwd).and_then(|r| git.worktrees(&r)).is_some_and(|l| l.contains(&real(wt)));
        if !listed {
            // a folder git does not list as its worktree is not one this call made: it stays, and so does its record
            return false;
        }
        let gone = git.run_for(cwd, &["worktree", "remove", "--force", &wt_s], SLOW).map(|r| r.code == Some(0)).unwrap_or(false);
        if !gone {
            return false;
        }
    }
    let ref_name = format!("refs/heads/{name}");
    if git.line(cwd, &["rev-parse", "--verify", "--quiet", &ref_name]).as_deref() == Some(at) {
        let _ = git.run(cwd, &["branch", "-D", name]);
    }
    true
}

/// The lanes the app made for the repository `cwd` is in, newest first.
pub fn list(home: &Path, cwd: &Path) -> Result<Vec<Kept>, String> {
    if !cwd.is_absolute() || !cwd.is_dir() || git_branch::git_dir(cwd).is_none() {
        return Ok(Vec::new());
    }
    let Ok(git) = Git::new(home) else { return Ok(Vec::new()) };
    let Some(repo) = git.common_dir(cwd) else { return Ok(Vec::new()) };
    let mut mine: Vec<Record> = records(home).into_iter().map(|(_, r)| r).filter(|r| real(Path::new(&r.repo)) == repo).collect();
    mine.sort_by(|a, b| b.made.cmp(&a.made).then_with(|| a.worktree.cmp(&b.worktree)));
    Ok(mine
        .into_iter()
        .enumerate()
        .map(|(i, r)| {
            let wt = PathBuf::from(&r.worktree);
            let exists = fs::symlink_metadata(&wt).map(|m| m.is_dir()).unwrap_or(false);
            let read = exists && i < STATUS_MAX;
            let dir = if r.prefix.is_empty() { wt.clone() } else { wt.join(&r.prefix) };
            Kept {
                dir: dir.to_string_lossy().into_owned(),
                changed: if read { git.changed(&wt) } else { None },
                ahead: if read { git.ahead(&wt, &r) } else { None },
                exists,
                worktree: r.worktree,
                branch: r.branch,
                base: r.base,
                made: r.made,
            }
        })
        .collect())
}

/// The developer's folders the app's lanes were made from, one each, while they are there: the Code page lists a project whose
/// last session closed while its lane's folder was kept, so the folder is never out of sight.
pub fn projects(home: &Path) -> Vec<String> {
    let mut out: Vec<String> = records(home).into_iter().map(|(_, r)| r.project).filter(|p| Path::new(p).is_dir()).collect();
    out.sort();
    out.dedup();
    out
}

/// Removes the lane's folder `worktree` (one [`make`] made and recorded), and its branch when `ask.branch` says so, once what
/// is there is what the person saw: see [`RemoveAsk`]. A folder with changed or new files goes only with `ask.changed` equal
/// to their number, a branch with commits not on its base only with `ask.ahead` equal to theirs; otherwise nothing is done
/// and the answer says what is there now. Refuses anything the app did not make (`not_a_lane`).
pub fn remove(home: &Path, worktree: &str, ask: &RemoveAsk) -> Result<Removed, String> {
    let lanes = lanes_dir(home);
    let wt = PathBuf::from(worktree);
    let rest: Vec<Component> = match wt.strip_prefix(&lanes) {
        Ok(r) if wt.is_absolute() => r.components().collect(),
        _ => return Err("not_a_lane".into()),
    };
    if rest.len() != 2 || !rest.iter().all(|c| matches!(c, Component::Normal(_))) {
        return Err("not_a_lane".into());
    }
    let parent = wt.parent().ok_or("not_a_lane")?.to_path_buf();
    if [home.join(".manut"), lanes.clone(), parent.clone(), wt.clone()].iter().any(|p| is_link(p)) {
        return Err("not_a_lane".into());
    }
    let rec_path = wt.with_extension("json");
    // the record beside the folder, naming exactly this folder (a name with a dot in it would read another's record)
    let rec = read_record(&rec_path).filter(|r| Path::new(&r.worktree) == wt).ok_or("not_a_lane")?;
    let git = Git::new(home)?;
    let _turn = WRITING.lock().unwrap_or_else(|e| e.into_inner());
    let repo = real(Path::new(&rec.repo));
    let exists = fs::symlink_metadata(&wt).map(|m| m.is_dir()).unwrap_or(false);
    if exists {
        // the folder must still be a worktree of the recorded repository, as git lists it: anything else put there since is
        // not the app's to remove
        let ours = git.common_dir(&wt).as_ref() == Some(&repo) && git.worktrees(&repo).is_some_and(|l| l.contains(&real(&wt)));
        if !ours {
            return Err("not_a_lane".into());
        }
    }
    let changed = if exists { git.changed(&wt).ok_or("git could not say what changed in the folder")? } else { 0 };
    let ahead = if ask.branch { git.ahead(&repo, &rec) } else { None };
    if (changed > 0 && changed != ask.changed) || (ask.branch && ahead != ask.ahead && ahead != Some(0)) {
        return Ok(Removed { changed: Some(changed), ahead, ..Removed::default() });
    }

    // git's own note of the worktree goes with it; for a folder already gone, only the note
    let mut args = vec!["worktree", "remove"];
    if changed > 0 {
        args.push("--force");
    }
    args.push(worktree);
    let ran = git.run_for(&repo, &args, SLOW)?;
    if ran.code != Some(0) && (exists || git.worktrees(&repo).is_some_and(|l| l.contains(&real(&wt)))) {
        return Err(tasks::error_line(&ran.err));
    }
    if fs::symlink_metadata(&wt).is_ok() {
        return Err("the folder is still there".into());
    }
    let mut out = Removed { removed: true, ..Removed::default() };
    if ask.branch {
        match git.run(&repo, &["branch", "-D", &rec.branch]) {
            Ok(r) if r.code == Some(0) => out.deleted = true,
            Ok(r) => out.error = Some(tasks::error_line(&r.err)),
            Err(e) => out.error = Some(e),
        }
    }
    let _ = fs::remove_file(&rec_path);
    // the project's folder goes when it holds no other lane (a folder with anything in it stays)
    let _ = fs::remove_dir(&parent);
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("manut-lane-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d.canonicalize().unwrap()
    }

    /// Runs git in `dir` for a test's setup, with an identity so a commit works on a machine that has none.
    fn sh(dir: &Path, args: &[&str]) -> String {
        let out = Command::new("git")
            .args(["-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", "-c", "init.defaultBranch=main"])
            .args(args)
            .current_dir(dir)
            .env_remove("GIT_DIR")
            .env_remove("GIT_WORK_TREE")
            .output()
            .expect("git runs");
        assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
        String::from_utf8_lossy(&out.stdout).trim().to_string()
    }

    /// A home folder and, in it, a repository `web-app` on `main` with one commit, a tracked `a.txt` and `apps/web/b.txt`,
    /// and `node_modules` ignored; or None when this machine has no git (the tests then say so and pass, as the rest of the
    /// shell's tests do for a program that is not there).
    fn repo(name: &str) -> Option<(PathBuf, PathBuf)> {
        tasks::find("git")?;
        let home = tmp(name);
        let d = home.join("code").join("web-app");
        fs::create_dir_all(d.join("apps/web")).unwrap();
        sh(&d, &["init", "-q"]);
        sh(&d, &["symbolic-ref", "HEAD", "refs/heads/main"]);
        fs::write(d.join("a.txt"), "one\n").unwrap();
        fs::write(d.join("apps/web/b.txt"), "two\n").unwrap();
        fs::write(d.join(".gitignore"), "node_modules/\n").unwrap();
        sh(&d, &["add", "."]);
        sh(&d, &["commit", "-q", "-m", "first"]);
        Some((home, d))
    }

    fn names(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    fn commit_in(dir: &Path, file: &str, text: &str) {
        fs::write(dir.join(file), text).unwrap();
        sh(dir, &["add", file]);
        sh(dir, &["commit", "-q", "-m", file]);
    }

    #[test]
    fn a_name_is_only_ever_the_narrow_form_kit_makes() {
        for ok in ["kit/promptpay-qr", "kit/x", "kit/fix-stock-sync-2", "kit/a1-b2"] {
            assert!(valid_name(ok), "{ok}");
        }
        let long = format!("kit/{}", "a".repeat(80));
        for bad in ["", "main", "kit/", "kit", "Kit/x", "kit/X", "kit/a b", "kit/a--b", "kit/-a", "kit/a-", "kit/a/b", "kit/..", "kit/a.lock", "kit/a.b", "-kit/x", "--help", "kit/--x", "kit/é", "kit/a\n", &long] {
            assert!(!valid_name(bad), "{bad:?}");
        }
    }

    #[test]
    fn a_project_word_is_one_plain_name() {
        for (folder, word) in [("web-app", "web-app"), ("Baan Mali (pre-order)", "Baan-Mali-pre-order"), ("..", "project"), (".hidden", "hidden"), ("-x-", "x"), ("ร้าน", "project"), ("a..b", "a..b")] {
            assert_eq!(project_word(&Path::new("/code").join(folder)), word, "{folder}");
        }
        assert_eq!(project_word(Path::new(&format!("/code/{}", "x".repeat(60)))).len(), 40);
    }

    #[test]
    fn a_lane_folder_is_two_names_or_more_below_the_lanes_folder() {
        let home = Path::new("/Users/you");
        assert!(in_a_lane(home, Path::new("/Users/you/.manut/lanes/web-app/promptpay-qr")));
        assert!(in_a_lane(home, Path::new("/Users/you/.manut/lanes/web-app/promptpay-qr/apps/web")));
        for no in ["/Users/you/.manut/lanes", "/Users/you/.manut/lanes/web-app", "/Users/you/.manut", "/Users/you/.manut/turn-snapshots/s1/x", "/Users/you/code/web-app", "/Users/you/.manut/lanes/../lanes/a/b"] {
            assert!(!in_a_lane(home, Path::new(no)), "{no}");
        }
    }

    #[test]
    fn makes_a_working_folder_of_its_own_and_leaves_the_developers_folder_as_it_was() {
        let Some((home, d)) = repo("make") else { return };
        let main = sh(&d, &["rev-parse", "main"]);
        // the developer's own work: a change, a staged change, a new file, a stash, and installed dependencies
        commit_in(&d, "c.txt", "three\n");
        let main2 = sh(&d, &["rev-parse", "main"]);
        fs::write(d.join("c.txt"), "three\nstashed\n").unwrap();
        sh(&d, &["stash", "-q"]);
        fs::write(d.join("a.txt"), "one\nmine\n").unwrap();
        fs::write(d.join("apps/web/b.txt"), "two\nstaged\n").unwrap();
        sh(&d, &["add", "apps/web/b.txt"]);
        fs::write(d.join("new.txt"), "new\n").unwrap();
        fs::create_dir_all(d.join("node_modules/qrcode")).unwrap();
        fs::write(d.join("node_modules/qrcode/index.js"), "x\n").unwrap();
        let before = (sh(&d, &["status", "--porcelain"]), sh(&d, &["stash", "list"]), sh(&d, &["symbolic-ref", "HEAD"]));

        let made = make(&home, &d, &names(&["kit/promptpay-qr", "kit/promptpay-qr-2"])).unwrap();
        let wt = home.join(".manut/lanes/web-app/promptpay-qr");
        // three of the developer's files did not come along: a change, a staged change and a new file (never what git ignores)
        assert_eq!(made, Made { branch: "kit/promptpay-qr".into(), base: "main".into(), dir: wt.to_string_lossy().into(), worktree: wt.to_string_lossy().into(), left: 3 });
        // the developer's folder: same branch, same index, same stash, same files
        assert_eq!((sh(&d, &["status", "--porcelain"]), sh(&d, &["stash", "list"]), sh(&d, &["symbolic-ref", "HEAD"])), before);
        assert_eq!(git_branch::branch(&d), "main");
        assert_eq!(sh(&d, &["rev-parse", "main"]), main2);
        assert_eq!(fs::read_to_string(d.join("a.txt")).unwrap(), "one\nmine\n");
        // the lane: on its own branch at main's commit, with the committed files only
        assert_eq!(git_branch::branch(&wt), "kit/promptpay-qr");
        assert_eq!(sh(&d, &["rev-parse", "kit/promptpay-qr"]), main2);
        assert_ne!(main, main2);
        assert_eq!(fs::read_to_string(wt.join("a.txt")).unwrap(), "one\n");
        assert_eq!(fs::read_to_string(wt.join("apps/web/b.txt")).unwrap(), "two\n");
        assert_eq!(fs::read_to_string(wt.join("c.txt")).unwrap(), "three\n");
        assert!(!wt.join("new.txt").exists() && !wt.join("node_modules").exists());
        assert_eq!(sh(&wt, &["status", "--porcelain"]), "");
        // git lists it as a worktree, and the app's record says it made it
        assert!(sh(&d, &["worktree", "list", "--porcelain"]).contains(&format!("worktree {}", wt.display())));
        let rec = read_record(&wt.with_extension("json")).unwrap();
        assert_eq!((rec.branch.as_str(), rec.base.as_str(), rec.at.as_str(), rec.prefix.as_str()), ("kit/promptpay-qr", "main", main2.as_str(), ""));
        assert_eq!(Path::new(&rec.repo), d.join(".git").canonicalize().unwrap());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(fs::metadata(home.join(".manut/lanes")).unwrap().permissions().mode() & 0o777, 0o700);
            assert_eq!(fs::metadata(wt.with_extension("json")).unwrap().permissions().mode() & 0o777, 0o600);
        }
        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn two_lanes_work_at_once_each_on_its_own_branch_made_from_the_developers() {
        let Some((home, d)) = repo("two") else { return };
        let main = sh(&d, &["rev-parse", "main"]);
        let a = make(&home, &d, &names(&["kit/thai-date-format"])).unwrap();
        // the first lane commits on its branch while the second is made: the second does not stack on it
        commit_in(Path::new(&a.dir), "a.txt", "one\nthai\n");
        let b = make(&home, &d, &names(&["kit/fix-stock-sync"])).unwrap();
        assert_eq!((a.base.as_str(), b.base.as_str()), ("main", "main"));
        assert_eq!(sh(&d, &["rev-parse", "kit/fix-stock-sync"]), main);
        assert_ne!(a.dir, b.dir);
        assert_eq!(fs::read_to_string(Path::new(&b.dir).join("a.txt")).unwrap(), "one\n");
        // each works on its own files
        fs::write(Path::new(&b.dir).join("a.txt"), "one\nstock\n").unwrap();
        assert_eq!(fs::read_to_string(Path::new(&a.dir).join("a.txt")).unwrap(), "one\nthai\n");
        assert_eq!(git_branch::branch(&d), "main");
        assert_eq!(fs::read_to_string(d.join("a.txt")).unwrap(), "one\n");
        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn takes_the_next_name_or_folder_when_one_is_taken_and_refuses_when_all_are() {
        let Some((home, d)) = repo("taken") else { return };
        sh(&d, &["branch", "kit/promptpay-qr"]);
        sh(&d, &["branch", "kit/promptpay-qr-2"]);
        let made = make(&home, &d, &names(&["kit/promptpay-qr", "kit/promptpay-qr-2", "kit/promptpay-qr-3"])).unwrap();
        assert_eq!(made.branch, "kit/promptpay-qr-3");
        assert_eq!(make(&home, &d, &names(&["kit/promptpay-qr", "kit/promptpay-qr-2"])), Err("taken".into()));
        assert_eq!(make(&home, &d, &names(&["kit/Promptpay-Qr"])), Err("bad_name".into()));
        // a folder of that name is on disk already (another repository of the same name, a folder kept): the next number
        fs::create_dir_all(home.join(".manut/lanes/web-app/checkout")).unwrap();
        let next = make(&home, &d, &names(&["kit/checkout"])).unwrap();
        assert_eq!((next.branch.as_str(), next.worktree.ends_with("/web-app/checkout-2")), ("kit/checkout", true));
        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn works_in_the_same_folder_inside_its_worktree_and_from_a_detached_commit() {
        let Some((home, d)) = repo("sub") else { return };
        let made = make(&home, &d.join("apps/web"), &names(&["kit/web"])).unwrap();
        assert!(made.dir.ends_with("/.manut/lanes/web-app/web/apps/web"), "{}", made.dir);
        assert_eq!(fs::read_to_string(Path::new(&made.dir).join("b.txt")).unwrap(), "two\n");
        // a folder the branch does not hold is not in a lane's folder
        fs::create_dir_all(d.join("scratch")).unwrap();
        fs::write(d.join("scratch/x.txt"), "x").unwrap();
        assert_eq!(make(&home, &d.join("scratch"), &names(&["kit/x"])), Err("not_committed".into()));
        let sha = sh(&d, &["rev-parse", "HEAD"]);
        sh(&d, &["checkout", "-q", "--detach"]);
        let made = make(&home, &d, &names(&["kit/x"])).unwrap();
        assert_eq!(made.base, sha[..7]);
        assert_eq!(git_branch::branch(&d), sha[..7]);
        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn makes_it_from_a_linked_worktree_and_leaves_both_of_the_developers_alone() {
        let Some((home, d)) = repo("wt") else { return };
        let mine = home.join("code").join("web-app-dev");
        sh(&d, &["worktree", "add", "-q", "-b", "feat/dev", mine.to_str().unwrap()]);
        let mine = mine.canonicalize().unwrap();
        let made = make(&home, &mine, &names(&["kit/x"])).unwrap();
        assert_eq!((made.branch.as_str(), made.base.as_str()), ("kit/x", "feat/dev"));
        assert_eq!((git_branch::branch(&mine), git_branch::branch(&d)), ("feat/dev".to_string(), "main".to_string()));
        assert_eq!(git_branch::branch(Path::new(&made.dir)), "kit/x");
        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn refuses_what_it_cannot_make_a_lane_from_or_would_disturb() {
        let plain = tmp("plain");
        assert_eq!(make(&plain, &plain, &names(&["kit/x"])), Err("not_a_repository".into()));
        assert_eq!(make(&plain, Path::new("relative/dir"), &names(&["kit/x"])), Err("not_a_repository".into()));
        assert_eq!(make(&plain, &plain.join("missing"), &names(&["kit/x"])), Err("not_a_repository".into()));
        assert!(!plain.join(".manut").exists());
        let _ = fs::remove_dir_all(plain);

        // no commit yet
        if tasks::find("git").is_some() {
            let empty = tmp("empty");
            sh(&empty, &["init", "-q"]);
            assert_eq!(make(&empty, &empty, &names(&["kit/x"])), Err("no_commit".into()));
            let _ = fs::remove_dir_all(empty);
        }

        // in the middle of something of the developer's own
        let Some((home, d)) = repo("busy") else { return };
        for marker in ["MERGE_HEAD", "rebase-merge", "CHERRY_PICK_HEAD", "REVERT_HEAD", "BISECT_LOG", "index.lock"] {
            let p = d.join(".git").join(marker);
            fs::write(&p, "x").unwrap();
            assert_eq!(make(&home, &d, &names(&["kit/x"])), Err("busy".into()), "{marker}");
            fs::remove_file(&p).unwrap();
        }
        assert!(!home.join(".manut").exists());
        assert!(make(&home, &d, &names(&["kit/x"])).is_ok());
        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn never_runs_git_with_a_name_it_does_not_make() {
        let Some((home, d)) = repo("badname") else { return };
        for bad in [names(&[]), names(&["main"]), names(&["--orphan"]), names(&["kit/x", "-b"]), names(&["kit/x y"]), (0..21).map(|i| format!("kit/n{i}")).collect()] {
            assert_eq!(make(&home, &d, &bad), Err("bad_name".into()), "{bad:?}");
        }
        assert_eq!(sh(&d, &["branch", "--list", "--format=%(refname:short)"]), "main");
        assert!(!home.join(".manut").exists());
        let _ = fs::remove_dir_all(home);
    }

    #[cfg(unix)]
    #[test]
    fn never_writes_through_a_link() {
        let Some((home, d)) = repo("links") else { return };
        let away = home.join("away");
        fs::create_dir_all(&away).unwrap();
        fs::create_dir_all(home.join(".manut")).unwrap();
        std::os::unix::fs::symlink(&away, home.join(".manut/lanes")).unwrap();
        assert!(make(&home, &d, &names(&["kit/x"])).unwrap_err().contains("is a link"));
        fs::remove_file(home.join(".manut/lanes")).unwrap();
        fs::create_dir_all(home.join(".manut/lanes")).unwrap();
        std::os::unix::fs::symlink(&away, home.join(".manut/lanes/web-app")).unwrap();
        assert!(make(&home, &d, &names(&["kit/x"])).unwrap_err().contains("is a link"));
        fs::remove_file(home.join(".manut/lanes/web-app")).unwrap();
        // a link planted where the record would go: that name is not used, and nothing is written through it
        fs::create_dir_all(home.join(".manut/lanes/web-app")).unwrap();
        std::os::unix::fs::symlink(away.join("rec.json"), home.join(".manut/lanes/web-app/x.json")).unwrap();
        let made = make(&home, &d, &names(&["kit/x"])).unwrap();
        assert!(made.worktree.ends_with("/web-app/x-2"));
        assert_eq!(fs::read_dir(&away).unwrap().count(), 0);
        assert_eq!(sh(&d, &["branch", "--list", "--format=%(refname:short)", "kit/*"]), "kit/x");
        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn lists_the_lanes_it_made_for_this_repository_with_what_is_in_them() {
        let Some((home, d)) = repo("list") else { return };
        let a = make(&home, &d, &names(&["kit/a"])).unwrap();
        let b = make(&home, &d, &names(&["kit/b"])).unwrap();
        // another repository's lane is not this one's
        let other = home.join("code").join("other");
        fs::create_dir_all(&other).unwrap();
        sh(&other, &["init", "-q"]);
        commit_in(&other, "o.txt", "o\n");
        make(&home, &other, &names(&["kit/o"])).unwrap();
        fs::write(Path::new(&a.dir).join("a.txt"), "changed\n").unwrap();
        fs::write(Path::new(&a.dir).join("new.txt"), "new\n").unwrap();
        commit_in(Path::new(&b.dir), "b.txt", "b\n");
        commit_in(Path::new(&b.dir), "b2.txt", "b\n");
        // a record that names another folder than the one beside it is no record
        let fake = Record { v: 1, worktree: d.to_string_lossy().into(), repo: d.join(".git").to_string_lossy().into(), project: String::new(), prefix: String::new(), branch: "kit/z".into(), base: "main".into(), at: String::new(), made: 0 };
        fs::write(home.join(".manut/lanes/web-app/z.json"), serde_json::to_string(&fake).unwrap()).unwrap();

        let got = list(&home, &d).unwrap();
        let by = |w: &str| got.iter().find(|k| k.worktree == w).unwrap();
        assert_eq!(got.len(), 2, "{got:?}");
        assert_eq!((by(&a.worktree).changed, by(&a.worktree).ahead, by(&a.worktree).exists), (Some(2), Some(0), true));
        assert_eq!((by(&b.worktree).changed, by(&b.worktree).ahead), (Some(0), Some(2)));
        // read from a lane's own folder, the list is the same repository's
        assert_eq!(list(&home, Path::new(&a.dir)).unwrap().len(), 2);
        assert_eq!(list(&home, &other).unwrap().len(), 1);
        assert_eq!(list(&home, &home).unwrap(), vec![]);
        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn names_the_projects_its_lanes_were_made_from_once_each_while_they_are_there() {
        let Some((home, d)) = repo("projects") else { return };
        assert_eq!(projects(&home), Vec::<String>::new());
        make(&home, &d, &names(&["kit/a"])).unwrap();
        make(&home, &d, &names(&["kit/b"])).unwrap();
        make(&home, &d.join("apps/web"), &names(&["kit/web"])).unwrap();
        let web = d.join("apps/web").to_string_lossy().into_owned();
        assert_eq!(projects(&home), vec![d.to_string_lossy().into_owned(), web.clone()]);
        // a developer's folder that is gone is no project to list
        fs::remove_dir_all(d.join("apps")).unwrap();
        assert_eq!(projects(&home), vec![d.to_string_lossy().into_owned()]);
        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn removes_a_folder_with_nothing_in_it_that_would_be_lost_and_keeps_the_branch() {
        let Some((home, d)) = repo("remove") else { return };
        let a = make(&home, &d, &names(&["kit/a"])).unwrap();
        commit_in(Path::new(&a.dir), "a2.txt", "kept on the branch\n");
        let tip = sh(&d, &["rev-parse", "kit/a"]);
        let got = remove(&home, &a.worktree, &RemoveAsk::default()).unwrap();
        assert_eq!(got, Removed { removed: true, ..Removed::default() });
        assert!(!Path::new(&a.worktree).exists() && !Path::new(&a.worktree).with_extension("json").exists());
        assert_eq!(sh(&d, &["rev-parse", "kit/a"]), tip);
        assert!(!sh(&d, &["worktree", "list"]).contains(".manut"));
        assert_eq!(git_branch::branch(&d), "main");
        // the project's folder went with its last lane
        assert!(!home.join(".manut/lanes/web-app").exists());
        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn keeps_a_folder_with_changes_until_the_person_said_yes_to_that_many() {
        let Some((home, d)) = repo("changes") else { return };
        let a = make(&home, &d, &names(&["kit/a"])).unwrap();
        fs::write(Path::new(&a.dir).join("a.txt"), "changed\n").unwrap();
        fs::write(Path::new(&a.dir).join("new.txt"), "new\n").unwrap();
        // ignored files go with the folder and are never counted
        fs::create_dir_all(Path::new(&a.dir).join("node_modules/q")).unwrap();
        fs::write(Path::new(&a.dir).join("node_modules/q/i.js"), "x").unwrap();
        let kept = remove(&home, &a.worktree, &RemoveAsk::default()).unwrap();
        assert_eq!(kept, Removed { changed: Some(2), ..Removed::default() });
        assert!(Path::new(&a.dir).join("new.txt").exists());
        // the person saw one file; there are two now
        assert_eq!(remove(&home, &a.worktree, &RemoveAsk { changed: 1, ..RemoveAsk::default() }).unwrap(), Removed { changed: Some(2), ..Removed::default() });
        assert!(Path::new(&a.dir).exists());
        let gone = remove(&home, &a.worktree, &RemoveAsk { changed: 2, ..RemoveAsk::default() }).unwrap();
        assert!(gone.removed && !gone.deleted);
        assert!(!Path::new(&a.worktree).exists());
        assert_eq!(sh(&d, &["branch", "--list", "--format=%(refname:short)", "kit/*"]), "kit/a");
        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn deletes_the_branch_only_when_asked_and_its_commits_were_counted() {
        let Some((home, d)) = repo("branch") else { return };
        let a = make(&home, &d, &names(&["kit/a"])).unwrap();
        // nothing on it that is not on main: it goes when asked
        let got = remove(&home, &a.worktree, &RemoveAsk { branch: true, ahead: Some(0), ..RemoveAsk::default() }).unwrap();
        assert!(got.removed && got.deleted, "{got:?}");
        assert_eq!(sh(&d, &["branch", "--list", "kit/*"]), "");

        let b = make(&home, &d, &names(&["kit/b"])).unwrap();
        commit_in(Path::new(&b.dir), "b.txt", "b\n");
        commit_in(Path::new(&b.dir), "b2.txt", "b\n");
        // two commits that are only on it: not without the person's yes to two
        for ahead in [None, Some(0), Some(1)] {
            let no = remove(&home, &b.worktree, &RemoveAsk { branch: true, ahead, ..RemoveAsk::default() }).unwrap();
            assert_eq!(no, Removed { changed: Some(0), ahead: Some(2), ..Removed::default() }, "{ahead:?}");
            assert!(Path::new(&b.worktree).exists());
        }
        let got = remove(&home, &b.worktree, &RemoveAsk { branch: true, ahead: Some(2), ..RemoveAsk::default() }).unwrap();
        assert!(got.removed && got.deleted, "{got:?}");
        assert_eq!(sh(&d, &["branch", "--list", "kit/*"]), "");
        assert_eq!(git_branch::branch(&d), "main");
        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn a_folder_removed_by_hand_takes_only_git_s_note_and_the_record_with_it() {
        let Some((home, d)) = repo("byhand") else { return };
        let a = make(&home, &d, &names(&["kit/a"])).unwrap();
        fs::remove_dir_all(&a.worktree).unwrap();
        assert!(!list(&home, &d).unwrap()[0].exists);
        let got = remove(&home, &a.worktree, &RemoveAsk::default()).unwrap();
        assert!(got.removed);
        assert!(!sh(&d, &["worktree", "list"]).contains(".manut"));
        assert_eq!(sh(&d, &["branch", "--list", "--format=%(refname:short)", "kit/*"]), "kit/a");
        assert_eq!(list(&home, &d).unwrap(), vec![]);
        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn never_removes_anything_it_did_not_make() {
        let Some((home, d)) = repo("notmine") else { return };
        let a = make(&home, &d, &names(&["kit/a"])).unwrap();
        let lanes = lanes_dir(&home);
        // the developer's folder, a folder outside the lanes, one level down, a folder with no record, a path with `..`, and a
        // name whose record is another folder's (`a.x` reads `a.json`)
        fs::create_dir_all(lanes.join("web-app/stray")).unwrap();
        fs::create_dir_all(lanes.join("web-app/a.x")).unwrap();
        for bad in [d.to_string_lossy().into_owned(), home.join("code").to_string_lossy().into_owned(), lanes.join("web-app").to_string_lossy().into_owned(), lanes.join("web-app/stray").to_string_lossy().into_owned(), format!("{}/../a", lanes.join("web-app").display()), "relative/web-app/a".into(), lanes.join("web-app/a.x").to_string_lossy().into_owned()] {
            assert_eq!(remove(&home, &bad, &RemoveAsk { changed: 9, branch: true, ahead: Some(9) }), Err("not_a_lane".into()), "{bad}");
        }
        assert!(d.join("a.txt").exists() && lanes.join("web-app/stray").exists() && lanes.join("web-app/a.x").exists());
        // a record pointing at another folder than its own is no record
        let rec = Record { v: 1, worktree: d.to_string_lossy().into(), repo: d.join(".git").to_string_lossy().into(), project: String::new(), prefix: String::new(), branch: "kit/a".into(), base: "main".into(), at: String::new(), made: 0 };
        fs::write(lanes.join("web-app/stray.json"), serde_json::to_string(&rec).unwrap()).unwrap();
        assert_eq!(remove(&home, &lanes.join("web-app/stray").to_string_lossy(), &RemoveAsk::default()), Err("not_a_lane".into()));
        // the lane's folder replaced by a clone of its own (not a worktree of the recorded repository): not the app's
        fs::remove_dir_all(&a.worktree).unwrap();
        sh(&home, &["clone", "-q", d.to_str().unwrap(), &a.worktree]);
        assert_eq!(remove(&home, &a.worktree, &RemoveAsk { changed: 9, ..RemoveAsk::default() }), Err("not_a_lane".into()));
        assert!(Path::new(&a.worktree).join("a.txt").exists());
        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn the_main_moved_note_reads_the_lane_in_its_own_folder() {
        let Some((home, d)) = repo("moved") else { return };
        let a = make(&home, &d, &names(&["kit/a"])).unwrap();
        // main moves in the developer's folder and the lane changes the same file in its own
        commit_in(&d, "a.txt", "one\nmain\n");
        fs::write(Path::new(&a.dir).join("a.txt"), "one\nlane\n").unwrap();
        let m = crate::git_moved::main_moved(Path::new(&a.dir), Some("main"), &[]).unwrap().unwrap();
        assert_eq!((m.branch.as_str(), m.base.as_str()), ("kit/a", "main"));
        assert_eq!((m.ours.clone(), m.theirs.clone()), (vec!["a.txt".to_string()], vec!["a.txt".to_string()]));
        // read from the developer's folder, it is about the developer's branch, which is main itself: nothing to say
        assert_eq!(crate::git_moved::main_moved(&d, Some("main"), &[]).unwrap(), None);
        let _ = fs::remove_dir_all(home);
    }
}
