//! Pull requests on other hosts (item 100b, part 4): the open requests of a project whose remote is on Azure DevOps, or on a Gitea
//! or Forgejo server, listed in Tasks › Pull requests beside GitHub's and GitLab's. Read only: no merge, no write, nothing that
//! changes a request; each row only says "Open on <host>". Each host is read only through its own signed-in CLI, and only when that
//! CLI is installed: a project on a host whose CLI is not here shows nothing and asks nothing.
//!
//! - **Azure DevOps** through Azure CLI's `az repos pr list --organization <org> --project <p> --repository <r> --status active
//!   --top 51 --output json --detect false` (its reference page; `az` was not on this Mac on 26 Nov 2026, so the answer is read
//!   as the REST API's pull request objects: `pullRequestId`, `title`, `isDraft`, `createdBy.displayName`, `creationDate`,
//!   `sourceRefName`, `targetRefName`, `mergeStatus`, `reviewers[].vote`, `forkSource`). The answer has no browser address, so a
//!   request's is `<org>/<project>/_git/<repo>/pullrequest/<id>`. `AZURE_EXTENSION_USE_DYNAMIC_INSTALL=no` is set for the call
//!   (Azure CLI's configuration page: `AZURE_{section}_{name}`; `no` is the default), so the CLI never installs an extension by
//!   itself whatever the person set.
//! - **Gitea and Forgejo** through Gitea's own CLI, `gt` (which replaced the archived `tea`; its manual pages, as `gt` was not on
//!   this Mac either): `gt auth status --json host` names the servers it is signed in to (no token is among its fields), and a
//!   remote on one of them is listed with `gt pr list --host <server> --repo <owner>/<name> --state open --limit 51
//!   --json=<fields> --no-input`. Whether `gt` serves a Forgejo server was not confirmed: one it is signed in to is listed when its
//!   answer reads.
//! - **Bitbucket** is not offered: the one Atlassian CLI that holds a Bitbucket sign-in (`twg`, the Teamwork Graph CLI) documents
//!   no list of pull requests with an output this module could read, and the other Bitbucket CLIs are not Atlassian's.
//!
//! What crosses from the page is only the project's folder: the remote is read from its git config here (no program runs for it),
//! never a name the page sends. Every text passes the app's one masker (`tasks::text`). A list is kept [`crate::pulls::KEEP_BOARD`].
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::Value;

use crate::pulls::{Board, Pull, BOARD_MAX, KEEP_BOARD};
use crate::tasks::{self, Checks, Item};

/// How long the servers `gt` is signed in to are kept.
const KEEP_HOSTS: Duration = Duration::from_secs(60);

fn s(v: &str) -> String {
    v.to_string()
}

/// A project's remote on one of these hosts, as the page is told it: `host` (`azure` or `gitea`), `name` (what the row says the
/// host is: "Azure DevOps", or the server's own name), and the repository as a person reads it.
#[derive(Clone, Debug, Default, Serialize, PartialEq)]
pub struct OtherRemote {
    pub host: String,
    pub name: String,
    pub repo: String,
}

/// A repository on Azure DevOps: the organisation's address (`https://dev.azure.com/<org>/`, or the older
/// `https://<org>.visualstudio.com/`), the project and the repository.
#[derive(Clone, Debug, PartialEq)]
pub struct Azure {
    pub org: String,
    pub project: String,
    pub repo: String,
}

/// A repository on a Gitea or Forgejo server: the server as `gt` names it (with any base path), and `owner/name`.
#[derive(Clone, Debug, PartialEq)]
pub struct Gitea {
    pub server: String,
    pub repo: String,
}

#[derive(Clone, Debug, PartialEq)]
pub enum Found {
    Azure(Azure),
    Gitea(Gitea),
}

impl Found {
    pub fn remote(&self) -> OtherRemote {
        match self {
            Found::Azure(a) => OtherRemote { host: "azure".into(), name: "Azure DevOps".into(), repo: format!("{}/{}", a.project, a.repo) },
            Found::Gitea(g) => OtherRemote { host: "gitea".into(), name: host_name(&g.server).to_string(), repo: g.repo.clone() },
        }
    }
}

