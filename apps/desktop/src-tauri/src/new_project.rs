//! A new project (item 100b, part 2): a folder the person names or picks, made by the shell inside their home folder, with git
//! started in it by the app's own git, so the Code page can list it as a project. It writes only on this Mac: the folder, and the
//! `.git` folder `git init` makes. Making it on GitHub too is a separate write, asked through review.rs's one ask
//! (`Ledger::ask_repo`), and nothing is ever pushed from here.
//!
//! The folder's rules:
//!
//! - An absolute path with no `.` or `..` part, inside the person's home folder and not the home folder itself. Inside is read on
//!   real paths: the nearest folder of the path that exists is resolved (`canonicalize`) and must be in the home folder's real
//!   path, so a link on the way that leads elsewhere is outside.
//! - A path that exists must be a folder, not a link, and empty (`not_empty`): a project is never started over someone's files.
//! - The folder is made with `create_dir_all`, its real path checked once more, and then `git init --quiet --template=` runs in it
//!   through `lane::Git` (no hook can run, `core.hooksPath` names a folder that is never made; an empty `--template=` copies no
//!   template, so no sample hook and no exclude file is written, whatever `init.templateDir` the person set).
use std::path::{Component, Path, PathBuf};

use serde::Serialize;

use crate::lane::Git;
use crate::tasks;

/// What was made: the project's folder (its real path) and its name.
#[derive(Clone, Debug, Default, Serialize, PartialEq)]
pub struct Made {
    pub folder: String,
    pub name: String,
    /// The folder was there already, empty, and only git was started in it.
    pub existed: bool,
}

/// The longest path taken.
const PATH_MAX: usize = 1024;

/// `path` as the page named it, when it is one the rules allow at all: absolute, short, with no `.` or `..` part.
pub fn path_ok(path: &str) -> Result<PathBuf, String> {
    let p = PathBuf::from(path);
    let dotted = path.split(['/', '\\']).any(|part| part == "." || part == "..");
    if path.is_empty() || path.len() > PATH_MAX || !p.is_absolute() || dotted || path.chars().any(char::is_control) || p.components().any(|c| matches!(c, Component::CurDir | Component::ParentDir)) {
        return Err("bad_path".into());
    }
    Ok(p)
}

/// Whether the real path `real` is inside the real home folder `home` (and not the home folder itself).
fn inside(real: &Path, home: &Path) -> bool {
    real != home && real.starts_with(home)
}

/// The nearest folder of `p` that exists, as its real path.
fn nearest_real(p: &Path) -> Option<PathBuf> {
    let mut at = Some(p);
    while let Some(x) = at {
        if std::fs::symlink_metadata(x).is_ok() {
            return x.canonicalize().ok();
        }
        at = x.parent();
    }
    None
}

/// Where a new project may be: `path`'s real place, checked against the real home folder. Err `bad_path`, `outside_home`,
/// `link`, `not_a_folder` or `not_empty`; Ok(true) when the folder is there already (empty).
pub fn check(home: &Path, path: &str) -> Result<(PathBuf, bool), String> {
    let p = path_ok(path)?;
    let home = home.canonicalize().map_err(|_| "no_home".to_string())?;
    let near = nearest_real(&p).ok_or("outside_home")?;
    if !(near == home || inside(&near, &home)) {
        return Err("outside_home".into());
    }
    match std::fs::symlink_metadata(&p) {
        Ok(m) if m.file_type().is_symlink() => Err("link".into()),
        Ok(m) if !m.is_dir() => Err("not_a_folder".into()),
        Ok(_) => {
            let real = p.canonicalize().map_err(|_| "outside_home".to_string())?;
            if !inside(&real, &home) {
                return Err("outside_home".into());
            }
            let empty = std::fs::read_dir(&real).map_err(|_| "unreadable".to_string())?.next().is_none();
            if !empty {
                return Err("not_empty".into());
            }
            Ok((real, true))
        }
        Err(_) => Ok((p, false)),
    }
}

