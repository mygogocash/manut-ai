//! Settings › Source control › Automatically pull (item 75): a project's default branch brought up to date by itself, as T3 Code's
//! "Automatically pull" keeps the default branch current "when the checkout has no local changes or commits" (pingdotgg/t3code,
//! MIT License, `autoPullProjects`; the rule is read from its behaviour, the code is Manut AI's own).
//!
//! The page asks for it when the Code page opens a project and when the window is looked at again, at most once every fifteen
//! minutes for a project, never on a timer (`src/lib/sourceControl.ts`). Here, every condition is read now and none assumed, and
//! the first that fails ends the call with its code and nothing done:
//!
//! - the folder is a repository's work tree, and not a lane's folder (`lane`): a lane's branch is the lane's;
//! - the repository's own config names no program git would run and no other address to fetch from (`config`, with the
//!   setting in `setting`; `lane::Git::config_risk`): a `.git/config` that came from someone else (a zip a freelancer sent) must
//!   not run their clean filter, ssh command or credential helper, or bring in their commits, when the project opens;
//! - git is not partway through a rebase, merge, cherry-pick, revert or bisect, and holds no index lock (`busy`);
//! - the checkout is on a branch (`detached`), that branch tracks a remote branch (`no_upstream`), and both are the remote's
//!   default branch by name, read as the merged clean-up reads it (`not_default`);
//! - nothing in the work tree is changed, staged or new, ignored files aside (`changes`; `unread` when git could not say). An
//!   ignored file is not counted, but it is never written over either: see [`FAST_FORWARD`];
//! - no commit of the branch is missing from every remote branch (`ahead`).
//!
//! Then the default branch alone is fetched, as item 73's start from the remote fetches it (`lane::fetch_branch`: one branch, ten
//! seconds at most, no password asked; `fetch_failed`), and the checkout moves only when its commit is an ancestor of the
//! remote's (`diverged` otherwise), by one write: [`FAST_FORWARD`], `git merge --ff-only` to that very commit, which git itself
//! refuses unless it is a fast-forward. Never a merge commit, a rebase, a stash or a force; no hook runs (`lane::Git` points
//! `core.hooksPath` at a folder that does not exist), and no branch but the one checked out moves.
//!
//! A file git ignores (a person's `.env`, `.mcp.json`) is not counted as a change, so it does not stop the pull, but the pull
//! never writes over one: `git merge` silently replaces an ignored file when an incoming commit adds a tracked file at the same
//! path (`--overwrite-ignore` is its default, `git help merge`), so the one write passes `--no-overwrite-ignore`, and git's
//! refusal then reads as the checkout having changes (`changes`), as a new file at that path would.

use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::Serialize;

use crate::lane::{self, fetch_branch, real, safe_rev, Git};
use crate::lane_clean::default_branch;

/// How long the fast-forward may take: it writes every file the new commits changed, as a checkout does.
const CHECKOUT_LIMIT: Duration = Duration::from_secs(120);

/// The one write, before the commit it moves to: a fast-forward, which git refuses when the branch has anything the commit does
/// not. `--no-overwrite-ignore` because git's default replaces an ignored file (a person's `.env`) with a tracked one an incoming
/// commit adds at the same path, `--no-autostash` because a `merge.autoStash` setting would stash (the checkout was just read
/// clean, so there is nothing to stash, and a stash must never be made), `--no-verify-signatures` because a
/// `merge.verifySignatures` setting would run the `gpg.program` a repository names, `--no-stat` because nothing reads the
/// summary.
pub const FAST_FORWARD: [&str; 6] = ["merge", "--ff-only", "--no-overwrite-ignore", "--no-autostash", "--no-verify-signatures", "--no-stat"];

