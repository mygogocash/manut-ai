//! The one exception to "a lane brings the committed tree only" (`lane.rs`, docs/code-editor.md "Where a lane works"): the
//! project's own agent settings that git does not hold. A lane's folder is a fresh checkout, so without this a coding agent
//! in it would miss the MCP servers, skills, commands and local settings the person keeps in the project but never committed
//! (an untracked or ignored `.mcp.json`, `.claude/settings.local.json`, skills under `.claude/skills` or `.agents/skills`).
//!
//! What comes: only the files named in [`PROJECT_FILES`], each found in each CLI's own documentation, that git does not track
//! in the developer's folder, at the repository's top and in each folder down to the one the session started in. Nothing
//! else git ignores comes along (dependencies, build output, `.env`): those stay out for the reasons `lane.rs` gives.
//!
//! Copied, never linked: the lane's agent writes its own local settings (an "always allow" lands in a settings file), and a
//! link would carry that write into the developer's folder, which a lane never changes. A copy is the lane's own and goes
//! with the lane's folder.
//!
//! Never committed, never kept elsewhere: a copy stays only when git ignores it in the lane. Either the lane's own rules
//! already ignore it (the committed `.gitignore` files, the repository's `info/exclude` or the person's global excludes,
//! where Claude Code puts `**/.claude/settings.local.json`), or the copy is in an agent folder (`.claude`, `.codex`,
//! `.agents`) the lane did not have, which the app then makes with a `.gitignore` of `*` that ignores itself too. A copy
//! that git would still list as new is taken back at once and counted as stayed, so `git add -A` can never pick one up,
//! a turn's snapshot (which leaves out what git ignores) never stores one, a clean-up still sees the folder as clean, and
//! `git worktree remove` takes the copies with the folder.

use std::collections::{BTreeSet, HashSet};
use std::fs;
use std::io::Read;
use std::path::{Component, Path, PathBuf};

use crate::lane::Git;

/// The project files a coding agent reads its own settings from, by the name each CLI's documentation gives (Claude Code:
/// code.claude.com/docs/en/claude-directory, `settings`, `mcp`, `skills`; Codex: its `config-basic`, `agents-md` and
/// `build-skills` pages). A folder brings every file in it.
pub(crate) const PROJECT_FILES: [&str; 16] = [
    // Claude Code
    ".mcp.json",
    "CLAUDE.md",
    "CLAUDE.local.md",
    ".claude/CLAUDE.md",
    ".claude/settings.json",
    ".claude/settings.local.json",
    ".claude/skills",
    ".claude/commands",
    ".claude/agents",
    ".claude/output-styles",
    ".claude/rules",
    ".claude/workflows",
    // Codex
    "AGENTS.md",
    "AGENTS.override.md",
    ".codex/config.toml",
    ".agents/skills",
];

/// The agent folders the app may make in a lane, with a `.gitignore` of `*` in each, when the lane has no such folder.
const OWN_FOLDERS: [&str; 3] = [".claude", ".codex", ".agents"];
/// At most this many files come along; a person's settings are a handful.
const MAX_FILES: usize = 200;
/// The largest file that comes along; a settings file or a skill is far smaller.
const MAX_FILE: u64 = 1 << 20;
/// The most bytes that come along in all.
const MAX_BYTES: u64 = 8 << 20;

/// What came along. `files`: copied into the lane, every one ignored by git there. `stayed`: agent settings files that did
/// not come, because git would see them in the lane as new, or they are links, too big or too many. `counted`: how many of
/// `files` the developer's folder lists as new (untracked and not ignored), so the lane's "did not come along" count leaves
/// them out.
#[derive(Debug, Default, PartialEq, Eq)]
pub(crate) struct Brought {
    pub files: u32,
    pub stayed: u32,
    pub counted: u32,
}

/// The folders from the repository's top down to the one the session started in: "", `apps`, `apps/web`.
fn levels(prefix: &str) -> Vec<String> {
    let mut out = vec![String::new()];
    let mut at = String::new();
    for part in prefix.split('/').filter(|p| !p.is_empty()) {
        if !at.is_empty() {
            at.push('/');
        }
        at.push_str(part);
        out.push(at.clone());
    }
    out
}