/// A name of a project or repository as Azure DevOps writes one in an address: `%20` read as a space, nothing else escaped, and
/// only letters, digits, `.`, `_`, `-` and spaces, never starting with `-` or `.`.
fn azure_name(raw: &str) -> Option<String> {
    let n = raw.replace("%20", " ");
    let ok = !n.is_empty() && n.len() <= 100 && !n.starts_with(['-', '.', ' ']) && n.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-' | ' '));
    ok.then_some(n)
}

/// An Azure DevOps remote, in each form Azure Repos gives one: `https://[<user>@]dev.azure.com/<org>/<project>/_git/<repo>`,
/// `git@ssh.dev.azure.com:v3/<org>/<project>/<repo>` (and `ssh://` of the same), and the older
/// `https://<org>.visualstudio.com/[DefaultCollection/]<project>/_git/<repo>`.
pub fn parse_azure(url: &str) -> Option<Azure> {
    let u = url.trim().trim_end_matches('/');
    let u = u.strip_suffix(".git").unwrap_or(u);
    let segs = |p: &str| p.split('/').map(str::to_string).collect::<Vec<_>>();
    let org_ok = |o: &str| !o.is_empty() && o.len() <= 100 && !o.starts_with(['-', '.']) && o.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'));
    if let Some(rest) = u.strip_prefix("https://") {
        let rest = rest.split_once('@').filter(|(user, _)| !user.contains('/')).map(|(_, r)| r).unwrap_or(rest);
        let (host, path) = rest.split_once('/')?;
        let host = host.to_ascii_lowercase();
        let p = segs(path);
        if host == "dev.azure.com" && p.len() == 4 && p[2] == "_git" && org_ok(&p[0]) {
            return Some(Azure { org: format!("https://dev.azure.com/{}/", p[0]), project: azure_name(&p[1])?, repo: azure_name(&p[3])? });
        }
        if let Some(org) = host.strip_suffix(".visualstudio.com").filter(|o| org_ok(o) && !o.contains('.')) {
            let p: Vec<String> = if p.first().is_some_and(|c| c.eq_ignore_ascii_case("DefaultCollection")) { p[1..].to_vec() } else { p };
            if p.len() == 3 && p[1] == "_git" {
                return Some(Azure { org: format!("https://{org}.visualstudio.com/"), project: azure_name(&p[0])?, repo: azure_name(&p[2])? });
            }
        }
        return None;
    }
    let ssh = u.strip_prefix("ssh://").map(|r| r.replacen('/', ":", 1)).unwrap_or_else(|| u.to_string());
    let (left, path) = ssh.split_once(':')?;
    let host = left.rsplit_once('@').map(|(_, h)| h).unwrap_or(left).to_ascii_lowercase();
    if host != "ssh.dev.azure.com" && host != "vs-ssh.visualstudio.com" {
        return None;
    }
    let p = segs(path);
    if p.len() == 4 && p[0] == "v3" && org_ok(&p[1]) {
        return Some(Azure { org: format!("https://dev.azure.com/{}/", p[1]), project: azure_name(&p[2])?, repo: azure_name(&p[3])? });
    }
    None
}

/// The host (with its port) of a server address, lower-cased: `https://Git.Example.com:3000/base` is `git.example.com:3000`.
fn host_name(server: &str) -> &str {
    let rest = server.split_once("://").map(|(_, r)| r).unwrap_or(server);
    rest.split('/').next().unwrap_or(rest)
}

/// A server `gt` named, as `https://<host>[/<base path>]` with no trailing `/`, when it is one: an http(s) address, or a bare name.
fn server_of(raw: &str) -> Option<String> {
    let r = raw.trim().trim_end_matches('/');
    let r = if r.contains("://") { r.to_string() } else { format!("https://{r}") };
    let ok = (r.starts_with("https://") || r.starts_with("http://")) && !r.chars().any(|c| c.is_whitespace() || c.is_control() || matches!(c, '?' | '#' | '@'));
    (ok && !host_name(&r).is_empty()).then_some(r)
}

