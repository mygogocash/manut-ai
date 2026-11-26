//! The main branch moving while Kit worked, for the Code page (src/code/moved.ts): which branch a session's folder is
//! on, which branch it started from, where each is, and which files each side changed since the two parted. The page
//! decides what that means.
//!
//! Until now the shell ran no `git` at all: `git_branch.rs` reads `.git/HEAD` as a file and `tasks.rs` runs `gh`.
//! Telling which files changed on both sides needs git's own object store, so this runs the person's own `git`, through
//! the runner Tasks already uses for `gh` (`tasks::run_env`: no shell, nothing on stdin, a time limit, a cap on the
//! output). Every argv here only reads: `symbolic-ref`, `rev-parse`, `merge-base`, `diff` and `ls-files`. Nothing is
//! written, fetched or merged; Kit merges, as a step of its own that asks through its card.
//!
//! What crosses from the page is a folder, optionally a branch name (checked below) and the paths whose diffs it wants
//! (each must be a path both sides changed, so nothing the page invents reaches git). A diff's text passes
//! `mask_secrets` before it leaves this module, as every CLI answer does in `tasks.rs`.
//!
//! A repository's own config can name programs git runs while it reads: a file monitor, an external diff, a text
//! conversion, a clean filter. The first three are switched off on the command line. The note is read by itself whenever the
//! page shows a session, so a repository whose own config names a clean filter, or any other program git would run
//! (`lane::risky_setting`, item 86), or one of whose submodules' own config does (`lane::config_risk_by`, item 90), is not
//! read at all: there is no note, as for a folder that is not a repository. No diff here goes into a submodule (see `DIFF`).

use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::tasks::{error_line, find, mask_secrets, run_env, Ran};

/// The most paths one side lists.
const MAX_NAMES: usize = 20_000;
/// The most files whose diffs one call gives.
const MAX_SHOWN: usize = 20;
/// The most bytes of one side's diff of one file that cross to the page.
const MAX_DIFF: usize = 256 * 1024;

/// One path both sides changed, with what each side did to it, as git prints it (keys masked).
#[derive(Serialize, Debug, PartialEq)]
pub struct Both {
    pub path: String,
    pub theirs: String,
    pub ours: String,
}

/// What git says of one folder. `ours` is what the branch changed since it left `base` (its commits, what is staged,
/// what is changed in the work tree and what is new), `theirs` what `base` changed since. Both are sorted paths from the
/// repository's top folder. `both` holds the two diffs of the paths asked for.
#[derive(Serialize, Debug, PartialEq)]
pub struct MainMoved {
    pub branch: String,
    pub base: String,
    /// Where `base` is now, and where the branch left it: commit ids, equal while `base` has not moved.
    pub tip: String,
    pub fork: String,
    pub ours: Vec<String>,
    pub theirs: Vec<String>,
    pub both: Vec<Both>,
}

/// Set for every call. A read must not take the index lock, or the agent's own `git commit` in the same folder would
/// meet it; a path from a list is a path, never a pathspec (`:(glob)…`, `*`); nothing may ask for a password.
const ENV: &[(&str, &str)] = &[("GIT_OPTIONAL_LOCKS", "0"), ("GIT_LITERAL_PATHSPECS", "1"), ("GIT_TERMINAL_PROMPT", "0"), ("GIT_PAGER", "cat")];

/// Taken out of git's environment, so a variable this app was started with cannot point it at another repository or run a
/// program of its own.
const UNSET: &[&str] = &[
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_INDEX_FILE",
    "GIT_OBJECT_DIRECTORY",
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_COMMON_DIR",
    "GIT_NAMESPACE",
    "GIT_EXTERNAL_DIFF",
    "GIT_DIFF_OPTS",
    "GIT_CONFIG_PARAMETERS",
    "GIT_CONFIG_COUNT",
];

/// The flags of every diff: no external program, no text conversion, no colour, and a rename is a delete and an add, so a
/// file one side moved and the other edited counts as changed on both. A submodule is hidden and, if one reached a diff
/// anyway, drawn as two commit names (item 90): comparing one with the work tree runs `status` inside it, and `diff.submodule`'s
/// `log` and `diff` forms read or diff inside it, each with the submodule's own config, whose clean filter no flag here reaches.
const DIFF: &[&str] = &["diff", "--no-ext-diff", "--no-textconv", "--no-renames", "--ignore-submodules=all", "--submodule=short"];

