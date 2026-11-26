//! Bring over the person's own Claude Code and Codex work (item 101e): the folders those agents worked in on this Mac that
//! are still there, and how many conversations each has, so the page can offer them as projects. The page adds the folders
//! the person picks to its project list and shows their conversations in History, where they are continued as past_chats.rs
//! already allows. This module only reads, and only names a folder and counts: no word of a conversation leaves it.
//!
//! It reads with past_chats.rs's readers, so a conversation here is one there: the same homes (the one a new session of the
//! agent uses), the same transcripts (Claude Code's `<home>/projects/<folder slug>/<uuid>.jsonl`, whose own `cwd` names its
//! folder because the slug is lossy; Codex's `<home>/sessions/YYYY/MM/DD/rollout-*.jsonl`, whose first line's
//! `session_meta` names it), the same rule that the person typed something in it (a Codex subagent's thread or a fork is not
//! a conversation of its own), and the same refusal of links (`past_chats::inside`). Each transcript is read from its start
//! only until its folder and a typed line are found ([`past_chats::head_until`]), at most `Limits::head` bytes.
//!
//! What is skipped is counted, never an error that stops the rest:
//! * `gone`: a folder that is no longer on this Mac (counted once per folder);
//! * `compressed`: a Codex rollout written compressed (`.jsonl.zst`), which no reader here opens (item 106b);
//! * `unreadable`: a link under the agents' folders, a file that cannot be opened, or one that is not JSON lines;
//! * `over_limit`: files past the bounds ([`Limits`]), oldest first, and then the answer is `partial`.
//!
//! Not offered at all: the home folder itself and the disk's root (a project of everything the person has is not a project,
//! and its conversations stay in the + menu, which offers home), and folders under the app's own `~/.manut` (its lanes and
//! account homes are the app's, not the person's projects).
use std::collections::HashMap;
use std::path::{Path, PathBuf};

use serde::Serialize;
use serde_json::Value;

use crate::past_chats;
use crate::sessions::is_uuid;

#[derive(Clone, Copy, Debug)]
pub struct Limits {
    /// Transcripts looked at per agent, newest first.
    pub files: usize,
    /// Bytes read from the start of one transcript at most.
    pub head: u64,
    /// Bytes read per agent at most (each transcript counted at its size or `head`, whichever is less).
    pub bytes: u64,
    /// Folder entries visited per agent.
    pub walk: usize,
}

impl Default for Limits {
    fn default() -> Self {
        Limits { files: 3_000, head: past_chats::HEAD, bytes: 256 * 1024 * 1024, walk: 50_000 }
    }
}

/// One folder the agents worked in, still on this Mac.
#[derive(Serialize, Debug, Clone, PartialEq)]
pub struct Project {
    /// The folder as the agents recorded it, without a trailing separator.
    pub cwd: String,
    /// Conversations of each agent in it.
    pub claude: u32,
    pub codex: u32,
    /// The newest of them changed at, seconds since the epoch.
    pub at: f64,
}

#[derive(Serialize, Debug, Clone, Default, PartialEq)]
pub struct Skipped {
    pub gone: u32,
    pub compressed: u32,
    pub unreadable: u32,
    pub over_limit: u32,
}

#[derive(Serialize, Debug, Clone, PartialEq)]
pub struct Found {
    /// Newest first.
    pub projects: Vec<Project>,
    pub skipped: Skipped,
    /// A bound stopped the look before every transcript was read.
    pub partial: bool,
}

#[derive(Default)]
struct Tally {
    by: HashMap<String, Project>,
    skipped: Skipped,
    partial: bool,
}

#[derive(Clone, Copy)]
enum Agent {
    Claude,
    Codex,
}

impl Tally {
    fn add(&mut self, cwd: &str, agent: Agent, at: f64) {
        if !past_chats::absolute(cwd) {
            return;
        }
        let key = folder_key(cwd);
        let p = self.by.entry(key.clone()).or_insert(Project { cwd: key, claude: 0, codex: 0, at: 0.0 });
        match agent {
            Agent::Claude => p.claude += 1,
            Agent::Codex => p.codex += 1,
        }
        if at > p.at {
            p.at = at;
        }
    }

    /// `rest` files past a bound: not looked at.
    fn over(&mut self, rest: usize) {
        self.skipped.over_limit += rest as u32;
        self.partial = true;
    }
}

