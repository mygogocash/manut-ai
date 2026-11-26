//! Pull requests (item 100): the open pull / merge requests of one repository with what the page needs to sort them by how
//! ready each is to merge (its checks, its review, whether it conflicts), one request's detail (its description, checks and
//! changed files with their counts), and which merge methods the repository allows. Read the way Tasks reads (tasks.rs):
//! through the person's own `gh` or `glab`, a fixed argv built here from checked words, no shell, nothing on stdin, at most
//! 20 seconds, every text masked by the app's one masker before it leaves. Nothing here writes: every argv is a `list`, a
//! `view` or `repo view`. Merging is review.rs's, through its one ask.
//!
//! Fields: `gh pr list --json` and `gh pr view --json` list `reviewDecision`, `mergeable`, `baseRefName`, `files`,
//! `additions`, `deletions` and `changedFiles` (their help on gh 2.104.0), `gh repo view --json` lists `mergeCommitAllowed`,
//! `squashMergeAllowed` and `rebaseMergeAllowed`. `glab mr list --output json` prints GitLab's own merge request objects, which
//! carry `detailed_merge_status`, `has_conflicts`, `draft` and `target_branch` but no pipeline (GitLab's merge requests API);
//! glab is not on the Mac this was built on, so its answer is read as the API's object, as tasks.rs and review.rs read it.
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use serde_json::Value;

use crate::tasks::{self, check_repo, Check, Item, Kind, Ran, Source};

/// The most requests a list reads: the newest open ones, which is what a person merging looks at.
pub const BOARD_MAX: usize = 50;
/// The most changed files a detail lists (the counts cover them all).
pub const FILES_MAX: usize = 300;
/// An answer younger than this is given again without asking the host: the page reads a list at most once a minute.
pub const KEEP_BOARD: Duration = Duration::from_secs(55);

const GH_BOARD: &str = "number,title,state,url,labels,author,createdAt,updatedAt,isDraft,headRefName,baseRefName,statusCheckRollup,isCrossRepository,headRepository,headRepositoryOwner,reviewDecision,mergeable";
const GH_DETAIL: &str = "number,title,state,url,labels,author,createdAt,updatedAt,isDraft,headRefName,baseRefName,statusCheckRollup,isCrossRepository,headRepository,headRepositoryOwner,reviewDecision,mergeable,body,files,additions,deletions,changedFiles";
const GH_METHODS: &str = "mergeCommitAllowed,squashMergeAllowed,rebaseMergeAllowed";

fn s(v: &str) -> String {
    v.to_string()
}

/// One request as the list shows it: Tasks' row (`Item`: number, title, state, author, checks, the branch and whether it is this
/// repository's own) and what its readiness is read from.
#[derive(Clone, Debug, Default, Serialize, PartialEq)]
pub struct Pull {
    #[serde(flatten)]
    pub item: Item,
    /// `approved`, `changes` (changes asked), `required` (a review is still needed), or "" (the host asks for none, or did not say)
    pub review: String,
    /// The host says the branch conflicts with its base.
    pub conflict: bool,
    /// The branch it would merge into.
    pub base: String,
}

/// A repository's open requests, newest first, at most [`BOARD_MAX`].
#[derive(Clone, Debug, Default, Serialize, PartialEq)]
pub struct Board {
    pub items: Vec<Pull>,
    /// More are open than the list holds.
    pub more: bool,
    /// When the list was last read or confirmed, in seconds since 1970.
    pub at: i64,
}

#[derive(Clone, Debug, Default, Serialize, PartialEq)]
pub struct FileCount {
    pub path: String,
    pub additions: u64,
    pub deletions: u64,
}

/// One request opened in the app: its row, its description as plain text, its checks, and its changed files and counts (None:
/// the host did not say; GitLab's view names only how many files changed).
#[derive(Clone, Debug, Default, Serialize, PartialEq)]
pub struct PullDetail {
    pub pull: Pull,
    pub body: String,
    pub checks: Vec<Check>,
    pub files: Vec<FileCount>,
    pub additions: Option<u64>,
    pub deletions: Option<u64>,
    pub changed: Option<u64>,
}

/// The merge methods a repository allows. `read`: the host said; otherwise all three are offered and the host refuses one it
/// does not allow when the merge is asked.
#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct Methods {
    pub merge: bool,
    pub squash: bool,
    pub rebase: bool,
    pub read: bool,
}

impl Default for Methods {
    fn default() -> Methods {
        Methods { merge: true, squash: true, rebase: true, read: false }
    }
}

