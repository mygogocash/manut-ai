//! Removing the folders of lanes whose pull request has merged (Settings › Worktrees, item 73). The page asks for it when the
//! Code page opens a project (and when the window is looked at again, at most once an hour for a project, never on a timer), and
//! it is the one place a lane's folder is removed because of something that happened on the remote.
//!
//! A lane's folder is removed only when all of this holds, each read now and none assumed:
//! - its session is closed (the page names the folders a session still works in, and those are never touched);
//! - nothing in it is changed or new, git is not partway through something there, and nothing git ignores in it is the
//!   developer's own (a `.env.local`, a local database: only what a project rebuilds and the agent settings the app copied in
//!   may go) (`lane::release`, the same check as the one a deleted chat's folder goes through, so there is one rule for "work of
//!   its own");
//! - the person's own `gh` (GitHub) or `glab` (GitLab) lists a merged pull / merge request whose head branch is the lane's in
//!   this very repository (GitHub's `isCrossRepository` false, GitLab's `source_project_id` equal to its `target_project_id`:
//!   a fork's request on a branch of the same name, which anyone can open, never counts), and
//!   the lane's branch tip is already in the default branch on the remote, or (GitHub only) is exactly the commit that pull
//!   request merged, which is what a squash merge leaves: the branch then holds nothing the pull request did not carry.
//!
//! If the CLI is not installed or not signed in, nothing is removed and the answer says why (`cannot`). The branch always stays,
//! no force flag reaches git, and the folder is read with the same limit and the same environment every other `gh` call here
//! has (`tasks.rs`: no shell, nothing on stdin, no prompt, a time limit). The default branch is fetched first (one branch, a time
//! limit, no password), so a merge made since the last fetch is seen; when that fetch fails the answer is read from what the
//! repository already has, which can only keep a folder.

use std::path::Path;
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::Value;

use crate::lane::{self, fetch_branch, real, records, safe_rev, Git};
use crate::tasks::{self, Source, Tasks};

/// The most folders looked at in one run, and how long a run may take in all: a pull request is asked about one by one, and the
/// rest wait for the next run.
const MAX_LANES: usize = 20;
const BUDGET: Duration = Duration::from_secs(90);

/// One folder a clean-up left, with why: a code from `lane::release` (`changes`, `ignored`, `config`, `submodules`, `busy`,
/// `unread`, `changed`), or `open` (no
/// merged pull request for the branch), `not_in_default` (merged, but its commits are not in the default branch), `no_default`
/// (the default branch could not be found), `later` (not asked about yet in this run).
#[derive(Debug, Serialize, PartialEq)]
pub struct CleanKept {
    pub branch: String,
    pub why: String,
}

/// What a clean-up did: the branches whose folders went, the folders left with why, and, when it could not tell at all, why
/// (`no_remote`: the folder has no GitHub or GitLab remote, `not_installed`, `not_signed_in`, `config`: the repository's own
/// config names a program git would run or another address to fetch from, named in `setting`).
#[derive(Debug, Serialize, PartialEq, Default)]
pub struct Cleaned {
    pub removed: Vec<String>,
    pub kept: Vec<CleanKept>,
    pub cannot: Option<String>,
    pub setting: Option<String>,
}

/// The `gh` or `glab` argv (after the program) that lists merged requests whose head branch is `branch`. `fields` are the
/// ones gh is asked for; glab prints what its API gives.
pub fn merged_argv(source: Source, repo: &str, branch: &str) -> Result<Vec<String>, String> {
    let repo = tasks::check_repo(source, repo)?;
    if !lane::valid_name(branch) {
        return Err("bad_name".into());
    }
    let s = |x: &str| x.to_string();
    Ok(match source {
        Source::Github => vec![s("pr"), s("list"), s("--repo"), repo, s("--head"), s(branch), s("--state"), s("merged"), s("--json"), s("headRefOid,mergedAt,isCrossRepository"), s("--limit"), s("10")],
        Source::Gitlab => vec![s("mr"), s("list"), s("--repo"), repo, s("--source-branch"), s(branch), s("--merged"), s("--output"), s("json"), s("--per-page"), s("10")],
    })
}