/// The servers `gt auth status --json host` names: every `host` string in its answer, however it nests the accounts.
pub fn parse_gt_hosts(out: &str) -> Vec<String> {
    fn walk(v: &Value, depth: u8, out: &mut Vec<String>) {
        if depth > 4 {
            return;
        }
        match v {
            Value::Array(a) => a.iter().for_each(|x| walk(x, depth + 1, out)),
            Value::Object(o) => {
                if let Some(h) = o.get("host").and_then(Value::as_str).and_then(server_of) {
                    if !out.contains(&h) {
                        out.push(h);
                    }
                }
                o.values().filter(|x| x.is_object() || x.is_array()).for_each(|x| walk(x, depth + 1, out));
            }
            _ => {}
        }
    }
    let mut hosts = vec![];
    if let Ok(v) = serde_json::from_str::<Value>(out.trim()) {
        walk(&v, 0, &mut hosts);
    }
    hosts
}

/// A remote on one of `servers` (what `gt` is signed in to) as a Gitea repository: `https://<server>/<owner>/<name>`, or over ssh
/// (`git@<host>:<owner>/<name>`, `ssh://git@<host>[:port]/<owner>/<name>`) to that server's host. GitHub, GitLab and Azure DevOps
/// are never one.
pub fn parse_gitea(url: &str, servers: &[String]) -> Option<Gitea> {
    if tasks::parse_remote(url).is_some() || parse_azure(url).is_some() {
        return None;
    }
    let u = url.trim().trim_end_matches('/');
    let u = u.strip_suffix(".git").unwrap_or(u);
    let repo_of = |path: &str| -> Option<String> {
        let parts: Vec<&str> = path.trim_matches('/').split('/').collect();
        (parts.len() == 2 && parts.iter().all(|p| tasks::segment_ok(p))).then(|| parts.join("/"))
    };
    if let Some((scheme, rest)) = u.split_once("://").filter(|(s, _)| *s == "https" || *s == "http") {
        let rest = rest.split_once('@').filter(|(user, _)| !user.contains('/')).map(|(_, r)| r).unwrap_or(rest);
        let full = format!("{scheme}://{rest}");
        let lower = full.to_ascii_lowercase();
        for server in servers {
            let base = format!("{}/", server.to_ascii_lowercase());
            if lower.starts_with(&base) {
                // the path as written (its case kept), after the server's own part
                return repo_of(&full[base.len()..]).map(|repo| Gitea { server: server.clone(), repo });
            }
        }
        return None;
    }
    let ssh = u.strip_prefix("ssh://").map(|r| r.to_string());
    let (host, path) = match &ssh {
        Some(r) => {
            let (h, p) = r.split_once('/')?;
            (h.rsplit_once('@').map(|(_, h)| h).unwrap_or(h).split(':').next()?.to_ascii_lowercase(), p.to_string())
        }
        None => {
            let (left, p) = u.split_once(':')?;
            if left.contains('/') {
                return None;
            }
            (left.rsplit_once('@').map(|(_, h)| h).unwrap_or(left).to_ascii_lowercase(), p.to_string())
        }
    };
    let server = servers.iter().find(|s| host_name(s).split(':').next().unwrap_or("").eq_ignore_ascii_case(&host))?;
    repo_of(&path).map(|repo| Gitea { server: server.clone(), repo })
}

/// The argv (after `az`) that lists `a`'s open pull requests: the newest [`BOARD_MAX`] and one more, so the page knows more are open.
pub fn azure_argv(a: &Azure) -> Vec<String> {
    let top = (BOARD_MAX + 1).to_string();
    vec![s("repos"), s("pr"), s("list"), s("--organization"), a.org.clone(), s("--project"), a.project.clone(), s("--repository"), a.repo.clone(), s("--status"), s("active"), s("--top"), top, s("--output"), s("json"), s("--detect"), s("false")]
}

/// The fields `gt pr list --json` is asked for.
const GT_FIELDS: &str = "number,title,state,draft,author,url,head,base,created_at,updated_at,mergeable,review_decision";

/// The argv (after `gt`) that lists `g`'s open pull requests.
pub fn gitea_argv(g: &Gitea) -> Vec<String> {
    vec![s("pr"), s("list"), s("--host"), g.server.clone(), s("--repo"), g.repo.clone(), s("--state"), s("open"), s("--limit"), (BOARD_MAX + 1).to_string(), format!("--json={GT_FIELDS}"), s("--no-input")]
}

