//! How far a lane's branch is from its remote (item 146): the commits it has that the remote branch does not (ahead) and the
//! commits the remote branch has that it does not (behind), for the line a lane's row shows (src/code/LaneSync.tsx). The lane's
//! remote branch is its upstream when git has one set (`@{upstream}`), else the branch of the same name on `origin`, which a
//! push leaves behind as a remote-tracking branch even when it did not set an upstream. A lane whose branch has no such copy
//! reports the commits no remote branch holds, which is what a person asks of a branch that was never pushed, and none behind.
//! A repository with no remote at all reports nothing: every commit of its branch is "not pushed" there, which says nothing.
//!
//! This only reads what git already holds. It fetches nothing, so "behind" is as of the last fetch or push, and the row says so.
//! It runs through the lane's own `Git` runner after the checks every automatic read of a lane's folder passes (`lane_diff::opened`:
//! a folder the app made, listed by git as a worktree of the recorded repository, in a repository whose config names no program
//! git would run), and each count is read at most `CAP` commits deep, so a branch a very long way from its remote does not
//! walk a whole history. Nothing is written, nothing is masked because nothing but numbers and a branch name leaves.

use std::path::Path;
use std::time::Duration;

use serde::Serialize;

use crate::lane::{safe_rev, Git};
use crate::lane_diff::opened;

/// Counting stops after this many commits on either side: a count over `CAP` is sent as `CAP` + 1 and the page shows `999+`.
const CAP: usize = 1000;
/// How long one of the reads may take.
const LIMIT: Duration = Duration::from_secs(10);

/// `ahead` and `behind` are against `upstream` (`origin/kit/x`). With no `upstream` (the branch has no copy on a remote) `ahead`
/// is the commits no remote branch holds and `behind` is 0; with no remote at all, both are 0.
#[derive(Serialize, Debug, PartialEq)]
pub struct Remote {
    pub upstream: Option<String>,
    pub ahead: u32,
    pub behind: u32,
}

/// One number git printed for `rev-list --count`, or None for anything else.
fn parse_count(out: &str) -> Option<u32> {
    let mut words = out.split_whitespace();
    let n = words.next()?.parse().ok()?;
    words.next().is_none().then_some(n)
}

/// `git rev-list --count --max-count=<cap> <revs>` in `wt`: how many commits those revisions name, at most `cap`.
fn count(git: &Git, wt: &Path, revs: &[&str], cap: usize) -> Option<u32> {
    let max = format!("--max-count={cap}");
    let mut argv = vec!["rev-list", "--count", max.as_str()];
    argv.extend_from_slice(revs);
    argv.push("--");
    let ran = git.run_with(wt, &argv, LIMIT, &[]).ok()?;
    if ran.code != Some(0) {
        return None;
    }
    parse_count(&ran.out)
}

