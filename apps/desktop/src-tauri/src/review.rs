//! A lane put up for review, and its pull request merged (item 75): the app's only writes to GitHub or GitLab, each behind one
//! ask that settles once. Tasks (tasks.rs) stays the read-only reader it always was; nothing here is reachable from it, and
//! nothing in it is reachable from the page except through an ask.
//!
//! How a write is tied to the ask:
//!
//! 1. The page asks for an ask (`Ledger::ask_open`). The shell reads the lane now (the app's own folder, on its own branch, with
//!    commits its base on the remote lacks, a GitHub or GitLab remote, the CLI installed and signed in), checks the title and
//!    body, and writes down the exact plan: the push's argv and the pull request's argv, with the title and body in them as they
//!    will be sent. It answers the ask in words the page shows: the repository, the branch, the base, the title and the body.
//!    Nothing is written yet. A lane that cannot be put up says why (`no_remote`, `not_signed_in`, ...) and nothing is asked.
//! 2. The page opens that ask as an approval-core request (`src/code/reviewAsk.ts`), and the person's Yes or No settles it there
//!    once, through approval-core's own rules. Only a settled request reaches the shell (`Ledger::settle`, by the ask's id).
//! 3. `Ledger::settle` takes the ask out of waiting under its lock before anything runs, so a second answer, a second window or a
//!    retried call finds it decided and runs nothing. A No runs nothing. A Yes runs the plan written in step 1, once: the page
//!    sends only the id and the answer, never an argv, a branch or a text. The function that runs a plan takes a `Settled`, which
//!    only `settle` can make, so no other path in the shell can reach it either.
//!
//! The push never forces: its refspec has no `+` and no flag of its argv forces, deletes, mirrors or pushes tags, and a remote set
//! up as a mirror is refused. No hook runs (`lane::Git`), and nothing may ask for a password (`lane::net_env`). The pull request
//! is opened with the branch named (`--head`, glab's `--source-branch`), so the CLI pushes and forks nothing of its own.
//!
//! An ask waits at most [`ASK_LIFE`]; after that it is refused as expired and the page asks again, so a Yes never lands on what
//! the person saw long ago. Before a Yes runs, the branch's commit is read again: a lane that committed since the ask runs
//! nothing (`changed`), since the person did not see that commit go.
//!
//! Merging (`Ledger::ask_merge`) is irreversible and public, so it is always asked, with no setting that skips the ask and no
//! auto-merge: the ask is made only for a pull request that is open, not a draft, made from the lane's own branch in this very
//! repository (never a fork's branch that happens to have the same name: GitHub's `isCrossRepository` is false and its head
//! repository is the base's, GitLab's `source_project_id` is its `target_project_id`), whose head commit is the lane's own
//! branch tip both on this Mac and as this Mac last pushed it, and that the host says can merge now (GitHub's `mergeable` and
//! `mergeStateStatus`, GitLab's `detailed_merge_status`). It names where the pull request comes from, its head commit, the
//! method and exactly the message that will be sent (`--subject` and `--body`, glab's `--message` and `--squash-message`; a
//! rebase makes no message and rewrites no commit message). The merge is bound to the commit the person saw
//! (`--match-head-commit`, glab's `--sha`); just before it runs, the pull request is read again (still this repository's, at
//! that commit, into the base the ask named, able to merge) and so is the lane (still at that commit), and no flag of its argv
//! merges automatically later, uses administrator rights or deletes the branch. Neither CLI can bind the base on the merge
//! itself, so a retarget in the moment between that read and the merge is the one change this cannot see. The app never
//! deletes the remote branch.
//!
//! The Pull requests list (item 100) merges through the same ask (`Ledger::ask_merge_pull`): a request of the project's own
//! repository (its folder's remote), from a branch of that very repository. A lane's request is asked as that lane's own Merge;
//! any other is asked the same way without a lane's tip to check, bound to the head commit shown and read again before it runs,
//! with a method the repository allows. No other write is added.
//!
//! A new project made on GitHub too (item 100b, `Ledger::ask_repo`) is the third write, through the same ask: the shell checks the
//! project's folder (in the person's home, a repository of its own with no `origin` yet), the name and the CLI, and writes down
//! `gh repo create <name> --private --source <folder> --remote origin` (or `--public`, when the person chose it). The ask shows
//! that line in full, as it will run; a Yes runs it once, after the folder is read again. It pushes nothing: no `--push`, and no
//! other step here sends the project's commits.

use std::collections::HashMap;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::Serialize;

use crate::lane::{self, real, safe_rev, Git};
use crate::lane_clean::remote_name;
use crate::tasks::{self, Source};

/// How long an ask waits for its answer before a Yes is refused as expired.
pub const ASK_LIFE: Duration = Duration::from_secs(15 * 60);
/// How long the push may take: it sends every commit of the branch the remote lacks.
const PUSH_LIMIT: Duration = Duration::from_secs(120);
/// How long `gh` or `glab` may take to open a pull request or merge one.
const CLI_LIMIT: Duration = Duration::from_secs(60);
/// The longest title and body sent.
pub const TITLE_MAX: usize = 256;
pub const BODY_MAX: usize = 64 * 1024;
/// The most asks kept: decided ones are kept so a second answer hears "already decided", and the oldest go first.
const KEPT_MAX: usize = 200;
/// The most commit subjects a draft lists.
const DRAFT_MAX: usize = 50;

/// What the person is asked, in the shell's own words for the page to put into the person's language. `kind` is `open` (push the
/// branch and open a pull request) or `merge`. Every text in it is what will be sent.
#[derive(Clone, Debug, Serialize, PartialEq, Default)]
pub struct Ask {
    pub id: String,
    pub kind: String,
    /// `github` or `gitlab`, and the repository (`owner/repo`, or `group/sub/project`).
    pub source: String,
    pub repo: String,
    /// The remote the branch is pushed to (`origin`).
    pub remote: String,
    /// A merge's own: the repository the pull request's branch is in, as the host says it (always `repo`'s own: an ask is never
    /// made for another's), shown on the card beside the title with the head commit.
    pub from: String,
    pub branch: String,
    pub base: String,
    /// The commit of the branch the ask is about, and how many commits it has that the base on the remote lacks.
    pub head: String,
    pub commits: u32,
    /// Changed or new files in the lane's folder that are not committed, so do not go.
    pub uncommitted: u32,
    pub title: String,
    pub body: String,
    /// A merge's own: the pull request's number and address, the method (`merge`, `squash` or `rebase`), and the message's
    /// subject and body exactly as they will be sent ("" for a rebase, which makes none).
    pub number: u64,
    pub url: String,
    pub method: String,
    pub subject: String,
    pub message: String,
    /// How many agent credit lines were taken out of the message (Settings › Source control › Remove agent credits when merging).
    pub dropped: u32,
    /// A new repository's own (`kind` `repo`, item 100b): the project's folder, who can see it (`private` or `public`), and the
    /// exact command a Yes runs, as one line.
    pub folder: String,
    pub visibility: String,
    pub plan: String,
}

/// What a settled ask did. `outcome`: `declined` (the person said no; nothing ran), `opened`, `merged`, or `failed` with the
/// `step` that failed (`check`: the branch or the pull request changed since the ask; `push`; `create`; `merge`) and the CLI's
/// own last line, masked. `pushed`: the branch
/// reached the remote (a pull request that then failed to open leaves it there, and says so).
#[derive(Clone, Debug, Serialize, PartialEq, Default)]
pub struct Done {
    pub outcome: String,
    pub pushed: bool,
    pub url: String,
    pub number: u64,
    pub step: String,
    pub error: String,
}

impl Done {
    fn failed(step: &str, error: String, pushed: bool) -> Done {
        Done { outcome: "failed".into(), step: step.into(), error, pushed, ..Done::default() }
    }
}

/// What a lane would be put up with: its branch and base, and its commits' subjects (masked, newest first) for the page to offer
/// as the pull request's first words. Only reads.
#[derive(Clone, Debug, Serialize, PartialEq, Default)]
pub struct Draft {
    pub branch: String,
    pub base: String,
    pub commits: Vec<String>,
    pub count: u32,
}

/// What a Yes runs, written down when the ask was made.
#[derive(Clone, Debug)]
enum Plan {
    Open { home: PathBuf, dir: PathBuf, branch: String, head: String, push: Vec<String>, cli: PathBuf, create: Vec<String> },
    /// `lane`: the home folder and the lane's folder, when the request is a lane's (its tip is read again before the merge); none
    /// for a request of the project's that no lane of the app's made (item 100), which is bound to the head commit shown alone.
    Merge { source: Source, cli: PathBuf, view: Vec<String>, lane: Option<(PathBuf, PathBuf)>, branch: String, base: String, head: String, number: u64, url: String, merge: Vec<String> },
    /// A new project's repository on GitHub (item 100b): the project's folder, and `gh repo create`'s argv.
    Repo { home: PathBuf, dir: PathBuf, cli: PathBuf, create: Vec<String> },
}

#[derive(Clone, Copy, Debug, PartialEq)]
enum State {
    Waiting,
    Decided,
    Withdrawn,
}

struct Entry {
    plan: Plan,
    made: Instant,
    state: State,
}

/// The proof that an ask was settled with a Yes. Its field is private to this module, so only [`Ledger::settle`] makes one, and
/// the function that runs a plan cannot be called without it.
pub(crate) struct Settled(());

/// The asks of this run of the app, by id. Ids are never reused.
pub struct Ledger {
    entries: Mutex<HashMap<String, Entry>>,
    life: Duration,
    /// tests: stand-ins for `gh` and `glab` (none: the ones found on this computer)
    cli: Option<(PathBuf, PathBuf)>,
}

impl Default for Ledger {
    fn default() -> Ledger {
        Ledger { entries: Mutex::new(HashMap::new()), life: ASK_LIFE, cli: None }
    }
}

/// A fresh id: 128 random bits from the system, else a counter with the time (an id only has to be new in this run).
fn new_id() -> String {
    static N: AtomicU64 = AtomicU64::new(0);
    let mut b = [0u8; 16];
    let random = std::fs::File::open("/dev/urandom").and_then(|mut f| f.read_exact(&mut b)).is_ok();
    if !random {
        let t = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
        b[..8].copy_from_slice(&(t as u64).to_le_bytes());
        b[8..].copy_from_slice(&N.fetch_add(1, Ordering::Relaxed).to_le_bytes());
    }
    b.iter().map(|x| format!("{x:02x}")).collect()
}

fn commit_id(s: &str) -> bool {
    (s.len() == 40 || s.len() == 64) && s.bytes().all(|b| b.is_ascii_hexdigit())
}

/// The title as it will be sent: trimmed, one line, at most [`TITLE_MAX`] characters. Err(`bad_title`) for anything else.
pub fn clean_title(t: &str) -> Result<String, String> {
    let t = t.trim();
    if t.is_empty() || t.chars().count() > TITLE_MAX || t.chars().any(char::is_control) {
        return Err("bad_title".into());
    }
    Ok(t.to_string())
}

/// The body as it will be sent: line ends made `\n`, the end trimmed, at most [`BODY_MAX`] bytes, no control character but a line
/// end or a tab. Err(`bad_body`) for anything else. An empty body is a body.
pub fn clean_body(b: &str) -> Result<String, String> {
    let b = b.replace("\r\n", "\n");
    let b = b.trim_end();
    if b.len() > BODY_MAX || b.chars().any(|c| c.is_control() && c != '\n' && c != '\t') {
        return Err("bad_body".into());
    }
    Ok(b.to_string())
}

/// The push of `branch` to `remote`, after `git` (and its own `-C` and `-c`): the branch's own ref to the same name there, no
/// `+`, no flag that forces, deletes, mirrors or sends tags, and no submodule pushed. `push.followTags` is turned off for this one
/// call, since a setting of the person's would otherwise send tags too.
pub fn push_argv(remote: &str, branch: &str) -> Result<Vec<String>, String> {
    if !safe_rev(remote) || !lane::valid_name(branch) {
        return Err("bad_name".into());
    }
    let refspec = format!("refs/heads/{branch}:refs/heads/{branch}");
    Ok(["-c", "push.followTags=false", "push", "--recurse-submodules=no", remote, &refspec].iter().map(|s| s.to_string()).collect())
}

