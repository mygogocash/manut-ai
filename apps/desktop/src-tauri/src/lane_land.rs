//! Landing a helper lane's work in its lead lane's folder, and taking a landing back (item 102g; docs/several-agents.md, R8).
//! A helper lane (item 102f, `lane_helper.rs`) starts from a snapshot of its lead's folder and works in its own. When it has
//! reported, its work is carried into the lead's folder: one landing at a time per lead folder, into the lead's working tree
//! only (never a branch, a commit or a push, and never the developer's own folder), with what was there kept first so the
//! person can take the landing back.
//!
//! Lifted from GoSpark's `BuddyLand.applyHeadWork`, `foreignTarget`, `pathsOutside` and `excludingBuildOutput`
//! (`GoGoCode/Models/BuddyLandingApply.swift`), `Git.apply` and `captureTree` (`GoGoCode/Git/Git.swift`), its
//! `BuddyCheckoutGate` and `CheckoutCoordinator` (one writer per checkout, a copy never taken mid-patch) and
//! `AppModel.landBuddyHead` (`GoGoCode/App/AppModel+Buddy.swift`), with their tests (`BuddyLandingTests`,
//! `BuddyForeignPatchTests`), `mygogocash/gospark` at `a7537c80`. What a landing does, in order:
//!
//! 1. **The lock.** One landing at a time per lead folder ([`lead_lock`]); a second waits its turn. A helper lane's snapshot of
//!    the lead (`lane_helper::make`) and a lane's removal (`lane::remove`) take the same lock, so a helper lane never starts from
//!    a folder half way through a patch and a folder never goes while a patch is written into it.
//! 2. **The helper lane's work.** Its folder as git would write it (`lane_helper::capture`: a copy of its index, `git add -A`,
//!    committed or not, nothing git ignores), measured from the snapshot it started from (`refs/manut/helpers/<job>/<folder>`).
//! 3. **Build output cut.** A file in a folder a project's build or its tools write (`turn_files::REBUILT` and GoSpark's caches,
//!    [`output_folder`]) where the snapshot holds nothing in that folder, and a file the system writes (`.DS_Store`), is put
//!    back to the snapshot's own in the copy of the index before the patch is made: what git's ignore rules missed never lands.
//!    A folder of that name the project keeps in git (a tracked `build/`) is the project's own and lands.
//! 4. **The patch.** `git diff-tree -p --binary --full-index --no-renames` between the snapshot and that tree, written by git
//!    straight to a file of the app's own (mode 0600), so every byte is the helper's, binary files included.
//! 5. **The masker's read.** Every added line passes the app's one masker (`tasks::mask_secrets`); a file one holds a key in is
//!    named in the answer ([`Landed::keys`]). The landing still goes: the key is then in the lead's folder, where the lead's next
//!    commit or push reads it from the lane's diff and asks first (item 117, `src/code/secrets.ts`).
//! 6. **Where it may go.** A patch from a copy of another repository, one naming a file outside the lead's project (outside its
//!    folder inside the repository, [`outside`]), or a name the app cannot hold is kept without being tried.
//! 7. **The snapshot before writing.** Each file the patch names, as it is on disk in the lead's folder, byte for byte with its
//!    bits (`turn_files::read_files`), and the folders it would make.
//! 8. **`git apply --3way`** in the lead's folder, against a throwaway copy of the lead's index (GoSpark's `Git.apply`), so the
//!    lead's own index never changes. Conflicts left as markers count as landed and are named. A patch that will not apply is
//!    applied not at all (git applies a patch whole or not, `git help apply`), and should anything differ all the same it is
//!    put back from step 7; the patch is kept owner-read-only (0600) at `~/.manut/patches/<job>/<folder>.patch`.
//! 9. **The keep.** Step 7's bytes and the landed bytes, kept by `refs/manut/landings/<job>/<folder>` (a tree of them: `b/` as
//!    they were, `a/` as landed), and a record of the landing in `~/.manut/landings/<job>/<folder>.json` with the tree of the
//!    lead's whole folder just after it. A landing that cannot be kept is taken back at once: nothing is half landed.
//!
//! **Take back** ([`take_back`]) puts every file the landing wrote back as it was, byte for byte, and takes away the folders it
//! made, only while nothing in the lead's folder changed since (the landed files byte for byte, and the whole folder's tree).
//!
//! One landing per helper lane until it is taken back (`landed`); the page names only a helper lane the app made, and the shell
//! finds its lead, its job and its snapshot from its record. Whether the lead's turn is running or one of its asks waits is the
//! page's to know (item 102i): this module only keeps one landing at a time and the lead's folder whole.
//!
//! git runs as for a lane the person starts (`lane::Git::new`: the person's Start helpers press said the work would land),
//! hooks and the file monitor aside, so git-lfs and line-ending settings carry a file into the lead as git would. A landing
//! starts without a press of its own (when a helper lane reports), so it does nothing in a repository whose own config names a
//! program git would run there (`lane::Git::landing_config_risk`: a clean filter, and a merge driver, which a three-way apply
//! runs), as the app's other work that starts by itself does.

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};

use serde::{Deserialize, Serialize};

use crate::lane::{self, real, Git, Record};
use crate::lane_helper;
use crate::tasks;
use crate::turn_files::{self, OnDisk};

/// Where every landing's keep lives: under the app's own refs, beside the helper lanes' snapshots and Rewind's.
pub(crate) const REFS: &str = "refs/manut/landings/";
/// The most paths each list of an answer names; the totals count the rest.
const NAMED: usize = 500;
/// The most paths named as outside the project.
const OUTSIDE_SHOWN: usize = 20;
/// The largest landing record read: one names each landed file twice.
const RECORD_BYTES: u64 = 16 << 20;
/// The caches GoSpark's `TouchedPaths.isBuildOutput` names that Rewind's list (`turn_files::REBUILT`) lacks. A folder whose
/// name ends in `.noindex` is one too.
const CACHES: &[&str] = &[".build", ".ruff_cache", "xcuserdata", ".swiftpm", "ModuleCache", "-Xcc"];

/// What a landing did. `outcome`: `landed` (conflicts included), `nothing` (the helper lane changed nothing once build output
/// was cut) or `kept` (the patch was not applied: `why` says why, `patch` where it is). `files`: the files the patch holds, at
/// most [`NAMED`] (`files_total` counts them all), paths from the top of the repository as git writes them. `conflicts`: the
/// files left with conflict markers. `cut`: build output left out ([`output_folder`]). `keys`: the files an added line of
/// which holds a key the masker hides, nothing of the key itself (`?` when a line could not be put to a file). `why`, for
/// `kept`: `outside` (it names files outside the lead's project, the first of them in `outside`), `bad_path` (a name the app
/// cannot hold, in `outside` too), `other_repo` (the helper lane is a copy of another repository than its lead's), or
/// `would_not_apply` (`error` is git's own line, or what could not be read in the lead's folder).
#[derive(Debug, Serialize, PartialEq, Default)]
pub struct Landed {
    pub outcome: String,
    pub files: Vec<String>,
    pub files_total: u32,
    pub conflicts: Vec<String>,
    pub cut: Vec<String>,
    pub cut_total: u32,
    pub keys: Vec<String>,
    pub patch: String,
    pub why: String,
    pub outside: Vec<String>,
    pub error: String,
}

/// What Take back put back: the files the landing had written, at most [`NAMED`] (`files_total` counts them all).
#[derive(Debug, Serialize, PartialEq)]
pub struct TakenBack {
    pub files: Vec<String>,
    pub files_total: u32,
}

/// A landing's record, `~/.manut/landings/<job>/<folder>.json`: the helper lane and the lead it landed in (as their records
/// name them), the ref that keeps its bytes and the tree it names, each file it wrote as it was (`before`) and as it landed
/// (`after`, None where nothing is), the folders it made, the tree of the lead's whole folder just after it, and when.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
struct Landing {
    v: u32,
    helper: String,
    lead: String,
    keep: String,
    tree: String,
    before: BTreeMap<String, Option<OnDisk>>,
    after: BTreeMap<String, Option<OnDisk>>,
    made: Vec<String>,
    folder: String,
    at: u64,
}

