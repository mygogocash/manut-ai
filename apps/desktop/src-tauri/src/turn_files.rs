//! Rewind to before a turn: the files and the chat go back together (docs/code-editor.md, "Rewind"). This module
//! keeps the files. When the person sends a message that starts a turn of a coding session, the page asks for a
//! snapshot of the session's folder first ([`Book::take`]); when the turn ends it asks for another ([`Book::end`]),
//! so a later rewind can tell what the agent changed from what changed outside its turns. A rewind
//! ([`Book::restore`]) first keeps the files as they are now, then puts back the snapshot from before the chosen
//! turn; the page then asks the agent to take the chat back to that turn, and tells this module how that went
//! ([`Book::settle`]): when the agent refused, the files go back as they were, so nothing is half done.
//!
//! Bring it back (the canvas's StatesCode "Reverted"): when the agent took the chat back, [`Book::settle`] keeps the
//! files as they were just before the rewind (`back`), and the files as the rewind left them (`rest`, to tell what
//! changed since), until the next turn starts. [`Book::back_preview`] says what [`Book::bring_back`] would put back,
//! and the files changed by hand since the rewind stay as they are unless the person says otherwise, as in a rewind.
//! Only the files come back: neither Claude Code nor Codex has a message that brings a rewound chat back.
//!
//! Where a snapshot lives:
//! - In a git repository, in git's own objects: each file's bytes as a blob, exactly as they are on disk (no filter,
//!   no line-ending conversion), and the snapshot as a tree kept alive by a ref of the app's own,
//!   `refs/manut/snapshots/<session>/<name>`. A ref that names a tree, not a commit, stays out of `git log --all`
//!   and every history view, and `git gc` keeps what it names. Nothing here touches the developer's branches,
//!   index, stash or HEAD: the trees are built in an index file of this module's own.
//! - In any other folder (or when git cannot run), as a copy in the app's data folder,
//!   `~/.manut/turn-snapshots/<session>/blobs/<sha256>`, each content once.
//!
//! Either way each snapshot's list of files (path, mode, size, times, content id) is a manifest in
//! `~/.manut/turn-snapshots/<session>/`, and a session keeps its newest [`Limits::snapshots`] turns. The page drops a
//! session's snapshots when the session is removed or its agent starts again (a new process can take back only the
//! messages it was sent itself), and the ones of sessions that are gone when the app starts.
//!
//! What a snapshot leaves out: what git ignores (in a repository), the folders a project rebuilds ([`REBUILT`]), the
//! files the system writes beside a project's own ([`SYSTEM_FILES`]), files over [`Limits::file`], and names it
//! cannot hold. A file left out is never kept and never touched by a rewind. A folder with more than
//! [`Limits::files`] files, or more than [`Limits::bytes`] in them, gets no snapshot, and its turns cannot be
//! rewound.
//!
//! Nothing pushed, merged or deployed is touched: a rewind writes files in the session's folder only, and never
//! moves a branch. A file the person changed by hand since the turn is listed by [`Book::preview`], and
//! [`Book::restore`] leaves every file the person chose to keep as it is.

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::ffi::OsStr;
use std::fs;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

/// How much a session keeps. [`LIMITS`] in the app; the tests make them small.
#[derive(Clone, Copy, Debug)]
pub(crate) struct Limits {
    /// turn-start snapshots kept per session: the oldest goes when a new one would pass this
    pub snapshots: usize,
    /// files in one snapshot: a folder with more gets none
    pub files: usize,
    /// bytes of one file: a bigger file is left out
    pub file: u64,
    /// bytes of all the files of one snapshot: a folder with more gets none
    pub bytes: u64,
}

pub(crate) const LIMITS: Limits = Limits { snapshots: 20, files: 50_000, file: 50 * 1024 * 1024, bytes: 1024 * 1024 * 1024 };

/// Folders a project rebuilds, never kept and never touched. In a folder that is not a git repository, which has no
/// ignore rules to read, all of these are left out wherever they are. In a repository git's own ignore rules leave
/// out the rest, and a build folder a repository tracks is part of the project, so only [`REBUILT_IN_GIT`] is.
pub(crate) const REBUILT: &[&str] = &[
    ".git",
    "node_modules",
    "bower_components",
    "target",
    "dist",
    "build",
    ".next",
    ".nuxt",
    ".svelte-kit",
    ".turbo",
    ".parcel-cache",
    ".cache",
    "coverage",
    "__pycache__",
    ".venv",
    "venv",
    ".tox",
    ".pytest_cache",
    ".mypy_cache",
    ".gradle",
    "Pods",
    "DerivedData",
    ".dart_tool",
    ".expo",
    ".terraform",
];

/// The folders left out of a git repository's snapshot even when git does not ignore them: a forgotten
/// `node_modules` is the one that is large often enough to matter.
pub(crate) const REBUILT_IN_GIT: &[&str] = &[".git", "node_modules"];

/// Files the system writes beside a project's own (the Finder's, Explorer's): never kept, so opening a folder in the
/// Finder between turns does not read as a change made by hand.
pub(crate) const SYSTEM_FILES: &[&str] = &[".DS_Store", "Thumbs.db", "desktop.ini"];

/// A file changed within this long before it was read may have been written again in the same tick, with the same
/// size and times (a coarse clock): it is read again next time instead of trusted by its stat data.
const RACY_NS: u64 = 2_000_000_000;

/// The mode of a symbolic link, as git writes it.
const LINK: u32 = 0o120000;

// ---------------------------------------------------------------------------------------------
// What a snapshot holds
// ---------------------------------------------------------------------------------------------

/// One file of a snapshot: its git-style mode (`100644`, `100755` or `120000`), its stat data (to know an unchanged
/// file without reading it again), its permission bits, and its content id (a git blob id, or a sha256 in the copy).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
struct Entry {
    m: u32,
    s: u64,
    /// modified, nanoseconds since 1970
    t: u64,
    /// status changed, nanoseconds since 1970 (0 where the system has no such time)
    c: u64,
    /// inode (0 where the system has none)
    i: u64,
    /// read, write and run bits, put back with the file (0: the default for its mode)
    #[serde(default)]
    p: u32,
    o: String,
}

/// A snapshot: the files of the session's folder at one moment.
#[derive(Serialize, Deserialize, Clone, Debug, Default)]
struct Manifest {
    v: u32,
    /// a turn-start snapshot's turn: the id of the person's message that started it
    #[serde(default)]
    turn: String,
    /// a turn-start snapshot's number; the end's: the start it followed; the undo's: the start it rewinds to
    n: u32,
    /// when its files were read (ms since 1970)
    at: u64,
    /// in a repository, HEAD's commit then ("" when none)
    #[serde(default)]
    head: String,
    files: BTreeMap<String, Entry>,
    /// files that were there but are not kept (too big, a name it cannot hold, not a file): never touched
    #[serde(default)]
    left: BTreeSet<String>,
    /// a turn-start snapshot's files that changed outside a turn since the turn before it ended
    #[serde(default)]
    hand: BTreeSet<String>,
}

/// A session's store: the folder it keeps, and where its contents live.
#[derive(Serialize, Deserialize, Clone, Debug)]
struct Meta {
    v: u32,
    /// the session's folder, as its real path
    root: String,
    /// "git" or "copy"
    store: String,
    /// the repository's git folder (`git rev-parse --absolute-git-dir`), for "git"
    #[serde(default)]
    git_dir: String,
    /// the number the next turn-start snapshot takes
    next: u32,
}

/// What a turn-start snapshot kept, for the page.
#[derive(Serialize, Debug, PartialEq)]
pub struct Taken {
    pub n: u32,
    pub files: usize,
    pub left: usize,
}

/// One file a rewind would put back: `changed` (it is there and goes back as it was), `back` (it was removed and
/// comes back) or `gone` (it was made since, and goes).
#[derive(Serialize, Debug, PartialEq, Eq, Clone)]
pub struct Change {
    pub path: String,
    pub change: &'static str,
}

/// What a rewind to before a turn would do, for the person to read before they confirm it.
#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Preview {
    pub back: Vec<Change>,
    /// of those, the files that changed outside the agent's turns since that turn: the person may keep them
    pub hand: Vec<String>,
    /// files too big to keep now, which stay as they are
    pub too_big: usize,
    /// in a repository, the branch moved since (a commit or a pull): the files go back, the commits stay
    pub head_moved: bool,
}

/// What a rewind did.
#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Restored {
    pub changed: usize,
    pub kept: usize,
    pub too_big: usize,
}

/// What [`Book::settle`] left behind. `back`: the files as they were just before a rewind that went through are kept, so
/// Bring it back can put them back (until the next turn starts). Never set for a rewind the agent refused, which put the
/// files back as they were itself.
#[derive(Serialize, Debug, PartialEq, Eq)]
pub struct Settled {
    pub back: bool,
}

// ---------------------------------------------------------------------------------------------
// Paths and names
// ---------------------------------------------------------------------------------------------

/// `<home>/.manut/turn-snapshots`.
pub fn root_dir(home: &Path) -> PathBuf {
    home.join(".manut").join("turn-snapshots")
}

/// A turn's id as the page makes it (its message's bubble id, `local-s7`): one plain word, so it is never a path.
pub fn valid_turn(id: &str) -> bool {
    (1..=80).contains(&id.len()) && id.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b':'))
}

/// A path relative to the session's folder, as a snapshot names it: `/`-separated parts, none empty, `.` or `..`, no
/// NUL, no line break (git reads the paths it hashes one per line), and on Windows no `\` or `:`. Anything else is
/// never read, written or deleted.
pub fn safe_rel(p: &str) -> bool {
    if p.is_empty() || p.starts_with('/') || p.contains(['\0', '\n', '\r']) || (cfg!(windows) && p.contains(['\\', ':'])) {
        return false;
    }
    p.split('/').all(|part| !part.is_empty() && part != "." && part != "..")
}

/// Whether a path is left out by its name: a part that is a folder the project rebuilds (`rebuilt`), or a system file.
fn left_out_by_name(p: &str, rebuilt: &[&str]) -> bool {
    let parts: Vec<&str> = p.split('/').collect();
    let last = parts.last().copied().unwrap_or("");
    SYSTEM_FILES.contains(&last) || parts[..parts.len().saturating_sub(1)].iter().any(|d| rebuilt.contains(d)) || last == ".git"
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// A number no other temporary file of this process has, for names that must not meet.
fn nonce() -> u64 {
    static N: AtomicU64 = AtomicU64::new(0);
    N.fetch_add(1, Ordering::Relaxed) ^ (now_ms() << 16)
}

fn path_bytes(p: &Path) -> Vec<u8> {
    #[cfg(unix)]
    {
        use std::os::unix::ffi::OsStrExt;
        p.as_os_str().as_bytes().to_vec()
    }
    #[cfg(not(unix))]
    {
        p.to_string_lossy().as_bytes().to_vec()
    }
}

/// Make `dir` (and the folders above it that are missing) for the app's own use only: a session's copy holds the
/// project's files, keys and all, so no other account on the computer may list or read it. A folder made earlier with
/// wider rights is closed too.
fn private_dir(dir: &Path) -> Result<(), String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::{DirBuilderExt, PermissionsExt};
        fs::DirBuilder::new().recursive(true).mode(0o700).create(dir).map_err(|e| e.to_string())?;
        fs::set_permissions(dir, fs::Permissions::from_mode(0o700)).map_err(|e| e.to_string())
    }
    #[cfg(not(unix))]
    {
        fs::create_dir_all(dir).map_err(|e| e.to_string())
    }
}

/// Write `bytes` to the new file `tmp`, readable by this account only from the moment it exists, then move it to
/// `dest`. A file already at `tmp` is never written through.
fn write_private(tmp: &Path, dest: &Path, bytes: &[u8]) -> Result<(), String> {
    let mut o = fs::OpenOptions::new();
    o.write(true).create_new(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut o, 0o600);
    o.open(tmp).and_then(|mut f| f.write_all(bytes)).and_then(|_| fs::rename(tmp, dest)).map_err(|e| {
        let _ = fs::remove_file(tmp);
        e.to_string()
    })
}

fn hex_id(s: &str) -> bool {
    (s.len() == 40 || s.len() == 64) && s.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
}

/// Each session's own lock: the page queues a session's calls, and this keeps two windows (or a stray call) from
/// running two at once on one store.
fn session_lock(session: &str) -> Arc<Mutex<()>> {
    static LOCKS: OnceLock<Mutex<HashMap<String, Arc<Mutex<()>>>>> = OnceLock::new();
    LOCKS.get_or_init(Default::default).lock().unwrap_or_else(|e| e.into_inner()).entry(session.to_string()).or_default().clone()
}

// ---------------------------------------------------------------------------------------------
// Stat data
// ---------------------------------------------------------------------------------------------

fn stat_entry(md: &fs::Metadata, m: u32) -> Entry {
    let t = md.modified().ok().and_then(|x| x.duration_since(UNIX_EPOCH).ok()).map(|d| d.as_nanos() as u64).unwrap_or(0);
    #[cfg(unix)]
    let (c, i, p) = {
        use std::os::unix::fs::MetadataExt;
        // read, write and run bits only: a rewind never sets a set-user, set-group or sticky bit
        ((md.ctime().max(0) as u64).saturating_mul(1_000_000_000).saturating_add(md.ctime_nsec().max(0) as u64), md.ino(), md.mode() & 0o777)
    };
    #[cfg(not(unix))]
    let (c, i, p) = (0, 0, 0);
    Entry { m, s: md.len(), t, c, i, p, o: String::new() }
}

fn executable(md: &fs::Metadata) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        md.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    {
        let _ = md;
        false
    }
}

/// Whether `now` is the file `was` describes, by its stat data, and `was` was read (at `read_ms`) well after the file
/// last changed: then its content id stands without reading the file again.
fn same(was: &Entry, now: &Entry, read_ms: u64) -> bool {
    was.m == now.m
        && was.s == now.s
        && was.t == now.t
        && was.c == now.c
        && was.i == now.i
        && !was.o.is_empty()
        && now.t.saturating_add(RACY_NS) < read_ms.saturating_mul(1_000_000)
}

