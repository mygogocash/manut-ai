//! A SESSIONS row's menu: show the session's folder in the file manager, or open the person's own system terminal
//! in it (BOUNDARY rule 30). Neither runs anything in the folder: the file manager is the system opener, and the
//! terminal starts the person's own shell there with no command and nothing typed into it. That terminal is not the
//! agent's terminal view inside manut (sessions.rs); it is the desktop's own Terminal / console window.
//!
//! A third action, "open in an editor" (item 107), follows every rule below. The editors are a fixed list of ids
//! (`EDITORS`); the page names one by id and never by a path or a command, and a typed command is not offered: it would
//! be a way to run anything, which needs the design of an ask (docs/decisions.md). Each is found on this computer by
//! its app bundle (macOS) or its command on the person's PATH, never through a shell.
//!
//! The folder is the only other thing that crosses from the page. It must be an absolute path to a folder that exists. It
//! is never put into a shell string: on macOS it is one argument to `open -a Terminal`, elsewhere it is only the new
//! process's working folder (and one `--working-directory=` style argument for the Linux terminals that need it).
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use crate::accounts::{resolve, search_dirs};
use crate::platform::Os;
use crate::platform::Desk;

/// `cwd` when it is an absolute path to an existing folder (links followed: a project folder may be one).
pub fn folder(cwd: &str) -> Result<PathBuf, String> {
    let p = PathBuf::from(cwd);
    if cwd.is_empty() || !p.is_absolute() || cwd.contains('\0') {
        return Err("not a folder".into());
    }
    let real = p.canonicalize().map_err(|_| "the folder is not there".to_string())?;
    if !real.is_dir() {
        return Err("not a folder".into());
    }
    Ok(real)
}

/// Terminal programs to try, in order, as (program, argv). Each runs with `dir` as its working folder.
pub fn launchers(desk: Desk, dir: &Path) -> Vec<(String, Vec<OsString>)> {
    let with = |flag: &str| -> OsString {
        let mut s = OsString::from(flag);
        s.push(dir.as_os_str());
        s
    };
    match desk {
        // LaunchServices opens Terminal with a new window in that folder
        Desk::Mac => vec![("open".into(), vec!["-a".into(), "Terminal".into(), dir.as_os_str().to_owned()])],
        // `start` opens a new console window running `cmd` in the working folder; its first quoted argument is
        // the window title. The folder is not on the command line, so `cmd` never parses it.
        Desk::Windows => vec![("cmd".into(), vec!["/c".into(), "start".into(), "".into(), "cmd".into()])],
        Desk::Linux => vec![
            ("x-terminal-emulator".into(), vec![]),
            ("gnome-terminal".into(), vec![with("--working-directory=")]),
            ("konsole".into(), vec!["--workdir".into(), dir.as_os_str().to_owned()]),
            ("xfce4-terminal".into(), vec![with("--working-directory=")]),
            ("xterm".into(), vec![]),
        ],
    }
}

/// One editor manut knows. `app` is its macOS bundle name (`open -a <app>`), `command` its own command on the PATH, which
/// takes the folder as its one argument.
pub struct Editor {
    pub id: &'static str,
    pub label: &'static str,
    app: &'static str,
    command: Option<&'static str>,
    /// Xcode exists on macOS only
    mac_only: bool,
}

/// The editors, in the order "Automatic" takes the first installed. JetBrains' launchers are not here: how each takes a
/// folder was not confirmed from its documentation or from a `--help` on a computer that has one, and a flag is not guessed.
pub const EDITORS: &[Editor] = &[
    Editor { id: "vscode", label: "Visual Studio Code", app: "Visual Studio Code", command: Some("code"), mac_only: false },
    Editor { id: "cursor", label: "Cursor", app: "Cursor", command: Some("cursor"), mac_only: false },
    Editor { id: "windsurf", label: "Windsurf", app: "Windsurf", command: Some("windsurf"), mac_only: false },
    Editor { id: "zed", label: "Zed", app: "Zed", command: Some("zed"), mac_only: false },
    Editor { id: "xcode", label: "Xcode", app: "Xcode", command: None, mac_only: true },
];

