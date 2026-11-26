//! A helper lane's own working folder (item 102f; docs/several-agents.md, R1 and R8). A lane's agent (the lead) asks for
//! helper lanes, and each works in its own copy of the lead's work as it is when the helper starts. The lead's work is mostly
//! uncommitted while it leads, so a helper lane is not made from the lead's last commit, as a lane is made from the
//! developer's (`lane.rs`), but from a snapshot of the lead lane's folder: the files git tracks there as they are on disk,
//! staged or not, and the new files git does not ignore.
//!
//! How the snapshot is taken, lifted from GoSpark's `Git.captureTree()` and `commitTree` (`GoGoCode/Git/Git.swift`) and the
//! isolated copy each Buddy head starts from (`makeBuddyCopy` in `GoGoCode/App/AppModel+Buddy.swift`, `BuddyCopySnapshots` in
//! `GoGoCode/Models/BuddyCopySnapshot.swift`), `mygogocash/gospark` at `a7537c80`:
//!
//! 1. The lead lane's own index file is copied, byte for byte, to a temporary file of this module's own under
//!    `~/.manut/helper-index` (readable by this account only). Starting from the lead's index keeps what it stages (a file
//!    git tracks although it matches an ignore rule, a sparse checkout's entries) and git's stat cache, so files that did not
//!    change are not read again. A lead with no index file starts from its HEAD's tree (`read-tree HEAD`).
//! 2. `git add -A` with `GIT_INDEX_FILE` naming that copy writes the folder's files into it: changed, deleted and new files,
//!    never one git ignores. `git write-tree` makes a tree of it, and `git commit-tree` a commit of that tree on top of the
//!    lead's HEAD, under the app's own name. The copy goes as soon as the commit is made, whatever happened.
//! 3. The commit is kept by a ref of the app's own, `refs/manut/helpers/<job>/<folder>`, as Rewind keeps its snapshots under
//!    `refs/manut/snapshots/` (`turn_files.rs`): a ref outside `refs/heads` and `refs/tags` is on no branch the developer
//!    sees, and `git gc` keeps what it names. Landing (102g) reads the helper's change from it.
//! 4. The helper lane is a new worktree on a new branch at that commit, made where its lead's folder is, with its record
//!    beside the lead's: the branch named from the lead's (`kit/promptpay-qr` has `kit/promptpay-qr-help-1`, `-help-2` …), its
//!    base the lead's branch, its `at` the snapshot's commit, and the record naming its job, its lead and its ref.
//!
//! What is never touched: the lead's index (only its copy is written), HEAD, branch, stash and files, and the developer's
//! folder. git writes the snapshot's objects into the repository's shared object store, as any `git add` would, and nothing
//! else of the lead's.
//!
//! What comes along: what `git add -A` takes. Nothing git ignores (installed dependencies, build output, a `.env`) is copied,
//! as for any lane. The project's agent settings that git does not hold come from the developer's own folder (`lane_config.rs`,
//! as for any lane), never from the lead's, whose agent may have written its own "always allow" there: a helper lane is never
//! broader than any lane of the project (R3).
//!
//! Nothing is half made: a step that fails takes back what this call made (the folder, the branch, the ref, the record), and
//! the answer says why. git runs as for a lane the person starts (`lane::Git::new`): the person's press of Start helpers
//! named each helper lane, so the repository's own settings apply, as `git add` in a terminal would, hooks and the file
//! monitor aside. Only the snapshot's commit names the app as its author; the lead's branch never gets it.

use std::fs;
use std::io;
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use crate::git_branch;
use crate::lane::{self, Git, HelperOf, Made, Record};
use crate::lane_config;
use crate::tasks;

/// The longest a job's id is. The page's are `j` and ten letters or digits (`startJob`, item 102a).
const JOB_MAX: usize = 40;
/// Where every snapshot ref lives: under the app's own refs, beside Rewind's.
pub(crate) const REFS: &str = "refs/manut/helpers/";
/// The name the snapshot's commit is made under, so no person's identity is needed and none is borrowed.
const IDENTITY: [(&str, &str); 4] =
    [("GIT_AUTHOR_NAME", "Manut AI"), ("GIT_AUTHOR_EMAIL", "manut@localhost"), ("GIT_COMMITTER_NAME", "Manut AI"), ("GIT_COMMITTER_EMAIL", "manut@localhost")];

/// Whether `job` is a job's id as the page makes it: one lower case word or number run, with single hyphens, at most
/// [`JOB_MAX`] characters. So it is never a path, an option or anything but one plain part of a ref.
pub fn valid_job(job: &str) -> bool {
    job.len() <= JOB_MAX && lane::word_ok(job)
}

/// The names a helper lane of the lead on `lead_branch` tries, in order: `<lead>-help-1` to `<lead>-help-20`, with the lead's
/// words cut (at a hyphen's end) where the whole would be longer than a lane's name may be. Each is a name Kit makes
/// ([`lane::valid_name`]), under the lead's own prefix.
pub(crate) fn helper_names(lead_branch: &str) -> Vec<String> {
    let prefix = lane::prefix_of(lead_branch);
    let words = &lead_branch[prefix.len()..];
    (1..=lane::NAMES_MAX)
        .filter_map(|n| {
            let suffix = format!("-help-{n}");
            let room = lane::NAME_MAX.saturating_sub(prefix.len() + suffix.len());
            // the words are ASCII (a valid name's), so a cut by bytes is a cut by letters
            let cut = words.get(..words.len().min(room))?.trim_end_matches('-');
            let name = format!("{prefix}{cut}{suffix}");
            lane::valid_name(&name).then_some(name)
        })
        .collect()
}