/// The argv (after `gh` or `glab`) that opens the pull / merge request of `branch` into `base` with `title` and `body`, exactly.
/// The texts are passed as `--flag=<text>`, so a text that starts with `-` is never read as a flag. The branch is named, so the
/// CLI pushes and forks nothing; glab is told not to push and not to remove the branch when it merges.
pub fn create_argv(source: Source, repo: &str, branch: &str, base: &str, title: &str, body: &str) -> Result<Vec<String>, String> {
    let repo = tasks::check_repo(source, repo)?;
    if !lane::valid_name(branch) || !safe_rev(base) {
        return Err("bad_name".into());
    }
    let s = |x: &str| x.to_string();
    Ok(match source {
        Source::Github => vec![s("pr"), s("create"), s("--repo"), repo, s("--base"), s(base), s("--head"), s(branch), format!("--title={title}"), format!("--body={body}")],
        Source::Gitlab => vec![
            s("mr"),
            s("create"),
            s("--repo"),
            repo,
            s("--source-branch"),
            s(branch),
            s("--target-branch"),
            s(base),
            format!("--title={title}"),
            format!("--description={body}"),
            s("--yes"),
            s("--push=false"),
            s("--remove-source-branch=false"),
        ],
    })
}

/// The pull request's address and number in what the CLI printed: the first https address with `/pull/<n>` or
/// `/merge_requests/<n>` in it.
pub fn read_created(out: &str) -> (String, u64) {
    for w in out.split_whitespace() {
        let u = tasks::web_url(w.trim_end_matches(['.', ',', ')']));
        for mark in ["/pull/", "/merge_requests/"] {
            if let Some(n) = u.rsplit_once(mark).and_then(|(_, n)| n.split(['/', '?', '#']).next()).and_then(|n| n.parse::<u64>().ok()) {
                return (u, n);
            }
        }
    }
    (String::new(), 0)
}

/// A new repository's name as `gh repo create` takes it: `name`, or `owner/name` for an organisation's, each part letters, digits,
/// `.`, `_` and `-`, at most 100, never starting with `-` or `.`. Err(`bad_repo_name`) for anything else.
pub fn repo_name(name: &str) -> Result<String, String> {
    let name = name.trim();
    let parts: Vec<&str> = name.split('/').collect();
    if parts.is_empty() || parts.len() > 2 || !parts.iter().all(|p| tasks::segment_ok(p)) {
        return Err("bad_repo_name".into());
    }
    Ok(name.to_string())
}

/// The argv (after `gh`) that makes the GitHub repository `name` from the project at `folder`, private unless `public`, with the
/// new repository as the folder's `origin`. It pushes nothing: no `--push`.
pub fn repo_argv(name: &str, public: bool, folder: &Path) -> Result<Vec<String>, String> {
    let name = repo_name(name)?;
    let dir = folder.to_str().filter(|d| folder.is_absolute() && !d.chars().any(char::is_control)).ok_or("bad_path")?;
    let s = |x: &str| x.to_string();
    Ok(vec![s("repo"), s("create"), name, s(if public { "--public" } else { "--private" }), s("--source"), s(dir), s("--remote"), s("origin")])
}

/// A command as one line a person can read and a shell would run as the same words: each word as it is when it is plain, else in
/// single quotes (a `'` in it written `'\''`).
pub fn plan_line(program: &str, argv: &[String]) -> String {
    let plain = |w: &str| !w.is_empty() && w.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'/' | b'=' | b':' | b'@' | b'+' | b','));
    std::iter::once(program.to_string()).chain(argv.iter().map(|w| if plain(w) { w.clone() } else { format!("'{}'", w.replace('\'', "'\\''")) })).collect::<Vec<_>>().join(" ")
}

/// The new repository's address in what `gh repo create` printed: the first `https://github.com/<owner>/<name>` in it.
pub fn read_repo_url(out: &str) -> String {
    for w in out.split_whitespace() {
        let u = tasks::web_url(w.trim_end_matches(['.', ',', ')']).trim_end_matches(".git"));
        if let Some(path) = u.strip_prefix("https://github.com/") {
            let parts: Vec<&str> = path.split('/').collect();
            if parts.len() == 2 && parts.iter().all(|p| tasks::segment_ok(p)) {
                return u;
            }
        }
    }
    String::new()
}

/// Whether `dir` is a repository's own top folder (its `.git` a real folder, not a link and not a worktree's file) with no remote
/// named `origin` yet: Err(`not_a_repository`) or Err(`has_origin`).
fn bare_project(git: &Git, dir: &Path) -> Result<(), String> {
    let dot = std::fs::symlink_metadata(dir.join(".git")).map_err(|_| "not_a_repository".to_string())?;
    if !dot.is_dir() || dot.file_type().is_symlink() {
        return Err("not_a_repository".into());
    }
    if git.line(dir, &["config", "--get", "remote.origin.url"]).is_some() {
        return Err("has_origin".into());
    }
    Ok(())
}

/// How a pull request is merged. Every one is asked; there is no automatic one.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Method {
    Merge,
    Squash,
    Rebase,
}

impl Method {
    pub fn parse(s: &str) -> Result<Method, String> {
        match s {
            "merge" => Ok(Method::Merge),
            "squash" => Ok(Method::Squash),
            "rebase" => Ok(Method::Rebase),
            _ => Err("bad_method".into()),
        }
    }
    fn word(self) -> &'static str {
        match self {
            Method::Merge => "merge",
            Method::Squash => "squash",
            Method::Rebase => "rebase",
        }
    }
}

/// What a pull request is, as `gh pr view` or `glab mr view` answers it: only what the ask and the merge read.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Pull {
    pub number: u64,
    pub title: String,
    pub body: String,
    pub open: bool,
    pub draft: bool,
    /// None: it can merge now; else why not (`conflicts`, `behind`, `blocked`, `checking`, `draft`, `closed`).
    pub cannot: Option<String>,
    pub head_branch: String,
    pub head: String,
    pub base: String,
    /// The owner of the repository the branch is in (GitHub), for the merge commit's subject.
    pub owner: String,
    /// Whether the host says the branch is in the very repository the pull request is in (GitHub's `isCrossRepository` false
    /// with its head repository the base's; GitLab's `source_project_id` equal to `target_project_id`). False when it is a
    /// fork's, and when the host did not say.
    pub same_repo: bool,
    /// The repository the branch is in, `owner/repo`, as GitHub names it ("" for GitLab, whose answer names only the id).
    pub from: String,
    /// The commits' headlines and bodies, oldest first (GitHub; GitLab's view lists none).
    pub commits: Vec<(String, String)>,
    pub url: String,
}

/// The fields `gh pr view` is asked for.
const GH_VIEW: &str = "number,title,body,state,isDraft,mergeable,mergeStateStatus,headRefName,headRefOid,baseRefName,headRepositoryOwner,headRepository,isCrossRepository,commits,url";

/// The argv (after `gh` or `glab`) that reads pull request `number` of `repo`. A read: tasks.rs's view, with the fields a merge
/// needs.
pub fn view_argv(source: Source, repo: &str, number: u64) -> Result<Vec<String>, String> {
    let repo = tasks::check_repo(source, repo)?;
    if number == 0 || number > 100_000_000 {
        return Err("bad_number".into());
    }
    let s = |x: &str| x.to_string();
    Ok(match source {
        Source::Github => vec![s("pr"), s("view"), number.to_string(), s("--repo"), repo, s("--json"), s(GH_VIEW)],
        Source::Gitlab => vec![s("mr"), s("view"), number.to_string(), s("--repo"), repo, s("--output"), s("json")],
    })
}

/// A text of the CLI's answer as it will be shown and sent: control characters out but line ends and tabs, anything token-like
/// masked (tasks.rs's one masker), at most [`BODY_MAX`] bytes.
fn pr_text(v: &serde_json::Value, k: &str) -> String {
    let mut t = tasks::text(v, k).replace("\r\n", "\n");
    if t.len() > BODY_MAX {
        let mut at = BODY_MAX;
        while !t.is_char_boundary(at) {
            at -= 1;
        }
        t.truncate(at);
    }
    t.trim_end().to_string()
}

/// A pull request out of the CLI's answer. GitHub's `mergeable` and `mergeStateStatus` are its GraphQL enums: it can merge now
/// only when `mergeable` is `MERGEABLE` and the state is `CLEAN`, `HAS_HOOKS` or `UNSTABLE` (non-required checks failing); `BLOCKED`
/// would make gh turn on auto-merge instead, so it is refused. GitLab's `detailed_merge_status` must be `mergeable`.
pub fn read_pull(source: Source, out: &str) -> Result<Pull, String> {
    let v: serde_json::Value = serde_json::from_str(out.trim()).map_err(|_| "unread".to_string())?;
    if !v.is_object() {
        return Err("unread".into());
    }
    let word = |k: &str| v.get(k).and_then(serde_json::Value::as_str).unwrap_or("").to_string();
    let mut p = match source {
        Source::Github => {
            let draft = v.get("isDraft").and_then(serde_json::Value::as_bool).unwrap_or(false);
            let open = word("state").eq_ignore_ascii_case("OPEN");
            let state = word("mergeStateStatus").to_ascii_uppercase();
            let mergeable = word("mergeable").to_ascii_uppercase();
            let cannot = if !open {
                Some("closed")
            } else if draft || state == "DRAFT" {
                Some("draft")
            } else if mergeable == "CONFLICTING" || state == "DIRTY" {
                Some("conflicts")
            } else if state == "BEHIND" {
                Some("behind")
            } else if state == "BLOCKED" {
                Some("blocked")
            } else if mergeable != "MERGEABLE" || !matches!(state.as_str(), "CLEAN" | "HAS_HOOKS" | "UNSTABLE") {
                Some("checking")
            } else {
                None
            };
            let commits = v
                .get("commits")
                .and_then(serde_json::Value::as_array)
                .map(|cs| cs.iter().map(|c| (tasks::one_line(pr_text(c, "messageHeadline"), 300), pr_text(c, "messageBody"))).filter(|(h, _)| !h.is_empty()).collect())
                .unwrap_or_default();
            let url = tasks::web_url(&word("url"));
            let owner = v.get("headRepositoryOwner").map(|o| tasks::text(o, "login")).unwrap_or_default();
            let (from, same_repo) = tasks::gh_from(&v, &url);
            Pull {
                number: v.get("number").and_then(serde_json::Value::as_u64).unwrap_or(0),
                title: tasks::one_line(pr_text(&v, "title"), 300),
                body: pr_text(&v, "body"),
                open,
                draft,
                cannot: cannot.map(str::to_string),
                head_branch: word("headRefName"),
                head: word("headRefOid"),
                base: word("baseRefName"),
                owner,
                same_repo,
                from,
                commits,
                url,
            }
        }
        Source::Gitlab => {
            let draft = v.get("draft").and_then(serde_json::Value::as_bool).unwrap_or(false) || v.get("work_in_progress").and_then(serde_json::Value::as_bool).unwrap_or(false);
            let open = word("state") == "opened";
            let status = word("detailed_merge_status");
            let cannot = if !open {
                Some("closed")
            } else if draft || status == "draft_status" {
                Some("draft")
            } else if status == "mergeable" {
                None
            } else if status == "conflict" || v.get("has_conflicts").and_then(serde_json::Value::as_bool).unwrap_or(false) {
                Some("conflicts")
            } else if status == "need_rebase" {
                Some("behind")
            } else if matches!(status.as_str(), "checking" | "unchecked" | "") {
                Some("checking")
            } else {
                Some("blocked")
            };
            Pull {
                number: v.get("iid").and_then(serde_json::Value::as_u64).unwrap_or(0),
                title: tasks::one_line(pr_text(&v, "title"), 300),
                body: pr_text(&v, "description"),
                open,
                draft,
                cannot: cannot.map(str::to_string),
                head_branch: word("source_branch"),
                head: word("sha"),
                base: word("target_branch"),
                owner: String::new(),
                same_repo: tasks::gl_same_project(&v),
                from: String::new(),
                commits: vec![],
                url: tasks::web_url(&word("web_url")),
            }
        }
    };
    if p.number == 0 || !commit_id(&p.head) || !lane::valid_name(&p.head_branch) || !safe_rev(&p.base) {
        return Err("unread".into());
    }
    if p.owner.chars().any(|c| !(c.is_ascii_alphanumeric() || c == '-' || c == '_')) {
        p.owner.clear();
    }
    Ok(p)
}