/// The argv (after `gt`) that names the servers it is signed in to, and nothing else of its accounts.
pub fn gt_hosts_argv() -> Vec<String> {
    vec![s("auth"), s("status"), s("--json=host"), s("--no-input")]
}

/// A string field, or a person's or a branch's name given as an object (`login`, `username`, `name`, `ref`, `label`).
fn named(v: Option<&Value>) -> String {
    match v {
        Some(Value::String(t)) => tasks::one_line(tasks::mask_secrets(t), 250),
        Some(o @ Value::Object(_)) => ["login", "username", "ref", "name", "label"].iter().map(|k| tasks::text(o, k)).find(|t| !t.is_empty()).map(|t| tasks::one_line(t, 250)).unwrap_or_default(),
        _ => String::new(),
    }
}

/// An Azure DevOps answer as a board. Its review is read from the reviewers' votes (10 approved, 5 approved with suggestions, 0 none,
/// -5 waiting for the author, -10 rejected): any vote under 0 is changes asked, else any over 0 approved, else a review is needed
/// while reviewers are named.
pub fn parse_azure_board(a: &Azure, out: &str) -> Result<Board, String> {
    let v: Value = serde_json::from_str(out.trim()).map_err(|e| format!("az answered something that is not JSON: {e}"))?;
    let rows = v.as_array().ok_or("az did not answer a list")?;
    let web = |id: u64| tasks::web_url(&format!("{}{}/_git/{}/pullrequest/{id}", a.org, a.project.replace(' ', "%20"), a.repo.replace(' ', "%20")));
    let branch = |k: &str, r: &Value| tasks::one_line(tasks::text(r, k).trim_start_matches("refs/heads/").to_string(), 250);
    let mut items: Vec<Pull> = rows
        .iter()
        .filter_map(|r| {
            let number = r.get("pullRequestId").and_then(Value::as_u64).filter(|n| *n > 0)?;
            let votes: Vec<i64> = r.get("reviewers").and_then(Value::as_array).map(|rs| rs.iter().filter_map(|x| x.get("vote").and_then(Value::as_i64)).collect()).unwrap_or_default();
            let review = if votes.iter().any(|v| *v < 0) {
                "changes"
            } else if votes.iter().any(|v| *v > 0) {
                "approved"
            } else if !votes.is_empty() {
                "required"
            } else {
                ""
            };
            let created = tasks::epoch(&tasks::text(r, "creationDate"));
            let draft = r.get("isDraft").and_then(Value::as_bool).unwrap_or(false);
            let item = Item {
                number,
                title: tasks::one_line(tasks::text(r, "title"), 300),
                state: if draft { "draft" } else { "open" }.into(),
                url: web(number),
                author: named(r.get("createdBy").and_then(|c| c.get("displayName"))),
                created,
                updated: created,
                // the list carries no checks: none are shown rather than guessed
                checks: Some(Checks::default()),
                head: branch("sourceRefName", r),
                same: r.get("forkSource").is_none_or(Value::is_null),
                ..Item::default()
            };
            Some(Pull { item, review: review.into(), conflict: tasks::text(r, "mergeStatus") == "conflicts", base: branch("targetRefName", r) })
        })
        .collect();
    let more = items.len() > BOARD_MAX;
    items.truncate(BOARD_MAX);
    Ok(Board { items, more, at: crate::pulls::now() })
}