/// The ref that keeps the snapshot of the helper lane in folder `folder` of job `job`.
pub(crate) fn snapshot_ref(job: &str, folder: &str) -> String {
    format!("{REFS}{job}/{folder}")
}

/// Whether `id` is a full object id as git prints one (SHA-1 or SHA-256).
fn full_id(id: &str) -> bool {
    id.len() >= 40 && id.bytes().all(|b| b.is_ascii_hexdigit())
}

/// Takes the ref `name` away when it still names `at`, and only a ref under [`REFS`]: a helper lane's snapshot, when its record
/// goes (`lane::remove`) or a step after it failed. A ref moved since is someone else's doing and stays.
pub(crate) fn drop_ref(git: &Git, cwd: &Path, name: &str, at: &str) {
    if name.starts_with(REFS) && lane::safe_rev(name) && full_id(at) {
        let _ = git.run(cwd, &["update-ref", "-d", name, at]);
    }
}

/// A temporary index file of this module's own: taken away, with the lock file git keeps beside it, when it goes, whatever
/// happened.
struct TempIndex(PathBuf);

impl Drop for TempIndex {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
        let _ = fs::remove_file(PathBuf::from(format!("{}.lock", self.0.display())));
    }
}

/// A name no other temporary index of this process has, now or earlier: two snapshots taken at once never share a file.
fn fresh_name() -> String {
    static N: AtomicU64 = AtomicU64::new(0);
    let nanos = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    format!("index-{}-{}-{nanos}", std::process::id(), N.fetch_add(1, Ordering::Relaxed))
}

/// Copies the file `from` to the new file `to`, readable by this account only from the moment it exists. A file or link
/// already at `to` is never written through.
fn copy_private(from: &Path, to: &Path) -> io::Result<()> {
    let mut src = fs::File::open(from)?;
    let mut o = fs::OpenOptions::new();
    o.write(true).create_new(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut o, 0o600);
    let mut dst = o.open(to)?;
    io::copy(&mut src, &mut dst).map(|_| ())
}

/// The snapshot of the lead lane's folder `lwt` (its worktree's top) as a commit on top of `head`, its HEAD's commit: see the
/// module's own words. Err is git's own last line, or what could not be done.
fn snapshot(git: &Git, home: &Path, lwt: &Path, head: &str, message: &str) -> Result<String, String> {
    let index = git.line(lwt, &["rev-parse", "--git-path", "index"]).filter(|l| !l.is_empty()).ok_or("git could not name the lane's index")?;
    let index = lane::from_cwd(lwt, &index);
    let dir = home.join(".manut").join("helper-index");
    lane::own_dir(&home.join(".manut"))?;
    lane::own_dir(&dir)?;
    let tmp = TempIndex(dir.join(fresh_name()));
    let tmp_s = tmp.0.to_string_lossy().into_owned();
    // a split index is written whole into the copy, so nothing of it is written beside the lead's own
    let env = [("GIT_INDEX_FILE", tmp_s.as_str()), ("GIT_LITERAL_PATHSPECS", "1")];
    let checked = |ran: Result<tasks::Ran, String>| -> Result<String, String> {
        let ran = ran?;
        if ran.code == Some(0) {
            Ok(ran.out.lines().next().unwrap_or("").trim().to_string())
        } else {
            Err(tasks::error_line(&ran.err))
        }
    };
    match fs::symlink_metadata(&index) {
        Ok(m) if m.is_file() => copy_private(&index, &tmp.0).map_err(|e| e.to_string())?,
        Ok(_) => return Err("the lane's index is not a file".into()),
        Err(e) if e.kind() == io::ErrorKind::NotFound => {
            checked(git.run_with(lwt, &["-c", "core.splitIndex=false", "read-tree", head], tasks::TIMEOUT, &env))?;
        }
        Err(e) => return Err(e.to_string()),
    }
    // a file it has to read for the first time is hashed, which takes longer than a read on a large project
    checked(git.run_with(lwt, &["-c", "core.splitIndex=false", "add", "-A", "--", "."], lane::SLOW, &env))?;
    let tree = checked(git.run_with(lwt, &["-c", "core.splitIndex=false", "write-tree"], tasks::TIMEOUT, &env))?;
    if !full_id(&tree) {
        return Err("git printed no tree".into());
    }
    // the app's own name, and never a signature (`--no-gpg-sign`): a signing program could wait for a passphrase
    let commit = checked(git.run_with(lwt, &["commit-tree", &tree, "-p", head, "--no-gpg-sign", "-m", message], tasks::TIMEOUT, &IDENTITY))?;
    if !full_id(&commit) {
        return Err("git printed no commit".into());
    }
    Ok(commit)
}