/// The lock of the lead lane whose record names its folder `lead`: a landing in it, a take back, a helper lane's snapshot of it
/// and its removal each hold it while they read or write the folder, so two never overlap (GoSpark's `BuddyCheckoutGate`).
/// Nothing waits for another lock while it holds this one, except `lane::remove`, which takes it after `lane::WRITING`; nothing
/// that holds it takes `WRITING`.
pub(crate) fn lead_lock(lead: &str) -> Arc<Mutex<()>> {
    static LOCKS: OnceLock<Mutex<HashMap<String, Arc<Mutex<()>>>>> = OnceLock::new();
    LOCKS.get_or_init(Default::default).lock().unwrap_or_else(|e| e.into_inner()).entry(lead.to_string()).or_default().clone()
}

fn record_path(home: &Path, job: &str, folder: &str) -> PathBuf {
    home.join(".manut").join("landings").join(job).join(format!("{folder}.json"))
}

fn patch_path(home: &Path, job: &str, folder: &str) -> PathBuf {
    home.join(".manut").join("patches").join(job).join(format!("{folder}.patch"))
}

fn keep_ref(job: &str, folder: &str) -> String {
    format!("{REFS}{job}/{folder}")
}

/// Whether `id` is a full object id as git prints one (SHA-1 or SHA-256).
fn full_id(id: &str) -> bool {
    matches!(id.len(), 40 | 64) && id.bytes().all(|b| b.is_ascii_hexdigit())
}

fn named(list: &[String]) -> Vec<String> {
    list.iter().take(NAMED).cloned().collect()
}

/// The folder that makes `path` build output, if one does: its shortest leading folder whose name is one a project's build or
/// tools write (`turn_files::REBUILT`, [`CACHES`], or a name ending in `.noindex`). A file the system writes beside a project's
/// own (`turn_files::SYSTEM_FILES`, `.DS_Store`) is build output wherever it is, and is its own answer.
pub(crate) fn output_folder(path: &str) -> Option<String> {
    let parts: Vec<&str> = path.split('/').collect();
    let (last, dirs) = parts.split_last()?;
    for (i, d) in dirs.iter().enumerate() {
        if turn_files::REBUILT.contains(d) || CACHES.contains(d) || d.ends_with(".noindex") {
            return Some(parts[..=i].join("/"));
        }
    }
    turn_files::SYSTEM_FILES.contains(last).then(|| path.to_string())
}

/// The paths of `paths` that do not resolve inside the lead's project, `prefix` (its record's folder inside the worktree, ""
/// for the whole worktree), in their order: GoSpark's `BuddyLand.pathsOutside`. Paths are from the top of the repository, as
/// git writes them. A path is outside when it is absolute, climbs out with `..`, or, in a project made at a subfolder, sits
/// elsewhere in the repository; the subfolder itself is not inside it, which is where git draws the line too.
pub(crate) fn outside(paths: &[String], prefix: &str) -> Vec<String> {
    let root: Vec<&str> = prefix.split('/').filter(|c| !c.is_empty()).collect();
    paths
        .iter()
        .filter(|path| {
            if path.starts_with('/') {
                return true;
            }
            let mut resolved: Vec<&str> = Vec::new();
            for c in path.split('/') {
                match c {
                    "" | "." => {}
                    ".." => {
                        if resolved.pop().is_none() {
                            return true;
                        }
                    }
                    c => resolved.push(c),
                }
            }
            resolved.len() <= root.len() || resolved[..root.len()] != root[..]
        })
        .cloned()
        .collect()
}

/// A file of the app's own made while a landing runs (the patch, a list of paths), readable by this account only from the
/// moment it exists, and taken away when it goes unless it was moved to be kept.
struct TempFile(PathBuf);

impl TempFile {
    fn new(home: &Path, what: &str) -> Result<TempFile, String> {
        let path = lane_helper::temp_dir(home)?.join(format!("{}.{what}", lane_helper::fresh_name()));
        let mut o = fs::OpenOptions::new();
        o.write(true).create_new(true);
        #[cfg(unix)]
        std::os::unix::fs::OpenOptionsExt::mode(&mut o, 0o600);
        o.open(&path).map_err(|e| e.to_string())?;
        Ok(TempFile(path))
    }

    fn arg(&self) -> String {
        self.0.to_string_lossy().into_owned()
    }
}

impl Drop for TempFile {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
    }
}

/// Writes `bytes` to `path`, readable by this account only: beside it first, then moved over it.
fn write_private(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let dir = path.parent().ok_or("no folder")?;
    let tmp = dir.join(format!(".{}.tmp", lane_helper::fresh_name()));
    let mut o = fs::OpenOptions::new();
    o.write(true).create_new(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut o, 0o600);
    o.open(&tmp).and_then(|mut f| f.write_all(bytes)).and_then(|_| fs::rename(&tmp, path)).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        e.to_string()
    })
}

/// The landing record at `path`, when it is a plain file the app wrote.
fn read_record(path: &Path) -> Option<Landing> {
    let md = fs::symlink_metadata(path).ok()?;
    if !md.is_file() || md.len() > RECORD_BYTES {
        return None;
    }
    serde_json::from_slice::<Landing>(&fs::read(path).ok()?).ok().filter(|l| l.v == 1)
}

/// Whether `wt` is still a worktree of the repository whose git folder is `repo`, as git lists it, and never that repository's
/// own folder.
fn listed(git: &Git, wt: &Path, repo: &Path) -> bool {
    let exists = fs::symlink_metadata(wt).map(|m| m.is_dir()).unwrap_or(false);
    exists && git.common_dir(wt).as_deref() == Some(repo) && git.worktrees(repo).is_some_and(|l| l.contains(&real(wt)) && l.first() != Some(&real(wt)))
}

/// A helper lane and its lead, as their records name them.
struct Pair {
    hwt: PathBuf,
    hrec: Record,
    job: String,
    snapshot: String,
    folder: String,
    lwt: PathBuf,
    lrec: Record,
    /// The helper lane's repository's git folder, as a real path.
    repo: PathBuf,
}

/// The helper lane whose folder is `helper` (its worktree, as its record names it) and the lead its record names. Refusals:
/// `not_a_lane` (a folder the app did not make, or one git no longer lists), `not_a_helper` (a lane that is no helper lane's),
/// `no_lead` (its lead is gone, is not a lane the app made, or is itself a helper lane).
fn pair(git: &Git, home: &Path, helper: &str) -> Result<Pair, String> {
    let (hwt, _, hrec) = lane::own_lane(home, helper)?;
    let of = hrec.helper.clone().ok_or("not_a_helper")?;
    let folder = hwt.file_name().and_then(|f| f.to_str()).map(str::to_string).ok_or("not_a_lane")?;
    // both become one plain part of a ref and of a file's name
    if !lane_helper::valid_job(&of.job) || !lane::word_ok(&folder) {
        return Err("not_a_lane".into());
    }
    let repo = real(Path::new(&hrec.repo));
    if !listed(git, &hwt, &repo) {
        return Err("not_a_lane".into());
    }
    let (lwt, _, lrec) = lane::own_lane(home, &of.lead).map_err(|_| "no_lead".to_string())?;
    if lrec.helper.is_some() || lwt == hwt || !listed(git, &lwt, &real(Path::new(&lrec.repo))) {
        return Err("no_lead".into());
    }
    Ok(Pair { hwt, hrec, job: of.job, snapshot: of.snapshot, folder, lwt, lrec, repo })
}