/// A `gt pr list --json` answer as a board. Its fields are read as their names say, a person's or a branch's name either as a
/// string or as an object; `review_decision` in either case (`approved`, `changes_requested`, `review_required`); `mergeable`
/// false is a conflict only when it is said.
pub fn parse_gitea_board(out: &str) -> Result<Board, String> {
    let v: Value = serde_json::from_str(out.trim()).map_err(|e| format!("gt answered something that is not JSON: {e}"))?;
    let rows = v.as_array().ok_or("gt did not answer a list")?;
    let mut items: Vec<Pull> = rows
        .iter()
        .filter_map(|r| {
            let number = r.get("number").and_then(Value::as_u64).filter(|n| *n > 0)?;
            let draft = r.get("draft").and_then(Value::as_bool).unwrap_or(false);
            let review = match tasks::text(r, "review_decision").to_ascii_lowercase().as_str() {
                "approved" => "approved",
                "changes_requested" => "changes",
                "review_required" => "required",
                _ => "",
            };
            let created = tasks::epoch(&tasks::text(r, "created_at"));
            let updated = tasks::epoch(&tasks::text(r, "updated_at"));
            let item = Item {
                number,
                title: tasks::one_line(tasks::text(r, "title"), 300),
                state: if draft { "draft" } else { "open" }.into(),
                url: tasks::web_url(&tasks::text(r, "url")),
                author: named(r.get("author")),
                created,
                updated: if updated > 0 { updated } else { created },
                checks: Some(Checks::default()),
                head: named(r.get("head")),
                ..Item::default()
            };
            Some(Pull { item, review: review.into(), conflict: r.get("mergeable").and_then(Value::as_bool) == Some(false), base: named(r.get("base")) })
        })
        .collect();
    let more = items.len() > BOARD_MAX;
    items.truncate(BOARD_MAX);
    Ok(Board { items, more, at: crate::pulls::now() })
}

/// A list of another host's requests, with the remote it is of.
#[derive(Clone, Debug, Default, Serialize, PartialEq)]
pub struct OtherBoard {
    #[serde(flatten)]
    pub remote: OtherRemote,
    #[serde(flatten)]
    pub board: Board,
}

/// The servers `gt` is signed in to, and the lists read this run, each kept a short while.
pub struct Others {
    /// tests: stand-ins for `az` and `gt` (none: the ones found on this computer)
    cli: Option<(PathBuf, PathBuf)>,
    hosts: Mutex<Option<(Instant, Vec<String>)>>,
    lists: Mutex<HashMap<String, (Instant, OtherBoard)>>,
}

impl Default for Others {
    fn default() -> Others {
        Others { cli: None, hosts: Mutex::new(None), lists: Mutex::new(HashMap::new()) }
    }
}

impl Others {
    #[cfg(test)]
    pub(crate) fn with(az: PathBuf, gt: PathBuf) -> Others {
        Others { cli: Some((az, gt)), ..Others::default() }
    }

    fn exe(&self, program: &str) -> Option<PathBuf> {
        match &self.cli {
            Some((az, gt)) => Some(if program == "az" { az.clone() } else { gt.clone() }).filter(|p| p.is_file()),
            None => tasks::find(program),
        }
    }

    /// The servers `gt` is signed in to (none when it is not installed or did not answer), asked at most once a minute.
    fn gt_servers(&self, gt: &Path) -> Vec<String> {
        if let Some((at, h)) = self.hosts.lock().ok().and_then(|m| m.clone()) {
            if at.elapsed() < KEEP_HOSTS {
                return h;
            }
        }
        let h = tasks::run_env(gt, &gt_hosts_argv(), true, &[], &[]).ok().filter(|r| r.code == Some(0)).map(|r| parse_gt_hosts(&r.out)).unwrap_or_default();
        if let Ok(mut m) = self.hosts.lock() {
            *m = Some((Instant::now(), h.clone()));
        }
        h
    }

    /// The repository of the project at `cwd` on one of these hosts, when that host's CLI is installed (and, for Gitea, signed in to
    /// the remote's server). The remote is read from the folder's git config; only `gt auth status` may run.
    pub fn found(&self, cwd: &str) -> Option<Found> {
        let dir = Path::new(cwd);
        if !dir.is_absolute() || !dir.is_dir() {
            return None;
        }
        let url = tasks::folder_remote_url(dir)?;
        // GitHub's and GitLab's are pulls.rs's: nothing is asked of another CLI for them
        if tasks::parse_remote(&url).is_some() {
            return None;
        }
        if let Some(a) = parse_azure(&url) {
            return self.exe("az").map(|_| Found::Azure(a));
        }
        let gt = self.exe("gt")?;
        parse_gitea(&url, &self.gt_servers(&gt)).map(Found::Gitea)
    }