/// Takes back what one try made of the helper lane in folder `wt` on branch `name` at the snapshot's commit `at`: the folder
/// when git lists it as a worktree (made by this call: nothing was there when its name was claimed), and the branch while it
/// is at `at` (only this call made a branch at a commit it made a moment ago). A folder git does not list is someone else's
/// and stays. False when a folder of this call's could not be removed: it then stays, with its record, as a folder kept.
fn take_back(git: &Git, lwt: &Path, wt: &Path, name: &str, at: &str) -> bool {
    let listed = git.common_dir(lwt).and_then(|r| git.worktrees(&r)).is_some_and(|l| l.contains(&lane::real(wt)));
    if listed && fs::symlink_metadata(wt).is_ok() {
        // `--force` skips git's own check that the folder is clean, which would run `git status` in it: this folder holds
        // nothing but the snapshot it was checked out from a moment ago
        let wt_s = wt.to_string_lossy().into_owned();
        let gone = git.run_for(lwt, &["worktree", "remove", "--force", &wt_s], lane::SLOW).map(|r| r.code == Some(0)).unwrap_or(false);
        if !gone {
            return false;
        }
    }
    let branch_ref = format!("refs/heads/{name}");
    if git.line(lwt, &["rev-parse", "--verify", "--quiet", &branch_ref]).as_deref() == Some(at) {
        let _ = git.run(lwt, &["branch", "-D", name]);
    }
    true
}

/// The project's agent settings that git does not hold, brought into the helper lane `wt` from the developer's own folder the
/// lead was made from (`rec.project`), as for any lane. None come when that folder is gone or is no longer the recorded
/// repository's.
fn bring_settings(git: &Git, rec: &Record, wt: &Path) -> lane_config::Brought {
    let project = Path::new(&rec.project);
    if !project.is_absolute() || !project.is_dir() || git.common_dir(project) != Some(lane::real(Path::new(&rec.repo))) {
        return lane_config::Brought::default();
    }
    let Some(top) = git.line(project, &["rev-parse", "--show-toplevel"]).filter(|t| !t.is_empty()).map(PathBuf::from) else {
        return lane_config::Brought::default();
    };
    lane_config::bring(git, &top, wt, &rec.prefix)
}