/// The merge's message as the app proposes it, before any credit line is taken out: (subject, body). GitHub's own defaults, so
/// it reads as a merge made on the site would: a merge commit is `Merge pull request #<n> from <owner>/<branch>` with the
/// title and description; a squash is `<title> (#<n>)` with each commit's message. GitLab's: `Merge branch '<branch>' into
/// '<base>'` with the title, the description and the request; a squash is the title and the description. A rebase has none.
pub fn message_for(source: Source, method: Method, repo: &str, p: &Pull) -> (String, String) {
    let join = |parts: &[&str]| parts.iter().filter(|x| !x.is_empty()).copied().collect::<Vec<_>>().join("\n\n");
    match (source, method) {
        (_, Method::Rebase) => (String::new(), String::new()),
        (Source::Github, Method::Merge) => {
            let from = if p.owner.is_empty() { p.head_branch.clone() } else { format!("{}/{}", p.owner, p.head_branch) };
            (format!("Merge pull request #{} from {from}", p.number), join(&[&p.title, &p.body]))
        }
        (Source::Github, Method::Squash) => {
            let commits: Vec<String> = p.commits.iter().map(|(h, b)| if b.is_empty() { format!("* {h}") } else { format!("* {h}\n\n{b}") }).collect();
            let body = if commits.is_empty() { p.body.clone() } else { commits.join("\n\n") };
            (format!("{} (#{})", p.title, p.number), body)
        }
        (Source::Gitlab, Method::Merge) => {
            let see = format!("See merge request {repo}!{}", p.number);
            (format!("Merge branch '{}' into '{}'", p.head_branch, p.base), join(&[&p.title, &p.body, &see]))
        }
        (Source::Gitlab, Method::Squash) => (p.title.clone(), p.body.clone()),
    }
}

/// The argv (after `gh` or `glab`) that merges pull request `number` with `method`, bound to commit `head`, with the message as
/// given. Never `--auto`, `--admin`, `--delete-branch` or glab's `--remove-source-branch`; glab's auto-merge is turned off,
/// which it otherwise turns on while a pipeline runs. A rebase sends no message.
pub fn merge_argv(source: Source, repo: &str, number: u64, method: Method, head: &str, subject: &str, body: &str) -> Result<Vec<String>, String> {
    let repo = tasks::check_repo(source, repo)?;
    if number == 0 || !commit_id(head) {
        return Err("bad_number".into());
    }
    let s = |x: &str| x.to_string();
    Ok(match source {
        Source::Github => {
            let mut a = vec![s("pr"), s("merge"), number.to_string(), s("--repo"), repo, format!("--{}", method.word()), s("--match-head-commit"), s(head)];
            if method != Method::Rebase {
                a.extend([format!("--subject={subject}"), format!("--body={body}")]);
            }
            a
        }
        Source::Gitlab => {
            let mut a = vec![s("mr"), s("merge"), number.to_string(), s("--repo"), repo, s("--yes"), s("--auto-merge=false")];
            let message = if body.is_empty() { subject.to_string() } else { format!("{subject}\n\n{body}") };
            match method {
                Method::Merge => a.extend([s("--sha"), s(head), format!("--message={message}")]),
                // one text for both commits GitLab may make (the squashed one, and a merge commit if the project makes those)
                Method::Squash => a.extend([s("--squash"), s("--sha"), s(head), format!("--squash-message={message}"), format!("--message={message}")]),
                // GitLab's rebase takes no commit to match: the run reads the request again just before, instead
                Method::Rebase => a.push(s("--rebase")),
            }
            a
        }
    })
}

/// Whether pull request head `head` is all of the lane's work and only it: the lane's branch tip on this Mac, and the tip this
/// Mac last pushed (its remote-tracking branch), are both that commit. Err says which way it is not: `lane_ahead` (the lane has
/// commits the pull request does not hold: they would not be merged), `pull_ahead` (the pull request holds commits the lane
/// does not, or other ones), `not_pushed` (this Mac has no record of the lane's tip going to the remote).
fn lane_holds(l: &Lane, head: &str) -> Result<(), String> {
    let branch = &l.rec.branch;
    let local = l.git.line(&l.wt, &["rev-parse", "--verify", "--quiet", &format!("refs/heads/{branch}^{{commit}}")]).filter(|h| commit_id(h)).ok_or("unread")?;
    if local != head {
        // the pull request's head is an older commit of the lane's own: the lane went on since
        let older = commit_id(head) && l.git.run(&l.wt, &["merge-base", "--is-ancestor", head, &local]).is_ok_and(|r| r.code == Some(0));
        return Err(if older { "lane_ahead" } else { "pull_ahead" }.into());
    }
    let pushed = l.git.line(&l.wt, &["rev-parse", "--verify", "--quiet", &format!("refs/remotes/{}/{branch}^{{commit}}", l.remote)]);
    if pushed.as_deref() != Some(head) {
        return Err("not_pushed".into());
    }
    Ok(())
}

/// Pull request `number` of `repo`, read now for a merge's ask: the view's argv (kept in the plan to read it again) and what it
/// answered.
fn read_for_merge(source: Source, repo: &str, cli: &Path, number: u64) -> Result<(Vec<String>, Pull), String> {
    let view = view_argv(source, repo, number)?;
    let ran = tasks::run_env_for(cli, &view, true, &[], &[], CLI_LIMIT)?;
    if ran.code != Some(0) {
        return Err(tasks::error_line(&ran.err));
    }
    let p = read_pull(source, &ran.out)?;
    Ok((view, p))
}

/// The folder of the app's lane on `branch` of the repository `dir` is in, while that folder is there (item 100: a request
/// from it is merged by the lane's own ask).
fn lane_on(home: &Path, dir: &Path, branch: &str) -> Option<String> {
    let repo = Git::new(home).ok()?.common_dir(dir)?;
    lane::records(home).into_iter().map(|(_, r)| r).find(|r| real(Path::new(&r.repo)) == repo && r.branch == branch && Path::new(&r.worktree).is_dir()).map(|r| r.worktree)
}

/// What every ask reads of a lane first: the app's own folder, there, a worktree of its recorded repository on the lane's own
/// branch, with a GitHub or GitLab remote and that CLI installed and signed in.
struct Lane {
    git: Git,
    wt: PathBuf,
    rec: lane::Record,
    source: Source,
    repo: String,
    remote: String,
    cli: PathBuf,
}

impl Ledger {
    /// tests: a ledger whose `gh` and `glab` are stand-ins, and whose asks wait `life`.
    #[cfg(test)]
    fn with(gh: PathBuf, glab: PathBuf, life: Duration) -> Ledger {
        Ledger { entries: Mutex::new(HashMap::new()), life, cli: Some((gh, glab)) }
    }

    fn cli(&self, source: Source) -> Option<PathBuf> {
        match &self.cli {
            Some((gh, glab)) => Some(if source == Source::Github { gh.clone() } else { glab.clone() }).filter(|p| p.is_file()),
            None => tasks::find(source.program()),
        }
    }

    fn lane(&self, home: &Path, worktree: &str) -> Result<Lane, String> {
        let (wt, _, rec) = lane::own_lane(home, worktree)?;
        let git = Git::new(home)?;
        if !wt.is_dir() {
            return Err("gone".into());
        }
        let repo_dir = real(Path::new(&rec.repo));
        let ours = git.common_dir(&wt).as_ref() == Some(&repo_dir) && git.worktrees(&repo_dir).is_some_and(|l| l.contains(&real(&wt)) && l.first() != Some(&real(&wt)));
        if !ours {
            return Err("not_a_lane".into());
        }
        if crate::git_branch::branch(&wt) != rec.branch {
            return Err("moved".into());
        }
        let found = tasks::folder_remote(&wt).ok_or("no_remote")?;
        let source = Source::parse(&found.source)?;
        let remote = remote_name(&git, &wt).ok_or("no_remote")?;
        // a remote set up as a mirror pushes every ref, deletes and all, whatever refspec is named: never one of those
        if git.line(&wt, &["config", "--bool", "--get", &format!("remote.{remote}.mirror")]).as_deref() == Some("true") {
            return Err("mirror_remote".into());
        }
        let cli = self.cli(source).ok_or("not_installed")?;
        let signed = tasks::run_env(&cli, &tasks::auth_argv(source), false, &[], &[]).is_ok_and(|r| r.code == Some(0));
        if !signed {
            return Err("not_signed_in".into());
        }
        Ok(Lane { git, wt, rec, source, repo: found.repo, remote, cli })
    }

    fn keep(&self, plan: Plan) -> String {
        let id = new_id();
        let mut m = self.entries.lock().unwrap_or_else(|e| e.into_inner());
        if m.len() >= KEPT_MAX {
            // the oldest answered or withdrawn asks go first; a waiting one is kept until it expires
            let life = self.life;
            m.retain(|_, e| e.state == State::Waiting && e.made.elapsed() <= life);
        }
        m.insert(id.clone(), Entry { plan, made: Instant::now(), state: State::Waiting });
        id
    }

    /// What the lane at `worktree` would be put up with (see [`Draft`]). Only reads.
    pub fn draft(&self, home: &Path, worktree: &str) -> Result<Draft, String> {
        let (wt, _, rec) = lane::own_lane(home, worktree)?;
        let git = Git::new(home)?;
        if !wt.is_dir() {
            return Err("gone".into());
        }
        let remote = remote_name(&git, &wt);
        let on_remote = remote.as_ref().map(|r| format!("refs/remotes/{r}/{}", rec.base)).filter(|r| git.line(&wt, &["rev-parse", "--verify", "--quiet", &format!("{r}^{{commit}}")]).is_some());
        let from = on_remote.unwrap_or_else(|| rec.at.clone());
        if !safe_rev(&rec.base) || !lane::valid_name(&rec.branch) {
            return Err("bad_name".into());
        }
        let range = format!("{from}..refs/heads/{}", rec.branch);
        let ran = git.run(&wt, &["log", "--no-color", "--format=%s", "-n", &DRAFT_MAX.to_string(), &range])?;
        let commits: Vec<String> = if ran.code == Some(0) { ran.out.lines().map(|l| tasks::one_line(tasks::mask_secrets(l), 200)).filter(|l| !l.is_empty()).collect() } else { vec![] };
        let count = git.line(&wt, &["rev-list", "--count", &range]).and_then(|n| n.parse().ok()).unwrap_or(commits.len() as u32);
        Ok(Draft { branch: rec.branch, base: rec.base, commits, count })
    }

    /// Asks to push the lane at `worktree` and open its pull request into the branch it was made from, with `title` and `body`.
    /// Writes nothing: the answer is the ask, and only [`Ledger::settle`] with its id and a Yes runs it.
    pub fn ask_open(&self, home: &Path, worktree: &str, title: &str, body: &str) -> Result<Ask, String> {
        let l = self.lane(home, worktree)?;
        let (branch, base) = (l.rec.branch.clone(), l.rec.base.clone());
        // the base must be a branch the remote has: a lane made from a detached commit has none to go into
        let remote_base = format!("refs/remotes/{}/{base}", l.remote);
        if !safe_rev(&base) || l.git.line(&l.wt, &["rev-parse", "--verify", "--quiet", &format!("{remote_base}^{{commit}}")]).is_none() {
            return Err("base_not_on_remote".into());
        }
        let head = l.git.line(&l.wt, &["rev-parse", "--verify", "--quiet", &format!("refs/heads/{branch}^{{commit}}")]).filter(|h| commit_id(h)).ok_or("unread")?;
        let commits: u32 = l.git.line(&l.wt, &["rev-list", "--count", &format!("{remote_base}..{head}")]).and_then(|n| n.parse().ok()).ok_or("unread")?;
        if commits == 0 {
            return Err("no_commits".into());
        }
        let title = clean_title(title)?;
        let body = clean_body(body)?;
        let push = push_argv(&l.remote, &branch)?;
        let create = create_argv(l.source, &l.repo, &branch, &base, &title, &body)?;
        let uncommitted = l.git.changed(&l.wt).unwrap_or(0);
        let plan = Plan::Open { home: home.to_path_buf(), dir: l.wt.clone(), branch: branch.clone(), head: head.clone(), push, cli: l.cli.clone(), create };
        let id = self.keep(plan);
        Ok(Ask {
            id,
            kind: "open".into(),
            source: if l.source == Source::Github { "github" } else { "gitlab" }.into(),
            repo: l.repo,
            remote: l.remote,
            branch,
            base,
            head,
            commits,
            uncommitted,
            title,
            body,
            ..Ask::default()
        })
    }