/// A `diff` call's arguments: the flags every diff has, `extra`, then `tail`.
fn diff_args(extra: &[&str], tail: &[&str]) -> Vec<String> {
    DIFF.iter().chain(extra).chain(tail).map(|s| s.to_string()).collect()
}

fn refs(v: &[String]) -> Vec<&str> {
    v.iter().map(String::as_str).collect()
}

struct Git {
    exe: PathBuf,
    dir: PathBuf,
}

impl Git {
    /// `git -C <dir> <args>`, with the file monitor off and nothing going into a submodule unless a command is told to (see
    /// [`DIFF`]). Err only when git could not run or did not answer in time.
    fn run(&self, args: &[&str]) -> Result<Ran, String> {
        let mut argv: Vec<String> = vec!["-c".into(), "core.fsmonitor=false".into(), "-c".into(), "submodule.recurse=false".into(), "-c".into(), "diff.ignoreSubmodules=all".into(), "-C".into(), self.dir.to_string_lossy().into_owned()];
        argv.extend(args.iter().map(|a| a.to_string()));
        run_env(&self.exe, &argv, true, ENV, UNSET)
    }

    /// The first line git printed, when it succeeded; None for any other ending (a ref that is not there, a HEAD that is
    /// not a branch, no common ancestor). For a question whose answer "no" is a fine one.
    fn line(&self, args: &[&str]) -> Result<Option<String>, String> {
        let r = self.run(args)?;
        if r.code != Some(0) {
            return Ok(None);
        }
        Ok(r.out.lines().next().map(str::to_string).filter(|l| !l.is_empty()))
    }

    /// The paths git listed with `-z`, sorted, once each; an error when it did not succeed.
    fn names(&self, args: &[&str]) -> Result<Vec<String>, String> {
        let r = self.run(args)?;
        if r.code != Some(0) {
            return Err(failed(args, &r));
        }
        let mut v: Vec<String> = r.out.split('\0').filter(|s| !s.is_empty()).take(MAX_NAMES).map(str::to_string).collect();
        v.sort();
        v.dedup();
        Ok(v)
    }

    /// One diff's text, cut and masked; `ok` are the exit codes that mean it ran (`--no-index` ends with 1 when the files
    /// differ).
    fn diff_text(&self, args: &[&str], ok: &[i32]) -> Result<String, String> {
        let r = self.run(args)?;
        match r.code {
            Some(c) if ok.contains(&c) => Ok(mask_secrets(&clip(r.out, MAX_DIFF))),
            _ => Err(failed(args, &r)),
        }
    }
}

fn failed(args: &[&str], r: &Ran) -> String {
    let line = error_line(&r.err);
    format!("git {} failed{}{}", args.first().copied().unwrap_or(""), if line.is_empty() { "" } else { ": " }, line)
}

fn clip(mut t: String, n: usize) -> String {
    if t.len() > n {
        let mut at = n;
        while !t.is_char_boundary(at) {
            at -= 1;
        }
        t.truncate(at);
    }
    t
}

/// Whether `n` can be a branch name (git's own rules, kept strict): it is never an option, a range or a pathspec, and
/// holds no control character or space.
pub fn valid_branch(n: &str) -> bool {
    !n.is_empty()
        && n.len() <= 200
        && n != "@"
        && !n.starts_with(['-', '/', '.'])
        && !n.ends_with(['/', '.'])
        && !n.ends_with(".lock")
        && !n.contains("..")
        && !n.contains("@{")
        && !n.contains("//")
        && !n.contains("/.")
        && !n.chars().any(|c| c.is_control() || c.is_whitespace() || "~^:?*[\\".contains(c))
}

/// A commit id as `rev-parse` prints it: 40 hex characters (64 in a SHA-256 repository).
fn is_commit_id(s: &str) -> bool {
    (s.len() == 40 || s.len() == 64) && s.bytes().all(|b| b.is_ascii_hexdigit())
}

/// The branches to try as the base when the page names none: the one `origin/HEAD` points at, then `main`, then `master`.
fn candidates(git: &Git) -> Result<Vec<String>, String> {
    let mut out: Vec<String> = Vec::new();
    if let Some(r) = git.line(&["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"])? {
        if let Some(n) = r.strip_prefix("refs/remotes/origin/").filter(|n| valid_branch(n)) {
            out.push(n.to_string());
        }
    }
    for n in ["main", "master"] {
        if !out.iter().any(|x| x == n) {
            out.push(n.to_string());
        }
    }
    Ok(out)
}