// ---------------------------------------------------------------------------------------------
// git
// ---------------------------------------------------------------------------------------------

/// The git program, found once: on PATH or in the usual install folders. On macOS `/usr/bin/git` is a stand-in that
/// asks to install the developer tools when they are missing; it is used only when `xcode-select -p` says they are
/// there, so a snapshot never puts that dialog up.
fn git_program() -> Option<PathBuf> {
    static GIT: OnceLock<Option<PathBuf>> = OnceLock::new();
    GIT.get_or_init(|| {
        let found = crate::tasks::find("git")?;
        if cfg!(target_os = "macos") && found == Path::new("/usr/bin/git") {
            let mut c = Command::new("/usr/bin/xcode-select");
            c.arg("-p").stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
            if !c.status().map(|s| s.success()).unwrap_or(false) {
                return None;
            }
        }
        Some(found)
    })
    .clone()
}

/// git with nothing the repository configures that runs a program: no hook (`update-ref` runs reference-transaction
/// hooks), no file-system monitor. Variables that would point it at another repository or index are taken out.
fn git_command(git: &Path, home: &Path) -> Command {
    let mut c = Command::new(git);
    // a folder that is never made: git finds no hook in it
    c.arg("-c").arg(format!("core.hooksPath={}", root_dir(home).join(".no-hooks").display()));
    c.args(["-c", "core.fsmonitor=false"]);
    for k in ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_COMMON_DIR", "GIT_NAMESPACE"] {
        c.env_remove(k);
    }
    // a read never takes the index's lock to refresh it
    c.env("GIT_OPTIONAL_LOCKS", "0").env("GIT_TERMINAL_PROMPT", "0");
    crate::platform::no_console_window(&mut c);
    crate::appimage::host_env(&mut c);
    c
}

/// Run git `args` in `cwd` with `env` added and `input` on its stdin; its stdout. A failure says git's last line.
fn run_git(git: &Path, home: &Path, cwd: &Path, args: &[&str], env: &[(&str, &OsStr)], input: Option<Vec<u8>>) -> Result<Vec<u8>, String> {
    let mut c = git_command(git, home);
    c.args(args).current_dir(cwd).stdout(Stdio::piped()).stderr(Stdio::piped());
    c.stdin(if input.is_some() { Stdio::piped() } else { Stdio::null() });
    for (k, v) in env {
        c.env(k, v);
    }
    let mut child = c.spawn().map_err(|e| format!("could not run git: {e}"))?;
    // the input goes from its own thread, so a long list never waits on output nobody reads yet
    let writer = match (input, child.stdin.take()) {
        (Some(bytes), Some(mut stdin)) => Some(std::thread::spawn(move || {
            let _ = stdin.write_all(&bytes);
        })),
        _ => None,
    };
    let out = child.wait_with_output().map_err(|e| e.to_string())?;
    if let Some(w) = writer {
        let _ = w.join();
    }
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr);
        let last = err.lines().rev().find(|l| !l.trim().is_empty()).unwrap_or("failed").trim().to_string();
        return Err(format!("git {}: {last}", args.first().copied().unwrap_or("")));
    }
    Ok(out.stdout)
}

fn git_line(out: Vec<u8>) -> Result<String, String> {
    Ok(String::from_utf8(out).map_err(|_| "git printed something unreadable".to_string())?.trim().to_string())
}

/// Whether `root` or a folder above it holds a `.git`: only then is git asked about it.
fn has_dot_git(root: &Path) -> bool {
    root.ancestors().any(|d| fs::symlink_metadata(d.join(".git")).is_ok())
}

/// The repository `root` is inside, as its git folder, when git runs and says `root` is in a work tree.
fn repository_of(git: &Path, home: &Path, root: &Path) -> Option<PathBuf> {
    if !has_dot_git(root) {
        return None;
    }
    let out = run_git(git, home, root, &["rev-parse", "--is-inside-work-tree", "--absolute-git-dir"], &[], None).ok()?;
    let text = String::from_utf8(out).ok()?;
    let mut lines = text.lines();
    if lines.next()? != "true" {
        return None;
    }
    let dir = PathBuf::from(lines.next()?.trim());
    dir.is_dir().then_some(dir)
}

fn ref_name(session: &str, name: &str) -> String {
    format!("refs/manut/snapshots/{session}/{name}")
}

/// A running `git cat-file --batch`: one blob read at a time (it answers each request before the next), so a rewind
/// holds at most one file in memory.
struct CatFile {
    child: Child,
    stdin: ChildStdin,
    out: BufReader<ChildStdout>,
}

impl CatFile {
    fn open(git: &Path, home: &Path, dir: &Path) -> Result<CatFile, String> {
        let mut c = git_command(git, home);
        c.args(["cat-file", "--batch"]).current_dir(dir).env("GIT_DIR", dir).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null());
        let mut child = c.spawn().map_err(|e| format!("could not run git: {e}"))?;
        let stdin = child.stdin.take().ok_or("no stdin")?;
        let out = BufReader::new(child.stdout.take().ok_or("no stdout")?);
        Ok(CatFile { child, stdin, out })
    }
    fn read(&mut self, oid: &str) -> Result<Vec<u8>, String> {
        writeln!(self.stdin, "{oid}").and_then(|_| self.stdin.flush()).map_err(|e| e.to_string())?;
        let mut head = String::new();
        self.out.read_line(&mut head).map_err(|e| e.to_string())?;
        // "<oid> blob <size>", or "<oid> missing"
        let parts: Vec<&str> = head.split_whitespace().collect();
        let size = match parts.as_slice() {
            [_, "blob", size] => size.parse::<usize>().map_err(|_| "git printed something unreadable".to_string())?,
            _ => return Err(format!("the snapshot's copy of a file is missing ({oid})")),
        };
        let mut buf = vec![0u8; size];
        self.out.read_exact(&mut buf).map_err(|e| e.to_string())?;
        let mut nl = [0u8; 1];
        self.out.read_exact(&mut nl).map_err(|e| e.to_string())?;
        Ok(buf)
    }
}

impl Drop for CatFile {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

// ---------------------------------------------------------------------------------------------
// The two stores
// ---------------------------------------------------------------------------------------------

/// Where a session's contents live.
#[derive(Clone, Debug)]
enum Store {
    /// git's own objects in the repository whose git folder is `dir`
    Git { git: PathBuf, dir: PathBuf },
    /// a copy in the app's data folder, each content once under its sha256
    Copy { blobs: PathBuf },
}

impl Store {
    fn rebuilt(&self) -> &'static [&'static str] {
        match self {
            Store::Git { .. } => REBUILT_IN_GIT,
            Store::Copy { .. } => REBUILT,
        }
    }
}

/// Every file under `root` that is not in a folder the project rebuilds, as `/`-separated relative paths. Links are
/// listed, never followed. Stops once there are more than `max`.
fn walk(root: &Path, max: usize) -> Result<Vec<String>, String> {
    let mut out = Vec::new();
    let mut todo = vec![String::new()];
    while let Some(rel) = todo.pop() {
        let dir = if rel.is_empty() { root.to_path_buf() } else { root.join(&rel) };
        let Ok(rd) = fs::read_dir(&dir) else { continue };
        for e in rd.flatten() {
            let Some(name) = e.file_name().to_str().map(str::to_string) else {
                // a name that is not text cannot be kept: it is left out, and never touched
                continue;
            };
            let path = if rel.is_empty() { name.clone() } else { format!("{rel}/{name}") };
            match e.file_type() {
                Ok(ft) if ft.is_dir() => {
                    if !REBUILT.contains(&name.as_str()) {
                        todo.push(path);
                    }
                }
                Ok(_) => out.push(path),
                Err(_) => {}
            }
            if out.len() > max {
                return Err("why:too_many".into());
            }
        }
    }
    Ok(out)
}

/// The paths git lists for `root`: tracked, and untracked but not ignored, relative to `root`.
fn list_git(git: &Path, home: &Path, root: &Path) -> Result<Vec<String>, String> {
    let out = run_git(git, home, root, &["ls-files", "-z", "--cached", "--others", "--exclude-standard"], &[], None)?;
    let mut seen = BTreeSet::new();
    for raw in out.split(|b| *b == 0) {
        // a nested repository is listed as its folder (`name/`): it is not this project's files
        if raw.is_empty() || raw.ends_with(b"/") {
            continue;
        }
        if let Ok(p) = std::str::from_utf8(raw) {
            seen.insert(p.to_string());
        }
    }
    Ok(seen.into_iter().collect())
}

fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes).iter().map(|b| format!("{b:02x}")).collect()
}

/// The content ids of `todo` (paths under `root`, and whether each is a link), stored when `write` is set.
fn hash_files(store: &Store, home: &Path, root: &Path, todo: &[(String, bool)], write: bool) -> Result<Vec<String>, String> {
    let mut out = vec![String::new(); todo.len()];
    match store {
        Store::Git { git, dir } => {
            let files: Vec<usize> = (0..todo.len()).filter(|i| !todo[*i].1).collect();
            if !files.is_empty() {
                let mut input = Vec::new();
                for &i in &files {
                    input.extend(path_bytes(&root.join(&todo[i].0)));
                    input.push(b'\n');
                }
                // the bytes as they are on disk: --no-filters skips the clean filters and line-ending conversion
                let args: &[&str] = if write { &["hash-object", "-w", "--no-filters", "--stdin-paths"] } else { &["hash-object", "--no-filters", "--stdin-paths"] };
                let got = run_git(git, home, dir, args, &[("GIT_DIR", dir.as_os_str())], Some(input))?;
                let text = String::from_utf8(got).map_err(|_| "git printed something unreadable".to_string())?;
                let ids: Vec<&str> = text.lines().collect();
                if ids.len() != files.len() || !ids.iter().all(|x| hex_id(x)) {
                    return Err("git did not name every file".into());
                }
                for (k, &i) in files.iter().enumerate() {
                    out[i] = ids[k].to_string();
                }
            }
            // a link's blob is the path it points to, as git keeps a link (hash-object would follow it)
            for (i, (p, link)) in todo.iter().enumerate() {
                if *link {
                    let target = fs::read_link(root.join(p)).map_err(|e| format!("{p}: {e}"))?;
                    let args: &[&str] = if write { &["hash-object", "-w", "--stdin"] } else { &["hash-object", "--stdin"] };
                    let id = git_line(run_git(git, home, dir, args, &[("GIT_DIR", dir.as_os_str())], Some(path_bytes(&target)))?)?;
                    if !hex_id(&id) {
                        return Err("git did not name a link".into());
                    }
                    out[i] = id;
                }
            }
        }
        Store::Copy { blobs } => {
            for (i, (p, link)) in todo.iter().enumerate() {
                let bytes = if *link { fs::read_link(root.join(p)).map(|t| path_bytes(&t)) } else { fs::read(root.join(p)) }.map_err(|e| format!("{p}: {e}"))?;
                let id = sha256_hex(&bytes);
                if write {
                    let dest = blobs.join(&id);
                    if !dest.is_file() {
                        private_dir(blobs)?;
                        write_private(&blobs.join(format!(".tmp-{}-{}", std::process::id(), nonce())), &dest, &bytes)?;
                    }
                }
                out[i] = id;
            }
        }
    }
    Ok(out)
}

/// Reads a snapshot's contents back.
enum Reader {
    Git(CatFile),
    Copy(PathBuf),
}

impl Reader {
    fn open(store: &Store, home: &Path) -> Result<Reader, String> {
        Ok(match store {
            Store::Git { git, dir } => Reader::Git(CatFile::open(git, home, dir)?),
            Store::Copy { blobs } => Reader::Copy(blobs.clone()),
        })
    }
    fn read(&mut self, oid: &str) -> Result<Vec<u8>, String> {
        if !hex_id(oid) {
            return Err("not a content id".into());
        }
        match self {
            Reader::Git(c) => c.read(oid),
            Reader::Copy(blobs) => fs::read(blobs.join(oid)).map_err(|_| format!("the snapshot's copy of a file is missing ({oid})")),
        }
    }
}

// ---------------------------------------------------------------------------------------------
// Reading a folder
// ---------------------------------------------------------------------------------------------

/// The files of `root` now, as a snapshot. `cache` is an earlier snapshot of the same folder: a file whose stat data
/// it holds unchanged keeps its content id without being read. With `write` the contents are stored.
fn scan(store: &Store, home: &Path, root: &Path, cache: Option<&Manifest>, write: bool, limits: &Limits) -> Result<Manifest, String> {
    let at = now_ms();
    let paths = match store {
        Store::Git { git, .. } => list_git(git, home, root)?,
        Store::Copy { .. } => walk(root, limits.files)?,
    };
    if paths.len() > limits.files {
        return Err("why:too_many".into());
    }
    let mut m = Manifest { v: 1, at, head: head_of(store, home, root), ..Manifest::default() };
    let mut todo: Vec<(String, bool)> = Vec::new();
    let mut waiting: Vec<Entry> = Vec::new();
    let mut total = 0u64;
    for p in paths {
        if left_out_by_name(&p, store.rebuilt()) {
            continue;
        }
        if !safe_rel(&p) {
            m.left.insert(p);
            continue;
        }
        let Ok(md) = fs::symlink_metadata(root.join(&p)) else { continue };
        let ft = md.file_type();
        let (mode, link) = if ft.is_symlink() && cfg!(unix) {
            (LINK, true)
        } else if ft.is_file() {
            (if executable(&md) { 0o100755 } else { 0o100644 }, false)
        } else {
            // a folder git lists (a submodule), a pipe, a link where links cannot be made: never touched
            m.left.insert(p);
            continue;
        };
        if !link && md.len() > limits.file {
            m.left.insert(p);
            continue;
        }
        total = total.saturating_add(md.len());
        if total > limits.bytes {
            return Err("why:too_big".into());
        }
        let mut e = stat_entry(&md, mode);
        match cache.and_then(|c| c.files.get(&p).filter(|was| same(was, &e, c.at))) {
            Some(was) => {
                e.o = was.o.clone();
                m.files.insert(p, e);
            }
            None => {
                todo.push((p, link));
                waiting.push(e);
            }
        }
    }
    let ids = hash_files(store, home, root, &todo, write)?;
    for (((p, _), mut e), id) in todo.into_iter().zip(waiting).zip(ids) {
        e.o = id;
        m.files.insert(p, e);
    }
    Ok(m)
}