    /// The project at `cwd`'s open requests on its host, or None when it is on none of these hosts or its CLI is not here.
    pub fn board(&self, cwd: &str) -> Result<Option<OtherBoard>, String> {
        let Some(found) = self.found(cwd) else { return Ok(None) };
        let remote = found.remote();
        let key = format!("{}:{}", remote.host, match &found {
            Found::Azure(a) => format!("{}{}/{}", a.org, a.project, a.repo),
            Found::Gitea(g) => format!("{}/{}", g.server, g.repo),
        });
        if let Some((at, b)) = self.lists.lock().ok().and_then(|m| m.get(&key).cloned()) {
            if at.elapsed() < KEEP_BOARD {
                return Ok(Some(b));
            }
        }
        let (program, argv, env): (&str, Vec<String>, Vec<(&str, &str)>) = match &found {
            Found::Azure(a) => ("az", azure_argv(a), vec![("AZURE_EXTENSION_USE_DYNAMIC_INSTALL", "no"), ("AZURE_CORE_NO_COLOR", "true")]),
            Found::Gitea(g) => ("gt", gitea_argv(g), vec![]),
        };
        let exe = self.exe(program).ok_or_else(|| format!("{program} is not installed"))?;
        let ran = tasks::run_env(&exe, &argv, true, &env, &[])?;
        if ran.code != Some(0) {
            let line = tasks::error_line(&ran.err);
            return Err(if line.is_empty() { format!("{program} failed") } else { line });
        }
        let board = match &found {
            Found::Azure(a) => parse_azure_board(a, &ran.out)?,
            Found::Gitea(_) => parse_gitea_board(&ran.out)?,
        };
        let b = OtherBoard { remote, board };
        if let Ok(mut m) = self.lists.lock() {
            if m.len() >= 64 {
                m.clear();
            }
            m.insert(key, (Instant::now(), b.clone()));
        }
        Ok(Some(b))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pulls::tests::{log_lines, stand_in, temp};
    use std::fs;

    const AZ_OUT: &str = include_str!("tasks_fixtures/az-pr-list.json");
    const GT_OUT: &str = include_str!("tasks_fixtures/gt-pr-list.json");

    fn azure() -> Azure {
        Azure { org: "https://dev.azure.com/baanmali/".into(), project: "Shop Site".into(), repo: "site".into() }
    }

    #[test]
    fn reads_each_form_of_an_azure_devops_remote() {
        let want = azure();
        for url in [
            "https://dev.azure.com/baanmali/Shop%20Site/_git/site",
            "https://baanmali@dev.azure.com/baanmali/Shop%20Site/_git/site",
            "git@ssh.dev.azure.com:v3/baanmali/Shop%20Site/site",
            "ssh://git@ssh.dev.azure.com/v3/baanmali/Shop%20Site/site",
        ] {
            assert_eq!(parse_azure(url).as_ref(), Some(&want), "{url}");
        }
        assert_eq!(parse_azure("https://baanmali.visualstudio.com/DefaultCollection/Shop%20Site/_git/site").map(|a| a.org), Some("https://baanmali.visualstudio.com/".into()));
        for no in ["https://github.com/o/r.git", "https://dev.azure.com/o/p/r", "https://dev.azure.com/o/-p/_git/r", "https://dev.azure.com/o/p/_git/r%2Fx", "git@ssh.dev.azure.com:v2/o/p/r", "https://evil.com/dev.azure.com/o/p/_git/r"] {
            assert_eq!(parse_azure(no), None, "{no}");
        }
    }

    #[test]
    fn reads_a_remote_on_a_server_gt_is_signed_in_to_and_nothing_else() {
        let servers = parse_gt_hosts(r#"[{"host": "https://gitea.example.com", "user": "noi", "active": true}, {"host": "https://code.example.org/git/", "user": "noi"}, {"host": "codeberg.org"}]"#);
        assert_eq!(servers, ["https://gitea.example.com", "https://code.example.org/git", "https://codeberg.org"]);
        // the same hosts nested under an accounts list
        assert_eq!(parse_gt_hosts(r#"{"accounts": [{"host": "https://gitea.example.com"}]}"#), ["https://gitea.example.com"]);
        let g = |url: &str| parse_gitea(url, &servers);
        assert_eq!(g("https://gitea.example.com/baanmali/site.git"), Some(Gitea { server: "https://gitea.example.com".into(), repo: "baanmali/site".into() }));
        assert_eq!(g("https://code.example.org/git/Baanmali/Site").map(|x| x.repo), Some("Baanmali/Site".into()));
        assert_eq!(g("git@codeberg.org:baanmali/site.git").map(|x| x.server), Some("https://codeberg.org".into()));
        assert_eq!(g("ssh://git@gitea.example.com:2222/baanmali/site.git").map(|x| x.repo), Some("baanmali/site".into()));
        for no in [
            "https://other.example.com/baanmali/site.git",
            "https://gitea.example.com/baanmali/site/extra",
            "https://gitea.example.com/-x/site",
            "https://github.com/baanmali/site.git",
            "https://gitlab.com/baanmali/site.git",
            "https://code.example.org/baanmali/site",
        ] {
            assert_eq!(g(no), None, "{no}");
        }
        assert!(parse_gt_hosts("not json").is_empty());
    }

    #[test]
    fn each_argv_only_lists() {
        let a = azure_argv(&azure());
        assert_eq!(a[..3], ["repos", "pr", "list"]);
        assert_eq!(a[a.iter().position(|w| w == "--project").unwrap() + 1], "Shop Site");
        assert_eq!(a[a.iter().position(|w| w == "--status").unwrap() + 1], "active");
        let g = gitea_argv(&Gitea { server: "https://gitea.example.com".into(), repo: "baanmali/site".into() });
        assert_eq!(g[..2], ["pr", "list"]);
        assert!(g.contains(&"--no-input".to_string()) && g.contains(&"open".to_string()));
        assert_eq!(gt_hosts_argv(), ["auth", "status", "--json=host", "--no-input"]);
        for argv in [a, g, gt_hosts_argv()] {
            for w in ["merge", "create", "close", "approve", "--web", "token", "--verify"] {
                assert!(!argv.iter().any(|x| x == w), "{w} in {argv:?}");
            }
        }
    }

    #[test]
    fn reads_a_recorded_azure_devops_list() {
        let b = parse_azure_board(&azure(), AZ_OUT).unwrap();
        assert_eq!(b.items.len(), 4);
        let by = |n: u64| b.items.iter().find(|p| p.item.number == n).unwrap();
        let first = by(31);
        assert_eq!((first.item.title.as_str(), first.item.author.as_str(), first.item.head.as_str(), first.base.as_str(), first.review.as_str()), ("PromptPay QR at checkout", "Noi Saetang", "kit/promptpay-qr", "main", "approved"));
        assert_eq!(first.item.url, "https://dev.azure.com/baanmali/Shop%20Site/_git/site/pullrequest/31");
        assert!(first.item.created > 0 && first.item.same);
        assert_eq!(by(32).review, "changes");
        assert!(by(33).conflict && by(33).review == "required");
        assert_eq!(by(34).item.state, "draft");
        assert!(!by(34).item.same, "a fork's request");
        // a token-like text in a title is masked
        assert!(!b.items.iter().any(|p| p.item.title.contains("ghp_")));
    }

    #[test]
    fn reads_a_recorded_gt_list() {
        let b = parse_gitea_board(GT_OUT).unwrap();
        assert_eq!(b.items.len(), 3);
        let by = |n: u64| b.items.iter().find(|p| p.item.number == n).unwrap();
        assert_eq!((by(7).item.author.as_str(), by(7).item.head.as_str(), by(7).base.as_str(), by(7).review.as_str()), ("noi", "fix/qr", "main", "approved"));
        assert_eq!(by(7).item.url, "https://gitea.example.com/baanmali/site/pulls/7");
        assert!(by(8).conflict && by(8).review == "changes");
        assert_eq!((by(9).item.state.as_str(), by(9).item.author.as_str(), by(9).item.head.as_str()), ("draft", "fon", "try/header"));
    }

    fn project(name: &str, url: &str) -> PathBuf {
        let d = temp(name);
        fs::create_dir_all(d.join(".git")).unwrap();
        fs::write(d.join(".git/config"), format!("[remote \"origin\"]\n\turl = {url}\n")).unwrap();
        d
    }

    #[test]
    fn a_host_whose_cli_is_not_here_shows_nothing_and_runs_nothing() {
        let az_dir = project("other-none-az", "https://dev.azure.com/baanmali/Shop%20Site/_git/site");
        let gt_dir = project("other-none-gt", "https://gitea.example.com/baanmali/site.git");
        let others = Others::with(az_dir.join("no-az"), gt_dir.join("no-gt"));
        assert_eq!(others.board(az_dir.to_str().unwrap()), Ok(None));
        assert_eq!(others.board(gt_dir.to_str().unwrap()), Ok(None));
        // a GitHub project is not one of these hosts' at all
        let hub = project("other-none-hub", "https://github.com/o/r.git");
        let bin = temp("other-none-bin");
        let az = stand_in(&bin, "exit 0");
        let others = Others::with(az.clone(), az);
        assert_eq!(others.board(hub.to_str().unwrap()), Ok(None));
        assert!(log_lines(&bin).is_empty());
        for d in [az_dir, gt_dir, hub, bin] {
            let _ = fs::remove_dir_all(d);
        }
    }

    #[test]
    fn an_azure_project_is_listed_through_az_once_a_minute() {
        let dir = project("other-az", "https://dev.azure.com/baanmali/Shop%20Site/_git/site");
        let bin = temp("other-az-bin");
        fs::write(bin.join("list.json"), AZ_OUT).unwrap();
        let az = stand_in(&bin, &format!("case \"$1 $2 $3\" in \"repos pr list\") [ \"$AZURE_EXTENSION_USE_DYNAMIC_INSTALL\" = no ] || exit 3; cat '{}'; exit 0;; esac; exit 2", bin.join("list.json").display()));
        let others = Others::with(az, bin.join("no-gt"));
        let got = others.board(dir.to_str().unwrap()).unwrap().unwrap();
        assert_eq!(got.remote, OtherRemote { host: "azure".into(), name: "Azure DevOps".into(), repo: "Shop Site/site".into() });
        assert_eq!(got.board.items.len(), 4);
        others.board(dir.to_str().unwrap()).unwrap();
        let log = log_lines(&bin);
        assert_eq!(log.len(), 1, "{log:?}");
        assert!(log[0].starts_with("repos pr list --organization https://dev.azure.com/baanmali/ --project Shop Site --repository site --status active"), "{log:?}");
        let _ = fs::remove_dir_all(dir);
        let _ = fs::remove_dir_all(bin);
    }

    #[test]
    fn a_gitea_project_is_listed_through_gt_only_when_gt_is_signed_in_to_its_server() {
        let dir = project("other-gt", "git@gitea.example.com:baanmali/site.git");
        let bin = temp("other-gt-bin");
        fs::write(bin.join("list.json"), GT_OUT).unwrap();
        fs::write(bin.join("hosts.json"), r#"[{"host": "https://gitea.example.com"}]"#).unwrap();
        let gt = stand_in(&bin, &format!("case \"$1 $2\" in \"auth status\") cat '{}'; exit 0;; \"pr list\") cat '{}'; exit 0;; esac; exit 2", bin.join("hosts.json").display(), bin.join("list.json").display()));
        let others = Others::with(bin.join("no-az"), gt);
        let got = others.board(dir.to_str().unwrap()).unwrap().unwrap();
        assert_eq!(got.remote, OtherRemote { host: "gitea".into(), name: "gitea.example.com".into(), repo: "baanmali/site".into() });
        assert_eq!(got.board.items.len(), 3);
        let log = log_lines(&bin);
        assert_eq!(log[0], "auth status --json=host --no-input ");
        assert!(log[1].starts_with("pr list --host https://gitea.example.com --repo baanmali/site --state open"), "{log:?}");
        // a server gt is not signed in to: nothing, and no list asked for
        fs::write(bin.join("hosts.json"), r#"[{"host": "https://other.example.com"}]"#).unwrap();
        let others = Others::with(bin.join("no-az"), bin.join("gh"));
        assert_eq!(others.board(dir.to_str().unwrap()), Ok(None));
        assert_eq!(log_lines(&bin).iter().filter(|l| l.starts_with("pr list")).count(), 1);
        let _ = fs::remove_dir_all(dir);
        let _ = fs::remove_dir_all(bin);
    }
}