/// How an installed editor is started: its app bundle through `open -a`, or its own command.
#[derive(Debug, PartialEq, Eq)]
pub enum Way {
    App(&'static str),
    Command(PathBuf),
}

/// Where to look for editors: the desk, the path rules, the folders that hold app bundles (macOS) and the PATH folders.
pub struct Probe<'a> {
    pub desk: Desk,
    pub os: Os,
    pub app_dirs: &'a [PathBuf],
    pub dirs: &'a [PathBuf],
}

fn way<D: Fn(&Path) -> bool, X: Fn(&Path) -> bool>(e: &'static Editor, pr: &Probe, is_dir: &D, is_program: &X) -> Option<Way> {
    if pr.desk == Desk::Mac {
        let bundle = format!("{}.app", e.app);
        if pr.app_dirs.iter().any(|d| is_dir(&d.join(&bundle))) {
            return Some(Way::App(e.app));
        }
    }
    if e.mac_only && pr.desk != Desk::Mac {
        return None;
    }
    resolve(e.command?, pr.dirs, is_program, pr.os).map(Way::Command)
}

/// The editors found on this computer, in `EDITORS` order.
pub fn installed<D: Fn(&Path) -> bool, X: Fn(&Path) -> bool>(pr: &Probe, is_dir: D, is_program: X) -> Vec<&'static Editor> {
    EDITORS.iter().filter(|e| way(e, pr, &is_dir, &is_program).is_some()).collect()
}

/// The program and arguments that open `dir` in editor `id`. Each is one argument: the folder is never part of a string a
/// shell reads. An id that is not on the list, or an editor not installed, is refused.
pub fn editor_launch<D: Fn(&Path) -> bool, X: Fn(&Path) -> bool>(id: &str, dir: &Path, pr: &Probe, is_dir: D, is_program: X) -> Result<(PathBuf, Vec<OsString>), String> {
    let e = EDITORS.iter().find(|e| e.id == id).ok_or_else(|| "not an editor".to_string())?;
    match way(e, pr, &is_dir, &is_program).ok_or_else(|| "the editor is not installed".to_string())? {
        Way::App(app) => Ok((PathBuf::from("open"), vec!["-a".into(), app.into(), dir.as_os_str().to_owned()])),
        Way::Command(exe) => Ok((exe, vec![dir.as_os_str().to_owned()])),
    }
}

fn probe_dirs() -> (Os, Desk, Vec<PathBuf>, Vec<PathBuf>) {
    let os = Os::current();
    let desk = Desk::current();
    let mut apps = Vec::new();
    if desk == Desk::Mac {
        apps.push(PathBuf::from("/Applications"));
        if let Some(h) = host_env("HOME").filter(|h| !h.is_empty()) {
            apps.push(Path::new(&h).join("Applications"));
        }
    }
    (os, desk, apps, search_dirs(&host_env, os))
}

fn is_folder(p: &Path) -> bool {
    p.is_dir()
}

/// The editors on this computer, as (id, label), for the page to offer only those.
pub fn editors_installed() -> Vec<(String, String)> {
    let (os, desk, apps, dirs) = probe_dirs();
    let pr = Probe { desk, os, app_dirs: &apps, dirs: &dirs };
    installed(&pr, is_folder, is_program).into_iter().map(|e| (e.id.to_string(), e.label.to_string())).collect()
}

/// Open folder `cwd` in editor `id`. Returns once the editor's launcher has handed off (or exited).
pub fn open_in_editor(cwd: &str, id: &str) -> Result<(), String> {
    let dir = folder(cwd)?;
    let (os, desk, apps, dirs) = probe_dirs();
    let pr = Probe { desk, os, app_dirs: &apps, dirs: &dirs };
    let (exe, argv) = editor_launch(id, &dir, &pr, is_folder, is_program)?;
    let mut cmd = Command::new(&exe);
    cmd.args(&argv).current_dir(&dir).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    crate::appimage::host_env(&mut cmd);
    match cmd.status() {
        Ok(s) if s.success() => Ok(()),
        Ok(s) => Err(format!("the editor exited with {s}")),
        Err(e) => Err(format!("the editor did not start: {e}")),
    }
}