/// What a pull did. `done`: the branch moved. `why`: `pulled`, `current` (it already was the remote's commit), or the code of the
/// condition that stopped it (see the module). `from` and `to` are short commit ids, `count` how many commits came.
#[derive(Debug, Serialize, PartialEq, Default)]
pub struct Pulled {
    pub done: bool,
    pub why: String,
    pub branch: String,
    pub remote: String,
    pub from: String,
    pub to: String,
    pub count: u32,
    /// `config`'s own: the setting that stopped it, as git names it (an address in it shown as `*`).
    pub setting: String,
}

fn short(id: &str) -> String {
    id.chars().take(7).collect()
}

fn commit_id(s: &str) -> bool {
    (s.len() == 40 || s.len() == 64) && s.bytes().all(|b| b.is_ascii_hexdigit())
}

/// Brings the default branch checked out in `cwd` up to date with its remote, as the module says.
pub fn pull(home: &Path, cwd: &Path) -> Pulled {
    let mut out = Pulled::default();
    let why = pull_into(home, cwd, &mut out);
    out.done = why == "pulled";
    out.why = why.to_string();
    out
}

fn pull_into(home: &Path, cwd: &Path, out: &mut Pulled) -> &'static str {
    if !cwd.is_absolute() || !cwd.is_dir() || crate::git_branch::git_dir(cwd).is_none() {
        return "not_a_repository";
    }
    if lane::in_a_lane(home, &real(cwd)) || lane::in_a_lane(home, cwd) {
        return "lane";
    }
    let Ok(git) = Git::automatic(home) else { return "git_missing" };
    let Some(top) = git.line(cwd, &["rev-parse", "--show-toplevel"]).map(PathBuf::from).filter(|p| p.is_absolute()) else {
        return "not_a_repository";
    };
    if lane::in_a_lane(home, &real(&top)) {
        return "lane";
    }
    if let Some(setting) = git.config_risk(&top) {
        out.setting = setting;
        return "config";
    }
    if git.busy(&top) {
        return "busy";
    }
    let Some(branch) = git.line(&top, &["symbolic-ref", "--quiet", "HEAD"]).and_then(|r| r.strip_prefix("refs/heads/").map(str::to_string)).filter(|b| safe_rev(b)) else {
        return "detached";
    };
    out.branch = branch.clone();
    // the remote branch it tracks: `branch.<name>.remote` and `.merge`, as `git status` reads them
    let remote = git.line(&top, &["config", "--get", &format!("branch.{branch}.remote")]).filter(|r| !r.is_empty() && r != "." && safe_rev(r));
    let merge = git.line(&top, &["config", "--get", &format!("branch.{branch}.merge")]).and_then(|m| m.strip_prefix("refs/heads/").map(str::to_string)).filter(|m| safe_rev(m));
    let (Some(remote), Some(merge)) = (remote, merge) else { return "no_upstream" };
    out.remote = remote.clone();
    match default_branch(&git, &top, &remote) {
        // the default branch by name too: a branch of another name that happens to track it is the developer's own
        Some((default, _)) if default == merge && default == branch => {}
        _ => return "not_default",
    }
    match git.changed(&top) {
        None => return "unread",
        Some(n) if n > 0 => return "changes",
        _ => {}
    }
    match git.line(&top, &["rev-list", "--count", "HEAD", "--not", "--remotes"]).and_then(|n| n.parse::<u32>().ok()) {
        None => return "unread",
        Some(n) if n > 0 => return "ahead",
        _ => {}
    }
    if fetch_branch(&git, &top, &remote, &merge).is_err() {
        return "fetch_failed";
    }
    let tracking = format!("refs/remotes/{remote}/{merge}^{{commit}}");
    let Some(tip) = git.line(&top, &["rev-parse", "--verify", "--quiet", &tracking]).filter(|t| commit_id(t)) else { return "fetch_failed" };
    let Some(head) = git.line(&top, &["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]).filter(|h| commit_id(h)) else { return "unread" };
    out.from = short(&head);
    out.to = short(&tip);
    if head == tip {
        return "current";
    }
    if !git.run(&top, &["merge-base", "--is-ancestor", &head, &tip]).is_ok_and(|r| r.code == Some(0)) {
        return "diverged";
    }
    // read again just before the one write: the fetch took time, and the person may have started something since
    if git.busy(&top) {
        return "busy";
    }
    if git.changed(&top) != Some(0) {
        return "changes";
    }
    let mut args: Vec<&str> = FAST_FORWARD.to_vec();
    args.push(&tip);
    let ran = git.run_for(&top, &args, CHECKOUT_LIMIT);
    if git.line(&top, &["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]).as_deref() != Some(tip.as_str()) {
        // git refused to write over a file in the work tree (an ignored one, since the checkout was read clean): the person's
        // file is there, which is the checkout having changes, as a new file at that path would be
        let over = ran.as_ref().is_ok_and(|r| r.err.contains("would be overwritten"));
        return if over { "changes" } else { "failed" };
    }
    out.count = git.line(&top, &["rev-list", "--count", &format!("{head}..{tip}")]).and_then(|n| n.parse().ok()).unwrap_or(0);
    "pulled"
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::lane::tests::{commit_in, names, repo, sh, with_origin};
    use std::fs;

    /// Moves `branch` on the remote by `n` commits from a second clone, so the developer's copy is behind.
    fn advance(home: &Path, bare: &Path, n: usize) -> String {
        let other = home.join("other");
        let _ = fs::remove_dir_all(&other);
        sh(home, &["clone", "-q", bare.to_str().unwrap(), other.to_str().unwrap()]);
        for i in 0..n {
            commit_in(&other, &format!("r{i}.txt"), "from the remote\n");
        }
        sh(&other, &["push", "-q", "origin", "main"]);
        sh(&other, &["rev-parse", "HEAD"])
    }

    /// A developer's clone of a remote whose `main` moved on by two commits since.
    fn behind(name: &str) -> Option<(PathBuf, PathBuf, PathBuf, String)> {
        let (home, d) = repo(name)?;
        let bare = with_origin(&home, &d);
        let theirs = advance(&home, &bare, 2);
        Some((home, d, bare, theirs))
    }

    /// The things a pull must never have touched in `d`: where HEAD is, the remote-tracking branch, the files, the stash.
    fn state(d: &Path) -> (String, String, String, String) {
        (sh(d, &["rev-parse", "HEAD"]), sh(d, &["rev-parse", "refs/remotes/origin/main"]), sh(d, &["status", "--porcelain", "--untracked-files=all"]), sh(d, &["stash", "list"]))
    }

    #[test]
    fn brings_a_clean_default_branch_up_to_date_by_a_fast_forward_and_nothing_else() {
        let Some((home, d, _, theirs)) = behind("pull-ok") else { return };
        let mine = sh(&d, &["rev-parse", "HEAD"]);
        // a hook the repository names never runs
        fs::write(d.join(".git/hooks/post-merge"), "#!/bin/sh\ntouch hooked\n").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(d.join(".git/hooks/post-merge"), fs::Permissions::from_mode(0o755)).unwrap();
        }
        let got = pull(&home, &d);
        assert_eq!(got, Pulled { done: true, why: "pulled".into(), branch: "main".into(), remote: "origin".into(), from: mine[..7].into(), to: theirs[..7].into(), count: 2, ..Pulled::default() });
        assert_eq!(sh(&d, &["rev-parse", "HEAD"]), theirs);
        assert_eq!(fs::read_to_string(d.join("r1.txt")).unwrap(), "from the remote\n");
        // a fast-forward: no merge commit, no stash, the reflog says so
        assert_eq!(sh(&d, &["rev-list", "--merges", "HEAD"]), "");
        assert_eq!(sh(&d, &["stash", "list"]), "");
        assert!(sh(&d, &["reflog", "-1", "--format=%gs"]).contains("Fast-forward"), "{}", sh(&d, &["reflog", "-1", "--format=%gs"]));
        assert!(!d.join("hooked").exists());
        // again: nothing to do
        assert_eq!(pull(&home, &d), Pulled { done: false, why: "current".into(), branch: "main".into(), remote: "origin".into(), from: theirs[..7].into(), to: theirs[..7].into(), count: 0, ..Pulled::default() });
        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn refuses_every_kind_of_dirty_checkout_and_reaches_no_remote() {
        let Some((home, d, _, _)) = behind("pull-dirty") else { return };
        let clean = state(&d);
        // a changed file, a staged change, a new file: each refused, and nothing moved or was fetched
        type Make = fn(&Path);
        let dirty: [(&str, Make); 3] = [
            ("changed", |d| fs::write(d.join("a.txt"), "one\nmine\n").unwrap()),
            ("staged", |d| {
                fs::write(d.join("a.txt"), "one\nstaged\n").unwrap();
                sh(d, &["add", "a.txt"]);
            }),
            ("untracked", |d| fs::write(d.join("new.txt"), "new\n").unwrap()),
        ];
        for (what, make) in dirty {
            make(&d);
            let before = state(&d);
            assert_eq!(pull(&home, &d).why, "changes", "{what}");
            assert_eq!(state(&d), before, "{what}");
            assert_eq!(state(&d).1, clean.1, "{what}: the remote-tracking branch was not fetched");
            sh(&d, &["reset", "-q", "--hard"]);
            sh(&d, &["clean", "-q", "-fd"]);
        }
        // a commit that is on no remote
        commit_in(&d, "mine.txt", "mine\n");
        let before = state(&d);
        assert_eq!(pull(&home, &d).why, "ahead");
        assert_eq!(state(&d), before);
        sh(&d, &["reset", "-q", "--hard", "HEAD~1"]);
        // partway through something of the developer's own
        for marker in ["MERGE_HEAD", "rebase-merge", "rebase-apply", "CHERRY_PICK_HEAD", "REVERT_HEAD", "BISECT_LOG", "index.lock"] {
            let p = d.join(".git").join(marker);
            fs::write(&p, "x").unwrap();
            assert_eq!(pull(&home, &d).why, "busy", "{marker}");
            fs::remove_file(&p).unwrap();
        }
        assert_eq!(state(&d), clean);
        // what git ignores does not count: the pull then goes ahead
        fs::create_dir_all(d.join("node_modules/qrcode")).unwrap();
        fs::write(d.join("node_modules/qrcode/index.js"), "x\n").unwrap();
        assert_eq!(pull(&home, &d).why, "pulled");
        assert!(d.join("node_modules/qrcode/index.js").exists());
        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn only_the_default_branch_that_tracks_the_remote_is_pulled() {
        let Some((home, d, _, _)) = behind("pull-which") else { return };
        let main = sh(&d, &["rev-parse", "main"]);
        // detached
        sh(&d, &["checkout", "-q", "--detach"]);
        assert_eq!(pull(&home, &d).why, "detached");
        // another branch, even one that tracks the remote's main
        sh(&d, &["checkout", "-q", "-b", "feature", "--track", "origin/main"]);
        sh(&d, &["reset", "-q", "--hard", &main]);
        assert_eq!(pull(&home, &d).why, "not_default");
        sh(&d, &["checkout", "-q", "main"]);
        sh(&d, &["branch", "-q", "-D", "feature"]);
        sh(&d, &["checkout", "-q", "-b", "other"]);
        assert_eq!(pull(&home, &d).why, "no_upstream");
        sh(&d, &["checkout", "-q", "main"]);
        // main with no upstream
        sh(&d, &["branch", "--unset-upstream"]);
        assert_eq!(pull(&home, &d).why, "no_upstream");
        assert_eq!(sh(&d, &["rev-parse", "main"]), main);
        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn anything_but_a_fast_forward_is_refused_and_nothing_is_reset() {
        let Some((home, d)) = repo("pull-diverged") else { return };
        let bare = with_origin(&home, &d);
        let mine = sh(&d, &["rev-parse", "HEAD"]);
        // the remote's main is rewritten to a history the developer's commit is not part of
        let other = home.join("rewrite");
        sh(&home, &["init", "-q", other.to_str().unwrap()]);
        sh(&other, &["symbolic-ref", "HEAD", "refs/heads/main"]);
        commit_in(&other, "else.txt", "another history\n");
        sh(&other, &["push", "-q", "--force", bare.to_str().unwrap(), "main:main"]);
        let got = pull(&home, &d);
        assert_eq!(got.why, "diverged");
        assert!(!got.done);
        assert_eq!(sh(&d, &["rev-parse", "HEAD"]), mine);
        assert!(!d.join("else.txt").exists());
        assert_eq!(sh(&d, &["rev-list", "--merges", "HEAD"]), "");
        assert_eq!(sh(&d, &["stash", "list"]), "");
        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn never_touches_a_lane_s_folder_or_its_branch() {
        let Some((home, d, _, theirs)) = behind("pull-lane") else { return };
        let made = lane::make(&home, &d, &names(&["kit/qr"])).unwrap();
        let lane_at = sh(&d, &["rev-parse", "kit/qr"]);
        assert_eq!(pull(&home, Path::new(&made.dir)).why, "lane");
        assert_eq!(pull(&home, &d).why, "pulled");
        assert_eq!(sh(&d, &["rev-parse", "main"]), theirs);
        // the lane's branch and folder are as they were
        assert_eq!(sh(&d, &["rev-parse", "kit/qr"]), lane_at);
        assert_eq!(sh(Path::new(&made.dir), &["rev-parse", "HEAD"]), lane_at);
        assert!(!Path::new(&made.dir).join("r0.txt").exists());
        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn a_fetch_that_fails_changes_nothing() {
        let Some((home, d, bare, _)) = behind("pull-offline") else { return };
        let before = state(&d);
        fs::rename(&bare, home.join("gone.git")).unwrap();
        assert_eq!(pull(&home, &d).why, "fetch_failed");
        assert_eq!(state(&d), before);
        assert_eq!(pull(&home, &home.join("nowhere")).why, "not_a_repository");
        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn a_file_git_ignores_is_never_written_over_by_a_commit_that_brings_the_same_path() {
        let Some((home, d)) = repo("pull-ignored") else { return };
        let bare = with_origin(&home, &d);
        // the developer's own `.env`, ignored by this checkout's exclude file, with a value only they have
        fs::create_dir_all(d.join(".git/info")).unwrap();
        fs::write(d.join(".git/info/exclude"), ".env\n").unwrap();
        fs::write(d.join(".env"), "TOKEN=mine\n").unwrap();
        // someone commits a tracked `.env` to the remote's main: a fast-forward would bring it to the same path
        let other = home.join("other");
        sh(&home, &["clone", "-q", bare.to_str().unwrap(), other.to_str().unwrap()]);
        fs::write(other.join(".env"), "TOKEN=theirs\n").unwrap();
        sh(&other, &["add", "-f", ".env"]);
        sh(&other, &["commit", "-q", "-m", "env"]);
        sh(&other, &["push", "-q", "origin", "main"]);
        let mine = sh(&d, &["rev-parse", "HEAD"]);
        // git's own refusal is the checkout having a file of its own there, said as changes, and nothing moved
        let got = pull(&home, &d);
        assert_eq!((got.done, got.why.as_str()), (false, "changes"), "{got:?}");
        assert_eq!(fs::read_to_string(d.join(".env")).unwrap(), "TOKEN=mine\n");
        assert_eq!(sh(&d, &["rev-parse", "HEAD"]), mine);
        assert_eq!(sh(&d, &["stash", "list"]), "");
        // once the person moved their file away, the same pull goes ahead
        fs::rename(d.join(".env"), home.join("env-moved")).unwrap();
        assert_eq!(pull(&home, &d).why, "pulled");
        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn a_pull_runs_no_program_the_repository_s_own_config_names_and_fetches_from_nowhere_it_redirects_to() {
        // a clean filter, which `git status` runs to compare a file
        let Some((home, d, _, _)) = behind("pull-filter") else { return };
        let marker = crate::lane::tests::filter_in(&home, &d, &d);
        let before = state_quiet(&d);
        let got = pull(&home, &d);
        assert_eq!((got.done, got.why.as_str(), got.setting.as_str()), (false, "config", "filter.spy.clean"), "{got:?}");
        assert!(!marker.exists(), "a program ran: {}", fs::read_to_string(&marker).unwrap_or_default());
        assert_eq!(state_quiet(&d), before);
        let _ = fs::remove_dir_all(home);

        // an ssh command of the repository's own, which a fetch over ssh runs
        let Some((home, d, _, _)) = behind("pull-ssh") else { return };
        let (ssh, marker) = crate::lane::tests::spy(&home, "ssh", true);
        sh(&d, &["config", "core.sshCommand", &ssh]);
        sh(&d, &["remote", "set-url", "origin", "ssh://git@example.invalid/o/r.git"]);
        assert_eq!(pull(&home, &d).setting, "core.sshcommand");
        assert!(!marker.exists(), "a program ran: {}", fs::read_to_string(&marker).unwrap_or_default());
        let _ = fs::remove_dir_all(home);

        // a credential helper of the repository's own, and a remote that is a program (`ext::`)
        for (key, value) in [("credential.helper", "!evil"), ("remote.origin.url", "ext::sh -c evil")] {
            let Some((home, d, _, _)) = behind("pull-cred") else { return };
            sh(&d, &["config", key, value]);
            assert_eq!(pull(&home, &d).why, "config", "{key}");
            let _ = fs::remove_dir_all(home);
        }

        // a fetch sent to another repository than the remote names: its commits must never come in
        let Some((home, d, bare, _)) = behind("pull-redirect") else { return };
        let evil = home.join("evil.git");
        sh(&home, &["clone", "-q", "--bare", bare.to_str().unwrap(), evil.to_str().unwrap()]);
        let other = home.join("evil-work");
        sh(&home, &["clone", "-q", evil.to_str().unwrap(), other.to_str().unwrap()]);
        commit_in(&other, "planted.txt", "not from the remote\n");
        sh(&other, &["push", "-q", "origin", "main"]);
        sh(&d, &["config", &format!("url.{}.insteadOf", evil.display()), bare.to_str().unwrap()]);
        let mine = sh(&d, &["rev-parse", "HEAD"]);
        let got = pull(&home, &d);
        assert_eq!((got.why.as_str(), got.setting.as_str()), ("config", "url.*.insteadof"));
        assert_eq!(sh(&d, &["rev-parse", "HEAD"]), mine);
        assert!(!d.join("planted.txt").exists());
        let _ = fs::remove_dir_all(home);
    }

    /// Where HEAD is, the remote-tracking branch and the stash, read without refreshing the index (which would run a filter).
    fn state_quiet(d: &Path) -> (String, String, String) {
        (sh(d, &["rev-parse", "HEAD"]), sh(d, &["rev-parse", "refs/remotes/origin/main"]), sh(d, &["stash", "list"]))
    }

    #[test]
    fn the_one_write_is_a_fast_forward_and_never_a_merge_rebase_stash_or_force() {
        assert_eq!(FAST_FORWARD[0], "merge");
        assert!(FAST_FORWARD.contains(&"--ff-only") && FAST_FORWARD.contains(&"--no-overwrite-ignore") && FAST_FORWARD.contains(&"--no-verify-signatures"));
        for w in ["--no-ff", "--ff", "--squash", "--rebase", "rebase", "stash", "--autostash", "reset", "--hard", "--force", "-f", "pull", "-X", "-s", "--allow-unrelated-histories", "--no-verify", "--overwrite-ignore"] {
            assert!(!FAST_FORWARD.contains(&w), "{w}");
        }
    }
}