impl Methods {
    pub fn allows(&self, method: &str) -> bool {
        match method {
            "merge" => self.merge,
            "squash" => self.squash,
            "rebase" => self.rebase,
            _ => false,
        }
    }
}

/// The argv (after `gh` or `glab`) that lists `repo`'s open requests with what readiness needs.
pub fn board_argv(source: Source, repo: &str) -> Result<Vec<String>, String> {
    let repo = check_repo(source, repo)?;
    Ok(match source {
        // one more than is kept, so the page knows more are open
        Source::Github => vec![s("pr"), s("list"), s("--repo"), repo, s("--state"), s("open"), s("--json"), s(GH_BOARD), s("--limit"), (BOARD_MAX + 1).to_string()],
        Source::Gitlab => vec![s("mr"), s("list"), s("--repo"), repo, s("--output"), s("json"), s("--per-page"), BOARD_MAX.to_string(), s("--page"), s("1")],
    })
}

/// The argv that reads request `number` of `repo` with its files and counts.
pub fn detail_argv(source: Source, repo: &str, number: u64) -> Result<Vec<String>, String> {
    let repo = check_repo(source, repo)?;
    if number == 0 || number > 100_000_000 {
        return Err(format!("not an item number: {number}"));
    }
    Ok(match source {
        Source::Github => vec![s("pr"), s("view"), number.to_string(), s("--repo"), repo, s("--json"), s(GH_DETAIL)],
        Source::Gitlab => vec![s("mr"), s("view"), number.to_string(), s("--repo"), repo, s("--output"), s("json")],
    })
}

/// The argv (after `gh`) that reads which merge methods a GitHub repository allows. GitLab has none here.
pub fn methods_argv(repo: &str) -> Result<Vec<String>, String> {
    let repo = check_repo(Source::Github, repo)?;
    Ok(vec![s("repo"), s("view"), repo, s("--json"), s(GH_METHODS)])
}

/// What `gh repo view --json mergeCommitAllowed,...` answered. Anything else is not read: all three are offered.
pub fn parse_methods(out: &str) -> Methods {
    let Ok(v) = serde_json::from_str::<Value>(out.trim()) else { return Methods::default() };
    let b = |k: &str| v.get(k).and_then(Value::as_bool);
    match (b("mergeCommitAllowed"), b("squashMergeAllowed"), b("rebaseMergeAllowed")) {
        (Some(merge), Some(squash), Some(rebase)) if merge || squash || rebase => Methods { merge, squash, rebase, read: true },
        _ => Methods::default(),
    }
}

fn gh_pull(v: &Value) -> Pull {
    let up = |k: &str| v.get(k).and_then(Value::as_str).unwrap_or("").to_ascii_uppercase();
    let review = match up("reviewDecision").as_str() {
        "APPROVED" => "approved",
        "CHANGES_REQUESTED" => "changes",
        "REVIEW_REQUIRED" => "required",
        _ => "",
    };
    Pull { item: tasks::gh_item(v, true), review: review.into(), conflict: up("mergeable") == "CONFLICTING", base: tasks::one_line(tasks::text(v, "baseRefName"), 250) }
}

/// GitLab's list carries no pipeline, so its checks are read from `detailed_merge_status` when it names one (a pipeline still
/// running, or one that must succeed and has not), else from a pipeline the object does carry (a view's).
fn gl_pull(v: &Value) -> Pull {
    let mut item = tasks::gl_item(v, true);
    let status = v.get("detailed_merge_status").and_then(Value::as_str).unwrap_or("");
    let review = match status {
        "not_approved" => "required",
        "requested_changes" => "changes",
        _ => "",
    };
    if item.checks.as_ref().is_some_and(|c| c.total == 0) {
        match status {
            "ci_still_running" => item.checks = Some(tasks::Checks { pending: 1, total: 1, ..Default::default() }),
            "ci_must_pass" => item.checks = Some(tasks::Checks { failed: 1, total: 1, ..Default::default() }),
            _ => {}
        }
    }
    let conflict = status == "conflict" || v.get("has_conflicts").and_then(Value::as_bool).unwrap_or(false);
    Pull { item, review: review.into(), conflict, base: tasks::one_line(tasks::text(v, "target_branch"), 250) }
}

fn now_secs() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0)
}

/// A list answer as a board, newest first as the host lists them.
pub fn parse_board(source: Source, out: &str) -> Result<Board, String> {
    let v: Value = serde_json::from_str(out.trim()).map_err(|e| format!("{} answered something that is not JSON: {e}", source.program()))?;
    let rows = v.as_array().ok_or_else(|| format!("{} did not answer a list", source.program()))?;
    let mut items: Vec<Pull> = rows.iter().map(|r| if source == Source::Github { gh_pull(r) } else { gl_pull(r) }).filter(|p| p.item.number > 0).collect();
    let more = match source {
        Source::Github => items.len() > BOARD_MAX,
        Source::Gitlab => rows.len() >= BOARD_MAX,
    };
    items.truncate(BOARD_MAX);
    Ok(Board { items, more, at: now_secs() })
}