/// `git <args>` in `cwd` with `env`, and its output when it said yes; otherwise git's own last line.
fn checked(git: &Git, cwd: &Path, args: &[&str], env: &[(&str, &str)]) -> Result<String, String> {
    let ran = git.run_with(cwd, args, lane::SLOW, env)?;
    if ran.code != Some(0) {
        return Err(tasks::error_line(&ran.err));
    }
    if ran.out.len() as u64 >= tasks::MAX_OUT {
        return Err("git listed more than the app reads".into());
    }
    Ok(ran.out)
}

/// The commit `rev` names in `cwd`, as a full id.
fn commit(git: &Git, cwd: &Path, rev: &str) -> Option<String> {
    git.line(cwd, &["rev-parse", "--verify", "--quiet", &format!("{rev}^{{commit}}")]).filter(|l| full_id(l))
}

/// The files that differ between `base` and `tree`, from the top of the repository: a submodule's commit is not one of them
/// (item 90), and a rename is a file gone and a file new.
fn names(git: &Git, cwd: &Path, base: &str, tree: &str) -> Result<Vec<String>, String> {
    let out = checked(git, cwd, &["diff-tree", "-r", "--name-only", "-z", "--no-renames", "--ignore-submodules=all", base, tree], &[])?;
    Ok(out.split('\0').filter(|p| !p.is_empty()).map(str::to_string).collect())
}

/// Whether the commit `base` holds anything at `folder`.
fn holds(git: &Git, cwd: &Path, base: &str, folder: &str) -> bool {
    git.run(cwd, &["cat-file", "-e", &format!("{base}:{folder}")]).map(|r| r.code == Some(0)).unwrap_or(false)
}

/// The files an added line of which holds a key the masker hides, in the patch at `patch` whose files are `files` in its order
/// (each starts at a `diff --git` line; a header that names a file is read as an added line, as `lane_diff.rs` reads a push).
/// A key found where the blocks cannot be put to the files is `?`.
fn keys_in(patch: &Path, files: &[String]) -> Result<Vec<String>, String> {
    let mut read = BufReader::new(fs::File::open(patch).map_err(|e| e.to_string())?);
    let mut line: Vec<u8> = Vec::new();
    let mut block: Option<usize> = None;
    let mut found: BTreeSet<Option<usize>> = BTreeSet::new();
    loop {
        line.clear();
        if read.read_until(b'\n', &mut line).map_err(|e| e.to_string())? == 0 {
            break;
        }
        if line.starts_with(b"diff --git ") {
            block = Some(block.map_or(0, |b| b + 1));
        } else if let Some(added) = line.strip_prefix(b"+") {
            let text = String::from_utf8_lossy(added);
            let text = text.trim_end_matches(['\n', '\r']);
            if tasks::mask_secrets(text) != text {
                found.insert(block);
            }
        }
    }
    let whole = block.map_or(0, |b| b + 1) == files.len();
    let mut keys: Vec<String> = found.into_iter().map(|b| b.filter(|_| whole).and_then(|b| files.get(b).cloned()).unwrap_or_else(|| "?".into())).collect();
    keys.dedup();
    Ok(keys)
}

/// The helper lane's work, as a patch made by git in a file of the app's own: the files it holds, the build output cut from
/// it, and the files a key is in.
struct Work {
    files: Vec<String>,
    cut: Vec<String>,
    keys: Vec<String>,
    patch: TempFile,
}

/// Steps 2 to 5 of the module's own words, in the helper lane's folder, from the snapshot's commit `base`; `head` is the
/// helper lane's HEAD, read only by a folder with no index file.
fn work(git: &Git, home: &Path, hwt: &Path, base: &str, head: &str) -> Result<Work, String> {
    let (index, tree) = lane_helper::capture(git, home, hwt, head)?;
    let changed = names(git, hwt, base, &tree)?;
    let mut held: HashMap<String, bool> = HashMap::new();
    let cut: Vec<String> = changed
        .iter()
        .filter(|path| match output_folder(path) {
            None => false,
            Some(f) if f == **path => true,
            Some(f) => !*held.entry(f.clone()).or_insert_with(|| holds(git, hwt, base, &f)),
        })
        .cloned()
        .collect();
    let (tree, files) = if cut.is_empty() {
        (tree, changed)
    } else {
        // each cut file goes back to the snapshot's own in the copy of the index: a new one goes, a changed one is as it was
        let list = TempFile::new(home, "cut")?;
        let mut bytes = Vec::new();
        for p in &cut {
            bytes.extend(p.as_bytes());
            bytes.push(0);
        }
        fs::write(&list.0, &bytes).map_err(|e| e.to_string())?;
        let idx = index.0.to_string_lossy().into_owned();
        let env = [("GIT_INDEX_FILE", idx.as_str()), ("GIT_LITERAL_PATHSPECS", "1")];
        let list_arg = list.arg();
        checked(git, hwt, &["-c", "core.splitIndex=false", "restore", "--staged", "--source", base, "--pathspec-from-file", &list_arg, "--pathspec-file-nul"], &env)?;
        let tree = checked(git, hwt, &["-c", "core.splitIndex=false", "write-tree"], &env)?.trim().to_string();
        if !full_id(&tree) {
            return Err("git printed no tree".into());
        }
        let files = names(git, hwt, base, &tree)?;
        (tree, files)
    };
    drop(index);
    let patch = TempFile::new(home, "patch")?;
    if !files.is_empty() {
        // git writes the patch itself, so no byte of it is read as text on the way; it opens the file made above for writing,
        // which keeps its mode
        let output = format!("--output={}", patch.arg());
        checked(
            git,
            hwt,
            &[
                "diff-tree",
                "-r",
                "-p",
                "--binary",
                "--full-index",
                "--no-renames",
                "--no-ext-diff",
                "--no-textconv",
                "--no-color",
                "--ignore-submodules=all",
                "--src-prefix=a/",
                "--dst-prefix=b/",
                &output,
                base,
                &tree,
            ],
            &[],
        )?;
    }
    let keys = keys_in(&patch.0, &files)?;
    Ok(Work { files, cut, keys, patch })
}

/// Moves the patch to `~/.manut/patches/<job>/<folder>.patch` (owner-read-only, in folders only this account reads) and says
/// why it was kept: the lead's folder was not written.
fn keep(home: &Path, p: &Pair, patch: TempFile, mut out: Landed, why: &str, named_paths: Vec<String>, error: String) -> Result<Landed, String> {
    let dest = patch_path(home, &p.job, &p.folder);
    let manut = home.join(".manut");
    for d in [manut.clone(), manut.join("patches"), manut.join("patches").join(&p.job)] {
        lane::own_dir(&d)?;
    }
    fs::rename(&patch.0, &dest).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&dest, fs::Permissions::from_mode(0o600)).map_err(|e| e.to_string())?;
    }
    out.outcome = "kept".into();
    out.patch = dest.to_string_lossy().into_owned();
    out.why = why.into();
    out.outside = named_paths.into_iter().take(OUTSIDE_SHOWN).collect();
    out.error = error;
    Ok(out)
}

/// The folders on the way to `files` in `root` that are not there now: the ones a landing would make, which Take back takes
/// away again.
fn made_dirs(root: &Path, files: &[String]) -> Vec<String> {
    let mut out = BTreeSet::new();
    for f in files {
        let mut at = f.as_str();
        while let Some((d, _)) = at.rsplit_once('/') {
            if fs::symlink_metadata(root.join(d)).is_err() {
                out.insert(d.to_string());
            }
            at = d;
        }
    }
    out.into_iter().collect()
}

/// The files with conflict markers a three-way apply left, as its throwaway index `index` names them (each file once).
fn unmerged(git: &Git, lwt: &Path, index: &str) -> Vec<String> {
    let Ok(out) = checked(git, lwt, &["-c", "core.splitIndex=false", "ls-files", "-u", "-z"], &[("GIT_INDEX_FILE", index)]) else { return Vec::new() };
    let paths: BTreeSet<String> = out.split('\0').filter_map(|e| e.split_once('\t')).map(|(_, p)| p.to_string()).collect();
    paths.into_iter().collect()
}

