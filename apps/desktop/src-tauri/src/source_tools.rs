//! Settings › Source control (item 75): git, the GitHub CLI (`gh`) and the GitLab CLI (`glab`) on one page, each with whether it
//! is on this computer, its version and, for the two CLIs, whether it is signed in and as whom (names only). The page's shape is
//! T3 Code's Source control page (pingdotgg/t3code, MIT License): Version Control with git and its version, then each provider
//! with its CLI's version and account. The words and the reads are Manut AI's own.
//!
//! Every read here goes through a runner that already exists: `tasks::find` finds a program the way Tasks does, `tasks::run_env`
//! runs it (no shell, nothing on stdin, a time limit), `Tasks::status` says whether a CLI is signed in by `auth status`'s exit code
//! alone, and gh's accounts are `gh_me::Me::accounts` (`gh auth status --json hosts`, host and login only). glab's account is
//! `glab api user`, of which only `username` is read. A version is read from `--version`'s first line, and only its digits
//! cross to the page. Nothing is installed, signed in or changed from here: the page says how (the CLI's own login, in a
//! terminal).

use std::path::Path;
use std::time::Duration;

use serde::Serialize;
use serde_json::Value;

use crate::gh_me::Me;
use crate::tasks::{self, Source, Tasks};

/// How long a `--version` may take. A version needs no network, so a CLI that takes longer is not waited for.
const VERSION_LIMIT: Duration = Duration::from_secs(5);

/// One account a CLI is signed in to: the name, the host when it is not the CLI's usual one ("" for github.com and gitlab.com),
/// and whether it is the one the CLI uses now.
#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct Account {
    pub name: String,
    pub host: String,
    pub active: bool,
}

/// One program as the page shows it. `signed_in` is null for git, which has no sign-in of its own.
#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct Tool {
    pub installed: bool,
    /// The version's digits (`2.54.0`), "" when the program is missing or printed none.
    pub version: String,
    pub signed_in: Option<bool>,
    pub accounts: Vec<Account>,
}

/// The whole page: git, then GitHub's CLI, then GitLab's.
#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct Tools {
    pub git: Tool,
    pub github: Tool,
    pub gitlab: Tool,
}

/// The first version-like run of digits in `out`'s first line (`gh version 2.104.0 (2026-11-12)` is `2.104.0`; `git version
/// 2.54.0 (Apple Git-157)` is `2.54.0`), at most 32 characters; "" when there is none. glab's own line is not written in its
/// documentation, so the read takes the first such run wherever it is, and nothing else of the line reaches the page.
pub fn version_of(out: &str) -> String {
    let line = out.lines().map(str::trim).find(|l| !l.is_empty()).unwrap_or("");
    let bytes = line.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i].is_ascii_digit() && (i == 0 || !bytes[i - 1].is_ascii_alphanumeric() || bytes[i - 1] == b'v') {
            let start = i;
            let mut dots = 0;
            while i < bytes.len() && (bytes[i].is_ascii_digit() || (bytes[i] == b'.' && i + 1 < bytes.len() && bytes[i + 1].is_ascii_digit())) {
                if bytes[i] == b'.' {
                    dots += 1;
                }
                i += 1;
            }
            if dots >= 1 && i - start <= 32 {
                return line[start..i].to_string();
            }
        }
        i += 1;
    }
    String::new()
}

/// The version `exe --version` prints, or "" when it printed none in time.
fn version_at(exe: &Path) -> String {
    let argv = vec!["--version".to_string()];
    match tasks::run_env_for(exe, &argv, true, &[], &[], VERSION_LIMIT) {
        Ok(r) if r.code == Some(0) => version_of(&r.out),
        _ => String::new(),
    }
}

/// A GitLab username as GitLab allows one: letters, digits, `_`, `-` and `.`, at most 255 characters, not starting with `-`
/// or `.`. Anything else in the answer is not a name and is not shown.
pub fn gitlab_name_ok(n: &str) -> bool {
    !n.is_empty() && n.len() <= 255 && !n.starts_with(['-', '.']) && n.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.'))
}

/// The argv (after `glab`) that reads the signed-in GitLab user: `GET /user`, of which only `username` is read.
pub fn glab_user_argv() -> Vec<String> {
    vec!["api".into(), "user".into()]
}

/// The username of a `glab api user` answer, when it is one.
pub fn read_glab_user(out: &str) -> Option<String> {
    let v: Value = serde_json::from_str(out.trim()).ok()?;
    let n = v.get("username")?.as_str()?;
    gitlab_name_ok(n).then(|| n.to_string())
}

/// git as the page shows it: on this computer or not, and its version.
pub fn git_tool() -> Tool {
    match tasks::find("git") {
        None => Tool { installed: false, version: String::new(), signed_in: None, accounts: vec![] },
        Some(exe) => Tool { installed: true, version: version_at(&exe), signed_in: None, accounts: vec![] },
    }
}