/// A count GitLab gives as a string ("3", "1000+"): its leading digits.
fn count_of(v: &Value) -> Option<u64> {
    match v {
        Value::Number(n) => n.as_u64(),
        Value::String(t) => t.chars().take_while(char::is_ascii_digit).collect::<String>().parse().ok(),
        _ => None,
    }
}

/// A view answer as the request's detail: Tasks' own reading of it (`tasks::parse_view`: the description, masked and cut, and
/// the checks) with the readiness fields and the changed files.
pub fn parse_detail(source: Source, out: &str) -> Result<PullDetail, String> {
    let d = tasks::parse_view(source, Kind::Changes, out)?;
    let v: Value = serde_json::from_str(out.trim()).map_err(|e| e.to_string())?;
    let mut pull = if source == Source::Github { gh_pull(&v) } else { gl_pull(&v) };
    pull.item = d.item;
    let (files, additions, deletions, changed) = match source {
        Source::Github => {
            let files: Vec<FileCount> = v
                .get("files")
                .and_then(Value::as_array)
                .map(|fs| {
                    fs.iter()
                        .take(FILES_MAX)
                        .map(|f| FileCount { path: tasks::one_line(tasks::text(f, "path"), 400), additions: f.get("additions").and_then(Value::as_u64).unwrap_or(0), deletions: f.get("deletions").and_then(Value::as_u64).unwrap_or(0) })
                        .filter(|f| !f.path.is_empty())
                        .collect()
                })
                .unwrap_or_default();
            let n = |k: &str| v.get(k).and_then(Value::as_u64);
            (files, n("additions"), n("deletions"), n("changedFiles"))
        }
        Source::Gitlab => (vec![], None, None, v.get("changes_count").and_then(count_of)),
    };
    Ok(PullDetail { pull, body: d.body, checks: d.checks, files, additions, deletions, changed })
}

struct Entry {
    board: Board,
    /// When the host was last asked about this list.
    asked: Instant,
}

/// The lists read this run, by `<program>:<repo>`. A list is kept only to give it again within [`KEEP_BOARD`].
pub struct Boards {
    lists: Mutex<HashMap<String, Entry>>,
    /// tests: stand-ins for `gh` and `glab` (none: the ones found on this computer)
    cli: Option<(PathBuf, PathBuf)>,
    keep: Duration,
}

impl Default for Boards {
    fn default() -> Boards {
        Boards { lists: Mutex::new(HashMap::new()), cli: None, keep: KEEP_BOARD }
    }
}

impl Boards {
    #[cfg(test)]
    pub(crate) fn with(gh: PathBuf, glab: PathBuf, keep: Duration) -> Boards {
        Boards { lists: Mutex::new(HashMap::new()), cli: Some((gh, glab)), keep }
    }

    fn run(&self, source: Source, argv: &[String]) -> Result<Ran, String> {
        let exe = match &self.cli {
            Some((gh, glab)) => Some(if source == Source::Github { gh.clone() } else { glab.clone() }).filter(|p| p.is_file()),
            None => tasks::find(source.program()),
        }
        .ok_or_else(|| format!("{} is not installed", source.program()))?;
        tasks::run_env(&exe, argv, true, &[], &[])
    }

    /// `argv`'s answer, or its last error line.
    fn answer(&self, source: Source, argv: &[String]) -> Result<String, String> {
        let ran = self.run(source, argv)?;
        if ran.code != Some(0) {
            let line = tasks::error_line(&ran.err);
            return Err(if line.is_empty() { format!("{} failed", source.program()) } else { line });
        }
        Ok(ran.out)
    }

    /// `repo`'s open requests: the list read within [`KEEP_BOARD`] again, else read now.
    pub fn board(&self, source: Source, repo: &str) -> Result<Board, String> {
        let argv = board_argv(source, repo)?;
        let key = format!("{}:{repo}", source.program());
        if let Some(e) = self.lists.lock().ok().and_then(|m| m.get(&key).filter(|e| e.asked.elapsed() < self.keep).map(|e| e.board.clone())) {
            return Ok(e);
        }
        let board = parse_board(source, &self.answer(source, &argv)?)?;
        if let Ok(mut m) = self.lists.lock() {
            if m.len() >= 64 && !m.contains_key(&key) {
                m.clear();
            }
            m.insert(key, Entry { board: board.clone(), asked: Instant::now() });
        }
        Ok(board)
    }