/// The lead's own git folder (a worktree's, under the repository's `worktrees/`), where the bytes kept for a landing are
/// stored through the objects every worktree shares.
fn git_dir(git: &Git, lwt: &Path) -> Result<PathBuf, String> {
    git.line(lwt, &["rev-parse", "--absolute-git-dir"]).filter(|l| !l.is_empty()).map(PathBuf::from).ok_or_else(|| "git could not name the lane's folder".into())
}

/// Lands the work of the helper lane whose folder is `helper` in its lead lane's folder: the module's own words, steps 1 to 9.
/// Refusals, with nothing read or written: those of [`pair`]; `landed` (this helper lane's landing has not been taken back);
/// `busy` (git is partway through a rebase, merge, cherry-pick, revert or bisect in either folder, or an index is locked);
/// `config:<setting>` (the repository's own config names a program git would run here); `no_snapshot` (the ref the helper lane
/// started from is gone or moved); `no_commit`; `git_missing`. Anything else is git's own line, with the lead's folder as it
/// was.
pub fn land(home: &Path, helper: &str) -> Result<Landed, String> {
    let git = Git::new(home)?;
    let p = pair(&git, home, helper)?;
    let lock = lead_lock(&p.lrec.worktree);
    let _held = lock.lock().unwrap_or_else(|e| e.into_inner());
    #[cfg(test)]
    lane::between::at("land-locked", &p.lwt);
    if fs::symlink_metadata(record_path(home, &p.job, &p.folder)).is_ok() {
        return Err("landed".into());
    }
    if git.busy(&p.hwt) || git.busy(&p.lwt) {
        return Err("busy".into());
    }
    let lead_repo = real(Path::new(&p.lrec.repo));
    if let Some(setting) = git.lane_config_risk(&p.hwt, &p.repo).or_else(|| git.landing_config_risk(&p.lwt, &lead_repo)) {
        return Err(format!("config:{setting}"));
    }
    let base = commit(&git, &p.hwt, &p.snapshot).filter(|c| *c == p.hrec.at).ok_or("no_snapshot")?;
    let hhead = commit(&git, &p.hwt, "HEAD").ok_or("no_commit")?;
    let lhead = commit(&git, &p.lwt, "HEAD").ok_or("no_commit")?;

    let w = work(&git, home, &p.hwt, &base, &hhead)?;
    let mut out = Landed {
        files: named(&w.files),
        files_total: w.files.len() as u32,
        cut: named(&w.cut),
        cut_total: w.cut.len() as u32,
        keys: w.keys.clone(),
        ..Landed::default()
    };
    if w.files.is_empty() {
        out.outcome = "nothing".into();
        return Ok(out);
    }
    // where it may go: GoSpark's `foreignTarget`. A wrong target applies three ways with no marker and nothing to undo it
    if lead_repo != p.repo {
        return keep(home, &p, w.patch, out, "other_repo", Vec::new(), String::new());
    }
    let far = outside(&w.files, &p.lrec.prefix);
    if !far.is_empty() {
        return keep(home, &p, w.patch, out, "outside", far, String::new());
    }
    // a name git listed that is not text, or one a snapshot cannot hold, is never written
    let odd: Vec<String> = w.files.iter().filter(|f| !turn_files::safe_rel(f) || f.contains('\u{FFFD}')).cloned().collect();
    if !odd.is_empty() {
        return keep(home, &p, w.patch, out, "bad_path", odd, String::new());
    }

    // the snapshot before writing: each file the patch names, byte for byte as it is on disk
    let lgit = git_dir(&git, &p.lwt)?;
    let before = match turn_files::read_files(home, &p.lwt, &lgit, &w.files, true) {
        Ok(b) => b,
        Err(e) => return keep(home, &p, w.patch, out, "would_not_apply", Vec::new(), e),
    };
    let made = made_dirs(&p.lwt, &w.files);
    let (index, _) = lane_helper::capture(&git, home, &p.lwt, &lhead)?;
    let idx = index.0.to_string_lossy().into_owned();
    #[cfg(test)]
    lane::between::at("land-apply", &p.lwt);
    let patch_arg = w.patch.arg();
    let ran = git.run_with(&p.lwt, &["-c", "core.splitIndex=false", "apply", "--3way", "--binary", "--whitespace=nowarn", &patch_arg], lane::SLOW, &[("GIT_INDEX_FILE", idx.as_str())]);
    let conflicts = unmerged(&git, &p.lwt, &idx);
    drop(index);
    let applied = matches!(&ran, Ok(r) if r.code == Some(0) || (r.code == Some(1) && !conflicts.is_empty()));
    if !applied {
        let error = match ran {
            Ok(r) => apply_error(&r.err),
            Err(e) => e,
        };
        // git writes nothing of a patch that does not apply whole; should anything differ all the same (a git stopped part
        // way), it goes back to the snapshot taken before
        if let Err(e) = put_back(home, &p.lwt, &lgit, &w.files, &before, &made) {
            return Err(format!("{error}; the lead's folder could not be put back: {e}"));
        }
        return keep(home, &p, w.patch, out, "would_not_apply", Vec::new(), error);
    }
    if let Err(e) = remember(&git, home, &p, &lgit, &lhead, &w.files, &before, &made) {
        // a landing that cannot be taken back is not left: the folder goes back as it was
        return Err(match turn_files::write_files(home, &p.lwt, &lgit, &before, &made) {
            Ok(()) => e,
            Err(x) => format!("{e}; the lead's folder could not be put back: {x}"),
        });
    }
    out.outcome = "landed".into();
    out.conflicts = conflicts;
    Ok(out)
}

/// Why `git apply` would not apply a patch, from what it printed: its first `error:` line (the lines after it say what it
/// tried, `Falling back to direct application...`), else its last line, short and masked.
fn apply_error(err: &str) -> String {
    match err.lines().map(str::trim).find(|l| l.starts_with("error:")) {
        Some(line) => tasks::one_line(tasks::mask_secrets(line), 200),
        None => tasks::error_line(err),
    }
}

/// Puts the files `files` of `lwt` back to `before` when any of them differs from it now.
fn put_back(home: &Path, lwt: &Path, lgit: &Path, files: &[String], before: &BTreeMap<String, Option<OnDisk>>, made: &[String]) -> Result<(), String> {
    match turn_files::read_files(home, lwt, lgit, files, false) {
        Ok(now) if now == *before => Ok(()),
        _ => turn_files::write_files(home, lwt, lgit, before, made),
    }
}

/// Step 9 of the module's own words: the landed bytes and the bytes from before, kept by the landing's ref, and its record.
#[allow(clippy::too_many_arguments)]
fn remember(git: &Git, home: &Path, p: &Pair, lgit: &Path, lhead: &str, files: &[String], before: &BTreeMap<String, Option<OnDisk>>, made: &[String]) -> Result<(), String> {
    let after = turn_files::read_files(home, &p.lwt, lgit, files, true)?;
    let (_, folder) = lane_helper::capture(git, home, &p.lwt, lhead)?;
    let mut kept: Vec<(String, &OnDisk)> = before.iter().filter_map(|(path, f)| f.as_ref().map(|f| (format!("b/{path}"), f))).collect();
    kept.extend(after.iter().filter_map(|(path, f)| f.as_ref().map(|f| (format!("a/{path}"), f))));
    let tree = turn_files::tree_of(home, lgit, &lane_helper::temp_dir(home)?, &kept)?;
    let name = keep_ref(&p.job, &p.folder);
    checked(git, &p.lwt, &["update-ref", &name, &tree], &[])?;
    let rec = Landing {
        v: 1,
        helper: p.hrec.worktree.clone(),
        lead: p.lrec.worktree.clone(),
        keep: name.clone(),
        tree: tree.clone(),
        before: before.clone(),
        after,
        made: made.to_vec(),
        folder,
        at: lane::now_secs(),
    };
    let path = record_path(home, &p.job, &p.folder);
    let saved = (|| {
        let manut = home.join(".manut");
        for d in [manut.clone(), manut.join("landings"), manut.join("landings").join(&p.job)] {
            lane::own_dir(&d)?;
        }
        write_private(&path, &serde_json::to_vec(&rec).map_err(|e| e.to_string())?)
    })();
    if saved.is_err() {
        let _ = git.run(&p.lwt, &["update-ref", "-d", &name, &tree]);
    }
    saved
}

