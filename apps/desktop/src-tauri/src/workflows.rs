//! Workflows (item 77b): the files in `~/.manut/workflows/`, read for Settings › Workflows. A workflow is a JSON file the
//! person keeps there (its name, the project, the coding agent, the steps and an optional time); the page reads and checks
//! each one (`src/workflows/file.ts`) and runs it as a lane of its own, through the same chat start a person's own lane uses.
//!
//! The shell only reads here, and makes the folder when the page's Show folder asks for it. It never writes, renames or
//! deletes a file in the folder, so a file it cannot read stays exactly as the person left it, listed with the reason:
//!
//! - only the folder's own files are read: dot-files and subfolders are left alone, and so is a file whose name does not
//!   end in `.json` (a note or a README beside the workflows is not a workflow);
//! - a `.json` file is listed with a reason instead of its text when its name is not a plain one (`name`), when it is a link
//!   (`link`: never read through one, as the shell's own files are never written through one), when it is over 64 KB
//!   (`too_big`), when it cannot be read (`unreadable`) or when it is not UTF-8 text (`not_text`);
//! - at most 100 files are listed, in name order, and the rest are counted (`more`);
//! - a folder that is a link is not read at all (`state: link`).
//!
//! Item 91: a workflow's `project` is checked here when the person allows the workflow and again before every run
//! ([`project`]). A run starts only in the top folder of a git repository, written as its real path, that is not the home
//! folder, a disk's top, a folder that holds the home folder or the app's own folder, or anything inside the app's own folder.
//! The lane a run starts in is made from that repository (lane.rs), and what counts as inside the project for Kit's dial is
//! that folder, so a folder this check would let through could never be wider than one repository.

use std::path::{Component, Path, PathBuf};

use serde::Serialize;

use crate::lane;

/// A workflow file is read only up to this size: a few steps of plain text are a few kilobytes.
pub const FILE_MAX: u64 = 64 * 1024;
/// At most this many files are listed.
pub const FILES_MAX: usize = 100;
/// A file name's length cap, in bytes.
const NAME_MAX: usize = 100;

/// What the folder is, as the page says it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum State {
    /// Read: its files are listed.
    Ok,
    /// Not made yet: no workflow exists.
    Missing,
    /// A link: not read, so nothing outside the app's own folder is taken for a workflow.
    Link,
    /// There, but the shell could not list it.
    Unreadable,
}

/// One `.json` file of the folder: its text, or why it was not read.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct File {
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub why: Option<&'static str>,
}

/// The folder as the page is told it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Folder {
    pub path: String,
    pub state: State,
    pub files: Vec<File>,
    /// Files past [`FILES_MAX`], not listed.
    pub more: usize,
}

/// Where the workflows live: `~/.manut/workflows`.
pub fn folder(home: &Path) -> PathBuf {
    home.join(".manut").join("workflows")
}

/// A plain file name: a letter or digit first, then letters, digits, `.`, `_` and `-`, ending in `.json`.
fn plain_name(name: &str) -> bool {
    name.len() <= NAME_MAX
        && name.len() > ".json".len()
        && name.ends_with(".json")
        && name.bytes().next().is_some_and(|c| c.is_ascii_alphanumeric())
        && name.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'.' || c == b'_' || c == b'-')
}

/// One file's text, or why it is not read. Its metadata is read without following a link.
fn read_one(path: &Path, name: &str) -> Option<File> {
    let meta = std::fs::symlink_metadata(path).ok()?;
    let why = |w: &'static str| Some(File { name: name.to_string(), text: None, why: Some(w) });
    if meta.file_type().is_symlink() {
        return why("link");
    }
    // a subfolder named `x.json`, a pipe or a device is not a file: left alone, as a subfolder is
    if !meta.is_file() {
        return None;
    }
    if !plain_name(name) {
        return why("name");
    }
    if meta.len() > FILE_MAX {
        return why("too_big");
    }
    let Ok(bytes) = std::fs::read(path) else {
        return why("unreadable");
    };
    // read again after the length check: a file that grew meanwhile is still held to the cap
    if bytes.len() as u64 > FILE_MAX {
        return why("too_big");
    }
    match String::from_utf8(bytes) {
        Ok(text) => Some(File { name: name.to_string(), text: Some(text), why: None }),
        Err(_) => why("not_text"),
    }
}