/// What a merged-request list says: whether any request of this repository's own branch merged, and the head commits GitHub
/// gave (none for GitLab). `gh pr list --head` and `glab mr list --source-branch` match the branch name alone, so a fork's
/// request on a branch of the same name is listed too; only a row the host says is from this repository counts, and one that
/// does not say is not.
pub fn read_merged(source: Source, out: &str) -> Option<(bool, Vec<String>)> {
    let v: Value = serde_json::from_str(out.trim()).ok()?;
    let rows: Vec<&Value> = v
        .as_array()?
        .iter()
        .filter(|r| match source {
            Source::Github => r.get("isCrossRepository").and_then(Value::as_bool) == Some(false),
            Source::Gitlab => tasks::gl_same_project(r),
        })
        .collect();
    let heads = match source {
        Source::Github => rows.iter().filter_map(|r| r.get("headRefOid").and_then(Value::as_str)).map(str::to_string).collect(),
        Source::Gitlab => Vec::new(),
    };
    Some((!rows.is_empty(), heads))
}

/// The remote-tracking branch of the default branch on `remote`: where `origin/HEAD` points, else `main`, else `master`; the
/// branch name on the remote and its local ref. git_pull.rs reads the default branch by the same rule, so the clean-up and the
/// pull never disagree about which branch it is.
pub(crate) fn default_branch(git: &Git, cwd: &Path, remote: &str) -> Option<(String, String)> {
    let head = format!("refs/remotes/{remote}/HEAD");
    let pointed = git.line(cwd, &["symbolic-ref", "--short", &head]).and_then(|s| s.strip_prefix(&format!("{remote}/")).map(str::to_string));
    for name in pointed.into_iter().chain(["main".to_string(), "master".to_string()]) {
        if !safe_rev(&name) {
            continue;
        }
        let r = format!("refs/remotes/{remote}/{name}");
        if git.line(cwd, &["rev-parse", "--verify", "--quiet", &format!("{r}^{{commit}}")]).is_some() {
            return Some((name, r));
        }
    }
    None
}

/// The remote a folder's pull requests are read from: `origin`, else the first remote, as `tasks::folder_remote` reads it.
/// review.rs pushes a lane's branch to this same remote.
pub(crate) fn remote_name(git: &Git, cwd: &Path) -> Option<String> {
    let ran = git.run(cwd, &["remote"]).ok().filter(|r| r.code == Some(0))?;
    let all: Vec<&str> = ran.out.lines().map(str::trim).filter(|l| !l.is_empty()).collect();
    all.iter().find(|r| **r == "origin").or(all.first()).map(|r| r.to_string()).filter(|r| safe_rev(r))
}

/// Removes the folders of the lanes of the repository `cwd` is in whose pull request merged, as the module says. `held`: the
/// folders a session still works in, which are left alone. `tasks` answers whether the CLI is signed in.
pub fn merged(home: &Path, cwd: &Path, held: &[String], tasks: &Tasks) -> Result<Cleaned, String> {
    let mut out = Cleaned::default();
    if !cwd.is_absolute() || !cwd.is_dir() || crate::git_branch::git_dir(cwd).is_none() {
        return Ok(out);
    }
    let git = Git::automatic(home)?;
    let Some(repo) = git.common_dir(cwd) else { return Ok(out) };
    let mut mine: Vec<_> = records(home).into_iter().map(|(_, r)| r).filter(|r| real(Path::new(&r.repo)) == repo && Path::new(&r.worktree).is_dir() && !held.iter().any(|h| h == &r.worktree)).collect();
    // nothing to look at: nothing reaches the network
    if mine.is_empty() {
        return Ok(out);
    }
    mine.sort_by(|a, b| b.made.cmp(&a.made).then_with(|| a.worktree.cmp(&b.worktree)));
    // the clean-up is the app's own doing: nothing is fetched or removed in a repository whose config names a program git
    // would run (a credential helper, an ssh command, a clean filter) or another address to fetch from
    if let Some(setting) = git.config_risk(cwd) {
        out.cannot = Some("config".into());
        out.setting = Some(setting);
        return Ok(out);
    }
    let Some(remote) = tasks::folder_remote(cwd) else {
        out.cannot = Some("no_remote".into());
        return Ok(out);
    };
    let source = Source::parse(&remote.source)?;
    let st = tasks.status(source, false);
    if !st.installed || !st.signed_in {
        out.cannot = Some(if st.installed { "not_signed_in" } else { "not_installed" }.into());
        return Ok(out);
    }
    let exe = tasks::find(source.program()).ok_or("not_installed")?;
    let ask = |argv: &[String]| tasks::run_env_for(&exe, argv, true, &[], &[], tasks::TIMEOUT).ok().filter(|r| r.code == Some(0)).map(|r| r.out);
    Ok(sweep(home, &git, cwd, &repo, mine, source, &remote.repo, &ask))
}