/// The remote branch the lane's branch is compared with and the revision that names it: its upstream when it has one, else the
/// branch of the same name on `origin` when that exists. The shown name is checked as a revision before anything runs with it.
fn upstream_of(git: &Git, wt: &Path) -> Option<(String, String)> {
    if let Some(name) = git.line(wt, &["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]).filter(|n| safe_rev(n)) {
        return Some((name, "@{upstream}".to_string()));
    }
    let branch = git.line(wt, &["symbolic-ref", "--short", "-q", "HEAD"]).filter(|b| safe_rev(b))?;
    let full = format!("refs/remotes/origin/{branch}");
    git.line(wt, &["rev-parse", "--verify", "--quiet", &full]).filter(|id| !id.is_empty())?;
    Some((format!("origin/{branch}"), full))
}

/// The lane `dir`'s branch against its remote. `Err` is a short code, as `lane_diff::read`'s: `not_a_lane`, `git_missing`,
/// `config:<setting>`, or `unread` when git did not answer.
pub fn read(home: &Path, dir: &str) -> Result<Remote, String> {
    read_capped(home, dir, CAP)
}

fn read_capped(home: &Path, dir: &str, cap: usize) -> Result<Remote, String> {
    let (git, wt, _) = opened(home, dir)?;
    let unread = || "unread".to_string();
    if let Some((name, rev)) = upstream_of(&git, &wt) {
        let ahead = count(&git, &wt, &["HEAD", "--not", &rev], cap).ok_or_else(unread)?;
        let behind = count(&git, &wt, &[&rev, "--not", "HEAD"], cap).ok_or_else(unread)?;
        return Ok(Remote { upstream: Some(name), ahead, behind });
    }
    // no copy of this branch on a remote: what no remote branch holds, unless there is no remote to hold anything
    let remotes = git.run_with(&wt, &["remote"], LIMIT, &[]).map_err(|_| unread())?;
    if remotes.code != Some(0) {
        return Err(unread());
    }
    if remotes.out.trim().is_empty() {
        return Ok(Remote { upstream: None, ahead: 0, behind: 0 });
    }
    let ahead = count(&git, &wt, &["HEAD", "--not", "--remotes"], cap).ok_or_else(unread)?;
    Ok(Remote { upstream: None, ahead, behind: 0 })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::lane;
    use crate::lane::tests::{commit_in, names, repo, sh};
    use std::fs;
    use std::path::PathBuf;

    #[test]
    fn git_s_count_is_one_number_and_nothing_else_is_taken() {
        assert_eq!(parse_count("3\n"), Some(3));
        assert_eq!(parse_count(" 12 \n"), Some(12));
        assert_eq!(parse_count("0"), Some(0));
        for bad in ["", "\n", "x", "3 1", "3\t1\n", "-1", "3.5", "99999999999999999999"] {
            assert_eq!(parse_count(bad), None, "{bad:?}");
        }
    }

    /// A lane `kit/x` of the test repository with a bare `origin` the repository's main branch was pushed to, and its folder.
    fn lane_with_origin(name: &str) -> Option<(PathBuf, PathBuf, PathBuf, PathBuf)> {
        let (home, d) = repo(name)?;
        let bare = crate::lane::tests::with_origin(&home, &d);
        let made = lane::make(&home, &d, &names(&["kit/x"])).unwrap();
        Some((home, d, bare, PathBuf::from(made.worktree)))
    }

    fn at(home: &Path, wt: &Path) -> Result<Remote, String> {
        read(home, &wt.to_string_lossy())
    }

    #[test]
    fn a_lane_never_pushed_counts_the_commits_no_remote_holds() {
        let Some((home, _, _, wt)) = lane_with_origin("lr-never") else { return };
        // a fresh lane is where main is, and main is on the remote: nothing to say
        assert_eq!(at(&home, &wt).unwrap(), Remote { upstream: None, ahead: 0, behind: 0 });
        commit_in(&wt, "one.txt", "1\n");
        commit_in(&wt, "two.txt", "2\n");
        assert_eq!(at(&home, &wt).unwrap(), Remote { upstream: None, ahead: 2, behind: 0 });
        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn a_branch_pushed_without_an_upstream_is_found_by_its_name_on_origin() {
        let Some((home, _, _, wt)) = lane_with_origin("lr-name") else { return };
        commit_in(&wt, "one.txt", "1\n");
        sh(&wt, &["push", "-q", "origin", "kit/x"]);
        // pushed, so level with its copy
        assert_eq!(at(&home, &wt).unwrap(), Remote { upstream: Some("origin/kit/x".into()), ahead: 0, behind: 0 });
        commit_in(&wt, "two.txt", "2\n");
        commit_in(&wt, "three.txt", "3\n");
        assert_eq!(at(&home, &wt).unwrap(), Remote { upstream: Some("origin/kit/x".into()), ahead: 2, behind: 0 });
        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn ahead_and_behind_are_counted_against_the_upstream_once_there_is_one() {
        let Some((home, d, bare, wt)) = lane_with_origin("lr-both") else { return };
        commit_in(&wt, "one.txt", "1\n");
        sh(&wt, &["push", "-q", "-u", "origin", "kit/x"]);
        // someone else puts two commits on the branch, and this lane makes one of its own
        let other = home.join("other");
        sh(&home, &["clone", "-q", &bare.to_string_lossy(), &other.to_string_lossy()]);
        sh(&other, &["checkout", "-q", "kit/x"]);
        commit_in(&other, "theirs1.txt", "a\n");
        commit_in(&other, "theirs2.txt", "b\n");
        sh(&other, &["push", "-q", "origin", "kit/x"]);
        commit_in(&wt, "mine.txt", "m\n");
        // nothing was fetched, so the lane knows nothing of theirs yet
        assert_eq!(at(&home, &wt).unwrap(), Remote { upstream: Some("origin/kit/x".into()), ahead: 1, behind: 0 });
        // after a fetch (the person's own, never the app's) both numbers show
        sh(&d, &["fetch", "-q", "origin"]);
        assert_eq!(at(&home, &wt).unwrap(), Remote { upstream: Some("origin/kit/x".into()), ahead: 1, behind: 2 });
        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn a_repository_with_no_remote_says_nothing() {
        let Some((home, d)) = repo("lr-none") else { return };
        let wt = PathBuf::from(lane::make(&home, &d, &names(&["kit/x"])).unwrap().worktree);
        commit_in(&wt, "one.txt", "1\n");
        assert_eq!(at(&home, &wt).unwrap(), Remote { upstream: None, ahead: 0, behind: 0 });
        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn a_count_stops_at_the_cap() {
        let Some((home, _, _, wt)) = lane_with_origin("lr-cap") else { return };
        for i in 0..5 {
            commit_in(&wt, &format!("f{i}.txt"), "x\n");
        }
        let got = read_capped(&home, &wt.to_string_lossy(), 3).unwrap();
        assert_eq!(got.ahead, 3, "{got:?}");
        assert_eq!(read_capped(&home, &wt.to_string_lossy(), 1000).unwrap().ahead, 5);
        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn a_folder_the_app_did_not_make_is_refused() {
        let Some((home, d, _, wt)) = lane_with_origin("lr-refused") else { return };
        for p in [d.to_string_lossy().into_owned(), wt.join("apps").to_string_lossy().into_owned(), "web-app".into(), "/no/such/folder".into(), String::new()] {
            assert_eq!(read(&home, &p).unwrap_err(), "not_a_lane", "{p}");
        }
        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn a_lane_whose_repository_names_a_clean_filter_is_not_read_by_itself() {
        let Some((home, d, _, wt)) = lane_with_origin("lr-filter") else { return };
        let marker = crate::lane::tests::filter_in(&home, &d, &wt);
        assert_eq!(at(&home, &wt).unwrap_err(), "config:filter.spy.clean");
        assert!(!marker.exists(), "a program ran: {}", fs::read_to_string(&marker).unwrap_or_default());
        let _ = fs::remove_dir_all(home);
    }

    #[cfg(unix)]
    #[test]
    fn no_program_the_repository_names_runs_to_count() {
        use std::os::unix::fs::PermissionsExt;
        let Some((home, d, _, wt)) = lane_with_origin("lr-programs") else { return };
        // the commit is made first: git run by the test itself would run the hooks below, and only the app's own read is on trial
        commit_in(&wt, "one.txt", "1\n");
        let marker = home.join("ran");
        let script = home.join("spy.sh");
        fs::write(&script, format!("#!/bin/sh\necho ran >> '{}'\n", marker.display())).unwrap();
        fs::set_permissions(&script, fs::Permissions::from_mode(0o755)).unwrap();
        let s = script.to_string_lossy().into_owned();
        // a file monitor and hooks, in the repository's own config and hooks
        sh(&d, &["config", "core.fsmonitor", &s]);
        for hook in ["post-index-change", "reference-transaction", "post-checkout"] {
            let h = d.join(".git/hooks").join(hook);
            fs::create_dir_all(h.parent().unwrap()).unwrap();
            fs::write(&h, format!("#!/bin/sh\necho ran >> '{}'\n", marker.display())).unwrap();
            fs::set_permissions(&h, fs::Permissions::from_mode(0o755)).unwrap();
        }
        assert_eq!(at(&home, &wt).unwrap().ahead, 1);
        assert!(!marker.exists(), "a program ran: {}", fs::read_to_string(&marker).unwrap_or_default());
        let _ = fs::remove_dir_all(home);
    }
}
