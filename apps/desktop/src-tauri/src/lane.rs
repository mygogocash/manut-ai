//! A lane's branch (`src/code/laneBranch.ts`). When Kit starts a piece of work in a project, the page asks for a branch of
//! its own, made from the branch the folder is on and switched to, so what Kit changes never lands on the developer's own
//! branch. This is the one place the shell runs `git` for the page; every other read of a repository (`git_branch.rs`,
//! `tasks.rs`) opens its files and runs nothing.
//!
//! The page sends the names to try, in order, and each is checked here against the one narrow form Kit makes
//! (`kit/` then lower case words joined by hyphens), so a name can never be a word `git` reads as an option or a path. The
//! first that no branch has is made with `git checkout -b <name>`: a new branch at `HEAD` has the same tree, so no file in
//! the folder changes, and nothing is pushed, merged, fetched or deleted. The folder's own branch is left as it was.
//!
//! It refuses rather than disturbs: a folder that is not a repository, one with no commit yet, one in the middle of a
//! rebase, a merge, a cherry-pick, a revert or a bisect, one whose index is locked by another `git`, and a list of names
//! that are all taken. A refusal is a short code the page maps to "no branch of its own"; the agent still starts.

use std::collections::HashSet;
use std::path::Path;

use serde::Serialize;

use crate::git_branch;
use crate::tasks;

/// The most names one call tries (the page sends nine).
const NAMES_MAX: usize = 20;
/// The longest a branch name is. The page makes them far shorter.
const NAME_MAX: usize = 64;

/// What was made: the lane's branch, and the one it was made from (a short commit when the folder was detached).
#[derive(Debug, Serialize, PartialEq)]
pub struct Made {
    pub branch: String,
    pub base: String,
}

/// Whether `name` is a branch name Kit makes: `kit/` and then lower case words and numbers joined by single hyphens.
pub fn valid_name(name: &str) -> bool {
    let Some(rest) = name.strip_prefix("kit/") else { return false };
    name.len() <= NAME_MAX
        && !rest.is_empty()
        && rest.split('-').all(|w| !w.is_empty() && w.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit()))
}