/// The loop of [`merged`] once the CLI is known to be there: `ask` runs a `gh` or `glab` argv and gives its output, or None
/// when it failed (tests answer from a list).
#[allow(clippy::too_many_arguments)]
pub(crate) fn sweep(home: &Path, git: &Git, cwd: &Path, repo: &Path, mine: Vec<lane::Record>, source: Source, slug: &str, ask: &dyn Fn(&[String]) -> Option<String>) -> Cleaned {
    let mut out = Cleaned::default();
    let remote_name = remote_name(git, cwd);
    // the default branch as the remote has it now; when the fetch fails the repository's own copy is used
    let default = remote_name.as_deref().and_then(|r| {
        let (name, local) = default_branch(git, cwd, r)?;
        let _ = fetch_branch(git, cwd, r, &name);
        Some(local)
    });
    let started = Instant::now();
    for (i, rec) in mine.into_iter().enumerate() {
        let keep = |out: &mut Cleaned, why: &str| out.kept.push(CleanKept { branch: rec.branch.clone(), why: why.into() });
        if i >= MAX_LANES || started.elapsed() > BUDGET {
            keep(&mut out, "later");
            continue;
        }
        let Ok(argv) = merged_argv(source, slug, &rec.branch) else {
            keep(&mut out, "unread");
            continue;
        };
        let Some((is_merged, heads)) = ask(&argv).and_then(|o| read_merged(source, &o)) else {
            keep(&mut out, "unread");
            continue;
        };
        if !is_merged {
            keep(&mut out, "open");
            continue;
        }
        // the branch's tip: what is on the folder's branch now, not what it was when the lane was made
        let Some(tip) = git.line(repo, &["rev-parse", "--verify", "--quiet", &format!("refs/heads/{}^{{commit}}", rec.branch)]) else {
            keep(&mut out, "unread");
            continue;
        };
        let in_default = default.as_deref().is_some_and(|d| git.run(cwd, &["merge-base", "--is-ancestor", &tip, d]).map(|r| r.code == Some(0)).unwrap_or(false));
        if !in_default && !heads.contains(&tip) {
            keep(&mut out, if default.is_some() { "not_in_default" } else { "no_default" });
            continue;
        }
        match lane::release(home, &rec.worktree, false) {
            Ok(r) if r.removed => out.removed.push(rec.branch.clone()),
            Ok(r) => keep(&mut out, r.kept.as_deref().unwrap_or("unread")),
            Err(_) => keep(&mut out, "unread"),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::lane::tests::{commit_in, names, repo, sh, with_origin};
    use std::fs;

    /// Runs a sweep over every lane of `d` with `ask` answering the pull request lists.
    fn run(home: &Path, d: &Path, source: Source, ask: &dyn Fn(&[String]) -> Option<String>) -> Cleaned {
        let git = Git::new(home).unwrap();
        let repo = git.common_dir(d).unwrap();
        let mine = records(home).into_iter().map(|(_, r)| r).collect();
        sweep(home, &git, d, &repo, mine, source, "o/r", ask)
    }

    /// A lane with one commit, pushed to origin; merged into origin's main when `merge`.
    fn lane(home: &Path, d: &Path, name: &str, merge: bool) -> (lane::Made, String) {
        let made = lane::make(home, d, &names(&[&format!("kit/{name}")])).unwrap();
        let wt = Path::new(&made.worktree);
        commit_in(wt, &format!("{name}.txt"), "work\n");
        sh(wt, &["push", "-q", "origin", &made.branch]);
        let tip = sh(wt, &["rev-parse", "HEAD"]);
        if merge {
            sh(d, &["merge", "-q", "--no-edit", "--no-ff", &made.branch]);
            sh(d, &["push", "-q", "origin", "main"]);
        }
        (made, tip)
    }

    fn said(tip: &str) -> String {
        format!(r#"[{{"headRefOid":"{tip}","mergedAt":"2026-11-25T00:00:00Z","isCrossRepository":false}}]"#)
    }

    #[test]
    fn removes_the_folder_of_a_merged_lane_whose_commits_are_in_the_default_branch_and_keeps_the_branch() {
        let Some((home, d)) = repo("clean-merged") else { return };
        with_origin(&home, &d);
        let (made, tip) = lane(&home, &d, "m", true);
        let out = run(&home, &d, Source::Github, &|_| Some(said(&tip)));
        assert_eq!((out.removed.clone(), out.kept.len()), (vec!["kit/m".to_string()], 0), "{out:?}");
        assert!(!Path::new(&made.worktree).exists());
        assert!(!sh(&d, &["branch", "--list", "kit/m"]).is_empty());
        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn keeps_every_folder_that_is_open_not_in_the_default_branch_or_has_work_of_its_own() {
        let Some((home, d)) = repo("clean-keep") else { return };
        with_origin(&home, &d);
        // not merged at all: the list is empty
        let (open, _) = lane(&home, &d, "open", false);
        // merged by the list's word, but its commits are not in main and the head is not the one that merged
        let (stale, _) = lane(&home, &d, "stale", false);
        // merged and in main, with a changed file since
        let (dirty, dtip) = lane(&home, &d, "dirty", true);
        fs::write(Path::new(&dirty.worktree).join("a.txt"), "mine\n").unwrap();
        // merged and in main, with an untracked file
        let (loose, ltip) = lane(&home, &d, "loose", true);
        fs::write(Path::new(&loose.worktree).join("new.txt"), "x\n").unwrap();
        // merged and in main, with a commit made after the merge that is on no remote
        let (later, ltip2) = lane(&home, &d, "later", true);
        commit_in(Path::new(&later.worktree), "after.txt", "after\n");
        let ask = |argv: &[String]| -> Option<String> {
            let b = argv.iter().position(|a| a == "--head").map(|i| argv[i + 1].as_str()).unwrap();
            Some(match b {
                "kit/open" => "[]".into(),
                "kit/stale" => said("0000000000000000000000000000000000000000"),
                "kit/dirty" => said(&dtip),
                "kit/loose" => said(&ltip),
                _ => said(&ltip2),
            })
        };
        let out = run(&home, &d, Source::Github, &ask);
        let why = |b: &str| out.kept.iter().find(|k| k.branch == b).map(|k| k.why.clone());
        assert_eq!(why("kit/open").as_deref(), Some("open"));
        assert_eq!(why("kit/stale").as_deref(), Some("not_in_default"));
        assert_eq!(why("kit/dirty").as_deref(), Some("changes"));
        assert_eq!(why("kit/loose").as_deref(), Some("changes"));
        // a commit after the merge is on no remote and not the merged head: not in the default branch, so kept
        assert_eq!(why("kit/later").as_deref(), Some("not_in_default"));
        assert!(out.removed.is_empty(), "{out:?}");
        for m in [&open, &stale, &dirty, &loose, &later] {
            assert!(Path::new(&m.worktree).join(".git").exists());
        }
        assert_eq!(fs::read_to_string(Path::new(&dirty.worktree).join("a.txt")).unwrap(), "mine\n");
        assert!(Path::new(&loose.worktree).join("new.txt").exists() && Path::new(&later.worktree).join("after.txt").exists());
        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn a_squash_merge_counts_only_when_the_branch_is_exactly_the_commit_that_merged() {
        let Some((home, d)) = repo("clean-squash") else { return };
        with_origin(&home, &d);
        let (made, tip) = lane(&home, &d, "sq", false);
        // main never gets the branch's commits (a squash), but the pull request's head is the branch's tip
        let out = run(&home, &d, Source::Github, &|_| Some(said(&tip)));
        assert_eq!(out.removed, vec!["kit/sq".to_string()], "{out:?}");
        assert!(!Path::new(&made.worktree).exists());
        // GitLab's list gives no head commit here, so the same lane is kept
        let (other, _) = lane(&home, &d, "sq2", false);
        let out = run(&home, &d, Source::Gitlab, &|_| Some(r#"[{"state":"merged","source_project_id":3,"target_project_id":3}]"#.into()));
        assert_eq!(out.kept.iter().map(|k| k.why.as_str()).collect::<Vec<_>>(), vec!["not_in_default"]);
        assert!(Path::new(&other.worktree).join(".git").exists());
        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn a_merged_lane_holding_a_file_git_ignores_that_is_the_developer_s_is_kept_with_its_own_reason() {
        let Some((home, d)) = repo("clean-ignored") else { return };
        with_origin(&home, &d);
        fs::create_dir_all(d.join(".git/info")).unwrap();
        fs::write(d.join(".git/info/exclude"), ".env.local\n").unwrap();
        let (made, tip) = lane(&home, &d, "env", true);
        fs::write(Path::new(&made.worktree).join(".env.local"), "KEY=only-here\n").unwrap();
        let out = run(&home, &d, Source::Github, &|_| Some(said(&tip)));
        assert_eq!(out.removed, Vec::<String>::new(), "{out:?}");
        assert_eq!(out.kept, vec![CleanKept { branch: "kit/env".into(), why: "ignored".into() }]);
        assert_eq!(fs::read_to_string(Path::new(&made.worktree).join(".env.local")).unwrap(), "KEY=only-here\n");
        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn a_stranger_s_merged_request_with_the_lane_s_branch_name_never_removes_its_folder() {
        let Some((home, d)) = repo("clean-fork") else { return };
        with_origin(&home, &d);
        // the lane's commits are in main, but the only merged request named like its branch came from someone's fork
        let (made, tip) = lane(&home, &d, "fork", true);
        let fork = format!(r#"[{{"headRefOid":"{tip}","mergedAt":"2026-11-25T00:00:00Z","isCrossRepository":true}}]"#);
        let out = run(&home, &d, Source::Github, &|_| Some(fork.clone()));
        assert_eq!((out.removed.len(), out.kept.first().map(|k| k.why.as_str())), (0, Some("open")), "{out:?}");
        assert!(Path::new(&made.worktree).join(".git").exists());
        // GitLab: a merge request whose source project is not the target
        let gl = r#"[{"state":"merged","source_project_id":2,"target_project_id":3}]"#;
        let out = run(&home, &d, Source::Gitlab, &|_| Some(gl.into()));
        assert_eq!((out.removed.len(), out.kept.first().map(|k| k.why.as_str())), (0, Some("open")), "{out:?}");
        assert!(Path::new(&made.worktree).join(".git").exists());
        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn a_list_that_cannot_be_read_removes_nothing() {
        let Some((home, d)) = repo("clean-unread") else { return };
        with_origin(&home, &d);
        let (made, _) = lane(&home, &d, "u", true);
        for answer in [None, Some("not json".to_string()), Some("{}".to_string())] {
            let out = run(&home, &d, Source::Github, &|_| answer.clone());
            assert_eq!((out.removed.len(), out.kept[0].why.as_str()), (0, "unread"));
        }
        assert!(Path::new(&made.worktree).join(".git").exists());
        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn a_lane_a_session_still_holds_is_never_looked_at() {
        let Some((home, d)) = repo("clean-held") else { return };
        with_origin(&home, &d);
        let (made, tip) = lane(&home, &d, "h", true);
        let tasks = Tasks::default();
        // held folders are dropped before anything is asked, so nothing reaches the network or a CLI
        let out = merged(&home, &d, &[made.worktree.clone()], &tasks).unwrap();
        assert_eq!(out, Cleaned::default());
        assert!(Path::new(&made.worktree).join(".git").exists());
        let _ = tip;
        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn does_nothing_by_itself_in_a_repository_whose_own_config_names_a_program() {
        let Some((home, d)) = repo("clean-config") else { return };
        with_origin(&home, &d);
        let (made, _) = lane(&home, &d, "c", true);
        let (helper, marker) = crate::lane::tests::spy(&home, "helper", true);
        sh(&d, &["config", "credential.helper", &helper]);
        let out = merged(&home, &d, &[], &Tasks::default()).unwrap();
        assert_eq!((out.cannot.as_deref(), out.setting.as_deref(), out.removed.len()), (Some("config"), Some("credential.helper"), 0), "{out:?}");
        assert!(Path::new(&made.worktree).join(".git").exists());
        assert!(!marker.exists());
        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn a_merged_lane_s_clean_up_runs_no_program_a_submodule_s_own_config_names_and_keeps_the_folder() {
        let Some((home, d)) = repo("clean-submodule") else { return };
        with_origin(&home, &d);
        crate::lane::tests::with_submodule(&home, &d);
        sh(&d, &["push", "-q", "origin", "main"]);
        let (made, tip) = lane(&home, &d, "sub", true);
        let marker = crate::lane::tests::filter_in_submodule(&home, Path::new(&made.worktree));
        let out = run(&home, &d, Source::Github, &|_| Some(said(&tip)));
        assert!(!marker.exists(), "a program ran: {}", fs::read_to_string(&marker).unwrap_or_default());
        assert_eq!(out.removed, Vec::<String>::new(), "{out:?}");
        assert!(Path::new(&made.worktree).join("sub/s.txt").exists());
        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn a_merged_lane_with_submodules_is_kept_with_its_own_reason() {
        let Some((home, d)) = repo("clean-submodules") else { return };
        with_origin(&home, &d);
        crate::lane::tests::with_submodule(&home, &d);
        sh(&d, &["push", "-q", "origin", "main"]);
        let (made, tip) = lane(&home, &d, "subs", true);
        let wt = Path::new(&made.worktree);
        sh(wt, &["-c", "protocol.file.allow=always", "submodule", "update", "--init", "-q"]);
        fs::write(wt.join("sub/s.txt"), "uncommitted in the submodule\n").unwrap();
        let out = run(&home, &d, Source::Github, &|_| Some(said(&tip)));
        assert_eq!(out.kept, vec![CleanKept { branch: "kit/subs".into(), why: "submodules".into() }], "{out:?}");
        assert_eq!(fs::read_to_string(wt.join("sub/s.txt")).unwrap(), "uncommitted in the submodule\n");
        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn says_it_cannot_tell_and_does_nothing_without_a_github_or_gitlab_remote() {
        let Some((home, d)) = repo("clean-cannot") else { return };
        with_origin(&home, &d);
        let (made, _) = lane(&home, &d, "c", true);
        // origin is a local path, which is neither GitHub nor GitLab
        let out = merged(&home, &d, &[], &Tasks::default()).unwrap();
        assert_eq!((out.cannot.as_deref(), out.removed.len()), (Some("no_remote"), 0));
        assert!(Path::new(&made.worktree).join(".git").exists());
        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn asks_for_merged_requests_of_one_head_branch_only() {
        let gh = merged_argv(Source::Github, "mygogocash/web-app", "kit/promptpay-qr").unwrap();
        assert_eq!(gh.join(" "), "pr list --repo mygogocash/web-app --head kit/promptpay-qr --state merged --json headRefOid,mergedAt,isCrossRepository --limit 10");
        let gl = merged_argv(Source::Gitlab, "group/sub/web-app", "kit/x").unwrap();
        assert_eq!(gl.join(" "), "mr list --repo group/sub/web-app --source-branch kit/x --merged --output json --per-page 10");
        // a name that is not a branch Kit makes, or a repository that is not one, reaches no argv
        assert!(merged_argv(Source::Github, "o/r", "--help").is_err());
        assert!(merged_argv(Source::Github, "o/r", "main").is_err());
        assert!(merged_argv(Source::Github, "-o/r", "kit/x").is_err());
    }

    #[test]
    fn reads_what_a_merged_list_says() {
        assert_eq!(read_merged(Source::Github, "[]"), Some((false, vec![])));
        assert_eq!(read_merged(Source::Github, r#"[{"headRefOid":"abc","mergedAt":"2026-11-25T00:00:00Z","isCrossRepository":false}]"#), Some((true, vec!["abc".to_string()])));
        assert_eq!(read_merged(Source::Gitlab, r#"[{"state":"merged","source_project_id":3,"target_project_id":3}]"#), Some((true, vec![])));
        // a fork's request, or a row that does not say whose branch it is, does not count
        assert_eq!(read_merged(Source::Github, r#"[{"headRefOid":"abc","isCrossRepository":true},{"headRefOid":"def"}]"#), Some((false, vec![])));
        assert_eq!(read_merged(Source::Gitlab, r#"[{"state":"merged","source_project_id":2,"target_project_id":3},{"state":"merged"}]"#), Some((false, vec![])));
        // not a list: not read, so nothing is removed
        for bad in ["", "null", "{}", "gh: not signed in"] {
            assert_eq!(read_merged(Source::Github, bad), None, "{bad:?}");
        }
    }
}