fn host_env(k: &str) -> Option<String> {
    std::env::var(k).ok()
}

#[cfg(unix)]
fn is_program(p: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(p).map(|m| m.is_file() && m.permissions().mode() & 0o111 != 0).unwrap_or(false)
}

#[cfg(not(unix))]
fn is_program(p: &Path) -> bool {
    p.is_file()
}

/// Open the system terminal in folder `cwd`, running the person's own shell. Returns once the terminal program has
/// handed the window off (or exited).
pub fn open_terminal(cwd: &str) -> Result<(), String> {
    let dir = folder(cwd)?;
    let os = Os::current();
    let dirs = search_dirs(&host_env, os);
    let desk = Desk::current();
    let mut last = String::from("no terminal program found");
    for (program, argv) in launchers(desk, &dir) {
        let exe = if desk == Desk::Linux {
            match resolve(&program, &dirs, is_program, os) {
                Some(p) => p,
                None => continue,
            }
        } else {
            PathBuf::from(&program)
        };
        let mut cmd = Command::new(&exe);
        cmd.args(&argv).current_dir(&dir).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
        crate::appimage::host_env(&mut cmd);
        match cmd.status() {
            Ok(s) if s.success() => return Ok(()),
            Ok(s) => last = format!("{program} exited with {s}"),
            Err(e) => last = format!("{program}: {e}"),
        }
    }
    Err(last)
}

/// Show folder `cwd` in the file manager (Finder, Explorer, the desktop's own) through the system opener.
pub fn reveal(cwd: &str) -> Result<(), String> {
    let dir = folder(cwd)?;
    #[cfg(target_os = "linux")]
    {
        crate::appimage::open(&dir.to_string_lossy())
    }
    #[cfg(not(target_os = "linux"))]
    {
        tauri_plugin_opener::open_path(&dir, None::<&str>).map_err(|e| e.to_string())
    }
}

