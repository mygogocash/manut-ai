//! The Mac App Store edition (docs/app-store.md). It is the same app built with `MANUT_APP_STORE=1`, which build.rs
//! turns into `cfg(app_store)`; the GitHub build never sets it, so nothing here changes that build.
//!
//! What differs, and why:
//! - The App Store updates the app, so the in-app updater is left out (App Review Guideline 2.4.5(vii)); lib.rs
//!   registers its plugin only when [`APP_STORE`] is false.
//! - The App Sandbox sets `HOME` to the app's container (`~/Library/Containers/co.gogocash.gogocode/Data`), where no
//!   agent has signed in and no `.manut` exists. So before anything else runs, [`adopt_real_home`] points `HOME` at the
//!   person's own home from the password database, as GoSpark's `LoginEnvironment.homeDirectory` did. That one change
//!   reaches every reader at once: `user_home()` and its callers, every `$HOME` read in the shell, `dirs::home_dir`, and
//!   every program the app starts (an agent, git, the terminal's shell), which inherits the variable. The sandbox's
//!   temporary exceptions (AppStore.entitlements) name those folders of the real home, relative to it.
//! - Claude Code keeps a scratch folder under `/tmp`, which the sandbox (inherited by every child) refuses: GoSpark's
//!   sandboxed build saw `EPERM: operation not permitted, open '/tmp/claude-501'` before Claude's first turn. So it is
//!   pointed at `~/.manut/tmp`, inside an exception the app already holds, unless the person chose one.

use std::ffi::{OsStr, OsString};
use std::path::PathBuf;

/// Whether this shell was built as the Mac App Store edition.
pub const APP_STORE: bool = cfg!(app_store);

/// Claude Code's own variable for its scratch folder.
const CLAUDE_TMPDIR: &str = "CLAUDE_CODE_TMPDIR";

/// The home folder the app should use. In the App Store edition the password database's answer wins over `HOME`, which
/// the sandbox set to the container; elsewhere `HOME` stands, as it always has (a person may point it elsewhere on
/// purpose). Either way an empty value counts as none.
pub fn resolve_home(app_store: bool, env_home: Option<&OsStr>, passwd: Option<PathBuf>) -> Option<PathBuf> {
    let env = env_home.filter(|h| !h.is_empty()).map(PathBuf::from);
    if app_store {
        passwd.filter(|p| !p.as_os_str().is_empty()).or(env)
    } else {
        env
    }
}

/// The variables [`adopt_real_home`] sets, worked out without touching the process so both editions are tested on any
/// host: nothing for the GitHub build; for the App Store edition `HOME` (when it differs) and Claude Code's scratch
/// folder (when the person has not set one).
pub fn home_vars(app_store: bool, env_home: Option<&OsStr>, passwd: Option<PathBuf>, claude_tmpdir: Option<&OsStr>) -> Vec<(&'static str, OsString)> {
    if !app_store {
        return Vec::new();
    }
    let Some(home) = resolve_home(true, env_home, passwd) else { return Vec::new() };
    let mut vars = Vec::new();
    if env_home != Some(home.as_os_str()) {
        vars.push(("HOME", home.clone().into_os_string()));
    }
    if claude_tmpdir.filter(|v| !v.is_empty()).is_none() {
        // short on purpose: Claude goes back to /tmp for the commands it runs when this path is longer than 44 bytes
        vars.push((CLAUDE_TMPDIR, home.join(".manut").join("tmp").into_os_string()));
    }
    vars
}

/// Called first in `main`, while the process has one thread, so no other thread reads the environment as it changes.
/// Does nothing in the GitHub build.
pub fn adopt_real_home() {
    if !APP_STORE {
        return;
    }
    let vars = home_vars(true, std::env::var_os("HOME").as_deref(), passwd_home(), std::env::var_os(CLAUDE_TMPDIR).as_deref());
    for (k, v) in vars {
        std::env::set_var(k, v);
    }
}

