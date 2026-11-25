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

use std::path::{Path, PathBuf};

use serde::Serialize;

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