/// The folder's workflow files, read now. Reads only; nothing in the folder changes.
pub fn read(home: &Path) -> Folder {
    let dir = folder(home);
    let path = dir.to_string_lossy().into_owned();
    let out = |state: State| Folder { path: path.clone(), state, files: Vec::new(), more: 0 };
    match std::fs::symlink_metadata(&dir) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return out(State::Missing),
        Err(_) => return out(State::Unreadable),
        Ok(m) if m.file_type().is_symlink() => return out(State::Link),
        Ok(m) if !m.is_dir() => return out(State::Unreadable),
        Ok(_) => {}
    }
    // the app's own folder is read only when no part of it is a link either
    if std::fs::symlink_metadata(home.join(".manut")).is_ok_and(|m| m.file_type().is_symlink()) {
        return out(State::Link);
    }
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return out(State::Unreadable);
    };
    let mut names: Vec<String> = entries
        .filter_map(Result::ok)
        .filter_map(|e| e.file_name().into_string().ok())
        .filter(|n| !n.starts_with('.') && n.to_ascii_lowercase().ends_with(".json"))
        .collect();
    names.sort();
    let mut folder = out(State::Ok);
    for name in names {
        let Some(file) = read_one(&dir.join(&name), &name) else { continue };
        if folder.files.len() >= FILES_MAX {
            folder.more += 1;
        } else {
            folder.files.push(file);
        }
    }
    folder
}

/// The page's Show folder: the folder made when it is not there yet (never through a link), and its path.
pub fn make(home: &Path) -> Result<PathBuf, String> {
    let manut = home.join(".manut");
    let dir = folder(home);
    for p in [&manut, &dir] {
        if std::fs::symlink_metadata(p).is_ok_and(|m| m.file_type().is_symlink()) {
            return Err("link".to_string());
        }
    }
    std::fs::create_dir_all(&dir).map_err(|_| "unwritable".to_string())?;
    Ok(dir)
}

/// The longest project path read.
const PROJECT_MAX: usize = 1024;

/// `p` without Windows' verbatim prefix (`\\?\C:\...`), which `canonicalize` adds there, so it compares with a path as written.
fn plain(p: PathBuf) -> PathBuf {
    #[cfg(windows)]
    {
        let s = p.to_string_lossy();
        if let Some(rest) = s.strip_prefix(r"\\?\") {
            if rest.as_bytes().get(1) == Some(&b':') {
                return PathBuf::from(rest.to_string());
            }
        }
    }
    p
}

/// Whether `p` is the top of a disk: no folder above it, or one on another disk (a volume's own top folder, where a disk is
/// mounted). A folder that cannot be read is taken as one.
fn disk_top(p: &Path) -> bool {
    let Some(parent) = p.parent() else { return true };
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        match (std::fs::metadata(p), std::fs::metadata(parent)) {
            (Ok(a), Ok(b)) => a.dev() != b.dev(),
            _ => true,
        }
    }
    // elsewhere only a drive's own top is known for one (no folder above it, above)
    #[cfg(not(unix))]
    {
        let _ = parent;
        false
    }
}