/// Takes back the landing of the helper lane whose folder is `helper`: every file it wrote in the lead's folder goes back as it
/// was before, byte for byte with its bits, and the folders it made go, only while nothing in the lead's folder changed since
/// (the landed files byte for byte, and the whole folder's tree). Its keep and record go, and the helper lane may land again.
/// Refusals, with nothing written: those of [`pair`]; `not_landed` (no landing of it to take back); `changed` (the lead's folder
/// changed since); `no_commit`; `git_missing`. A write that fails part way puts the landing back as it was, so Take back can be
/// tried again, and says git's or the system's own words.
pub fn take_back(home: &Path, helper: &str) -> Result<TakenBack, String> {
    let git = Git::new(home)?;
    let p = pair(&git, home, helper)?;
    let lock = lead_lock(&p.lrec.worktree);
    let _held = lock.lock().unwrap_or_else(|e| e.into_inner());
    let path = record_path(home, &p.job, &p.folder);
    let k = read_record(&path).ok_or("not_landed")?;
    if k.helper != p.hrec.worktree || k.lead != p.lrec.worktree || k.keep != keep_ref(&p.job, &p.folder) || !full_id(&k.tree) {
        return Err("not_landed".into());
    }
    // its bytes are still kept by its ref
    if git.line(&p.lwt, &["rev-parse", "--verify", "--quiet", &k.keep]).as_deref() != Some(k.tree.as_str()) {
        return Err("not_landed".into());
    }
    let lgit = git_dir(&git, &p.lwt)?;
    let paths: Vec<String> = k.after.keys().cloned().collect();
    // nothing changed since: the landed files byte for byte, then the whole folder as git sees it
    match turn_files::read_files(home, &p.lwt, &lgit, &paths, false) {
        Ok(now) if now == k.after => {}
        _ => return Err("changed".into()),
    }
    let lhead = commit(&git, &p.lwt, "HEAD").ok_or("no_commit")?;
    let (_, folder) = lane_helper::capture(&git, home, &p.lwt, &lhead)?;
    if folder != k.folder {
        return Err("changed".into());
    }
    #[cfg(test)]
    lane::between::at("take-back-write", &p.lwt);
    if let Err(e) = turn_files::write_files(home, &p.lwt, &lgit, &k.before, &k.made) {
        let _ = turn_files::write_files(home, &p.lwt, &lgit, &k.after, &[]);
        return Err(e);
    }
    let _ = fs::remove_file(&path);
    let _ = git.run(&p.lwt, &["update-ref", "-d", &k.keep, &k.tree]);
    Ok(TakenBack { files: named(&paths), files_total: paths.len() as u32 })
}