/// The untracked files under the names in [`PROJECT_FILES`] at every level, as git lists them in `top` (relative to it).
/// `open`: only those git does not ignore there. Names are literal (`GIT_LITERAL_PATHSPECS`), never patterns.
fn untracked(git: &Git, top: &Path, prefix: &str, open: bool) -> Option<Vec<String>> {
    let specs: Vec<String> = levels(prefix).iter().flat_map(|l| PROJECT_FILES.iter().map(move |n| if l.is_empty() { (*n).to_string() } else { format!("{l}/{n}") })).collect();
    let mut args: Vec<&str> = vec!["ls-files", "-z", "--others"];
    if open {
        args.push("--exclude-standard");
    }
    args.push("--");
    args.extend(specs.iter().map(String::as_str));
    let ran = git.run_with(top, &args, crate::tasks::TIMEOUT, &[("GIT_LITERAL_PATHSPECS", "1")]).ok()?;
    (ran.code == Some(0)).then(|| ran.out.split('\0').filter(|p| !p.is_empty()).map(str::to_string).collect())
}

/// Whether `rel` is a plain relative path with nothing in it a lane leaves out (`.git`, `node_modules`).
fn plain(rel: &str) -> bool {
    let p = Path::new(rel);
    !rel.is_empty()
        && !rel.contains('\\')
        && p.components().all(|c| matches!(c, Component::Normal(n) if n != ".git" && n != "node_modules"))
}

/// The agent folder `rel` is in, relative to the lane's top (`apps/web/.claude`), when it is in one of [`OWN_FOLDERS`] at
/// one of the levels.
fn own_folder(rel: &str, levels: &[String]) -> Option<String> {
    levels.iter().find_map(|l| {
        let inner = if l.is_empty() { rel } else { rel.strip_prefix(l.as_str())?.strip_prefix('/')? };
        let first = inner.split('/').next()?;
        (OWN_FOLDERS.contains(&first) && inner.contains('/')).then(|| if l.is_empty() { first.to_string() } else { format!("{l}/{first}") })
    })
}

fn is_link(p: &Path) -> bool {
    fs::symlink_metadata(p).map(|m| m.file_type().is_symlink()).unwrap_or(false)
}

/// Makes each missing folder from `wt` down to `dir` (relative), refusing a link or a file on the way: nothing is written
/// through a link. The folders it made, outermost first.
fn make_dirs(wt: &Path, dir: &Path) -> Option<Vec<PathBuf>> {
    let mut at = wt.to_path_buf();
    let mut made = Vec::new();
    for c in dir.components() {
        let Component::Normal(n) = c else { return None };
        at.push(n);
        match fs::symlink_metadata(&at) {
            Ok(m) if m.is_dir() && !m.file_type().is_symlink() => {}
            Ok(_) => return None,
            Err(_) => {
                fs::create_dir(&at).ok()?;
                made.push(at.clone());
            }
        }
    }
    Some(made)
}

/// Writes `bytes` to the new file `path`, for this account only (and runnable by it when `exec`), never through a file or
/// link already there.
fn write_new(path: &Path, bytes: &[u8], exec: bool) -> std::io::Result<()> {
    use std::io::Write;
    let mut o = fs::OpenOptions::new();
    o.write(true).create_new(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut o, if exec { 0o700 } else { 0o600 });
    #[cfg(not(unix))]
    let _ = exec;
    let mut f = o.open(path)?;
    f.write_all(bytes).inspect_err(|_| {
        let _ = fs::remove_file(path);
    })
}

#[cfg(unix)]
fn runnable(m: &fs::Metadata) -> bool {
    use std::os::unix::fs::PermissionsExt;
    m.permissions().mode() & 0o100 != 0
}

#[cfg(not(unix))]
fn runnable(_: &fs::Metadata) -> bool {
    false
}

/// The paths `git status` lists as new in `wt` (untracked and not ignored), every one listed by itself.
fn new_in(git: &Git, wt: &Path) -> Option<HashSet<String>> {
    let ran = git.run(wt, &["status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignore-submodules=none"]).ok()?;
    if ran.code != Some(0) {
        return None;
    }
    Some(ran.out.split('\0').filter_map(|e| e.strip_prefix("?? ")).map(str::to_string).collect())
}