/// The files and folders git keeps while it is partway through something that moves `HEAD` or the index. A branch made
/// then would be made in the middle of the developer's own operation.
const IN_PROGRESS: [&str; 7] = ["rebase-merge", "rebase-apply", "MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "BISECT_LOG", "index.lock"];

fn in_progress(git_dir: &Path) -> bool {
    IN_PROGRESS.iter().any(|f| git_dir.join(f).exists())
}

/// The environment variables that would point `git` at another repository than the folder it is run in.
const REDIRECTS: [&str; 7] = ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_COMMON_DIR", "GIT_NAMESPACE", "GIT_CEILING_DIRECTORIES"];

/// Runs `git -C <cwd> <args>` with no shell, nothing on stdin and no prompt, as `tasks.rs` runs its CLIs.
fn git(exe: &Path, cwd: &Path, args: &[&str]) -> Result<tasks::Ran, String> {
    let mut argv: Vec<String> = vec!["-C".into(), cwd.to_string_lossy().into_owned()];
    argv.extend(args.iter().map(|a| (*a).to_string()));
    tasks::run_env(exe, &argv, true, &[("GIT_TERMINAL_PROMPT", "0"), ("LC_ALL", "C")], &REDIRECTS)
}

/// The branches under `kit/` that exist, lower-cased (a file system that ignores letter case treats two as one).
fn taken(exe: &Path, cwd: &Path) -> Result<HashSet<String>, String> {
    let ran = git(exe, cwd, &["for-each-ref", "--format=%(refname:short)", "refs/heads/kit/"])?;
    if ran.code != Some(0) {
        return Err(tasks::error_line(&ran.err));
    }
    Ok(ran.out.lines().map(|l| l.trim().to_lowercase()).filter(|l| !l.is_empty()).collect())
}

/// Makes the first of `names` that no branch has, from the branch `cwd` is on, and switches the folder to it.
pub fn make(cwd: &Path, names: &[String]) -> Result<Made, String> {
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
    let exe = tasks::find("git").ok_or("git_missing")?;
    // no commit yet: there is nothing to make a branch from
    let head = git(&exe, cwd, &["rev-parse", "--verify", "--quiet", "HEAD"])?;
    if head.code != Some(0) {
        return Err("no_commit".into());
    }
    let base = git_branch::branch(cwd);
    if base.is_empty() {
        return Err("not_a_repository".into());
    }
    let exists = taken(&exe, cwd)?;
    for name in names.iter().filter(|n| !exists.contains(&n.to_lowercase())) {
        let ran = git(&exe, cwd, &["checkout", "-b", name])?;
        // a hook that ran after the switch may fail the command, or a slow one be stopped: what matters is where the
        // folder is now
        if ran.code == Some(0) || git_branch::branch(cwd) == *name {
            return Ok(Made { branch: name.clone(), base });
        }
        // another process made the name first: the next one
        if ran.err.contains("already exists") {
            continue;
        }
        return Err(tasks::error_line(&ran.err));
    }
    Err("taken".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::process::Command;

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("manut-lane-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
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

    /// A repository on `main` with one commit and one file, or None when this machine has no git (the tests then say so
    /// and pass, as the rest of the shell's tests do for a program that is not there).
    fn repo(name: &str) -> Option<PathBuf> {
        tasks::find("git")?;
        let d = tmp(name);
        sh(&d, &["init", "-q"]);
        sh(&d, &["symbolic-ref", "HEAD", "refs/heads/main"]);
        std::fs::write(d.join("a.txt"), "one\n").unwrap();
        sh(&d, &["add", "a.txt"]);
        sh(&d, &["commit", "-q", "-m", "first"]);
        Some(d)
    }

    fn names(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
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
    fn makes_a_branch_from_the_one_the_folder_is_on_and_changes_nothing_else() {
        let Some(d) = repo("make") else { return };
        let main = sh(&d, &["rev-parse", "main"]);
        // the developer's own unsaved work stays where it is
        std::fs::write(d.join("a.txt"), "one\nmine\n").unwrap();
        let made = make(&d, &names(&["kit/promptpay-qr", "kit/promptpay-qr-2"])).unwrap();
        assert_eq!(made, Made { branch: "kit/promptpay-qr".into(), base: "main".into() });
        assert_eq!(git_branch::branch(&d), "kit/promptpay-qr");
        // the lane starts where main is, and main was not touched
        assert_eq!(sh(&d, &["rev-parse", "kit/promptpay-qr"]), main);
        assert_eq!(sh(&d, &["rev-parse", "main"]), main);
        assert_eq!(std::fs::read_to_string(d.join("a.txt")).unwrap(), "one\nmine\n");
        assert_eq!(sh(&d, &["branch", "--list", "--format=%(refname:short)"]).lines().count(), 2);
        let _ = std::fs::remove_dir_all(d);
    }

    #[test]
    fn takes_the_next_name_when_one_is_taken_and_refuses_when_all_are() {
        let Some(d) = repo("taken") else { return };
        sh(&d, &["branch", "kit/promptpay-qr"]);
        sh(&d, &["branch", "kit/promptpay-qr-2"]);
        let made = make(&d, &names(&["kit/promptpay-qr", "kit/promptpay-qr-2", "kit/promptpay-qr-3"])).unwrap();
        assert_eq!(made.branch, "kit/promptpay-qr-3");
        assert_eq!(make(&d, &names(&["kit/promptpay-qr", "kit/promptpay-qr-2"])), Err("taken".into()));
        // letter case does not make a taken name free
        sh(&d, &["switch", "-q", "main"]);
        assert_eq!(make(&d, &names(&["kit/Promptpay-Qr"])), Err("bad_name".into()));
        let _ = std::fs::remove_dir_all(d);
    }

    #[test]
    fn makes_it_from_a_detached_commit_and_says_which() {
        let Some(d) = repo("detached") else { return };
        let sha = sh(&d, &["rev-parse", "HEAD"]);
        sh(&d, &["checkout", "-q", "--detach"]);
        let made = make(&d, &names(&["kit/x"])).unwrap();
        assert_eq!(made.base, sha[..7]);
        assert_eq!(git_branch::branch(&d), "kit/x");
        let _ = std::fs::remove_dir_all(d);
    }

    #[test]
    fn makes_it_in_a_linked_worktree_and_leaves_the_main_one_alone() {
        let Some(d) = repo("wt") else { return };
        let wt = d.parent().unwrap().join(format!("manut-lane-wt-linked-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&wt);
        sh(&d, &["worktree", "add", "-q", "-b", "feat/dev", wt.to_str().unwrap()]);
        let wt = wt.canonicalize().unwrap();
        let made = make(&wt, &names(&["kit/x"])).unwrap();
        assert_eq!(made, Made { branch: "kit/x".into(), base: "feat/dev".into() });
        assert_eq!(git_branch::branch(&wt), "kit/x");
        assert_eq!(git_branch::branch(&d), "main");
        let _ = std::fs::remove_dir_all(&wt);
        let _ = std::fs::remove_dir_all(d);
    }

    #[test]
    fn refuses_what_it_cannot_make_a_branch_from_or_would_disturb() {
        let plain = tmp("plain");
        assert_eq!(make(&plain, &names(&["kit/x"])), Err("not_a_repository".into()));
        assert_eq!(make(Path::new("relative/dir"), &names(&["kit/x"])), Err("not_a_repository".into()));
        assert_eq!(make(&plain.join("missing"), &names(&["kit/x"])), Err("not_a_repository".into()));
        let _ = std::fs::remove_dir_all(plain);

        // no commit yet
        if tasks::find("git").is_some() {
            let empty = tmp("empty");
            sh(&empty, &["init", "-q"]);
            assert_eq!(make(&empty, &names(&["kit/x"])), Err("no_commit".into()));
            let _ = std::fs::remove_dir_all(empty);
        }

        // in the middle of something of the developer's own
        let Some(d) = repo("busy") else { return };
        for marker in ["MERGE_HEAD", "rebase-merge", "CHERRY_PICK_HEAD", "REVERT_HEAD", "BISECT_LOG", "index.lock"] {
            let p = d.join(".git").join(marker);
            std::fs::write(&p, "x").unwrap();
            assert_eq!(make(&d, &names(&["kit/x"])), Err("busy".into()), "{marker}");
            std::fs::remove_file(&p).unwrap();
        }
        assert_eq!(git_branch::branch(&d), "main");
        assert!(make(&d, &names(&["kit/x"])).is_ok());
        let _ = std::fs::remove_dir_all(d);
    }

    #[test]
    fn never_runs_git_with_a_name_it_does_not_make() {
        let Some(d) = repo("badname") else { return };
        for bad in [names(&[]), names(&["main"]), names(&["--orphan"]), names(&["kit/x", "-b"]), names(&["kit/x y"]), (0..21).map(|i| format!("kit/n{i}")).collect()] {
            assert_eq!(make(&d, &bad), Err("bad_name".into()), "{bad:?}");
        }
        assert_eq!(git_branch::branch(&d), "main");
        assert_eq!(sh(&d, &["branch", "--list", "--format=%(refname:short)"]), "main");
        let _ = std::fs::remove_dir_all(d);
    }
}