/// One spelling per folder, as past_chats.rs compares them: a trailing separator goes (the root stays).
fn folder_key(cwd: &str) -> String {
    let t = cwd.trim_end_matches(['/', '\\']);
    if t.is_empty() { cwd.to_string() } else { t.to_string() }
}

fn link(p: &Path) -> bool {
    std::fs::symlink_metadata(p).map(|m| m.file_type().is_symlink()).unwrap_or(false)
}

fn size(p: &Path) -> u64 {
    std::fs::metadata(p).map(|m| m.len()).unwrap_or(0)
}

/// Claude Code's transcripts under `root`, newest first; each one's folder taken from its own `cwd`.
fn claude(root: &Path, l: &Limits, t: &mut Tally) {
    let projects = root.join("projects");
    if link(&projects) {
        t.skipped.unreadable += 1;
        return;
    }
    if !past_chats::plain_dir(&projects) {
        return;
    }
    let Ok(rd) = std::fs::read_dir(&projects) else {
        t.skipped.unreadable += 1;
        return;
    };
    let mut budget = l.walk;
    let mut files: Vec<(f64, PathBuf)> = Vec::new();
    'walk: for e in rd.flatten() {
        let dir = e.path();
        let Ok(m) = std::fs::symlink_metadata(&dir) else { continue };
        if m.file_type().is_symlink() {
            t.skipped.unreadable += 1;
            continue;
        }
        if !m.is_dir() {
            continue;
        }
        let Ok(inner) = std::fs::read_dir(&dir) else {
            t.skipped.unreadable += 1;
            continue;
        };
        for f in inner.flatten() {
            if budget == 0 {
                t.partial = true;
                break 'walk;
            }
            budget -= 1;
            let name = f.file_name();
            let Some(stem) = name.to_str().and_then(|n| n.strip_suffix(".jsonl")) else { continue };
            if !is_uuid(stem) {
                continue;
            }
            let p = f.path();
            let Ok(fm) = std::fs::symlink_metadata(&p) else { continue };
            if fm.file_type().is_symlink() {
                t.skipped.unreadable += 1;
                continue;
            }
            if fm.is_file() {
                files.push((past_chats::mtime(&p), p));
            }
        }
    }
    files.sort_by(|a, b| b.0.total_cmp(&a.0).then_with(|| a.1.cmp(&b.1)));
    let mut bytes = 0u64;
    for (i, (at, p)) in files.iter().enumerate() {
        if i >= l.files || bytes >= l.bytes {
            t.over(files.len() - i);
            break;
        }
        let Some(real) = past_chats::inside(root, p) else {
            t.skipped.unreadable += 1;
            continue;
        };
        let size = size(&real);
        bytes += size.min(l.head);
        let (mut cwd, mut typed) = (String::new(), false);
        let read = past_chats::head_until(&real, l.head, &mut |o: &Value| {
            if cwd.is_empty() {
                if let Some(c) = o.get("cwd").and_then(Value::as_str).filter(|c| !c.is_empty()) {
                    cwd = c.to_string();
                }
            }
            typed = typed || past_chats::claude_user_text(o).is_some();
            !cwd.is_empty() && typed
        });
        match read {
            // it could not be opened or read, or it has something in it and none of it is JSON lines
            None => t.skipped.unreadable += 1,
            Some(0) if size > 0 => t.skipped.unreadable += 1,
            // only `/clear`, or nothing the person typed: not a conversation, as the + menu does not list it
            _ if cwd.is_empty() || !typed => {}
            _ => t.add(&cwd, Agent::Claude, *at),
        }
    }
}