    /// Asks to merge pull request `number`, made from the lane at `worktree`, with `method`: it reads the pull request now, and
    /// asks only when it is open, not a draft, made from the lane's own branch and can merge now; the answer names the method and
    /// the message exactly as they will be sent. Writes nothing: only [`Ledger::settle`] with its id and a Yes runs it.
    ///
    /// `credits`: the person turned on Remove agent credits when merging, so the proposed message has the recognised agent credit
    /// lines taken out (credits.rs), every human co-author kept. The ask shows the message after that, which is the message sent.
    pub fn ask_merge(&self, home: &Path, worktree: &str, number: u64, method: &str, credits: bool) -> Result<Ask, String> {
        let method = Method::parse(method)?;
        let l = self.lane(home, worktree)?;
        let (view, p) = read_for_merge(l.source, &l.repo, &l.cli, number)?;
        if p.number != number || p.head_branch != l.rec.branch {
            return Err("not_this_lane".into());
        }
        // a fork's branch can have the lane's name (it is public once pushed): only this repository's own branch is the lane's
        if !p.same_repo {
            return Err("other_repo".into());
        }
        if let Some(why) = &p.cannot {
            return Err(format!("cannot_merge:{why}"));
        }
        // what merges is the lane's own work, all of it: the pull request's head is the lane's tip here and as this Mac pushed it
        lane_holds(&l, &p.head)?;
        let lane = Some((home.to_path_buf(), l.wt.clone()));
        self.merge_ask(l.source, l.repo, l.remote, &l.cli, view, p, method, credits, lane)
    }

    /// Asks to merge request `number` of `repo`, a project's of the person's, from the Pull requests list (item 100), with
    /// `method`. It is the lane's own ask, plan and run for the same request:
    ///
    /// - `folder` is the project the list read it for, and its remote must name `repo` on `source`: a request of any other
    ///   repository is refused (`not_this_project`) before anything is asked.
    /// - The request is read now. Its branch must be this very repository's own (`other_repo` for a fork's, item 86), and when a
    ///   lane of the app's is on that branch (its folder still here), the ask is that lane's own Merge ([`Ledger::ask_merge`]),
    ///   with every check of its tip.
    /// - Otherwise the request must be able to merge now, with a method the repository allows (`method_not_allowed`, when GitHub
    ///   says so; GitLab's is the host's to refuse), and the ask names its repository and branch, the method and exactly the
    ///   message. The merge is bound to the head commit shown, and just before it runs the request is read again, as a lane's is.
    ///
    /// Writes nothing: only [`Ledger::settle`] with its id and a Yes runs it.
    #[allow(clippy::too_many_arguments)]
    pub fn ask_merge_pull(&self, home: &Path, folder: &str, source: &str, repo: &str, number: u64, method: &str, credits: bool) -> Result<Ask, String> {
        let method = Method::parse(method)?;
        let source = Source::parse(source).map_err(|_| "bad_name".to_string())?;
        let repo = tasks::check_repo(source, repo).map_err(|_| "bad_name".to_string())?;
        let dir = Path::new(folder);
        if !dir.is_absolute() || !dir.is_dir() {
            return Err("gone".into());
        }
        // the repository is the project's own: what its folder's remote names, never a name the page sends alone
        let found = tasks::folder_remote(dir).ok_or("no_remote")?;
        if Source::parse(&found.source)? != source || !found.repo.eq_ignore_ascii_case(&repo) {
            return Err("not_this_project".into());
        }
        let cli = self.cli(source).ok_or("not_installed")?;
        let signed = tasks::run_env(&cli, &tasks::auth_argv(source), false, &[], &[]).is_ok_and(|r| r.code == Some(0));
        if !signed {
            return Err("not_signed_in".into());
        }
        let (view, p) = read_for_merge(source, &repo, &cli, number)?;
        if p.number != number {
            return Err("unread".into());
        }
        if !p.same_repo {
            return Err("other_repo".into());
        }
        if let Some(worktree) = lane_on(home, dir, &p.head_branch) {
            return self.ask_merge(home, &worktree, number, method.word(), credits);
        }
        if let Some(why) = &p.cannot {
            return Err(format!("cannot_merge:{why}"));
        }
        if source == Source::Github {
            let allowed = crate::pulls::methods_argv(&repo)
                .ok()
                .and_then(|a| tasks::run_env_for(&cli, &a, true, &[], &[], CLI_LIMIT).ok())
                .filter(|r| r.code == Some(0))
                .map(|r| crate::pulls::parse_methods(&r.out))
                .unwrap_or_default();
            if !allowed.allows(method.word()) {
                return Err("method_not_allowed".into());
            }
        }
        let remote = Git::new(home).ok().and_then(|g| remote_name(&g, dir)).unwrap_or_default();
        self.merge_ask(source, repo, remote, &cli, view, p, method, credits, None)
    }

    /// The ask both Merges make once the request was read and checked: the message as GitHub or GitLab would write it, with the
    /// recognised agent credit lines taken out when `credits`, the merge's argv bound to the head commit shown, and the plan kept.
    #[allow(clippy::too_many_arguments)]
    fn merge_ask(&self, source: Source, repo: String, remote: String, cli: &Path, view: Vec<String>, p: Pull, method: Method, credits: bool, lane: Option<(PathBuf, PathBuf)>) -> Result<Ask, String> {
        let number = p.number;
        let (subject, mut message) = message_for(source, method, &repo, &p);
        let mut dropped = 0;
        if credits && method != Method::Rebase {
            let (cleaned, n) = crate::credits::remove_agent_credits(&message);
            dropped = n;
            // an empty message would let the host write its own, which brings the credits back: the title stands in, as T3 Code does
            message = if n > 0 && cleaned.trim().is_empty() { p.title.clone() } else { cleaned };
        }
        let merge = merge_argv(source, &repo, number, method, &p.head, &subject, &message)?;
        let plan = Plan::Merge {
            source,
            cli: cli.to_path_buf(),
            view,
            lane,
            branch: p.head_branch.clone(),
            base: p.base.clone(),
            head: p.head.clone(),
            number,
            url: p.url.clone(),
            merge,
        };
        let id = self.keep(plan);
        let from = if p.from.is_empty() { repo.clone() } else { p.from.clone() };
        Ok(Ask {
            id,
            kind: "merge".into(),
            source: if source == Source::Github { "github" } else { "gitlab" }.into(),
            repo,
            remote,
            from,
            branch: p.head_branch,
            base: p.base,
            head: p.head,
            commits: p.commits.len() as u32,
            uncommitted: 0,
            title: p.title,
            body: p.body,
            number,
            url: p.url,
            method: method.word().into(),
            subject,
            message,
            dropped,
            ..Ask::default()
        })
    }

    /// Asks to make the GitHub repository `name` from the new project at `folder` (item 100b), private unless `public`. It checks
    /// the folder (absolute, in the person's home, a repository's own top with no `origin`), the name, and that gh is here and
    /// signed in, and answers the ask with the exact command a Yes runs. Writes nothing: only [`Ledger::settle`] with its id and a
    /// Yes runs it.
    pub fn ask_repo(&self, home: &Path, folder: &str, name: &str, public: bool) -> Result<Ask, String> {
        let p = crate::new_project::path_ok(folder)?;
        let dir = p.canonicalize().map_err(|_| "gone".to_string())?;
        let real_home = home.canonicalize().map_err(|_| "gone".to_string())?;
        if dir == real_home || !dir.starts_with(&real_home) || !dir.is_dir() {
            return Err("outside_home".into());
        }
        let name = repo_name(name)?;
        let git = Git::new(home)?;
        bare_project(&git, &dir)?;
        let cli = self.cli(Source::Github).ok_or("not_installed")?;
        let signed = tasks::run_env(&cli, &tasks::auth_argv(Source::Github), false, &[], &[]).is_ok_and(|r| r.code == Some(0));
        if !signed {
            return Err("not_signed_in".into());
        }
        let create = repo_argv(&name, public, &dir)?;
        let plan = plan_line("gh", &create);
        let id = self.keep(Plan::Repo { home: home.to_path_buf(), dir: dir.clone(), cli, create });
        Ok(Ask {
            id,
            kind: "repo".into(),
            source: "github".into(),
            repo: name,
            remote: "origin".into(),
            folder: dir.to_string_lossy().into_owned(),
            visibility: if public { "public" } else { "private" }.into(),
            plan,
            ..Ask::default()
        })
    }

    /// The person's answer to ask `id`, as approval-core settled it on the page. The ask leaves waiting here before anything runs,
    /// so it is answered once: a second answer is `already_decided`, an ask taken back is `withdrawn`, one past [`ASK_LIFE`] is
    /// `expired`, one this run never made is `not_found`. A No runs nothing; a Yes runs what the ask named, once.
    pub fn settle(&self, id: &str, yes: bool) -> Result<Done, String> {
        let plan = {
            let mut m = self.entries.lock().unwrap_or_else(|e| e.into_inner());
            let e = m.get_mut(id).ok_or("not_found")?;
            match e.state {
                State::Decided => return Err("already_decided".into()),
                State::Withdrawn => return Err("withdrawn".into()),
                State::Waiting => {}
            }
            if e.made.elapsed() > self.life {
                e.state = State::Withdrawn;
                return Err("expired".into());
            }
            e.state = State::Decided;
            if !yes {
                return Ok(Done { outcome: "declined".into(), ..Done::default() });
            }
            e.plan.clone()
        };
        Ok(run(Settled(()), &plan))
    }

    /// Takes a waiting ask back (the person closed it or changed what it asks): a later answer to it runs nothing.
    pub fn withdraw(&self, id: &str) {
        let mut m = self.entries.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(e) = m.get_mut(id).filter(|e| e.state == State::Waiting) {
            e.state = State::Withdrawn;
        }
    }
}