/// HEAD's commit in a repository, "" when it has none or this is not one.
fn head_of(store: &Store, home: &Path, root: &Path) -> String {
    match store {
        Store::Git { git, .. } => run_git(git, home, root, &["rev-parse", "-q", "--verify", "HEAD"], &[], None).ok().and_then(|o| git_line(o).ok()).unwrap_or_default(),
        Store::Copy { .. } => String::new(),
    }
}

/// The files that differ between `a` and `b` (content or mode, or there in one only), leaving out what either left
/// out (its content is not known).
fn diff(a: &Manifest, b: &Manifest) -> BTreeSet<String> {
    let mut out = BTreeSet::new();
    for (p, x) in &a.files {
        if b.left.contains(p) {
            continue;
        }
        match b.files.get(p) {
            Some(y) if y.m == x.m && y.o == x.o => {}
            _ => {
                out.insert(p.clone());
            }
        }
    }
    for p in b.files.keys() {
        if !a.files.contains_key(p) && !a.left.contains(p) {
            out.insert(p.clone());
        }
    }
    out
}

// ---------------------------------------------------------------------------------------------
// Putting files back
// ---------------------------------------------------------------------------------------------

enum Act {
    /// a file made since: it goes
    Delete(String),
    /// a file that changed or went: it goes back as the snapshot holds it
    Write(String, Entry),
}

impl Act {
    fn path(&self) -> &str {
        match self {
            Act::Delete(p) | Act::Write(p, _) => p,
        }
    }
}

/// What it takes to make the files `now` holds into the files `target` holds, every file in `keep` left as it is.
/// Deletions come first, so a file can take the place of a folder that went. A file `now` left out (too big to keep)
/// is never overwritten, and a file `target` left out is never deleted: their contents are not known. The second
/// value counts the files left as they are because they are too big now.
fn plan(target: &Manifest, now: &Manifest, keep: &BTreeSet<String>) -> (Vec<Act>, usize) {
    let mut acts = Vec::new();
    for p in now.files.keys() {
        if !target.files.contains_key(p) && !target.left.contains(p) && !keep.contains(p) {
            acts.push(Act::Delete(p.clone()));
        }
    }
    let mut too_big = 0;
    for (p, e) in &target.files {
        if keep.contains(p) {
            continue;
        }
        if now.left.contains(p) {
            too_big += 1;
            continue;
        }
        match now.files.get(p) {
            Some(x) if x.m == e.m && x.o == e.o => {}
            _ => acts.push(Act::Write(p.clone(), e.clone())),
        }
    }
    (acts, too_big)
}

/// Every folder `m` has a file in, so emptying a folder never removes one the snapshot needs.
fn folders_of(m: &Manifest) -> BTreeSet<String> {
    let mut out = BTreeSet::new();
    for p in m.files.keys().chain(m.left.iter()) {
        let mut at = p.as_str();
        while let Some((d, _)) = at.rsplit_once('/') {
            if !out.insert(d.to_string()) {
                break;
            }
            at = d;
        }
    }
    out
}

/// `root/rel`, when no folder on the way from `root` to it is a link: a rewind never writes or deletes through a link,
/// which could lead out of the project.
fn inside(root: &Path, rel: &str) -> Result<PathBuf, String> {
    if !safe_rel(rel) {
        return Err(format!("not a path inside the project: {rel}"));
    }
    let parts: Vec<&str> = rel.split('/').collect();
    let mut at = root.to_path_buf();
    for (k, part) in parts.iter().enumerate() {
        at.push(part);
        if k + 1 < parts.len() && fs::symlink_metadata(&at).map(|md| md.file_type().is_symlink()).unwrap_or(false) {
            return Err(format!("{} is a link, so nothing is written through it", parts[..=k].join("/")));
        }
    }
    Ok(at)
}

fn write_file(dest: &Path, e: &Entry, bytes: &[u8]) -> Result<(), String> {
    let parent = dest.parent().ok_or("no folder")?;
    fs::create_dir_all(parent).map_err(|x| x.to_string())?;
    // written beside it, then moved over it: a reader sees the old file or the new one, never half of one
    let tmp = parent.join(format!(".manut-rewind-{}-{}", std::process::id(), nonce()));
    let made = if e.m == LINK {
        #[cfg(unix)]
        {
            use std::os::unix::ffi::OsStrExt;
            std::os::unix::fs::symlink(OsStr::from_bytes(bytes), &tmp).map_err(|x| x.to_string())
        }
        #[cfg(not(unix))]
        {
            Err("links cannot be made here".to_string())
        }
    } else {
        fs::write(&tmp, bytes).map_err(|x| x.to_string()).and_then(|_| {
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let bits = if e.p != 0 { e.p } else if e.m == 0o100755 { 0o755 } else { 0o644 };
                fs::set_permissions(&tmp, fs::Permissions::from_mode(bits)).map_err(|x| x.to_string())?;
            }
            Ok(())
        })
    };
    if let Err(x) = made.and_then(|_| fs::rename(&tmp, dest).map_err(|x| x.to_string())) {
        let _ = fs::remove_file(&tmp);
        return Err(x);
    }
    Ok(())
}