/// The small amber dot manut lays over its Windows taskbar button while asks wait (Windows has no badge count).
pub fn overlay_dot() -> (Vec<u8>, u32) {
    const N: u32 = 16;
    let mut rgba = Vec::with_capacity((N * N * 4) as usize);
    let c = (N as f32 - 1.0) / 2.0;
    for y in 0..N {
        for x in 0..N {
            let d = ((x as f32 - c).powi(2) + (y as f32 - c).powi(2)).sqrt();
            // a 1px soft edge
            let a = (7.5 - d).clamp(0.0, 1.0);
            rgba.extend_from_slice(&[0xf5, 0xa5, 0x24, (a * 255.0) as u8]);
        }
    }
    (rgba, N)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_an_existing_absolute_folder_is_taken() {
        let d = std::env::temp_dir().join(format!("manut-folder-open-{}", std::process::id()));
        std::fs::create_dir_all(&d).unwrap();
        assert_eq!(folder(d.to_str().unwrap()).unwrap(), d.canonicalize().unwrap());
        let f = d.join("file.txt");
        std::fs::write(&f, "x").unwrap();
        for bad in ["", "relative/dir", "~/code", f.to_str().unwrap(), d.join("missing").to_str().unwrap(), "/tmp/a\0b"] {
            assert!(folder(bad).is_err(), "{bad:?}");
        }
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn the_terminal_runs_no_command_and_the_folder_is_never_a_shell_string() {
        let dir = Path::new("/Users/k k/it's; rm -rf ~ & x");
        let os = |v: &[&str]| v.iter().map(OsString::from).collect::<Vec<_>>();
        let mac = launchers(Desk::Mac, dir);
        assert_eq!(mac, vec![("open".to_string(), os(&["-a", "Terminal", "/Users/k k/it's; rm -rf ~ & x"]))]);
        // Windows: the folder is only the working folder, never on cmd's command line
        let win = launchers(Desk::Windows, dir);
        assert_eq!(win, vec![("cmd".to_string(), os(&["/c", "start", "", "cmd"]))]);
        let lin = launchers(Desk::Linux, dir);
        assert_eq!(lin.iter().map(|l| l.0.as_str()).collect::<Vec<_>>(), ["x-terminal-emulator", "gnome-terminal", "konsole", "xfce4-terminal", "xterm"]);
        assert_eq!(lin[1].1, os(&["--working-directory=/Users/k k/it's; rm -rf ~ & x"]));
        assert_eq!(lin[2].1, os(&["--workdir", "/Users/k k/it's; rm -rf ~ & x"]));
        // no launcher carries a command to run (-e, -x, --command, /k)
        for (_, argv) in mac.iter().chain(&win).chain(&lin) {
            for a in argv {
                assert!(!["-e", "-x", "--", "--command", "/k", "-c"].contains(&a.to_str().unwrap()), "{a:?}");
            }
        }
    }

    /// A stand-in computer: app folders and PATH folders in a temp directory, with fake bundles and fake commands.
    struct Fake {
        root: PathBuf,
        apps: Vec<PathBuf>,
        bin: Vec<PathBuf>,
    }
    impl Fake {
        fn new(tag: &str) -> Fake {
            let root = std::env::temp_dir().join(format!("manut-editors-{tag}-{}", std::process::id()));
            let _ = std::fs::remove_dir_all(&root);
            let (a, b) = (root.join("Applications"), root.join("bin"));
            std::fs::create_dir_all(&a).unwrap();
            std::fs::create_dir_all(&b).unwrap();
            Fake { root, apps: vec![a], bin: vec![b] }
        }
        fn app(&self, name: &str) {
            std::fs::create_dir_all(self.apps[0].join(format!("{name}.app"))).unwrap();
        }
        fn cmd(&self, name: &str) {
            let p = self.bin[0].join(name);
            std::fs::write(&p, "#!/bin/sh\n").unwrap();
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o755)).unwrap();
            }
        }
        fn probe(&self, desk: Desk) -> Probe<'_> {
            Probe { desk, os: Os::Unix, app_dirs: &self.apps, dirs: &self.bin }
        }
        fn ids(&self, desk: Desk) -> Vec<&'static str> {
            installed(&self.probe(desk), is_folder, is_program).iter().map(|e| e.id).collect()
        }
    }
    impl Drop for Fake {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.root);
        }
    }

    #[test]
    fn the_editors_are_the_fixed_list_in_order() {
        assert_eq!(EDITORS.iter().map(|e| e.id).collect::<Vec<_>>(), ["vscode", "cursor", "windsurf", "zed", "xcode"]);
        let f = Fake::new("none");
        assert!(f.ids(Desk::Mac).is_empty());
        assert!(f.ids(Desk::Linux).is_empty());
    }

    #[test]
    fn an_editor_is_found_by_its_bundle_on_macos_or_its_command_anywhere() {
        let f = Fake::new("found");
        f.app("Zed");
        f.app("Xcode");
        f.cmd("cursor");
        f.cmd("code");
        // the list keeps its own order, not the order they were found in
        assert_eq!(f.ids(Desk::Mac), ["vscode", "cursor", "zed", "xcode"]);
        // elsewhere the bundles do not count and Xcode does not exist
        assert_eq!(f.ids(Desk::Linux), ["vscode", "cursor"]);
        assert_eq!(f.ids(Desk::Windows), ["vscode", "cursor"]);
    }

    #[test]
    fn a_file_called_like_a_bundle_or_a_command_that_cannot_run_is_not_an_editor() {
        let f = Fake::new("fake");
        std::fs::write(f.apps[0].join("Cursor.app"), "x").unwrap();
        std::fs::write(f.bin[0].join("zed"), "x").unwrap(); // not executable
        assert!(f.ids(Desk::Mac).is_empty());
    }

    #[test]
    fn macos_opens_the_bundle_with_one_argument_each_and_the_folder_is_never_a_shell_string() {
        let f = Fake::new("mac");
        f.app("Visual Studio Code");
        f.app("Xcode");
        let dir = Path::new("/Users/k k/it's; rm -rf ~ & x");
        let os = |v: &[&str]| v.iter().map(OsString::from).collect::<Vec<_>>();
        let (prog, argv) = editor_launch("vscode", dir, &f.probe(Desk::Mac), is_folder, is_program).unwrap();
        assert_eq!((prog, argv), (PathBuf::from("open"), os(&["-a", "Visual Studio Code", "/Users/k k/it's; rm -rf ~ & x"])));
        let (_, argv) = editor_launch("xcode", dir, &f.probe(Desk::Mac), is_folder, is_program).unwrap();
        assert_eq!(argv, os(&["-a", "Xcode", "/Users/k k/it's; rm -rf ~ & x"]));
    }

    #[test]
    fn macos_with_only_the_command_runs_that_command_with_the_folder_as_its_one_argument() {
        let f = Fake::new("macbin");
        f.cmd("zed");
        let dir = Path::new("/p/a b");
        let (prog, argv) = editor_launch("zed", dir, &f.probe(Desk::Mac), is_folder, is_program).unwrap();
        assert_eq!(prog, f.bin[0].join("zed"));
        assert_eq!(argv, vec![OsString::from("/p/a b")]);
    }

    #[test]
    fn elsewhere_the_editors_own_command_gets_the_folder_as_one_argument() {
        let f = Fake::new("lin");
        f.cmd("windsurf");
        f.app("Cursor"); // a bundle means nothing off macOS
        let dir = Path::new("/home/k/a;b $(x)");
        let (prog, argv) = editor_launch("windsurf", dir, &f.probe(Desk::Linux), is_folder, is_program).unwrap();
        assert_eq!(prog, f.bin[0].join("windsurf"));
        assert_eq!(argv, vec![OsString::from("/home/k/a;b $(x)")]);
        assert!(editor_launch("cursor", dir, &f.probe(Desk::Linux), is_folder, is_program).is_err());
        assert!(editor_launch("xcode", dir, &f.probe(Desk::Windows), is_folder, is_program).is_err());
    }

    #[test]
    fn an_id_not_on_the_list_or_an_editor_not_installed_is_refused() {
        let f = Fake::new("refuse");
        f.cmd("code");
        let dir = Path::new("/p");
        for bad in ["", "code", "/usr/bin/code", "vscode; rm -rf ~", "VSCODE", "idea", "../bin/code"] {
            assert!(editor_launch(bad, dir, &f.probe(Desk::Linux), is_folder, is_program).is_err(), "{bad:?}");
        }
        assert_eq!(editor_launch("zed", dir, &f.probe(Desk::Linux), is_folder, is_program).unwrap_err(), "the editor is not installed");
        assert_eq!(editor_launch("nope", dir, &f.probe(Desk::Linux), is_folder, is_program).unwrap_err(), "not an editor");
    }

    #[test]
    fn a_folder_that_is_not_there_or_a_relative_one_opens_nothing() {
        // `open_in_editor` checks the folder before it looks for an editor or starts anything
        let d = std::env::temp_dir().join(format!("manut-editors-dir-{}", std::process::id()));
        for bad in ["", "relative/dir", "~/code", d.join("missing").to_str().unwrap(), "/tmp/a\0b"] {
            assert!(open_in_editor(bad, "vscode").is_err(), "{bad:?}");
        }
        assert_eq!(open_in_editor("relative/dir", "vscode").unwrap_err(), "not a folder");
    }

    #[test]
    fn no_editor_launch_carries_a_command_to_run() {
        let f = Fake::new("flags");
        for n in ["code", "cursor", "windsurf", "zed"] {
            f.cmd(n);
        }
        let dir = Path::new("/p");
        for id in ["vscode", "cursor", "windsurf", "zed"] {
            let (_, argv) = editor_launch(id, dir, &f.probe(Desk::Linux), is_folder, is_program).unwrap();
            assert_eq!(argv.len(), 1, "{id}: the folder alone");
        }
    }

    #[test]
    fn the_overlay_dot_is_a_round_16px_picture() {
        let (rgba, n) = overlay_dot();
        assert_eq!((n, rgba.len()), (16, 16 * 16 * 4));
        assert_eq!(rgba[3], 0, "the corner is clear");
        let mid = ((8 * 16 + 8) * 4) as usize;
        assert_eq!(rgba[mid + 3], 255);
    }
}