/// Forgets the landing of the helper lane in folder `folder` of job `job`, if there is one: its record and the ref that keeps
/// its bytes, in the repository whose git folder is `repo`. `lane::remove` calls it when the helper lane's record goes, since a
/// landing is taken back by naming its helper lane. A kept patch is not touched.
pub(crate) fn forget(home: &Path, git: &Git, repo: &Path, job: &str, folder: &str) {
    if !lane_helper::valid_job(job) || !lane::word_ok(folder) {
        return;
    }
    let _ = fs::remove_file(record_path(home, job, folder));
    let name = keep_ref(job, folder);
    let _ = git.run(repo, &["update-ref", "-d", &name]);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::lane::tests::{commit_in, names, repo, sh};
    use crate::lane::RemoveAsk;
    use crate::lane_helper::tests::{files, lead, s, same, seen, text};
    use std::sync::mpsc;
    use std::time::Duration;

    /// A helper lane of the lead lane `lwt` for job `job`: its folder.
    fn helper(home: &Path, lwt: &Path, job: &str) -> PathBuf {
        PathBuf::from(lane_helper::make(home, &s(lwt), job).unwrap().worktree)
    }

    fn mode_of(p: &Path) -> u32 {
        use std::os::unix::fs::PermissionsExt;
        fs::symlink_metadata(p).unwrap().permissions().mode() & 0o777
    }

    fn write(dir: &Path, rel: &str, body: &str) {
        let at = dir.join(rel);
        fs::create_dir_all(at.parent().unwrap()).unwrap();
        fs::write(at, body).unwrap();
    }

    /// The landing refs and records of `home`, and what the app's temporary folder still holds.
    fn kept_state(home: &Path, d: &Path) -> (String, usize, usize) {
        let records = fs::read_dir(home.join(".manut/landings")).map(|r| r.flatten().map(|j| fs::read_dir(j.path()).map(|f| f.count()).unwrap_or(0)).sum()).unwrap_or(0);
        let temp = fs::read_dir(home.join(".manut/helper-index")).map(|r| r.count()).unwrap_or(0);
        (sh(d, &["for-each-ref", "--format=%(refname)", REFS]), records, temp)
    }

    #[test]
    fn build_output_and_the_project_s_bounds_follow_gosparks_rules() {
        for (path, folder) in [
            ("dist/app.js", Some("dist")),
            ("apps/web/.next/cache/x", Some("apps/web/.next")),
            (".build/debug/App", Some(".build")),
            ("App.xcodeproj/-Xcc/mod.modulemap", Some("App.xcodeproj/-Xcc")),
            ("build.noindex/x", Some("build.noindex")),
            ("a/.DS_Store", Some("a/.DS_Store")),
            ("src/app.ts", None),
            ("build.gradle", None),
            ("dist", None),
        ] {
            assert_eq!(output_folder(path).as_deref(), folder, "{path}");
        }
        // GoSpark's `pathsOutsideTheCheckout`, case by case; a record's folder has no slash at its end
        let v = |l: &[&str]| l.iter().map(|x| x.to_string()).collect::<Vec<_>>();
        assert!(outside(&v(&["a.swift", "Sources/b.swift", "./c.swift", "d/../e.swift"]), "").is_empty());
        assert_eq!(outside(&v(&["/etc/hosts", "../other/x.swift", "a/../../y.swift"]), ""), v(&["/etc/hosts", "../other/x.swift", "a/../../y.swift"]));
        for prefix in ["sub", "sub/"] {
            assert!(outside(&v(&["sub/a.swift", "sub/deep/b.swift"]), prefix).is_empty());
            assert_eq!(outside(&v(&["b.txt", "subway/c.txt", "sub", "sub/../d.txt"]), prefix), v(&["b.txt", "subway/c.txt", "sub", "sub/../d.txt"]));
        }
        assert_eq!(outside(&v(&["app/Sources/x.swift", "app/Tests/y.swift"]), "app/Sources"), v(&["app/Tests/y.swift"]));
        assert_eq!(outside(&v(&["../outside"]), "apps/web"), v(&["../outside"]));
    }

    /// GoSpark's `cleanApplyAdvancesBase`, and the slice's promise that a landing writes the lead's working tree only: the
    /// lead's own uncommitted work stays (a change in another part of the same file merges in), its index, HEAD, branch and
    /// stash do not change, and neither the developer's folder nor the helper lane's own does.
    #[test]
    fn a_clean_landing_writes_the_lead_s_working_tree_and_nothing_else() {
        let Some((home, d, lwt)) = lead("ll-clean") else { return };
        commit_in(&lwt, "list.txt", "1\n2\n3\n4\n5\n6\n7\n8\n9\n");
        commit_in(&lwt, "c.txt", "three\n");
        fs::write(lwt.join("a.txt"), "one\nmine\n").unwrap();
        sh(&lwt, &["stash", "-q"]);
        fs::write(lwt.join("a.txt"), "one\nlead's\n").unwrap();
        let hwt = helper(&home, &lwt, "jclean");
        // the lead goes on with its own work after the helper lane started
        fs::write(lwt.join("list.txt"), "1 lead\n2\n3\n4\n5\n6\n7\n8\n9\n").unwrap();
        write(&lwt, "notes.md", "lead's notes\n");
        // the helper lane's work: a change at the other end of the file, a new file in a new folder, a deletion, a commit
        fs::write(hwt.join("list.txt"), "1\n2\n3\n4\n5\n6\n7\n8\n9 helper\n").unwrap();
        write(&hwt, "apps/web/qr/qr.ts", "export const qr = 1;\n");
        fs::remove_file(hwt.join("c.txt")).unwrap();
        commit_in(&hwt, "apps/web/b.txt", "two\nhelper\n");
        let before = seen(&lwt);
        let developer = seen(&d);
        let helper_before = seen(&hwt);
        let branches = sh(&d, &["for-each-ref", "--format=%(refname) %(objectname)", "refs/heads/"]);

        let got = land(&home, &s(&hwt)).unwrap();

        assert_eq!(
            got,
            Landed {
                outcome: "landed".into(),
                files: names(&["apps/web/b.txt", "apps/web/qr/qr.ts", "c.txt", "list.txt"]),
                files_total: 4,
                ..Landed::default()
            }
        );
        assert_eq!(text(&lwt, "list.txt"), "1 lead\n2\n3\n4\n5\n6\n7\n8\n9 helper\n");
        assert_eq!((text(&lwt, "apps/web/qr/qr.ts"), text(&lwt, "apps/web/b.txt")), ("export const qr = 1;\n".into(), "two\nhelper\n".into()));
        assert!(!lwt.join("c.txt").exists());
        assert_eq!((text(&lwt, "a.txt"), text(&lwt, "notes.md")), ("one\nlead's\n".into(), "lead's notes\n".into()));
        // the lead's index, HEAD, branch and stash: as they were; only its working tree changed
        let after = seen(&lwt);
        assert!(after.index == before.index, "the lead's index changed");
        assert_eq!((&after.head, &after.commit, &after.stash), (&before.head, &before.commit, &before.stash));
        assert_eq!(sh(&d, &["for-each-ref", "--format=%(refname) %(objectname)", "refs/heads/"]), branches);
        same(&seen(&d), &developer, "the developer's folder");
        same(&seen(&hwt), &helper_before, "the helper lane");
        // kept for Take back: one ref and one record, owner-read-only; no patch, nothing left in the temporary folder
        assert_eq!(kept_state(&home, &d), ("refs/manut/landings/jclean/promptpay-qr-help-1".into(), 1, 0));
        let rec = home.join(".manut/landings/jclean/promptpay-qr-help-1.json");
        assert_eq!((mode_of(&rec), mode_of(rec.parent().unwrap())), (0o600, 0o700));
        assert!(!home.join(".manut/patches").exists());
        // one landing for each helper lane until it is taken back
        assert_eq!(land(&home, &s(&hwt)), Err("landed".into()));
        let _ = fs::remove_dir_all(home);
    }

    /// GoSpark's `conflictsStillLandAndAdvanceBase`: both changed the same line, so the file keeps conflict markers, counts as
    /// landed and is named; the lead's index still does not change.
    #[test]
    fn a_three_way_conflict_counts_as_landed_and_is_named() {
        let Some((home, _d, lwt)) = lead("ll-conflict") else { return };
        let hwt = helper(&home, &lwt, "jconf");
        fs::write(hwt.join("a.txt"), "one\nfrom the helper\n").unwrap();
        write(&hwt, "apps/web/b.txt", "two\nclean\n");
        fs::write(lwt.join("a.txt"), "one\nfrom the lead\n").unwrap();
        let before = seen(&lwt);

        let got = land(&home, &s(&hwt)).unwrap();

        assert_eq!((got.outcome.as_str(), got.files.clone(), got.conflicts.clone()), ("landed", names(&["a.txt", "apps/web/b.txt"]), names(&["a.txt"])));
        let a = text(&lwt, "a.txt");
        assert!(a.contains("<<<<<<<") && a.contains("from the lead") && a.contains("from the helper") && a.contains(">>>>>>>"), "{a}");
        assert_eq!(text(&lwt, "apps/web/b.txt"), "two\nclean\n");
        assert!(seen(&lwt).index == before.index, "the lead's index changed");
        // and Take back puts the lead's own line back, every byte
        take_back(&home, &s(&hwt)).unwrap();
        same(&seen(&lwt), &before, "after Take back");
        let _ = fs::remove_dir_all(home);
    }

    /// The slice's safety test: a patch that will not apply (it changes a file the lead has deleted; git applies a patch whole or
    /// not at all) leaves the lead's folder and its index byte for byte as they were, and is kept at
    /// `~/.manut/patches/<job>/<folder>.patch` with mode 0600. And GoSpark's `failedApplyWritesPatchAndLeavesBase`: a folder
    /// where the patch expects a file.
    #[test]
    fn a_patch_that_will_not_apply_leaves_the_lead_byte_for_byte_and_is_kept_owner_read_only() {
        let Some((home, d, lwt)) = lead("ll-fail") else { return };
        let hwt = helper(&home, &lwt, "jfail");
        fs::write(hwt.join("a.txt"), "one\nhelper\n").unwrap();
        write(&hwt, "apps/web/b.txt", "two\nhelper\n");
        write(&hwt, "fresh/new.txt", "new\n");
        fs::remove_file(lwt.join("a.txt")).unwrap();
        write(&lwt, "notes.md", "lead's\n");
        let before = seen(&lwt);
        let lead_git = PathBuf::from(sh(&lwt, &["rev-parse", "--absolute-git-dir"]));
        let lead_git_before = files(&lead_git);

        let got = land(&home, &s(&hwt)).unwrap();

        let kept = home.join(".manut/patches/jfail/promptpay-qr-help-1.patch");
        assert_eq!((got.outcome.as_str(), got.why.as_str(), got.patch.as_str()), ("kept", "would_not_apply", s(&kept).as_str()));
        assert!(got.error.contains("a.txt"), "{}", got.error);
        assert_eq!(got.files, names(&["a.txt", "apps/web/b.txt", "fresh/new.txt"]));
        same(&seen(&lwt), &before, "the lead");
        assert!(files(&lead_git) == lead_git_before, "the lead's own git folder changed");
        assert!(!lwt.join("fresh").exists());
        assert_eq!((mode_of(&kept), mode_of(kept.parent().unwrap()), mode_of(&home.join(".manut/patches"))), (0o600, 0o700, 0o700));
        let patch = fs::read_to_string(&kept).unwrap();
        assert!(patch.contains("diff --git a/a.txt b/a.txt") && patch.contains("+helper") && patch.contains("diff --git a/fresh/new.txt b/fresh/new.txt"), "{patch}");
        // nothing kept for Take back, nothing left over; with the file back, the same helper lane lands
        assert_eq!(kept_state(&home, &d), (String::new(), 0, 0));
        assert_eq!(take_back(&home, &s(&hwt)), Err("not_landed".into()));
        sh(&lwt, &["checkout", "--", "a.txt"]);
        assert_eq!(land(&home, &s(&hwt)).unwrap().outcome, "landed");
        assert_eq!(text(&lwt, "a.txt"), "one\nhelper\n");
        take_back(&home, &s(&hwt)).unwrap();

        // a folder where the patch expects a file: nothing is tried, nothing is written
        fs::remove_file(lwt.join("a.txt")).unwrap();
        fs::create_dir_all(lwt.join("a.txt")).unwrap();
        write(&lwt, "a.txt/inside", "x\n");
        let before = seen(&lwt);
        let got = land(&home, &s(&hwt)).unwrap();
        assert_eq!((got.outcome.as_str(), got.why.as_str()), ("kept", "would_not_apply"));
        assert!(got.error.contains("a.txt"), "{}", got.error);
        same(&seen(&lwt), &before, "the lead, a folder in the way");
        assert_eq!(mode_of(&kept), 0o600);
        let _ = fs::remove_dir_all(home);
    }

    /// The slice's safety test: two landings into one lead folder at once run one after the other (a barrier inside the first
    /// apply holds the second at the lock), and a helper lane's snapshot of that lead waits too (GoSpark's
    /// `copyWaitsForLanding`), so it never starts from a folder half way through a patch.
    #[test]
    fn two_landings_at_once_run_one_after_the_other() {
        let Some((home, _d, lwt)) = lead("ll-two") else { return };
        let one = helper(&home, &lwt, "jtwo");
        let two = helper(&home, &lwt, "jtwo");
        fs::write(one.join("a.txt"), "one\nfrom one\n").unwrap();
        write(&two, "apps/web/b.txt", "two\nfrom two\n");

        let (inside_tx, inside_rx) = mpsc::channel::<()>();
        let (release_tx, release_rx) = mpsc::channel::<()>();
        let (h, w) = (home.clone(), s(&one));
        let first = std::thread::spawn(move || {
            lane::between::set(Some(Box::new(move |step, _| {
                if step == "land-apply" {
                    inside_tx.send(()).unwrap();
                    release_rx.recv().unwrap();
                }
            })));
            land(&h, &w)
        });
        inside_rx.recv_timeout(Duration::from_secs(60)).expect("the first landing reached its apply");
        let (second_tx, second_rx) = mpsc::channel::<()>();
        let (h, w) = (home.clone(), s(&two));
        let second = std::thread::spawn(move || {
            lane::between::set(Some(Box::new(move |step, _| {
                if step == "land-locked" {
                    second_tx.send(()).unwrap();
                }
            })));
            land(&h, &w)
        });
        let (snap_tx, snap_rx) = mpsc::channel::<()>();
        let (h, l) = (home.clone(), s(&lwt));
        let third = std::thread::spawn(move || {
            lane::between::set(Some(Box::new(move |step, _| {
                if step == "helper-snapshot" {
                    snap_tx.send(()).unwrap();
                }
            })));
            lane_helper::make(&h, &l, "jtwo")
        });
        std::thread::sleep(Duration::from_millis(600));
        assert!(second_rx.try_recv().is_err(), "the second landing went past the lock while the first was applying");
        assert!(snap_rx.try_recv().is_err(), "a helper lane's snapshot was taken while a landing was applying");
        release_tx.send(()).unwrap();
        assert_eq!(first.join().unwrap().unwrap().outcome, "landed");
        second_rx.recv_timeout(Duration::from_secs(60)).expect("the second landing took the lock once the first was done");
        assert_eq!(second.join().unwrap().unwrap().outcome, "landed");
        let made = third.join().unwrap().unwrap();
        // both landed whole, and the snapshot holds the first landing whole
        assert_eq!((text(&lwt, "a.txt"), text(&lwt, "apps/web/b.txt")), ("one\nfrom one\n".into(), "two\nfrom two\n".into()));
        assert_eq!(text(Path::new(&made.dir), "a.txt"), "one\nfrom one\n");
        let _ = fs::remove_dir_all(home);
    }

    /// GoSpark's `buildOutputsAreFilteredFromLanding`: what git's ignore rules missed in the helper lane never lands, and a folder
    /// of such a name that the project keeps in git (a tracked `build/`) is the project's own and lands.
    #[test]
    fn build_output_is_cut_and_a_folder_the_project_keeps_is_its_own() {
        let Some((home, _d, lwt)) = lead("ll-cut") else { return };
        write(&lwt, "build/run.sh", "echo run\n");
        commit_in(&lwt, "build/run.sh", "echo run\n");
        let hwt = helper(&home, &lwt, "jcut");
        fs::write(hwt.join("a.txt"), "one\nreal\n").unwrap();
        fs::write(hwt.join("build/run.sh"), "echo run fast\n").unwrap();
        write(&hwt, "build/more.sh", "echo more\n");
        for cache in ["dist/app.js", ".DS_Store", ".build/debug/App", "App.xcodeproj/-Xcc/mod.modulemap", "apps/web/.next/cache/x"] {
            write(&hwt, cache, "cache\n");
        }

        let got = land(&home, &s(&hwt)).unwrap();

        assert_eq!(got.outcome, "landed");
        assert_eq!((got.files.clone(), got.files_total), (names(&["a.txt", "build/more.sh", "build/run.sh"]), 3));
        // `.DS_Store` is cut, or never seen where the person's own global ignore file names it already
        let cut: Vec<String> = got.cut.iter().filter(|c| *c != ".DS_Store").cloned().collect();
        assert_eq!(cut, names(&[".build/debug/App", "App.xcodeproj/-Xcc/mod.modulemap", "apps/web/.next/cache/x", "dist/app.js"]));
        assert_eq!(got.cut_total as usize, got.cut.len());
        assert_eq!((text(&lwt, "a.txt"), text(&lwt, "build/run.sh"), text(&lwt, "build/more.sh")), ("one\nreal\n".into(), "echo run fast\n".into(), "echo more\n".into()));
        for gone in ["dist", ".DS_Store", ".build", "App.xcodeproj", "apps/web/.next"] {
            assert!(!lwt.join(gone).exists(), "{gone} landed");
        }
        // a helper lane whose only changes are build output lands nothing
        take_back(&home, &s(&hwt)).unwrap();
        let only = helper(&home, &lwt, "jcut");
        write(&only, "dist/app.js", "cache\n");
        let got = land(&home, &s(&only)).unwrap();
        assert_eq!((got.outcome.as_str(), got.files.len(), got.cut.clone()), ("nothing", 0, names(&["dist/app.js"])));
        assert!(!home.join(".manut/landings/jcut/promptpay-qr-help-2.json").exists());
        let _ = fs::remove_dir_all(home);
    }

    /// GoSpark's `foreignTarget` for a project made at a subfolder: a patch that also names a file elsewhere in the repository is
    /// kept whole and not tried, the lead's folder untouched, and the kept patch stays when the helper lane is removed.
    #[test]
    fn a_patch_naming_files_outside_the_lead_s_project_is_kept_untried() {
        let Some((home, d)) = repo("ll-outside") else { return };
        let lead = lane::make(&home, &d.join("apps/web"), &names(&["kit/web"])).unwrap();
        let lwt = PathBuf::from(&lead.worktree);
        let hwt = helper(&home, &lwt, "jout");
        write(&hwt, "apps/web/b.txt", "two\ninside\n");
        fs::write(hwt.join("a.txt"), "one\noutside\n").unwrap();
        let before = seen(&lwt);

        let got = land(&home, &s(&hwt)).unwrap();

        let kept = home.join(".manut/patches/jout/web-help-1.patch");
        assert_eq!((got.outcome.as_str(), got.why.as_str(), got.outside.clone(), got.patch.as_str()), ("kept", "outside", names(&["a.txt"]), s(&kept).as_str()));
        assert_eq!(got.files, names(&["a.txt", "apps/web/b.txt"]));
        same(&seen(&lwt), &before, "the lead");
        assert_eq!(mode_of(&kept), 0o600);
        let patch = fs::read_to_string(&kept).unwrap();
        assert!(patch.contains("b/a.txt") && patch.contains("b/apps/web/b.txt"));
        assert_eq!(kept_state(&home, &d), (String::new(), 0, 0));
        // only inside the project: it lands
        sh(&hwt, &["checkout", "--", "a.txt"]);
        assert_eq!(land(&home, &s(&hwt)).unwrap().files, names(&["apps/web/b.txt"]));
        assert_eq!(text(&lwt, "apps/web/b.txt"), "two\ninside\n");
        // removing the helper lane forgets its landing (nothing names it any more) and keeps the patch
        assert_eq!(kept_state(&home, &d).1, 1);
        let changed = sh(&hwt, &["status", "--porcelain", "--untracked-files=all"]).lines().count() as u32;
        let gone = lane::remove(&home, &s(&hwt), &RemoveAsk { changed, ..RemoveAsk::default() }).unwrap();
        assert!(gone.removed);
        assert_eq!(kept_state(&home, &d), (String::new(), 0, 0));
        assert!(kept.is_file());
        let _ = fs::remove_dir_all(home);
    }

    /// The masker reads the patch: a key in it is named in the answer, never shown, and the work still lands, so the lead's next
    /// commit or push reads it from the lane's diff and asks first (item 117).
    #[test]
    fn a_key_in_the_patch_is_named_and_the_work_lands_for_the_lead_s_commit_to_ask() {
        let Some((home, _d, lwt)) = lead("ll-key") else { return };
        let hwt = helper(&home, &lwt, "jkey");
        let key = format!("ghp_{}", "f".repeat(36));
        write(&hwt, "apps/web/config.ts", &format!("export const token = \"{key}\";\n"));
        fs::write(hwt.join("a.txt"), "one\nplain\n").unwrap();

        let got = land(&home, &s(&hwt)).unwrap();

        assert_eq!((got.outcome.as_str(), got.keys.clone()), ("landed", names(&["apps/web/config.ts"])));
        assert!(!serde_json::to_string(&got).unwrap().contains(&key), "the answer holds the key");
        // the lead's own diff, which a commit or push reads before it goes, has the key masked in that file
        let diff = crate::lane_diff::read(&home, &s(&lwt)).unwrap();
        let file = diff.files.iter().find(|f| f.path == "apps/web/config.ts").unwrap();
        assert!(!file.diff.contains(&key) && tasks::mask_secrets(&format!("+{key}")) != format!("+{key}"));
        assert!(!diff.files.iter().any(|f| f.diff.contains(&key)));
        let _ = fs::remove_dir_all(home);
    }

    /// Take back puts the lead's folder back byte for byte (files, bits, the folders the landing made, the index as it always
    /// was), only while nothing changed there since, and then the helper lane may land again.
    #[test]
    fn take_back_restores_the_lead_byte_for_byte_while_nothing_changed_since() {
        let Some((home, d, lwt)) = lead("ll-back") else { return };
        commit_in(&lwt, "run.sh", "echo run\n");
        commit_in(&lwt, "c.txt", "three\n");
        let hwt = helper(&home, &lwt, "jback");
        // the lead's own work, kept as it is
        fs::write(lwt.join("a.txt"), "one\nlead's\n").unwrap();
        write(&lwt, "keep/notes.md", "notes\n");
        // the helper lane's: a change, files in new folders, a deletion, a file made executable
        write(&hwt, "apps/web/b.txt", "two\nhelper\n");
        write(&hwt, "deep/er/still/new.txt", "new\n");
        write(&hwt, "keep/more.md", "more\n");
        fs::remove_file(hwt.join("c.txt")).unwrap();
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(hwt.join("run.sh"), fs::Permissions::from_mode(0o755)).unwrap();
        }
        let before = seen(&lwt);
        let developer = seen(&d);
        assert_eq!(mode_of(&lwt.join("run.sh")), 0o644);

        let got = land(&home, &s(&hwt)).unwrap();
        assert_eq!(got.files, names(&["apps/web/b.txt", "c.txt", "deep/er/still/new.txt", "keep/more.md", "run.sh"]));
        assert_eq!(mode_of(&lwt.join("run.sh")), 0o755);

        // a change since, anywhere in the lead's folder: nothing is taken back
        let landed = seen(&lwt);
        fs::write(lwt.join("apps/web/b.txt"), "two\nhelper\nedited\n").unwrap();
        assert_eq!(take_back(&home, &s(&hwt)), Err("changed".into()));
        fs::write(lwt.join("apps/web/b.txt"), "two\nhelper\n").unwrap();
        write(&lwt, "other.txt", "made since\n");
        assert_eq!(take_back(&home, &s(&hwt)), Err("changed".into()));
        fs::remove_file(lwt.join("other.txt")).unwrap();
        same(&seen(&lwt), &landed, "a refused Take back");

        let back = take_back(&home, &s(&hwt)).unwrap();
        assert_eq!((back.files.len(), back.files_total), (5, 5));
        same(&seen(&lwt), &before, "after Take back");
        assert_eq!(mode_of(&lwt.join("run.sh")), 0o644);
        assert!(!lwt.join("deep").exists(), "a folder the landing made is still there");
        assert!(lwt.join("keep").is_dir());
        same(&seen(&d), &developer, "the developer's folder");
        assert_eq!(kept_state(&home, &d), (String::new(), 0, 0));
        assert_eq!(take_back(&home, &s(&hwt)), Err("not_landed".into()));
        // taken back, it may land again
        assert_eq!(land(&home, &s(&hwt)).unwrap().outcome, "landed");
        assert_eq!(text(&lwt, "deep/er/still/new.txt"), "new\n");
        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn refuses_what_is_no_helper_lane_and_a_repository_whose_config_names_a_program() {
        let Some((home, d, lwt)) = lead("ll-refuse") else { return };
        let hwt = helper(&home, &lwt, "jref");
        let (h, l) = (s(&hwt), s(&lwt));
        // what the page may name: only a helper lane the app made
        for (not, code) in [(s(&d), "not_a_lane"), ("relative/x".to_string(), "not_a_lane"), (s(&hwt.join("apps/web")), "not_a_lane"), (l.clone(), "not_a_helper")] {
            assert_eq!(land(&home, &not), Err(code.into()), "{not}");
            assert_eq!(take_back(&home, &not), Err(code.into()), "{not}");
        }
        assert_eq!(take_back(&home, &h), Err("not_landed".into()));
        // a helper lane that changed nothing lands nothing, and keeps nothing
        assert_eq!(land(&home, &h).unwrap(), Landed { outcome: "nothing".into(), ..Landed::default() });
        assert_eq!(kept_state(&home, &d), (String::new(), 0, 0));
        fs::write(hwt.join("a.txt"), "one\nhelper\n").unwrap();
        // either folder partway through something of git's
        for dir in [&hwt, &lwt] {
            let git_dir = PathBuf::from(sh(dir, &["rev-parse", "--absolute-git-dir"]));
            fs::write(git_dir.join("MERGE_HEAD"), "x").unwrap();
            assert_eq!(land(&home, &h), Err("busy".into()));
            fs::remove_file(git_dir.join("MERGE_HEAD")).unwrap();
        }
        // the repository's own config names a program a landing would run: a clean filter, a merge driver
        for (key, value) in [("filter.spy.clean", "cat"), ("merge.spy.driver", "true")] {
            sh(&d, &["config", key, value]);
            assert_eq!(land(&home, &h), Err(format!("config:{key}")));
            sh(&d, &["config", "--unset", key]);
        }
        // the snapshot it started from moved
        let at = sh(&d, &["rev-parse", "refs/manut/helpers/jref/promptpay-qr-help-1"]);
        sh(&d, &["update-ref", "refs/manut/helpers/jref/promptpay-qr-help-1", "main"]);
        assert_eq!(land(&home, &h), Err("no_snapshot".into()));
        sh(&d, &["update-ref", "refs/manut/helpers/jref/promptpay-qr-help-1", &at]);
        assert_eq!(text(&lwt, "a.txt"), "one\n");
        assert_eq!(land(&home, &h).unwrap().outcome, "landed");
        // its lead gone: nothing to land in or take back from
        let changed = sh(&lwt, &["status", "--porcelain", "--untracked-files=all"]).lines().count() as u32;
        assert!(lane::remove(&home, &l, &RemoveAsk { changed, ..RemoveAsk::default() }).unwrap().removed);
        assert_eq!(land(&home, &h), Err("no_lead".into()));
        assert_eq!(take_back(&home, &h), Err("no_lead".into()));
        let _ = fs::remove_dir_all(home);
    }
}