/// Makes the project at `path` (see the top of this file): the folder when it is not there, then git in it.
pub fn make(home: &Path, path: &str) -> Result<Made, String> {
    let (p, existed) = check(home, path)?;
    let git = Git::new(home)?;
    if !existed {
        std::fs::create_dir_all(&p).map_err(|e| format!("make_failed:{}", tasks::one_line(e.to_string(), 200)))?;
    }
    // what was made is still where it was asked for: nothing on the way turned into a link meanwhile
    let real = p.canonicalize().map_err(|_| "outside_home".to_string())?;
    let real_home = home.canonicalize().map_err(|_| "no_home".to_string())?;
    if !inside(&real, &real_home) {
        return Err("outside_home".into());
    }
    let ran = git.run(&real, &["init", "--quiet", "--template="])?;
    if ran.code != Some(0) {
        return Err(format!("init_failed:{}", tasks::error_line(&ran.err)));
    }
    let name = real.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    Ok(Made { folder: real.to_string_lossy().into_owned(), name, existed })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn home(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("manut-newproj-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d.canonicalize().unwrap()
    }

    #[test]
    fn a_new_folder_in_home_is_made_with_git_and_no_hook_or_template() {
        if tasks::find("git").is_none() {
            return;
        }
        let h = home("make");
        let path = h.join("code/shop-site");
        let made = make(&h, path.to_str().unwrap()).unwrap();
        assert_eq!(made, Made { folder: path.to_string_lossy().into_owned(), name: "shop-site".into(), existed: false });
        assert!(path.join(".git/HEAD").is_file());
        // no template was copied: no sample hook, no exclude file
        assert!(!path.join(".git/hooks").exists() && !path.join(".git/info").exists());
        // only `.git` is in it
        assert_eq!(fs::read_dir(&path).unwrap().count(), 1);
        let _ = fs::remove_dir_all(h);
    }

    #[test]
    fn an_empty_folder_that_exists_is_taken_and_one_with_files_is_refused() {
        if tasks::find("git").is_none() {
            return;
        }
        let h = home("existing");
        let empty = h.join("empty");
        fs::create_dir_all(&empty).unwrap();
        assert!(make(&h, empty.to_str().unwrap()).unwrap().existed);
        let full = h.join("full");
        fs::create_dir_all(&full).unwrap();
        fs::write(full.join("notes.txt"), "mine").unwrap();
        assert_eq!(make(&h, full.to_str().unwrap()), Err("not_empty".into()));
        // a hidden file counts too
        let hidden = h.join("hidden");
        fs::create_dir_all(&hidden).unwrap();
        fs::write(hidden.join(".env"), "KEY=x").unwrap();
        assert_eq!(make(&h, hidden.to_str().unwrap()), Err("not_empty".into()));
        assert!(!hidden.join(".git").exists() && !full.join(".git").exists());
        // a file is not a folder
        fs::write(h.join("file"), "x").unwrap();
        assert_eq!(make(&h, h.join("file").to_str().unwrap()), Err("not_a_folder".into()));
        let _ = fs::remove_dir_all(h);
    }

    #[test]
    fn a_path_outside_home_or_dotted_or_relative_is_refused_and_nothing_is_made() {
        let h = home("outside");
        let other = home("outside-other");
        for bad in [
            other.join("site").to_string_lossy().into_owned(),
            format!("{}/../outside-escape", h.display()),
            format!("{}/./site", h.display()),
            "code/site".to_string(),
            h.to_string_lossy().into_owned(),
            String::new(),
        ] {
            let got = make(&h, &bad);
            assert!(matches!(got.as_ref().map_err(String::as_str), Err("outside_home" | "bad_path")), "{bad}: {got:?}");
        }
        assert!(!other.join("site").exists());
        let _ = fs::remove_dir_all(h);
        let _ = fs::remove_dir_all(other);
    }

    #[cfg(unix)]
    #[test]
    fn a_link_on_the_way_out_of_home_or_at_the_folder_is_refused() {
        use std::os::unix::fs::symlink;
        let h = home("link");
        let other = home("link-other");
        // `~/code` leads out of the home folder: a project under it would be made outside
        symlink(&other, h.join("code")).unwrap();
        assert_eq!(make(&h, h.join("code/site").to_str().unwrap()), Err("outside_home".into()));
        assert!(!other.join("site").exists());
        // the folder itself is a link, even to an empty folder inside home
        fs::create_dir_all(h.join("real")).unwrap();
        symlink(h.join("real"), h.join("alias")).unwrap();
        assert_eq!(make(&h, h.join("alias").to_str().unwrap()), Err("link".into()));
        let _ = fs::remove_dir_all(h);
        let _ = fs::remove_dir_all(other);
    }
}