/// Codex's rollouts under `root`, newest first; each one's folder from its `session_meta`.
fn codex(root: &Path, l: &Limits, t: &mut Tally) {
    let sessions = root.join("sessions");
    if link(&sessions) {
        t.skipped.unreadable += 1;
        return;
    }
    let mut zst = 0u32;
    let files = past_chats::codex_rollouts_seen(root, l.walk, &mut zst);
    t.skipped.compressed += zst;
    let mut bytes = 0u64;
    for (i, p) in files.iter().enumerate() {
        if i >= l.files || bytes >= l.bytes {
            t.over(files.len() - i);
            break;
        }
        let Some(real) = past_chats::inside(root, p) else {
            t.skipped.unreadable += 1;
            continue;
        };
        let size = size(&real);
        bytes += size.min(l.head);
        let (mut first, mut meta, mut typed) = (true, None::<(String, String)>, false);
        let read = past_chats::head_until(&real, l.head, &mut |o: &Value| {
            if first {
                first = false;
                meta = past_chats::codex_meta(std::slice::from_ref(o));
                // not a conversation of its own (a subagent's thread, a fork, no session_meta): nothing more to look for
                return meta.is_none();
            }
            typed = past_chats::codex_user_text(o).is_some();
            typed
        });
        match (read, meta) {
            (None, _) => t.skipped.unreadable += 1,
            (Some(0), _) if size > 0 => t.skipped.unreadable += 1,
            (_, Some((_, cwd))) if typed && !cwd.is_empty() => t.add(&cwd, Agent::Codex, past_chats::mtime(&real)),
            _ => {}
        }
    }
}

/// Whether `cwd` is a folder offered at all: not the home folder, not the disk's root, not under the app's own `~/.manut`.
fn offered(cwd: &str, home: &Path) -> bool {
    let p = Path::new(cwd);
    if p.parent().is_none() {
        return false;
    }
    let homes = [Some(home.to_path_buf()), home.canonicalize().ok()];
    !homes.iter().flatten().any(|h| p == h.as_path() || p.starts_with(h.join(".manut")))
}