/// Runs a settled Yes: the one place a push, a pull request or a merge happens.
fn run(_settled: Settled, plan: &Plan) -> Done {
    match plan {
        Plan::Open { home, dir, branch, head, push, cli, create } => {
            let Ok(git) = Git::new(home) else { return Done::failed("check", "git_missing".into(), false) };
            // what the person saw go is what goes: a commit made since the ask was not in it
            let now = git.line(dir, &["rev-parse", "--verify", "--quiet", &format!("refs/heads/{branch}^{{commit}}")]);
            if now.as_deref() != Some(head.as_str()) || crate::git_branch::branch(dir) != *branch {
                return Done::failed("check", "changed".into(), false);
            }
            let env = lane::net_env(&git, dir);
            let env: Vec<(&str, &str)> = env.iter().map(|(k, v)| (*k, v.as_str())).collect();
            let args: Vec<&str> = push.iter().map(String::as_str).collect();
            match git.run_with(dir, &args, PUSH_LIMIT, &env) {
                Ok(r) if r.code == Some(0) => {}
                Ok(r) => return Done::failed("push", tasks::error_line(&r.err), false),
                Err(e) => return Done::failed("push", tasks::error_line(&e), false),
            }
            match tasks::run_env_for(cli, create, true, &[], &[], CLI_LIMIT) {
                Ok(r) if r.code == Some(0) => {
                    let (url, number) = read_created(&r.out);
                    Done { outcome: "opened".into(), pushed: true, url, number, ..Done::default() }
                }
                Ok(r) => Done::failed("create", tasks::error_line(if r.err.trim().is_empty() { &r.out } else { &r.err }), true),
                Err(e) => Done::failed("create", tasks::error_line(&e), true),
            }
        }
        Plan::Merge { source, cli, view, lane, branch, base, head, number, url, merge } => {
            // the pull request is read again: still this repository's own branch, still open and able to merge, still at the
            // commit the person saw, and still into the base the ask named (a retarget would merge into a branch it never named)
            let now = tasks::run_env_for(cli, view, true, &[], &[], CLI_LIMIT).ok().filter(|r| r.code == Some(0)).and_then(|r| read_pull(*source, &r.out).ok());
            match now {
                Some(p) if p.head == *head && p.cannot.is_none() && p.base == *base && p.same_repo && p.head_branch == *branch => {}
                Some(_) => return Done::failed("check", "changed".into(), false),
                None => return Done::failed("check", "unread".into(), false),
            }
            // and the lane, when it is a lane's: a commit made since the ask would be left out of what merges
            if let Some((home, dir)) = lane {
                let Ok(git) = Git::new(home) else { return Done::failed("check", "git_missing".into(), false) };
                let tip = git.line(dir, &["rev-parse", "--verify", "--quiet", &format!("refs/heads/{branch}^{{commit}}")]);
                if tip.as_deref() != Some(head.as_str()) {
                    return Done::failed("check", "changed".into(), false);
                }
            }
            match tasks::run_env_for(cli, merge, true, &[], &[], CLI_LIMIT) {
                Ok(r) if r.code == Some(0) => Done { outcome: "merged".into(), url: url.clone(), number: *number, ..Done::default() },
                Ok(r) => Done::failed("merge", tasks::error_line(if r.err.trim().is_empty() { &r.out } else { &r.err }), false),
                Err(e) => Done::failed("merge", tasks::error_line(&e), false),
            }
        }
        Plan::Repo { home, dir, cli, create } => {
            // the folder is still the new project the person saw: a repository's own, with no `origin` set since
            let Ok(git) = Git::new(home) else { return Done::failed("check", "git_missing".into(), false) };
            if bare_project(&git, dir).is_err() {
                return Done::failed("check", "changed".into(), false);
            }
            match tasks::run_env_for(cli, create, true, &[], &[], CLI_LIMIT) {
                Ok(r) if r.code == Some(0) => Done { outcome: "created".into(), url: read_repo_url(&format!("{}\n{}", r.out, r.err)), ..Done::default() },
                Ok(r) => Done::failed("create", tasks::error_line(if r.err.trim().is_empty() { &r.out } else { &r.err }), false),
                Err(e) => Done::failed("create", tasks::error_line(&e), false),
            }
        }
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::lane::tests::{commit_in, names, repo, sh};
    use std::fs;

    /// A bare repository standing in for `github.com/o/r`: the developer's `origin` says `https://github.com/o/r.git` (what
    /// Tasks and this module read), and git is told, in this repository only, to use the bare folder for that address, so no
    /// test ever reaches the network.
    pub(crate) fn github_origin(home: &Path, d: &Path) -> PathBuf {
        let remotes = home.join("remotes");
        let bare = remotes.join("o/r.git");
        fs::create_dir_all(&bare).unwrap();
        sh(&bare, &["init", "-q", "--bare"]);
        sh(&bare, &["symbolic-ref", "HEAD", "refs/heads/main"]);
        sh(d, &["config", &format!("url.{}/.insteadOf", remotes.display()), "https://github.com/"]);
        sh(d, &["remote", "add", "origin", "https://github.com/o/r.git"]);
        sh(d, &["push", "-q", "-u", "origin", "main"]);
        bare
    }

    /// A stand-in CLI at `home/bin/<name>`: it writes each call's argv to `home/<name>.log` (the words split by NUL, the calls by
    /// 0x1e), answers `auth status` with `auth` as its exit code, prints a pull request's address for a create, prints
    /// `home/<name>-view.json` for a view and `home/<name>-repo.json` for a repository's view (failing when there is none), and says
    /// yes to a merge.
    pub(crate) fn stand_in(home: &Path, name: &str, auth: i32) -> PathBuf {
        let bin = home.join("bin");
        fs::create_dir_all(&bin).unwrap();
        let p = bin.join(name);
        let log = home.join(format!("{name}.log"));
        let view = home.join(format!("{name}-view.json"));
        let script = format!(
            "#!/bin/sh\nprintf '%s\\0' \"$@\" >> '{log}'\nprintf '\\036' >> '{log}'\ncase \"$1 $2\" in\n\"auth status\") exit {auth};;\n\"pr create\") echo 'https://github.com/o/r/pull/7'; exit 0;;\n\"mr create\") echo 'https://gitlab.com/g/p/-/merge_requests/4'; exit 0;;\n\"pr view\"|\"mr view\") cat '{view}'; exit 0;;\n\"repo view\") cat '{repo}' || exit 1; exit 0;;\n\"repo create\") echo 'https://github.com/you/shop-site'; exit 0;;\n\"pr merge\"|\"mr merge\") exit 0;;\nesac\nexit 2\n",
            log = log.display(),
            view = view.display(),
            repo = home.join(format!("{name}-repo.json")).display()
        );
        fs::write(&p, script).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&p, fs::Permissions::from_mode(0o755)).unwrap();
        }
        p
    }

    /// The calls a stand-in got, each as its argv.
    pub(crate) fn calls(home: &Path, name: &str) -> Vec<Vec<String>> {
        let text = fs::read_to_string(home.join(format!("{name}.log"))).unwrap_or_default();
        text.split('\u{1e}').filter(|c| !c.is_empty()).map(|c| c.split('\0').filter(|w| !w.is_empty()).map(str::to_string).collect()).collect()
    }

    /// The writes a stand-in got: every call but `auth status` and a view.
    pub(crate) fn writes(home: &Path, name: &str) -> Vec<Vec<String>> {
        calls(home, name).into_iter().filter(|c| !(c.len() >= 2 && (c[1] == "status" || c[1] == "view"))).collect()
    }

    /// A developer's repository on `github.com/o/r` (a stand-in), and a lane of it with one commit of its own.
    pub(crate) fn lane_with_work(name: &str) -> Option<(PathBuf, PathBuf, PathBuf, lane::Made)> {
        let (home, d) = repo(name)?;
        let bare = github_origin(&home, &d);
        let made = lane::make(&home, &d, &names(&["kit/qr"])).unwrap();
        commit_in(Path::new(&made.worktree), "qr.txt", "promptpay\n");
        Some((home, d, bare, made))
    }

    pub(crate) fn ledger(home: &Path) -> Ledger {
        Ledger::with(stand_in(home, "gh", 0), stand_in(home, "glab", 0), ASK_LIFE)
    }

    fn remote_has(bare: &Path, branch: &str) -> Option<String> {
        let out = std::process::Command::new("git").args(["rev-parse", "--verify", "--quiet", &format!("refs/heads/{branch}")]).current_dir(bare).output().ok()?;
        out.status.success().then(|| String::from_utf8_lossy(&out.stdout).trim().to_string())
    }

    const BODY: &str = "- Add the PromptPay QR\n\n--not-a-flag\nCo-authored-by: Ana <ana@shop.co>";

    #[test]
    fn an_ask_names_exactly_what_will_be_sent_and_writes_nothing() {
        let Some((home, _, bare, made)) = lane_with_work("review-ask") else { return };
        let l = ledger(&home);
        let ask = l.ask_open(&home, &made.worktree, "  Add the PromptPay QR  ", &format!("{BODY}\r\n\r\n")).unwrap();
        let head = sh(Path::new(&made.worktree), &["rev-parse", "HEAD"]);
        assert_eq!(
            ask,
            Ask {
                id: ask.id.clone(),
                kind: "open".into(),
                source: "github".into(),
                repo: "o/r".into(),
                remote: "origin".into(),
                branch: "kit/qr".into(),
                base: "main".into(),
                head,
                commits: 1,
                uncommitted: 0,
                title: "Add the PromptPay QR".into(),
                body: BODY.into(),
                ..Ask::default()
            }
        );
        assert_eq!(ask.id.len(), 32);
        // nothing was written: no branch on the remote, and the CLI was only asked whether it is signed in
        assert_eq!(remote_has(&bare, "kit/qr"), None);
        assert!(writes(&home, "gh").is_empty(), "{:?}", calls(&home, "gh"));
        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn a_yes_pushes_and_opens_once_with_the_text_the_ask_showed() {
        let Some((home, _, bare, made)) = lane_with_work("review-yes") else { return };
        let l = ledger(&home);
        let ask = l.ask_open(&home, &made.worktree, "Add the PromptPay QR", BODY).unwrap();
        let done = l.settle(&ask.id, true).unwrap();
        assert_eq!(done, Done { outcome: "opened".into(), pushed: true, url: "https://github.com/o/r/pull/7".into(), number: 7, ..Done::default() });
        assert_eq!(remote_has(&bare, "kit/qr").as_deref(), Some(ask.head.as_str()));
        let w = writes(&home, "gh");
        assert_eq!(w.len(), 1);
        assert_eq!(w[0], vec!["pr", "create", "--repo", "o/r", "--base", "main", "--head", "kit/qr", &format!("--title={}", ask.title), &format!("--body={}", ask.body)]);
        // a second answer, from this window or another, runs nothing
        assert_eq!(l.settle(&ask.id, true), Err("already_decided".into()));
        assert_eq!(l.settle(&ask.id, false), Err("already_decided".into()));
        assert_eq!(writes(&home, "gh").len(), 1);
        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn a_no_runs_nothing_and_settles_the_ask() {
        let Some((home, _, bare, made)) = lane_with_work("review-no") else { return };
        let l = ledger(&home);
        let ask = l.ask_open(&home, &made.worktree, "x", "").unwrap();
        assert_eq!(l.settle(&ask.id, false), Ok(Done { outcome: "declined".into(), ..Done::default() }));
        assert_eq!(l.settle(&ask.id, true), Err("already_decided".into()));
        assert_eq!(remote_has(&bare, "kit/qr"), None);
        assert!(writes(&home, "gh").is_empty());
        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn a_write_without_a_settled_ask_is_refused() {
        let Some((home, _, bare, made)) = lane_with_work("review-unasked") else { return };
        let l = ledger(&home);
        // an id this run never made
        assert_eq!(l.settle("0123456789abcdef0123456789abcdef", true), Err("not_found".into()));
        assert_eq!(l.settle("", true), Err("not_found".into()));
        // an ask taken back
        let ask = l.ask_open(&home, &made.worktree, "x", "").unwrap();
        l.withdraw(&ask.id);
        assert_eq!(l.settle(&ask.id, true), Err("withdrawn".into()));
        // an ask past its life
        let old = Ledger::with(stand_in(&home, "gh", 0), stand_in(&home, "glab", 0), Duration::from_millis(0));
        let ask = old.ask_open(&home, &made.worktree, "x", "").unwrap();
        std::thread::sleep(Duration::from_millis(5));
        assert_eq!(old.settle(&ask.id, true), Err("expired".into()));
        assert_eq!(old.settle(&ask.id, true), Err("withdrawn".into()));
        // an ask of another ledger (another run of the app) is not this one's
        let other = ledger(&home);
        let theirs = other.ask_open(&home, &made.worktree, "x", "").unwrap();
        assert_eq!(l.settle(&theirs.id, true), Err("not_found".into()));
        assert_eq!(remote_has(&bare, "kit/qr"), None);
        assert!(writes(&home, "gh").is_empty());
        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn a_push_never_forces_and_a_rejected_push_opens_nothing() {
        let a = push_argv("origin", "kit/qr").unwrap();
        assert_eq!(a, vec!["-c", "push.followTags=false", "push", "--recurse-submodules=no", "origin", "refs/heads/kit/qr:refs/heads/kit/qr"]);
        for w in ["--force", "-f", "--force-with-lease", "--force-if-includes", "--mirror", "--delete", "-d", "--tags", "--all", "--prune", "--follow-tags", "--no-verify"] {
            assert!(!a.iter().any(|x| x == w || x.starts_with(&format!("{w}="))), "{w}");
        }
        assert!(!a.iter().any(|x| x.starts_with('+') || x.starts_with(':')));
        assert!(push_argv("--upload-pack=x", "kit/qr").is_err() && push_argv("origin", "main").is_err() && push_argv("origin", "+kit/qr").is_err());

        // the remote's branch moved on its own: a push that would have to force is refused by git, and nothing is opened
        let Some((home, _, bare, made)) = lane_with_work("review-reject") else { return };
        let other = home.join("other");
        sh(&home, &["clone", "-q", bare.to_str().unwrap(), other.to_str().unwrap()]);
        sh(&other, &["checkout", "-q", "-b", "kit/qr"]);
        commit_in(&other, "theirs.txt", "someone else\n");
        sh(&other, &["push", "-q", "origin", "kit/qr"]);
        let theirs = remote_has(&bare, "kit/qr").unwrap();
        let l = ledger(&home);
        let ask = l.ask_open(&home, &made.worktree, "x", "").unwrap();
        let done = l.settle(&ask.id, true).unwrap();
        assert_eq!((done.outcome.as_str(), done.step.as_str(), done.pushed), ("failed", "push", false), "{done:?}");
        assert_eq!(remote_has(&bare, "kit/qr").as_deref(), Some(theirs.as_str()));
        assert!(writes(&home, "gh").is_empty());
        // a remote set up as a mirror is never pushed to
        sh(Path::new(&made.worktree), &["config", "remote.origin.mirror", "true"]);
        assert_eq!(l.ask_open(&home, &made.worktree, "x", ""), Err("mirror_remote".into()));
        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn a_commit_made_after_the_ask_stops_the_yes() {
        let Some((home, _, bare, made)) = lane_with_work("review-moved") else { return };
        let l = ledger(&home);
        let ask = l.ask_open(&home, &made.worktree, "x", "").unwrap();
        commit_in(Path::new(&made.worktree), "later.txt", "later\n");
        assert_eq!(l.settle(&ask.id, true).unwrap(), Done::failed("check", "changed".into(), false));
        assert_eq!(remote_has(&bare, "kit/qr"), None);
        assert!(writes(&home, "gh").is_empty());
        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn says_why_and_asks_nothing_when_the_lane_cannot_go_up() {
        let Some((home, d, _, made)) = lane_with_work("review-cannot") else { return };
        // the CLI is not signed in, or not here
        let out = Ledger::with(stand_in(&home, "gh", 1), stand_in(&home, "glab", 1), ASK_LIFE);
        assert_eq!(out.ask_open(&home, &made.worktree, "x", ""), Err("not_signed_in".into()));
        let none = Ledger::with(home.join("no/gh"), home.join("no/glab"), ASK_LIFE);
        assert_eq!(none.ask_open(&home, &made.worktree, "x", ""), Err("not_installed".into()));
        let l = ledger(&home);
        // a title or body that cannot be sent as it is
        assert_eq!(l.ask_open(&home, &made.worktree, "   ", ""), Err("bad_title".into()));
        assert_eq!(l.ask_open(&home, &made.worktree, "two\nlines", ""), Err("bad_title".into()));
        assert_eq!(l.ask_open(&home, &made.worktree, &"x".repeat(TITLE_MAX + 1), ""), Err("bad_title".into()));
        assert_eq!(l.ask_open(&home, &made.worktree, "x", "a\u{7}b"), Err("bad_body".into()));
        // a folder that is not a lane the app made, or the developer's own
        assert_eq!(l.ask_open(&home, d.to_str().unwrap(), "x", ""), Err("not_a_lane".into()));
        assert_eq!(l.ask_open(&home, "relative/x", "x", ""), Err("not_a_lane".into()));
        // a lane with no commit of its own
        let empty = lane::make(&home, &d, &names(&["kit/empty"])).unwrap();
        assert_eq!(l.ask_open(&home, &empty.worktree, "x", ""), Err("no_commits".into()));
        // a remote that is neither GitHub nor GitLab
        sh(&d, &["remote", "set-url", "origin", home.join("remotes/o/r.git").to_str().unwrap()]);
        assert_eq!(l.ask_open(&home, &made.worktree, "x", ""), Err("no_remote".into()));
        sh(&d, &["remote", "remove", "origin"]);
        assert_eq!(l.ask_open(&home, &made.worktree, "x", ""), Err("no_remote".into()));
        assert!(writes(&home, "gh").is_empty());
        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn glab_is_asked_to_push_nothing_and_remove_no_branch() {
        let a = create_argv(Source::Gitlab, "g/sub/p", "kit/qr", "main", "Add QR", "-x").unwrap();
        assert_eq!(a, vec!["mr", "create", "--repo", "g/sub/p", "--source-branch", "kit/qr", "--target-branch", "main", "--title=Add QR", "--description=-x", "--yes", "--push=false", "--remove-source-branch=false"]);
        assert!(create_argv(Source::Github, "o/r", "main", "main", "x", "").is_err());
        assert!(create_argv(Source::Github, "o/--web", "kit/x", "main", "x", "").is_err());
        assert_eq!(read_created("https://github.com/o/r/pull/7\n"), ("https://github.com/o/r/pull/7".into(), 7));
        assert_eq!(read_created("!4 Add QR (kit/qr)\n https://gitlab.com/g/p/-/merge_requests/4\n"), ("https://gitlab.com/g/p/-/merge_requests/4".into(), 4));
        assert_eq!(read_created("created"), (String::new(), 0));
    }

    #[test]
    fn a_draft_lists_the_lane_s_commits_and_writes_nothing() {
        let Some((home, _, _, made)) = lane_with_work("review-draft") else { return };
        commit_in(Path::new(&made.worktree), "b.txt", "token=ghp_abcdefghijklmnopqrstuvwxyz0123456789\n");
        sh(Path::new(&made.worktree), &["commit", "-q", "--allow-empty", "-m", "Use ghp_abcdefghijklmnopqrstuvwxyz0123456789 here"]);
        let d = ledger(&home).draft(&home, &made.worktree).unwrap();
        assert_eq!((d.branch.as_str(), d.base.as_str(), d.count), ("kit/qr", "main", 3));
        assert_eq!(d.commits.len(), 3);
        assert_eq!(d.commits[2], "qr.txt");
        assert!(!d.commits.iter().any(|c| c.contains("ghp_abc")), "{:?}", d.commits);
        assert!(writes(&home, "gh").is_empty());
        let _ = fs::remove_dir_all(home);
    }

    /// A pull request as `gh pr view` answers it, made from the lane's branch, that can merge now unless `over` says otherwise.
    fn gh_view(home: &Path, head: &str, over: serde_json::Value) -> serde_json::Value {
        let mut v = serde_json::json!({
            "number": 7, "title": "Add the PromptPay QR", "body": "Draws the QR.\n\n\u{1F916} Generated with [Claude Code](https://claude.com/claude-code)",
            "state": "OPEN", "isDraft": false, "mergeable": "MERGEABLE", "mergeStateStatus": "CLEAN",
            "headRefName": "kit/qr", "headRefOid": head, "baseRefName": "main", "headRepositoryOwner": {"id": "x", "login": "o"},
            "headRepository": {"id": "r1", "name": "r", "nameWithOwner": "o/r"}, "isCrossRepository": false,
            "commits": [
                {"oid": head, "messageHeadline": "Draw the QR", "messageBody": "Co-authored-by: Ana <ana@shop.co>\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"},
                {"oid": head, "messageHeadline": "Read the amount", "messageBody": ""}
            ],
            "url": "https://github.com/o/r/pull/7"
        });
        for (k, val) in over.as_object().cloned().unwrap_or_default() {
            v[k] = val;
        }
        fs::write(home.join("gh-view.json"), v.to_string()).unwrap();
        v
    }

    #[test]
    fn a_merge_is_asked_only_for_a_pull_request_of_this_lane_that_can_merge_now() {
        let Some((home, _, _, made, _)) = pushed_lane_with_work("review-merge-can") else { return };
        let l = ledger(&home);
        let head = sh(Path::new(&made.worktree), &["rev-parse", "HEAD"]);
        for (over, why) in [
            (serde_json::json!({"state": "MERGED"}), "cannot_merge:closed"),
            (serde_json::json!({"isDraft": true}), "cannot_merge:draft"),
            (serde_json::json!({"mergeable": "CONFLICTING", "mergeStateStatus": "DIRTY"}), "cannot_merge:conflicts"),
            (serde_json::json!({"mergeStateStatus": "BEHIND"}), "cannot_merge:behind"),
            (serde_json::json!({"mergeStateStatus": "BLOCKED"}), "cannot_merge:blocked"),
            (serde_json::json!({"mergeable": "UNKNOWN", "mergeStateStatus": "UNKNOWN"}), "cannot_merge:checking"),
            (serde_json::json!({"headRefName": "kit/other"}), "not_this_lane"),
            (serde_json::json!({"number": 8}), "not_this_lane"),
        ] {
            gh_view(&home, &head, over.clone());
            assert_eq!(l.ask_merge(&home, &made.worktree, 7, "merge", false), Err(why.to_string()), "{over}");
        }
        gh_view(&home, &head, serde_json::json!({}));
        assert_eq!(l.ask_merge(&home, &made.worktree, 7, "fast-forward", false), Err("bad_method".into()));
        assert_eq!(l.ask_merge(&home, &made.worktree, 0, "merge", false), Err("bad_number".into()));
        // a merge that can go: nothing has run but reads
        let ask = l.ask_merge(&home, &made.worktree, 7, "merge", false).unwrap();
        assert_eq!((ask.kind.as_str(), ask.number, ask.method.as_str(), ask.base.as_str()), ("merge", 7, "merge", "main"));
        assert!(writes(&home, "gh").is_empty(), "{:?}", writes(&home, "gh"));
        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn a_yes_merges_once_with_the_method_and_the_message_the_ask_showed() {
        let Some((home, _, _, made, _)) = pushed_lane_with_work("review-merge-yes") else { return };
        let l = ledger(&home);
        let head = sh(Path::new(&made.worktree), &["rev-parse", "HEAD"]);
        gh_view(&home, &head, serde_json::json!({}));
        let ask = l.ask_merge(&home, &made.worktree, 7, "squash", false).unwrap();
        assert_eq!(ask.subject, "Add the PromptPay QR (#7)");
        assert_eq!(ask.message, "* Draw the QR\n\nCo-authored-by: Ana <ana@shop.co>\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>\n\n* Read the amount");
        let done = l.settle(&ask.id, true).unwrap();
        assert_eq!(done, Done { outcome: "merged".into(), url: "https://github.com/o/r/pull/7".into(), number: 7, ..Done::default() });
        let w = writes(&home, "gh");
        assert_eq!(w, vec![vec!["pr".to_string(), "merge".into(), "7".into(), "--repo".into(), "o/r".into(), "--squash".into(), "--match-head-commit".into(), head.clone(), format!("--subject={}", ask.subject), format!("--body={}", ask.message)]]);
        assert_eq!(l.settle(&ask.id, true), Err("already_decided".into()));
        assert_eq!(writes(&home, "gh").len(), 1);
        // a merge commit says where it came from, with the title and the description
        let m = l.ask_merge(&home, &made.worktree, 7, "merge", false).unwrap();
        assert_eq!(m.subject, "Merge pull request #7 from o/kit/qr");
        assert!(m.message.starts_with("Add the PromptPay QR\n\nDraws the QR."), "{}", m.message);
        // a rebase makes no message and sends none
        let r = l.ask_merge(&home, &made.worktree, 7, "rebase", false).unwrap();
        assert_eq!((r.subject.as_str(), r.message.as_str()), ("", ""));
        l.settle(&r.id, true).unwrap();
        let last = writes(&home, "gh").pop().unwrap();
        assert!(last.contains(&"--rebase".to_string()) && !last.iter().any(|a| a.starts_with("--subject") || a.starts_with("--body")), "{last:?}");
        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn with_credits_off_the_message_is_untouched_and_on_the_message_sent_is_the_one_shown_with_every_human_kept() {
        let Some((home, _, _, made, _)) = pushed_lane_with_work("review-merge-credits") else { return };
        let l = ledger(&home);
        let head = sh(Path::new(&made.worktree), &["rev-parse", "HEAD"]);
        gh_view(&home, &head, serde_json::json!({}));
        let off = l.ask_merge(&home, &made.worktree, 7, "squash", false).unwrap();
        assert!(off.message.contains("noreply@anthropic.com") && off.dropped == 0);
        let on = l.ask_merge(&home, &made.worktree, 7, "squash", true).unwrap();
        assert_eq!(on.message, "* Draw the QR\n\nCo-authored-by: Ana <ana@shop.co>\n\n* Read the amount");
        assert_eq!(on.dropped, 1);
        l.settle(&on.id, true).unwrap();
        let sent = writes(&home, "gh").pop().unwrap();
        assert!(sent.contains(&format!("--body={}", on.message)), "{sent:?}");
        assert!(sent.contains(&format!("--subject={}", on.subject)));
        assert!(!sent.iter().any(|a| a.contains("noreply@anthropic.com")));
        assert!(sent.iter().any(|a| a.contains("Co-authored-by: Ana <ana@shop.co>")));
        // the generated footer in a merge commit's description goes too
        let merge = l.ask_merge(&home, &made.worktree, 7, "merge", true).unwrap();
        assert_eq!((merge.message.as_str(), merge.dropped), ("Add the PromptPay QR\n\nDraws the QR.", 1));
        // a message of credits alone becomes the title, so the host never writes its own with them back in
        gh_view(&home, &head, serde_json::json!({"body": "", "commits": [{"oid": head, "messageHeadline": "Generated with Claude Code", "messageBody": ""}]}));
        let only = l.ask_merge(&home, &made.worktree, 7, "squash", true).unwrap();
        assert_eq!((only.message.as_str(), only.dropped), ("Add the PromptPay QR", 1));
        // the commits that exist are never rewritten: the lane's own commit keeps its message
        assert_eq!(sh(Path::new(&made.worktree), &["log", "-1", "--format=%H %s"]), format!("{head} qr.txt"));
        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn a_pull_request_that_changed_since_the_ask_is_not_merged() {
        let Some((home, _, _, made, _)) = pushed_lane_with_work("review-merge-moved") else { return };
        let l = ledger(&home);
        let head = sh(Path::new(&made.worktree), &["rev-parse", "HEAD"]);
        gh_view(&home, &head, serde_json::json!({}));
        let ask = l.ask_merge(&home, &made.worktree, 7, "merge", false).unwrap();
        // someone pushed to the pull request since: another commit at its head
        gh_view(&home, &"b".repeat(40), serde_json::json!({}));
        assert_eq!(l.settle(&ask.id, true).unwrap(), Done::failed("check", "changed".into(), false));
        // or it can no longer merge
        gh_view(&home, &head, serde_json::json!({}));
        let ask = l.ask_merge(&home, &made.worktree, 7, "merge", false).unwrap();
        gh_view(&home, &head, serde_json::json!({"mergeStateStatus": "BLOCKED"}));
        assert_eq!(l.settle(&ask.id, true).unwrap(), Done::failed("check", "changed".into(), false));
        assert!(writes(&home, "gh").is_empty());
        let _ = fs::remove_dir_all(home);
    }

    /// [`lane_with_work`], its branch pushed to the stand-in remote as the app's Push and open would: the pull request's head
    /// is then the lane's tip here and as pushed.
    pub(crate) fn pushed_lane_with_work(name: &str) -> Option<(PathBuf, PathBuf, PathBuf, lane::Made, String)> {
        let (home, d, bare, made) = lane_with_work(name)?;
        let wt = PathBuf::from(&made.worktree);
        sh(&wt, &["push", "-q", "origin", "refs/heads/kit/qr:refs/heads/kit/qr"]);
        let head = sh(&wt, &["rev-parse", "HEAD"]);
        Some((home, d, bare, made, head))
    }

    #[test]
    fn a_merge_is_never_asked_for_a_pull_request_from_another_repository_with_the_lane_s_branch_name() {
        let Some((home, _, _, made, head)) = pushed_lane_with_work("review-merge-fork") else { return };
        let l = ledger(&home);
        // a stranger's fork, on a branch named like the lane's (public once pushed), opened against this repository
        let theirs = "f".repeat(40);
        gh_view(&home, &theirs, serde_json::json!({"isCrossRepository": true, "headRepositoryOwner": {"id": "y", "login": "stranger"}, "headRepository": {"id": "z", "name": "r", "nameWithOwner": "stranger/r"}}));
        assert_eq!(l.ask_merge(&home, &made.worktree, 7, "squash", false), Err("other_repo".into()));
        // even when it carries the lane's very commit
        gh_view(&home, &head, serde_json::json!({"isCrossRepository": true, "headRepositoryOwner": {"id": "y", "login": "stranger"}, "headRepository": {"id": "z", "name": "r", "nameWithOwner": "stranger/r"}}));
        assert_eq!(l.ask_merge(&home, &made.worktree, 7, "merge", false), Err("other_repo".into()));
        // a host that does not say where the branch is: not taken as this repository's
        gh_view(&home, &head, serde_json::json!({"isCrossRepository": null}));
        assert_eq!(l.ask_merge(&home, &made.worktree, 7, "merge", false), Err("other_repo".into()));
        assert!(writes(&home, "gh").is_empty());
        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn a_merge_is_asked_only_when_the_pull_request_s_head_is_the_lane_s_tip_here_and_as_pushed() {
        let Some((home, _, _, made, head)) = pushed_lane_with_work("review-merge-tip") else { return };
        let wt = PathBuf::from(&made.worktree);
        let l = ledger(&home);
        // the pull request has a commit the lane does not hold (someone pushed to its branch)
        gh_view(&home, &"e".repeat(40), serde_json::json!({}));
        assert_eq!(l.ask_merge(&home, &made.worktree, 7, "merge", false), Err("pull_ahead".into()));
        // the lane has a commit the pull request does not hold yet
        commit_in(&wt, "later.txt", "later\n");
        gh_view(&home, &head, serde_json::json!({}));
        assert_eq!(l.ask_merge(&home, &made.worktree, 7, "merge", false), Err("lane_ahead".into()));
        sh(&wt, &["reset", "-q", "--hard", &head]);
        // this Mac has no record of the lane's commit going to the remote
        sh(&wt, &["update-ref", "-d", "refs/remotes/origin/kit/qr"]);
        assert_eq!(l.ask_merge(&home, &made.worktree, 7, "merge", false), Err("not_pushed".into()));
        sh(&wt, &["update-ref", "refs/remotes/origin/kit/qr", &head]);
        // all three the same: asked, and the card says where it comes from and which commit
        let ask = l.ask_merge(&home, &made.worktree, 7, "merge", false).unwrap();
        assert_eq!((ask.from.as_str(), ask.head.as_str()), ("o/r", head.as_str()));
        assert!(writes(&home, "gh").is_empty());
        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn a_pull_request_retargeted_or_a_lane_that_committed_since_the_ask_is_not_merged() {
        let Some((home, _, _, made, head)) = pushed_lane_with_work("review-merge-base") else { return };
        let l = ledger(&home);
        gh_view(&home, &head, serde_json::json!({}));
        let ask = l.ask_merge(&home, &made.worktree, 7, "merge", false).unwrap();
        // retargeted to another base after the ask: the card named main
        gh_view(&home, &head, serde_json::json!({"baseRefName": "release"}));
        assert_eq!(l.settle(&ask.id, true).unwrap(), Done::failed("check", "changed".into(), false));
        // the lane committed since the ask: the pull request no longer holds all of it
        gh_view(&home, &head, serde_json::json!({}));
        let ask = l.ask_merge(&home, &made.worktree, 7, "merge", false).unwrap();
        commit_in(Path::new(&made.worktree), "later.txt", "later\n");
        assert_eq!(l.settle(&ask.id, true).unwrap(), Done::failed("check", "changed".into(), false));
        assert!(writes(&home, "gh").is_empty());
        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn a_merge_never_turns_on_auto_merge_uses_admin_rights_or_deletes_the_branch() {
        let head = "c".repeat(40);
        for source in [Source::Github, Source::Gitlab] {
            for method in [Method::Merge, Method::Squash, Method::Rebase] {
                let a = merge_argv(source, "g/p", 3, method, &head, "Subject", "Body").unwrap();
                for w in ["--auto", "--admin", "--delete-branch", "-d", "--remove-source-branch", "--auto-merge", "--auto-merge=true", "--disable-auto"] {
                    assert!(!a.iter().any(|x| x == w), "{source:?} {method:?} {w}: {a:?}");
                }
                if source == Source::Gitlab {
                    assert!(a.contains(&"--auto-merge=false".to_string()) && a.contains(&"--yes".to_string()));
                }
                if method != Method::Rebase {
                    assert!(a.windows(2).any(|w| w[0] == "--sha" || w[0] == "--match-head-commit"), "{a:?}");
                }
            }
        }
        let gl = merge_argv(Source::Gitlab, "g/p", 3, Method::Squash, &head, "Add QR", "Draws it").unwrap();
        assert_eq!(gl, vec!["mr", "merge", "3", "--repo", "g/p", "--yes", "--auto-merge=false", "--squash", "--sha", &head, "--squash-message=Add QR\n\nDraws it", "--message=Add QR\n\nDraws it"]);
        assert!(merge_argv(Source::Github, "o/r", 3, Method::Merge, "not-a-commit", "s", "b").is_err());
    }

    #[test]
    fn reads_what_gitlab_says_of_a_merge_request() {
        let head = "d".repeat(40);
        let v = |status: &str| serde_json::json!({"iid": 4, "title": "Add QR", "description": "Draws it", "state": "opened", "draft": false, "detailed_merge_status": status, "source_branch": "kit/qr", "target_branch": "main", "sha": head, "web_url": "https://gitlab.com/g/p/-/merge_requests/4"}).to_string();
        let p = read_pull(Source::Gitlab, &v("mergeable")).unwrap();
        assert_eq!((p.number, p.cannot.clone(), p.head_branch.as_str(), p.base.as_str()), (4, None, "kit/qr", "main"));
        // its own project's branch only when the answer says both projects and they are one
        assert!(!p.same_repo, "no project ids: not taken as its own");
        let with = |src: serde_json::Value, dst: serde_json::Value| {
            let mut o: serde_json::Value = serde_json::from_str(&v("mergeable")).unwrap();
            o["source_project_id"] = src;
            o["target_project_id"] = dst;
            read_pull(Source::Gitlab, &o.to_string()).unwrap().same_repo
        };
        assert!(with(serde_json::json!(15), serde_json::json!(15)));
        assert!(!with(serde_json::json!(2), serde_json::json!(3)));
        assert!(!with(serde_json::json!("15"), serde_json::json!(15)));
        for (status, why) in [("conflict", "conflicts"), ("need_rebase", "behind"), ("ci_must_pass", "blocked"), ("not_approved", "blocked"), ("checking", "checking"), ("draft_status", "draft")] {
            assert_eq!(read_pull(Source::Gitlab, &v(status)).unwrap().cannot.as_deref(), Some(why), "{status}");
        }
        let (subject, body) = message_for(Source::Gitlab, Method::Merge, "g/p", &p);
        assert_eq!((subject.as_str(), body.as_str()), ("Merge branch 'kit/qr' into 'main'", "Add QR\n\nDraws it\n\nSee merge request g/p!4"));
        for bad in ["", "[]", "{}", r#"{"iid":4,"sha":"x","source_branch":"kit/qr","target_branch":"main"}"#] {
            assert!(read_pull(Source::Gitlab, bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn reads_whether_a_github_pull_request_s_branch_is_in_its_own_repository() {
        let head = "a".repeat(40);
        let pull = |over: serde_json::Value| {
            let mut v = serde_json::json!({"number": 7, "title": "t", "state": "OPEN", "isDraft": false, "mergeable": "MERGEABLE", "mergeStateStatus": "CLEAN", "headRefName": "kit/qr", "headRefOid": head, "baseRefName": "main",
                "headRepositoryOwner": {"login": "O"}, "headRepository": {"name": "R", "nameWithOwner": "O/R"}, "isCrossRepository": false, "url": "https://github.com/o/r/pull/7"});
            for (k, val) in over.as_object().cloned().unwrap_or_default() {
                v[k] = val;
            }
            let p = read_pull(Source::Github, &v.to_string()).unwrap();
            (p.from, p.same_repo)
        };
        // the host's own names, in any letter case
        assert_eq!(pull(serde_json::json!({})), ("O/R".into(), true));
        // an older gh with no nameWithOwner: the owner's login and the name
        assert_eq!(pull(serde_json::json!({"headRepository": {"name": "r"}})), ("O/r".into(), true));
        // a fork, a deleted fork, a host that does not say, and a head repository that is not the one the address names
        assert_eq!(pull(serde_json::json!({"isCrossRepository": true, "headRepositoryOwner": {"login": "x"}, "headRepository": {"name": "r", "nameWithOwner": "x/r"}})), ("x/r".into(), false));
        assert_eq!(pull(serde_json::json!({"isCrossRepository": true, "headRepository": null, "headRepositoryOwner": null})), (String::new(), false));
        assert_eq!(pull(serde_json::json!({"isCrossRepository": null})).1, false);
        assert_eq!(pull(serde_json::json!({"headRepository": {"name": "r", "nameWithOwner": "x/r"}})).1, false);
        assert_eq!(pull(serde_json::json!({"url": ""})).1, false);
    }

    /// The page reaches the writes only through an ask: lib.rs names this module's asks, `settle` and `withdraw`, and never the
    /// function that runs a plan or the proof it takes.
    #[test]
    fn a_merge_from_the_list_is_refused_for_a_request_of_another_repository_than_the_project_s() {
        let Some((home, d, _, _)) = lane_with_work("review-pull-other") else { return };
        let l = ledger(&home);
        let folder = d.to_string_lossy().into_owned();
        // the folder's remote is github.com/o/r: any other repository, or the other host, is not this project's
        assert_eq!(l.ask_merge_pull(&home, &folder, "github", "o/other", 7, "merge", false), Err("not_this_project".into()));
        assert_eq!(l.ask_merge_pull(&home, &folder, "gitlab", "o/r", 7, "merge", false), Err("not_this_project".into()));
        assert_eq!(l.ask_merge_pull(&home, &folder, "github", "o/r/x", 7, "merge", false), Err("bad_name".into()));
        assert_eq!(l.ask_merge_pull(&home, "relative/folder", "github", "o/r", 7, "merge", false), Err("gone".into()));
        assert_eq!(l.ask_merge_pull(&home, &folder, "github", "o/r", 7, "fast-forward", false), Err("bad_method".into()));
        // nothing was asked of gh, not even whether it is signed in
        assert!(calls(&home, "gh").is_empty(), "{:?}", calls(&home, "gh"));
        // a folder with no remote
        let (h2, bare_folder) = repo("review-pull-noremote").unwrap();
        assert_eq!(ledger(&h2).ask_merge_pull(&h2, &bare_folder.to_string_lossy(), "github", "o/r", 7, "merge", false), Err("no_remote".into()));
        let _ = fs::remove_dir_all(home);
        let _ = fs::remove_dir_all(h2);
    }

    #[test]
    fn a_lane_s_request_merged_from_the_list_is_the_lane_s_own_ask_and_plan() {
        let Some((home, d, _, made, head)) = pushed_lane_with_work("review-pull-lane") else { return };
        let l = ledger(&home);
        gh_view(&home, &head, serde_json::json!({}));
        let lane = l.ask_merge(&home, &made.worktree, 7, "squash", true).unwrap();
        let list = l.ask_merge_pull(&home, &d.to_string_lossy(), "github", "o/r", 7, "squash", true).unwrap();
        assert_eq!(Ask { id: lane.id.clone(), ..list.clone() }, lane);
        assert_ne!(list.id, lane.id);
        // the lane's checks of its tip run for it too: a commit made in the lane since the ask stops the Yes
        commit_in(Path::new(&made.worktree), "later.txt", "later\n");
        assert_eq!(l.settle(&list.id, true).unwrap(), Done::failed("check", "changed".into(), false));
        assert!(writes(&home, "gh").is_empty());
        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn a_request_no_lane_made_is_asked_with_its_repository_and_branch_and_merged_once() {
        let Some((home, d, _, _)) = lane_with_work("review-pull-own") else { return };
        let l = ledger(&home);
        let folder = d.to_string_lossy().into_owned();
        let sha = "c".repeat(40);
        gh_view(&home, &sha, serde_json::json!({"headRefName": "fix/typo", "title": "Fix a typo", "body": "On the about page."}));
        let ask = l.ask_merge_pull(&home, &folder, "github", "o/r", 7, "merge", false).unwrap();
        assert_eq!(
            (ask.kind.as_str(), ask.repo.as_str(), ask.from.as_str(), ask.branch.as_str(), ask.base.as_str(), ask.head.as_str(), ask.method.as_str()),
            ("merge", "o/r", "o/r", "fix/typo", "main", sha.as_str(), "merge")
        );
        assert_eq!(ask.subject, "Merge pull request #7 from o/fix/typo");
        assert_eq!(ask.message, "Fix a typo\n\nOn the about page.");
        assert!(writes(&home, "gh").is_empty(), "the ask writes nothing");
        let done = l.settle(&ask.id, true).unwrap();
        assert_eq!(done, Done { outcome: "merged".into(), url: "https://github.com/o/r/pull/7".into(), number: 7, ..Done::default() });
        // the same argv a lane's merge sends: bound to the head commit shown, with the message shown, and nothing else
        let expected = merge_argv(Source::Github, "o/r", 7, Method::Merge, &sha, &ask.subject, &ask.message).unwrap();
        assert_eq!(writes(&home, "gh"), vec![expected]);
        assert_eq!(l.settle(&ask.id, true), Err("already_decided".into()));
        assert_eq!(writes(&home, "gh").len(), 1);
        // a request that moved since the ask is not merged
        let again = l.ask_merge_pull(&home, &folder, "github", "o/r", 7, "merge", false).unwrap();
        gh_view(&home, &"d".repeat(40), serde_json::json!({"headRefName": "fix/typo"}));
        assert_eq!(l.settle(&again.id, true).unwrap(), Done::failed("check", "changed".into(), false));
        assert_eq!(writes(&home, "gh").len(), 1);
        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn a_request_from_the_list_is_asked_only_from_this_repository_when_it_can_merge_with_a_method_allowed() {
        let Some((home, d, _, _)) = lane_with_work("review-pull-refuse") else { return };
        let l = ledger(&home);
        let folder = d.to_string_lossy().into_owned();
        let sha = "c".repeat(40);
        let fork = serde_json::json!({"headRefName": "fix/typo", "isCrossRepository": true, "headRepositoryOwner": {"login": "stranger"}, "headRepository": {"name": "r", "nameWithOwner": "stranger/r"}});
        gh_view(&home, &sha, fork);
        assert_eq!(l.ask_merge_pull(&home, &folder, "github", "o/r", 7, "merge", false), Err("other_repo".into()));
        gh_view(&home, &sha, serde_json::json!({"headRefName": "fix/typo", "mergeStateStatus": "BLOCKED"}));
        assert_eq!(l.ask_merge_pull(&home, &folder, "github", "o/r", 7, "merge", false), Err("cannot_merge:blocked".into()));
        gh_view(&home, &sha, serde_json::json!({"headRefName": "fix/typo"}));
        fs::write(home.join("gh-repo.json"), r#"{"mergeCommitAllowed": false, "squashMergeAllowed": true, "rebaseMergeAllowed": false}"#).unwrap();
        assert_eq!(l.ask_merge_pull(&home, &folder, "github", "o/r", 7, "merge", false), Err("method_not_allowed".into()));
        assert_eq!(l.ask_merge_pull(&home, &folder, "github", "o/r", 7, "squash", false).map(|a| a.method), Ok("squash".into()));
        assert!(writes(&home, "gh").is_empty());
        let _ = fs::remove_dir_all(home);
    }

    /// A home folder with a new project in it (item 100b), made as the page's New project makes one.
    fn new_project(name: &str) -> Option<(PathBuf, PathBuf)> {
        tasks::find("git")?;
        let home = crate::lane::tests::tmp(name);
        let made = crate::new_project::make(&home, home.join("code/shop-site").to_str().unwrap()).unwrap();
        Some((home, PathBuf::from(made.folder)))
    }

    #[test]
    fn a_new_repository_s_ask_shows_the_exact_command_and_writes_nothing() {
        let Some((home, dir)) = new_project("repo-ask") else { return };
        let l = ledger(&home);
        let folder = dir.to_string_lossy().into_owned();
        let ask = l.ask_repo(&home, &folder, "shop-site", false).unwrap();
        assert_eq!(
            ask,
            Ask {
                id: ask.id.clone(),
                kind: "repo".into(),
                source: "github".into(),
                repo: "shop-site".into(),
                remote: "origin".into(),
                folder: folder.clone(),
                visibility: "private".into(),
                plan: format!("gh repo create shop-site --private --source {folder} --remote origin"),
                ..Ask::default()
            }
        );
        // public only when chosen, said in the command too
        let public = l.ask_repo(&home, &folder, "baanmali/shop-site", true).unwrap();
        assert_eq!((public.visibility.as_str(), public.plan.as_str()), ("public", format!("gh repo create baanmali/shop-site --public --source {folder} --remote origin").as_str()));
        // gh was only asked whether it is signed in
        assert!(writes(&home, "gh").is_empty(), "{:?}", calls(&home, "gh"));
        // no push, ever, and nothing that forces or names another remote
        let argv = repo_argv("shop-site", false, &dir).unwrap();
        assert_eq!(argv, ["repo", "create", "shop-site", "--private", "--source", folder.as_str(), "--remote", "origin"]);
        assert!(!argv.iter().any(|w| w.starts_with("--push") || w.starts_with("--clone") || w == "--public"));
        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn a_yes_makes_the_repository_once_and_pushes_nothing_and_a_no_runs_nothing() {
        let Some((home, dir)) = new_project("repo-yes") else { return };
        let l = ledger(&home);
        let folder = dir.to_string_lossy().into_owned();
        let no = l.ask_repo(&home, &folder, "shop-site", false).unwrap();
        assert_eq!(l.settle(&no.id, false), Ok(Done { outcome: "declined".into(), ..Done::default() }));
        assert!(writes(&home, "gh").is_empty());
        let ask = l.ask_repo(&home, &folder, "shop-site", false).unwrap();
        let done = l.settle(&ask.id, true).unwrap();
        assert_eq!(done, Done { outcome: "created".into(), url: "https://github.com/you/shop-site".into(), ..Done::default() });
        let w = writes(&home, "gh");
        assert_eq!(w, vec![vec!["repo", "create", "shop-site", "--private", "--source", folder.as_str(), "--remote", "origin"]]);
        // once: a second answer runs nothing
        assert_eq!(l.settle(&ask.id, true), Err("already_decided".into()));
        assert_eq!(writes(&home, "gh").len(), 1);
        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn a_new_repository_is_asked_only_for_a_project_of_its_own_in_home_with_a_good_name_and_gh_signed_in() {
        let Some((home, dir)) = new_project("repo-refuse") else { return };
        let l = ledger(&home);
        let folder = dir.to_string_lossy().into_owned();
        for bad in ["", "-x", ".x", "a/b/c", "a b", "owner/", "x;rm"] {
            assert_eq!(l.ask_repo(&home, &folder, bad, false), Err("bad_repo_name".into()), "{bad:?}");
        }
        // a folder outside the home folder, the home folder itself, a relative or dotted path
        let outside = crate::lane::tests::tmp("repo-refuse-outside");
        sh(&outside, &["init", "-q"]);
        assert_eq!(l.ask_repo(&home, outside.to_str().unwrap(), "x", false), Err("outside_home".into()));
        assert_eq!(l.ask_repo(&home, home.to_str().unwrap(), "x", false), Err("outside_home".into()));
        assert_eq!(l.ask_repo(&home, "code/shop-site", "x", false), Err("bad_path".into()));
        assert_eq!(l.ask_repo(&home, &format!("{folder}/../shop-site"), "x", false), Err("bad_path".into()));
        // a folder inside another repository, not one of its own
        fs::create_dir_all(dir.join("sub")).unwrap();
        assert_eq!(l.ask_repo(&home, dir.join("sub").to_str().unwrap(), "x", false), Err("not_a_repository".into()));
        // gh signed out
        let signed_out = Ledger::with(stand_in(&home, "gh", 1), stand_in(&home, "glab", 0), ASK_LIFE);
        assert_eq!(signed_out.ask_repo(&home, &folder, "x", false), Err("not_signed_in".into()));
        // a project that has an `origin` already
        sh(&dir, &["remote", "add", "origin", "https://github.com/o/r.git"]);
        assert_eq!(l.ask_repo(&home, &folder, "x", false), Err("has_origin".into()));
        assert!(writes(&home, "gh").is_empty());
        let _ = fs::remove_dir_all(home);
        let _ = fs::remove_dir_all(outside);
    }

    #[test]
    fn an_origin_set_after_the_ask_stops_the_yes() {
        let Some((home, dir)) = new_project("repo-changed") else { return };
        let l = ledger(&home);
        let ask = l.ask_repo(&home, dir.to_str().unwrap(), "shop-site", false).unwrap();
        sh(&dir, &["remote", "add", "origin", "https://github.com/o/r.git"]);
        assert_eq!(l.settle(&ask.id, true).unwrap(), Done::failed("check", "changed".into(), false));
        assert!(writes(&home, "gh").is_empty());
        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn a_plan_line_reads_as_the_words_that_run() {
        let a = vec!["repo".to_string(), "create".into(), "shop".into(), "--private".into(), "--source".into(), "/Users/fon/My Code/it's".into(), "--remote".into(), "origin".into()];
        assert_eq!(plan_line("gh", &a), "gh repo create shop --private --source '/Users/fon/My Code/it'\\''s' --remote origin");
        assert_eq!(read_repo_url("✓ Created repository you/shop on github.com\n  https://github.com/you/shop\n✓ Added remote https://github.com/you/shop.git"), "https://github.com/you/shop");
        assert_eq!(read_repo_url("nothing"), "");
    }

    #[test]
    fn the_page_reaches_the_writes_only_through_a_settled_ask() {
        let lib = include_str!("lib.rs");
        for never in ["review::run", "Settled", "run_env_for(", "\"push\""] {
            assert!(!lib.contains(never), "lib.rs names {never}");
        }
        // `review::` as a path of its own, not the end of `preview::`
        let own = |i: usize| i == 0 || !lib[..i].ends_with(|c: char| c.is_alphanumeric() || c == '_');
        let used: std::collections::BTreeSet<&str> = lib.match_indices("review::").filter(|(i, _)| own(*i)).map(|(i, _)| lib[i + 8..].split(|c: char| !c.is_alphanumeric() && c != '_').next().unwrap_or("")).collect();
        assert_eq!(used.into_iter().collect::<Vec<_>>(), vec!["Ask", "Done", "Draft", "Ledger"]);
    }
}