/// The person's home folder as the password database has it for this process's user, never the sandbox's container.
#[cfg(unix)]
pub fn passwd_home() -> Option<PathBuf> {
    use std::ffi::CStr;
    use std::os::unix::ffi::OsStrExt;
    let mut pwd: libc::passwd = unsafe { std::mem::zeroed() };
    let mut out: *mut libc::passwd = std::ptr::null_mut();
    let mut buf = vec![0 as libc::c_char; 16 * 1024];
    // SAFETY: getpwuid_r writes only into `pwd` and `buf`, both ours and both alive until we have copied the answer out.
    let rc = unsafe { libc::getpwuid_r(libc::getuid(), &mut pwd, buf.as_mut_ptr(), buf.len(), &mut out) };
    if rc != 0 || out.is_null() || pwd.pw_dir.is_null() {
        return None;
    }
    // SAFETY: pw_dir points into `buf`, a NUL-terminated string getpwuid_r wrote.
    let dir = unsafe { CStr::from_ptr(pwd.pw_dir) };
    let path = PathBuf::from(OsStr::from_bytes(dir.to_bytes()));
    (!path.as_os_str().is_empty()).then_some(path)
}

#[cfg(not(unix))]
pub fn passwd_home() -> Option<PathBuf> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    const CONTAINER: &str = "/Users/k/Library/Containers/co.gogocash.gogocode/Data";

    fn os(s: &str) -> Option<&OsStr> {
        Some(OsStr::new(s))
    }

    #[test]
    fn the_github_build_keeps_home_as_it_is() {
        // the flag off: HOME stands even where the password database says otherwise, and nothing is set
        assert_eq!(resolve_home(false, os("/Users/k"), Some("/Users/other".into())), Some("/Users/k".into()));
        assert_eq!(resolve_home(false, os(""), Some("/Users/k".into())), None);
        assert_eq!(resolve_home(false, None, Some("/Users/k".into())), None);
        assert!(home_vars(false, os(CONTAINER), Some("/Users/k".into()), None).is_empty());
    }

    /// `cargo test` builds the GitHub shell, `MANUT_APP_STORE=1 cargo test app_store` the App Store one: each checks
    /// that `user_home()` follows its own edition's rule.
    #[cfg(not(app_store))]
    #[test]
    fn this_build_is_the_github_one_and_user_home_is_home() {
        assert!(!APP_STORE);
        let env = std::env::var_os("HOME").filter(|h| !h.is_empty()).map(PathBuf::from);
        assert_eq!(crate::user_home().ok(), env);
    }

    #[cfg(app_store)]
    #[test]
    fn this_build_is_the_app_store_one_and_user_home_is_the_password_databases() {
        assert!(APP_STORE);
        assert_eq!(crate::user_home().ok(), passwd_home());
    }

    #[test]
    fn the_app_store_edition_takes_the_real_home_over_the_container() {
        // the flag on: the password database wins over the container HOME the sandbox set
        assert_eq!(resolve_home(true, os(CONTAINER), Some("/Users/k".into())), Some("/Users/k".into()));
        // with no answer from it, HOME is still better than nothing; an empty answer counts as none
        assert_eq!(resolve_home(true, os("/Users/k"), None), Some("/Users/k".into()));
        assert_eq!(resolve_home(true, os("/Users/k"), Some(PathBuf::new())), Some("/Users/k".into()));
        assert_eq!(resolve_home(true, None, None), None);
    }

    #[test]
    fn the_app_store_edition_hands_every_child_the_real_home_and_a_scratch_folder_it_may_write() {
        let vars = home_vars(true, os(CONTAINER), Some("/Users/k".into()), None);
        assert_eq!(vars, vec![("HOME", OsString::from("/Users/k")), ("CLAUDE_CODE_TMPDIR", OsString::from("/Users/k/.manut/tmp"))]);
        // inside the 44 bytes Claude keeps it for its commands too, for an ordinary home folder
        assert!(vars[1].1.len() <= 44);
        // HOME already right: only the scratch folder; the person's own scratch folder stands
        assert_eq!(home_vars(true, os("/Users/k"), Some("/Users/k".into()), None), vec![("CLAUDE_CODE_TMPDIR", OsString::from("/Users/k/.manut/tmp"))]);
        assert_eq!(home_vars(true, os(CONTAINER), Some("/Users/k".into()), os("/Users/k/tmp")), vec![("HOME", OsString::from("/Users/k"))]);
        // no home at all: nothing to set
        assert!(home_vars(true, None, None, None).is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn the_password_database_answers_for_this_user() {
        let home = passwd_home().expect("a home in the password database");
        assert!(home.is_absolute());
        assert!(!home.to_string_lossy().contains("/Library/Containers/"));
    }
}