/// The folders Claude Code (its home `claude`) and Codex (`codex`) worked in, with their conversations counted (see the top
/// of this file). `home` is the person's home folder. Reads only.
pub fn scan(home: &Path, claude_root: Option<&Path>, codex_root: Option<&Path>, l: &Limits) -> Found {
    let mut t = Tally::default();
    if let Some(r) = claude_root {
        claude(r, l, &mut t);
    }
    if let Some(r) = codex_root {
        codex(r, l, &mut t);
    }
    let mut projects = Vec::new();
    let mut skipped = t.skipped;
    for (cwd, p) in t.by {
        if !offered(&cwd, home) {
            continue;
        }
        // asked of the folder itself, a link followed as the agent followed it into it; nothing in it is read
        if !std::fs::metadata(&cwd).map(|m| m.is_dir()).unwrap_or(false) {
            skipped.gone += 1;
            continue;
        }
        projects.push(p);
    }
    projects.sort_by(|a, b| b.at.total_cmp(&a.at).then_with(|| a.cwd.cmp(&b.cwd)));
    Found { projects, skipped, partial: t.partial }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::past_chats::claude_slug;
    use serde_json::json;
    use std::collections::BTreeMap;
    use std::io::Write;
    use std::sync::atomic::{AtomicU32, Ordering};

    /// A made-up home folder in the temp folder, removed when dropped.
    struct Tmp(PathBuf);
    impl Tmp {
        fn new(tag: &str) -> Tmp {
            static N: AtomicU32 = AtomicU32::new(0);
            let p = std::env::temp_dir().join(format!("manut-import-{tag}-{}-{}", std::process::id(), N.fetch_add(1, Ordering::Relaxed)));
            let _ = std::fs::remove_dir_all(&p);
            std::fs::create_dir_all(&p).unwrap();
            Tmp(p.canonicalize().unwrap())
        }
    }
    impl Drop for Tmp {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn write(p: &Path, lines: &[Value]) {
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        let mut f = std::fs::File::create(p).unwrap();
        for l in lines {
            writeln!(f, "{l}").unwrap();
        }
    }

    fn uuid(n: u32) -> String {
        format!("{n:08x}-2222-4333-8444-555555555555")
    }

    /// A Claude Code transcript in `cwd`: a meta line, then the person's words when `said`.
    fn claude_file(cwd: &str, said: bool) -> Vec<Value> {
        let mut v = vec![
            json!({"type": "user", "isMeta": true, "cwd": cwd, "message": {"role": "user", "content": "<local-command-caveat>x</local-command-caveat>"}}),
            json!({"type": "user", "cwd": cwd, "message": {"role": "user", "content": "<command-name>/clear</command-name>"}}),
        ];
        if said {
            v.push(json!({"type": "user", "cwd": cwd, "message": {"role": "user", "content": "Fix the login page"}}));
            v.push(json!({"type": "assistant", "cwd": cwd, "message": {"id": "m1", "role": "assistant", "content": [{"type": "text", "text": "Done."}]}}));
        }
        v
    }

    fn codex_file(id: &str, cwd: &str) -> Vec<Value> {
        vec![
            json!({"type": "session_meta", "payload": {"id": id, "cwd": cwd, "originator": "codex-tui", "source": "cli"}}),
            json!({"type": "response_item", "payload": {"type": "message", "role": "user", "content": [{"type": "input_text", "text": "# AGENTS.md instructions for /w\n..."}]}}),
            json!({"type": "response_item", "payload": {"type": "message", "role": "user", "content": [{"type": "input_text", "text": "Add a dark theme"}]}}),
        ]
    }

    /// Every file under `dir` with its bytes: what a read-only look must leave as it was.
    fn snapshot(dir: &Path) -> BTreeMap<PathBuf, (Vec<u8>, Option<std::time::SystemTime>)> {
        let mut out = BTreeMap::new();
        let mut stack = vec![dir.to_path_buf()];
        while let Some(d) = stack.pop() {
            for e in std::fs::read_dir(&d).unwrap().flatten() {
                let p = e.path();
                let m = std::fs::symlink_metadata(&p).unwrap();
                if m.is_dir() {
                    stack.push(p);
                } else if m.is_file() {
                    out.insert(p.clone(), (std::fs::read(&p).unwrap(), m.modified().ok()));
                } else {
                    out.insert(p.clone(), (Vec::new(), None));
                }
            }
        }
        out
    }

    fn set_mtime(p: &Path, secs: u64) {
        let f = std::fs::File::options().write(true).open(p).unwrap();
        f.set_modified(std::time::UNIX_EPOCH + std::time::Duration::from_secs(secs)).unwrap();
    }

    #[test]
    fn finds_each_folder_with_its_conversations_newest_first_and_counts_what_it_skipped() {
        let home = Tmp::new("home");
        let h = &home.0;
        let claude_root = h.join(".claude");
        let codex_root = h.join(".codex");
        // two projects on disk, one that is gone
        let web = h.join("code/web-app");
        let api = h.join("code/shop-api");
        std::fs::create_dir_all(&web).unwrap();
        std::fs::create_dir_all(&api).unwrap();
        let (web, api) = (web.to_string_lossy().into_owned(), api.to_string_lossy().into_owned());
        let gone = h.join("code/old-site").to_string_lossy().into_owned();
        let cdir = |cwd: &str| claude_root.join("projects").join(claude_slug(cwd));
        // web-app: two Claude Code conversations and an empty one (only /clear), which is not a conversation
        write(&cdir(&web).join(format!("{}.jsonl", uuid(1))), &claude_file(&web, true));
        write(&cdir(&web).join(format!("{}.jsonl", uuid(2))), &claude_file(&web, true));
        write(&cdir(&web).join(format!("{}.jsonl", uuid(3))), &claude_file(&web, false));
        set_mtime(&cdir(&web).join(format!("{}.jsonl", uuid(1))), 1_000);
        set_mtime(&cdir(&web).join(format!("{}.jsonl", uuid(2))), 2_000);
        // not a transcript's name: never opened
        write(&cdir(&web).join("notes.jsonl"), &claude_file(&web, true));
        // a file that is not JSON lines, under a folder whose slug says web-app
        std::fs::write(cdir(&web).join(format!("{}.jsonl", uuid(4))), "this is not json\nnor this\n").unwrap();
        // the gone folder's conversation: counted as one gone folder
        write(&cdir(&gone).join(format!("{}.jsonl", uuid(5))), &claude_file(&gone, true));
        // Codex: one in shop-api, newest of all; a subagent's thread and a compressed rollout
        let day = codex_root.join("sessions/2026/11/20");
        let x1 = "01a1d060-4ab7-72b2-b02b-1dbee1d5f52c";
        write(&day.join(format!("rollout-2026-11-20T10-00-00-{x1}.jsonl")), &codex_file(x1, &api));
        set_mtime(&day.join(format!("rollout-2026-11-20T10-00-00-{x1}.jsonl")), 5_000);
        let x2 = "01a1d060-7a13-75e3-aa36-356cd0706c8a";
        let mut sub = codex_file(x2, &api);
        sub[0]["payload"]["source"] = json!({"subagent": {"thread_spawn": {"parent_thread_id": x1}}});
        write(&day.join(format!("rollout-2026-11-20T10-05-00-{x2}.jsonl")), &sub);
        std::fs::write(day.join("rollout-2026-11-20T11-00-00-01a1d060-0000-75e3-aa36-356cd0706c8a.jsonl.zst"), [0x28, 0xb5, 0x2f, 0xfd]).unwrap();
        // Codex in web-app too, with a trailing slash on its folder: the same project
        let x3 = "01a1d060-1111-75e3-aa36-356cd0706c8a";
        write(&day.join(format!("rollout-2026-11-20T09-00-00-{x3}.jsonl")), &codex_file(x3, &format!("{web}/")));
        set_mtime(&day.join(format!("rollout-2026-11-20T09-00-00-{x3}.jsonl")), 3_000);
        let before = snapshot(h);

        let found = scan(h, Some(&claude_root), Some(&codex_root), &Limits::default());
        assert_eq!(
            found.projects,
            vec![
                Project { cwd: api.clone(), claude: 0, codex: 1, at: 5_000.0 },
                Project { cwd: web.clone(), claude: 2, codex: 1, at: 3_000.0 },
            ]
        );
        assert_eq!(found.skipped, Skipped { gone: 1, compressed: 1, unreadable: 1, over_limit: 0 });
        assert!(!found.partial);
        // nothing under the home folder changed: no file written, moved, removed or touched
        assert_eq!(snapshot(h), before);
        // a second look finds the same
        assert_eq!(scan(h, Some(&claude_root), Some(&codex_root), &Limits::default()), found);
    }

    #[test]
    fn no_agent_folders_finds_nothing_and_says_nothing_was_skipped() {
        let home = Tmp::new("empty");
        let found = scan(&home.0, Some(&home.0.join(".claude")), Some(&home.0.join(".codex")), &Limits::default());
        assert_eq!(found, Found { projects: vec![], skipped: Skipped::default(), partial: false });
        assert_eq!(scan(&home.0, None, None, &Limits::default()).projects, vec![]);
    }

    #[test]
    fn the_home_folder_the_disk_root_and_the_apps_own_folders_are_not_offered() {
        let home = Tmp::new("own");
        let h = &home.0;
        let root = h.join(".claude");
        let lane = h.join(".manut/lanes/web-app/fix-login");
        std::fs::create_dir_all(&lane).unwrap();
        for (i, cwd) in [h.to_string_lossy().into_owned(), "/".to_string(), lane.to_string_lossy().into_owned(), "relative/folder".to_string()].iter().enumerate() {
            write(&root.join("projects").join(claude_slug(cwd)).join(format!("{}.jsonl", uuid(10 + i as u32))), &claude_file(cwd, true));
        }
        let found = scan(h, Some(&root), None, &Limits::default());
        assert_eq!(found.projects, vec![]);
        assert_eq!(found.skipped, Skipped::default());
    }

    #[test]
    fn past_the_bounds_the_oldest_are_counted_not_read() {
        let home = Tmp::new("bounds");
        let h = &home.0;
        let root = h.join(".claude");
        let web = h.join("web");
        std::fs::create_dir_all(&web).unwrap();
        let web = web.to_string_lossy().into_owned();
        for i in 0..5u32 {
            let p = root.join("projects").join(claude_slug(&web)).join(format!("{}.jsonl", uuid(20 + i)));
            write(&p, &claude_file(&web, true));
            set_mtime(&p, 1_000 + i as u64);
        }
        let found = scan(h, Some(&root), None, &Limits { files: 3, ..Limits::default() });
        assert_eq!(found.projects, vec![Project { cwd: web.clone(), claude: 3, codex: 0, at: 1_004.0 }]);
        assert_eq!(found.skipped.over_limit, 2);
        assert!(found.partial);
        // a walk that runs out of entries says the answer is partial too
        assert!(scan(h, Some(&root), None, &Limits { walk: 2, ..Limits::default() }).partial);
    }

    #[test]
    fn a_long_transcript_is_read_only_until_its_folder_and_first_words() {
        let home = Tmp::new("long");
        let h = &home.0;
        let root = h.join(".claude");
        let web = h.join("web");
        std::fs::create_dir_all(&web).unwrap();
        let web = web.to_string_lossy().into_owned();
        let p = root.join("projects").join(claude_slug(&web)).join(format!("{}.jsonl", uuid(30)));
        let mut lines = claude_file(&web, true);
        // a line far past the head, which is not valid JSON: never reached
        let filler = "x".repeat(4_000);
        for _ in 0..200 {
            lines.push(json!({"type": "attachment", "pad": filler}));
        }
        write(&p, &lines);
        std::fs::OpenOptions::new().append(true).open(&p).unwrap().write_all(b"{broken\n").unwrap();
        let found = scan(h, Some(&root), None, &Limits { head: 64 * 1024, ..Limits::default() });
        assert_eq!(found.projects.len(), 1);
        assert_eq!(found.skipped.unreadable, 0);
        // its words come after the head: it is not counted, and it is not called unreadable either
        let late = root.join("projects").join(claude_slug(&web)).join(format!("{}.jsonl", uuid(31)));
        let mut lines: Vec<Value> = (0..40).map(|_| json!({"type": "attachment", "cwd": web, "pad": filler})).collect();
        lines.extend(claude_file(&web, true));
        write(&late, &lines);
        let found = scan(h, Some(&root), None, &Limits { head: 64 * 1024, ..Limits::default() });
        assert_eq!((found.projects[0].claude, found.skipped.unreadable), (1, 0));
    }

    #[cfg(unix)]
    #[test]
    fn links_under_the_agents_folders_are_refused_and_counted() {
        use std::os::unix::fs::symlink;
        let home = Tmp::new("links");
        let away = Tmp::new("links-away");
        let h = &home.0;
        let root = h.join(".claude");
        let web = h.join("web");
        std::fs::create_dir_all(&web).unwrap();
        let web = web.to_string_lossy().into_owned();
        // a transcript outside the home, linked in as a file
        write(&away.0.join("t.jsonl"), &claude_file(&web, true));
        std::fs::create_dir_all(root.join("projects").join(claude_slug(&web))).unwrap();
        symlink(away.0.join("t.jsonl"), root.join("projects").join(claude_slug(&web)).join(format!("{}.jsonl", uuid(40)))).unwrap();
        // a linked project folder
        write(&away.0.join("slug").join(format!("{}.jsonl", uuid(41))), &claude_file(&web, true));
        symlink(away.0.join("slug"), root.join("projects").join("-linked")).unwrap();
        let found = scan(h, Some(&root), None, &Limits::default());
        assert_eq!(found.projects, vec![]);
        assert_eq!(found.skipped.unreadable, 2);
        // a linked projects folder, and a linked Codex sessions folder
        let other = Tmp::new("links-root");
        std::fs::create_dir_all(other.0.join(".claude")).unwrap();
        symlink(root.join("projects"), other.0.join(".claude/projects")).unwrap();
        std::fs::create_dir_all(other.0.join(".codex")).unwrap();
        symlink(away.0.clone(), other.0.join(".codex/sessions")).unwrap();
        let found = scan(&other.0, Some(&other.0.join(".claude")), Some(&other.0.join(".codex")), &Limits::default());
        assert_eq!((found.projects.len(), found.skipped.unreadable), (0, 2));
    }

    #[cfg(unix)]
    #[test]
    fn a_transcript_that_cannot_be_opened_is_counted_and_the_rest_are_read() {
        use std::os::unix::fs::PermissionsExt;
        let home = Tmp::new("perm");
        let h = &home.0;
        let root = h.join(".claude");
        let web = h.join("web");
        std::fs::create_dir_all(&web).unwrap();
        let web = web.to_string_lossy().into_owned();
        let dir = root.join("projects").join(claude_slug(&web));
        write(&dir.join(format!("{}.jsonl", uuid(50))), &claude_file(&web, true));
        let shut = dir.join(format!("{}.jsonl", uuid(51)));
        write(&shut, &claude_file(&web, true));
        std::fs::set_permissions(&shut, std::fs::Permissions::from_mode(0o000)).unwrap();
        // root can open anything: the check means nothing there
        if std::fs::File::open(&shut).is_err() {
            let found = scan(h, Some(&root), None, &Limits::default());
            assert_eq!((found.projects[0].claude, found.skipped.unreadable), (1, 1));
        }
        std::fs::set_permissions(&shut, std::fs::Permissions::from_mode(0o644)).unwrap();
    }
}