    /// Request `number` of `repo`, opened in the app. Read each time it is opened.
    pub fn detail(&self, source: Source, repo: &str, number: u64) -> Result<PullDetail, String> {
        let argv = detail_argv(source, repo, number)?;
        parse_detail(source, &self.answer(source, &argv)?)
    }

    /// The merge methods `repo` allows: GitHub's answer, else (GitLab, or an answer not read) all three, for the host to refuse.
    pub fn methods(&self, source: Source, repo: &str) -> Result<Methods, String> {
        check_repo(source, repo)?;
        if source != Source::Github {
            return Ok(Methods::default());
        }
        Ok(self.answer(source, &methods_argv(repo)?).map(|out| parse_methods(&out)).unwrap_or_default())
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use std::fs;
    use std::path::Path;

    const GH_BOARD_OUT: &str = include_str!("tasks_fixtures/gh-pr-board.json");
    const GL_BOARD_OUT: &str = include_str!("tasks_fixtures/glab-mr-board.json");
    const GH_DETAIL_OUT: &str = include_str!("tasks_fixtures/gh-pr-detail.json");

    fn by(b: &Board, n: u64) -> &Pull {
        b.items.iter().find(|p| p.item.number == n).unwrap()
    }

    #[test]
    fn the_list_asks_for_the_fields_readiness_needs_and_only_reads() {
        let gh = board_argv(Source::Github, "shop/site").unwrap();
        assert_eq!(gh[..6], ["pr", "list", "--repo", "shop/site", "--state", "open"]);
        let fields = &gh[gh.iter().position(|a| a == "--json").unwrap() + 1];
        for f in ["reviewDecision", "mergeable", "statusCheckRollup", "isDraft", "isCrossRepository", "headRefName", "author", "baseRefName"] {
            assert!(fields.split(',').any(|x| x == f), "{f}");
        }
        assert_eq!(gh.last().unwrap(), "51");
        assert_eq!(board_argv(Source::Gitlab, "shop/sub/site").unwrap()[..6], ["mr", "list", "--repo", "shop/sub/site", "--output", "json"]);
        assert!(board_argv(Source::Github, "--exec/x").is_err() && board_argv(Source::Github, "a/b/c").is_err());
        assert_eq!(detail_argv(Source::Github, "shop/site", 7).unwrap()[..5], ["pr", "view", "7", "--repo", "shop/site"]);
        assert!(detail_argv(Source::Github, "shop/site", 0).is_err());
        assert_eq!(methods_argv("shop/site").unwrap(), ["repo", "view", "shop/site", "--json", GH_METHODS]);
        // every word of every argv is a read
        for a in [board_argv(Source::Github, "o/r").unwrap(), board_argv(Source::Gitlab, "o/r").unwrap(), detail_argv(Source::Github, "o/r", 1).unwrap(), detail_argv(Source::Gitlab, "o/r", 1).unwrap(), methods_argv("o/r").unwrap()] {
            assert!(["list", "view"].contains(&a[1].as_str()), "{a:?}");
        }
    }

    #[test]
    fn reads_each_state_from_a_recorded_github_list() {
        let b = parse_board(Source::Github, GH_BOARD_OUT).unwrap();
        assert_eq!(b.items.len(), 6);
        assert!(!b.more);
        let ready = by(&b, 41);
        assert_eq!((ready.review.as_str(), ready.conflict, ready.base.as_str(), ready.item.state.as_str()), ("approved", false, "main", "open"));
        assert_eq!(ready.item.checks.as_ref().map(|c| (c.passed, c.failed, c.pending)), Some((2, 0, 0)));
        assert_eq!((ready.item.author.as_str(), ready.item.head.as_str(), ready.item.same), ("noi", "fix/qr-size", true));
        assert_eq!(by(&b, 42).item.checks.as_ref().map(|c| c.pending), Some(1));
        assert_eq!(by(&b, 43).review, "changes");
        assert_eq!(by(&b, 44).item.state, "draft");
        assert!(by(&b, 45).conflict);
        assert_eq!(by(&b, 45).review, "required");
        // a fork's request: its branch is not this repository's
        let fork = by(&b, 46);
        assert_eq!((fork.item.same, fork.item.from.as_str()), (false, "stranger/site"));
        // a token-like text in a title is masked before it leaves
        assert!(!b.items.iter().any(|p| p.item.title.contains("ghp_")), "{:?}", b.items.iter().map(|p| &p.item.title).collect::<Vec<_>>());
    }

    #[test]
    fn reads_gitlab_s_merge_status_as_review_checks_and_conflict() {
        let b = parse_board(Source::Gitlab, GL_BOARD_OUT).unwrap();
        assert_eq!(b.items.len(), 5);
        assert_eq!(by(&b, 11).review, "");
        assert_eq!(by(&b, 11).item.checks.as_ref().map(|c| c.total), Some(0));
        assert_eq!(by(&b, 12).item.checks.as_ref().map(|c| c.pending), Some(1));
        assert_eq!(by(&b, 13).review, "changes");
        assert_eq!(by(&b, 14).review, "required");
        assert!(by(&b, 15).conflict);
        assert_eq!(by(&b, 15).base, "main");
        assert!(by(&b, 11).item.same && !by(&b, 12).item.same);
    }

    #[test]
    fn a_detail_has_its_description_checks_files_and_counts() {
        let d = parse_detail(Source::Github, GH_DETAIL_OUT).unwrap();
        assert_eq!(d.pull.item.number, 41);
        assert_eq!(d.pull.review, "approved");
        assert!(d.body.starts_with("Makes the QR"), "{}", d.body);
        assert_eq!(d.checks.len(), 2);
        assert_eq!(d.files, vec![FileCount { path: "src/qr.ts".into(), additions: 12, deletions: 3 }, FileCount { path: "src/qr.test.ts".into(), additions: 20, deletions: 0 }]);
        assert_eq!((d.additions, d.deletions, d.changed), (Some(32), Some(3), Some(2)));
        let gl = parse_detail(Source::Gitlab, r#"{"iid": 9, "title": "t", "state": "opened", "description": "d", "changes_count": "1000+", "web_url": "https://gitlab.com/g/p/-/merge_requests/9"}"#).unwrap();
        assert_eq!((gl.changed, gl.additions, gl.files.len()), (Some(1000), None, 0));
    }

    #[test]
    fn methods_are_the_repository_s_own_or_all_three_when_not_read() {
        assert_eq!(parse_methods(r#"{"mergeCommitAllowed": false, "squashMergeAllowed": true, "rebaseMergeAllowed": false}"#), Methods { merge: false, squash: true, rebase: false, read: true });
        assert_eq!(parse_methods("not json"), Methods::default());
        assert_eq!(parse_methods(r#"{"mergeCommitAllowed": false, "squashMergeAllowed": false, "rebaseMergeAllowed": false}"#), Methods::default());
        assert!(Methods::default().allows("rebase") && !Methods::default().allows("fast-forward"));
    }

    /// A stand-in `gh` at `dir/gh` that answers a list from `dir/list.json`, logging each call to `dir/gh.log`.
    pub(crate) fn stand_in(dir: &Path, script_body: &str) -> PathBuf {
        fs::create_dir_all(dir).unwrap();
        let p = dir.join("gh");
        let log = dir.join("gh.log");
        let script = format!("#!/bin/sh\nprintf '%s ' \"$@\" >> '{log}'\nprintf '\\n' >> '{log}'\n{script_body}\n", log = log.display());
        fs::write(&p, script).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&p, fs::Permissions::from_mode(0o755)).unwrap();
        }
        p
    }

    pub(crate) fn temp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("manut-pulls-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    pub(crate) fn log_lines(dir: &Path) -> Vec<String> {
        fs::read_to_string(dir.join("gh.log")).unwrap_or_default().lines().map(str::to_string).collect()
    }

    #[test]
    fn a_list_read_within_the_minute_is_given_again_without_asking() {
        let dir = temp("keep");
        fs::write(dir.join("list.json"), GH_BOARD_OUT).unwrap();
        let gh = stand_in(&dir, &format!("case \"$1 $2\" in\n\"pr list\") cat '{}'; exit 0;;\nesac\nexit 2", dir.join("list.json").display()));
        let b = Boards::with(gh.clone(), dir.join("none"), Duration::from_secs(60));
        assert_eq!(b.board(Source::Github, "shop/site").unwrap().items.len(), 6);
        assert_eq!(b.board(Source::Github, "shop/site").unwrap().items.len(), 6);
        assert_eq!(log_lines(&dir).len(), 1);
        // with no time kept, each read asks
        let b = Boards::with(gh, dir.join("none"), Duration::ZERO);
        b.board(Source::Github, "shop/site").unwrap();
        assert_eq!(log_lines(&dir).len(), 2);
        // glab missing: said so
        assert_eq!(b.board(Source::Gitlab, "shop/site"), Err("glab is not installed".into()));
        let _ = fs::remove_dir_all(dir);
    }
}
