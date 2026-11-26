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
/// `MAX_FILES`.
#[derive(Serialize, Debug, PartialEq)]
pub struct LaneDiff {
    pub start: String,
    pub files: Vec<LaneFile>,
    pub more_files: u32,
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

/// Every file that differs from `start`: what git's own diff says about tracked files (renames paired), then the new files git
/// does not ignore.
fn entries(git: &Git, wt: &Path, start: &str) -> Result<Vec<Entry>, String> {
    // a submodule is not one of the lane's files, and comparing one would run git inside it (`SUBMODULES`)
    let mut argv: Vec<&str> = vec!["diff", "--name-status", "-z", "-M", "--no-ext-diff", "--no-textconv", "--no-color"];
    argv.extend_from_slice(SUBMODULES);
    argv.push(start);
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
        out.push(Entry { path: path.to_string(), from: from.map(str::to_string), state, untracked: false, mtime: mtime_of(wt, path) });
        if out.len() >= MAX_NAMES {
            break;
        }
    }
    let fresh = git.run_with(wt, &["ls-files", "--others", "--exclude-standard", "-z"], Duration::from_secs(20), ENV)?;
    if fresh.code != Some(0) {
        return Err("unread".into());
    }
    for p in fresh.out.split('\0').filter(|s| !s.is_empty()) {
        // a nested repository is listed as `dir/`: it is not a file of this one
        if p.ends_with('/') || !plain(p) || out.iter().any(|e| e.path == p) {
            continue;
        }
        out.push(Entry { path: p.to_string(), from: None, state: "new", untracked: true, mtime: mtime_of(wt, p) });
        if out.len() >= MAX_NAMES {
            break;
        }
    }
    // the file that changed last first, as the pane has always listed them
    out.sort_by(|a, b| b.mtime.cmp(&a.mtime).then_with(|| a.path.cmp(&b.path)));
    Ok(out)
}

/// The diff text of one entry, or why there is none.
fn diff_of(git: &Git, wt: &Path, start: &str, e: &Entry, left: Duration) -> Result<String, &'static str> {
    if e.state != "deleted" && fs::symlink_metadata(wt.join(&e.path)).map(|m| m.len() > MAX_SOURCE).unwrap_or(false) {
        return Err("too_large");
    }
    let from = e.from.as_deref().unwrap_or("");
    let mut argv: Vec<&str> = vec!["diff", "--no-ext-diff", "--no-textconv", "--no-color"];
    argv.extend_from_slice(SUBMODULES);
    if e.untracked {
        argv.extend(["--no-index", "--", "/dev/null", &e.path]);
    } else if e.from.is_some() {
        argv.extend(["-M", start, "--", from, &e.path]);
    } else {
        argv.extend(["--no-renames", start, "--", &e.path]);
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

/// What changed in the lane's folder `dir` since the lane started. `Err` is a short code: `not_a_lane` (a folder the app did not
/// make, or one git does not list as a worktree of the recorded repository), `git_missing`, `unread`, `config:<setting>` (the
/// repository's own config names a program git would run).
pub fn read(home: &Path, dir: &str) -> Result<LaneDiff, String> {
    let (wt, rec) = own_folder(home, dir)?;
    let git = Git::automatic(home)?;
    let repo = real(Path::new(&rec.repo));
    let exists = fs::symlink_metadata(&wt).map(|m| m.is_dir()).unwrap_or(false);
    let ours = exists && git.common_dir(&wt).as_ref() == Some(&repo) && git.worktrees(&repo).is_some_and(|l| l.contains(&real(&wt)) && l.first() != Some(&real(&wt)));
    if !ours {
        return Err("not_a_lane".into());
    }
    if let Some(setting) = git.config_risk(&wt) {
        return Err(format!("config:{setting}"));
    }
    let begun = Instant::now();
    let start = start_commit(&git, &wt, &rec).ok_or("unread")?;
    let all = entries(&git, &wt, &start)?;
    let more_files = all.len().saturating_sub(MAX_FILES) as u32;
    let mut total = 0usize;
    let mut files = Vec::new();
    for e in all.iter().take(MAX_FILES) {
        let got = match BUDGET.checked_sub(begun.elapsed()) {
            None => Err("left_out"),
            Some(_) if total >= MAX_TOTAL => Err("left_out"),
            Some(left) => diff_of(&git, &wt, &start, e, left).and_then(|t| if total + t.len() > MAX_TOTAL { Err("left_out") } else { Ok(t) }),
        };
        let (diff, note) = match got {
            Ok(t) => {
                total += t.len();
                (t, None)
            }
            Err(n) => (String::new(), Some(n.to_string())),
        };
        files.push(LaneFile { path: e.path.clone(), from: e.from.clone(), state: e.state.to_string(), diff, note });
    }
    Ok(LaneDiff { start: start.chars().take(12).collect(), files, more_files })
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
}