/// Where branch `name` is: the local branch if there is one, else its copy from `origin`. Always the commit id, so no
/// later argument names a branch.
fn tip_of(git: &Git, name: &str) -> Result<Option<String>, String> {
    for prefix in ["refs/heads/", "refs/remotes/origin/"] {
        let spec = format!("{prefix}{name}^{{commit}}");
        if let Some(id) = git.line(&["rev-parse", "--verify", "--quiet", &spec])? {
            if is_commit_id(&id) {
                return Ok(Some(id));
            }
        }
    }
    Ok(None)
}

/// What git says of the folder `cwd`, or None when there is nothing to say: not a repository (no program runs then), no
/// `git` on this computer, a detached HEAD, no base branch, the base branch itself, or no common history. `base` names the
/// branch the work started from; none means the one `origin/HEAD` points at, else `main`, else `master`. `show` are the
/// paths whose two diffs are wanted.
pub fn main_moved(cwd: &Path, base: Option<&str>, show: &[String]) -> Result<Option<MainMoved>, String> {
    if !cwd.is_absolute() || !cwd.is_dir() || crate::git_branch::git_dir(cwd).is_none() {
        return Ok(None);
    }
    if let Some(b) = base {
        if !valid_branch(b) {
            return Err("that is not a branch name".into());
        }
    }
    let Some(exe) = find("git") else { return Ok(None) };

    // The work tree's top folder: every later call runs from it, so the paths git prints are the paths it is given.
    let probe = Git { exe: exe.clone(), dir: cwd.to_path_buf() };
    let Some(top) = probe.line(&["rev-parse", "--show-toplevel"])? else { return Ok(None) };
    let git = Git { exe, dir: PathBuf::from(top) };
    // the note is read by itself: nothing more is read where the repository's own config, or a submodule's, names a program
    // git would run, or cannot be read
    if crate::lane::config_risk_by(&|args: &[&str]| git.run(args).ok(), &git.dir).is_some() {
        return Ok(None);
    }

    // a detached HEAD is on no branch, so no lane
    let Some(head) = git.line(&["symbolic-ref", "--quiet", "HEAD"])? else { return Ok(None) };
    let Some(branch) = head.strip_prefix("refs/heads/").map(str::to_string) else { return Ok(None) };

    let names = match base {
        Some(b) => vec![b.to_string()],
        None => candidates(&git)?,
    };
    let mut found: Option<(String, String)> = None;
    for n in names {
        if let Some(id) = tip_of(&git, &n)? {
            found = Some((n, id));
            break;
        }
    }
    let Some((base, tip)) = found else { return Ok(None) };
    if base == branch {
        return Ok(None);
    }
    // an unborn branch, or one with no history in common with the base, has nothing it started from
    let Some(fork) = git.line(&["merge-base", &tip, "HEAD"])? else { return Ok(None) };
    if !is_commit_id(&fork) {
        return Ok(None);
    }
    let mut out = MainMoved { branch, base, tip: tip.clone(), fork: fork.clone(), ours: Vec::new(), theirs: Vec::new(), both: Vec::new() };
    // the base is where the branch left it: nothing changed under it, so there is nothing to compare
    if fork == tip {
        return Ok(Some(out));
    }

    // Since the fork: what the base changed, and what the branch changed (committed, staged or not, in the work tree) with
    // the files it has that git does not track yet.
    out.theirs = git.names(&refs(&diff_args(&["--name-only", "-z"], &[&fork, &tip, "--"])))?;
    let mut ours = git.names(&refs(&diff_args(&["--name-only", "-z"], &[&fork, "--"])))?;
    let untracked = git.names(&["ls-files", "-z", "--others", "--exclude-standard", "--full-name"])?;
    ours.extend(untracked.iter().cloned());
    ours.sort();
    ours.dedup();
    out.ours = ours;

    for p in show.iter().take(MAX_SHOWN) {
        // only a path both sides changed: nothing else the page names gets to git
        if out.ours.binary_search(p).is_err() || out.theirs.binary_search(p).is_err() {
            continue;
        }
        let theirs = git.diff_text(&refs(&diff_args(&["--no-color", "-U3"], &[&fork, &tip, "--", p])), &[0])?;
        // a file git does not track yet is shown as all added, against nothing
        let ours = if untracked.binary_search(p).is_ok() {
            git.diff_text(&["diff", "--no-index", "--no-ext-diff", "--no-textconv", "--no-color", "-U3", "--", "/dev/null", p], &[0, 1])?
        } else {
            git.diff_text(&refs(&diff_args(&["--no-color", "-U3"], &[&fork, "--", p])), &[0])?
        };
        out.both.push(Both { path: p.clone(), theirs, ours });
    }
    Ok(Some(out))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("manut-moved-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d.canonicalize().unwrap()
    }

    /// The developer's git, with no config of its own in the way and an author, so commits work anywhere.
    fn git(dir: &Path, args: &[&str]) -> String {
        let o = Command::new("git")
            .args(["-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false"])
            .args(args)
            .current_dir(dir)
            .env("HOME", dir)
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_CONFIG_GLOBAL", if cfg!(windows) { "NUL" } else { "/dev/null" })
            .output()
            .unwrap();
        assert!(o.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&o.stderr));
        String::from_utf8_lossy(&o.stdout).trim().to_string()
    }

    fn write(dir: &Path, name: &str, text: &str) {
        std::fs::write(dir.join(name), text).unwrap();
    }

    fn commit(dir: &Path, msg: &str) {
        git(dir, &["add", "-A"]);
        git(dir, &["commit", "-q", "-m", msg]);
    }

    /// A repository on `main` with a.txt, b.txt and c.txt.
    fn repo(name: &str) -> PathBuf {
        let d = tmp(name);
        git(&d, &["init", "-q", "-b", "main"]);
        for f in ["a.txt", "b.txt", "c.txt"] {
            write(&d, f, &format!("{f}\n"));
        }
        commit(&d, "start");
        d
    }

    /// The canvas's story: the lane `kit/promptpay-qr` leaves main, main then changes a.txt, b.txt and adds d.txt, and the
    /// lane changes a.txt in a commit, c.txt in its work tree, and has its own d.txt that git does not track yet.
    fn moved(name: &str) -> PathBuf {
        let d = repo(name);
        git(&d, &["branch", "kit/promptpay-qr"]);
        write(&d, "a.txt", "a.txt\nmain\n");
        write(&d, "b.txt", "b.txt\nmain\n");
        write(&d, "d.txt", "main new\n");
        commit(&d, "main moves");
        git(&d, &["switch", "-q", "kit/promptpay-qr"]);
        write(&d, "a.txt", "a.txt\nlane\n");
        commit(&d, "lane");
        write(&d, "c.txt", "c.txt\nlane\n");
        write(&d, "d.txt", "lane new\n");
        d
    }

    fn view(d: &Path) -> MainMoved {
        main_moved(d, None, &[]).unwrap().expect("a view")
    }

    fn strs(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    /// What the page reads (`readView` in src/code/moved.ts) is this answer exactly as the shell sends it: the page's own
    /// copy of one answer (`src/code/mainMoved.fixture.json`, which its test reads with `readView`) equals the JSON of the
    /// same answer here, key for key.
    #[test]
    fn the_answer_is_what_the_page_reads() {
        let p = Path::new(env!("CARGO_MANIFEST_DIR")).join("../src/code/mainMoved.fixture.json");
        let copy: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(p).unwrap()).unwrap();
        let both = |t: &str, o: &str| Both {
            path: "src/checkout.tsx".into(),
            theirs: format!("diff --git a/src/checkout.tsx b/src/checkout.tsx\n--- a/src/checkout.tsx\n+++ b/src/checkout.tsx\n@@ -1,2 +1,2 @@\n-const total = 1;\n+const total = {t};\n"),
            ours: format!("diff --git a/src/checkout.tsx b/src/checkout.tsx\n--- a/src/checkout.tsx\n+++ b/src/checkout.tsx\n@@ -1,2 +1,2 @@\n-const total = 1;\n+const total = {o};\n"),
        };
        let answer = MainMoved {
            branch: "kit/promptpay-qr".into(),
            base: "main".into(),
            tip: "b3c5d7e9f1a2b4c6d8e0f2a4b6c8d0e2f4a6b8c0".into(),
            fork: "a1b3c5d7e9f0a2b4c6d8e0f1a3b5c7d9e1f3a5b7".into(),
            ours: strs(&["src/checkout.tsx", "src/promptpay.ts", "tests/checkout.test.ts"]),
            theirs: strs(&["README.md", "src/checkout.tsx"]),
            both: vec![both("1 + shipping", "qr(1)")],
        };
        assert_eq!(copy, serde_json::to_value(&answer).unwrap());
    }

    #[test]
    fn says_nothing_outside_a_repository_or_for_a_bad_path() {
        let d = tmp("plain");
        assert_eq!(main_moved(&d, None, &[]).unwrap(), None);
        assert_eq!(main_moved(Path::new("relative/dir"), None, &[]).unwrap(), None);
        assert_eq!(main_moved(&d.join("missing"), None, &[]).unwrap(), None);
        let _ = std::fs::remove_dir_all(d);
    }

    #[test]
    fn names_the_files_each_side_changed_since_the_fork() {
        let d = moved("both");
        let v = view(&d);
        assert_eq!(v.branch, "kit/promptpay-qr");
        assert_eq!(v.base, "main");
        assert_ne!(v.tip, v.fork);
        assert_eq!(v.tip, git(&d, &["rev-parse", "main"]));
        assert_eq!(v.fork, git(&d, &["rev-parse", "main~1"]));
        // the lane: a.txt in a commit, c.txt in the work tree, d.txt not tracked
        assert_eq!(v.ours, strs(&["a.txt", "c.txt", "d.txt"]));
        // main: a.txt and b.txt changed, d.txt added
        assert_eq!(v.theirs, strs(&["a.txt", "b.txt", "d.txt"]));
        assert!(v.both.is_empty());
        let _ = std::fs::remove_dir_all(d);
    }

    #[test]
    fn lists_nothing_while_the_base_is_where_the_lane_left_it() {
        let d = repo("still");
        git(&d, &["switch", "-q", "-c", "kit/x"]);
        write(&d, "a.txt", "changed\n");
        let v = view(&d);
        assert_eq!(v.tip, v.fork);
        assert!(v.ours.is_empty() && v.theirs.is_empty());
        let _ = std::fs::remove_dir_all(d);
    }

    #[test]
    fn a_file_deleted_on_one_side_and_edited_on_the_other_counts_on_both() {
        let d = repo("delete");
        git(&d, &["branch", "kit/x"]);
        git(&d, &["rm", "-q", "b.txt"]);
        commit(&d, "main deletes b");
        git(&d, &["switch", "-q", "kit/x"]);
        write(&d, "b.txt", "b.txt\nlane\n");
        let v = view(&d);
        assert_eq!(v.theirs, strs(&["b.txt"]));
        assert_eq!(v.ours, strs(&["b.txt"]));
        let _ = std::fs::remove_dir_all(d);
    }

    #[test]
    fn a_rename_is_a_delete_and_an_add_so_an_edit_of_the_old_name_meets_it() {
        let d = repo("rename");
        git(&d, &["branch", "kit/x"]);
        git(&d, &["mv", "c.txt", "cc.txt"]);
        commit(&d, "main renames c");
        git(&d, &["switch", "-q", "kit/x"]);
        write(&d, "c.txt", "c.txt\nlane\n");
        let v = view(&d);
        assert_eq!(v.theirs, strs(&["c.txt", "cc.txt"]));
        assert_eq!(v.ours, strs(&["c.txt"]));
        let _ = std::fs::remove_dir_all(d);
    }

    #[test]
    fn reads_a_name_with_odd_characters_whole() {
        let d = repo("odd");
        git(&d, &["branch", "kit/x"]);
        write(&d, "my file é.txt", "main\n");
        commit(&d, "main adds it");
        git(&d, &["switch", "-q", "kit/x"]);
        write(&d, "my file é.txt", "lane\n");
        let v = view(&d);
        assert_eq!(v.theirs, strs(&["my file é.txt"]));
        assert_eq!(v.ours, strs(&["my file é.txt"]));
        let _ = std::fs::remove_dir_all(d);
    }

    #[test]
    fn finds_the_base_by_origin_head_then_main_then_master() {
        // origin/HEAD names trunk
        let d = repo("trunk");
        git(&d, &["branch", "-m", "main", "trunk"]);
        git(&d, &["branch", "kit/x"]);
        write(&d, "a.txt", "trunk\n");
        commit(&d, "trunk moves");
        let id = git(&d, &["rev-parse", "trunk"]);
        git(&d, &["update-ref", "refs/remotes/origin/trunk", &id]);
        git(&d, &["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/trunk"]);
        git(&d, &["switch", "-q", "kit/x"]);
        assert_eq!(view(&d).base, "trunk");
        let _ = std::fs::remove_dir_all(d);

        // master, when there is no main
        let d = repo("master");
        git(&d, &["branch", "-m", "main", "master"]);
        git(&d, &["switch", "-q", "-c", "kit/x"]);
        assert_eq!(view(&d).base, "master");
        let _ = std::fs::remove_dir_all(d);

        // a copy from origin, when there is no local branch of that name
        let d = repo("remote-only");
        git(&d, &["switch", "-q", "-c", "kit/x"]);
        let id = git(&d, &["rev-parse", "main"]);
        git(&d, &["update-ref", "refs/remotes/origin/main", &id]);
        git(&d, &["branch", "-D", "main"]);
        assert_eq!(view(&d).base, "main");
        let _ = std::fs::remove_dir_all(d);
    }

    #[test]
    fn the_page_may_name_the_base() {
        let d = repo("named");
        git(&d, &["branch", "develop"]);
        git(&d, &["switch", "-q", "-c", "kit/x"]);
        assert_eq!(main_moved(&d, Some("develop"), &[]).unwrap().map(|v| v.base), Some("develop".to_string()));
        // a branch that is not there is no base
        assert_eq!(main_moved(&d, Some("nope"), &[]).unwrap(), None);
        let _ = std::fs::remove_dir_all(d);
    }

    #[test]
    fn a_branch_name_that_could_be_an_option_or_a_range_never_reaches_git() {
        let d = repo("names");
        git(&d, &["switch", "-q", "-c", "kit/x"]);
        for bad in ["--upload-pack=evil", "-x", "a..b", "a b", "a:b", "a~1", "a^", "a@{1}", ".hidden", "x.lock", "x/", "/x", "x//y", "", "@"] {
            assert!(main_moved(&d, Some(bad), &[]).is_err(), "{bad:?}");
        }
        for good in ["main", "feat/x", "release-1.2", "kit/promptpay-qr"] {
            assert!(valid_branch(good), "{good:?}");
        }
        let _ = std::fs::remove_dir_all(d);
    }

    #[test]
    fn says_nothing_on_the_base_branch_itself_or_a_detached_head() {
        let d = moved("on-base");
        git(&d, &["stash", "-u", "-q"]);
        git(&d, &["switch", "-q", "main"]);
        assert_eq!(main_moved(&d, None, &[]).unwrap(), None);
        let id = git(&d, &["rev-parse", "HEAD"]);
        git(&d, &["switch", "-q", "--detach", &id]);
        assert_eq!(main_moved(&d, None, &[]).unwrap(), None);
        let _ = std::fs::remove_dir_all(d);
    }

    #[test]
    fn says_nothing_for_a_branch_with_no_history_in_common_with_the_base() {
        let d = repo("orphan");
        git(&d, &["switch", "-q", "--orphan", "kit/x"]);
        write(&d, "z.txt", "z\n");
        commit(&d, "unrelated");
        assert_eq!(main_moved(&d, None, &[]).unwrap(), None);
        let _ = std::fs::remove_dir_all(d);
    }

    #[test]
    fn shows_both_sides_of_the_paths_asked_for_and_no_others() {
        let d = moved("show");
        // a.txt: changed on both sides and tracked. d.txt: new on both, the lane's not tracked yet. b.txt: main only.
        let show = strs(&["a.txt", "d.txt", "b.txt", "zzz.txt", "--output=/tmp/x"]);
        let v = main_moved(&d, None, &show).unwrap().unwrap();
        assert_eq!(v.both.iter().map(|b| b.path.as_str()).collect::<Vec<_>>(), vec!["a.txt", "d.txt"]);
        let a = &v.both[0];
        assert!(a.theirs.contains("+main") && !a.theirs.contains("+lane"), "{}", a.theirs);
        assert!(a.ours.contains("+lane") && !a.ours.contains("+main"), "{}", a.ours);
        let d_txt = &v.both[1];
        assert!(d_txt.theirs.contains("+main new"), "{}", d_txt.theirs);
        assert!(d_txt.ours.contains("+lane new") && d_txt.ours.contains("new file mode"), "{}", d_txt.ours);
        let _ = std::fs::remove_dir_all(d);
    }

    #[test]
    fn masks_a_key_in_a_diff_before_it_leaves() {
        let d = repo("keys");
        git(&d, &["branch", "kit/x"]);
        write(&d, "a.txt", "password=not-a-real-one\n");
        commit(&d, "main puts a secret in");
        git(&d, &["switch", "-q", "kit/x"]);
        write(&d, "a.txt", &format!("token=ghp_{}\n", "a".repeat(36)));
        let v = main_moved(&d, None, &strs(&["a.txt"])).unwrap().unwrap();
        let b = &v.both[0];
        assert!(b.theirs.contains("password=••••") && !b.theirs.contains("not-a-real-one"), "{}", b.theirs);
        assert!(b.ours.contains("••••") && !b.ours.contains(&"a".repeat(36)), "{}", b.ours);
        let _ = std::fs::remove_dir_all(d);
    }

    #[test]
    fn cuts_a_very_long_diff() {
        let d = repo("long");
        git(&d, &["branch", "kit/x"]);
        write(&d, "a.txt", &"x".repeat(MAX_DIFF * 2));
        commit(&d, "main writes a lot");
        git(&d, &["switch", "-q", "kit/x"]);
        write(&d, "a.txt", "lane\n");
        let v = main_moved(&d, None, &strs(&["a.txt"])).unwrap().unwrap();
        assert!(v.both[0].theirs.len() <= MAX_DIFF);
        let _ = std::fs::remove_dir_all(d);
    }

    #[test]
    fn changes_nothing_in_the_repository_and_takes_no_lock() {
        let d = moved("read-only");
        // the agent's own git is mid-command: the index lock is held, and a read must neither wait for it nor break it
        std::fs::write(d.join(".git/index.lock"), "").unwrap();
        let index = std::fs::read(d.join(".git/index")).unwrap();
        let status = git_status(&d);
        let v = view(&d);
        assert_eq!(v.ours, strs(&["a.txt", "c.txt", "d.txt"]));
        assert_eq!(std::fs::read(d.join(".git/index")).unwrap(), index);
        assert!(d.join(".git/index.lock").exists());
        std::fs::remove_file(d.join(".git/index.lock")).unwrap();
        assert_eq!(git_status(&d), status);
        let _ = std::fs::remove_dir_all(d);
    }

    fn git_status(d: &Path) -> String {
        git(d, &["status", "--porcelain=v1", "-z"])
    }

    #[cfg(unix)]
    #[test]
    fn says_nothing_by_itself_where_the_repository_s_own_config_names_a_clean_filter() {
        use std::os::unix::fs::PermissionsExt;
        let d = moved("filter");
        let spy = tmp("filter-spy");
        let marker = spy.join("ran");
        let script = spy.join("spy.sh");
        std::fs::write(&script, format!("#!/bin/sh\necho ran >> '{}'\ncat\n", marker.display())).unwrap();
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
        git(&d, &["config", "filter.spy.clean", script.to_str().unwrap()]);
        std::fs::create_dir_all(d.join(".git/info")).unwrap();
        std::fs::write(d.join(".git/info/attributes"), "*.txt filter=spy\n").unwrap();
        // a stat change with the same size, so git has to read a.txt through the filter to compare it
        let a = std::fs::read(d.join("a.txt")).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(1100));
        std::fs::write(d.join("a.txt"), a).unwrap();
        assert_eq!(main_moved(&d, None, &strs(&["a.txt"])).unwrap(), None);
        assert!(!marker.exists(), "a program ran");
        let _ = std::fs::remove_dir_all(&d);
        let _ = std::fs::remove_dir_all(&spy);
    }

    #[test]
    fn works_from_a_folder_below_the_top_with_paths_from_the_top() {
        let d = moved("below");
        std::fs::create_dir_all(d.join("src/deep")).unwrap();
        let v = main_moved(&d.join("src/deep"), None, &[]).unwrap().unwrap();
        assert_eq!(v.ours, strs(&["a.txt", "c.txt", "d.txt"]));
        let _ = std::fs::remove_dir_all(d);
    }
}