/// Whether the workflow's project `written` is a folder a run may start in, checked as it is now: its real path, or a short
/// code the page says in words (`src/workflows/words.ts`):
///
/// - `missing`: not an absolute path written plainly, not there, or not a folder.
/// - `link`: a link on the way to it, or letters the disk writes differently: the path written must be its real path, so the
///   folder allowed is the folder that runs, and it cannot be pointed somewhere else later.
/// - `too_broad`: the disk's top or another disk's top, the home folder, or a folder that holds the home folder or the app's
///   own folder (`~/.manut`, wherever it really is).
/// - `app_folder`: inside the app's own folder, or a lane's working folder made under a folder the person chose.
/// - `not_repo`: not the top folder of a git repository (no `.git` in it, or git says its top is another folder).
/// - `no_git`: git is not installed, so no lane can be made.
///
/// git is asked only `rev-parse --show-toplevel`, as the app's own automatic work runs it (no hook, no file monitor, no
/// `ext::` remote): a program the repository names never runs.
pub fn project(home: &Path, written: &str) -> Result<String, &'static str> {
    let path = Path::new(written);
    // a `.` or `..` part is refused as written (Rust's own reading of a path drops a `.` in the middle)
    let dotted = written.split(['/', '\\']).any(|x| x == "." || x == "..");
    if written.is_empty() || written.len() > PROJECT_MAX || written.chars().any(char::is_control) || dotted || !path.is_absolute() || path.components().any(|c| !matches!(c, Component::RootDir | Component::Prefix(_) | Component::Normal(_))) {
        return Err("missing");
    }
    let real = plain(std::fs::canonicalize(path).map_err(|_| "missing")?);
    if !real.is_dir() {
        return Err("missing");
    }
    // compared part by part: a written path that only ends in a separator is the same folder
    if real != path {
        return Err("link");
    }
    let home_real = plain(std::fs::canonicalize(home).unwrap_or_else(|_| home.to_path_buf()));
    let own = home_real.join(".manut");
    let own_real = plain(std::fs::canonicalize(&own).unwrap_or_else(|_| own.clone()));
    if disk_top(&real) || home_real.starts_with(&real) || own_real.starts_with(&real) {
        return Err("too_broad");
    }
    if real.starts_with(&own) || real.starts_with(&own_real) || lane::in_a_lane(home, &real) || lane::in_a_lane(&home_real, &real) {
        return Err("app_folder");
    }
    // git's own folder or file (a linked worktree's) right in it: anything deeper inside a repository is not its top
    if std::fs::symlink_metadata(real.join(".git")).is_err() {
        return Err("not_repo");
    }
    let git = lane::Git::automatic(home).map_err(|_| "no_git")?;
    let ran = git.run(&real, &["rev-parse", "--show-toplevel"]).map_err(|_| "not_repo")?;
    let top = ran.out.lines().next().unwrap_or("").trim();
    if ran.code != Some(0) || top.is_empty() || std::fs::canonicalize(top).map(plain).ok().as_deref() != Some(real.as_path()) {
        return Err("not_repo");
    }
    Ok(real.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Home(PathBuf);
    impl Home {
        fn new(tag: &str) -> Self {
            let p = std::env::temp_dir().join(format!("manut-workflows-{tag}-{}", std::process::id()));
            let _ = std::fs::remove_dir_all(&p);
            std::fs::create_dir_all(&p).unwrap();
            Home(p)
        }
        fn dir(&self) -> PathBuf {
            let d = folder(&self.0);
            std::fs::create_dir_all(&d).unwrap();
            d
        }
    }
    impl Drop for Home {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn names(f: &Folder) -> Vec<(&str, Option<&str>)> {
        f.files.iter().map(|x| (x.name.as_str(), x.why)).collect()
    }

    #[test]
    fn a_folder_that_is_not_there_is_missing_and_nothing_is_made_by_reading_it() {
        let h = Home::new("missing");
        let f = read(&h.0);
        assert_eq!(f.state, State::Missing);
        assert!(f.files.is_empty());
        assert!(!folder(&h.0).exists());
        assert_eq!(f.path, folder(&h.0).to_string_lossy());
    }

    #[test]
    fn reads_the_json_files_in_name_order_and_leaves_everything_else_alone() {
        let h = Home::new("order");
        let d = h.dir();
        std::fs::write(d.join("b-nightly.json"), "{\"name\":\"B\"}").unwrap();
        std::fs::write(d.join("a.json"), "{}").unwrap();
        std::fs::write(d.join("README.md"), "notes").unwrap();
        std::fs::write(d.join(".hidden.json"), "{}").unwrap();
        std::fs::create_dir_all(d.join("helpers.json")).unwrap();
        std::fs::create_dir_all(d.join("sub")).unwrap();
        std::fs::write(d.join("sub").join("c.json"), "{}").unwrap();
        let f = read(&h.0);
        assert_eq!(f.state, State::Ok);
        assert_eq!(names(&f), vec![("a.json", None), ("b-nightly.json", None)]);
        assert_eq!(f.files[1].text.as_deref(), Some("{\"name\":\"B\"}"));
        assert_eq!(f.more, 0);
    }

    #[test]
    fn says_why_a_file_is_not_read_and_never_changes_it() {
        let h = Home::new("why");
        let d = h.dir();
        std::fs::write(d.join("my flow.json"), "{}").unwrap();
        std::fs::write(d.join("big.json"), vec![b' '; FILE_MAX as usize + 1]).unwrap();
        std::fs::write(d.join("latin.json"), [0xff, 0xfe, 0x00]).unwrap();
        std::fs::write(d.join("ok.json"), "{}").unwrap();
        let f = read(&h.0);
        assert_eq!(names(&f), vec![("big.json", Some("too_big")), ("latin.json", Some("not_text")), ("my flow.json", Some("name")), ("ok.json", None)]);
        assert!(f.files.iter().filter(|x| x.why.is_some()).all(|x| x.text.is_none()));
        // every file is as it was
        assert_eq!(std::fs::read(d.join("latin.json")).unwrap(), vec![0xff, 0xfe, 0x00]);
        assert_eq!(std::fs::metadata(d.join("big.json")).unwrap().len(), FILE_MAX + 1);
        assert!(d.join("my flow.json").exists());
    }

    #[cfg(unix)]
    #[test]
    fn never_reads_through_a_link() {
        let h = Home::new("link");
        let d = h.dir();
        let elsewhere = h.0.join("elsewhere.json");
        std::fs::write(&elsewhere, "{\"secret\":1}").unwrap();
        std::os::unix::fs::symlink(&elsewhere, d.join("linked.json")).unwrap();
        let f = read(&h.0);
        assert_eq!(names(&f), vec![("linked.json", Some("link"))]);
        assert!(f.files[0].text.is_none());

        // a folder that is a link is not read at all
        let h2 = Home::new("linkdir");
        let real = h2.0.join("real");
        std::fs::create_dir_all(&real).unwrap();
        std::fs::write(real.join("a.json"), "{}").unwrap();
        std::fs::create_dir_all(h2.0.join(".manut")).unwrap();
        std::os::unix::fs::symlink(&real, folder(&h2.0)).unwrap();
        let f2 = read(&h2.0);
        assert_eq!(f2.state, State::Link);
        assert!(f2.files.is_empty());
        assert_eq!(make(&h2.0), Err("link".to_string()));
    }

    #[test]
    fn lists_at_most_a_hundred_files_and_counts_the_rest() {
        let h = Home::new("many");
        let d = h.dir();
        for i in 0..(FILES_MAX + 3) {
            std::fs::write(d.join(format!("w{i:03}.json")), "{}").unwrap();
        }
        let f = read(&h.0);
        assert_eq!(f.files.len(), FILES_MAX);
        assert_eq!(f.more, 3);
        assert_eq!(f.files[0].name, "w000.json");
    }

    #[test]
    fn show_folder_makes_the_folder_once() {
        let h = Home::new("make");
        let made = make(&h.0).unwrap();
        assert_eq!(made, folder(&h.0));
        assert!(made.is_dir());
        // again: the same folder, nothing else
        assert_eq!(make(&h.0).unwrap(), made);
        assert_eq!(read(&h.0).state, State::Ok);
    }

    /// Item 91: every folder a workflow's `project` may name, as the disk has it, and what the check says of each. Only a
    /// repository's own top folder, written as its real path and narrower than the home folder and the app's own, passes.
    #[cfg(unix)]
    #[test]
    fn a_project_is_only_a_repositorys_top_folder_written_as_its_real_path() {
        use crate::lane::tests::{repo, sh};
        use std::os::unix::fs::symlink;
        let Some((home, web)) = repo("wf-project") else {
            eprintln!("git is not installed: the project check's table is not run");
            return;
        };
        let s = |p: &Path| p.to_string_lossy().into_owned();
        let check = |p: &str| project(&home, p);

        // a repository's top folder, written as its real path (a final separator is the same folder)
        assert_eq!(check(&s(&web)), Ok(s(&web)));
        assert_eq!(check(&format!("{}/", s(&web))), Ok(s(&web)));
        // a linked worktree's top folder is a repository's top folder too
        let wt = home.join("code").join("web-app-wt");
        sh(&web, &["worktree", "add", "-q", "-b", "side", &s(&wt)]);
        assert_eq!(check(&s(&wt)), Ok(s(&wt)));

        // the hostile folders, each with why
        std::fs::create_dir_all(home.join("notes")).unwrap();
        symlink(&web, home.join("code").join("web-link")).unwrap();
        symlink(home.join("code"), home.join("code-link")).unwrap();
        std::fs::create_dir_all(home.join("fake").join(".git")).unwrap();
        std::fs::create_dir_all(home.join("stray")).unwrap();
        std::fs::write(home.join("stray").join(".git"), "gitdir: /nowhere/at/all\n").unwrap();
        // the app's own folder, and a repository made inside it
        let inside = home.join(".manut").join("lanes").join("web-app").join("try");
        std::fs::create_dir_all(&inside).unwrap();
        sh(&inside, &["init", "-q"]);
        let up = home.parent().unwrap().to_path_buf();
        let table: Vec<(String, &str)> = vec![
            (s(&home), "too_broad"),
            (s(&up), "too_broad"),
            ("/".into(), "too_broad"),
            (s(&home.join(".manut")), "too_broad"),
            (s(&inside), "app_folder"),
            (s(&home.join("notes")), "not_repo"),
            (s(&web.join("apps")), "not_repo"),
            (s(&web.join("apps").join("web")), "not_repo"),
            (s(&home.join("fake")), "not_repo"),
            (s(&home.join("stray")), "not_repo"),
            (s(&home.join("code").join("web-link")), "link"),
            (s(&home.join("code-link").join("web-app")), "link"),
            (s(&web.join("a.txt")), "missing"),
            (s(&home.join("gone")), "missing"),
            (format!("{}/../web-app", s(&web)), "missing"),
            (format!("{}/./apps", s(&web)), "missing"),
            ("code/web-app".into(), "missing"),
            (format!("{}\n", s(&web)), "missing"),
            (String::new(), "missing"),
            (format!("/{}", "a".repeat(PROJECT_MAX)), "missing"),
        ];
        for (p, why) in &table {
            assert_eq!(check(p), Err(*why), "{p:?}");
        }
        // the same letters in another case are never the folder allowed: not there, or not the repository's own top
        assert!(check(&s(&web).replace("web-app", "WEB-APP")).is_err());

        // the home folder stays refused when it is a repository itself (a dotfiles checkout)
        sh(&home, &["init", "-q"]);
        assert_eq!(check(&s(&home)), Err("too_broad"));
    }

    /// The app's own folder kept somewhere else through a link: a repository that holds where it really is, is as broad as the
    /// home folder for this check; and a lane's working folder under a folder the person chose is the app's own.
    #[cfg(unix)]
    #[test]
    fn a_project_never_holds_the_apps_own_folder_nor_is_a_lanes_folder() {
        use crate::lane::tests::{names, repo, sh};
        let Some((home, web)) = repo("wf-own") else {
            eprintln!("git is not installed: not run");
            return;
        };
        let s = |p: &Path| p.to_string_lossy().into_owned();
        let data = home.parent().unwrap().join(format!("manut-wf-data-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&data);
        std::fs::create_dir_all(data.join("kept")).unwrap();
        sh(&data, &["init", "-q"]);
        std::os::unix::fs::symlink(data.join("kept"), home.join(".manut")).unwrap();
        assert_eq!(project(&home, &s(&data)), Err("too_broad"));
        assert_eq!(project(&home, &s(&web)), Ok(s(&web)));
        std::fs::remove_file(home.join(".manut")).unwrap();
        let _ = std::fs::remove_dir_all(&data);

        // a lane made under a folder the person chose (Settings › Worktrees) is a repository's top, and the app's own
        let root = home.join("lanes-root");
        let made = lane::make_with(&home, &web, &names(&["kit/try-it"]), &lane::Start { root: s(&root), remote: false }).unwrap();
        assert!(Path::new(&made.worktree).starts_with(root.canonicalize().unwrap()));
        assert_eq!(project(&home, &made.worktree), Err("app_folder"));
        // and one made in the default place, inside the app's own folder
        let made = lane::make(&home, &web, &names(&["kit/try-again"])).unwrap();
        assert_eq!(project(&home, &made.worktree), Err("app_folder"));
        assert_eq!(project(&home, &s(&web)), Ok(s(&web)));
    }

    #[test]
    fn a_plain_name_is_letters_digits_dots_underscores_and_hyphens() {
        for ok in ["a.json", "nightly-tests.json", "v2_flow.json", "A1.b.json"] {
            assert!(plain_name(ok), "{ok}");
        }
        for bad in [".json", "-a.json", "a b.json", "a.JSON", "ทดสอบ.json", "a.json.txt", &format!("{}.json", "a".repeat(NAME_MAX))] {
            assert!(!plain_name(bad), "{bad}");
        }
    }
}