/// Brings the developer's agent settings that git does not hold from `top` (their repository's top) into the lane `wt`, at
/// the same paths. `prefix` is the folder inside the repository the session started in (`apps/web`, or ""). Never fails the
/// lane: whatever cannot come is counted as stayed.
pub(crate) fn bring(git: &Git, top: &Path, wt: &Path, prefix: &str) -> Brought {
    let mut out = Brought::default();
    let Some(all) = untracked(git, top, prefix, false) else { return out };
    if all.is_empty() {
        return out;
    }
    let open: HashSet<String> = untracked(git, top, prefix, true).unwrap_or_default().into_iter().collect();
    let lv = levels(prefix);
    let all: BTreeSet<String> = all.into_iter().collect();
    // the agent folders made here, each with its `.gitignore`, and every other folder made on the way
    let mut own_made: Vec<PathBuf> = Vec::new();
    let mut dirs_made: Vec<PathBuf> = Vec::new();
    let mut copied: Vec<String> = Vec::new();
    let mut bytes = 0u64;
    for rel in &all {
        let src = top.join(rel);
        let ok = plain(rel) && copied.len() < MAX_FILES;
        let meta = fs::symlink_metadata(&src).ok().filter(|m| m.is_file() && m.len() <= MAX_FILE && !m.file_type().is_symlink());
        let (true, Some(meta)) = (ok, meta) else {
            out.stayed += 1;
            continue;
        };
        if bytes + meta.len() > MAX_BYTES {
            out.stayed += 1;
            continue;
        }
        let dst = wt.join(rel);
        if fs::symlink_metadata(&dst).is_ok() {
            // the lane's own commit has it: that one stays
            continue;
        }
        // an agent folder the lane does not have is made with a `.gitignore` that ignores everything in it, itself too
        if let Some(own) = own_folder(rel, &lv) {
            let own_path = wt.join(&own);
            if fs::symlink_metadata(&own_path).is_err() {
                let Some(made) = make_dirs(wt, Path::new(&own)) else {
                    out.stayed += 1;
                    continue;
                };
                dirs_made.extend(made);
                if write_new(&own_path.join(".gitignore"), b"*\n", false).is_err() {
                    out.stayed += 1;
                    continue;
                }
                own_made.push(own_path);
            }
        }
        let parent = Path::new(rel).parent().unwrap_or(Path::new(""));
        let Some(made) = make_dirs(wt, parent) else {
            out.stayed += 1;
            continue;
        };
        dirs_made.extend(made);
        let mut data = Vec::new();
        let read = fs::File::open(&src).and_then(|f| f.take(MAX_FILE + 1).read_to_end(&mut data));
        if read.is_err() || data.len() as u64 > MAX_FILE || is_link(&src) || write_new(&dst, &data, runnable(&meta)).is_err() {
            out.stayed += 1;
            continue;
        }
        bytes += data.len() as u64;
        copied.push(rel.clone());
    }
    // a copy git would list as new in the lane goes again: it could be committed, and a clean-up would keep the folder for it
    let seen = new_in(git, wt);
    let mut kept = Vec::new();
    for rel in copied {
        let listed = seen.as_ref().is_none_or(|s| s.contains(&rel));
        if listed {
            let _ = fs::remove_file(wt.join(&rel));
            out.stayed += 1;
        } else {
            kept.push(rel);
        }
    }
    // an agent folder made here that still shows (its `.gitignore` was not read) goes with everything in it
    let still = new_in(git, wt).unwrap_or_default();
    for own in &own_made {
        let rel = own.strip_prefix(wt).map(|r| r.to_string_lossy().replace('\\', "/")).unwrap_or_default();
        if still.iter().any(|p| p == &format!("{rel}/.gitignore") || p.starts_with(&format!("{rel}/"))) {
            let gone: Vec<String> = kept.iter().filter(|k| k.starts_with(&format!("{rel}/"))).cloned().collect();
            out.stayed += gone.len() as u32;
            kept.retain(|k| !k.starts_with(&format!("{rel}/")));
            let _ = fs::remove_dir_all(own);
        }
    }
    // folders made for copies that went are taken away again, innermost first (a folder with anything in it stays)
    for d in dirs_made.iter().rev() {
        let _ = fs::remove_dir(d);
    }
    for own in &own_made {
        // an agent folder made here that holds nothing but its `.gitignore` goes too
        let only_ignore = fs::read_dir(own).map(|r| r.flatten().all(|e| e.file_name() == ".gitignore")).unwrap_or(false);
        if only_ignore {
            let _ = fs::remove_dir_all(own);
        }
    }
    out.files = kept.len() as u32;
    out.counted = kept.iter().filter(|k| open.contains(*k)).count() as u32;
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::lane::tests::{repo, sh};

    const SECRET: &str = "ghp_SECRET_never_committed";

    /// A file at `rel` under `dir`, its folders made.
    fn put(dir: &Path, rel: &str, text: &str) {
        let p = dir.join(rel);
        fs::create_dir_all(p.parent().unwrap()).unwrap();
        fs::write(p, text).unwrap();
    }

    fn read(dir: &Path, rel: &str) -> Option<String> {
        fs::read_to_string(dir.join(rel)).ok()
    }

    #[test]
    fn levels_run_from_the_top_to_the_sessions_folder() {
        assert_eq!(levels(""), vec![""]);
        assert_eq!(levels("apps/web"), vec!["", "apps", "apps/web"]);
        assert_eq!(own_folder(".claude/skills/a/SKILL.md", &levels("")), Some(".claude".into()));
        assert_eq!(own_folder("apps/web/.agents/skills/a/SKILL.md", &levels("apps/web")), Some("apps/web/.agents".into()));
        assert_eq!(own_folder(".mcp.json", &levels("")), None);
        assert_eq!(own_folder("CLAUDE.local.md", &levels("")), None);
        for bad in ["", "a/../b", "/abs", "x/.git/config", ".claude/skills/n/node_modules/x/SKILL.md", "a\\b"] {
            assert!(!plain(bad), "{bad}");
        }
        // every name is one a CLI's own documentation gives, and none is a credentials file
        for n in PROJECT_FILES {
            assert!(!n.contains("credentials") && !n.contains("auth") && !n.contains(".env"), "{n}");
        }
    }

    /// The lane made through `lane::make`, so the folders and records are the app's own.
    fn lane_of(home: &Path, d: &Path) -> crate::lane::Made {
        crate::lane::make(home, d, &crate::lane::tests::names(&["kit/settings"])).unwrap()
    }

    #[test]
    fn a_lane_brings_the_projects_own_agent_settings_ignored_and_nothing_else() {
        let Some((home, d)) = repo("lcfg-bring") else { return };
        // the developer's own, never committed: an ignored `.mcp.json` with a token, local settings, an untracked skill in a
        // folder git has never seen, Codex's project config and skills, and things that must stay: `.env`, installed modules
        fs::write(d.join(".gitignore"), "node_modules/\n.mcp.json\n.env\nCLAUDE.local.md\n").unwrap();
        sh(&d, &["add", ".gitignore"]);
        sh(&d, &["commit", "-q", "-m", "ignore"]);
        put(&d, ".mcp.json", &format!(r#"{{"mcpServers":{{"gh":{{"command":"gh-mcp","env":{{"TOKEN":"{SECRET}"}}}}}}}}"#));
        put(&d, "CLAUDE.local.md", "my notes\n");
        put(&d, ".claude/settings.local.json", r#"{"permissions":{"allow":["Bash(ls)"]}}"#);
        put(&d, ".claude/skills/promptpay/SKILL.md", "---\nname: promptpay\n---\n");
        put(&d, ".agents/skills/qr/SKILL.md", "---\nname: qr\n---\n");
        put(&d, ".codex/config.toml", "[mcp_servers.x]\ncommand = \"x\"\n");
        put(&d, ".env", &format!("KEY={SECRET}\n"));
        put(&d, "node_modules/x/index.js", "x\n");
        put(&d, ".claude/worktrees/old/a.txt", "a claude worktree\n");
        let made = lane_of(&home, &d);
        let wt = PathBuf::from(&made.worktree);
        assert_eq!(read(&wt, ".mcp.json").as_deref().map(|s| s.contains(SECRET)), Some(true));
        assert_eq!(read(&wt, "CLAUDE.local.md").as_deref(), Some("my notes\n"));
        assert!(read(&wt, ".claude/settings.local.json").is_some());
        assert!(read(&wt, ".claude/skills/promptpay/SKILL.md").is_some());
        assert!(read(&wt, ".agents/skills/qr/SKILL.md").is_some());
        assert!(read(&wt, ".codex/config.toml").is_some());
        // nothing else git ignores comes along
        for no in [".env", "node_modules/x/index.js", ".claude/worktrees/old/a.txt"] {
            assert!(!wt.join(no).exists(), "{no}");
        }
        assert_eq!((made.config, made.stayed), (6, 0));
        // every copy is one git ignores in the lane: the folder reads as clean, `git add -A` takes nothing
        assert_eq!(sh(&wt, &["status", "--porcelain", "--untracked-files=all"]), "");
        sh(&wt, &["add", "-A"]);
        assert_eq!(sh(&wt, &["diff", "--cached", "--name-only"]), "");
        // the copies are for this account only
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(fs::metadata(wt.join(".mcp.json")).unwrap().permissions().mode() & 0o777, 0o600);
        }
        // the developer's folder is as it was: the copies are the lane's own, so a change in the lane stays there
        fs::write(wt.join(".claude/settings.local.json"), "{}").unwrap();
        assert!(read(&d, ".claude/settings.local.json").unwrap().contains("Bash(ls)"));
        // and the copies go with the lane's folder: a clean-up sees nothing to keep it for
        let r = crate::lane::release(&home, &made.worktree, false).unwrap();
        assert!(r.removed, "{r:?}");
        assert!(!wt.exists());
        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn a_file_git_would_see_in_the_lane_stays_behind() {
        let Some((home, d)) = repo("lcfg-stay") else { return };
        // `.mcp.json` untracked and not ignored at the top (no folder of the app's can ignore it there), and a skill in a
        // `.claude` folder the lane has from the commit: neither may come, since either could be committed from the lane
        fs::create_dir_all(d.join(".claude")).unwrap();
        fs::write(d.join(".claude/settings.json"), "{}").unwrap();
        sh(&d, &["add", ".claude/settings.json"]);
        sh(&d, &["commit", "-q", "-m", "team settings"]);
        put(&d, ".mcp.json", &format!(r#"{{"mcpServers":{{"x":{{"url":"https://x.example/mcp?key={SECRET}"}}}}}}"#));
        put(&d, ".claude/skills/mine/SKILL.md", "---\nname: mine\n---\n");
        // the developer counts both as changed files in their folder
        let made = lane_of(&home, &d);
        let wt = PathBuf::from(&made.worktree);
        assert!(!wt.join(".mcp.json").exists());
        assert!(!wt.join(".claude/skills").exists(), "no folder is left behind for a copy that went");
        assert_eq!((made.config, made.stayed), (0, 2));
        assert_eq!(made.left, 2);
        assert_eq!(sh(&wt, &["status", "--porcelain", "--untracked-files=all"]), "");
        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn an_untracked_skill_in_a_new_agent_folder_comes_and_leaves_the_count_of_files_left() {
        let Some((home, d)) = repo("lcfg-own") else { return };
        // untracked and not ignored in the developer's folder: it counts there as a changed file, but it comes along now
        put(&d, ".agents/skills/qr/SKILL.md", "---\nname: qr\n---\n");
        put(&d, "notes.txt", "mine\n");
        let made = lane_of(&home, &d);
        let wt = PathBuf::from(&made.worktree);
        assert_eq!(read(&wt, ".agents/.gitignore").as_deref(), Some("*\n"));
        assert!(wt.join(".agents/skills/qr/SKILL.md").exists());
        assert_eq!((made.config, made.stayed, made.left), (1, 0, 1), "notes.txt did not come along; the skill did");
        assert_eq!(sh(&wt, &["status", "--porcelain", "--untracked-files=all"]), "");
        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn a_session_in_a_folder_brings_that_folders_settings_too() {
        let Some((home, d)) = repo("lcfg-sub") else { return };
        put(&d, "apps/web/.claude/settings.local.json", "{}");
        put(&d, ".claude/skills/top/SKILL.md", "x\n");
        let made = crate::lane::make(&home, &d.join("apps/web"), &crate::lane::tests::names(&["kit/sub"])).unwrap();
        let wt = PathBuf::from(&made.worktree);
        assert!(wt.join("apps/web/.claude/settings.local.json").exists());
        assert!(wt.join(".claude/skills/top/SKILL.md").exists());
        assert_eq!(made.config, 2);
        assert_eq!(sh(&wt, &["status", "--porcelain", "--untracked-files=all"]), "");
        let _ = fs::remove_dir_all(home);
    }

    #[cfg(unix)]
    #[test]
    fn a_link_never_comes_and_nothing_is_written_through_one() {
        let Some((home, d)) = repo("lcfg-link") else { return };
        let away = home.join("away");
        fs::create_dir_all(&away).unwrap();
        fs::write(away.join("SKILL.md"), "x\n").unwrap();
        fs::create_dir_all(d.join(".claude/skills")).unwrap();
        std::os::unix::fs::symlink(&away, d.join(".claude/skills/linked")).unwrap();
        std::os::unix::fs::symlink(away.join("SKILL.md"), d.join("CLAUDE.local.md")).unwrap();
        let made = lane_of(&home, &d);
        let wt = PathBuf::from(&made.worktree);
        assert!(fs::symlink_metadata(wt.join(".claude/skills/linked")).is_err());
        assert!(fs::symlink_metadata(wt.join("CLAUDE.local.md")).is_err());
        assert_eq!((made.config, made.stayed), (0, 2));
        let _ = fs::remove_dir_all(home);
    }
}