/// Makes a helper lane of the lane whose folder is `lead` (its worktree, as the lane's record names it) for job `job`: a
/// snapshot of the lead's folder as it is now, kept under the app's own ref, checked out in a new worktree on the first free
/// branch of [`helper_names`], beside the lead's folder. The answer is a lane's ([`Made`]): `base` is the lead's branch, and
/// `left` is 0 (everything git does not ignore came along).
///
/// Refusals, each a short code the page words, with nothing made: `bad_job`; `not_a_lane` (a folder the app did not make,
/// one git no longer lists as a worktree of its repository, or one git cannot read: no git); `lead_is_helper` (a helper lane
/// asks for no helpers of its own, R4); `busy` (git is partway through a rebase, merge, cherry-pick, revert or bisect in the
/// lead's folder, or its index is locked); `no_commit`; the chosen folder's codes ([`lane::check_lanes_root`]) when the lead
/// was made under one that can no longer be used; `no_folder` and `taken` when every name is; `git_missing`. Anything else is
/// git's own last line, after what was made is taken back.
pub fn make(home: &Path, lead: &str, job: &str) -> Result<Made, String> {
    if !valid_job(job) {
        return Err("bad_job".into());
    }
    let (lwt, lead_rec_path, rec) = lane::own_lane(home, lead)?;
    if rec.helper.is_some() {
        return Err("lead_is_helper".into());
    }
    if rec.prefix.chars().any(char::is_control) || !Path::new(&rec.prefix).components().all(|c| matches!(c, Component::Normal(_))) {
        return Err("not_a_lane".into());
    }
    let git = Git::new(home)?;
    let repo = lane::real(Path::new(&rec.repo));
    // still a worktree of the recorded repository, as git lists it, and never that repository's own folder
    let exists = fs::symlink_metadata(&lwt).map(|m| m.is_dir()).unwrap_or(false);
    let ours = exists && git.common_dir(&lwt).as_ref() == Some(&repo) && git.worktrees(&repo).is_some_and(|l| l.contains(&lane::real(&lwt)) && l.first() != Some(&lane::real(&lwt)));
    if !ours {
        return Err("not_a_lane".into());
    }
    if git.busy(&lwt) {
        return Err("busy".into());
    }
    let Some(head) = git.line(&lwt, &["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]).filter(|l| full_id(l)) else {
        return Err("no_commit".into());
    };
    // where the helper lane goes: beside its lead's folder, with its record beside the lead's. A lead made under a folder the
    // person chose has that folder checked again, as each new lane's is
    let parent = lwt.parent().ok_or("not_a_lane")?.to_path_buf();
    let record_parent = lead_rec_path.parent().ok_or("not_a_lane")?.to_path_buf();
    if parent != record_parent {
        let root = parent.parent().ok_or("not_a_lane")?;
        if lane::check_lanes_root(home, &root.to_string_lossy())? != root {
            return Err("bad_root".into());
        }
    }
    let names = helper_names(&rec.branch);
    let prefix_name = lane::prefix_of(&rec.branch);
    // the snapshot is taken before the turn below, as a lane's fetch is: it can take a while, and writes nothing a lane's
    // making or removing reads
    let message = format!("Manut AI: {} as it was, for a helper lane of job {job}", rec.branch);
    let at = snapshot(&git, home, &lwt, &head, &message)?;

    let _turn = lane::WRITING.lock().unwrap_or_else(|e| e.into_inner());
    let exists = git.taken(&lwt, prefix_name)?;
    for d in [home.join(".manut"), lane::lanes_dir(home), record_parent.clone(), parent.clone()] {
        lane::own_dir(&d)?;
    }
    for name in names.iter().filter(|n| !exists.contains(&n.to_lowercase())) {
        let words = &name[prefix_name.len()..];
        let Some((wt, rec_path)) = lane::claim(&parent, &record_parent, words, |folder, wt_s| Record {
            v: 1,
            worktree: wt_s,
            repo: rec.repo.clone(),
            project: rec.project.clone(),
            prefix: rec.prefix.clone(),
            branch: name.clone(),
            base: rec.branch.clone(),
            at: at.clone(),
            made: lane::now_secs(),
            helper: Some(HelperOf { job: job.to_string(), lead: rec.worktree.clone(), snapshot: snapshot_ref(job, folder) }),
        }) else {
            return Err("no_folder".into());
        };
        let folder = wt.file_name().map(|f| f.to_string_lossy().into_owned()).unwrap_or_default();
        let snap = snapshot_ref(job, &folder);
        // the snapshot's own ref, made only where there is none (an empty old value), so two helper lanes never share one
        let made_ref = git.run(&lwt, &["update-ref", &snap, &at, ""]);
        if !matches!(&made_ref, Ok(r) if r.code == Some(0)) {
            let _ = fs::remove_file(&rec_path);
            let err = match made_ref {
                Ok(r) => tasks::error_line(&r.err),
                Err(e) => e,
            };
            // a ref of that name left from an earlier helper lane: the next name is tried
            if err.contains("already exists") {
                continue;
            }
            return Err(err);
        }
        #[cfg(test)]
        lane::between::at("helper-ref", &wt);
        let wt_s = wt.to_string_lossy().into_owned();
        let ran = git.run_for(&lwt, &["worktree", "add", "--no-track", "-b", name, &wt_s, &at], lane::SLOW);
        #[cfg(test)]
        lane::between::at("helper-added", &wt);
        // as for a lane: what matters is whether the folder is there, on its branch at the snapshot
        if git_branch::branch(&wt) == *name && git.line(&wt, &["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]).as_deref() == Some(at.as_str()) {
            let inner = wt.join(&rec.prefix);
            let dir = if rec.prefix.is_empty() || !inner.is_dir() { wt.clone() } else { inner };
            let brought = bring_settings(&git, &rec, &wt);
            return Ok(Made { branch: name.clone(), base: rec.branch.clone(), dir: dir.to_string_lossy().into_owned(), worktree: wt_s, left: 0, from: String::new(), local: String::new(), config: brought.files, stayed: brought.stayed });
        }
        let err = match &ran {
            Ok(r) if r.code == Some(0) => "the helper lane's folder is not on its branch".to_string(),
            Ok(r) => tasks::error_line(&r.err),
            Err(e) => e.clone(),
        };
        // git makes the branch before it finds the folder taken: that branch is this call's, and goes too
        if !take_back(&git, &lwt, &wt, name, &at) {
            return Err(err);
        }
        drop_ref(&git, &lwt, &snap, &at);
        let _ = fs::remove_file(&rec_path);
        // another process made the branch or the folder first: the next name is tried, and what it made stays its own
        if err.contains("already exists") {
            continue;
        }
        return Err(err);
    }
    Err("taken".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::lane::tests::{commit_in, names, repo, sh};
    use crate::lane::{RemoveAsk, Start};
    use std::collections::BTreeMap;

    /// A home folder, the test repository in it, and a lane `kit/promptpay-qr` made from it: the lead.
    fn lead(name: &str) -> Option<(PathBuf, PathBuf, PathBuf)> {
        let (home, d) = repo(name)?;
        let made = lane::make(&home, &d, &names(&["kit/promptpay-qr"])).unwrap();
        Some((home, d, PathBuf::from(made.worktree)))
    }

    fn s(p: &Path) -> String {
        p.to_string_lossy().into_owned()
    }

    fn text(dir: &Path, rel: &str) -> String {
        fs::read_to_string(dir.join(rel)).unwrap_or_else(|e| panic!("{rel}: {e}"))
    }

    /// Every file under `dir`, ignored ones and a worktree's own `.git` file included, with its bytes. A repository's `.git`
    /// folder is left out: the objects and refs a helper lane needs are written there, as for any lane.
    fn files(dir: &Path) -> BTreeMap<String, Vec<u8>> {
        fn walk(top: &Path, dir: &Path, out: &mut BTreeMap<String, Vec<u8>>) {
            for e in fs::read_dir(dir).unwrap().flatten() {
                let p = e.path();
                if e.file_type().unwrap().is_dir() && e.file_name() == ".git" {
                    continue;
                }
                if e.file_type().unwrap().is_dir() {
                    walk(top, &p, out);
                } else {
                    out.insert(p.strip_prefix(top).unwrap().to_string_lossy().into_owned(), fs::read(&p).unwrap());
                }
            }
        }
        let mut out = BTreeMap::new();
        walk(dir, dir, &mut out);
        out
    }

    /// What the slice's safety test compares in a folder git works in: its index file's bytes (read first, before any git
    /// runs), what `git status --porcelain` says (with no optional lock, so the read itself never writes the index), HEAD and
    /// its commit, the stash list, and every file's bytes.
    #[derive(Debug, PartialEq)]
    struct Seen {
        index: Vec<u8>,
        status: String,
        head: String,
        commit: String,
        stash: String,
        files: BTreeMap<String, Vec<u8>>,
    }

    fn seen(dir: &Path) -> Seen {
        let index = lane::from_cwd(dir, &sh(dir, &["rev-parse", "--git-path", "index"]));
        let bytes = fs::read(&index).unwrap();
        let got = Seen {
            index: bytes.clone(),
            status: sh(dir, &["--no-optional-locks", "status", "--porcelain", "--untracked-files=all"]),
            head: sh(dir, &["symbolic-ref", "HEAD"]),
            commit: sh(dir, &["rev-parse", "HEAD"]),
            stash: sh(dir, &["stash", "list"]),
            files: files(dir),
        };
        assert_eq!(fs::read(&index).unwrap(), bytes, "reading the folder changed its index");
        got
    }

    /// `now` against `was`, field by field, so a failure names what changed (a file by its path) rather than printing both.
    fn same(now: &Seen, was: &Seen, what: &str) {
        assert!(now.index == was.index, "{what}: the index file's bytes changed");
        assert_eq!((&now.status, &now.head, &now.commit, &now.stash), (&was.status, &was.head, &was.commit, &was.stash), "{what}");
        let changed: Vec<&String> = now.files.keys().chain(was.files.keys()).filter(|k| now.files.get(*k) != was.files.get(*k)).collect();
        assert!(changed.is_empty(), "{what}: files changed: {changed:?}");
    }

    /// The helper lanes' branches and the app's snapshot refs in the repository at `d`.
    fn helpers_and_refs(d: &Path) -> (String, String) {
        (sh(d, &["branch", "--list", "--format=%(refname:short)", "kit/*-help-*"]), sh(d, &["for-each-ref", "--format=%(refname)", "refs/manut/"]))
    }

    fn worktrees(d: &Path) -> usize {
        sh(d, &["worktree", "list", "--porcelain"]).lines().filter(|l| l.starts_with("worktree ")).count()
    }

    #[test]
    fn a_job_is_one_plain_word_and_names_come_from_the_lead_s_branch() {
        for ok in ["jabcde23fgh", "j1", "job-7"] {
            assert!(valid_job(ok), "{ok}");
        }
        let long = "j".repeat(41);
        for bad in ["", "J1", "j 1", "../x", "a/b", "-x", "x-", "a--b", "j.lock", "j\n", long.as_str()] {
            assert!(!valid_job(bad), "{bad:?}");
        }
        let got = helper_names("kit/promptpay-qr");
        assert_eq!((got.len(), got[0].as_str(), got[1].as_str(), got[19].as_str()), (20, "kit/promptpay-qr-help-1", "kit/promptpay-qr-help-2", "kit/promptpay-qr-help-20"));
        assert_eq!(helper_names("team/ana/fix-login")[0], "team/ana/fix-login-help-1");
        // a lead's name at the longest a name may be: its words are cut, never at a hyphen's end, and every name is one Kit makes
        let longest = format!("kit/{}-b", "a".repeat(lane::NAME_MAX - 6));
        assert!(lane::valid_name(&longest));
        let cut = helper_names(&longest);
        assert_eq!(cut.len(), 20);
        assert!(cut.iter().all(|n| lane::valid_name(n) && n.len() <= lane::NAME_MAX && n.starts_with("kit/aaaa")), "{cut:?}");
        assert_eq!(snapshot_ref("jx", "promptpay-qr-help-1"), "refs/manut/helpers/jx/promptpay-qr-help-1");
    }

    /// The slice's safety test (docs/several-agents.md, 102f): the lead's `git status --porcelain`, its index file's bytes,
    /// HEAD and stash list are identical before and after, every file of its folder too, and ignored files are not copied.
    #[test]
    fn a_helper_lane_starts_from_the_lead_s_folder_as_it_is_and_the_lead_is_left_byte_for_byte() {
        let Some((home, d, lwt)) = lead("hs-safe") else { return };
        // the lead's own work: a commit, a stash, a staged change changed again since, a change, a deletion, new files in a
        // new folder, and what git ignores (by the committed `.gitignore` and by the repository's own exclude file)
        commit_in(&lwt, "c.txt", "three\n");
        fs::write(lwt.join("c.txt"), "three\nstashed\n").unwrap();
        sh(&lwt, &["stash", "-q"]);
        fs::write(lwt.join("apps/web/b.txt"), "two\nstaged\n").unwrap();
        sh(&lwt, &["add", "apps/web/b.txt"]);
        fs::write(lwt.join("apps/web/b.txt"), "two\nstaged\nchanged again\n").unwrap();
        fs::write(lwt.join("a.txt"), "one\nmine\n").unwrap();
        fs::remove_file(lwt.join("c.txt")).unwrap();
        fs::write(lwt.join("new.txt"), "new\n").unwrap();
        fs::create_dir_all(lwt.join("notes")).unwrap();
        fs::write(lwt.join("notes/todo.md"), "todo\n").unwrap();
        fs::create_dir_all(lwt.join("node_modules/qrcode")).unwrap();
        fs::write(lwt.join("node_modules/qrcode/index.js"), "x\n").unwrap();
        let exclude = lane::from_cwd(&lwt, &sh(&lwt, &["rev-parse", "--git-path", "info/exclude"]));
        fs::create_dir_all(exclude.parent().unwrap()).unwrap();
        fs::write(&exclude, ".env.local\n").unwrap();
        fs::write(lwt.join(".env.local"), "TOKEN=made-up-for-the-test\n").unwrap();
        let developer = seen(&d);
        let before = seen(&lwt);
        // the lead's own git folder too (`.git/worktrees/promptpay-qr`: its HEAD, index, reflog and the rest)
        let lead_git = PathBuf::from(sh(&lwt, &["rev-parse", "--absolute-git-dir"]));
        let lead_git_before = files(&lead_git);
        assert!(before.status.contains("MM apps/web/b.txt") && before.status.contains("?? new.txt") && before.status.contains(" D c.txt"), "{}", before.status);
        assert!(!before.stash.is_empty());

        let made = make(&home, &s(&lwt), "jsafe").unwrap();

        // the lead and the developer's folder: every byte as it was
        same(&seen(&lwt), &before, "the lead");
        same(&seen(&d), &developer, "the developer's folder");
        assert!(files(&lead_git) == lead_git_before, "the lead's own git folder changed");
        let hwt = home.join(".manut/lanes/web-app/promptpay-qr-help-1");
        assert_eq!(
            made,
            Made { branch: "kit/promptpay-qr-help-1".into(), base: "kit/promptpay-qr".into(), dir: s(&hwt), worktree: s(&hwt), left: 0, from: String::new(), local: String::new(), config: 0, stayed: 0 }
        );
        // the helper lane: the lead's folder as it was on disk, staged or not, its new files, and nothing git ignores
        assert_eq!(text(&hwt, "a.txt"), "one\nmine\n");
        assert_eq!(text(&hwt, "apps/web/b.txt"), "two\nstaged\nchanged again\n");
        assert_eq!((text(&hwt, "new.txt"), text(&hwt, "notes/todo.md")), ("new\n".to_string(), "todo\n".to_string()));
        assert!(!hwt.join("c.txt").exists(), "a file the lead deleted is not there");
        assert!(!hwt.join("node_modules").exists() && !hwt.join(".env.local").exists(), "an ignored file came along");
        assert_eq!(sh(&hwt, &["status", "--porcelain", "--untracked-files=all"]), "");
        // on its own branch at the snapshot, a commit on top of the lead's HEAD, kept under the app's own ref
        let snap = sh(&d, &["rev-parse", "refs/manut/helpers/jsafe/promptpay-qr-help-1"]);
        assert_eq!(sh(&hwt, &["rev-parse", "HEAD"]), snap);
        assert_eq!(sh(&d, &["rev-parse", "kit/promptpay-qr-help-1"]), snap);
        assert_eq!(sh(&d, &["rev-parse", &format!("{snap}^")]), before.commit);
        assert_eq!(sh(&d, &["log", "-1", "--format=%an <%ae>", &snap]), "Manut AI <manut@localhost>");
        assert_eq!(git_branch::branch(&hwt), "kit/promptpay-qr-help-1");
        // its record names the job and the lead; its base is the lead's branch, its start the snapshot
        let (_, rec_path, rec) = lane::own_lane(&home, &made.worktree).unwrap();
        assert_eq!(rec_path, home.join(".manut/lanes/web-app/promptpay-qr-help-1.json"));
        assert_eq!((rec.base.as_str(), rec.at.as_str(), rec.prefix.as_str(), rec.project.as_str()), ("kit/promptpay-qr", snap.as_str(), "", s(&d).as_str()));
        assert_eq!(rec.helper, Some(HelperOf { job: "jsafe".into(), lead: s(&lwt), snapshot: "refs/manut/helpers/jsafe/promptpay-qr-help-1".into() }));
        // no temporary index is left
        assert_eq!(fs::read_dir(home.join(".manut/helper-index")).unwrap().count(), 0);
        // what reads a lane reads this one from its snapshot: nothing changed yet, and no commits of its own
        assert!(crate::lane_diff::read(&home, &made.worktree).unwrap().files.is_empty());
        let listed = lane::list(&home, &d).unwrap();
        let mine = listed.iter().find(|k| k.worktree == made.worktree).unwrap();
        assert_eq!((mine.changed, mine.ahead, mine.base.as_str()), (Some(0), Some(0), "kit/promptpay-qr"));
        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn two_snapshots_of_one_lead_never_collide() {
        let Some((home, d, lwt)) = lead("hs-two") else { return };
        fs::write(lwt.join("a.txt"), "first\n").unwrap();
        let one = make(&home, &s(&lwt), "jtwo").unwrap();
        fs::write(lwt.join("a.txt"), "second\n").unwrap();
        let two = make(&home, &s(&lwt), "jtwo").unwrap();
        assert_eq!((one.branch.as_str(), two.branch.as_str()), ("kit/promptpay-qr-help-1", "kit/promptpay-qr-help-2"));
        assert_eq!((text(Path::new(&one.dir), "a.txt"), text(Path::new(&two.dir), "a.txt")), ("first\n".to_string(), "second\n".to_string()));
        let refs = sh(&d, &["for-each-ref", "--format=%(refname) %(objectname)", "refs/manut/helpers/jtwo/"]);
        let refs: Vec<(&str, &str)> = refs.lines().filter_map(|l| l.split_once(' ')).collect();
        assert_eq!(refs.iter().map(|r| r.0).collect::<Vec<_>>(), ["refs/manut/helpers/jtwo/promptpay-qr-help-1", "refs/manut/helpers/jtwo/promptpay-qr-help-2"]);
        assert_ne!(refs[0].1, refs[1].1);
        assert_eq!((sh(&d, &["rev-parse", &one.branch]), sh(&d, &["rev-parse", &two.branch])), (refs[0].1.to_string(), refs[1].1.to_string()));

        // two at once of a lead that did not change: the same tree, often in the same second, so the same commit; each still
        // gets its own branch, folder and ref
        let (h1, l1, h2, l2) = (home.clone(), s(&lwt), home.clone(), s(&lwt));
        let a = std::thread::spawn(move || make(&h1, &l1, "jboth"));
        let b = std::thread::spawn(move || make(&h2, &l2, "jboth"));
        let (a, b) = (a.join().unwrap().unwrap(), b.join().unwrap().unwrap());
        let mut both = [a.branch.clone(), b.branch.clone()];
        both.sort();
        assert_eq!(both, ["kit/promptpay-qr-help-3", "kit/promptpay-qr-help-4"]);
        assert_ne!(a.worktree, b.worktree);
        assert_eq!(sh(&d, &["for-each-ref", "--format=%(refname)", "refs/manut/helpers/jboth/"]).lines().count(), 2);
        // each works on its own files: nothing written in one shows in another, or in the lead
        fs::write(Path::new(&a.dir).join("a.txt"), "a's\n").unwrap();
        assert_eq!((text(Path::new(&b.dir), "a.txt"), text(&lwt, "a.txt"), text(Path::new(&two.dir), "a.txt")), ("second\n".into(), "second\n".into(), "second\n".into()));
        assert_eq!(worktrees(&d), 6);
        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn a_step_that_fails_midway_leaves_nothing_behind_and_the_lead_as_it_was() {
        let Some((home, d, lwt)) = lead("hs-fail") else { return };
        fs::write(lwt.join("a.txt"), "mine\n").unwrap();
        fs::write(lwt.join("new.txt"), "new\n").unwrap();
        let before = seen(&lwt);
        let common = lane::from_cwd(&d, &sh(&d, &["rev-parse", "--git-common-dir"]));
        let nothing = |what: &str, refs: &str| {
            assert_eq!(helpers_and_refs(&d), (String::new(), refs.to_string()), "{what}");
            assert!(!home.join(".manut/lanes/web-app/promptpay-qr-help-1").exists() && !home.join(".manut/lanes/web-app/promptpay-qr-help-1.json").exists(), "{what}");
            assert_eq!(lane::records(&home).len(), 1, "{what}");
            assert_eq!(worktrees(&d), 2, "{what}");
            assert_eq!(fs::read_dir(home.join(".manut/helper-index")).map(|r| r.count()).unwrap_or(0), 0, "{what}");
            same(&seen(&lwt), &before, what);
        };

        // the snapshot's ref cannot be written: a ref already holds the job's own name
        sh(&d, &["update-ref", "refs/manut/helpers/jfail", "HEAD"]);
        let err = make(&home, &s(&lwt), "jfail").unwrap_err();
        assert!(err.contains("exists"), "{err}");
        nothing("the ref", "refs/manut/helpers/jfail");
        sh(&d, &["update-ref", "-d", "refs/manut/helpers/jfail"]);

        // the branch cannot be made: another git holds its lock
        let lock = common.join("refs/heads/kit/promptpay-qr-help-1.lock");
        fs::create_dir_all(lock.parent().unwrap()).unwrap();
        fs::write(&lock, "").unwrap();
        let err = make(&home, &s(&lwt), "jfail").unwrap_err();
        assert!(err.contains("lock"), "{err}");
        nothing("the branch", "");
        fs::remove_file(&lock).unwrap();

        // the folder was made but is not on its branch when git is done: the folder, the branch, the ref and the record go
        lane::between::set(Some(Box::new(|step, wt| {
            if step == "helper-added" {
                sh(wt, &["checkout", "-q", "--detach"]);
            }
        })));
        let got = make(&home, &s(&lwt), "jfail");
        lane::between::set(None);
        assert_eq!(got, Err("the helper lane's folder is not on its branch".to_string()));
        nothing("the folder", "");

        // with nothing in the way, it is made from the lead as it is
        let made = make(&home, &s(&lwt), "jfail").unwrap();
        assert_eq!(made.branch, "kit/promptpay-qr-help-1");
        assert_eq!((text(Path::new(&made.dir), "a.txt"), text(Path::new(&made.dir), "new.txt")), ("mine\n".to_string(), "new\n".to_string()));
        same(&seen(&lwt), &before, "after");
        let _ = fs::remove_dir_all(home);
    }

    /// A folder planted where the helper lane's folder goes, after its name was claimed (another process): git makes the
    /// branch before it finds the folder there, so that branch goes again, the folder stays its own, and the next name is used.
    #[test]
    fn a_folder_that_appears_in_the_way_is_left_alone_and_the_next_name_is_used() {
        let Some((home, d, lwt)) = lead("hs-race") else { return };
        lane::between::set(Some(Box::new(|step, wt| {
            if step == "helper-ref" && wt.ends_with("promptpay-qr-help-1") {
                fs::create_dir_all(wt).unwrap();
                fs::write(wt.join("theirs.txt"), "theirs\n").unwrap();
            }
        })));
        let got = make(&home, &s(&lwt), "jrace");
        lane::between::set(None);
        let made = got.unwrap();
        assert_eq!(made.branch, "kit/promptpay-qr-help-2");
        assert_eq!(text(&home.join(".manut/lanes/web-app/promptpay-qr-help-1"), "theirs.txt"), "theirs\n");
        assert_eq!(helpers_and_refs(&d), ("kit/promptpay-qr-help-2".to_string(), "refs/manut/helpers/jrace/promptpay-qr-help-2".to_string()));
        assert!(!home.join(".manut/lanes/web-app/promptpay-qr-help-1.json").exists());
        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn refuses_a_lead_it_did_not_make_cannot_read_or_that_is_busy_and_makes_nothing() {
        let Some((home, d, lwt)) = lead("hs-refuse") else { return };
        for bad in ["", "J1", "../x", "a/b", "-x"] {
            assert_eq!(make(&home, &s(&lwt), bad), Err("bad_job".into()), "{bad:?}");
        }
        // not a lane the app made: the developer's own folder, a folder inside the lane, a relative path, any other folder
        for not in [s(&d), s(&lwt.join("apps/web")), "relative/x".to_string(), s(&home)] {
            assert_eq!(make(&home, &not, "jok"), Err("not_a_lane".into()), "{not}");
        }
        // the lead in the middle of something of its own
        let git_dir = PathBuf::from(sh(&lwt, &["rev-parse", "--absolute-git-dir"]));
        for marker in ["MERGE_HEAD", "rebase-merge", "index.lock"] {
            fs::write(git_dir.join(marker), "x").unwrap();
            assert_eq!(make(&home, &s(&lwt), "jok"), Err("busy".into()), "{marker}");
            fs::remove_file(git_dir.join(marker)).unwrap();
        }
        // a lead folder git can no longer read (its `.git` gone): no lane is made from it
        fs::rename(lwt.join(".git"), lwt.join(".git-away")).unwrap();
        assert_eq!(make(&home, &s(&lwt), "jok"), Err("not_a_lane".into()));
        fs::rename(lwt.join(".git-away"), lwt.join(".git")).unwrap();
        assert_eq!(helpers_and_refs(&d), (String::new(), String::new()));
        assert_eq!(lane::records(&home).len(), 1);
        // a helper lane asks for no helpers of its own
        let helper = make(&home, &s(&lwt), "jok").unwrap();
        assert_eq!(make(&home, &helper.worktree, "jok"), Err("lead_is_helper".into()));
        assert_eq!(helpers_and_refs(&d).0, "kit/promptpay-qr-help-1");
        let _ = fs::remove_dir_all(home);
    }

    /// Where the helper lane goes and what comes with it: beside its lead (under the folder the person chose for lanes, with the
    /// record in the app's own folder), in the same folder inside the worktree as its lead, and with the project's agent
    /// settings from the developer's folder, never the lead's own copy, which its agent may have widened.
    #[test]
    fn a_helper_lane_is_made_where_its_lead_is_and_brings_the_developer_s_agent_settings_not_the_lead_s() {
        let Some((home, d)) = repo("hs-where") else { return };
        let mine = "{\"permissions\":{\"allow\":[]}}\n";
        fs::create_dir_all(d.join(".claude")).unwrap();
        fs::write(d.join(".claude/settings.local.json"), mine).unwrap();
        let root = home.join("work/lanes");
        let start = Start { root: s(&root), ..Start::default() };
        let lead = lane::make_with(&home, &d.join("apps/web"), &names(&["kit/web"]), &start).unwrap();
        let lwt = PathBuf::from(&lead.worktree);
        assert_eq!(text(&lwt, ".claude/settings.local.json"), mine);
        // the lead's agent said "always allow" in its own copy
        fs::write(lwt.join(".claude/settings.local.json"), "{\"permissions\":{\"allow\":[\"Bash(*)\"]}}\n").unwrap();
        fs::write(lwt.join("apps/web/b.txt"), "two\nlead's\n").unwrap();

        let made = make(&home, &lead.worktree, "jwhere").unwrap();
        let hwt = root.canonicalize().unwrap().join("web-app/web-help-1");
        assert_eq!((made.worktree.as_str(), made.dir.as_str()), (s(&hwt).as_str(), s(&hwt.join("apps/web")).as_str()));
        assert!(lane::lanes_dir(&home).join("web-app/web-help-1.json").is_file() && !hwt.with_extension("json").exists());
        assert_eq!(text(Path::new(&made.dir), "b.txt"), "two\nlead's\n");
        assert_eq!(text(&hwt, ".claude/settings.local.json"), mine);
        assert!(made.config >= 1);
        assert_eq!(sh(&hwt, &["status", "--porcelain", "--untracked-files=all"]), "");
        // the folder chosen has become a checkout since: no helper lane is made there, and none anywhere else
        sh(&home.join("work"), &["init", "-q"]);
        assert_eq!(make(&home, &lead.worktree, "jwhere"), Err("root_in_checkout".into()));
        assert_eq!(helpers_and_refs(&d), ("kit/web-help-1".to_string(), "refs/manut/helpers/jwhere/web-help-1".to_string()));
        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn a_helper_lane_is_listed_and_removed_as_a_lane_and_its_snapshot_goes_with_its_record() {
        let Some((home, d, lwt)) = lead("hs-remove") else { return };
        fs::write(lwt.join("a.txt"), "lead's\n").unwrap();
        let helper = make(&home, &s(&lwt), "jrm").unwrap();
        commit_in(Path::new(&helper.dir), "h.txt", "h\n");
        let listed = lane::list(&home, &d).unwrap();
        assert_eq!(listed.iter().find(|k| k.worktree == helper.worktree).unwrap().ahead, Some(1));
        let gone = lane::remove(&home, &helper.worktree, &RemoveAsk::default()).unwrap();
        assert!(gone.removed && !Path::new(&helper.worktree).exists());
        // the branch stays unless the person asked, as for any lane; the snapshot's ref goes with the record
        assert_eq!(helpers_and_refs(&d), ("kit/promptpay-qr-help-1".to_string(), String::new()));
        assert!(lane::own_lane(&home, &s(&lwt)).is_ok() && text(&lwt, "a.txt") == "lead's\n");
        let _ = fs::remove_dir_all(home);
    }
}