/// gh as the page shows it. The accounts are gh_me.rs's list (host and login only), so the page and Settings › Accounts read the
/// same thing; signed in is `Tasks::status`'s, the word Tasks and the lanes' clean-up already go by.
pub fn github_tool(tasks: &Tasks, me: &Me, fresh: bool) -> Tool {
    let Some(exe) = tasks::find(Source::Github.program()) else {
        return Tool { installed: false, version: String::new(), signed_in: Some(false), accounts: vec![] };
    };
    let st = tasks.status(Source::Github, fresh);
    let accounts = me
        .accounts(fresh)
        .accounts
        .into_iter()
        .filter(|a| a.state == "success")
        .map(|a| Account { host: if a.host == "github.com" { String::new() } else { a.host.clone() }, name: a.login, active: a.active })
        .collect();
    Tool { installed: true, version: version_at(&exe), signed_in: Some(st.signed_in), accounts }
}

/// glab as the page shows it: the name `glab api user` answers, asked only once `auth status` said it is signed in.
pub fn gitlab_tool(tasks: &Tasks, fresh: bool) -> Tool {
    let Some(exe) = tasks::find(Source::Gitlab.program()) else {
        return Tool { installed: false, version: String::new(), signed_in: Some(false), accounts: vec![] };
    };
    let st = tasks.status(Source::Gitlab, fresh);
    let accounts = if st.signed_in {
        tasks::run_env(&exe, &glab_user_argv(), true, &[], &[])
            .ok()
            .filter(|r| r.code == Some(0))
            .and_then(|r| read_glab_user(&r.out))
            .map(|name| vec![Account { name, host: String::new(), active: true }])
            .unwrap_or_default()
    } else {
        vec![]
    };
    Tool { installed: true, version: version_at(&exe), signed_in: Some(st.signed_in), accounts }
}

/// The page: all three. `fresh` asks the CLIs again instead of the last minute's answer (the page's Check again).
pub fn read(tasks: &Tasks, me: &Me, fresh: bool) -> Tools {
    Tools { git: git_tool(), github: github_tool(tasks, me, fresh), gitlab: gitlab_tool(tasks, fresh) }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_version_is_the_first_run_of_digits_on_the_first_line() {
        for (out, want) in [
            ("gh version 2.104.0 (2026-11-12)\nhttps://github.com/cli/cli/releases/tag/v2.104.0\n", "2.104.0"),
            ("git version 2.54.0 (Apple Git-157)\n", "2.54.0"),
            ("git version 2.43.0\n", "2.43.0"),
            ("glab 1.52.0 (2026-10-01)\n", "1.52.0"),
            ("glab version v1.52.0\n", "1.52.0"),
            ("\n\n  tool 10.2\n", "10.2"),
            ("no version here\n", ""),
            ("build 2026\n", ""),
            ("x86_64 1.2.3\n", "1.2.3"),
            ("", ""),
        ] {
            assert_eq!(version_of(out), want, "{out:?}");
        }
        // nothing but the digits reaches the page, however long the line is
        assert_eq!(version_of(&format!("tool {}", "9.".repeat(40))).len(), 0);
    }

    #[test]
    fn a_gitlab_account_is_only_its_username() {
        assert_eq!(read_glab_user(r#"{"id":7,"username":"fon.s","name":"Fon","email":"fon@example.com","private_token":"glpat-x"}"#).as_deref(), Some("fon.s"));
        for bad in ["", "not json", "{}", r#"{"username":""}"#, r#"{"username":"-x"}"#, r#"{"username":"a b"}"#, r#"{"username":7}"#, "[]"] {
            assert_eq!(read_glab_user(bad), None, "{bad:?}");
        }
        assert_eq!(glab_user_argv(), vec!["api", "user"]);
    }

    #[test]
    fn git_reads_as_on_this_computer_with_its_version() {
        if tasks::find("git").is_none() {
            return;
        }
        let g = git_tool();
        assert!(g.installed && g.signed_in.is_none() && g.accounts.is_empty());
        assert!(g.version.split('.').count() >= 2 && g.version.split('.').all(|p| p.parse::<u32>().is_ok()), "{}", g.version);
    }

    #[cfg(unix)]
    #[test]
    fn a_version_is_read_from_the_programs_own_answer_and_a_failed_one_reads_as_none() {
        use std::os::unix::fs::PermissionsExt;
        let d = std::env::temp_dir().join(format!("manut-source-tools-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        let write = |name: &str, body: &str| {
            let p = d.join(name);
            std::fs::write(&p, format!("#!/bin/sh\n{body}\n")).unwrap();
            std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o755)).unwrap();
            p
        };
        assert_eq!(version_at(&write("glab", "echo 'glab 1.52.0 (2026-10-01)'")), "1.52.0");
        assert_eq!(version_at(&write("broken", "echo 'tool 1.0'; exit 3")), "");
        let _ = std::fs::remove_dir_all(&d);
    }
}