/// Carry out `acts` in `root`, reading contents from `store`. The folders a deleted file leaves empty go too, unless
/// they are in `keep_dirs`. Stops at the first file that cannot be done.
fn apply(store: &Store, home: &Path, root: &Path, acts: &[Act], keep_dirs: &BTreeSet<String>) -> Result<(), String> {
    let mut reader: Option<Reader> = None;
    for a in acts {
        let rel = a.path();
        let path = inside(root, rel)?;
        match a {
            Act::Delete(_) => {
                match fs::remove_file(&path) {
                    Ok(()) => {}
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                    Err(e) => return Err(format!("{rel}: {e}")),
                }
                let mut dir = rel.rsplit_once('/').map(|(d, _)| d.to_string());
                while let Some(d) = dir {
                    // remove_dir takes only an empty folder
                    if keep_dirs.contains(&d) || fs::remove_dir(root.join(&d)).is_err() {
                        break;
                    }
                    dir = d.rsplit_once('/').map(|(x, _)| x.to_string());
                }
            }
            Act::Write(_, e) => {
                if reader.is_none() {
                    reader = Some(Reader::open(store, home)?);
                }
                let bytes = reader.as_mut().map(|r| r.read(&e.o)).transpose()?.unwrap_or_default();
                write_file(&path, e, &bytes).map_err(|x| format!("{rel}: {x}"))?;
            }
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------------------------
// A session's book of snapshots
// ---------------------------------------------------------------------------------------------

/// The snapshots of every session, under `home`.
pub(crate) struct Book<'a> {
    home: &'a Path,
    limits: Limits,
}

/// A session's store, opened.
struct Open {
    dir: PathBuf,
    meta: Meta,
    store: Store,
}

impl<'a> Book<'a> {
    pub fn new(home: &'a Path) -> Book<'a> {
        Book { home, limits: LIMITS }
    }

    #[cfg(test)]
    fn with_limits(home: &'a Path, limits: Limits) -> Book<'a> {
        Book { home, limits }
    }

    fn session_dir(&self, session: &str) -> Result<PathBuf, String> {
        if !crate::session_files::valid_session(session) {
            return Err("bad session id".into());
        }
        let root = root_dir(self.home);
        for d in [self.home.join(".manut"), root.clone(), root.join(session)] {
            if d.is_symlink() {
                return Err(format!("{} is a link", d.display()));
            }
        }
        Ok(root.join(session))
    }

    /// The session's folder as its real path, when a snapshot of it may be kept: a folder that exists, and not the
    /// disk's root, the home folder itself or the app's own data folder (each far too broad to keep each turn of). A
    /// lane's working folder is in the app's data folder (lane.rs) but is a project's checkout like any other, so its
    /// turns are kept; the folder that holds every lane is not one.
    fn check_root(&self, cwd: &Path) -> Result<PathBuf, String> {
        if !cwd.is_absolute() || !cwd.is_dir() {
            return Err(format!("not a folder: {}", cwd.display()));
        }
        let root = cwd.canonicalize().map_err(|e| e.to_string())?;
        let home = self.home.canonicalize().unwrap_or_else(|_| self.home.to_path_buf());
        if root.parent().is_none() || root == home || (root.starts_with(home.join(".manut")) && !crate::lane::in_a_lane(&home, &root)) {
            return Err("why:too_broad".into());
        }
        Ok(root)
    }

    fn open(&self, session: &str) -> Result<Option<Open>, String> {
        let dir = self.session_dir(session)?;
        let Ok(text) = fs::read_to_string(dir.join("meta.json")) else { return Ok(None) };
        let meta: Meta = serde_json::from_str(&text).map_err(|e| format!("meta.json: {e}"))?;
        let store = match meta.store.as_str() {
            "git" => Store::Git { git: git_program().ok_or("git is not there any more")?, dir: PathBuf::from(&meta.git_dir) },
            _ => Store::Copy { blobs: dir.join("blobs") },
        };
        Ok(Some(Open { dir, meta, store }))
    }

    /// A new store for `root`: git's own objects when `root` is in a repository git can read, else the copy.
    fn new_store(&self, session: &str, root: &Path, root_s: &str) -> Result<Open, String> {
        let dir = self.session_dir(session)?;
        let o = match git_program().and_then(|git| repository_of(&git, self.home, root).map(|d| (git, d))) {
            Some((git, gd)) => Open {
                dir,
                meta: Meta { v: 1, root: root_s.to_string(), store: "git".into(), git_dir: gd.to_string_lossy().into_owned(), next: 1 },
                store: Store::Git { git, dir: gd },
            },
            None => Open {
                store: Store::Copy { blobs: dir.join("blobs") },
                dir,
                meta: Meta { v: 1, root: root_s.to_string(), store: "copy".into(), git_dir: String::new(), next: 1 },
            },
        };
        // refs an earlier run left under this session's name in this repository are not this session's
        self.drop_refs(&o, session);
        // the app's own folder for every session's snapshots, and this session's, for this account only
        private_dir(&root_dir(self.home))?;
        private_dir(&o.dir)?;
        Ok(o)
    }

    fn read_manifest(path: &Path) -> Option<Manifest> {
        fs::read_to_string(path).ok().and_then(|t| serde_json::from_str(&t).ok())
    }

    fn write_json<T: Serialize>(path: &Path, v: &T) -> Result<(), String> {
        let dir = path.parent().ok_or("no folder")?;
        private_dir(dir)?;
        let text = serde_json::to_vec(v).map_err(|e| e.to_string())?;
        write_private(&dir.join(format!(".tmp-{}-{}", std::process::id(), nonce())), path, &text)
    }

    /// The session's turn-start snapshots, oldest first.
    fn starts(o: &Open) -> Vec<Manifest> {
        let mut all: Vec<Manifest> = fs::read_dir(o.dir.join("snaps"))
            .into_iter()
            .flatten()
            .flatten()
            .filter_map(|e| Self::read_manifest(&e.path()))
            .collect();
        all.sort_by_key(|m| m.n);
        all
    }

    /// The newest snapshot this session saved (a turn's start or end): what a new read of the folder trusts for the
    /// files whose stat data did not change.
    fn cache(o: &Open) -> Option<Manifest> {
        let last = Self::starts(o).pop();
        let end = Self::read_manifest(&o.dir.join("end.json"));
        match (last, end) {
            (Some(a), Some(b)) => Some(if b.at >= a.at { b } else { a }),
            (a, b) => a.or(b),
        }
    }

    /// Where snapshot `name` is listed: a turn's start is `snaps/<n>.json`; the end of the last turn (`end`), the files as
    /// they were before a rewind that waits for the agent (`undo`), and the two Bring it back keeps after one (`back`: as
    /// they were just before it, `rest`: as it left them) are files of the session's folder.
    fn snap_file(o: &Open, name: &str) -> PathBuf {
        if matches!(name, "end" | "undo" | "back" | "rest") {
            o.dir.join(format!("{name}.json"))
        } else {
            o.dir.join("snaps").join(format!("{name}.json"))
        }
    }

    /// Save snapshot `m` under `name` (`snaps/<n>`, `end`, `undo`, `back`), and keep its contents alive.
    fn save(&self, o: &Open, session: &str, name: &str, m: &Manifest) -> Result<(), String> {
        if let Store::Git { git, dir } = &o.store {
            // the snapshot's tree, built in an index file of this module's own, under a ref of the app's own
            let index = o.dir.join(format!("index-{}-{}", std::process::id(), nonce()));
            let mut input = Vec::new();
            for (p, e) in &m.files {
                input.extend(format!("{:o} {}\t", e.m, e.o).as_bytes());
                input.extend(p.as_bytes());
                input.push(0);
            }
            private_dir(&o.dir)?;
            let env = [("GIT_DIR", dir.as_os_str()), ("GIT_INDEX_FILE", index.as_os_str())];
            let built = run_git(git, self.home, dir, &["update-index", "-z", "--index-info"], &env, Some(input))
                .and_then(|_| run_git(git, self.home, dir, &["write-tree"], &env, None))
                .and_then(git_line);
            let _ = fs::remove_file(&index);
            // git's lock beside it, when it stopped part way
            let _ = fs::remove_file(PathBuf::from(format!("{}.lock", index.display())));
            let tree = built?;
            run_git(git, self.home, dir, &["update-ref", &ref_name(session, name), &tree], &[("GIT_DIR", dir.as_os_str())], None)?;
        }
        Self::write_json(&Self::snap_file(o, name), m)
    }

    /// Drop the snapshots named `names` (`<n>`, `end`, `undo`, `back`, `rest`), and in the copy the contents nothing holds
    /// any more.
    fn drop_named(&self, o: &Open, session: &str, names: &[String]) {
        for name in names {
            let _ = fs::remove_file(Self::snap_file(o, name));
            if let Store::Git { git, dir } = &o.store {
                let _ = run_git(git, self.home, dir, &["update-ref", "-d", &ref_name(session, name)], &[("GIT_DIR", dir.as_os_str())], None);
            }
        }
        if let Store::Copy { blobs } = &o.store {
            let mut held = BTreeSet::new();
            // `rest.json` holds no copy: Bring it back only compares its content ids with the folder's, and never reads one
            let all = Self::starts(o).into_iter().chain(["end.json", "undo.json", "back.json"].iter().filter_map(|f| Self::read_manifest(&o.dir.join(f))));
            for m in all {
                held.extend(m.files.into_values().map(|e| e.o));
            }
            for e in fs::read_dir(blobs).into_iter().flatten().flatten() {
                let name = e.file_name().to_string_lossy().into_owned();
                if !held.contains(&name) {
                    let _ = fs::remove_file(e.path());
                }
            }
        }
    }

    /// Keep the files of `cwd` as they are now, before turn `turn` (the id of the message that starts it) begins.
    /// Its files that changed since the turn before ended are noted as changed outside a turn.
    pub fn take(&self, session: &str, cwd: &Path, turn: &str) -> Result<Taken, String> {
        if !valid_turn(turn) {
            return Err("bad turn id".into());
        }
        let lock = session_lock(session);
        let _held = lock.lock().unwrap_or_else(|e| e.into_inner());
        let root = self.check_root(cwd)?;
        let root_s = root.to_string_lossy().into_owned();
        let mut o = match self.open(session) {
            Ok(Some(o)) if o.meta.root == root_s => o,
            found => {
                // a first turn, a store this run cannot read, or the session's folder changed: start a new store
                if !matches!(found, Ok(None)) {
                    self.forget_locked(session)?;
                }
                self.new_store(session, &root, &root_s)?
            }
        };
        let cache = Self::cache(&o);
        let mut m = scan(&o.store, self.home, &root, cache.as_ref(), true, &self.limits)?;
        let starts = Self::starts(&o);
        let last = starts.last();
        let end = Self::read_manifest(&o.dir.join("end.json"));
        // what changed outside a turn: since the turn before ended, or when its end was not seen, since it started
        // (then the agent's own changes of that turn count too: it is said rather than missed)
        m.hand = match (last, &end) {
            (_, Some(e)) if e.n == last.map(|l| l.n).unwrap_or(0) => diff(e, &m),
            (Some(l), _) => diff(l, &m),
            (None, _) => BTreeSet::new(),
        };
        m.turn = turn.to_string();
        m.n = o.meta.next;
        o.meta.next += 1;
        // a turn already kept under this id (the page sent it again) gives way to this one
        let mut gone: Vec<String> = starts.iter().filter(|s| s.turn == turn).map(|s| s.n.to_string()).collect();
        self.save(&o, session, &m.n.to_string(), &m)?;
        Self::write_json(&o.dir.join("meta.json"), &o.meta)?;
        let kept: Vec<&Manifest> = starts.iter().filter(|s| s.turn != turn).collect();
        let over = (kept.len() + 1).saturating_sub(self.limits.snapshots);
        gone.extend(kept.iter().take(over).map(|s| s.n.to_string()));
        // a turn starts: the work goes on from the files as they are, so what Bring it back would put back is no longer
        // what the person would be bringing back. Dropped only when there is something (the copy's sweep reads every
        // manifest).
        if Self::snap_file(&o, "back").exists() || Self::snap_file(&o, "rest").exists() {
            gone.extend(["back".to_string(), "rest".to_string()]);
        }
        if !gone.is_empty() {
            self.drop_named(&o, session, &gone);
        }
        Ok(Taken { n: m.n, files: m.files.len(), left: m.left.len() })
    }

    /// The turn that started at the newest snapshot has ended: keep the files as they are now, so what changes
    /// before the next turn starts reads as changed outside a turn.
    pub fn end(&self, session: &str) -> Result<(), String> {
        let lock = session_lock(session);
        let _held = lock.lock().unwrap_or_else(|e| e.into_inner());
        let Some(o) = self.open(session)? else { return Ok(()) };
        let Some(last) = Self::starts(&o).pop() else { return Ok(()) };
        let cache = Self::cache(&o);
        let mut m = scan(&o.store, self.home, Path::new(&o.meta.root), cache.as_ref(), true, &self.limits)?;
        m.n = last.n;
        self.save(&o, session, "end", &m)
    }

    fn start_of(o: &Open, turn: &str) -> Result<Manifest, String> {
        Self::starts(o).into_iter().find(|s| s.turn == turn).ok_or_else(|| "why:no_snapshot".to_string())
    }

    /// The files changed outside the agent's turns since snapshot `n` began, up to `now`.
    fn hand_since(o: &Open, n: u32, now: &Manifest) -> BTreeSet<String> {
        let starts = Self::starts(o);
        let mut out: BTreeSet<String> = starts.iter().filter(|s| s.n > n).flat_map(|s| s.hand.iter().cloned()).collect();
        let last = starts.last();
        match (Self::read_manifest(&o.dir.join("end.json")), last) {
            (Some(e), Some(l)) if e.n == l.n => out.extend(diff(&e, now)),
            (_, Some(l)) => out.extend(diff(l, now)),
            _ => {}
        }
        out
    }

    /// What a rewind to before turn `turn` would put back, and which of those files changed outside the agent's
    /// turns since. Writes nothing.
    pub fn preview(&self, session: &str, turn: &str) -> Result<Preview, String> {
        let lock = session_lock(session);
        let _held = lock.lock().unwrap_or_else(|e| e.into_inner());
        let o = self.open(session)?.ok_or("why:no_snapshot")?;
        let target = Self::start_of(&o, turn)?;
        let cache = Self::cache(&o);
        let now = scan(&o.store, self.home, Path::new(&o.meta.root), cache.as_ref(), false, &self.limits)?;
        let (acts, too_big) = plan(&target, &now, &BTreeSet::new());
        let hand = Self::hand_since(&o, target.n, &now);
        Ok(Self::preview_of(&acts, &now, &hand, too_big, &target))
    }

    /// What putting `target` back over `now` (by `acts`) would do, for the person to read first: each file with what
    /// happens to it, those of them in `hand` (changed outside the agent's turns) apart, and whether the branch moved
    /// since `target` was kept.
    fn preview_of(acts: &[Act], now: &Manifest, hand: &BTreeSet<String>, too_big: usize, target: &Manifest) -> Preview {
        let back: Vec<Change> = acts
            .iter()
            .map(|a| Change {
                path: a.path().to_string(),
                change: match a {
                    Act::Delete(_) => "gone",
                    Act::Write(p, _) if now.files.contains_key(p) => "changed",
                    Act::Write(..) => "back",
                },
            })
            .collect();
        let hand = back.iter().filter(|c| hand.contains(&c.path)).map(|c| c.path.clone()).collect();
        Preview { back, hand, too_big, head_moved: !target.head.is_empty() && !now.head.is_empty() && target.head != now.head }
    }

    /// Rewind the files to before turn `turn`, every file in `keep` left as it is. The files as they were are kept
    /// first (`undo`), so [`Book::settle`] can put them back; a rewind that fails part way puts them back at once.
    pub fn restore(&self, session: &str, turn: &str, keep: &[String]) -> Result<Restored, String> {
        let lock = session_lock(session);
        let _held = lock.lock().unwrap_or_else(|e| e.into_inner());
        let o = self.open(session)?.ok_or("why:no_snapshot")?;
        let target = Self::start_of(&o, turn)?;
        let root = PathBuf::from(&o.meta.root);
        let cache = Self::cache(&o);
        let mut undo = scan(&o.store, self.home, &root, cache.as_ref(), true, &self.limits)?;
        undo.n = target.n;
        undo.turn = turn.to_string();
        self.save(&o, session, "undo", &undo)?;
        let keep: BTreeSet<String> = keep.iter().filter(|p| safe_rel(p)).cloned().collect();
        let (acts, too_big) = plan(&target, &undo, &keep);
        if let Err(e) = apply(&o.store, self.home, &root, &acts, &folders_of(&target)) {
            // put back what was there: the undo snapshot over whatever the failed rewind left
            if let Ok(after) = scan(&o.store, self.home, &root, Some(&undo), false, &self.limits) {
                let (back, _) = plan(&undo, &after, &BTreeSet::new());
                let _ = apply(&o.store, self.home, &root, &back, &folders_of(&undo));
            }
            self.drop_named(&o, session, &["undo".to_string()]);
            return Err(e);
        }
        let kept = keep.iter().filter(|p| target.files.contains_key(*p) || undo.files.contains_key(*p)).count();
        Ok(Restored { changed: acts.len(), kept, too_big })
    }

    /// Keep the files as they were just before a rewind that went through (`undo`) as `back`, and the files as the rewind
    /// left them (`rest`) beside it. `rest` goes first, and both go when either fails, so there is never a `back` whose
    /// changes made by hand since cannot be told.
    fn keep_back(&self, o: &Open, session: &str, undo: &Manifest, rest: &Manifest) -> Result<(), String> {
        let mut rest = rest.clone();
        rest.turn = undo.turn.clone();
        let kept = Self::write_json(&Self::snap_file(o, "rest"), &rest).and_then(|_| self.save(o, session, "back", undo));
        if kept.is_err() {
            self.drop_named(o, session, &["back".to_string(), "rest".to_string()]);
        }
        kept
    }

    /// The agent answered the rewind of turn `turn`. `ok`: the chat went back too, so that turn and every later one are
    /// gone, and the files as they are now are where the next turn starts from; the files as they were just before the
    /// rewind are kept for Bring it back (see [`Settled`]) until the next turn starts. Otherwise the chat stayed, and the
    /// files go back as they were before the rewind.
    pub fn settle(&self, session: &str, turn: &str, ok: bool) -> Result<Settled, String> {
        let lock = session_lock(session);
        let _held = lock.lock().unwrap_or_else(|e| e.into_inner());
        let nothing = Settled { back: false };
        let Some(o) = self.open(session)? else { return Ok(nothing) };
        let Some(undo) = Self::read_manifest(&o.dir.join("undo.json")) else { return Ok(nothing) };
        if undo.turn != turn {
            return Err("that rewind is not the one waiting".into());
        }
        let root = PathBuf::from(&o.meta.root);
        if ok {
            let starts = Self::starts(&o);
            let before = starts.iter().filter(|s| s.n < undo.n).last();
            // saved before anything is dropped: it takes content ids from the undo snapshot, whose copies must still
            // be there when it is saved
            let mut m = scan(&o.store, self.home, &root, Some(&undo), true, &self.limits)?;
            m.n = before.map(|b| b.n).unwrap_or(0);
            self.save(&o, session, "end", &m)?;
            // kept before `undo` goes, for the same reason. A rewind that went through is settled even when these cannot be
            // kept: the person is then only not offered Bring it back
            let kept = self.keep_back(&o, session, &undo, &m).is_ok();
            let mut gone: Vec<String> = starts.iter().filter(|s| s.n >= undo.n).map(|s| s.n.to_string()).collect();
            gone.push("undo".to_string());
            self.drop_named(&o, session, &gone);
            Ok(Settled { back: kept })
        } else {
            let now = scan(&o.store, self.home, &root, Some(&undo), false, &self.limits)?;
            let (back, _) = plan(&undo, &now, &BTreeSet::new());
            let done = apply(&o.store, self.home, &root, &back, &folders_of(&undo));
            if done.is_ok() {
                self.drop_named(&o, session, &["undo".to_string()]);
            }
            done.map(|()| nothing)
        }
    }

    /// The files kept for Bring it back after the rewind to before turn `turn` (as they were just before it), and the
    /// files as that rewind left them. A rewind to another turn, and a turn that has started since, have none.
    fn kept_back(o: &Open, turn: &str) -> Result<(Manifest, Manifest), String> {
        let back = Self::read_manifest(&Self::snap_file(o, "back")).filter(|b| b.turn == turn);
        let rest = Self::read_manifest(&Self::snap_file(o, "rest")).filter(|r| r.turn == turn);
        back.zip(rest).ok_or_else(|| "why:no_snapshot".to_string())
    }

    /// What Bring it back would put back for the rewind to before turn `turn`: the files as they were just before it, and
    /// which of those files changed outside this module since the rewind (by hand: no turn has run). Writes nothing.
    pub fn back_preview(&self, session: &str, turn: &str) -> Result<Preview, String> {
        let lock = session_lock(session);
        let _held = lock.lock().unwrap_or_else(|e| e.into_inner());
        let o = self.open(session)?.ok_or("why:no_snapshot")?;
        let (back, rest) = Self::kept_back(&o, turn)?;
        let cache = Self::cache(&o);
        let now = scan(&o.store, self.home, Path::new(&o.meta.root), cache.as_ref(), false, &self.limits)?;
        let (acts, too_big) = plan(&back, &now, &BTreeSet::new());
        Ok(Self::preview_of(&acts, &now, &diff(&rest, &now), too_big, &back))
    }

    /// Put the files back as they were just before the rewind to before turn `turn`. Every file changed since the rewind
    /// (by hand: no turn has run since) stays as it is, unless it is named in `overwrite`: the files the person saw listed
    /// ([`Book::back_preview`]) and unticked. So a file changed after the list was read, which the person never saw, is not
    /// overwritten. The files as they are now are kept first (`undo`), so a bring-back that fails part way puts them back
    /// at once and can be tried again. When it went through nothing is left to bring back, and the files as they are now
    /// are where the next turn starts from, so what was put back does not read as changed by hand. Writes in the session's
    /// folder only, and never through a link (see [`inside`]); no branch, index, stash or HEAD changes.
    pub fn bring_back(&self, session: &str, turn: &str, overwrite: &[String]) -> Result<Restored, String> {
        let lock = session_lock(session);
        let _held = lock.lock().unwrap_or_else(|e| e.into_inner());
        let o = self.open(session)?.ok_or("why:no_snapshot")?;
        let (back, rest) = Self::kept_back(&o, turn)?;
        let root = PathBuf::from(&o.meta.root);
        let cache = Self::cache(&o);
        let mut now = scan(&o.store, self.home, &root, cache.as_ref(), true, &self.limits)?;
        now.n = back.n;
        now.turn = turn.to_string();
        // no rewind waits while this runs (the page queues a session's calls), so `undo` is free to hold these
        self.save(&o, session, "undo", &now)?;
        let overwrite: BTreeSet<String> = overwrite.iter().filter(|p| safe_rel(p)).cloned().collect();
        let keep: BTreeSet<String> = diff(&rest, &now).difference(&overwrite).cloned().collect();
        let (acts, too_big) = plan(&back, &now, &keep);
        if let Err(e) = apply(&o.store, self.home, &root, &acts, &folders_of(&back)) {
            // put back what was there: the files as they were over whatever the failed bring-back left
            if let Ok(after) = scan(&o.store, self.home, &root, Some(&now), false, &self.limits) {
                let (undone, _) = plan(&now, &after, &BTreeSet::new());
                let _ = apply(&o.store, self.home, &root, &undone, &folders_of(&now));
            }
            self.drop_named(&o, session, &["undo".to_string()]);
            return Err(e);
        }
        // the files left as they are because they were changed by hand, of those that would have been put back
        let (all, _) = plan(&back, &now, &BTreeSet::new());
        let kept = all.iter().filter(|a| keep.contains(a.path())).count();
        // where the next turn starts from, as a rewind leaves it (`settle`); a read that fails only means a later turn
        // lists these files as changed by hand, which keeps them rather than losing them
        let end_n = Self::read_manifest(&Self::snap_file(&o, "end")).map(|e| e.n).or_else(|| Self::starts(&o).last().map(|s| s.n)).unwrap_or(0);
        if let Ok(mut m) = scan(&o.store, self.home, &root, Some(&now), true, &self.limits) {
            m.n = end_n;
            let _ = self.save(&o, session, "end", &m);
        }
        self.drop_named(&o, session, &["undo".to_string(), "back".to_string(), "rest".to_string()]);
        Ok(Restored { changed: acts.len(), kept, too_big })
    }

    fn drop_refs(&self, o: &Open, session: &str) {
        if let Store::Git { git, dir } = &o.store {
            let env = [("GIT_DIR", dir.as_os_str())];
            let prefix = format!("{}/", ref_name(session, "").trim_end_matches('/'));
            let Ok(out) = run_git(git, self.home, dir, &["for-each-ref", "--format=%(refname)", &prefix], &env, None) else { return };
            let refs: String = String::from_utf8_lossy(&out).lines().filter(|r| r.starts_with(&prefix)).map(|r| format!("delete {r}\n")).collect();
            if !refs.is_empty() {
                let _ = run_git(git, self.home, dir, &["update-ref", "--stdin"], &env, Some(refs.into_bytes()));
            }
        }
    }

    fn forget_locked(&self, session: &str) -> Result<(), String> {
        let dir = self.session_dir(session)?;
        if let Ok(Some(o)) = self.open(session) {
            self.drop_refs(&o, session);
        }
        match fs::remove_dir_all(&dir) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e.to_string()),
            _ => Ok(()),
        }
    }

    /// Drop every snapshot of the session: it was removed, or its agent started again.
    pub fn forget(&self, session: &str) -> Result<(), String> {
        let lock = session_lock(session);
        let _held = lock.lock().unwrap_or_else(|e| e.into_inner());
        self.forget_locked(session)
    }

    /// Drop the snapshots of every session not in `keep` (the app started: those sessions are gone).
    pub fn prune(&self, keep: &[String]) -> Result<(), String> {
        let root = root_dir(self.home);
        if root.is_symlink() || !root.is_dir() {
            return Ok(());
        }
        for e in fs::read_dir(&root).map_err(|e| e.to_string())?.flatten() {
            let name = e.file_name().to_string_lossy().into_owned();
            if crate::session_files::valid_session(&name) && !keep.iter().any(|k| k == &name) {
                self.forget(&name)?;
            }
        }
        Ok(())
    }
}

// ---------------------------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------------------------

fn home() -> Result<PathBuf, String> {
    std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" }).filter(|v| !v.is_empty()).map(PathBuf::from).ok_or_else(|| "no home folder".to_string())
}

async fn blocking<T: Send + 'static>(f: impl FnOnce(&Book) -> Result<T, String> + Send + 'static) -> Result<T, String> {
    let home = home()?;
    tauri::async_runtime::spawn_blocking(move || f(&Book::new(&home))).await.map_err(|e| e.to_string())?
}

/// Keep the files of session `session`'s folder `cwd` before turn `turn` (the message's bubble id) starts.
#[tauri::command]
pub async fn turn_files_take(session: String, cwd: String, turn: String) -> Result<Taken, String> {
    blocking(move |b| b.take(&session, Path::new(&cwd), &turn)).await
}

/// Session `session`'s turn ended: keep its files as they are now.
#[tauri::command]
pub async fn turn_files_end(session: String) -> Result<(), String> {
    blocking(move |b| b.end(&session)).await
}

/// What rewinding session `session` to before turn `turn` would put back. Writes nothing.
#[tauri::command]
pub async fn turn_files_preview(session: String, turn: String) -> Result<Preview, String> {
    blocking(move |b| b.preview(&session, &turn)).await
}

/// Rewind session `session`'s files to before turn `turn`, the files in `keep` left as they are.
#[tauri::command]
pub async fn turn_files_restore(session: String, turn: String, keep: Vec<String>) -> Result<Restored, String> {
    blocking(move |b| b.restore(&session, &turn, &keep)).await
}

/// The agent answered the rewind: `ok` = the chat went back too, and the files from before it are kept for Bring it back
/// (the answer says so); otherwise the files go back as they were.
#[tauri::command]
pub async fn turn_files_settle(session: String, turn: String, ok: bool) -> Result<Settled, String> {
    blocking(move |b| b.settle(&session, &turn, ok)).await
}

/// What Bring it back would put back for session `session`'s rewind to before turn `turn`. Writes nothing.
#[tauri::command]
pub async fn turn_files_back_preview(session: String, turn: String) -> Result<Preview, String> {
    blocking(move |b| b.back_preview(&session, &turn)).await
}

/// Put session `session`'s files back as they were just before its rewind to before turn `turn`, the files in `keep` left
/// as they are. The chat is not touched.
#[tauri::command]
pub async fn turn_files_bring_back(session: String, turn: String, keep: Vec<String>) -> Result<Restored, String> {
    blocking(move |b| b.bring_back(&session, &turn, &keep)).await
}

/// Drop every snapshot of session `session`.
#[tauri::command]
pub async fn turn_files_forget(session: String) -> Result<(), String> {
    blocking(move |b| b.forget(&session)).await
}

/// Drop the snapshots of every session not in `keep`.
#[tauri::command]
pub async fn turn_files_prune(keep: Vec<String>) -> Result<(), String> {
    blocking(move |b| b.prune(&keep)).await
}

// ---------------------------------------------------------------------------------------------
// Tests: real folders under the system's temporary folder, with a git repository and without
// ---------------------------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    /// A fresh folder, removed when the test ends.
    struct Temp(PathBuf);

    impl Temp {
        fn new(name: &str) -> Temp {
            let p = std::env::temp_dir().join(format!("manut-turn-files-{name}-{}-{}", std::process::id(), nonce()));
            let _ = fs::remove_dir_all(&p);
            fs::create_dir_all(&p).unwrap();
            Temp(p.canonicalize().unwrap())
        }
    }

    impl Drop for Temp {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    const SMALL: Limits = Limits { snapshots: 20, files: 1000, file: 1024 * 1024, bytes: 8 * 1024 * 1024 };

    fn put(root: &Path, rel: &str, text: &str) {
        let p = root.join(rel);
        fs::create_dir_all(p.parent().unwrap()).unwrap();
        fs::write(p, text).unwrap();
    }

    fn read(root: &Path, rel: &str) -> Option<String> {
        fs::read_to_string(root.join(rel)).ok()
    }

    /// git in `dir` as a developer would run it, with a fixed name, no signing and no hooks, and never writing the
    /// index on its own (`status` would refresh it), so what a test compares is what this module did.
    fn git(dir: &Path, args: &[&str]) -> String {
        let out = Command::new("git")
            .args(["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "-c", "init.defaultBranch=main"])
            .args(args)
            .current_dir(dir)
            .env("GIT_OPTIONAL_LOCKS", "0")
            .output()
            .unwrap();
        assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
        String::from_utf8_lossy(&out.stdout).into_owned()
    }

    fn change(path: &str, change: &'static str) -> Change {
        Change { path: path.into(), change }
    }

    #[test]
    fn a_folder_that_is_not_a_repository_is_copied_into_the_app_data_folder_and_put_back() {
        let (home, proj) = (Temp::new("home"), Temp::new("plain"));
        let r = &proj.0;
        put(r, "a.txt", "one");
        put(r, "src/b.ts", "two");
        put(r, "node_modules/x/index.js", "dep");
        put(r, "dist/app.js", "built");
        put(r, ".DS_Store", "finder");
        let b = Book::with_limits(&home.0, SMALL);
        assert_eq!(b.take("s1", r, "local-s1").unwrap(), Taken { n: 1, files: 2, left: 0 });
        // the agent's turn: a change, a removal, a new file in a new folder, and what the project rebuilds
        put(r, "a.txt", "ONE");
        fs::remove_file(r.join("src/b.ts")).unwrap();
        put(r, "made/new.txt", "new");
        put(r, "node_modules/x/index.js", "dep 2");
        put(r, "dist/app.js", "built 2");
        put(r, ".DS_Store", "finder 2");
        b.end("s1").unwrap();
        let p = b.preview("s1", "local-s1").unwrap();
        assert_eq!(p.back, vec![change("made/new.txt", "gone"), change("a.txt", "changed"), change("src/b.ts", "back")]);
        assert!(p.hand.is_empty(), "every change came in the turn: {:?}", p.hand);
        assert!(!p.head_moved);
        assert_eq!(b.restore("s1", "local-s1", &[]).unwrap(), Restored { changed: 3, kept: 0, too_big: 0 });
        assert_eq!(read(r, "a.txt").as_deref(), Some("one"));
        assert_eq!(read(r, "src/b.ts").as_deref(), Some("two"));
        assert!(!r.join("made").exists(), "the folder the turn made goes with its file");
        assert_eq!(read(r, "node_modules/x/index.js").as_deref(), Some("dep 2"), "a folder the project rebuilds is never touched");
        assert_eq!(read(r, "dist/app.js").as_deref(), Some("built 2"));
        assert_eq!(read(r, ".DS_Store").as_deref(), Some("finder 2"));
        b.settle("s1", "local-s1", true).unwrap();
        // the contents live in the app's data folder, each once; the turn that was rewound is gone
        let blobs = root_dir(&home.0).join("s1").join("blobs");
        assert!(fs::read_dir(&blobs).unwrap().count() >= 2);
        assert_eq!(b.preview("s1", "local-s1").unwrap_err(), "why:no_snapshot");
    }

    #[test]
    fn a_repository_keeps_snapshots_in_git_and_its_branch_index_stash_and_head_never_change() {
        let (home, repo) = (Temp::new("home"), Temp::new("repo"));
        let r = &repo.0;
        git(r, &["init", "-q"]);
        put(r, ".gitignore", "secret.txt\n");
        put(r, ".gitattributes", "* text=auto\n");
        put(r, "a.txt", "one\n");
        fs::write(r.join("crlf.txt"), b"x\r\ny\r\n").unwrap();
        git(r, &["add", "-A"]);
        git(r, &["commit", "-qm", "init"]);
        // the developer's own stash entry, a staged file and an untracked one, which must stay as they are
        put(r, "a.txt", "stashed\n");
        git(r, &["stash", "push", "-q", "-m", "mine"]);
        put(r, "staged.txt", "staged\n");
        git(r, &["add", "staged.txt"]);
        put(r, "untracked.txt", "u\n");
        put(r, "secret.txt", "ignored\n");
        let state = |r: &Path| {
            let index = fs::read(r.join(".git/index")).unwrap();
            (git(r, &["rev-parse", "HEAD"]), git(r, &["symbolic-ref", "HEAD"]), git(r, &["stash", "list"]), index, git(r, &["status", "--porcelain"]), git(r, &["rev-list", "--all", "--count"]))
        };
        let before = state(r);
        let b = Book::with_limits(&home.0, SMALL);
        let t = b.take("s2", r, "local-s1").unwrap();
        // a tree under the app's own ref, never a commit: it stays out of every history view
        assert_eq!(git(r, &["cat-file", "-t", "refs/manut/snapshots/s2/1"]).trim(), "tree");
        let kept = git(r, &["ls-tree", "-r", "--name-only", "refs/manut/snapshots/s2/1"]);
        assert_eq!(kept.lines().collect::<Vec<_>>(), [".gitattributes", ".gitignore", "a.txt", "crlf.txt", "staged.txt", "untracked.txt"], "tracked and untracked, never what git ignores");
        assert_eq!(t.files, 6);
        assert_eq!(state(r), before, "a snapshot changes nothing the developer has");
        // the agent's turn
        put(r, "a.txt", "agent\n");
        fs::remove_file(r.join("untracked.txt")).unwrap();
        put(r, "src/new.ts", "n\n");
        fs::write(r.join("crlf.txt"), b"z\n").unwrap();
        put(r, "secret.txt", "still ignored\n");
        b.end("s2").unwrap();
        b.restore("s2", "local-s1", &[]).unwrap();
        b.settle("s2", "local-s1", true).unwrap();
        assert_eq!(read(r, "a.txt").as_deref(), Some("one\n"));
        assert_eq!(read(r, "untracked.txt").as_deref(), Some("u\n"));
        assert!(!r.join("src").exists());
        assert_eq!(fs::read(r.join("crlf.txt")).unwrap(), b"x\r\ny\r\n", "the bytes as they were, line endings and all");
        assert_eq!(read(r, "secret.txt").as_deref(), Some("still ignored\n"), "what git ignores is never touched");
        assert_eq!(state(r), before, "the rewind changed only the files");
        // the files as they were just before the rewind stay beside the end, for Bring it back, until the next turn starts
        let refs = git(r, &["for-each-ref", "--format=%(refname)", "refs/manut/"]);
        assert_eq!(refs.lines().collect::<Vec<_>>(), ["refs/manut/snapshots/s2/back", "refs/manut/snapshots/s2/end"]);
        b.forget("s2").unwrap();
        assert_eq!(git(r, &["for-each-ref", "refs/manut/"]), "");
        assert!(!root_dir(&home.0).join("s2").exists());
    }

    #[test]
    fn a_commit_since_the_turn_is_said_and_the_branch_stays_where_it_is() {
        let (home, repo) = (Temp::new("home"), Temp::new("repo"));
        let r = &repo.0;
        git(r, &["init", "-q"]);
        put(r, "a.txt", "one\n");
        git(r, &["add", "-A"]);
        git(r, &["commit", "-qm", "init"]);
        let b = Book::with_limits(&home.0, SMALL);
        b.take("s3", r, "local-s1").unwrap();
        put(r, "a.txt", "two\n");
        git(r, &["commit", "-qam", "the agent's commit"]);
        let head = git(r, &["rev-parse", "HEAD"]);
        b.end("s3").unwrap();
        let p = b.preview("s3", "local-s1").unwrap();
        assert!(p.head_moved);
        assert_eq!(p.back, vec![change("a.txt", "changed")]);
        b.restore("s3", "local-s1", &[]).unwrap();
        assert_eq!(read(r, "a.txt").as_deref(), Some("one\n"));
        assert_eq!(git(r, &["rev-parse", "HEAD"]), head, "the commit stays; only the file went back");
    }

    #[test]
    fn a_session_in_a_subfolder_of_a_repository_keeps_and_touches_only_that_folder() {
        let (home, repo) = (Temp::new("home"), Temp::new("repo"));
        let r = &repo.0;
        git(r, &["init", "-q"]);
        put(r, "top.txt", "top\n");
        put(r, "app/a.txt", "a\n");
        git(r, &["add", "-A"]);
        git(r, &["commit", "-qm", "init"]);
        let b = Book::with_limits(&home.0, SMALL);
        b.take("s4", &r.join("app"), "local-s1").unwrap();
        assert_eq!(git(r, &["ls-tree", "-r", "--name-only", "refs/manut/snapshots/s4/1"]).trim(), "a.txt");
        put(r, "app/a.txt", "A\n");
        put(r, "top.txt", "TOP\n");
        b.end("s4").unwrap();
        b.restore("s4", "local-s1", &[]).unwrap();
        assert_eq!(read(r, "app/a.txt").as_deref(), Some("a\n"));
        assert_eq!(read(r, "top.txt").as_deref(), Some("TOP\n"));
    }

    #[test]
    fn a_file_changed_by_hand_since_the_turn_is_listed_and_can_be_kept() {
        let (home, proj) = (Temp::new("home"), Temp::new("plain"));
        let r = &proj.0;
        for f in ["a", "b", "c", "d"] {
            put(r, &format!("{f}.txt"), f);
        }
        let b = Book::with_limits(&home.0, SMALL);
        b.take("s5", r, "local-s1").unwrap();
        put(r, "a.txt", "A"); // the agent, in turn 1
        b.end("s5").unwrap();
        put(r, "b.txt", "B"); // the person, between the turns
        b.take("s5", r, "local-s2").unwrap();
        put(r, "c.txt", "C"); // the agent, in turn 2
        b.end("s5").unwrap();
        put(r, "d.txt", "D"); // the person, after the last turn
        let p = b.preview("s5", "local-s1").unwrap();
        assert_eq!(p.back.iter().map(|c| c.path.as_str()).collect::<Vec<_>>(), ["a.txt", "b.txt", "c.txt", "d.txt"]);
        assert_eq!(p.hand, ["b.txt", "d.txt"]);
        let p2 = b.preview("s5", "local-s2").unwrap();
        assert_eq!(p2.back.iter().map(|c| c.path.as_str()).collect::<Vec<_>>(), ["c.txt", "d.txt"], "turn 2 began after b.txt changed");
        assert_eq!(p2.hand, ["d.txt"]);
        let done = b.restore("s5", "local-s1", &["b.txt".into()]).unwrap();
        assert_eq!((done.changed, done.kept), (3, 1));
        assert_eq!([read(r, "a.txt"), read(r, "b.txt"), read(r, "c.txt"), read(r, "d.txt")].map(|x| x.unwrap()), ["a", "B", "c", "d"]);
        b.settle("s5", "local-s1", true).unwrap();
        // the files the rewind left are where the next turn starts: nothing reads as changed by hand
        b.take("s5", r, "local-s3").unwrap();
        assert!(b.preview("s5", "local-s3").unwrap().back.is_empty());
        // a change after a turn whose end was not seen counts as made outside it: it is said rather than missed
        put(r, "a.txt", "again");
        assert_eq!(b.preview("s5", "local-s3").unwrap().hand, ["a.txt"]);
    }

    #[test]
    fn when_the_chat_does_not_go_back_the_files_go_back_as_they_were() {
        let (home, proj) = (Temp::new("home"), Temp::new("plain"));
        let r = &proj.0;
        put(r, "a.txt", "a");
        let b = Book::with_limits(&home.0, SMALL);
        b.take("s6", r, "local-s1").unwrap();
        put(r, "a.txt", "A");
        put(r, "new.txt", "new");
        b.end("s6").unwrap();
        b.restore("s6", "local-s1", &[]).unwrap();
        assert_eq!(read(r, "a.txt").as_deref(), Some("a"));
        assert!(!r.join("new.txt").exists());
        assert!(b.settle("s6", "local-s2", false).is_err(), "only the rewind that waits is settled");
        b.settle("s6", "local-s1", false).unwrap();
        assert_eq!(read(r, "a.txt").as_deref(), Some("A"));
        assert_eq!(read(r, "new.txt").as_deref(), Some("new"));
        assert_eq!(b.preview("s6", "local-s1").unwrap().back.len(), 2, "the turn can still be rewound");
    }

    #[test]
    fn big_files_and_odd_names_are_left_out_and_never_touched() {
        let (home, proj) = (Temp::new("home"), Temp::new("plain"));
        let r = &proj.0;
        put(r, "small.txt", "x");
        put(r, "big.bin", "0123456789abcdef");
        put(r, "grows.txt", "g");
        if cfg!(unix) {
            put(r, "odd\nname.txt", "odd");
        }
        let b = Book::with_limits(&home.0, Limits { file: 10, ..SMALL });
        let t = b.take("s7", r, "local-s1").unwrap();
        assert_eq!((t.files, t.left), (2, if cfg!(unix) { 2 } else { 1 }));
        put(r, "small.txt", "y");
        put(r, "big.bin", "0123456789abcdef and more");
        put(r, "grows.txt", "now longer than ten bytes");
        b.end("s7").unwrap();
        let p = b.preview("s7", "local-s1").unwrap();
        assert_eq!(p.back, vec![change("small.txt", "changed")]);
        assert_eq!(p.too_big, 1, "grows.txt is too big to keep now, so it stays");
        b.restore("s7", "local-s1", &[]).unwrap();
        assert_eq!(read(r, "small.txt").as_deref(), Some("x"));
        assert_eq!(read(r, "big.bin").as_deref(), Some("0123456789abcdef and more"));
        assert_eq!(read(r, "grows.txt").as_deref(), Some("now longer than ten bytes"));
    }

    #[test]
    fn a_folder_over_the_limits_gets_no_snapshot() {
        let (home, proj) = (Temp::new("home"), Temp::new("plain"));
        let r = &proj.0;
        for i in 0..5 {
            put(r, &format!("f{i}.txt"), "1234");
        }
        assert_eq!(Book::with_limits(&home.0, Limits { files: 3, ..SMALL }).take("s8", r, "local-s1").unwrap_err(), "why:too_many");
        assert_eq!(Book::with_limits(&home.0, Limits { bytes: 10, ..SMALL }).take("s8", r, "local-s1").unwrap_err(), "why:too_big");
    }

    #[test]
    fn the_home_folder_the_disk_root_and_the_app_data_folder_get_no_snapshot() {
        let home = Temp::new("home");
        let b = Book::with_limits(&home.0, SMALL);
        let data = home.0.join(".manut").join("x");
        fs::create_dir_all(&data).unwrap();
        for dir in [home.0.clone(), PathBuf::from("/"), data] {
            assert_eq!(b.take("s9", &dir, "local-s1").unwrap_err(), "why:too_broad", "{}", dir.display());
        }
        assert!(b.take("s9", Path::new("relative"), "local-s1").is_err());
        assert!(b.take("x9", &home.0, "local-s1").is_err(), "a session id is one plain word");
        assert!(b.take("s9", &home.0, "../x").is_err(), "a turn id too");
    }

    #[test]
    fn a_lanes_own_folder_keeps_its_turns_and_the_folders_around_it_get_none() {
        if git_program().is_none() {
            return;
        }
        let home = Temp::new("home");
        let dev = home.0.join("code").join("web-app");
        fs::create_dir_all(&dev).unwrap();
        git(&dev, &["init", "-q"]);
        put(&dev, "a.txt", "one\n");
        git(&dev, &["add", "-A"]);
        git(&dev, &["commit", "-qm", "init"]);
        let lane = crate::lane::make(&home.0, &dev, &["kit/x".to_string()]).unwrap();
        let r = Path::new(&lane.dir);
        let b = Book::with_limits(&home.0, SMALL);
        // the lane's folder is in the app's data folder, and its turns are kept and rewound like any project's
        assert_eq!(b.take("s21", r, "local-s1").unwrap().files, 1);
        put(r, "a.txt", "agent\n");
        b.end("s21").unwrap();
        b.restore("s21", "local-s1", &[]).unwrap();
        b.settle("s21", "local-s1", true).unwrap();
        assert_eq!(read(r, "a.txt").as_deref(), Some("one\n"));
        assert_eq!(git(r, &["cat-file", "-t", "refs/manut/snapshots/s21/back"]).trim(), "tree");
        assert_eq!(git(&dev, &["symbolic-ref", "HEAD"]).trim(), "refs/heads/main");
        // the folder that holds every lane, and one project's lanes, are not a project
        for dir in [crate::lane::lanes_dir(&home.0), crate::lane::lanes_dir(&home.0).join("web-app")] {
            assert_eq!(b.take("s22", &dir, "local-s1").unwrap_err(), "why:too_broad", "{}", dir.display());
        }
        b.forget("s21").unwrap();
    }

    #[test]
    fn a_session_keeps_its_newest_snapshots_and_drops_what_only_older_ones_held() {
        let (home, proj, repo) = (Temp::new("home"), Temp::new("plain"), Temp::new("repo"));
        git(&repo.0, &["init", "-q"]);
        for r in [&proj.0, &repo.0] {
            let b = Book::with_limits(&home.0, Limits { snapshots: 2, ..SMALL });
            let s = if r == &proj.0 { "s10" } else { "s11" };
            for t in 1..=3 {
                put(r, "a.txt", &format!("version {t}"));
                b.take(s, r, &format!("local-s{t}")).unwrap();
            }
            assert_eq!(b.preview(s, "local-s1").unwrap_err(), "why:no_snapshot");
            assert!(b.preview(s, "local-s2").is_ok() && b.preview(s, "local-s3").is_ok());
            // the same turn sent again replaces its snapshot rather than adding one
            b.take(s, r, "local-s3").unwrap();
            assert!(b.preview(s, "local-s2").is_ok());
        }
        assert_eq!(fs::read_dir(root_dir(&home.0).join("s10").join("blobs")).unwrap().count(), 2, "version 1's copy went with its snapshot");
        let refs = git(&repo.0, &["for-each-ref", "--format=%(refname)", "refs/manut/"]);
        assert_eq!(refs.lines().collect::<Vec<_>>(), ["refs/manut/snapshots/s11/2", "refs/manut/snapshots/s11/4"]);
    }

    #[test]
    fn prune_drops_the_sessions_that_are_gone() {
        let (home, repo) = (Temp::new("home"), Temp::new("repo"));
        git(&repo.0, &["init", "-q"]);
        put(&repo.0, "a.txt", "a");
        let b = Book::with_limits(&home.0, SMALL);
        b.take("s12", &repo.0, "local-s1").unwrap();
        b.take("s13", &repo.0, "local-s1").unwrap();
        b.prune(&["s12".into()]).unwrap();
        assert!(root_dir(&home.0).join("s12").exists() && !root_dir(&home.0).join("s13").exists());
        assert_eq!(git(&repo.0, &["for-each-ref", "--format=%(refname)", "refs/manut/"]).trim(), "refs/manut/snapshots/s12/1");
    }

    #[test]
    fn a_store_this_run_cannot_read_starts_again() {
        let (home, proj) = (Temp::new("home"), Temp::new("plain"));
        put(&proj.0, "a.txt", "a");
        let b = Book::with_limits(&home.0, SMALL);
        let dir = root_dir(&home.0).join("s14");
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("meta.json"), "not json").unwrap();
        assert_eq!(b.take("s14", &proj.0, "local-s1").unwrap().n, 1);
    }

    #[cfg(unix)]
    #[test]
    fn links_are_put_back_as_links_and_nothing_is_written_through_one() {
        use std::os::unix::fs::{symlink, PermissionsExt};
        let (home, proj, outside) = (Temp::new("home"), Temp::new("plain"), Temp::new("outside"));
        let r = &proj.0;
        put(r, "sub/x.txt", "x");
        symlink("sub/x.txt", r.join("ln")).unwrap();
        put(r, "run.sh", "echo hi");
        // with a set-user bit, which a rewind never puts back: only the read, write and run bits
        fs::set_permissions(r.join("run.sh"), fs::Permissions::from_mode(0o4755)).unwrap();
        let b = Book::with_limits(&home.0, SMALL);
        b.take("s15", r, "local-s1").unwrap();
        // the turn: the folder becomes a link that leads out, the link points elsewhere, the script loses its bit
        fs::remove_dir_all(r.join("sub")).unwrap();
        symlink(&outside.0, r.join("sub")).unwrap();
        fs::remove_file(r.join("ln")).unwrap();
        symlink("run.sh", r.join("ln")).unwrap();
        put(r, "run.sh", "echo changed");
        fs::set_permissions(r.join("run.sh"), fs::Permissions::from_mode(0o644)).unwrap();
        b.end("s15").unwrap();
        // kept, the link stays where it leads, so x.txt cannot be written: the rewind stops and puts all back
        let err = b.restore("s15", "local-s1", &["sub".into()]).unwrap_err();
        assert!(err.contains("sub is a link"), "{err}");
        assert_eq!(fs::read_dir(&outside.0).unwrap().count(), 0, "nothing was written outside the project");
        assert_eq!(fs::read_link(r.join("ln")).unwrap(), Path::new("run.sh"));
        assert_eq!(read(r, "run.sh").as_deref(), Some("echo changed"));
        // not kept, the link goes and the folder comes back in its place
        b.restore("s15", "local-s1", &[]).unwrap();
        assert!(fs::symlink_metadata(r.join("sub")).unwrap().is_dir());
        assert_eq!(read(r, "sub/x.txt").as_deref(), Some("x"));
        assert_eq!(fs::read_link(r.join("ln")).unwrap(), Path::new("sub/x.txt"));
        assert_eq!(read(r, "run.sh").as_deref(), Some("echo hi"));
        assert_eq!(fs::metadata(r.join("run.sh")).unwrap().permissions().mode() & 0o7777, 0o755);
        assert_eq!(fs::read_dir(&outside.0).unwrap().count(), 0);
    }

    #[cfg(unix)]
    #[test]
    fn the_copy_of_a_project_is_for_this_account_only() {
        use std::os::unix::fs::PermissionsExt;
        let (home, proj) = (Temp::new("home"), Temp::new("plain"));
        put(&proj.0, ".env", "KEY=not-a-real-key");
        // a folder an earlier run made with wider rights is closed too
        let root = root_dir(&home.0);
        fs::create_dir_all(&root).unwrap();
        fs::set_permissions(&root, fs::Permissions::from_mode(0o755)).unwrap();
        Book::with_limits(&home.0, SMALL).take("s17", &proj.0, "local-s1").unwrap();
        let mode = |p: &Path| fs::metadata(p).unwrap().permissions().mode() & 0o777;
        let dir = root.join("s17");
        for d in [&root, &dir, &dir.join("blobs"), &dir.join("snaps")] {
            assert_eq!(mode(d), 0o700, "{}", d.display());
        }
        let blobs: Vec<PathBuf> = fs::read_dir(dir.join("blobs")).unwrap().flatten().map(|e| e.path()).collect();
        assert_eq!(blobs.len(), 1);
        for f in blobs.iter().chain([&dir.join("meta.json"), &dir.join("snaps").join("1.json")]) {
            assert_eq!(mode(f), 0o600, "{}", f.display());
        }
    }

    #[test]
    fn paths_that_leave_the_folder_are_refused() {
        for ok in ["a", "a/b.txt", ".env", "a/.b/c"] {
            assert!(safe_rel(ok), "{ok}");
        }
        for bad in ["", "/a", "a/../b", "./a", "a//b", "a/", "..", "a\nb", "a\0b"] {
            assert!(!safe_rel(bad), "{bad:?}");
        }
        assert!(inside(Path::new("/p"), "../x").is_err());
        assert!(valid_turn("local-s7") && !valid_turn("a/b") && !valid_turn(""));
    }

    #[test]
    fn every_kept_snapshot_still_has_its_copies_when_unchanged_files_are_trusted_by_their_stat_data() {
        let (home, proj) = (Temp::new("home"), Temp::new("plain"));
        let r = &proj.0;
        // an hour old, so a new read trusts their stat data instead of reading them again
        let old = |rel: &str| {
            let f = fs::File::options().write(true).open(r.join(rel)).unwrap();
            f.set_modified(SystemTime::now() - std::time::Duration::from_secs(3600)).unwrap();
        };
        put(r, "a.txt", "a");
        put(r, "b.txt", "b");
        old("a.txt");
        old("b.txt");
        let b = Book::with_limits(&home.0, SMALL);
        b.take("s16", r, "local-s1").unwrap();
        put(r, "c.txt", "c");
        old("c.txt");
        b.end("s16").unwrap();
        b.restore("s16", "local-s1", &[]).unwrap();
        b.settle("s16", "local-s1", true).unwrap();
        b.take("s16", r, "local-s2").unwrap();
        let dir = root_dir(&home.0).join("s16");
        let saved: Vec<Manifest> = fs::read_dir(dir.join("snaps")).unwrap().flatten().map(|e| e.path()).chain([dir.join("end.json")]).map(|p| serde_json::from_str(&fs::read_to_string(p).unwrap()).unwrap()).collect();
        assert_eq!(saved.len(), 2);
        for m in saved {
            for (p, e) in m.files {
                assert!(dir.join("blobs").join(&e.o).is_file(), "{p}'s copy is gone");
            }
        }
    }

    #[test]
    fn a_file_whose_stat_data_did_not_change_keeps_its_content_id() {
        let e = |t: u64| Entry { m: 0o100644, s: 3, t, c: t, i: 7, p: 0o644, o: "a".repeat(40) };
        let read_ms = 10_000;
        assert!(same(&e(1_000_000_000), &e(1_000_000_000), read_ms));
        assert!(!same(&e(9_000_000_000), &e(9_000_000_000), read_ms), "changed just before it was read: read it again");
        assert!(!same(&e(1_000_000_000), &Entry { s: 4, ..e(1_000_000_000) }, read_ms));
        assert!(!same(&Entry { o: String::new(), ..e(1) }, &e(1), read_ms));
    }

    // ---- Bring it back: the files as they were just before a rewind -----------------------------------------------

    #[test]
    fn bring_it_back_puts_the_files_as_they_were_just_before_a_rewind_in_a_folder_that_is_not_a_repository() {
        let (home, proj) = (Temp::new("home"), Temp::new("plain"));
        let r = &proj.0;
        put(r, "a.txt", "one");
        put(r, "src/b.ts", "two");
        let b = Book::with_limits(&home.0, SMALL);
        b.take("s20", r, "local-s1").unwrap();
        // the agent's turn: a change, a removal, a new file in a new folder
        put(r, "a.txt", "ONE");
        fs::remove_file(r.join("src/b.ts")).unwrap();
        put(r, "made/new.txt", "new");
        b.end("s20").unwrap();
        assert_eq!(b.restore("s20", "local-s1", &[]).unwrap(), Restored { changed: 3, kept: 0, too_big: 0 });
        // until the chat went back too the rewind is not settled, and there is nothing to bring back
        assert_eq!(b.back_preview("s20", "local-s1").unwrap_err(), "why:no_snapshot");
        assert_eq!(b.settle("s20", "local-s1", true).unwrap(), Settled { back: true });
        assert_eq!(read(r, "a.txt").as_deref(), Some("one"));
        assert_eq!(read(r, "src/b.ts").as_deref(), Some("two"));
        // the copy holds what the rewind put back over: each content once, in the app's data folder
        let dir = root_dir(&home.0).join("s20");
        let kept = Book::read_manifest(&dir.join("back.json")).unwrap();
        assert_eq!(kept.files.keys().collect::<Vec<_>>(), ["a.txt", "made/new.txt"]);
        for (p, e) in &kept.files {
            assert!(dir.join("blobs").join(&e.o).is_file(), "{p}'s copy is gone");
        }

        let p = b.back_preview("s20", "local-s1").unwrap();
        assert_eq!(p.back, vec![change("src/b.ts", "gone"), change("a.txt", "changed"), change("made/new.txt", "back")]);
        assert!(p.hand.is_empty() && !p.head_moved && p.too_big == 0, "{p:?}");
        assert_eq!(read(r, "a.txt").as_deref(), Some("one"), "looking at it changes nothing");

        assert_eq!(b.bring_back("s20", "local-s1", &[]).unwrap(), Restored { changed: 3, kept: 0, too_big: 0 });
        assert_eq!(read(r, "a.txt").as_deref(), Some("ONE"));
        assert!(!r.join("src").exists(), "the folder the rewind made goes with its file");
        assert_eq!(read(r, "made/new.txt").as_deref(), Some("new"));
        // once is all: nothing is left to bring back
        assert_eq!(b.back_preview("s20", "local-s1").unwrap_err(), "why:no_snapshot");
        assert_eq!(b.bring_back("s20", "local-s1", &[]).unwrap_err(), "why:no_snapshot");
        // the next turn starts from the files as they are now: what was put back is not read as changed by hand
        b.take("s20", r, "local-s2").unwrap();
        assert!(Book::read_manifest(&dir.join("snaps").join("2.json")).unwrap().hand.is_empty());
        for f in ["undo.json", "back.json", "rest.json"] {
            assert!(!dir.join(f).exists(), "{f}");
        }
    }

    #[test]
    fn bringing_it_back_in_a_repository_keeps_the_files_in_git_and_its_branch_index_stash_and_head_never_change() {
        let (home, repo) = (Temp::new("home"), Temp::new("repo"));
        let r = &repo.0;
        git(r, &["init", "-q"]);
        put(r, ".gitignore", "secret.txt\n");
        put(r, ".gitattributes", "* text=auto\n");
        put(r, "a.txt", "one\n");
        fs::write(r.join("crlf.txt"), b"x\r\ny\r\n").unwrap();
        git(r, &["add", "-A"]);
        git(r, &["commit", "-qm", "init"]);
        // the developer's own stash entry, a staged file, an untracked one and an ignored one
        put(r, "a.txt", "stashed\n");
        git(r, &["stash", "push", "-q", "-m", "mine"]);
        put(r, "staged.txt", "staged\n");
        git(r, &["add", "staged.txt"]);
        put(r, "untracked.txt", "u\n");
        put(r, "secret.txt", "ignored\n");
        // what only git's own bookkeeping holds: none of it may change, whatever happens to the files
        let kept_state = |r: &Path| {
            (
                git(r, &["rev-parse", "HEAD"]),
                git(r, &["symbolic-ref", "HEAD"]),
                git(r, &["stash", "list"]),
                fs::read(r.join(".git/index")).unwrap(),
                git(r, &["rev-list", "--all", "--count"]),
                git(r, &["for-each-ref", "--format=%(refname)", "refs/heads/", "refs/tags/", "refs/stash"]),
            )
        };
        let before = kept_state(r);
        let b = Book::with_limits(&home.0, SMALL);
        b.take("s21", r, "local-s1").unwrap();
        // the agent's turn
        put(r, "a.txt", "agent\n");
        fs::remove_file(r.join("untracked.txt")).unwrap();
        put(r, "src/new.ts", "n\n");
        fs::write(r.join("crlf.txt"), b"z\n").unwrap();
        put(r, "secret.txt", "still ignored\n");
        b.end("s21").unwrap();
        b.restore("s21", "local-s1", &[]).unwrap();
        assert_eq!(b.settle("s21", "local-s1", true).unwrap(), Settled { back: true });
        assert_eq!(read(r, "a.txt").as_deref(), Some("one\n"));
        // the files as they were just before the rewind are a tree under a ref of the app's own, never a commit
        assert_eq!(git(r, &["cat-file", "-t", "refs/manut/snapshots/s21/back"]).trim(), "tree");
        let kept = git(r, &["ls-tree", "-r", "--name-only", "refs/manut/snapshots/s21/back"]);
        assert_eq!(kept.lines().collect::<Vec<_>>(), [".gitattributes", ".gitignore", "a.txt", "crlf.txt", "src/new.ts", "staged.txt"]);
        let refs = git(r, &["for-each-ref", "--format=%(refname)", "refs/manut/"]);
        assert_eq!(refs.lines().collect::<Vec<_>>(), ["refs/manut/snapshots/s21/back", "refs/manut/snapshots/s21/end"]);
        assert_eq!(kept_state(r), before, "keeping them changes nothing the developer has");

        let p = b.back_preview("s21", "local-s1").unwrap();
        assert_eq!(p.back, vec![change("untracked.txt", "gone"), change("a.txt", "changed"), change("crlf.txt", "changed"), change("src/new.ts", "back")]);
        assert!(p.hand.is_empty() && !p.head_moved, "{p:?}");
        assert_eq!(b.bring_back("s21", "local-s1", &[]).unwrap(), Restored { changed: 4, kept: 0, too_big: 0 });
        assert_eq!(read(r, "a.txt").as_deref(), Some("agent\n"));
        assert!(!r.join("untracked.txt").exists());
        assert_eq!(read(r, "src/new.ts").as_deref(), Some("n\n"));
        assert_eq!(fs::read(r.join("crlf.txt")).unwrap(), b"z\n", "the bytes as they were, line endings and all");
        assert_eq!(read(r, "secret.txt").as_deref(), Some("still ignored\n"), "what git ignores is never touched");
        assert_eq!(kept_state(r), before, "putting the files back changed only the files");
        let refs = git(r, &["for-each-ref", "--format=%(refname)", "refs/manut/"]);
        assert_eq!(refs.trim(), "refs/manut/snapshots/s21/end", "nothing is left to bring back");
        b.forget("s21").unwrap();
        assert_eq!(git(r, &["for-each-ref", "refs/manut/"]), "");
        assert_eq!(kept_state(r), before);
    }

    #[test]
    fn a_commit_since_the_rewind_is_said_and_the_branch_stays_where_it_is() {
        let (home, repo) = (Temp::new("home"), Temp::new("repo"));
        let r = &repo.0;
        git(r, &["init", "-q"]);
        put(r, "a.txt", "one\n");
        git(r, &["add", "-A"]);
        git(r, &["commit", "-qm", "init"]);
        let b = Book::with_limits(&home.0, SMALL);
        b.take("s22", r, "local-s1").unwrap();
        put(r, "a.txt", "two\n");
        b.end("s22").unwrap();
        b.restore("s22", "local-s1", &[]).unwrap();
        b.settle("s22", "local-s1", true).unwrap();
        // the person commits after the rewind
        put(r, "b.txt", "b\n");
        git(r, &["add", "-A"]);
        git(r, &["commit", "-qm", "after the rewind"]);
        let head = git(r, &["rev-parse", "HEAD"]);
        let p = b.back_preview("s22", "local-s1").unwrap();
        assert!(p.head_moved);
        assert_eq!(p.back, vec![change("b.txt", "gone"), change("a.txt", "changed")]);
        assert_eq!(p.hand, ["b.txt"]);
        // the person unticked it: it is put back over too, so the file the commit added leaves the work tree
        b.bring_back("s22", "local-s1", &p.hand).unwrap();
        assert_eq!(read(r, "a.txt").as_deref(), Some("two\n"));
        assert!(!r.join("b.txt").exists());
        assert_eq!(git(r, &["rev-parse", "HEAD"]), head, "the commit stays; only the files went back");
        assert!(git(r, &["log", "--format=%s"]).contains("after the rewind"));
    }

    #[test]
    fn a_file_changed_by_hand_after_the_rewind_is_listed_and_kept_unless_the_person_unticks_it() {
        for (keep_theirs, session) in [(true, "s23"), (false, "s24")] {
            let (home, proj) = (Temp::new("home"), Temp::new("plain"));
            let r = &proj.0;
            for f in ["a", "b", "c"] {
                put(r, &format!("{f}.txt"), f);
            }
            let b = Book::with_limits(&home.0, SMALL);
            b.take(session, r, "local-s1").unwrap();
            put(r, "a.txt", "A"); // the agent
            put(r, "b.txt", "B");
            b.end(session).unwrap();
            b.restore(session, "local-s1", &[]).unwrap();
            b.settle(session, "local-s1", true).unwrap();
            // the person, after the rewind: edits a file the agent had changed, and makes a new one
            put(r, "b.txt", "mine");
            put(r, "new.txt", "new");
            let p = b.back_preview(session, "local-s1").unwrap();
            assert_eq!(p.back, vec![change("new.txt", "gone"), change("a.txt", "changed"), change("b.txt", "changed")]);
            assert_eq!(p.hand, ["new.txt", "b.txt"], "listed, so the person can keep or untick them");
            // ticked (kept) is the default: only the files the person unticked are named to be put back over
            let overwrite: Vec<String> = if keep_theirs { vec![] } else { p.hand.clone() };
            let done = b.bring_back(session, "local-s1", &overwrite).unwrap();
            let files = ["a.txt", "b.txt", "c.txt", "new.txt"].map(|f| read(r, f));
            let some = |x: &str| Some(x.to_string());
            if keep_theirs {
                assert_eq!((done.changed, done.kept), (1, 2));
                assert_eq!(files, [some("A"), some("mine"), some("c"), some("new")], "only the file the person did not touch went back");
            } else {
                assert_eq!((done.changed, done.kept), (3, 0));
                assert_eq!(files, [some("A"), some("B"), some("c"), None]);
            }
        }
    }

    #[test]
    fn a_file_changed_after_the_files_were_read_is_never_overwritten_unless_it_is_named() {
        for (named, session, expect) in [(false, "s29", "typed after looking"), (true, "s30", "A")] {
            let (home, proj) = (Temp::new("home"), Temp::new("plain"));
            let r = &proj.0;
            put(r, "a.txt", "a");
            put(r, "b.txt", "b");
            let b = Book::with_limits(&home.0, SMALL);
            b.take(session, r, "local-s1").unwrap();
            put(r, "a.txt", "A"); // the agent
            put(r, "b.txt", "B");
            b.end(session).unwrap();
            b.restore(session, "local-s1", &[]).unwrap();
            b.settle(session, "local-s1", true).unwrap();
            // the files are read: nothing was changed by hand yet, so nothing is listed
            let p = b.back_preview(session, "local-s1").unwrap();
            assert_eq!(p.back, vec![change("a.txt", "changed"), change("b.txt", "changed")]);
            assert!(p.hand.is_empty());
            // then the person edits a file the rewind put back: it was never in the list
            put(r, "a.txt", "typed after looking");
            let overwrite: Vec<String> = if named { vec!["a.txt".into()] } else { p.hand.clone() };
            let done = b.bring_back(session, "local-s1", &overwrite).unwrap();
            assert_eq!(read(r, "a.txt").as_deref(), Some(expect), "named: {named}");
            assert_eq!(read(r, "b.txt").as_deref(), Some("B"), "the file nobody touched goes back");
            assert_eq!((done.changed, done.kept), if named { (2, 0) } else { (1, 1) });
        }
    }

    #[test]
    fn the_files_from_before_a_rewind_are_kept_only_until_the_next_turn_starts() {
        let (home, repo) = (Temp::new("home"), Temp::new("repo"));
        let r = &repo.0;
        git(r, &["init", "-q"]);
        put(r, "a.txt", "a");
        let b = Book::with_limits(&home.0, SMALL);
        b.take("s25", r, "local-s1").unwrap();
        put(r, "a.txt", "A");
        b.end("s25").unwrap();
        b.restore("s25", "local-s1", &[]).unwrap();
        b.settle("s25", "local-s1", true).unwrap();
        assert!(b.back_preview("s25", "local-s1").is_ok());
        let dir = root_dir(&home.0).join("s25");
        assert!(dir.join("back.json").is_file() && dir.join("rest.json").is_file());
        // a message that starts a turn: the work goes on from the files as they are
        b.take("s25", r, "local-s2").unwrap();
        assert_eq!(b.back_preview("s25", "local-s1").unwrap_err(), "why:no_snapshot");
        assert_eq!(b.bring_back("s25", "local-s1", &[]).unwrap_err(), "why:no_snapshot");
        assert!(!dir.join("back.json").exists() && !dir.join("rest.json").exists());
        let refs = git(r, &["for-each-ref", "--format=%(refname)", "refs/manut/"]);
        assert_eq!(refs.lines().collect::<Vec<_>>(), ["refs/manut/snapshots/s25/2", "refs/manut/snapshots/s25/end"], "the ref of what was kept went with it");
        assert_eq!(read(r, "a.txt").as_deref(), Some("a"), "looking for them never touched a file");
    }

    #[test]
    fn a_second_rewind_replaces_what_the_first_kept_and_a_refused_one_leaves_it_alone() {
        let (home, proj) = (Temp::new("home"), Temp::new("plain"));
        let r = &proj.0;
        put(r, "a.txt", "0");
        let b = Book::with_limits(&home.0, SMALL);
        b.take("s26", r, "local-s1").unwrap();
        put(r, "a.txt", "1");
        b.end("s26").unwrap();
        b.take("s26", r, "local-s2").unwrap();
        put(r, "a.txt", "2");
        b.end("s26").unwrap();
        // the first rewind, to before turn 2, goes through: a.txt as turn 2 left it is kept
        b.restore("s26", "local-s2", &[]).unwrap();
        assert_eq!(b.settle("s26", "local-s2", true).unwrap(), Settled { back: true });
        assert_eq!(read(r, "a.txt").as_deref(), Some("1"));
        // a rewind to before turn 1 that the agent refuses puts the files back as they were, and keeps nothing of its own
        b.restore("s26", "local-s1", &[]).unwrap();
        assert_eq!(read(r, "a.txt").as_deref(), Some("0"));
        assert_eq!(b.settle("s26", "local-s1", false).unwrap(), Settled { back: false });
        assert_eq!(read(r, "a.txt").as_deref(), Some("1"));
        assert_eq!(b.back_preview("s26", "local-s2").unwrap().back, vec![change("a.txt", "changed")], "the first rewind can still be taken back");
        // the same rewind, answered this time: what it kept replaces the first's, which was of another rewind
        b.restore("s26", "local-s1", &[]).unwrap();
        assert_eq!(b.settle("s26", "local-s1", true).unwrap(), Settled { back: true });
        assert_eq!(b.back_preview("s26", "local-s2").unwrap_err(), "why:no_snapshot");
        assert_eq!(b.back_preview("s26", "local-s1").unwrap().back, vec![change("a.txt", "changed")]);
        b.bring_back("s26", "local-s1", &[]).unwrap();
        assert_eq!(read(r, "a.txt").as_deref(), Some("1"), "the files as they were just before the second rewind");
    }

    #[cfg(unix)]
    #[test]
    fn bringing_it_back_never_writes_through_a_link_or_outside_the_folder() {
        use std::os::unix::fs::symlink;
        /// A rewind that went through, and then the person turning the folder into a link that leads out of the project.
        fn after_rewind<'a>(home: &'a Path, r: &Path, outside: &Path, session: &str) -> Book<'a> {
            put(r, "sub/x.txt", "x");
            put(r, "keep.txt", "k");
            let b = Book::with_limits(home, SMALL);
            b.take(session, r, "local-s1").unwrap();
            put(r, "sub/x.txt", "x as the turn left it");
            b.end(session).unwrap();
            b.restore(session, "local-s1", &[]).unwrap();
            b.settle(session, "local-s1", true).unwrap();
            assert_eq!(read(r, "sub/x.txt").as_deref(), Some("x"));
            fs::remove_dir_all(r.join("sub")).unwrap();
            symlink(outside, r.join("sub")).unwrap();
            b
        }

        // nothing named to put back over: the link is the person's change, so it stays, and so does the file that is not in
        // the folder any more; nothing is written through the link
        let (home, proj, outside) = (Temp::new("home"), Temp::new("plain"), Temp::new("outside"));
        let (r, out) = (&proj.0, &outside.0);
        let b = after_rewind(&home.0, r, out, "s27");
        assert_eq!(b.bring_back("s27", "local-s1", &[]).unwrap(), Restored { changed: 0, kept: 2, too_big: 0 });
        assert_eq!(fs::read_link(r.join("sub")).unwrap(), *out);
        assert_eq!(fs::read_dir(out).unwrap().count(), 0, "nothing was written outside the project");
        assert_eq!(read(r, "keep.txt").as_deref(), Some("k"));

        // only the file named, with the link left in place: it would be written through the link, which is refused, and every
        // file is as it was
        let (home, proj, outside) = (Temp::new("home"), Temp::new("plain"), Temp::new("outside"));
        let (r, out) = (&proj.0, &outside.0);
        let b = after_rewind(&home.0, r, out, "s31");
        let err = b.bring_back("s31", "local-s1", &["sub/x.txt".into()]).unwrap_err();
        assert!(err.contains("sub is a link"), "{err}");
        assert_eq!(fs::read_dir(out).unwrap().count(), 0, "nothing was written outside the project");
        assert_eq!(fs::read_link(r.join("sub")).unwrap(), *out);
        assert_eq!(read(r, "keep.txt").as_deref(), Some("k"));
        // what was kept stays, so it can be tried again: with the link named too, it goes and the folder comes back in its place
        assert!(b.back_preview("s31", "local-s1").is_ok());
        b.bring_back("s31", "local-s1", &["sub".into(), "sub/x.txt".into()]).unwrap();
        assert!(fs::symlink_metadata(r.join("sub")).unwrap().is_dir());
        assert_eq!(read(r, "sub/x.txt").as_deref(), Some("x as the turn left it"));
        assert_eq!(fs::read_dir(out).unwrap().count(), 0);
    }

    #[test]
    fn nothing_is_brought_back_for_a_turn_that_was_not_rewound_or_a_rewind_the_agent_refused() {
        let (home, proj) = (Temp::new("home"), Temp::new("plain"));
        let r = &proj.0;
        put(r, "a.txt", "a");
        let b = Book::with_limits(&home.0, SMALL);
        // no store at all, then a store with a turn that was never rewound
        assert_eq!(b.back_preview("s28", "local-s1").unwrap_err(), "why:no_snapshot");
        b.take("s28", r, "local-s1").unwrap();
        put(r, "a.txt", "A");
        b.end("s28").unwrap();
        assert_eq!(b.back_preview("s28", "local-s1").unwrap_err(), "why:no_snapshot");
        assert_eq!(b.bring_back("s28", "local-s1", &[]).unwrap_err(), "why:no_snapshot");
        // a rewind the agent refused put the files back as they were: there is nothing to bring back
        b.restore("s28", "local-s1", &[]).unwrap();
        assert_eq!(b.settle("s28", "local-s1", false).unwrap(), Settled { back: false });
        assert_eq!(b.back_preview("s28", "local-s1").unwrap_err(), "why:no_snapshot");
        assert_eq!(read(r, "a.txt").as_deref(), Some("A"));
        // a rewind that went through is brought back by its own turn only
        b.restore("s28", "local-s1", &[]).unwrap();
        b.settle("s28", "local-s1", true).unwrap();
        assert_eq!(b.back_preview("s28", "local-s2").unwrap_err(), "why:no_snapshot");
        assert_eq!(b.bring_back("s28", "local-s2", &["a.txt".into()]).unwrap_err(), "why:no_snapshot");
        assert_eq!(read(r, "a.txt").as_deref(), Some("a"), "a refusal changes no file");
        assert!(b.bring_back("x28", "local-s1", &[]).is_err(), "a session id is one plain word");
    }

    #[test]
    fn what_the_page_is_told_when_a_rewind_is_settled() {
        assert_eq!(serde_json::to_value(Settled { back: true }).unwrap(), serde_json::json!({ "back": true }));
    }
}
